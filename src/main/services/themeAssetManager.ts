import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertContainedPath } from '@main/utils/storagePaths'
import type { RunTempHandle, RunTempChildOwnership } from '@main/utils/tempLifecycle'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_MEMORY_STAGES = 8
const MAX_MEMORY_STAGE_BYTES = MAX_IMAGE_BYTES * MAX_MEMORY_STAGES

export interface StagedThemeImage {
  stagingId: string
  previewPath: string
}

export interface PromotedThemeImage {
  fileName: string
  previewPath: string
}

export interface ThemeAssetManager {
  prepareThemeAssetStorage: () => Promise<void>
  stageThemeImage: (input: { sourcePath: string }) => Promise<StagedThemeImage>
  promoteThemeImage: <T>(
    staged: { stagingId: string, previewPath?: string },
    commit: (promoted: PromotedThemeImage) => Promise<T>,
  ) => Promise<T>
  discardThemeImage: (input: { stagingId: string }) => Promise<void>
  getThemeImagesPath: () => string
}

interface FileIdentity {
  dev: string
  ino: string
  size: string
  mtimeNs: string
  ctimeNs: string
}

interface OwnedFile {
  filePath: string
  identity: FileIdentity
}

interface DiskStagedFile extends OwnedFile {
  backing: 'disk'
  stagingId: string
  previewPath: string
}

interface MemoryStagedFile {
  backing: 'memory'
  stagingId: string
  bytes: Buffer
  mime: string
}

type StagedFile = DiskStagedFile | MemoryStagedFile
type DirectoryHandle = Awaited<ReturnType<typeof fs.open>>

const imageMime = (bytes: Buffer): string | null => {
  if (bytes.length < 12) return null
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return 'image/jpeg'
  if (bytes.subarray(0, 6).toString('ascii') == 'GIF87a' || bytes.subarray(0, 6).toString('ascii') == 'GIF89a') return 'image/gif'
  if (bytes.subarray(0, 2).toString('ascii') == 'BM') return 'image/bmp'
  if (bytes.subarray(0, 4).toString('ascii') == 'RIFF' && bytes.subarray(8, 12).toString('ascii') == 'WEBP') return 'image/webp'
  const text = bytes.subarray(0, 1024).toString('utf8').trimStart().toLowerCase()
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg')) ? 'image/svg+xml' : null
}

const isImage = (bytes: Buffer): boolean => imageMime(bytes) != null
const toDataUrl = (bytes: Buffer, mime: string): string => `data:${mime};base64,${bytes.toString('base64')}`

const inspect = async(targetPath: string) => await fs.lstat(targetPath, { bigint: true })
const identityOf = (stat: Awaited<ReturnType<typeof inspect>>): FileIdentity => ({
  dev: String(stat.dev),
  ino: String(stat.ino),
  size: String(stat.size),
  mtimeNs: String(stat.mtimeNs),
  ctimeNs: String(stat.ctimeNs),
})
const sameNode = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino
const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  sameNode(left, right) && left.size == right.size && left.mtimeNs == right.mtimeNs && left.ctimeNs == right.ctimeNs
const sameFileAfterRename = (left: FileIdentity, right: FileIdentity): boolean =>
  sameNode(left, right) && left.size == right.size && left.mtimeNs == right.mtimeNs
const samePathIdentity = (left: { dev: string, ino: string }, right: { dev: string, ino: string }): boolean =>
  left.dev == right.dev && left.ino == right.ino
const isOpaqueId = (value: string): boolean => /^[a-f0-9]{32}$/i.test(value)
const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex')

const missing = async(targetPath: string): Promise<boolean> => {
  try {
    await inspect(targetPath)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code == 'ENOENT') return true
    throw error
  }
}

const assertDirectFilePath = (rootPath: string, targetPath: string, errorCode: string): void => {
  try {
    assertContainedPath(rootPath, targetPath)
  } catch {
    throw new Error(errorCode)
  }
  if (path.dirname(path.resolve(targetPath)) != path.resolve(rootPath)) throw new Error(errorCode)
}

const readCapped = async(
  handle: Awaited<ReturnType<typeof fs.open>>,
  tooLargeCode: string,
): Promise<Buffer> => {
  const buffer = Buffer.allocUnsafe(MAX_IMAGE_BYTES + 1)
  let total = 0
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total)
    if (bytesRead == 0) break
    total += bytesRead
  }
  if (total > MAX_IMAGE_BYTES) throw new Error(tooLargeCode)
  return Buffer.from(buffer.subarray(0, total))
}

const readStableRegularFile = async(
  sourcePath: string,
  invalidCode: string,
  tooLargeCode: string,
): Promise<Buffer> => {
  const before = await inspect(sourcePath)
  if (before.isSymbolicLink() || !before.isFile()) throw new Error(invalidCode)
  if (before.size > BigInt(MAX_IMAGE_BYTES)) throw new Error(tooLargeCode)
  const beforeIdentity = identityOf(before)
  const handle = await fs.open(sourcePath, 'r')
  try {
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(identityOf(opened), beforeIdentity)) throw new Error(invalidCode)
    const bytes = await readCapped(handle, tooLargeCode)
    const after = await handle.stat({ bigint: true })
    if (after.size > BigInt(MAX_IMAGE_BYTES)) throw new Error(tooLargeCode)
    if (!sameFile(identityOf(after), beforeIdentity)) throw new Error(invalidCode)
    return bytes
  } finally {
    await handle.close()
  }
}

export const createThemeAssetManager = (input: {
  profileRoot: string
  runTemp: RunTempHandle
}): ThemeAssetManager => {
  const profileRoot = path.resolve(input.profileRoot)
  const assetRoot = path.join(profileRoot, 'assets', 'theme-images')
  const legacyRoot = path.join(profileRoot, 'theme_images')
  const stages = new Map<string, StagedFile>()
  const stageTails = new Map<string, Promise<unknown>>()
  let memoryStageBytes = 0
  let assetRootIdentity: { dev: string, ino: string } | null = null

  const getStagingOwnership = async(): Promise<RunTempChildOwnership> => {
    try {
      return await input.runTemp.getChildOwnership('theme-editor')
    } catch {
      throw new Error('theme_stage_invalid')
    }
  }

  const stagePath = (ownership: RunTempChildOwnership, stagingId: string): string => {
    if (!isOpaqueId(stagingId)) throw new Error('theme_stage_invalid')
    const target = path.join(ownership.childPath, stagingId)
    assertDirectFilePath(ownership.childPath, target, 'theme_stage_invalid')
    return target
  }

  const assertStagingOwnership = async(ownership: RunTempChildOwnership): Promise<void> => {
    const current = await getStagingOwnership()
    if (current.runTempRoot != ownership.runTempRoot || current.childPath != ownership.childPath ||
      !samePathIdentity(current.runTempIdentity, ownership.runTempIdentity) ||
      !samePathIdentity(current.childIdentity, ownership.childIdentity)) throw new Error('theme_stage_invalid')
  }

  const openOwnedStagingChild = async(ownership: RunTempChildOwnership): Promise<Readonly<{
    handle: DirectoryHandle
    accessPath: string
  }>> => {
    let handle: DirectoryHandle | null = null
    try {
      await assertStagingOwnership(ownership)
      handle = await fs.open(ownership.childPath, 'r')
      const opened = await handle.stat({ bigint: true })
      if (!opened.isDirectory() || !samePathIdentity(identityOf(opened), ownership.childIdentity)) {
        throw new Error('theme_stage_invalid')
      }
      await assertStagingOwnership(ownership)
      return Object.freeze({ handle, accessPath: `/proc/self/fd/${handle.fd}` })
    } catch (error) {
      try { await handle?.close() } catch {}
      throw error
    }
  }

  const ensureAssetRoot = async(): Promise<void> => {
    assertContainedPath(profileRoot, assetRoot)
    await fs.mkdir(assetRoot, { recursive: true })
    const stat = await inspect(assetRoot)
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('theme_asset_root_invalid')
    const identity = identityOf(stat)
    if (assetRootIdentity == null) assetRootIdentity = identity
    else if (!samePathIdentity(assetRootIdentity, identity)) throw new Error('theme_asset_root_invalid')
  }

  const assertOwnedFile = async(rootPath: string, owned: OwnedFile, errorCode: string): Promise<void> => {
    assertDirectFilePath(rootPath, owned.filePath, errorCode)
    const stat = await inspect(owned.filePath)
    if (stat.isSymbolicLink() || !stat.isFile() || !sameFile(identityOf(stat), owned.identity)) {
      throw new Error(errorCode)
    }
  }

  const assertRenamedOwnedFile = async(rootPath: string, owned: OwnedFile, errorCode: string): Promise<void> => {
    assertDirectFilePath(rootPath, owned.filePath, errorCode)
    const stat = await inspect(owned.filePath)
    if (stat.isSymbolicLink() || !stat.isFile() || !sameFileAfterRename(identityOf(stat), owned.identity)) {
      throw new Error(errorCode)
    }
  }

  const quarantineAndRemove = async(
    rootPath: string,
    owned: OwnedFile,
    validateRoot: () => Promise<void>,
    errorCode: string,
  ): Promise<void> => {
    await validateRoot()
    await assertOwnedFile(rootPath, owned, errorCode)
    const quarantinePath = path.join(rootPath, `.${path.basename(owned.filePath)}.quarantine-${crypto.randomUUID()}`)
    assertDirectFilePath(rootPath, quarantinePath, errorCode)
    if (!await missing(quarantinePath)) throw new Error(errorCode)
    await fs.rename(owned.filePath, quarantinePath)
    const movedIdentity = identityOf(await inspect(quarantinePath))
    try {
      await validateRoot()
      await assertRenamedOwnedFile(rootPath, { ...owned, filePath: quarantinePath }, errorCode)
      await fs.unlink(quarantinePath)
    } catch (error) {
      try {
        await validateRoot()
        const currentIdentity = identityOf(await inspect(quarantinePath))
        if (!sameNode(currentIdentity, movedIdentity)) throw new Error(errorCode)
        if (await missing(owned.filePath)) await fs.rename(quarantinePath, owned.filePath)
      } catch {}
      throw error
    }
  }

  const removeOwnedNodeIfCurrent = async(
    rootPath: string,
    filePath: string,
    expectedIdentity: FileIdentity,
    validateRoot: () => Promise<void>,
    errorCode: string,
  ): Promise<void> => {
    try {
      const currentIdentity = identityOf(await inspect(filePath))
      if (!sameNode(currentIdentity, expectedIdentity)) return
      await quarantineAndRemove(rootPath, { filePath, identity: currentIdentity }, validateRoot, errorCode)
    } catch {}
  }

  const removeOpenedFileIfCurrent = async(
    openPath: string,
    expectedIdentity: FileIdentity,
    errorCode: string,
  ): Promise<void> => {
    const quarantinePath = path.join(
      path.dirname(openPath),
      `.${path.basename(openPath)}.quarantine-${crypto.randomUUID()}`,
    )
    if (!await missing(quarantinePath)) throw new Error(errorCode)
    await fs.rename(openPath, quarantinePath)
    const movedIdentity = identityOf(await inspect(quarantinePath))
    if (!sameNode(movedIdentity, expectedIdentity)) {
      try {
        const currentIdentity = identityOf(await inspect(quarantinePath))
        if (!sameNode(currentIdentity, movedIdentity)) throw new Error(errorCode)
        if (await missing(openPath)) await fs.rename(quarantinePath, openPath)
      } catch {}
      return
    }
    try {
      const currentIdentity = identityOf(await inspect(quarantinePath))
      if (!sameNode(currentIdentity, movedIdentity)) throw new Error(errorCode)
      await fs.unlink(quarantinePath)
    } catch {
      try {
        const currentIdentity = identityOf(await inspect(quarantinePath))
        if (!sameNode(currentIdentity, movedIdentity)) throw new Error(errorCode)
        if (await missing(openPath)) await fs.rename(quarantinePath, openPath)
      } catch {}
    }
  }

  const writeOwnedFile = async(
    rootPath: string,
    targetPath: string,
    bytes: Buffer,
    errorCode: string,
    options: {
      openPath?: string
      validateRoot?: () => Promise<void>
    } = {},
  ): Promise<OwnedFile> => {
    assertDirectFilePath(rootPath, targetPath, errorCode)
    const openPath = options.openPath ?? targetPath
    const handle = await fs.open(openPath, 'wx')
    let openedIdentity: FileIdentity | null = null
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile()) throw new Error(errorCode)
      openedIdentity = identityOf(opened)
      await options.validateRoot?.()
      const created = await inspect(targetPath)
      if (created.isSymbolicLink() || !created.isFile() || !sameFile(identityOf(created), openedIdentity)) {
        throw new Error(errorCode)
      }
      await handle.writeFile(bytes)
      await handle.sync()
      const writtenIdentity = identityOf(await handle.stat({ bigint: true }))
      await handle.close()
      await options.validateRoot?.()
      const pathIdentity = identityOf(await inspect(targetPath))
      if (!sameFile(writtenIdentity, pathIdentity)) throw new Error(errorCode)
      return { filePath: targetPath, identity: pathIdentity }
    } catch (error) {
      try { await handle.close() } catch {}
      if (openedIdentity != null) {
        try {
          if (openPath != targetPath) await removeOpenedFileIfCurrent(openPath, openedIdentity, errorCode)
          else {
            const current = identityOf(await inspect(openPath))
            if (sameNode(current, openedIdentity)) await fs.unlink(openPath)
          }
        } catch {}
      }
      throw error
    }
  }

  const verifyStaged = async(stagingId: string, previewPath?: string): Promise<{ record: StagedFile, bytes: Buffer }> => {
    if (!isOpaqueId(stagingId)) throw new Error('theme_stage_invalid')
    const record = stages.get(stagingId)
    if (record == null) throw new Error('theme_stage_invalid')
    if (record.backing == 'memory') {
      if (record.bytes.length > MAX_IMAGE_BYTES || imageMime(record.bytes) != record.mime ||
        (previewPath != null && previewPath != toDataUrl(record.bytes, record.mime))) {
        throw new Error('theme_stage_invalid')
      }
      return { record, bytes: Buffer.from(record.bytes) }
    }
    const ownership = await getStagingOwnership()
    if (record.filePath != stagePath(ownership, stagingId) ||
      (previewPath != null && previewPath != record.previewPath)) throw new Error('theme_stage_invalid')
    await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
    const bytes = await readStableRegularFile(record.filePath, 'theme_stage_invalid', 'theme_stage_invalid')
    await assertStagingOwnership(ownership)
    await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
    if (!isImage(bytes)) throw new Error('theme_stage_invalid')
    return { record, bytes }
  }

  const retireStage = async(record: StagedFile): Promise<void> => {
    if (record.backing == 'memory') {
      if (stages.get(record.stagingId) == record) {
        stages.delete(record.stagingId)
        memoryStageBytes -= record.bytes.length
      }
      return
    }
    const ownership = await getStagingOwnership()
    await quarantineAndRemove(
      ownership.childPath,
      record,
      async() => {
        const current = await getStagingOwnership()
        if (current.childPath != ownership.childPath ||
          !samePathIdentity(current.childIdentity, ownership.childIdentity)) throw new Error('theme_stage_invalid')
      },
      'theme_stage_invalid',
    )
    stages.delete(record.stagingId)
  }

  const withStage = async<T>(stagingId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = stageTails.get(stagingId) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(operation)
    stageTails.set(stagingId, current)
    try {
      return await current
    } finally {
      if (stageTails.get(stagingId) == current) stageTails.delete(stagingId)
    }
  }

  const createAssetTemp = async(bytes: Buffer): Promise<OwnedFile> => {
    await ensureAssetRoot()
    for (let attempts = 0; attempts < 8; attempts++) {
      const targetPath = path.join(assetRoot, `.owned-theme-${crypto.randomBytes(16).toString('hex')}.tmp`)
      try {
        return await writeOwnedFile(assetRoot, targetPath, bytes, 'theme_asset_invalid')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
      }
    }
    throw new Error('theme_asset_collision')
  }

  const createDiskStage = async(bytes: Buffer): Promise<DiskStagedFile> => {
    const ownership = await getStagingOwnership()
    const child = await openOwnedStagingChild(ownership)
    let owned: OwnedFile | null = null
    let stagingId = ''
    let failure: unknown
    try {
      for (let attempts = 0; attempts < 8; attempts++) {
        stagingId = crypto.randomBytes(16).toString('hex')
        const target = stagePath(ownership, stagingId)
        try {
          owned = await writeOwnedFile(ownership.childPath, target, bytes, 'theme_stage_invalid', {
            openPath: path.join(child.accessPath, stagingId),
            validateRoot: async() => { await assertStagingOwnership(ownership) },
          })
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
        }
      }
      if (owned == null) throw new Error('theme_stage_collision')
    } catch (error) {
      failure = error
    }
    try {
      await child.handle.close()
    } catch (error) {
      failure ??= error
    }
    if (failure != null) {
      if (owned != null) {
        await removeOwnedNodeIfCurrent(
          ownership.childPath,
          owned.filePath,
          owned.identity,
          async() => { await assertStagingOwnership(ownership) },
          'theme_stage_invalid',
        )
      }
      throw failure instanceof Error ? failure : new Error('theme_stage_invalid')
    }
    const record: DiskStagedFile = {
      ...owned!,
      backing: 'disk',
      stagingId,
      previewPath: owned!.filePath,
    }
    try {
      await assertStagingOwnership(ownership)
      await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
      return record
    } catch (error) {
      await removeOwnedNodeIfCurrent(
        ownership.childPath,
        record.filePath,
        record.identity,
        async() => { await assertStagingOwnership(ownership) },
        'theme_stage_invalid',
      )
      throw error
    }
  }

  const createMemoryStage = (bytes: Buffer, mime: string): StagedThemeImage => {
    if (stages.size >= MAX_MEMORY_STAGES || memoryStageBytes + bytes.length > MAX_MEMORY_STAGE_BYTES) {
      throw new Error('theme_stage_capacity')
    }
    for (let attempts = 0; attempts < 8; attempts++) {
      const stagingId = crypto.randomBytes(16).toString('hex')
      if (stages.has(stagingId)) continue
      const record: MemoryStagedFile = {
        backing: 'memory',
        stagingId,
        bytes: Buffer.from(bytes),
        mime,
      }
      stages.set(stagingId, record)
      memoryStageBytes += record.bytes.length
      return { stagingId, previewPath: toDataUrl(record.bytes, record.mime) }
    }
    throw new Error('theme_stage_collision')
  }

  const publishAsset = async(temp: OwnedFile, preferredName?: string): Promise<{ promoted: PromotedThemeImage, final: OwnedFile }> => {
    await ensureAssetRoot()
    for (let attempts = 0; attempts < 8; attempts++) {
      const fileName = preferredName ?? `${crypto.randomBytes(16).toString('hex')}.img`
      const targetPath = path.join(assetRoot, fileName)
      assertDirectFilePath(assetRoot, targetPath, 'theme_asset_invalid')
      try {
        await fs.link(temp.filePath, targetPath)
      } catch (error) {
        if (preferredName == null && (error as NodeJS.ErrnoException).code == 'EEXIST') continue
        throw error
      }
      try {
        const finalIdentity = identityOf(await inspect(targetPath))
        if (!sameNode(finalIdentity, temp.identity)) throw new Error('theme_asset_invalid')
        const currentTemp = { filePath: temp.filePath, identity: identityOf(await inspect(temp.filePath)) }
        await quarantineAndRemove(assetRoot, currentTemp, ensureAssetRoot, 'theme_asset_invalid')
        const publishedIdentity = identityOf(await inspect(targetPath))
        if (!sameFileAfterRename(publishedIdentity, finalIdentity)) throw new Error('theme_asset_invalid')
        return {
          promoted: { fileName, previewPath: targetPath },
          final: { filePath: targetPath, identity: publishedIdentity },
        }
      } catch (error) {
        await removeOwnedNodeIfCurrent(assetRoot, targetPath, temp.identity, ensureAssetRoot, 'theme_asset_invalid')
        await removeOwnedNodeIfCurrent(assetRoot, temp.filePath, temp.identity, ensureAssetRoot, 'theme_asset_invalid')
        throw error
      }
    }
    throw new Error('theme_asset_collision')
  }

  const installLegacy = async(fileName: string, bytes: Buffer): Promise<void> => {
    const targetPath = path.join(assetRoot, fileName)
    assertDirectFilePath(assetRoot, targetPath, 'theme_asset_migration_conflict')
    if (!await missing(targetPath)) {
      const current = await readStableRegularFile(targetPath, 'theme_asset_migration_conflict', 'theme_asset_migration_conflict')
      if (sha256(current) != sha256(bytes)) throw new Error('theme_asset_migration_conflict')
      return
    }
    const temp = await createAssetTemp(bytes)
    let final: OwnedFile | null = null
    try {
      const published = await publishAsset(temp, fileName)
      final = published.final
      const readBack = await readStableRegularFile(final.filePath, 'theme_asset_migration_conflict', 'theme_asset_migration_conflict')
      if (sha256(readBack) != sha256(bytes)) throw new Error('theme_asset_migration_conflict')
    } catch (error) {
      if (final != null) {
        try { await quarantineAndRemove(assetRoot, final, ensureAssetRoot, 'theme_asset_invalid') } catch {}
      } else {
        try { await quarantineAndRemove(assetRoot, temp, ensureAssetRoot, 'theme_asset_invalid') } catch {}
      }
      throw error
    }
  }

  return {
    getThemeImagesPath: () => assetRoot,
    prepareThemeAssetStorage: async() => {
      await ensureAssetRoot()
      let entries
      try {
        const legacyStat = await inspect(legacyRoot)
        if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) return
        entries = await fs.readdir(legacyRoot, { withFileTypes: true })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code == 'ENOENT') return
        throw error
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink() || !entry.isFile()) continue
        const sourcePath = path.join(legacyRoot, entry.name)
        assertDirectFilePath(legacyRoot, sourcePath, 'theme_asset_migration_conflict')
        const bytes = await readStableRegularFile(
          sourcePath,
          'theme_asset_migration_conflict',
          'theme_asset_migration_conflict',
        )
        await installLegacy(entry.name, bytes)
      }
    },
    stageThemeImage: async({ sourcePath }) => {
      const source = path.resolve(sourcePath)
      const bytes = await readStableRegularFile(source, 'theme_image_invalid', 'theme_image_too_large')
      const mime = imageMime(bytes)
      if (mime == null) throw new Error('theme_image_invalid')
      if (process.platform != 'linux') return createMemoryStage(bytes, mime)
      const record = await createDiskStage(bytes)
      stages.set(record.stagingId, record)
      return { stagingId: record.stagingId, previewPath: record.previewPath }
    },
    promoteThemeImage: async(staged, commit) => await withStage(staged.stagingId, async() => {
      const { record, bytes } = await verifyStaged(staged.stagingId, staged.previewPath)
      const temp = await createAssetTemp(bytes)
      let final: OwnedFile | null = null
      try {
        await verifyStaged(staged.stagingId, staged.previewPath)
        const published = await publishAsset(temp)
        final = published.final
        const readBack = await readStableRegularFile(final.filePath, 'theme_asset_invalid', 'theme_asset_invalid')
        if (sha256(readBack) != sha256(bytes)) throw new Error('theme_asset_invalid')
        const result = await commit(published.promoted)
        try { await retireStage(record) } catch {}
        return result
      } catch (error) {
        if (final != null) {
          try { await quarantineAndRemove(assetRoot, final, ensureAssetRoot, 'theme_asset_invalid') } catch {}
        } else {
          try { await quarantineAndRemove(assetRoot, temp, ensureAssetRoot, 'theme_asset_invalid') } catch {}
        }
        throw error
      }
    }),
    discardThemeImage: async({ stagingId }) => {
      await withStage(stagingId, async() => {
        const { record } = await verifyStaged(stagingId)
        await retireStage(record)
      })
    },
  }
}
