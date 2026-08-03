import crypto from 'node:crypto'
import nativeFs from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
  type DirectDirectoryGuard,
  type NodeIdentity,
} from '../storage/directDirectory'
import {
  closeArtifactGuard,
  completeExclusiveArtifact,
  reserveExclusiveArtifact,
  revalidateImmutableArtifact,
  type BoundedByteSource,
  type ImmutableArtifactGuard,
} from '../storage/exclusiveArtifact'
import {
  isolateOwnedPath,
  reclaimIsolatedPayload,
} from '../storage/exclusiveIsolation'
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

interface FileIdentity extends NodeIdentity {
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
type VerifiedThemeStage =
  | {
    backing: 'memory'
    record: MemoryStagedFile
    bytes: Buffer
    close: () => Promise<void>
  }
  | {
    backing: 'disk'
    record: DiskStagedFile
    bytes: Buffer
    descriptor: Awaited<ReturnType<typeof fs.open>>
    descriptorIdentity: FileIdentity
    close: () => Promise<void>
  }

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
const sameNode = (left: NodeIdentity, right: NodeIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino
const sameFile = (left: FileIdentity, right: FileIdentity): boolean =>
  sameNode(left, right) && left.size == right.size && left.mtimeNs == right.mtimeNs && left.ctimeNs == right.ctimeNs
const sameFileAfterMove = (left: FileIdentity, right: FileIdentity): boolean =>
  sameNode(left, right) && left.size == right.size && left.mtimeNs == right.mtimeNs
const samePathIdentity = (left: { dev: string, ino: string }, right: { dev: string, ino: string }): boolean =>
  left.dev == right.dev && left.ino == right.ino
const isOpaqueId = (value: string): boolean => /^[a-f0-9]{32}$/i.test(value)
const sha256 = (bytes: Buffer): string => crypto.createHash('sha256').update(bytes).digest('hex')
const byteSource = (bytes: Buffer): BoundedByteSource => ({
  byteLength: bytes.length,
  read: (offset, maximumBytes) => Buffer.from(bytes.subarray(offset, offset + maximumBytes)),
})

const fixedThemeError = (error: unknown, fallback: string): Error => {
  if (error instanceof Error && error.message.startsWith('theme_')) return error
  const code = error != null && typeof error == 'object' && 'code' in error ? String(error.code) : ''
  if (code.startsWith('artifact_') || code.startsWith('direct_directory_') || code.startsWith('isolation_')) {
    return new Error(fallback)
  }
  return error instanceof Error ? error : new Error(fallback)
}

const readNativeDescriptor = (descriptor: number, byteLength: number): Buffer => {
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_IMAGE_BYTES) {
    throw new Error('theme_asset_invalid')
  }
  const bytes = Buffer.allocUnsafe(byteLength)
  let offset = 0
  while (offset < bytes.length) {
    const read = nativeFs.readSync(descriptor, bytes, offset, bytes.length - offset, offset)
    if (read <= 0) throw new Error('theme_asset_invalid')
    offset += read
  }
  const extra = Buffer.allocUnsafe(1)
  if (nativeFs.readSync(descriptor, extra, 0, 1, offset) != 0) throw new Error('theme_asset_invalid')
  return bytes
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
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink != 1n || !sameFile(identityOf(stat), owned.identity)) {
      throw new Error(errorCode)
    }
  }

  const openRootGuard = (
    rootPath: string,
    expectedIdentity: NodeIdentity,
    errorCode: string,
  ): DirectDirectoryGuard => {
    let guard: DirectDirectoryGuard | null = null
    try {
      guard = validateDirectDirectory(rootPath)
      if (!samePathIdentity(guard.identity, expectedIdentity)) throw new Error(errorCode)
      return guard
    } catch {
      if (guard != null) {
        try { closeDirectDirectory(guard) } catch {}
      }
      throw new Error(errorCode)
    }
  }

  const verifyDescriptorPath = async(
    descriptor: Awaited<ReturnType<typeof fs.open>>,
    descriptorIdentity: FileIdentity,
    targetPath: string,
    errorCode: string,
    afterMove = false,
  ): Promise<void> => {
    try {
      const descriptorStat = await descriptor.stat({ bigint: true })
      const pathStat = await inspect(targetPath)
      const currentDescriptorIdentity = identityOf(descriptorStat)
      const currentPathIdentity = identityOf(pathStat)
      if (!descriptorStat.isFile() || descriptorStat.nlink != 1n ||
        pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.nlink != 1n ||
        !(afterMove
          ? sameFileAfterMove(currentDescriptorIdentity, descriptorIdentity)
          : sameFile(currentDescriptorIdentity, descriptorIdentity)) ||
        !sameFile(currentPathIdentity, currentDescriptorIdentity)) throw new Error(errorCode)
    } catch {
      throw new Error(errorCode)
    }
  }

  const isolateAndReclaim = async(input: {
    root: DirectDirectoryGuard
    filePath: string
    identity: NodeIdentity
    prefix: string
    verify: (payloadPath: string) => Promise<void>
    errorCode: string
  }): Promise<void> => {
    let isolated
    try {
      isolated = await isolateOwnedPath({
        source: {
          root: input.root,
          path: input.filePath,
          basename: path.basename(input.filePath),
          identity: input.identity,
          kind: 'file',
        },
        prefix: input.prefix,
        verifySource: input.verify,
      })
    } catch {
      throw new Error(input.errorCode)
    }
    if (isolated.state != 'isolated') throw new Error(input.errorCode)
    const reclaimed = await reclaimIsolatedPayload({ guard: isolated.guard, verifyPayload: input.verify })
    if (reclaimed.state != 'reclaimed') throw new Error(input.errorCode)
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
    try {
      const opened = await handle.stat({ bigint: true })
      if (!opened.isFile() || opened.nlink != 1n) throw new Error(errorCode)
      const openedIdentity = identityOf(opened)
      await options.validateRoot?.()
      const created = await inspect(targetPath)
      if (created.isSymbolicLink() || !created.isFile() || created.nlink != 1n ||
        !sameFile(identityOf(created), openedIdentity)) {
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
      throw error
    }
  }

  const openVerifiedStage = async(stagingId: string, previewPath?: string): Promise<VerifiedThemeStage> => {
    if (!isOpaqueId(stagingId)) throw new Error('theme_stage_invalid')
    const record = stages.get(stagingId)
    if (record == null) throw new Error('theme_stage_invalid')
    if (record.backing == 'memory') {
      if (record.bytes.length > MAX_IMAGE_BYTES || imageMime(record.bytes) != record.mime ||
        (previewPath != null && previewPath != toDataUrl(record.bytes, record.mime))) {
        throw new Error('theme_stage_invalid')
      }
      return { backing: 'memory', record, bytes: Buffer.from(record.bytes), close: async() => {} }
    }
    const ownership = await getStagingOwnership()
    if (record.filePath != stagePath(ownership, stagingId) ||
      (previewPath != null && previewPath != record.previewPath)) throw new Error('theme_stage_invalid')
    let descriptor: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      await assertStagingOwnership(ownership)
      await assertOwnedFile(ownership.childPath, record, 'theme_stage_invalid')
      descriptor = await fs.open(record.filePath, 'r')
      const descriptorStat = await descriptor.stat({ bigint: true })
      const descriptorIdentity = identityOf(descriptorStat)
      if (!descriptorStat.isFile() || descriptorStat.nlink != 1n ||
        !sameFileAfterMove(descriptorIdentity, record.identity)) throw new Error('theme_stage_invalid')
      await verifyDescriptorPath(descriptor, descriptorIdentity, record.filePath, 'theme_stage_invalid')
      const bytes = await readCapped(descriptor, 'theme_stage_invalid')
      await verifyDescriptorPath(descriptor, descriptorIdentity, record.filePath, 'theme_stage_invalid')
      await assertStagingOwnership(ownership)
      if (!isImage(bytes)) throw new Error('theme_stage_invalid')
      const retainedDescriptor = descriptor
      descriptor = null
      return {
        backing: 'disk',
        record,
        bytes,
        descriptor: retainedDescriptor,
        descriptorIdentity,
        close: async() => { await retainedDescriptor.close() },
      }
    } catch {
      try { await descriptor?.close() } catch {}
      throw new Error('theme_stage_invalid')
    }
  }

  const revalidateStageAgainstDescriptor = async(stage: VerifiedThemeStage): Promise<void> => {
    if (stage.backing == 'memory') {
      if (stages.get(stage.record.stagingId) != stage.record ||
        stage.record.bytes.length > MAX_IMAGE_BYTES || imageMime(stage.record.bytes) != stage.record.mime ||
        !stage.bytes.equals(stage.record.bytes)) throw new Error('theme_stage_invalid')
      return
    }
    const ownership = await getStagingOwnership()
    if (stage.record.filePath != stagePath(ownership, stage.record.stagingId)) throw new Error('theme_stage_invalid')
    await assertStagingOwnership(ownership)
    await verifyDescriptorPath(
      stage.descriptor,
      stage.descriptorIdentity,
      stage.record.filePath,
      'theme_stage_invalid',
    )
  }

  const consumeThemeStage = async(stage: VerifiedThemeStage): Promise<void> => {
    if (stage.backing == 'memory') {
      const record = stage.record
      if (stages.get(record.stagingId) != record) throw new Error('theme_stage_invalid')
      stages.delete(record.stagingId)
      memoryStageBytes -= record.bytes.length
      return
    }
    const record = stage.record
    const ownership = await getStagingOwnership()
    await assertStagingOwnership(ownership)
    await revalidateStageAgainstDescriptor(stage)
    const root = openRootGuard(ownership.childPath, ownership.childIdentity, 'theme_stage_invalid')
    try {
      try {
        await isolateAndReclaim({
          root,
          filePath: record.filePath,
          identity: stage.descriptorIdentity,
          prefix: `.${record.stagingId}.isolate-`,
          verify: async payloadPath => {
            await verifyDescriptorPath(
              stage.descriptor,
              stage.descriptorIdentity,
              payloadPath,
              'theme_stage_invalid',
              true,
            )
            const payloadBytes = await readCapped(stage.descriptor, 'theme_stage_invalid')
            if (sha256(payloadBytes) != sha256(stage.bytes)) throw new Error('theme_stage_invalid')
            await verifyDescriptorPath(
              stage.descriptor,
              stage.descriptorIdentity,
              payloadPath,
              'theme_stage_invalid',
              true,
            )
          },
          errorCode: 'theme_stage_invalid',
        })
      } finally {
        if (stages.get(record.stagingId) == record) stages.delete(record.stagingId)
      }
    } finally {
      closeDirectDirectory(root)
    }
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
    } catch {
      throw new Error('theme_stage_invalid')
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

  const readOwnedPayload = async(
    targetPath: string,
    expectedIdentity: NodeIdentity,
    expectedHash: string | null,
    errorCode: string,
  ): Promise<Buffer> => {
    let descriptor: Awaited<ReturnType<typeof fs.open>> | null = null
    try {
      const before = await inspect(targetPath)
      if (before.isSymbolicLink() || !before.isFile() || before.nlink != 1n ||
        !sameNode(identityOf(before), expectedIdentity)) throw new Error(errorCode)
      const beforeIdentity = identityOf(before)
      descriptor = await fs.open(targetPath, 'r')
      await verifyDescriptorPath(descriptor, beforeIdentity, targetPath, errorCode)
      const bytes = await readCapped(descriptor, errorCode)
      await verifyDescriptorPath(descriptor, beforeIdentity, targetPath, errorCode)
      if (expectedHash != null && sha256(bytes) != expectedHash) throw new Error(errorCode)
      return bytes
    } catch {
      throw new Error(errorCode)
    } finally {
      try { await descriptor?.close() } catch {}
    }
  }

  const completeThemeTarget = (root: DirectDirectoryGuard, bytes: Buffer): ImmutableArtifactGuard => {
    const expectedHash = sha256(bytes)
    return completeExclusiveArtifact(
      reserveExclusiveArtifact(root, {
        prefix: '',
        suffix: '.img',
        artifactKind: 'theme-image-v1',
      }),
      byteSource(bytes),
      {
        verifyReadOnly: ({ readDescriptor, sha256: actualHash, byteLength }) => {
          const readBack = readNativeDescriptor(readDescriptor, byteLength)
          if (byteLength != bytes.length || actualHash != expectedHash || sha256(readBack) != expectedHash ||
            !isImage(readBack)) throw new Error('theme_asset_invalid')
        },
      },
    )
  }

  const rollbackDurableTarget = async(guard: ImmutableArtifactGuard): Promise<void> => {
    try {
      revalidateImmutableArtifact(guard)
    } catch {
      try { closeArtifactGuard(guard) } catch {}
      throw new Error('theme_asset_invalid')
    }
    closeArtifactGuard(guard)
    await isolateAndReclaim({
      root: guard.root,
      filePath: guard.path,
      identity: guard.identity,
      prefix: `.${guard.basename}.isolate-`,
      verify: async payloadPath => {
        const bytes = await readOwnedPayload(payloadPath, guard.identity, guard.sha256, 'theme_asset_invalid')
        if (bytes.length != guard.byteLength || !isImage(bytes)) throw new Error('theme_asset_invalid')
      },
      errorCode: 'theme_asset_invalid',
    })
  }

  const revalidateLegacyTarget = async(input: {
    root: DirectDirectoryGuard
    targetRoot: DirectDirectoryGuard
    targetPath: string
    identity: FileIdentity
    descriptor?: Awaited<ReturnType<typeof fs.open>>
  }): Promise<void> => {
    try {
      revalidateDirectDirectory(input.root)
      revalidateDirectDirectory(input.targetRoot)
      if (!samePathIdentity(input.root.identity, input.targetRoot.identity)) {
        throw new Error('theme_asset_migration_conflict')
      }
      assertDirectFilePath(input.targetRoot.path, input.targetPath, 'theme_asset_migration_conflict')
      if (input.descriptor != null) {
        await verifyDescriptorPath(
          input.descriptor,
          input.identity,
          input.targetPath,
          'theme_asset_migration_conflict',
        )
      } else {
        const target = await inspect(input.targetPath)
        if (target.isSymbolicLink() || !target.isFile() || target.nlink != 1n ||
          !sameFile(identityOf(target), input.identity)) throw new Error('theme_asset_migration_conflict')
      }
      revalidateDirectDirectory(input.targetRoot)
      revalidateDirectDirectory(input.root)
    } catch {
      throw new Error('theme_asset_migration_conflict')
    }
  }

  const installLegacy = async(fileName: string, bytes: Buffer): Promise<void> => {
    await ensureAssetRoot()
    const targetPath = path.join(assetRoot, fileName)
    assertDirectFilePath(assetRoot, targetPath, 'theme_asset_migration_conflict')
    const root = openRootGuard(assetRoot, assetRootIdentity!, 'theme_asset_migration_conflict')
    let targetRoot: DirectDirectoryGuard | null = null
    let descriptor: Awaited<ReturnType<typeof fs.open>> | null = null
    let createdIdentity: NodeIdentity | null = null
    try {
      try {
        descriptor = await fs.open(targetPath, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code != 'EEXIST') throw error
        targetRoot = validateDirectDirectory(assetRoot)
        const existing = await inspect(targetPath)
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink != 1n) {
          throw new Error('theme_asset_migration_conflict')
        }
        const existingIdentity = identityOf(existing)
        await revalidateLegacyTarget({ root, targetRoot, targetPath, identity: existingIdentity })
        await readOwnedPayload(
          targetPath,
          existingIdentity,
          sha256(bytes),
          'theme_asset_migration_conflict',
        )
        await revalidateLegacyTarget({ root, targetRoot, targetPath, identity: existingIdentity })
        await revalidateLegacyTarget({ root, targetRoot, targetPath, identity: existingIdentity })
        return
      }
      const opened = await descriptor.stat({ bigint: true })
      if (!opened.isFile() || opened.nlink != 1n) throw new Error('theme_asset_migration_conflict')
      const openedIdentity = identityOf(opened)
      createdIdentity = openedIdentity
      targetRoot = validateDirectDirectory(assetRoot)
      await revalidateLegacyTarget({
        root,
        targetRoot,
        targetPath,
        identity: openedIdentity,
        descriptor,
      })
      await descriptor.writeFile(bytes)
      await descriptor.sync()
      const written = await descriptor.stat({ bigint: true })
      const writtenIdentity = identityOf(written)
      if (!written.isFile() || written.nlink != 1n || !sameNode(writtenIdentity, createdIdentity)) {
        throw new Error('theme_asset_migration_conflict')
      }
      await revalidateLegacyTarget({
        root,
        targetRoot,
        targetPath,
        identity: writtenIdentity,
        descriptor,
      })
      await descriptor.close()
      descriptor = null
      await readOwnedPayload(
        targetPath,
        createdIdentity,
        sha256(bytes),
        'theme_asset_migration_conflict',
      )
      await revalidateLegacyTarget({ root, targetRoot, targetPath, identity: writtenIdentity })
      await revalidateLegacyTarget({ root, targetRoot, targetPath, identity: writtenIdentity })
    } catch (error) {
      try { await descriptor?.close() } catch {}
      descriptor = null
      if (createdIdentity != null) {
        if (targetRoot == null) {
          try {
            const candidate = validateDirectDirectory(assetRoot)
            const current = await inspect(targetPath)
            if (current.isSymbolicLink() || !current.isFile() || current.nlink != 1n ||
              !sameNode(identityOf(current), createdIdentity)) {
              closeDirectDirectory(candidate)
            } else {
              targetRoot = candidate
            }
          } catch {}
        }
        try {
          if (targetRoot == null) throw new Error('theme_asset_migration_conflict')
          await isolateAndReclaim({
            root: targetRoot,
            filePath: targetPath,
            identity: createdIdentity,
            prefix: `.${fileName}.isolate-`,
            verify: async payloadPath => {
              await readOwnedPayload(payloadPath, createdIdentity!, null, 'theme_asset_migration_conflict')
            },
            errorCode: 'theme_asset_migration_conflict',
          })
        } catch {
          throw new Error('theme_asset_migration_conflict')
        }
      }
      throw fixedThemeError(error, 'theme_asset_migration_conflict')
    } finally {
      try { await descriptor?.close() } catch {}
      if (targetRoot != null) {
        try { closeDirectDirectory(targetRoot) } catch {}
      }
      closeDirectDirectory(root)
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
      const stage = await openVerifiedStage(staged.stagingId, staged.previewPath)
      let root: DirectDirectoryGuard | null = null
      let durable: ImmutableArtifactGuard | null = null
      try {
        await ensureAssetRoot()
        root = openRootGuard(assetRoot, assetRootIdentity!, 'theme_asset_invalid')
        durable = completeThemeTarget(root, stage.bytes)
        await revalidateStageAgainstDescriptor(stage)
        await consumeThemeStage(stage)
        return await commit({ fileName: durable.basename, previewPath: durable.path })
      } catch (error) {
        if (durable != null) {
          try {
            await rollbackDurableTarget(durable)
          } catch {
            durable = null
            throw new Error('theme_asset_invalid')
          }
          durable = null
        }
        throw fixedThemeError(error, 'theme_asset_invalid')
      } finally {
        await stage.close()
        if (durable != null) {
          try { closeArtifactGuard(durable) } catch {}
        }
        if (root != null) closeDirectDirectory(root)
      }
    }),
    discardThemeImage: async({ stagingId }) => {
      await withStage(stagingId, async() => {
        const stage = await openVerifiedStage(stagingId)
        try {
          await revalidateStageAgainstDescriptor(stage)
          await consumeThemeStage(stage)
        } catch (error) {
          throw fixedThemeError(error, 'theme_stage_invalid')
        } finally {
          await stage.close()
        }
      })
    },
  }
}
