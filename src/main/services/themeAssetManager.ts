import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { assertContainedPath } from '@main/utils/storagePaths'
import type { RunTempHandle, RunTempChildOwnership } from '@main/utils/tempLifecycle'

const MAX_IMAGE_BYTES = 8 * 1024 * 1024

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

interface StagedFile extends OwnedFile {
  stagingId: string
  previewPath: string
}

const isImage = (bytes: Buffer): boolean => {
  if (bytes.length < 12) return false
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true
  if (bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff) return true
  if (bytes.subarray(0, 6).toString('ascii') == 'GIF87a' || bytes.subarray(0, 6).toString('ascii') == 'GIF89a') return true
  if (bytes.subarray(0, 2).toString('ascii') == 'BM') return true
  if (bytes.subarray(0, 4).toString('ascii') == 'RIFF' && bytes.subarray(8, 12).toString('ascii') == 'WEBP') return true
  const text = bytes.subarray(0, 1024).toString('utf8').trimStart().toLowerCase()
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))
}

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
    try {
      await validateRoot()
      await assertRenamedOwnedFile(rootPath, { ...owned, filePath: quarantinePath }, errorCode)
      await fs.unlink(quarantinePath)
    } catch (error) {
      try {
        await validateRoot()
        await assertRenamedOwnedFile(rootPath, { ...owned, filePath: quarantinePath }, errorCode)
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

  const writeOwnedFile = async(rootPath: string, targetPath: string, bytes: Buffer, errorCode: string): Promise<OwnedFile> => {
    assertDirectFilePath(rootPath, targetPath, errorCode)
    const handle = await fs.open(targetPath, 'wx')
    let openedIdentity: FileIdentity | null = null
    try {
      openedIdentity = identityOf(await handle.stat({ bigint: true }))
      await handle.writeFile(bytes)
      await handle.sync()
      const writtenIdentity = identityOf(await handle.stat({ bigint: true }))
      await handle.close()
      const pathIdentity = identityOf(await inspect(targetPath))
      if (!sameFile(writtenIdentity, pathIdentity)) throw new Error(errorCode)
      return { filePath: targetPath, identity: pathIdentity }
    } catch (error) {
      try { await handle.close() } catch {}
      if (openedIdentity != null) {
        try {
          const current = identityOf(await inspect(targetPath))
          if (sameNode(current, openedIdentity)) await fs.unlink(targetPath)
        } catch {}
      }
      throw error
    }
  }

  const verifyStaged = async(stagingId: string, previewPath?: string): Promise<{ record: StagedFile, bytes: Buffer }> => {
    const ownership = await getStagingOwnership()
    const record = stages.get(stagingId)
    if (record == null || record.filePath != stagePath(ownership, stagingId) ||
      (previewPath != null && previewPath != record.previewPath)) throw new Error('theme_stage_invalid')
    await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
    const bytes = await readStableRegularFile(record.filePath, 'theme_stage_invalid', 'theme_stage_invalid')
    await getStagingOwnership()
    await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
    if (!isImage(bytes)) throw new Error('theme_stage_invalid')
    return { record, bytes }
  }

  const retireStage = async(record: StagedFile): Promise<void> => {
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
      const ownership = await getStagingOwnership()
      const source = path.resolve(sourcePath)
      const bytes = await readStableRegularFile(source, 'theme_image_invalid', 'theme_image_too_large')
      if (!isImage(bytes)) throw new Error('theme_image_invalid')
      await getStagingOwnership()
      for (let attempts = 0; attempts < 8; attempts++) {
        const stagingId = crypto.randomBytes(16).toString('hex')
        const target = stagePath(ownership, stagingId)
        try {
          const owned = await writeOwnedFile(ownership.childPath, target, bytes, 'theme_stage_invalid')
          const record = { ...owned, stagingId, previewPath: target }
          await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
          stages.set(stagingId, record)
          return { stagingId, previewPath: target }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
        }
      }
      throw new Error('theme_stage_collision')
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
