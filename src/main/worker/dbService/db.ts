import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import {
  closeOnlineBackupReservation,
  completeOnlineBackup,
  reopenPreparedOnlineBackup,
  reserveOnlineBackup,
  verifyLegacyOnlineBackup,
  type OnlineBackupVerifier,
  type VerifiedOnlineBackupGuard,
} from './databaseBackup'
import { bootstrapDatabaseSchema, getPendingMigrations, getSchemaVersion, runMigrations } from './migrate'
import { migrations } from './migrations'
import type { MigrationRunResult } from './migrations/types'
import { verifyDatabase } from './verifyDB'
import type * as CacheCutover from '../../migration/cache/cutover'
import type * as CacheCleanupMigration from './migrations/0007_cache_cleanup'
import type * as RawLyricRepository from './modules/lyric/raw/repository'
import {
  acquireExpectedSqliteTarget,
  closeSqliteGuardDescriptor,
  prepareSqliteTarget,
  resolveContainedPath,
  validatePreparedSqliteTarget,
  type SqliteTargetExpectation,
} from './sqliteTarget'

export type DatabaseRecoveryReason =
  | 'open_failed'
  | 'backup_failed'
  | 'migration_failed'
  | 'schema_invalid'
  | 'quick_check_failed'
  | 'foreign_key_check_failed'

export interface DatabaseReadyStartupResult {
  status: 'ready'
  existed: boolean
  schemaVersion: number
  migratedVersions: number[]
  backupPath: string | null
  preparedCutoverPending: boolean
}

export type DatabaseStartupResult =
  | DatabaseReadyStartupResult
  | {
    status: 'recovery'
    reason: DatabaseRecoveryReason
    databasePath: string
    backupPath: string | null
    diagnostics: string[]
  }

export type DatabaseHealth =
  | { status: 'closed' }
  | { status: 'ready', readOnly: false, schemaVersion: number }
  | {
    status: 'recovery'
    readOnly: boolean
    reason: DatabaseRecoveryReason
    diagnostics: string[]
  }

export interface DatabaseInitOptions {
  dataPath: string
  cacheRoot: string
  backupsRoot: string
  previousShutdownWasClean: boolean
  targetSchemaVersion: 6
}

export interface DatabaseAdvanceOptions {
  targetSchemaVersion: 7
  backupsRoot: string
}

type DatabaseReadyResult = Extract<DatabaseStartupResult, { status: 'ready' }>

interface ReadyInitialization {
  dataPath: string
  cacheRoot: string
  backupsRoot: string
  schemaVersion: 6 | 7
  existedBeforeOpen: boolean
}

let writeDb: Database.Database | null = null
let recoveryDb: Database.Database | null = null
let initializingDb: Database.Database | null = null
let health: DatabaseHealth = { status: 'closed' }
let initializationKey: string | null = null
let initializationPromise: Promise<DatabaseStartupResult> | null = null
let cachedStartupResult: DatabaseStartupResult | null = null
let lifecycleGeneration = 0
let readyInitialization: Readonly<ReadyInitialization> | null = null
let advanceKey: string | null = null
let advancePromise: Promise<Readonly<DatabaseReadyResult>> | null = null

const pathExists = (filePath: string): boolean => {
  try {
    fs.statSync(filePath)
    return true
  } catch (error) {
    if (error != null && typeof error == 'object' && 'code' in error && error.code == 'ENOENT') return false
    throw error
  }
}

const getNativeOptions = (): { nativeBinding?: string } => {
  const nativeBinding = path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  return pathExists(nativeBinding) ? { nativeBinding } : {}
}

interface CloseAttempt {
  closed: boolean
  error: unknown | null
}

const closeConnection = (db: Database.Database | null): CloseAttempt => {
  if (!db?.open) return { closed: true, error: null }
  try {
    db.close()
    return db.open
      ? { closed: false, error: new Error('database_close_failed') }
      : { closed: true, error: null }
  } catch (error) {
    return { closed: !db.open, error }
  }
}

export const close = (): void => {
  lifecycleGeneration++
  let failure: unknown | null = null
  const connections = [initializingDb, writeDb, recoveryDb].filter(
    (db): db is Database.Database => db != null,
  )
  for (let index = 0; index < connections.length; index++) {
    const db = connections[index]
    if (connections.indexOf(db) != index) continue
    const attempt = closeConnection(db)
    if (attempt.closed) {
      if (initializingDb == db) initializingDb = null
      if (writeDb == db) writeDb = null
      if (recoveryDb == db) recoveryDb = null
    }
    if (attempt.error != null) failure ??= attempt.error
  }

  if (initializingDb == null && writeDb == null && recoveryDb == null) {
    initializationKey = null
    initializationPromise = null
    cachedStartupResult = null
    readyInitialization = null
    advanceKey = null
    advancePromise = null
    health = { status: 'closed' }
  }
  if (failure instanceof Error) throw failure
  if (failure != null) throw new Error('database_close_failed')
}

const reopenReadOnly = (
  databasePath: string,
  nativeOptions: { nativeBinding?: string },
  expectedTarget: SqliteTargetExpectation,
): { db: Database.Database | null, diagnostic: string | null } => {
  const guardedTarget = acquireExpectedSqliteTarget(databasePath, expectedTarget, {
    fileSystem: fs,
    pathModule: path,
  })
  if (guardedTarget == null) return { db: null, diagnostic: 'readonly_reopen.failed' }
  let db: Database.Database | null = null
  try {
    db = new Database(databasePath, { ...nativeOptions, readonly: true, fileMustExist: true })
    if (!validatePreparedSqliteTarget(databasePath, guardedTarget, { fileSystem: fs, pathModule: path })) {
      throw new Error('readonly_target_changed')
    }
    db.pragma('foreign_keys = ON')
    if (db.pragma('foreign_keys', { simple: true }) != 1) throw new Error('foreign_keys_not_enabled')
    db.pragma('schema_version', { simple: true })
    return { db, diagnostic: null }
  } catch {
    closeConnection(db)
    return { db: null, diagnostic: 'readonly_reopen.failed' }
  } finally {
    closeSqliteGuardDescriptor(fs, guardedTarget.guardDescriptor)
  }
}

const enterRecovery = (
  reason: DatabaseRecoveryReason,
  databasePath: string,
  backupPath: string | null,
  diagnostics: string[],
  localWriteDb: Database.Database | null,
  nativeOptions: { nativeBinding?: string },
  recoveryTarget: SqliteTargetExpectation | null,
): DatabaseStartupResult => {
  readyInitialization = null
  const writeClose = closeConnection(localWriteDb)
  if (writeClose.closed && initializingDb == localWriteDb) initializingDb = null
  writeDb = null
  if (!writeClose.closed) {
    recoveryDb = null
    const sanitizedDiagnostics = [...diagnostics, 'write_close.failed']
    health = {
      status: 'recovery',
      readOnly: false,
      reason,
      diagnostics: [...sanitizedDiagnostics],
    }
    return {
      status: 'recovery',
      reason,
      databasePath,
      backupPath,
      diagnostics: sanitizedDiagnostics,
    }
  }

  const reopened = recoveryTarget != null
    ? reopenReadOnly(databasePath, nativeOptions, recoveryTarget)
    : { db: null, diagnostic: null }
  recoveryDb = reopened.db
  const sanitizedDiagnostics = reopened.diagnostic == null
    ? [...diagnostics]
    : [...diagnostics, reopened.diagnostic]
  health = {
    status: 'recovery',
    readOnly: recoveryDb != null,
    reason,
    diagnostics: [...sanitizedDiagnostics],
  }
  return {
    status: 'recovery',
    reason,
    databasePath,
    backupPath,
    diagnostics: sanitizedDiagnostics,
  }
}

const createDatabaseError = (code: string): Error & { code: string } => {
  const error = new Error(code) as Error & { code: string }
  error.code = code
  return error
}

const cloneStartupResult = (result: DatabaseStartupResult): DatabaseStartupResult => result.status == 'ready'
  ? { ...result, migratedVersions: [...result.migratedVersions] }
  : { ...result, diagnostics: [...result.diagnostics] }

const freezeStartupResult = (result: DatabaseStartupResult): DatabaseStartupResult => {
  const cloned = cloneStartupResult(result)
  if (cloned.status == 'ready') Object.freeze(cloned.migratedVersions)
  else Object.freeze(cloned.diagnostics)
  return Object.freeze(cloned)
}

const freezeReadyResult = (result: DatabaseReadyResult): Readonly<DatabaseReadyResult> =>
  freezeStartupResult(result) as Readonly<DatabaseReadyResult>

const enterRawLyricSchema7CacheOnly = (): void => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the raw-lyric schema transition cycle boundary.
  const repository = require('./modules/lyric/raw/repository') as typeof RawLyricRepository
  repository.enterRawLyricSchema7CacheOnly()
}

const enterRawLyricCutoverPending = (): void => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the raw-lyric schema transition cycle boundary.
  const repository = require('./modules/lyric/raw/repository') as typeof RawLyricRepository
  repository.enterRawLyricCutoverPending()
}

const restoreRawLyricSchema6Fallback = (): void => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the raw-lyric schema transition cycle boundary.
  const repository = require('./modules/lyric/raw/repository') as typeof RawLyricRepository
  repository.restoreRawLyricSchema6Fallback()
}

const verifySchema7SteadyState = (db: Database.Database): void => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache cutover loading boundary.
  const cutover = require('../../migration/cache/cutover') as typeof CacheCutover
  cutover.verifySchema7SteadyState(db)
}

const validInitializationOptions = (options: unknown): options is DatabaseInitOptions => {
  if (options == null || typeof options != 'object' || Array.isArray(options) ||
    Object.getPrototypeOf(options) != Object.prototype) return false
  const keys = Reflect.ownKeys(options)
  if (keys.length != 5 || !keys.every(key => typeof key == 'string' && [
    'dataPath',
    'cacheRoot',
    'backupsRoot',
    'previousShutdownWasClean',
    'targetSchemaVersion',
  ].includes(key))) return false
  return typeof (options as DatabaseInitOptions).dataPath == 'string' &&
    typeof (options as DatabaseInitOptions).cacheRoot == 'string' &&
    typeof (options as DatabaseInitOptions).backupsRoot == 'string' &&
    typeof (options as DatabaseInitOptions).previousShutdownWasClean == 'boolean' &&
    typeof (options as DatabaseInitOptions).targetSchemaVersion == 'number'
}

const resolveInitialization = (options: DatabaseInitOptions): {
  key: string
  options: DatabaseInitOptions
} => {
  try {
    if (!validInitializationOptions(options)) throw new Error('database_initialization_invalid')
    const normalized = {
      ...options,
      dataPath: path.resolve(options.dataPath),
      cacheRoot: path.resolve(options.cacheRoot),
      backupsRoot: path.resolve(options.backupsRoot),
    }
    return {
      key: JSON.stringify([
        normalized.dataPath,
        normalized.cacheRoot,
        normalized.backupsRoot,
        normalized.previousShutdownWasClean,
        String(normalized.targetSchemaVersion),
      ]),
      options: normalized,
    }
  } catch {
    return { key: 'invalid_initialization_options', options }
  }
}

const isCurrentAttempt = (generation: number, key: string): boolean =>
  lifecycleGeneration == generation && initializationKey == key

const initializeDatabase = async(
  options: DatabaseInitOptions,
  generation: number,
  key: string,
): Promise<DatabaseStartupResult> => {
  let databasePath: string
  let nativeOptions: { nativeBinding?: string } = {}
  try {
    databasePath = resolveContainedPath(path.resolve(options.dataPath), 'lx.data.db', path)
    path.resolve(options.cacheRoot)
    path.resolve(options.backupsRoot)
    nativeOptions = getNativeOptions()
  } catch {
    const fallbackPath = typeof options.dataPath == 'string'
      ? path.resolve(options.dataPath, 'lx.data.db')
      : path.resolve('lx.data.db')
    return enterRecovery('open_failed', fallbackPath, null, ['open.path_invalid'], null, nativeOptions, null)
  }

  const target = prepareSqliteTarget(path.resolve(options.dataPath), databasePath, {
    fileSystem: fs,
    pathModule: path,
  })
  if (!target.ok) {
    return enterRecovery('open_failed', databasePath, null, [target.diagnostic], null, nativeOptions, null)
  }
  const existed = target.existed

  if (!validatePreparedSqliteTarget(databasePath, target, { fileSystem: fs, pathModule: path })) {
    closeSqliteGuardDescriptor(fs, target.guardDescriptor)
    return enterRecovery('open_failed', databasePath, null, ['open.target_changed'], null, nativeOptions, null)
  }

  let localWriteDb: Database.Database | null = null
  let targetValidatedAfterOpen = false
  try {
    localWriteDb = new Database(databasePath, {
      ...nativeOptions,
      fileMustExist: true,
    })
    initializingDb = localWriteDb
    if (!validatePreparedSqliteTarget(databasePath, target, { fileSystem: fs, pathModule: path })) {
      closeSqliteGuardDescriptor(fs, target.guardDescriptor)
      return enterRecovery(
        'open_failed',
        databasePath,
        null,
        ['open.target_changed'],
        localWriteDb,
        nativeOptions,
        null,
      )
    }
    targetValidatedAfterOpen = true
    closeSqliteGuardDescriptor(fs, target.guardDescriptor)
    localWriteDb.pragma('foreign_keys = ON')
    localWriteDb.pragma('journal_mode = WAL')
  } catch {
    const targetIsValid = targetValidatedAfterOpen || validatePreparedSqliteTarget(
      databasePath,
      target,
      { fileSystem: fs, pathModule: path },
    )
    closeSqliteGuardDescriptor(fs, target.guardDescriptor)
    return enterRecovery(
      'open_failed',
      databasePath,
      null,
      [targetIsValid ? 'open.failed' : 'open.target_changed'],
      localWriteDb,
      nativeOptions,
      targetIsValid ? target : null,
    )
  }

  if (!existed) {
    try {
      bootstrapDatabaseSchema(localWriteDb, migrations, {
        targetSchemaVersion: options.targetSchemaVersion,
      })
    } catch {
      return enterRecovery(
        'migration_failed',
        databasePath,
        null,
        ['migration.bootstrap_failed'],
        localWriteDb,
        nativeOptions,
        target,
      )
    }
  }

  let fromVersion: number
  try {
    fromVersion = getSchemaVersion(localWriteDb)
  } catch {
    return enterRecovery(
      'migration_failed',
      databasePath,
      null,
      ['migration.plan_failed'],
      localWriteDb,
      nativeOptions,
      target,
    )
  }

  if (fromVersion >= 7) {
    try {
      if (fromVersion != 7) throw createDatabaseError('database_schema_version_unsupported')
      verifySchema7SteadyState(localWriteDb)
      if (!options.previousShutdownWasClean) {
        if (localWriteDb.pragma('quick_check', { simple: true }) != 'ok') {
          return enterRecovery(
            'quick_check_failed', databasePath, null, ['quick_check.failed'],
            localWriteDb, nativeOptions, target,
          )
        }
        if ((localWriteDb.pragma('foreign_key_check') as unknown[]).length > 0) {
          return enterRecovery(
            'foreign_key_check_failed', databasePath, null, ['foreign_key_check.failed'],
            localWriteDb, nativeOptions, target,
          )
        }
      }
    } catch {
      return enterRecovery(
        'schema_invalid', databasePath, null, ['schema.verify_failed'],
        localWriteDb, nativeOptions, target,
      )
    }

    enterRawLyricSchema7CacheOnly()
    writeDb = localWriteDb
    initializingDb = null
    recoveryDb = null
    health = { status: 'ready', readOnly: false, schemaVersion: 7 }
    readyInitialization = Object.freeze({
      dataPath: options.dataPath,
      cacheRoot: options.cacheRoot,
      backupsRoot: options.backupsRoot,
      schemaVersion: 7,
      existedBeforeOpen: existed,
    })
    return {
      status: 'ready',
      existed,
      schemaVersion: 7,
      migratedVersions: [],
      backupPath: null,
      preparedCutoverPending: false,
    }
  }

  let pending
  try {
    pending = getPendingMigrations(localWriteDb, migrations, { targetSchemaVersion: options.targetSchemaVersion })
  } catch {
    return enterRecovery(
      'migration_failed',
      databasePath,
      null,
      ['migration.plan_failed'],
      localWriteDb,
      nativeOptions,
      target,
    )
  }

  let backupPath: string | null = null
  let backupGuard: VerifiedOnlineBackupGuard | null = null
  if (existed && pending.length > 0) {
    try {
      const reservation = reserveOnlineBackup({
        backupsRoot: options.backupsRoot,
        basenamePrefix: `lx.data.db.pre-migration-v${fromVersion}-to-v${pending[pending.length - 1].version}`,
        sourceSchemaVersion: fromVersion,
      })
      backupPath = reservation.path
      backupGuard = completeOnlineBackup(localWriteDb, reservation, nativeOptions, backupDb => {
        if (getSchemaVersion(backupDb) != fromVersion) throw createDatabaseError('database_backup_schema_invalid')
      })
    } catch {
      if (!isCurrentAttempt(generation, key)) {
        closeConnection(localWriteDb)
        throw createDatabaseError('database_initialization_cancelled')
      }
      return enterRecovery(
        'backup_failed',
        databasePath,
        backupPath,
        ['backup.failed'],
        localWriteDb,
        nativeOptions,
        target,
      )
    }
    if (!isCurrentAttempt(generation, key)) {
      try { backupGuard?.close() } catch {}
      closeConnection(localWriteDb)
      throw createDatabaseError('database_initialization_cancelled')
    }
  }

  let migratedVersions: number[] = []
  let schemaVersion: number
  let backupRevalidationFailed = false
  try {
    if (pending.length > 0) {
      migratedVersions = runMigrations(localWriteDb, migrations, {
        targetSchemaVersion: options.targetSchemaVersion,
        beforeCommit: backupGuard == null
          ? undefined
          : () => {
              try {
                backupGuard?.revalidate()
              } catch (error) {
                backupRevalidationFailed = true
                throw error
              }
            },
      }).applied
    }
    schemaVersion = getSchemaVersion(localWriteDb)
  } catch {
    try { backupGuard?.close() } catch {}
    return enterRecovery(
      backupRevalidationFailed ? 'backup_failed' : 'migration_failed',
      databasePath,
      backupPath,
      [backupRevalidationFailed ? 'backup.failed' : 'migration.failed'],
      localWriteDb,
      nativeOptions,
      target,
    )
  }
  try {
    backupGuard?.close()
  } catch {
    return enterRecovery(
      'backup_failed', databasePath, backupPath, ['backup.failed'], localWriteDb, nativeOptions, target,
    )
  }

  let verification: ReturnType<typeof verifyDatabase>
  try {
    const needsIntegrityChecks = !existed || migratedVersions.length > 0 || !options.previousShutdownWasClean
    verification = verifyDatabase(localWriteDb, {
      runQuickCheck: needsIntegrityChecks,
      runForeignKeyCheck: needsIntegrityChecks,
    })
  } catch {
    return enterRecovery(
      'schema_invalid',
      databasePath,
      backupPath,
      ['schema.verify_failed'],
      localWriteDb,
      nativeOptions,
      target,
    )
  }
  if (!verification.ok) {
    return enterRecovery(
      verification.reason,
      databasePath,
      backupPath,
      verification.diagnostics,
      localWriteDb,
      nativeOptions,
      target,
    )
  }

  let preparedCutoverPending = false
  // A prepared marker is itself startup state: verify it before application code can observe schema 6.
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache cutover loading boundary.
  const cutover = require('../../migration/cache/cutover') as typeof CacheCutover
  if (cutover.readBackupPreparedMarker(localWriteDb) != null) {
    const prerequisites = cutover.verifySchema6CutoverPrerequisites(localWriteDb)
    cutover.verifyBackupPreparedMarker(localWriteDb, prerequisites.readWriteMarker)
    preparedCutoverPending = true
  }

  writeDb = localWriteDb
  initializingDb = null
  recoveryDb = null
  health = { status: 'ready', readOnly: false, schemaVersion }
  readyInitialization = Object.freeze({
    dataPath: options.dataPath,
    cacheRoot: options.cacheRoot,
    backupsRoot: options.backupsRoot,
    schemaVersion: schemaVersion as 6,
    existedBeforeOpen: existed,
  })
  return { status: 'ready', existed, schemaVersion, migratedVersions, backupPath, preparedCutoverPending }
}

export const init = async(options: DatabaseInitOptions): Promise<DatabaseStartupResult> => {
  const requestedTargetSchemaVersion: unknown = options?.targetSchemaVersion
  if (requestedTargetSchemaVersion === 7) {
    throw createDatabaseError('database_direct_schema7_forbidden')
  }
  const resolved = resolveInitialization(options)
  if (resolved.key == 'invalid_initialization_options') {
    throw createDatabaseError('database_initialization_invalid')
  }
  if (initializationKey != null && initializationKey != resolved.key) {
    return Promise.reject(createDatabaseError('database_initialization_conflict'))
  }
  if (typeof requestedTargetSchemaVersion != 'number' || requestedTargetSchemaVersion != 6) {
    throw createDatabaseError('database_initialization_invalid')
  }
  if (cachedStartupResult != null) return Promise.resolve(cloneStartupResult(cachedStartupResult))
  if (initializationPromise != null) return initializationPromise.then(cloneStartupResult)

  initializationKey = resolved.key
  const generation = ++lifecycleGeneration
  const attempt = initializeDatabase(resolved.options, generation, resolved.key)
  initializationPromise = attempt.then(result => {
    if (isCurrentAttempt(generation, resolved.key)) {
      cachedStartupResult = freezeStartupResult(result)
      initializationPromise = null
      return cachedStartupResult
    }
    throw createDatabaseError('database_initialization_cancelled')
  }, error => {
    if (isCurrentAttempt(generation, resolved.key)) {
      const closeAttempt = closeConnection(initializingDb)
      if (closeAttempt.closed) initializingDb = null
      initializationPromise = null
      if (initializingDb == null) initializationKey = null
    }
    throw error
  })
  return initializationPromise.then(cloneStartupResult)
}

export const getAppDB = (): Database.Database => {
  if (health.status != 'ready' || writeDb == null) {
    throw createDatabaseError('database_not_ready')
  }
  return writeDb
}

export const getOpenAppDatabaseSchemaVersion = (): 6 | 7 => {
  const schemaVersion = getSchemaVersion(getAppDB())
  if (schemaVersion != 6 && schemaVersion != 7) {
    throw createDatabaseError('database_schema_version_unsupported')
  }
  return schemaVersion
}

export const getDatabaseInitialization = (): Readonly<{
  cacheRoot: string
  backupsRoot: string
  schemaVersion: 6 | 7
  existedBeforeOpen: boolean
}> => {
  if (health.status != 'ready' || writeDb == null || readyInitialization == null ||
    (readyInitialization.schemaVersion != 6 && readyInitialization.schemaVersion != 7)) {
    throw createDatabaseError('database_not_ready')
  }
  return Object.freeze({
    cacheRoot: readyInitialization.cacheRoot,
    backupsRoot: readyInitialization.backupsRoot,
    schemaVersion: readyInitialization.schemaVersion,
    existedBeforeOpen: readyInitialization.existedBeforeOpen,
  })
}

const cutoverBackupVerifier = (readWriteMarkerSha256: string): OnlineBackupVerifier => backupDb => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache cutover loading boundary.
  const cutover = require('../../migration/cache/cutover') as typeof CacheCutover
  cutover.verifyCutoverBackup(backupDb, readWriteMarkerSha256)
}

const prepareCutoverBackup = (
  db: Database.Database,
  backupsRoot: string,
  readWriteMarker: CacheCutover.StrictMarkerRow<typeof CacheCutover.READ_WRITE_MARKER_NAME>,
): VerifiedOnlineBackupGuard => {
  const nativeOptions = getNativeOptions()
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache cutover loading boundary.
  const cutover = require('../../migration/cache/cutover') as typeof CacheCutover
  const readWriteMarkerSha256 = cutover.markerRowSha256(readWriteMarker)
  const existing = cutover.verifyBackupPreparedMarker(db, readWriteMarker)
  if (existing != null) {
    return reopenPreparedOnlineBackup(db, {
      backupsRoot,
      marker: existing,
      nativeOptions,
      verifier: cutoverBackupVerifier(readWriteMarkerSha256),
    })
  }

  const reservation = reserveOnlineBackup({
    backupsRoot,
    basenamePrefix: 'lx.data.db.pre-migration-v6-to-v7',
    sourceSchemaVersion: 6,
  })
  const completedAtMs = Date.now()
  try {
    db.transaction(() => cutover.writeBackupPreparedMarker(db, {
      details: {
        backupBasename: reservation.basename,
        readWriteMarkerSha256,
        sourceSchemaVersion: 6,
        version: 1,
      },
      completedAtMs,
    }))()
  } catch (error) {
    try { closeOnlineBackupReservation(reservation) } catch {}
    throw error
  }
  return completeOnlineBackup(db, reservation, nativeOptions, cutoverBackupVerifier(readWriteMarkerSha256))
}

const runCacheCutoverMigration = (
  db: Database.Database,
  beforeCommit?: () => void,
): MigrationRunResult => db.transaction(() => {
  const fromVersion = getSchemaVersion(db)
  if (fromVersion != 6) throw createDatabaseError('database_advance_schema_invalid')
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Load migration 7 only during the schema-6-to-7 transition.
  const { migration7 } = require('./migrations/0007_cache_cleanup') as typeof CacheCleanupMigration
  const appliedAtMs = Date.now()
  if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
    throw new Error('Migration 7 produced an invalid applied timestamp')
  }
  const context = Object.freeze({ appliedAtMs })
  migration7.up(db, context)
  db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(migration7.version, migration7.name, migration7.checksum, appliedAtMs)
  if (db.prepare("UPDATE db_info SET field_value = ? WHERE field_name = 'version'").run('7').changes != 1) {
    throw new Error('Migration 7 could not update the legacy version mirror')
  }
  migration7.verify?.(db, context)
  beforeCommit?.()
  return { fromVersion: 6, toVersion: 7, applied: [7] }
})()

const publishSchema7 = (
  initialization: Readonly<ReadyInitialization>,
  backupPath: string | null,
  migratedVersions: number[],
): Readonly<DatabaseReadyResult> => {
  if (writeDb == null || cachedStartupResult?.status != 'ready') {
    throw createDatabaseError('database_not_ready')
  }
  const result = freezeReadyResult({
    status: 'ready',
    existed: cachedStartupResult.existed,
    schemaVersion: 7,
    migratedVersions,
    backupPath,
    preparedCutoverPending: false,
  })
  enterRawLyricSchema7CacheOnly()
  health = { status: 'ready', readOnly: false, schemaVersion: 7 }
  readyInitialization = Object.freeze({ ...initialization, schemaVersion: 7 })
  cachedStartupResult = result
  return result
}

const performDatabaseAdvance = async(
  db: Database.Database,
  initialization: Readonly<ReadyInitialization>,
  generation: number,
): Promise<Readonly<DatabaseReadyResult>> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache cutover loading boundary.
  const cutover = require('../../migration/cache/cutover') as typeof CacheCutover
  const currentVersion = getSchemaVersion(db)
  if (currentVersion == 7) {
    const { readWriteMarker, backupPreparedMarker } = cutover.verifySchema7SteadyState(db)
    const backupPath = backupPreparedMarker == null
      ? null
      : resolveContainedPath(initialization.backupsRoot, backupPreparedMarker.details.backupBasename, path)
    if (backupPath != null) {
      try {
        verifyLegacyOnlineBackup(
          backupPath,
          getNativeOptions(),
          cutoverBackupVerifier(cutover.markerRowSha256(readWriteMarker)),
        )
      } catch {
        throw createDatabaseError('database_advance_backup_invalid')
      }
    }
    return publishSchema7(initialization, backupPath, [])
  }
  if (currentVersion != 6) throw createDatabaseError('database_advance_schema_invalid')

  const prerequisites = cutover.verifySchema6CutoverPrerequisites(db)
  const readWriteMarkerSha256 = cutover.markerRowSha256(prerequisites.readWriteMarker)
  const backupGuard = initialization.existedBeforeOpen
    ? prepareCutoverBackup(db, initialization.backupsRoot, prerequisites.readWriteMarker)
    : null
  const backupPath = backupGuard?.path ?? null
  if (generation != lifecycleGeneration || writeDb != db || health.status != 'ready') {
    try { backupGuard?.close() } catch {}
    throw createDatabaseError('database_advance_cancelled')
  }

  const refreshed = cutover.verifySchema6CutoverPrerequisites(db)
  if (cutover.markerRowSha256(refreshed.readWriteMarker) != readWriteMarkerSha256) {
    try { backupGuard?.close() } catch {}
    throw createDatabaseError('database_advance_schema_invalid')
  }
  if (backupGuard != null) cutover.verifyBackupPreparedMarker(db, refreshed.readWriteMarker)

  enterRawLyricCutoverPending()
  try {
    const migration = runCacheCutoverMigration(db, backupGuard == null
      ? undefined
      : () => { backupGuard.revalidate() })
    if (migration.fromVersion != 6 || migration.toVersion != 7 ||
      migration.applied.length != 1 || migration.applied[0] != 7) {
      throw createDatabaseError('database_advance_migration_invalid')
    }
    cutover.verifySchema7SteadyState(db)
  } catch (error) {
    try { backupGuard?.close() } catch {}
    try {
      cutover.verifySchema7SteadyState(db)
      enterRawLyricSchema7CacheOnly()
    } catch {
      if (cutover.verifySchema6RollbackState(db)) restoreRawLyricSchema6Fallback()
    }
    throw error
  }
  let backupCloseFailed = false
  try {
    backupGuard?.close()
  } catch {
    backupCloseFailed = true
  }
  const published = publishSchema7(initialization, backupPath, [7])
  if (backupCloseFailed) throw createDatabaseError('database_advance_backup_invalid')
  return published
}

const resolveAdvance = (input: DatabaseAdvanceOptions): {
  key: string
  initialization: Readonly<ReadyInitialization>
  db: Database.Database
} | null => {
  if (input == null || typeof input != 'object' || Array.isArray(input) ||
    Object.getPrototypeOf(input) != Object.prototype ||
    Reflect.ownKeys(input).length != 2 || !Object.hasOwn(input, 'targetSchemaVersion') ||
    !Object.hasOwn(input, 'backupsRoot') || typeof input.targetSchemaVersion != 'number' ||
    input.targetSchemaVersion != 7 ||
    typeof input.backupsRoot != 'string' || health.status != 'ready' ||
    writeDb == null || readyInitialization == null) return null
  let resolvedBackupsRoot: string
  try {
    resolvedBackupsRoot = path.resolve(input.backupsRoot)
  } catch {
    return null
  }
  if (resolvedBackupsRoot != readyInitialization.backupsRoot) {
    return {
      key: JSON.stringify([7, resolvedBackupsRoot]),
      initialization: readyInitialization,
      db: writeDb,
    }
  }
  return {
    key: JSON.stringify([7, resolvedBackupsRoot]),
    initialization: readyInitialization,
    db: writeDb,
  }
}

export const advanceAppDatabase = (
  input: DatabaseAdvanceOptions,
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Preserve cached advance promise identity and synchronous validation.
): Promise<Readonly<DatabaseReadyResult>> => {
  const resolved = resolveAdvance(input)
  if (resolved == null) return Promise.reject(createDatabaseError('database_advance_invalid'))
  if (resolved.initialization.backupsRoot != path.resolve(input.backupsRoot)) {
    return Promise.reject(createDatabaseError(advancePromise == null
      ? 'database_advance_invalid'
      : 'database_advance_conflict'))
  }
  if (advancePromise != null) {
    return advanceKey == resolved.key
      ? advancePromise
      : Promise.reject(createDatabaseError('database_advance_conflict'))
  }

  advanceKey = resolved.key
  const generation = lifecycleGeneration
  const shared = performDatabaseAdvance(resolved.db, resolved.initialization, generation).then(result => {
    if (advanceKey == resolved.key) {
      advanceKey = null
      advancePromise = null
    }
    return result
  }, error => {
    if (advanceKey == resolved.key) {
      advanceKey = null
      advancePromise = null
    }
    throw error
  })
  advancePromise = shared
  return shared
}

export const getDatabaseHealth = (): DatabaseHealth => health.status == 'recovery'
  ? { ...health, diagnostics: [...health.diagnostics] }
  : { ...health }
