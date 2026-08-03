import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  closeArtifactGuard,
  closeArtifactReservation,
  completeExclusiveArtifact,
  reserveExclusiveArtifact,
  revalidateImmutableArtifact,
  type ExclusiveArtifactReservation,
  type ImmutableArtifactGuard,
} from '../../storage/exclusiveArtifact'
import {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
  type DirectDirectoryGuard,
  type NodeIdentity,
} from '../../storage/directDirectory'

export type OnlineBackupVerifier = (db: Database.Database) => void

export interface OnlineBackupReservation extends ExclusiveArtifactReservation {
  artifactKind: 'database-backup-v1'
  sourceSchemaVersion: number
}

export interface VerifiedOnlineBackupGuard {
  path: string
  basename: string
  sha256: string
  byteLength: number
  sourceSchemaVersion: number
  revalidate: () => void
  close: () => void
}

interface OnlineReservationMetadata {
  artifact: ExclusiveArtifactReservation
  root: DirectDirectoryGuard
  sourceSchemaVersion: number
  closed: boolean
  complete: boolean
}

interface RecordedGuardMetadata {
  root: DirectDirectoryGuard
  descriptor: number
  identity: NodeIdentity
  expectedSha256: string
  expectedByteLength: number
  closed: boolean
}

interface LegacyGuardMetadata {
  root: DirectDirectoryGuard
  descriptor: number
  identity: NodeIdentity
  linkCount: 1n | 2n
}

const onlineReservations = new WeakMap<OnlineBackupReservation, OnlineReservationMetadata>()
const recordedGuards = new WeakMap<VerifiedOnlineBackupGuard, RecordedGuardMetadata>()
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const MAXIMUM_CHUNK_BYTES = 1024 * 1024
const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0
const SQLITE_SIDECAR_SUFFIXES = ['-wal', '-shm', '-journal'] as const

const failure = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })

const asError = (error: unknown, fallbackCode: string): Error => error instanceof Error
  ? error
  : failure(fallbackCode)

const isMissing = (error: unknown): boolean => error != null && typeof error == 'object' &&
  'code' in error && error.code == 'ENOENT'

const sameIdentity = (left: NodeIdentity, right: NodeIdentity): boolean =>
  left.dev == right.dev && left.ino == right.ino

const identityOf = (stat: fs.BigIntStats): NodeIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) })

const directBasename = (basename: string): boolean => basename.length > 0 && basename != '.' && basename != '..' &&
  path.basename(basename) == basename

const safeSchemaVersion = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value > 0

interface CleanupAwareError extends Error {
  cleanupErrors?: readonly Error[]
}

const withCleanupContext = (primary: Error, cleanupErrors: readonly Error[]): Error => {
  if (cleanupErrors.length == 0) return primary
  const contextual = primary as CleanupAwareError
  try {
    Object.defineProperty(contextual, 'cleanupErrors', {
      configurable: true,
      enumerable: false,
      value: Object.freeze([...(contextual.cleanupErrors ?? []), ...cleanupErrors]),
    })
  } catch {}
  return contextual
}

const closeCapturedDirectGuard = (guard: DirectDirectoryGuard): Error[] => {
  const cleanupErrors: Error[] = []
  try {
    closeDirectDirectory(guard)
    return cleanupErrors
  } catch (error) {
    cleanupErrors.push(asError(error, 'backup_root_close_failed'))
  }

  try {
    // Metadata-backed revalidation distinguishes a pre-close throw from an
    // ambiguous post-close numeric descriptor that may already be reused.
    revalidateDirectDirectory(guard)
  } catch (error) {
    cleanupErrors.push(asError(error, 'backup_root_close_ownership_unknown'))
    return cleanupErrors
  }
  try {
    fs.closeSync(guard.descriptor)
  } catch (error) {
    if (error != null && typeof error == 'object' && 'code' in error && error.code == 'EBADF') {
      return cleanupErrors
    }
    cleanupErrors.push(asError(error, 'backup_root_descriptor_close_failed'))
  }
  return cleanupErrors
}

const closeRoot = (metadata: { root: DirectDirectoryGuard, closed: boolean }): void => {
  if (metadata.closed) return
  metadata.closed = true
  closeDirectDirectory(metadata.root)
}

const openBackupRoot = (backupsRoot: string): DirectDirectoryGuard => {
  const resolved = path.resolve(backupsRoot)
  try {
    fs.lstatSync(resolved)
    return validateDirectDirectory(resolved)
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const ownerPath = path.dirname(resolved)
  const basename = path.basename(resolved)
  if (!directBasename(basename) || ownerPath == resolved) throw failure('backup_root_invalid')
  const owner = validateDirectDirectory(ownerPath)
  let root: DirectDirectoryGuard | null = null
  const closeOpenedRoot = (): Error[] => {
    if (root == null) return []
    const opened = root
    root = null
    return closeCapturedDirectGuard(opened)
  }
  let operationError: Error | null = null
  const cleanupErrors: Error[] = []
  try {
    revalidateDirectDirectory(owner)
    fs.mkdirSync(resolved, { mode: 0o700 })
    revalidateDirectDirectory(owner)
    root = validateDirectDirectory(resolved)
    revalidateDirectDirectory(owner)
    revalidateDirectDirectory(root)
  } catch (error) {
    operationError = asError(error, 'backup_root_invalid')
  }
  const ownerCloseErrors = closeCapturedDirectGuard(owner)
  if (operationError == null && ownerCloseErrors.length > 0) {
    operationError = ownerCloseErrors[0]
    cleanupErrors.push(...ownerCloseErrors.slice(1))
  } else {
    cleanupErrors.push(...ownerCloseErrors)
  }
  if (operationError != null) {
    cleanupErrors.push(...closeOpenedRoot())
    throw withCleanupContext(operationError, cleanupErrors)
  }
  return root!
}

const validateReservationInput = (input: {
  backupsRoot: string
  basenamePrefix: string
  sourceSchemaVersion: number
}): void => {
  if (input == null || typeof input != 'object' || Array.isArray(input) ||
    typeof input.backupsRoot != 'string' || typeof input.basenamePrefix != 'string' ||
    !directBasename(input.basenamePrefix) || !safeSchemaVersion(input.sourceSchemaVersion)) {
    throw failure('backup_reservation_invalid')
  }
}

const reservationMetadata = (reservation: OnlineBackupReservation): OnlineReservationMetadata => {
  const metadata = onlineReservations.get(reservation)
  if (metadata == null || metadata.closed || metadata.complete ||
    reservation.artifactKind != 'database-backup-v1' ||
    !safeSchemaVersion(reservation.sourceSchemaVersion) ||
    reservation.sourceSchemaVersion != metadata.sourceSchemaVersion) {
    throw failure('backup_reservation_invalid')
  }
  return metadata
}

const validateOpenReservation = (
  reservation: OnlineBackupReservation,
  metadata: OnlineReservationMetadata,
): void => {
  revalidateDirectDirectory(metadata.root)
  const descriptorStat = fs.fstatSync(metadata.artifact.descriptor, { bigint: true })
  const pathStat = fs.lstatSync(metadata.artifact.path, { bigint: true })
  if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
    descriptorStat.nlink != 1n || pathStat.nlink != 1n ||
    !sameIdentity(identityOf(descriptorStat), reservation.identity) ||
    !sameIdentity(identityOf(pathStat), reservation.identity)) {
    throw failure('backup_evidence_changed')
  }
}

const assertNoSidecars = (filePath: string): void => {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    try {
      fs.lstatSync(`${filePath}${suffix}`)
    } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    throw failure('backup_sidecar_invalid')
  }
}

const readSourceSchemaVersion = (db: Database.Database): number => {
  const rows = db.prepare<[]>("SELECT field_value FROM db_info WHERE field_name = 'version'").all() as Array<{
    field_value: unknown
  }>
  if (rows.length != 1 || typeof rows[0].field_value != 'string' || !/^\d+$/.test(rows[0].field_value)) {
    throw failure('backup_schema_invalid')
  }
  const version = Number(rows[0].field_value)
  if (!safeSchemaVersion(version)) throw failure('backup_schema_invalid')
  return version
}

const standaloneSqliteBytes = (bytes: Buffer): Buffer => {
  if (bytes.length < 100 || bytes.subarray(0, 16).toString('binary') != 'SQLite format 3\0') {
    throw failure('backup_snapshot_invalid')
  }
  const readVersion = bytes[18]
  const writeVersion = bytes[19]
  if (readVersion != writeVersion || (readVersion != 1 && readVersion != 2)) {
    throw failure('backup_snapshot_invalid')
  }
  const artifactBytes = Buffer.from(bytes)
  if (readVersion == 2) {
    // The normalized copy becomes the artifact, so verification never derives different bytes.
    artifactBytes[18] = 1
    artifactBytes[19] = 1
  }
  return artifactBytes
}

const assertStandaloneDescriptor = (descriptor: number): void => {
  const header = Buffer.alloc(20)
  if (fs.readSync(descriptor, header, 0, header.length, 0) != header.length ||
    header.subarray(0, 16).toString('binary') != 'SQLite format 3\0' ||
    header[18] != 1 || header[19] != 1) {
    throw failure('backup_snapshot_invalid')
  }
}

const verifySqlite = (
  filePath: string,
  expectedSourceSchemaVersion: number | null,
  nativeOptions: { nativeBinding?: string },
  verifier: OnlineBackupVerifier,
  revalidate: () => void,
): void => {
  if (typeof verifier != 'function') throw failure('backup_verifier_invalid')
  assertNoSidecars(filePath)
  revalidate()
  let verificationDb: Database.Database | null = null
  let operationError: Error | null = null
  try {
    verificationDb = new Database(path.toNamespacedPath(filePath), {
      ...nativeOptions,
      readonly: true,
      fileMustExist: true,
    })
    revalidate()
    if (verificationDb.pragma('quick_check', { simple: true }) != 'ok') {
      throw failure('backup_quick_check_failed')
    }
    if ((verificationDb.pragma('foreign_key_check') as unknown[]).length != 0) {
      throw failure('backup_foreign_key_check_failed')
    }
    if (expectedSourceSchemaVersion != null && readSourceSchemaVersion(verificationDb) != expectedSourceSchemaVersion) {
      throw failure('backup_schema_invalid')
    }
    verifier(verificationDb)
    revalidate()
  } catch (error) {
    operationError = asError(error, 'backup_verification_failed')
  } finally {
    try { verificationDb?.close() } catch (error) {
      operationError ??= asError(error, 'backup_verification_close_failed')
    }
  }
  if (operationError != null) throw operationError
  assertNoSidecars(filePath)
  revalidate()
}

const hashDescriptor = (descriptor: number, expectedByteLength: number): string => {
  const hash = crypto.createHash('sha256')
  const chunk = Buffer.allocUnsafe(MAXIMUM_CHUNK_BYTES)
  let offset = 0
  while (offset < expectedByteLength) {
    const count = fs.readSync(
      descriptor,
      chunk,
      0,
      Math.min(chunk.length, expectedByteLength - offset),
      offset,
    )
    if (!Number.isSafeInteger(count) || count <= 0) throw failure('backup_evidence_invalid')
    hash.update(chunk.subarray(0, count))
    offset += count
  }
  if (fs.readSync(descriptor, chunk, 0, 1, offset) != 0) throw failure('backup_evidence_invalid')
  return hash.digest('hex')
}

const revalidateCompletedArtifact = (guard: ImmutableArtifactGuard): void => {
  revalidateImmutableArtifact(guard)
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(guard.path, fs.constants.O_RDONLY | NO_FOLLOW)
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (!stat.isFile() || stat.nlink != 1n || !sameIdentity(identityOf(stat), guard.identity) ||
      stat.size != BigInt(guard.byteLength) || hashDescriptor(descriptor, guard.byteLength) != guard.sha256) {
      throw failure('backup_evidence_changed')
    }
  } finally {
    if (descriptor != null) fs.closeSync(descriptor)
  }
  revalidateImmutableArtifact(guard)
}

const validateRecordedIdentity = (filePath: string, metadata: RecordedGuardMetadata): void => {
  if (metadata.closed) throw failure('backup_guard_closed')
  revalidateDirectDirectory(metadata.root)
  let descriptorStat: fs.BigIntStats
  let pathStat: fs.BigIntStats
  try {
    descriptorStat = fs.fstatSync(metadata.descriptor, { bigint: true })
    pathStat = fs.lstatSync(filePath, { bigint: true })
  } catch {
    throw failure('backup_evidence_changed')
  }
  if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
    descriptorStat.nlink != 1n || pathStat.nlink != 1n ||
    !sameIdentity(identityOf(descriptorStat), metadata.identity) ||
    !sameIdentity(identityOf(pathStat), metadata.identity) ||
    descriptorStat.size != BigInt(metadata.expectedByteLength) ||
    (process.platform != 'win32' && (pathStat.mode & 0o077n) != 0n)) {
    throw failure('backup_evidence_changed')
  }
  if (hashDescriptor(metadata.descriptor, metadata.expectedByteLength) != metadata.expectedSha256) {
    throw failure('backup_evidence_changed')
  }
}

const validateLegacyIdentity = (filePath: string, metadata: LegacyGuardMetadata): void => {
  try {
    revalidateDirectDirectory(metadata.root)
    const descriptorStat = fs.fstatSync(metadata.descriptor, { bigint: true })
    const pathStat = fs.lstatSync(filePath, { bigint: true })
    if (!descriptorStat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink() ||
      descriptorStat.nlink != metadata.linkCount || pathStat.nlink != metadata.linkCount ||
      !sameIdentity(identityOf(descriptorStat), metadata.identity) ||
      !sameIdentity(identityOf(pathStat), metadata.identity) ||
      (process.platform != 'win32' && (pathStat.mode & 0o077n) != 0n)) {
      throw failure('backup_evidence_changed')
    }
    revalidateDirectDirectory(metadata.root)
  } catch (error) {
    if (error instanceof Error && error.message == 'backup_evidence_changed') throw error
    throw failure('backup_evidence_changed')
  }
}

const closeRecordedGuard = (guard: VerifiedOnlineBackupGuard): void => {
  const metadata = recordedGuards.get(guard)
  if (metadata == null || metadata.closed) throw failure('backup_guard_closed')
  let closeError: Error | null = null
  try {
    fs.closeSync(metadata.descriptor)
  } catch (error) {
    closeError = asError(error, 'backup_descriptor_close_failed')
  }
  try {
    closeRoot(metadata)
  } catch (error) {
    closeError ??= asError(error, 'backup_root_close_failed')
  }
  if (closeError != null) throw closeError
}

export function reserveOnlineBackup(input: {
  backupsRoot: string
  basenamePrefix: string
  sourceSchemaVersion: number
}): OnlineBackupReservation {
  validateReservationInput(input)
  const root = openBackupRoot(input.backupsRoot)
  try {
    revalidateDirectDirectory(root)
    const artifact = reserveExclusiveArtifact(root, {
      prefix: `${input.basenamePrefix}.`,
      suffix: '.backup',
      artifactKind: 'database-backup-v1',
    })
    const reservation: OnlineBackupReservation = Object.freeze({
      ...artifact,
      artifactKind: 'database-backup-v1' as const,
      sourceSchemaVersion: input.sourceSchemaVersion,
    })
    onlineReservations.set(reservation, {
      artifact,
      root,
      sourceSchemaVersion: input.sourceSchemaVersion,
      closed: false,
      complete: false,
    })
    return reservation
  } catch (error) {
    closeDirectDirectory(root)
    throw error
  }
}

export function closeOnlineBackupReservation(reservation: OnlineBackupReservation): void {
  const metadata = onlineReservations.get(reservation)
  if (metadata == null || metadata.complete) throw failure('backup_reservation_invalid')
  let closeError: Error | null = null
  try {
    closeArtifactReservation(metadata.artifact)
  } catch (error) {
    closeError = asError(error, 'backup_descriptor_close_failed')
  }
  try {
    closeRoot(metadata)
  } catch (error) {
    closeError ??= asError(error, 'backup_root_close_failed')
  }
  if (closeError != null) throw closeError
}

export function completeOnlineBackup(
  db: Database.Database,
  reservation: OnlineBackupReservation,
  nativeOptions: { nativeBinding?: string },
  verifier: OnlineBackupVerifier,
): VerifiedOnlineBackupGuard {
  const metadata = reservationMetadata(reservation)
  let immutable: ImmutableArtifactGuard | null = null
  try {
    const snapshot = db.serialize()
    if (!Buffer.isBuffer(snapshot)) throw failure('backup_snapshot_invalid')
    const artifactBytes = standaloneSqliteBytes(snapshot)
    immutable = completeExclusiveArtifact(metadata.artifact, {
      byteLength: artifactBytes.length,
      read: (offset, maximumBytes) => artifactBytes.subarray(offset, offset + maximumBytes),
    }, {
      verifyReadOnly: ({ path: filePath }) => {
        verifySqlite(
          filePath,
          reservation.sourceSchemaVersion,
          nativeOptions,
          verifier,
          () => { validateOpenReservation(reservation, metadata) },
        )
      },
    })
    revalidateCompletedArtifact(immutable)
    metadata.complete = true
    let closed = false
    const guard: VerifiedOnlineBackupGuard = Object.freeze({
      path: immutable.path,
      basename: immutable.basename,
      sha256: immutable.sha256,
      byteLength: immutable.byteLength,
      sourceSchemaVersion: reservation.sourceSchemaVersion,
      revalidate: () => {
        if (closed) throw failure('backup_guard_closed')
        revalidateCompletedArtifact(immutable!)
      },
      close: () => {
        if (closed) throw failure('backup_guard_closed')
        closed = true
        let closeError: Error | null = null
        try {
          closeArtifactGuard(immutable!)
        } catch (error) {
          closeError = asError(error, 'backup_descriptor_close_failed')
        }
        try {
          closeRoot(metadata)
        } catch (error) {
          closeError ??= asError(error, 'backup_root_close_failed')
        }
        if (closeError != null) throw closeError
      },
    })
    return guard
  } catch (error) {
    try {
      closeOnlineBackupReservation(reservation)
    } catch {}
    throw error
  }
}

export function verifyLegacyOnlineBackup(
  filePath: string,
  nativeOptions: { nativeBinding?: string },
  verifier: OnlineBackupVerifier,
): void {
  const resolved = path.resolve(filePath)
  const basename = path.basename(resolved)
  if (!directBasename(basename)) throw failure('backup_legacy_invalid')
  const root = validateDirectDirectory(path.dirname(resolved))
  let descriptor: number | null = null
  try {
    descriptor = fs.openSync(path.join(root.path, basename), fs.constants.O_RDONLY | NO_FOLLOW)
    const stat = fs.fstatSync(descriptor, { bigint: true })
    if (stat.nlink != 1n && stat.nlink != 2n) throw failure('backup_evidence_changed')
    const metadata: LegacyGuardMetadata = {
      root,
      descriptor,
      identity: identityOf(stat),
      linkCount: stat.nlink,
    }
    validateLegacyIdentity(resolved, metadata)
    if (stat.size <= 0n || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw failure('backup_evidence_changed')
    }
    assertStandaloneDescriptor(descriptor)
    verifySqlite(
      resolved,
      null,
      nativeOptions,
      verifier,
      () => { validateLegacyIdentity(resolved, metadata) },
    )
  } finally {
    if (descriptor != null) {
      try { fs.closeSync(descriptor) } catch {}
    }
    closeDirectDirectory(root)
  }
}

export function verifyRecordedOnlineBackup(input: {
  backupsRoot: string
  basename: string
  expectedSha256: string
  expectedByteLength: number
  expectedSourceSchemaVersion: number
  nativeOptions: { nativeBinding?: string }
  verifier: OnlineBackupVerifier
}): VerifiedOnlineBackupGuard {
  if (input == null || typeof input != 'object' || typeof input.backupsRoot != 'string' ||
    typeof input.basename != 'string' || !directBasename(input.basename) ||
    typeof input.expectedSha256 != 'string' || !SHA256_PATTERN.test(input.expectedSha256) ||
    !Number.isSafeInteger(input.expectedByteLength) || input.expectedByteLength <= 0 ||
    !safeSchemaVersion(input.expectedSourceSchemaVersion) || typeof input.verifier != 'function') {
    throw failure('backup_record_invalid')
  }
  const root = validateDirectDirectory(path.resolve(input.backupsRoot))
  const filePath = path.join(root.path, input.basename)
  let descriptor: number | null = null
  try {
    revalidateDirectDirectory(root)
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | NO_FOLLOW)
    const metadata: RecordedGuardMetadata = {
      root,
      descriptor,
      identity: identityOf(fs.fstatSync(descriptor, { bigint: true })),
      expectedSha256: input.expectedSha256,
      expectedByteLength: input.expectedByteLength,
      closed: false,
    }
    validateRecordedIdentity(filePath, metadata)
    assertStandaloneDescriptor(descriptor)
    verifySqlite(
      filePath,
      input.expectedSourceSchemaVersion,
      input.nativeOptions,
      input.verifier,
      () => { validateRecordedIdentity(filePath, metadata) },
    )
    const guard: VerifiedOnlineBackupGuard = Object.freeze({
      path: filePath,
      basename: input.basename,
      sha256: input.expectedSha256,
      byteLength: input.expectedByteLength,
      sourceSchemaVersion: input.expectedSourceSchemaVersion,
      revalidate: () => { validateRecordedIdentity(filePath, metadata) },
      close: () => { closeRecordedGuard(guard) },
    })
    recordedGuards.set(guard, metadata)
    return guard
  } catch (error) {
    if (descriptor != null) {
      try { fs.closeSync(descriptor) } catch {}
    }
    try { closeDirectDirectory(root) } catch {}
    throw error
  }
}
