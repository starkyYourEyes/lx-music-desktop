import Database from 'better-sqlite3'
import { randomUUID as createRandomUUID } from 'node:crypto'
import fs from 'node:fs'
import { endianness } from 'node:os'
import path from 'node:path'
import { bootstrapCacheSchema, migrateCacheSchemaV1ToV2 } from './cacheMigrate'
import { inspectCacheSchema, verifyCacheSchema, verifyCacheSchemaV1 } from './cacheSchemaContract'
import { getDatabaseInitialization } from './db'
import { getCachePhasePrerequisite } from './modules/phase3'
import {
  closeDirectDirectory,
  createDirectChildDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
} from '../../storage/directDirectory'
import {
  acquireExpectedSqliteTarget,
  closeSqliteGuardDescriptor,
  isExclusiveSqliteFile,
  isPathContained,
  prepareSqliteTarget,
  resolveContainedPath,
  sameSqliteFileIdentity,
  sqliteFileIdentity,
  validatePreparedSqliteTarget,
  type SqliteFileIdentity,
  type SqliteTargetExpectation,
} from './sqliteTarget'

export type CacheLifecycleState = 'closed' | 'opening' | 'ready' | 'unavailable' | 'resetting'

export type CacheDiagnosticCode =
  | 'cache_phase3_prerequisite_invalid'
  | 'cache_target_invalid'
  | 'cache_open_failed'
  | 'cache_schema_invalid'
  | 'cache_integrity_failed'
  | 'cache_operation_failed'
  | 'cache_close_failed'
  | 'cache_delete_failed'
  | 'cache_reopen_failed'
  | 'cache_capacity_unavailable'

export type CacheReadResult<T> =
  | { status: 'hit', value: T }
  | { status: 'miss' }
  | { status: 'unavailable', code: CacheDiagnosticCode }

export type CacheWriteResult =
  | { status: 'stored' }
  | { status: 'unavailable', code: CacheDiagnosticCode }

export type CacheExecutionResult<T> =
  | { status: 'completed', value: T }
  | { status: 'unavailable', code: CacheDiagnosticCode }

export interface CacheOpenResult {
  status: 'ready' | 'created' | 'recreated' | 'unavailable'
  schemaVersion: 2 | null
  diagnostic: CacheDiagnosticCode | null
}

export interface CacheResetLease {
  resetId: string
}

export interface CacheWorkerLifecycle {
  openCacheDatabase: () => Promise<CacheOpenResult>
  beginCacheReset: () => Promise<CacheResetLease>
  finishCacheReset: (input: CacheResetLease) => Promise<CacheOpenResult>
  abortCacheReset: (input: CacheResetLease) => Promise<void>
  getCacheLifecycleState: () => Promise<CacheLifecycleState>
}

type CacheDatabaseHandle = Database.Database

export interface CacheRepositoryGate {
  runCacheRead: <T>(operation: (db: CacheDatabaseHandle) => T | null | undefined) => Promise<CacheReadResult<T>>
  runCacheWrite: (operation: (db: CacheDatabaseHandle) => void) => Promise<CacheWriteResult>
  runCacheImmediate: <T>(operation: (db: CacheDatabaseHandle) => T) => Promise<CacheExecutionResult<T>>
  runCacheRollbackOnly: <T>(operation: (db: CacheDatabaseHandle) => T) => Promise<CacheExecutionResult<T>>
}

type CacheDatabaseConstructor = new(filename: string, options?: Database.Options) => Database.Database

export interface CacheDatabaseServiceOptions {
  DatabaseImplementation?: CacheDatabaseConstructor
  fileSystem?: typeof fs
  pathModule?: typeof path
  now?: () => number
  randomUUID?: () => string
  getInitialization?: typeof getDatabaseInitialization
  verifyPhase3Prerequisite?: typeof getCachePhasePrerequisite
  invalidateRepositories?: () => void
}

export interface CacheDatabaseService extends CacheWorkerLifecycle, CacheRepositoryGate {
  closeCacheDatabase: () => Promise<void>
}

interface CacheRootOwnership {
  path: string
  realPath: string
  identity: { dev: string, ino: string }
}

interface CacheArtifactSnapshot {
  name: CacheArtifactName
  path: string
  identity: SqliteFileIdentity
  size: number
}

interface ActiveCacheConnection {
  db: Database.Database
  databasePath: string
  root: CacheRootOwnership
  target: SqliteTargetExpectation
  artifacts: Map<CacheArtifactName, CacheArtifactSnapshot>
}

type CacheArtifactName = typeof cacheArtifactNames[number]

type CandidateResult =
  | { ok: true, connection: ActiveCacheConnection, existed: boolean }
  | {
    ok: false
    diagnostic: CacheDiagnosticCode
    existed: boolean
    snapshots: Map<CacheArtifactName, CacheArtifactSnapshot> | null
  }

interface QueueJob<T> {
  operation: () => T | Promise<T>
  holdOnSuccess: boolean
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

interface ActiveReset {
  resetId: string
  status: 'held' | 'finishing'
}

const cacheArtifactNames = ['cache.db', 'cache.db-wal', 'cache.db-shm'] as const
const fixedDiagnosticCodes = new Set<CacheDiagnosticCode>([
  'cache_phase3_prerequisite_invalid',
  'cache_target_invalid',
  'cache_open_failed',
  'cache_schema_invalid',
  'cache_integrity_failed',
  'cache_operation_failed',
  'cache_close_failed',
  'cache_delete_failed',
  'cache_reopen_failed',
  'cache_capacity_unavailable',
])

const repositoryInvalidators = new Set<() => void>()

export const registerCacheRepositoryInvalidator = (invalidate: () => void): (() => void) => {
  repositoryInvalidators.add(invalidate)
  return () => { repositoryInvalidators.delete(invalidate) }
}

const invalidateRegisteredRepositories = (): void => {
  let failure: unknown | null = null
  for (const invalidate of repositoryInvalidators) {
    try {
      invalidate()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure instanceof Error) throw failure
  if (failure != null) throw new Error('cache_operation_failed')
}

const fixedError = (code: CacheDiagnosticCode): Error & { code: CacheDiagnosticCode } => {
  const error = new Error(code) as Error & { code: CacheDiagnosticCode }
  error.code = code
  return error
}

const sourceCode = (error: unknown): string =>
  error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string'
    ? error.code
    : ''

const classifyCacheError = (
  error: unknown,
  fallback: CacheDiagnosticCode,
): CacheDiagnosticCode => {
  const code = sourceCode(error)
  if (fixedDiagnosticCodes.has(code as CacheDiagnosticCode)) return code as CacheDiagnosticCode
  if (code == 'ENOSPC' || /^SQLITE_FULL(?:_|$)/.test(code)) return 'cache_capacity_unavailable'
  if (/^(SQLITE_CORRUPT|SQLITE_NOTADB)(?:_|$)/.test(code)) return 'cache_integrity_failed'
  return fallback
}

const isMissing = (error: unknown): boolean => sourceCode(error) == 'ENOENT'

const isPlainLease = (value: unknown): value is CacheResetLease => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) != Object.prototype) {
    return false
  }
  const keys = Reflect.ownKeys(value)
  return keys.length == 1 && keys[0] == 'resetId' &&
    typeof (value as { resetId?: unknown }).resetId == 'string' &&
    (value as { resetId: string }).resetId.length > 0
}

const isThenable = (value: unknown): boolean =>
  value != null && (typeof value == 'object' || typeof value == 'function') &&
  'then' in value && typeof (value as { then?: unknown }).then == 'function'

const getNativeOptions = (
  fileSystem: typeof fs,
  pathModule: typeof path,
): { nativeBinding?: string } => {
  const nativeBinding = pathModule.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  try {
    fileSystem.statSync(nativeBinding)
    return { nativeBinding }
  } catch (error) {
    if (!isMissing(error)) throw error
    return {}
  }
}

const prepareCacheRoot = (
  cacheRoot: string,
  fileSystem: typeof fs,
  pathModule: typeof path,
): CacheRootOwnership => {
  const resolved = pathModule.resolve(cacheRoot)
  const parentPath = pathModule.dirname(resolved)
  let parent
  let root
  try {
    parent = validateDirectDirectory(parentPath, { fsApi: fileSystem, pathApi: pathModule })
    try {
      root = validateDirectDirectory(resolved, { fsApi: fileSystem, pathApi: pathModule })
    } catch (error) {
      if (!isMissing(error) && (error as { code?: unknown })?.code != 'direct_directory_invalid') throw error
      root = createDirectChildDirectory(parent, pathModule.basename(resolved), { mode: 0o700 })
    }
    revalidateDirectDirectory(parent)
    revalidateDirectDirectory(root)
    return { path: resolved, realPath: root.realPath, identity: root.identity }
  } catch (error) {
    throw fixedError('cache_target_invalid')
  } finally {
    if (root != null) closeDirectDirectory(root)
    if (parent != null) closeDirectDirectory(parent)
  }
}

const validateCacheRoot = (
  root: CacheRootOwnership,
  fileSystem: typeof fs,
): boolean => {
  try {
    const stats = fileSystem.lstatSync(root.path, { bigint: true })
    return !stats.isSymbolicLink() && stats.isDirectory() &&
      String(stats.dev) == root.identity.dev && String(stats.ino) == root.identity.ino &&
      fileSystem.realpathSync(root.path) == root.realPath
  } catch {
    return false
  }
}

const inspectArtifact = (
  root: CacheRootOwnership,
  name: CacheArtifactName,
  fileSystem: typeof fs,
  pathModule: typeof path,
): CacheArtifactSnapshot | null => {
  if (!validateCacheRoot(root, fileSystem)) throw fixedError('cache_target_invalid')
  const artifactPath = resolveContainedPath(root.path, name, pathModule)
  if (pathModule.dirname(artifactPath) != root.path) throw fixedError('cache_target_invalid')
  let stats: fs.Stats
  try {
    stats = fileSystem.lstatSync(artifactPath)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (stats.isSymbolicLink() || !isExclusiveSqliteFile(stats) ||
    !isPathContained(root.realPath, fileSystem.realpathSync(artifactPath), pathModule)) {
    throw fixedError('cache_target_invalid')
  }
  return { name, path: artifactPath, identity: sqliteFileIdentity(stats), size: stats.size }
}

const readSidecarBytes = (
  descriptor: number,
  length: number,
  fileSystem: typeof fs,
  position = 0,
): Buffer => {
  const value = Buffer.allocUnsafe(length)
  let offset = 0
  while (offset < length) {
    const bytesRead = fileSystem.readSync(descriptor, value, offset, length - offset, position + offset)
    if (bytesRead <= 0) throw fixedError('cache_integrity_failed')
    offset += bytesRead
  }
  return value
}

const calculateWalChecksum = (
  value: Buffer,
  length: number,
  byteOrder: 'BE' | 'LE',
  initial: readonly [number, number] = [0, 0],
): readonly [number, number] => {
  let [first, second] = initial
  const readWord = byteOrder == 'BE'
    ? (offset: number): number => value.readUInt32BE(offset)
    : (offset: number): number => value.readUInt32LE(offset)
  for (let offset = 0; offset < length; offset += 8) {
    first = (first + readWord(offset) + second) >>> 0
    second = (second + readWord(offset + 4) + first) >>> 0
  }
  return [first, second]
}

const isSqlitePageSize = (value: number): boolean =>
  value >= 512 && value <= 65536 && (value & (value - 1)) == 0

interface WalHeader {
  byteOrder: 'BE' | 'LE'
  pageSize: number
  salt: readonly [number, number]
  checksum: readonly [number, number]
}

interface WalReplayPrefix {
  lastCommittedFrameEnd: number | null
  databasePages: number | null
}

const MAX_CACHE_PREFLIGHT_BYTES = 256 * 1024 * 1024
const SQLITE_MAX_PAGE_NUMBER = 0xfffffffe
const SQLITE_HEADER_BYTES = 100
const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\0', 'ascii')

const validateWalHeader = (header: Buffer): WalHeader => {
  const magic = header.readUInt32BE(0)
  if (magic != 0x377f0682 && magic != 0x377f0683) throw fixedError('cache_integrity_failed')
  const pageSize = header.readUInt32BE(8)
  if (header.readUInt32BE(4) != 3007000 || !isSqlitePageSize(pageSize)) {
    throw fixedError('cache_integrity_failed')
  }
  const byteOrder = magic == 0x377f0683 ? 'BE' : 'LE'
  const checksum = calculateWalChecksum(header, 24, byteOrder)
  if (header.readUInt32BE(24) != checksum[0] || header.readUInt32BE(28) != checksum[1]) {
    throw fixedError('cache_integrity_failed')
  }
  return {
    byteOrder,
    pageSize,
    salt: [header.readUInt32BE(16), header.readUInt32BE(20)],
    checksum,
  }
}

const scanWalFrames = (
  size: number,
  header: WalHeader,
  readFrame: (position: number, length: number) => Buffer,
): WalReplayPrefix => {
  const frameSize = 24 + header.pageSize
  let checksum = header.checksum
  let hasCommittedPrefix = false
  let lastCommittedFrameEnd: number | null = null
  let databasePages: number | null = null
  // SQLite treats an incomplete or invalid frame after a committed prefix as the end of the WAL.
  for (let position = 32; position + frameSize <= size; position += frameSize) {
    const frame = readFrame(position, frameSize)
    if (frame.readUInt32BE(0) == 0 || frame.readUInt32BE(8) != header.salt[0] ||
      frame.readUInt32BE(12) != header.salt[1]) {
      if (hasCommittedPrefix) break
      throw fixedError('cache_integrity_failed')
    }
    let nextChecksum = calculateWalChecksum(frame, 8, header.byteOrder, checksum)
    nextChecksum = calculateWalChecksum(frame.subarray(24), header.pageSize, header.byteOrder, nextChecksum)
    if (frame.readUInt32BE(16) != nextChecksum[0] || frame.readUInt32BE(20) != nextChecksum[1]) {
      if (hasCommittedPrefix) break
      throw fixedError('cache_integrity_failed')
    }
    checksum = nextChecksum
    const pageNumber = frame.readUInt32BE(0)
    const commitPages = frame.readUInt32BE(4)
    if (pageNumber > SQLITE_MAX_PAGE_NUMBER) throw fixedError('cache_integrity_failed')
    if (commitPages != 0) {
      hasCommittedPrefix = true
      lastCommittedFrameEnd = position + frameSize
      databasePages = commitPages
    }
  }
  if (databasePages != null && databasePages > Math.floor(MAX_CACHE_PREFLIGHT_BYTES / header.pageSize)) {
    throw fixedError('cache_capacity_unavailable')
  }
  return { lastCommittedFrameEnd, databasePages }
}

const validateWalFrames = (
  descriptor: number,
  size: number,
  header: WalHeader,
  fileSystem: typeof fs,
): WalReplayPrefix => scanWalFrames(
  size,
  header,
  (position, length) => readSidecarBytes(descriptor, length, fileSystem, position),
)

const validateShmHeader = (header: Buffer): void => {
  if (header.every(byte => byte == 0)) return
  const first = header.subarray(0, 48)
  const second = header.subarray(48, 96)
  if (!first.equals(second) || first[12] != 1) throw fixedError('cache_integrity_failed')
  const nativeOrder = endianness()
  const readUInt32 = nativeOrder == 'BE'
    ? (offset: number): number => first.readUInt32BE(offset)
    : (offset: number): number => first.readUInt32LE(offset)
  const encodedPageSize = nativeOrder == 'BE' ? first.readUInt16BE(14) : first.readUInt16LE(14)
  const pageSize = (encodedPageSize & 0xfe00) + ((encodedPageSize & 0x0001) << 16)
  const emptyIndex = readUInt32(16) == 0 && readUInt32(20) == 0
  const checksum = calculateWalChecksum(first, 40, nativeOrder)
  if (readUInt32(0) != 3007000 || (!isSqlitePageSize(pageSize) && !(pageSize == 0 && emptyIndex)) ||
    readUInt32(40) != checksum[0] || readUInt32(44) != checksum[1]) {
    throw fixedError('cache_integrity_failed')
  }
}

const validateSidecarHeader = (
  snapshot: CacheArtifactSnapshot,
  fileSystem: typeof fs,
): void => {
  if (snapshot.name == 'cache.db' || snapshot.size == 0) return
  if (snapshot.name == 'cache.db-wal' && snapshot.size > MAX_CACHE_PREFLIGHT_BYTES) {
    throw fixedError('cache_capacity_unavailable')
  }
  const minimumSize = snapshot.name == 'cache.db-wal' ? 32 : 32768
  if (snapshot.size < minimumSize) throw fixedError('cache_integrity_failed')
  if (snapshot.name == 'cache.db-shm' && snapshot.size % 32768 != 0) {
    throw fixedError('cache_integrity_failed')
  }
  let descriptor: number | null = null
  try {
    const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0
    descriptor = fileSystem.openSync(snapshot.path, fileSystem.constants.O_RDONLY | noFollow)
    const opened = fileSystem.fstatSync(descriptor)
    if (!isExclusiveSqliteFile(opened) ||
      !sameSqliteFileIdentity(sqliteFileIdentity(opened), snapshot.identity)) {
      throw fixedError('cache_target_invalid')
    }
    if (opened.size != snapshot.size) throw fixedError('cache_integrity_failed')
    if (snapshot.name == 'cache.db-wal') {
      const header = validateWalHeader(readSidecarBytes(descriptor, 32, fileSystem))
      validateWalFrames(descriptor, snapshot.size, header, fileSystem)
    } else {
      validateShmHeader(readSidecarBytes(descriptor, 96, fileSystem))
    }
    const verified = fileSystem.fstatSync(descriptor)
    if (!isExclusiveSqliteFile(verified) || verified.size != snapshot.size ||
      !sameSqliteFileIdentity(sqliteFileIdentity(verified), snapshot.identity)) {
      throw fixedError('cache_target_invalid')
    }
  } finally {
    if (descriptor != null) {
      try { fileSystem.closeSync(descriptor) } catch {}
    }
  }
}

const readBoundedArtifactFromDescriptor = (
  descriptor: number,
  snapshot: CacheArtifactSnapshot,
  maximumBytes: number,
  fileSystem: typeof fs,
): Buffer => {
  const opened = fileSystem.fstatSync(descriptor)
  if (!isExclusiveSqliteFile(opened) || opened.size != snapshot.size ||
    !sameSqliteFileIdentity(sqliteFileIdentity(opened), snapshot.identity)) {
    throw fixedError('cache_target_invalid')
  }
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.size > maximumBytes) {
    throw fixedError('cache_capacity_unavailable')
  }
  const bytes = readSidecarBytes(descriptor, snapshot.size, fileSystem)
  const verified = fileSystem.fstatSync(descriptor)
  if (!isExclusiveSqliteFile(verified) || verified.size != snapshot.size ||
    !sameSqliteFileIdentity(sqliteFileIdentity(verified), snapshot.identity)) {
    throw fixedError('cache_target_invalid')
  }
  return bytes
}

const readBoundedArtifact = (
  snapshot: CacheArtifactSnapshot,
  maximumBytes: number,
  fileSystem: typeof fs,
): Buffer => {
  let descriptor: number | null = null
  try {
    const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0
    descriptor = fileSystem.openSync(snapshot.path, fileSystem.constants.O_RDONLY | noFollow)
    return readBoundedArtifactFromDescriptor(descriptor, snapshot, maximumBytes, fileSystem)
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(sourceCode(error))) throw fixedError('cache_target_invalid')
    throw error
  } finally {
    closeSqliteGuardDescriptor(fileSystem, descriptor)
  }
}

const validateMainDatabaseImage = (bytes: Buffer): number => {
  if (bytes.length < SQLITE_HEADER_BYTES || !bytes.subarray(0, SQLITE_HEADER_MAGIC.length).equals(SQLITE_HEADER_MAGIC)) {
    throw fixedError('cache_integrity_failed')
  }
  const encodedPageSize = bytes.readUInt16BE(16)
  const pageSize = encodedPageSize == 1 ? 65536 : encodedPageSize
  if (!isSqlitePageSize(pageSize) || bytes.length < pageSize || bytes.length % pageSize != 0 ||
    ![1, 2].includes(bytes[18]) || ![1, 2].includes(bytes[19])) {
    throw fixedError('cache_integrity_failed')
  }
  return pageSize
}

const materializeExistingDatabase = (
  snapshots: Map<CacheArtifactName, CacheArtifactSnapshot>,
  prepared: Extract<ReturnType<typeof prepareSqliteTarget>, { ok: true }>,
  fileSystem: typeof fs,
): Buffer => {
  const mainSnapshot = snapshots.get('cache.db')
  if (mainSnapshot == null) throw fixedError('cache_target_invalid')
  let image = readBoundedArtifactFromDescriptor(
    prepared.guardDescriptor,
    mainSnapshot,
    MAX_CACHE_PREFLIGHT_BYTES,
    fileSystem,
  )
  const pageSize = validateMainDatabaseImage(image)
  const walSnapshot = snapshots.get('cache.db-wal')

  if (walSnapshot != null && walSnapshot.size > 0) {
    const remainingSourceBytes = MAX_CACHE_PREFLIGHT_BYTES - image.length
    const wal = readBoundedArtifact(walSnapshot, remainingSourceBytes, fileSystem)
    if (wal.length < 32) throw fixedError('cache_integrity_failed')
    const walHeader = validateWalHeader(wal.subarray(0, 32))
    if (walHeader.pageSize != pageSize) throw fixedError('cache_integrity_failed')
    const replay = scanWalFrames(
      wal.length,
      walHeader,
      (position, length) => wal.subarray(position, position + length),
    )
    if (replay.lastCommittedFrameEnd != null && replay.databasePages != null) {
      const finalBytes = replay.databasePages * pageSize
      if (!Number.isSafeInteger(finalBytes) || finalBytes < pageSize || finalBytes > MAX_CACHE_PREFLIGHT_BYTES) {
        throw fixedError('cache_capacity_unavailable')
      }
      if (image.length != finalBytes) {
        const resized = Buffer.alloc(finalBytes)
        image.copy(resized, 0, 0, Math.min(image.length, resized.length))
        image = resized
      }
      const frameSize = 24 + pageSize
      for (let position = 32; position < replay.lastCommittedFrameEnd; position += frameSize) {
        const pageNumber = wal.readUInt32BE(position)
        if (pageNumber <= replay.databasePages) {
          wal.copy(image, (pageNumber - 1) * pageSize, position + 24, position + frameSize)
        }
      }
    }
  }

  if (validateMainDatabaseImage(image) != pageSize) throw fixedError('cache_integrity_failed')
  image[18] = 1
  image[19] = 1
  return image
}

const rejectOrphanSidecars = (
  root: CacheRootOwnership,
  fileSystem: typeof fs,
  pathModule: typeof path,
): void => {
  if (inspectArtifact(root, 'cache.db', fileSystem, pathModule) != null) return
  const sidecars = (['cache.db-wal', 'cache.db-shm'] as const)
    .map(name => inspectArtifact(root, name, fileSystem, pathModule))
    .filter((snapshot): snapshot is CacheArtifactSnapshot => snapshot != null)
  for (const snapshot of sidecars) validateSidecarHeader(snapshot, fileSystem)
  if (sidecars.length > 0) throw fixedError('cache_integrity_failed')
}

const captureArtifacts = (
  root: CacheRootOwnership,
  databasePath: string,
  target: SqliteTargetExpectation,
  fileSystem: typeof fs,
  pathModule: typeof path,
  validateSidecars: boolean,
): Map<CacheArtifactName, CacheArtifactSnapshot> => {
  if (!validateCacheRoot(root, fileSystem)) throw fixedError('cache_target_invalid')
  const guarded = acquireExpectedSqliteTarget(databasePath, target, { fileSystem, pathModule })
  if (guarded == null) throw fixedError('cache_target_invalid')
  closeSqliteGuardDescriptor(fileSystem, guarded.guardDescriptor)

  const snapshots = new Map<CacheArtifactName, CacheArtifactSnapshot>()
  for (const name of cacheArtifactNames) {
    const snapshot = inspectArtifact(root, name, fileSystem, pathModule)
    if (snapshot == null) continue
    if (name == 'cache.db' && !sameSqliteFileIdentity(snapshot.identity, target.identity)) {
      throw fixedError('cache_target_invalid')
    }
    if (validateSidecars) validateSidecarHeader(snapshot, fileSystem)
    snapshots.set(name, snapshot)
  }
  if (!snapshots.has('cache.db')) throw fixedError('cache_target_invalid')
  return snapshots
}

const validateConnectionOwnership = (
  connection: ActiveCacheConnection,
  fileSystem: typeof fs,
  pathModule: typeof path,
): void => {
  validateArtifactOwnership(
    connection.root,
    connection.databasePath,
    connection.target,
    connection.artifacts,
    fileSystem,
    pathModule,
  )
}

const validateArtifactOwnership = (
  root: CacheRootOwnership,
  databasePath: string,
  target: SqliteTargetExpectation,
  expectedArtifacts: Map<CacheArtifactName, CacheArtifactSnapshot>,
  fileSystem: typeof fs,
  pathModule: typeof path,
  requireStableSize = false,
): void => {
  const current = captureArtifacts(
    root,
    databasePath,
    target,
    fileSystem,
    pathModule,
    false,
  )
  if (current.size != expectedArtifacts.size) throw fixedError('cache_target_invalid')
  for (const [name, expected] of expectedArtifacts) {
    const actual = current.get(name)
    if (actual == null || !sameSqliteFileIdentity(actual.identity, expected.identity) ||
      (requireStableSize && actual.size != expected.size)) {
      throw fixedError('cache_target_invalid')
    }
  }
}

const applyPrivateFileModes = (
  root: CacheRootOwnership,
  fileSystem: typeof fs,
  pathModule: typeof path,
): void => {
  for (const name of cacheArtifactNames) {
    const snapshot = inspectArtifact(root, name, fileSystem, pathModule)
    if (snapshot == null) continue
    let descriptor: number | null = null
    try {
      try {
        const noFollow = fileSystem.constants.O_NOFOLLOW ?? 0
        descriptor = fileSystem.openSync(snapshot.path, fileSystem.constants.O_RDONLY | noFollow)
      } catch (error) {
        if (['ENOENT', 'ELOOP'].includes(sourceCode(error))) throw fixedError('cache_target_invalid')
        throw error
      }
      const before = fileSystem.fstatSync(descriptor)
      if (!isExclusiveSqliteFile(before) ||
        !sameSqliteFileIdentity(sqliteFileIdentity(before), snapshot.identity)) {
        throw fixedError('cache_target_invalid')
      }
      try {
        fileSystem.fchmodSync(descriptor, 0o600)
      } catch (error) {
        const unsupportedModeChange = process.platform == 'win32' &&
          ['EPERM', 'ENOSYS', 'EINVAL'].includes(sourceCode(error))
        if (!unsupportedModeChange) throw error
      }
      const after = fileSystem.fstatSync(descriptor)
      if (!isExclusiveSqliteFile(after) ||
        !sameSqliteFileIdentity(sqliteFileIdentity(after), snapshot.identity)) {
        throw fixedError('cache_target_invalid')
      }
    } finally {
      closeSqliteGuardDescriptor(fileSystem, descriptor)
    }
    const published = inspectArtifact(root, name, fileSystem, pathModule)
    if (published == null || !sameSqliteFileIdentity(published.identity, snapshot.identity)) {
      throw fixedError('cache_target_invalid')
    }
  }
}

const closeHandle = (db: Database.Database | null): { closed: boolean, error: unknown | null } => {
  if (db == null || !db.open) return { closed: true, error: null }
  try {
    db.close()
    return db.open
      ? { closed: false, error: fixedError('cache_close_failed') }
      : { closed: true, error: null }
  } catch (error) {
    return { closed: !db.open, error }
  }
}

export const createCacheDatabaseService = (
  options: CacheDatabaseServiceOptions = {},
): CacheDatabaseService => {
  const DatabaseImplementation = options.DatabaseImplementation ?? Database
  const fileSystem = options.fileSystem ?? fs
  const pathModule = options.pathModule ?? path
  const now = options.now ?? Date.now
  const randomUUID = options.randomUUID ?? createRandomUUID
  const readInitialization = options.getInitialization ?? getDatabaseInitialization
  const verifyPrerequisite = options.verifyPhase3Prerequisite ?? getCachePhasePrerequisite
  const invalidateRepositories = options.invalidateRepositories ?? invalidateRegisteredRepositories

  let state: CacheLifecycleState = 'closed'
  let unavailableDiagnostic: CacheDiagnosticCode | null = null
  let connection: ActiveCacheConnection | null = null
  let retainedHandle: Database.Database | null = null
  let activeReset: ActiveReset | null = null
  let queueRunning = false
  const queue: Array<QueueJob<unknown>> = []

  const setUnavailable = (diagnostic: CacheDiagnosticCode): void => {
    state = 'unavailable'
    unavailableDiagnostic = diagnostic
  }

  const unavailableCode = (): CacheDiagnosticCode => unavailableDiagnostic ?? 'cache_open_failed'

  const drainQueue = (): void => {
    if (queueRunning || activeReset != null) return
    const job = queue.shift()
    if (job == null) return
    queueRunning = true
    void Promise.resolve().then(job.operation).then(value => {
      job.resolve(value)
      if (job.holdOnSuccess && activeReset?.status == 'held') return
      queueRunning = false
      drainQueue()
    }, error => {
      job.reject(error)
      queueRunning = false
      drainQueue()
    })
  }

  const enqueue = async <T>(operation: () => T | Promise<T>, holdOnSuccess = false): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const job: QueueJob<T> = { operation, holdOnSuccess, resolve, reject }
      queue.push(job as QueueJob<unknown>)
      drainQueue()
    })

  const candidateFailure = (
    diagnostic: CacheDiagnosticCode,
    existed: boolean,
    snapshots: Map<CacheArtifactName, CacheArtifactSnapshot> | null,
  ): CandidateResult => ({ ok: false, diagnostic, existed, snapshots })

  const verifyExistingCandidateInMemory = (
    snapshots: Map<CacheArtifactName, CacheArtifactSnapshot>,
    prepared: Extract<ReturnType<typeof prepareSqliteTarget>, { ok: true }>,
  ): 1 | 2 => {
    let verificationDb: Database.Database | null = null
    let verificationError: Error | null = null
    let recognizedVersion: 1 | 2 | null = null
    try {
      const image = materializeExistingDatabase(snapshots, prepared, fileSystem)
      verificationDb = new Database(image, {
        ...getNativeOptions(fileSystem, pathModule),
        readonly: true,
      })
      const verification = inspectCacheSchema(verificationDb)
      if (!verification.ok) throw fixedError(verification.diagnostic)
      recognizedVersion = verification.version
    } catch (error) {
      verificationError = fixedError(classifyCacheError(error, 'cache_integrity_failed'))
    }

    const closeAttempt = closeHandle(verificationDb)
    if (!closeAttempt.closed) retainedHandle = verificationDb
    if (closeAttempt.error != null || !closeAttempt.closed) throw fixedError('cache_close_failed')
    if (verificationError != null) throw verificationError
    if (recognizedVersion == null) throw fixedError('cache_schema_invalid')
    return recognizedVersion
  }

  const openCandidate = (
    root: CacheRootOwnership,
    databasePath: string,
  ): CandidateResult => {
    try {
      rejectOrphanSidecars(root, fileSystem, pathModule)
    } catch (error) {
      return candidateFailure(classifyCacheError(error, 'cache_target_invalid'), false, null)
    }
    const prepared = prepareSqliteTarget(root.path, databasePath, { fileSystem, pathModule })
    if (!prepared.ok) {
      const diagnostic = prepared.sourceCode == 'ENOSPC'
        ? 'cache_capacity_unavailable'
        : [
            'open.path_invalid', 'open.target_symlink', 'open.target_not_regular', 'open.target_hard_link',
            'open.target_changed', 'open.reserve_conflict', 'open.reserved_target_invalid',
          ].includes(prepared.diagnostic)
            ? 'cache_target_invalid'
            : 'cache_open_failed'
      return candidateFailure(diagnostic, false, null)
    }

    const target: SqliteTargetExpectation = {
      realRoot: prepared.realRoot,
      identity: prepared.identity,
    }
    let db: Database.Database | null = null
    let snapshots: Map<CacheArtifactName, CacheArtifactSnapshot> | null = null
    let recognizedVersion: 1 | 2 | null = null
    try {
      if (!validateCacheRoot(root, fileSystem) || prepared.realRoot != root.realPath) {
        throw fixedError('cache_target_invalid')
      }
      snapshots = captureArtifacts(root, databasePath, target, fileSystem, pathModule, true)
      if (prepared.existed) {
        recognizedVersion = verifyExistingCandidateInMemory(snapshots, prepared)
        validateArtifactOwnership(root, databasePath, target, snapshots, fileSystem, pathModule, true)
        if (!validatePreparedSqliteTarget(databasePath, prepared, { fileSystem, pathModule }) ||
          !validateCacheRoot(root, fileSystem)) {
          throw fixedError('cache_target_invalid')
        }
      }
      db = new DatabaseImplementation(databasePath, {
        ...getNativeOptions(fileSystem, pathModule),
        fileMustExist: true,
      })
      validateArtifactOwnership(
        root,
        databasePath,
        target,
        snapshots,
        fileSystem,
        pathModule,
        prepared.existed,
      )
      if (!validatePreparedSqliteTarget(databasePath, prepared, { fileSystem, pathModule }) ||
        !validateCacheRoot(root, fileSystem)) {
        throw fixedError('cache_target_invalid')
      }
      closeSqliteGuardDescriptor(fileSystem, prepared.guardDescriptor)
      if (prepared.existed) {
        const verification = recognizedVersion == 1 ? verifyCacheSchemaV1(db) : verifyCacheSchema(db)
        if (!verification.ok) throw fixedError(verification.diagnostic)
      }
      db.pragma('foreign_keys = ON')
      if (db.pragma('foreign_keys', { simple: true }) != 1) throw fixedError('cache_open_failed')
      if (!prepared.existed && String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase() != 'wal') {
        throw fixedError('cache_open_failed')
      }
      if (prepared.existed && recognizedVersion == 1) {
        migrateCacheSchemaV1ToV2(db, now(), candidate => verifyCacheSchema(candidate).ok)
      }
      if (!prepared.existed) bootstrapCacheSchema(db, now())
      if (!prepared.existed || recognizedVersion == 1) {
        const verification = verifyCacheSchema(db)
        if (!verification.ok) throw fixedError(verification.diagnostic)
      }
      if (prepared.existed && String(db.pragma('journal_mode = WAL', { simple: true })).toLowerCase() != 'wal') {
        throw fixedError('cache_open_failed')
      }
      applyPrivateFileModes(root, fileSystem, pathModule)
      snapshots = captureArtifacts(root, databasePath, target, fileSystem, pathModule, true)
      return {
        ok: true,
        existed: prepared.existed,
        connection: { db, databasePath, root, target, artifacts: snapshots },
      }
    } catch (error) {
      let diagnostic = classifyCacheError(error, 'cache_open_failed')
      if (diagnostic == 'cache_open_failed' && sourceCode(error) == 'EACCES') diagnostic = 'cache_open_failed'
      try {
        snapshots ??= captureArtifacts(root, databasePath, target, fileSystem, pathModule, false)
      } catch (ownershipError) {
        diagnostic = classifyCacheError(ownershipError, 'cache_target_invalid')
        snapshots = null
      }
      const closeAttempt = closeHandle(db)
      if (!closeAttempt.closed) retainedHandle = db
      if (closeAttempt.error != null || !closeAttempt.closed) diagnostic = 'cache_close_failed'
      return candidateFailure(diagnostic, prepared.existed, snapshots)
    } finally {
      closeSqliteGuardDescriptor(fileSystem, prepared.guardDescriptor)
    }
  }

  const installConnection = (
    active: ActiveCacheConnection,
    status: CacheOpenResult['status'],
  ): CacheOpenResult => {
    connection = active
    state = 'ready'
    unavailableDiagnostic = null
    return { status, schemaVersion: 2, diagnostic: null }
  }

  const closeRetainedHandle = (): CacheDiagnosticCode | null => {
    if (retainedHandle == null) return null
    const attempt = closeHandle(retainedHandle)
    if (attempt.closed) retainedHandle = null
    return attempt.error != null || !attempt.closed ? 'cache_close_failed' : null
  }

  const openWithinGate = (reopening: boolean): CacheOpenResult => {
    if (!reopening && state == 'ready' && connection != null) {
      try {
        validateConnectionOwnership(connection, fileSystem, pathModule)
        return { status: 'ready', schemaVersion: 2, diagnostic: null }
      } catch (error) {
        const diagnostic = transitionAfterOperationFailure(error)
        return { status: 'unavailable', schemaVersion: null, diagnostic }
      }
    }

    let initialization: ReturnType<typeof readInitialization>
    try {
      initialization = readInitialization()
      verifyPrerequisite()
    } catch (error) {
      const diagnostic = classifyCacheError(error, 'cache_open_failed')
      if (diagnostic == 'cache_phase3_prerequisite_invalid') throw fixedError(diagnostic)
      throw fixedError('cache_open_failed')
    }

    const activeDiagnostic = closeActiveConnection()
    const retainedDiagnostic = closeRetainedHandle()
    const closeDiagnostic = activeDiagnostic ?? retainedDiagnostic
    if (closeDiagnostic != null) {
      setUnavailable(closeDiagnostic)
      return { status: 'unavailable', schemaVersion: null, diagnostic: closeDiagnostic }
    }

    state = 'opening'
    unavailableDiagnostic = null
    let root: CacheRootOwnership
    let databasePath: string
    try {
      root = prepareCacheRoot(initialization.cacheRoot, fileSystem, pathModule)
      databasePath = resolveContainedPath(root.path, 'cache.db', pathModule)
    } catch (error) {
      const diagnostic = classifyCacheError(error, reopening ? 'cache_reopen_failed' : 'cache_open_failed')
      setUnavailable(diagnostic)
      return { status: 'unavailable', schemaVersion: null, diagnostic }
    }

    const first = openCandidate(root, databasePath)
    if (first.ok) {
      return installConnection(first.connection, first.existed ? 'ready' : 'created')
    }
    if (first.snapshots == null ||
      (first.diagnostic != 'cache_integrity_failed' && first.diagnostic != 'cache_schema_invalid')) {
      const diagnostic = reopening && first.diagnostic == 'cache_open_failed'
        ? 'cache_reopen_failed'
        : first.diagnostic
      setUnavailable(diagnostic)
      return { status: 'unavailable', schemaVersion: null, diagnostic }
    }

    try {
      invalidateRepositories()
    } catch {}
    setUnavailable(first.diagnostic)
    return { status: 'unavailable', schemaVersion: null, diagnostic: first.diagnostic }
  }

  const closeActiveConnection = (): CacheDiagnosticCode | null => {
    if (connection == null) return null
    let diagnostic: CacheDiagnosticCode | null = null
    try {
      validateConnectionOwnership(connection, fileSystem, pathModule)
    } catch (error) {
      diagnostic = classifyCacheError(error, 'cache_target_invalid')
    }
    const attempt = closeHandle(connection.db)
    if (attempt.closed) connection = null
    if (attempt.error != null || !attempt.closed) return 'cache_close_failed'
    return diagnostic
  }

  const transitionAfterOperationFailure = (error: unknown): CacheDiagnosticCode => {
    let diagnostic = classifyCacheError(error, 'cache_operation_failed')
    const failedConnection = connection
    try {
      invalidateRepositories()
    } catch {
      if (diagnostic == 'cache_operation_failed') diagnostic = 'cache_operation_failed'
    }
    if (failedConnection != null) {
      try {
        captureArtifacts(
          failedConnection.root,
          failedConnection.databasePath,
          failedConnection.target,
          fileSystem,
          pathModule,
          false,
        )
      } catch (ownershipError) {
        diagnostic = classifyCacheError(ownershipError, 'cache_target_invalid')
      }
      const closeAttempt = closeHandle(failedConnection.db)
      if (closeAttempt.closed) connection = null
      if (closeAttempt.error != null || !closeAttempt.closed) diagnostic = 'cache_close_failed'
    }
    setUnavailable(diagnostic)
    return diagnostic
  }

  const runReadyOperation = <T>(
    operation: (db: CacheDatabaseHandle) => T,
  ): { ok: true, value: T } | { ok: false, diagnostic: CacheDiagnosticCode } => {
    if (state != 'ready' || connection == null) return { ok: false, diagnostic: unavailableCode() }
    try {
      validateConnectionOwnership(connection, fileSystem, pathModule)
      const value = operation(connection.db)
      if (isThenable(value)) throw fixedError('cache_operation_failed')
      validateConnectionOwnership(connection, fileSystem, pathModule)
      return { ok: true, value }
    } catch (error) {
      return { ok: false, diagnostic: transitionAfterOperationFailure(error) }
    }
  }

  const openCacheDatabase = async(): Promise<CacheOpenResult> => enqueue(() => openWithinGate(false))

  const closeCacheDatabase = async(): Promise<void> => enqueue(() => {
    let invalidationFailure = false
    try {
      invalidateRepositories()
    } catch {
      invalidationFailure = true
    }
    const activeCloseDiagnostic = closeActiveConnection()
    const retainedCloseDiagnostic = closeRetainedHandle()
    const closeDiagnostic = activeCloseDiagnostic ?? retainedCloseDiagnostic
    if (closeDiagnostic != null) {
      setUnavailable(closeDiagnostic)
      throw fixedError(closeDiagnostic)
    }
    if (invalidationFailure) {
      setUnavailable('cache_operation_failed')
      throw fixedError('cache_operation_failed')
    }
    state = 'closed'
    unavailableDiagnostic = null
  })

  const beginCacheReset = async(): Promise<CacheResetLease> => enqueue(() => {
    state = 'resetting'
    unavailableDiagnostic = null
    let invalidationFailure = false
    try {
      invalidateRepositories()
    } catch {
      invalidationFailure = true
    }
    const activeCloseDiagnostic = closeActiveConnection()
    const retainedCloseDiagnostic = closeRetainedHandle()
    const closeDiagnostic = activeCloseDiagnostic ?? retainedCloseDiagnostic
    if (closeDiagnostic != null) {
      setUnavailable(closeDiagnostic)
      throw fixedError(closeDiagnostic)
    }
    if (invalidationFailure) {
      setUnavailable('cache_operation_failed')
      throw fixedError('cache_operation_failed')
    }
    const resetId = randomUUID()
    activeReset = { resetId, status: 'held' }
    return Object.freeze({ resetId })
  }, true)

  const finishCacheReset = async(input: CacheResetLease): Promise<CacheOpenResult> => {
    if (!isPlainLease(input) || activeReset?.status != 'held' || activeReset.resetId != input.resetId) {
      return Promise.reject(fixedError('cache_operation_failed'))
    }
    activeReset.status = 'finishing'
    return Promise.resolve().then(() => openWithinGate(true)).catch(error => {
      const diagnostic = classifyCacheError(error, 'cache_reopen_failed')
      setUnavailable(diagnostic)
      throw fixedError(diagnostic)
    }).finally(() => {
      activeReset = null
      queueRunning = false
      drainQueue()
    })
  }

  const abortCacheReset = async(input: CacheResetLease): Promise<void> => {
    if (!isPlainLease(input) || activeReset?.status != 'held' || activeReset.resetId != input.resetId) {
      throw fixedError('cache_operation_failed')
    }
    activeReset.status = 'finishing'
    setUnavailable('cache_delete_failed')
    activeReset = null
    queueRunning = false
    drainQueue()
  }

  const getCacheLifecycleState = async(): Promise<CacheLifecycleState> => Promise.resolve(state)

  const runCacheRead = async <T>(
    operation: (db: CacheDatabaseHandle) => T | null | undefined,
  ): Promise<CacheReadResult<T>> => enqueue(() => {
    const result = runReadyOperation(operation)
    if (!result.ok) return { status: 'unavailable', code: result.diagnostic }
    return result.value == null
      ? { status: 'miss' }
      : { status: 'hit', value: result.value }
  })

  const runCacheWrite = async(
    operation: (db: CacheDatabaseHandle) => void,
  ): Promise<CacheWriteResult> => enqueue(() => {
    const result = runReadyOperation(operation)
    return result.ok
      ? { status: 'stored' }
      : { status: 'unavailable', code: result.diagnostic }
  })

  const runCacheImmediate = async <T>(
    operation: (db: CacheDatabaseHandle) => T,
  ): Promise<CacheExecutionResult<T>> => enqueue(() => {
    const result = runReadyOperation(db => db.transaction(() => {
      const value = operation(db)
      if (isThenable(value)) throw fixedError('cache_operation_failed')
      return value
    }).immediate())
    return result.ok
      ? { status: 'completed', value: result.value }
      : { status: 'unavailable', code: result.diagnostic }
  })

  const runCacheRollbackOnly = async <T>(
    operation: (db: CacheDatabaseHandle) => T,
  ): Promise<CacheExecutionResult<T>> => enqueue(() => {
    const result = runReadyOperation(db => {
      let transactionOpen = false
      try {
        db.exec('BEGIN IMMEDIATE')
        transactionOpen = true
        const value = operation(db)
        if (isThenable(value)) throw fixedError('cache_operation_failed')
        db.exec('ROLLBACK')
        transactionOpen = false
        return value
      } catch (error) {
        if (transactionOpen) {
          db.exec('ROLLBACK')
        }
        throw error
      }
    })
    return result.ok
      ? { status: 'completed', value: result.value }
      : { status: 'unavailable', code: result.diagnostic }
  })

  return {
    openCacheDatabase,
    closeCacheDatabase,
    beginCacheReset,
    finishCacheReset,
    abortCacheReset,
    getCacheLifecycleState,
    runCacheRead,
    runCacheWrite,
    runCacheImmediate,
    runCacheRollbackOnly,
  }
}

const cacheDatabaseService = createCacheDatabaseService()

export const openCacheDatabase = cacheDatabaseService.openCacheDatabase
export const closeCacheDatabase = cacheDatabaseService.closeCacheDatabase
export const beginCacheReset = cacheDatabaseService.beginCacheReset
export const finishCacheReset = cacheDatabaseService.finishCacheReset
export const abortCacheReset = cacheDatabaseService.abortCacheReset
export const getCacheLifecycleState = cacheDatabaseService.getCacheLifecycleState
export const runCacheRead = cacheDatabaseService.runCacheRead
export const runCacheWrite = cacheDatabaseService.runCacheWrite
export const runCacheImmediate = cacheDatabaseService.runCacheImmediate
// Worker-private: this callback gate is deliberately not re-exported through modules/index.ts.
export const runCacheRollbackOnly = cacheDatabaseService.runCacheRollbackOnly
