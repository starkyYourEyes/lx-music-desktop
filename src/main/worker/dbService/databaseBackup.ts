import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export type OnlineBackupVerifier = (db: Database.Database) => void

interface FileIdentity {
  dev: bigint
  ino: bigint
}

interface RootGuard {
  descriptor: number
  identity: FileIdentity
  path: string
  realPath: string
}

interface FileGuard {
  descriptor: number
  identity: FileIdentity
  path: string
}

const activeDestinations = new Set<string>()
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const
const SNAPSHOT_WRITE_CHUNK_BYTES = 1024 * 1024
const SINGLE_LINK = [1n] as const
const PUBLISHED_LINKS = [2n] as const
const REUSABLE_LINKS = [1n, 2n] as const
const STAGE_NAME_PATTERN = /^\.lx-backup-[0-9a-f]{32}\.stage$/

const failure = (code: string): Error => new Error(code)

const normalizeError = (error: unknown, fallbackCode: string): Error => error instanceof Error
  ? error
  : failure(fallbackCode)

const errorCode = (error: unknown): string | null => error != null && typeof error == 'object' && 'code' in error &&
  typeof error.code == 'string'
  ? error.code
  : null

const sameIdentity = (left: FileIdentity, right: FileIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino

const identityOf = (stats: fs.BigIntStats): FileIdentity => ({ dev: stats.dev, ino: stats.ino })

const pathKey = (filePath: string): string => process.platform == 'win32'
  ? filePath.toLowerCase()
  : filePath

const samePath = (left: string, right: string): boolean => pathKey(path.resolve(left)) == pathKey(path.resolve(right))

const closeDescriptor = (descriptor: number): void => {
  try {
    fs.closeSync(descriptor)
  } catch {}
}

const assertPrivateRegularFile = (
  stats: fs.BigIntStats,
  allowedLinkCounts: readonly bigint[] = SINGLE_LINK,
): void => {
  if (!stats.isFile() || stats.isSymbolicLink() || !allowedLinkCounts.includes(stats.nlink) ||
    (process.platform != 'win32' && (stats.mode & 0o077n) != 0n)) {
    throw failure('backup_file_ownership_invalid')
  }
}

const openRootGuard = (rootPath: string): RootGuard => {
  const before = fs.lstatSync(rootPath, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory()) throw failure('backup_root_invalid')
  const descriptor = fs.openSync(rootPath, fs.constants.O_RDONLY | NO_FOLLOW)
  try {
    const guarded = fs.fstatSync(descriptor, { bigint: true })
    if (!guarded.isDirectory() || !sameIdentity(identityOf(before), identityOf(guarded))) {
      throw failure('backup_root_invalid')
    }
    return {
      descriptor,
      identity: identityOf(guarded),
      path: rootPath,
      realPath: fs.realpathSync.native(rootPath),
    }
  } catch (error) {
    closeDescriptor(descriptor)
    throw error
  }
}

const assertRootGuard = (root: RootGuard): void => {
  const guarded = fs.fstatSync(root.descriptor, { bigint: true })
  const current = fs.lstatSync(root.path, { bigint: true })
  if (!guarded.isDirectory() || current.isSymbolicLink() || !current.isDirectory() ||
    !sameIdentity(identityOf(guarded), root.identity) ||
    !sameIdentity(identityOf(current), root.identity) ||
    !samePath(fs.realpathSync.native(root.path), root.realPath)) {
    throw failure('backup_root_identity_changed')
  }
}

const assertDirectChild = (root: RootGuard, filePath: string): void => {
  if (!samePath(path.dirname(filePath), root.path)) throw failure('backup_path_invalid')
  const realFilePath = fs.realpathSync.native(filePath)
  if (!samePath(path.dirname(realFilePath), root.realPath)) throw failure('backup_path_invalid')
}

const assertFileGuard = (
  root: RootGuard,
  file: FileGuard,
  allowedLinkCounts: readonly bigint[] = SINGLE_LINK,
): fs.BigIntStats => {
  assertRootGuard(root)
  const guarded = fs.fstatSync(file.descriptor, { bigint: true })
  const current = fs.lstatSync(file.path, { bigint: true })
  assertPrivateRegularFile(guarded, allowedLinkCounts)
  assertPrivateRegularFile(current, allowedLinkCounts)
  if (!sameIdentity(identityOf(guarded), file.identity) ||
    !sameIdentity(identityOf(current), file.identity)) {
    throw failure('backup_file_identity_changed')
  }
  assertDirectChild(root, file.path)
  return guarded
}

const assertPathAbsent = (filePath: string): void => {
  try {
    fs.lstatSync(filePath)
  } catch (error) {
    if (errorCode(error) == 'ENOENT') return
    throw error
  }
  throw failure('backup_destination_exists')
}

const assertNoSqliteSidecars = (filePath: string): void => {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) assertPathAbsent(`${filePath}${suffix}`)
}

const captureSqliteSidecars = (root: RootGuard, filePath: string): FileGuard[] => {
  const sidecars: FileGuard[] = []
  try {
    for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
      const sidecarPath = `${filePath}${suffix}`
      try {
        sidecars.push(openExistingFileGuard(root, sidecarPath))
      } catch (error) {
        if (errorCode(error) != 'ENOENT') throw error
      }
    }
    return sidecars
  } catch (error) {
    for (const sidecar of sidecars) closeDescriptor(sidecar.descriptor)
    throw error
  }
}

const removeCapturedSidecars = (root: RootGuard, sidecars: readonly FileGuard[]): void => {
  let cleanupError: unknown = null
  for (const sidecar of sidecars) {
    try {
      try {
        fs.lstatSync(sidecar.path)
      } catch (error) {
        if (errorCode(error) == 'ENOENT') continue
        throw error
      }
      if (!removeExactOwnedFile(root, sidecar)) throw failure('backup_sidecar_identity_changed')
    } catch (error) {
      cleanupError ??= error
    } finally {
      closeDescriptor(sidecar.descriptor)
    }
  }
  if (cleanupError != null) throw normalizeError(cleanupError, 'backup_sidecar_cleanup_failed')
}

const openAttemptStage = (root: RootGuard): FileGuard => {
  for (let attempt = 0; attempt < 16; attempt++) {
    assertRootGuard(root)
    const stagePath = path.join(
      root.path,
      `.lx-backup-${crypto.randomBytes(16).toString('hex')}.stage`,
    )
    let descriptor: number
    try {
      descriptor = fs.openSync(
        stagePath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | NO_FOLLOW,
        0o600,
      )
    } catch (error) {
      if (errorCode(error) == 'EEXIST') continue
      throw error
    }
    const file = { descriptor, identity: identityOf(fs.fstatSync(descriptor, { bigint: true })), path: stagePath }
    try {
      assertFileGuard(root, file)
      return file
    } catch (error) {
      closeDescriptor(descriptor)
      throw error
    }
  }
  throw failure('backup_stage_reservation_failed')
}

const openExistingFileGuard = (
  root: RootGuard,
  filePath: string,
  allowedLinkCounts: readonly bigint[] = SINGLE_LINK,
): FileGuard => {
  assertRootGuard(root)
  const before = fs.lstatSync(filePath, { bigint: true })
  assertPrivateRegularFile(before, allowedLinkCounts)
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW)
  const file = { descriptor, identity: identityOf(before), path: filePath }
  try {
    assertFileGuard(root, file, allowedLinkCounts)
    return file
  } catch (error) {
    closeDescriptor(descriptor)
    throw error
  }
}

const assertRetainedStageLink = (root: RootGuard, file: FileGuard): void => {
  // A reusable two-link final must be paired with the attempt's retained random stage.
  assertFileGuard(root, file, PUBLISHED_LINKS)
  assertRootGuard(root)
  let retainedStage: FileGuard | null = null
  try {
    for (const name of fs.readdirSync(root.path)) {
      if (!STAGE_NAME_PATTERN.test(name)) continue
      const stagePath = path.join(root.path, name)
      if (samePath(stagePath, file.path)) continue
      const stats = fs.lstatSync(stagePath, { bigint: true })
      if (!sameIdentity(identityOf(stats), file.identity)) continue
      if (retainedStage != null) throw failure('backup_file_ownership_invalid')
      retainedStage = openExistingFileGuard(root, stagePath, PUBLISHED_LINKS)
      if (!sameIdentity(retainedStage.identity, file.identity)) {
        throw failure('backup_file_ownership_invalid')
      }
    }
    if (retainedStage == null) throw failure('backup_file_ownership_invalid')
    assertFileGuard(root, retainedStage, PUBLISHED_LINKS)
    assertFileGuard(root, file, PUBLISHED_LINKS)
  } finally {
    if (retainedStage != null) closeDescriptor(retainedStage.descriptor)
  }
}

const writeConsistentSnapshot = (root: RootGuard, stage: FileGuard, db: Database.Database): void => {
  const snapshot = db.serialize()
  if (!Buffer.isBuffer(snapshot)) throw failure('backup_snapshot_invalid')

  const before = assertFileGuard(root, stage)
  if (before.size != 0n) throw failure('backup_stage_size_invalid')

  let offset = 0
  while (offset < snapshot.length) {
    const length = Math.min(SNAPSHOT_WRITE_CHUNK_BYTES, snapshot.length - offset)
    const written = fs.writeSync(stage.descriptor, snapshot, offset, length, offset)
    if (written <= 0 || written > length) throw failure('backup_snapshot_write_failed')
    offset += written
  }
  fs.fsyncSync(stage.descriptor)

  const after = assertFileGuard(root, stage)
  if (after.size != BigInt(snapshot.length)) throw failure('backup_snapshot_size_invalid')
}

const verifyGuardedBackup = (
  root: RootGuard,
  file: FileGuard,
  nativeOptions: { nativeBinding?: string },
  verify?: OnlineBackupVerifier,
  allowedLinkCounts: readonly bigint[] = SINGLE_LINK,
): void => {
  assertNoSqliteSidecars(file.path)
  assertFileGuard(root, file, allowedLinkCounts)
  let verificationDb: Database.Database | null = null
  let sidecars: FileGuard[] = []
  let verificationError: Error | null = null
  try {
    verificationDb = new Database(file.path, { ...nativeOptions, readonly: true, fileMustExist: true })
    assertFileGuard(root, file, allowedLinkCounts)
    if (verificationDb.pragma('quick_check', { simple: true }) != 'ok') {
      throw failure('backup_quick_check_failed')
    }
    verify?.(verificationDb)
  } catch (error) {
    verificationError = normalizeError(error, 'backup_verification_failed')
  }
  let captureError: Error | null = null
  try {
    sidecars = captureSqliteSidecars(root, file.path)
  } catch (error) {
    captureError = normalizeError(error, 'backup_sidecar_capture_failed')
  }
  let closeError: Error | null = null
  try {
    verificationDb?.close()
  } catch (error) {
    closeError = normalizeError(error, 'backup_verification_close_failed')
  }
  let cleanupError: Error | null = null
  try {
    removeCapturedSidecars(root, sidecars)
  } catch (error) {
    cleanupError = normalizeError(error, 'backup_sidecar_cleanup_failed')
  }
  const operationError = verificationError ?? captureError ?? closeError ?? cleanupError
  if (operationError != null) throw operationError
  assertFileGuard(root, file, allowedLinkCounts)
  assertNoSqliteSidecars(file.path)
}

const assertLinkedStageAndFinal = (root: RootGuard, stage: FileGuard, destination: string): void => {
  assertRootGuard(root)
  const guarded = fs.fstatSync(stage.descriptor, { bigint: true })
  const currentStage = fs.lstatSync(stage.path, { bigint: true })
  const currentFinal = fs.lstatSync(destination, { bigint: true })
  for (const stats of [guarded, currentStage, currentFinal]) {
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink != 2n ||
      (process.platform != 'win32' && (stats.mode & 0o077n) != 0n) ||
      !sameIdentity(identityOf(stats), stage.identity)) {
      throw failure('backup_publication_identity_invalid')
    }
  }
  assertDirectChild(root, stage.path)
  assertDirectChild(root, destination)
}

const removeExactOwnedFile = (root: RootGuard, file: FileGuard): boolean => {
  try {
    assertFileGuard(root, file)
    fs.unlinkSync(file.path)
    return true
  } catch {
    return false
  }
}

export function verifyOnlineBackup(
  destination: string,
  nativeOptions: { nativeBinding?: string } = {},
  verify?: OnlineBackupVerifier,
): void {
  const resolvedDestination = path.resolve(destination)
  const root = openRootGuard(path.dirname(resolvedDestination))
  let file: FileGuard | null = null
  try {
    file = openExistingFileGuard(root, resolvedDestination, REUSABLE_LINKS)
    const stats = assertFileGuard(root, file, REUSABLE_LINKS)
    const hasRetainedStage = stats.nlink == 2n
    const linkState = hasRetainedStage ? PUBLISHED_LINKS : SINGLE_LINK
    if (hasRetainedStage) assertRetainedStageLink(root, file)
    verifyGuardedBackup(root, file, nativeOptions, verify, linkState)
    if (hasRetainedStage) assertRetainedStageLink(root, file)
  } finally {
    if (file != null) closeDescriptor(file.descriptor)
    closeDescriptor(root.descriptor)
  }
}

export async function createOnlineBackup(
  db: Database.Database,
  destination: string,
  nativeOptions: { nativeBinding?: string } = {},
  verify?: OnlineBackupVerifier,
): Promise<void> {
  const resolvedDestination = path.resolve(destination)
  const destinationKey = pathKey(resolvedDestination)
  if (activeDestinations.has(destinationKey)) throw failure('backup_destination_busy')
  activeDestinations.add(destinationKey)

  let root: RootGuard | null = null
  let stage: FileGuard | null = null
  try {
    fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true })
    root = openRootGuard(path.dirname(resolvedDestination))
    assertPathAbsent(resolvedDestination)
    assertNoSqliteSidecars(resolvedDestination)

    stage = openAttemptStage(root)
    assertFileGuard(root, stage)
    writeConsistentSnapshot(root, stage, db)
    verifyGuardedBackup(root, stage, nativeOptions, verify)

    assertRootGuard(root)
    assertPathAbsent(resolvedDestination)
    assertFileGuard(root, stage)
    const final = { descriptor: stage.descriptor, identity: stage.identity, path: resolvedDestination }
    fs.linkSync(stage.path, resolvedDestination)
    assertLinkedStageAndFinal(root, stage, resolvedDestination)
    verifyGuardedBackup(root, final, nativeOptions, verify, PUBLISHED_LINKS)
    assertLinkedStageAndFinal(root, stage, resolvedDestination)
  } finally {
    if (stage != null) closeDescriptor(stage.descriptor)
    if (root != null) closeDescriptor(root.descriptor)
    activeDestinations.delete(destinationKey)
  }
}
