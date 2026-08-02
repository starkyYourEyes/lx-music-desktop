import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createOnlineBackup } from './databaseBackup'
import { bootstrapDatabaseSchema, getPendingMigrations, getSchemaVersion, runMigrations } from './migrate'
import { migrations } from './migrations'
import { verifyDatabase } from './verifyDB'
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

export type DatabaseStartupResult =
  | {
    status: 'ready'
    existed: boolean
    schemaVersion: number
    migratedVersions: number[]
    backupPath: string | null
  }
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
  targetSchemaVersion: number
}

let writeDb: Database.Database | null = null
let recoveryDb: Database.Database | null = null
let initializingDb: Database.Database | null = null
let health: DatabaseHealth = { status: 'closed' }
let initializationKey: string | null = null
let initializationPromise: Promise<DatabaseStartupResult> | null = null
let cachedStartupResult: DatabaseStartupResult | null = null
let lifecycleGeneration = 0
let readyInitialization: Readonly<{ cacheRoot: string, schemaVersion: number }> | null = null

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
    health = { status: 'closed' }
  }
  if (failure instanceof Error) throw failure
  if (failure != null) throw new Error('database_close_failed')
}

const allocateBackupPath = (
  backupsRoot: string,
  fromVersion: number,
  toVersion: number,
): string => {
  const resolvedBackupDir = path.resolve(backupsRoot)
  fs.mkdirSync(resolvedBackupDir, { recursive: true })
  const timestamp = Date.now()
  for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter++) {
    const name = `lx.data.db.pre-migration-v${fromVersion}-to-v${toVersion}.${timestamp}-${counter}.backup`
    const candidate = resolveContainedPath(resolvedBackupDir, name, path)
    if (!pathExists(candidate)) return candidate
  }
  throw new Error('backup_name_exhausted')
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

const resolveInitialization = (options: DatabaseInitOptions): {
  key: string
  options: DatabaseInitOptions
} => {
  try {
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

  let pending
  let fromVersion: number
  try {
    pending = getPendingMigrations(localWriteDb, migrations, { targetSchemaVersion: options.targetSchemaVersion })
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

  let backupPath: string | null = null
  if (existed && pending.length > 0) {
    try {
      backupPath = allocateBackupPath(options.backupsRoot, fromVersion, pending[pending.length - 1].version)
      await createOnlineBackup(localWriteDb, backupPath, nativeOptions)
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
      closeConnection(localWriteDb)
      throw createDatabaseError('database_initialization_cancelled')
    }
  }

  let migratedVersions: number[] = []
  let schemaVersion: number
  try {
    if (pending.length > 0) {
      migratedVersions = runMigrations(localWriteDb, migrations, {
        targetSchemaVersion: options.targetSchemaVersion,
      }).applied
    }
    schemaVersion = getSchemaVersion(localWriteDb)
  } catch {
    return enterRecovery(
      'migration_failed',
      databasePath,
      backupPath,
      ['migration.failed'],
      localWriteDb,
      nativeOptions,
      target,
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

  writeDb = localWriteDb
  initializingDb = null
  recoveryDb = null
  health = { status: 'ready', readOnly: false, schemaVersion }
  readyInitialization = Object.freeze({ cacheRoot: options.cacheRoot, schemaVersion })
  return { status: 'ready', existed, schemaVersion, migratedVersions, backupPath }
}

export const init = async(options: DatabaseInitOptions): Promise<DatabaseStartupResult> => {
  const resolved = resolveInitialization(options)
  if (initializationKey != null && initializationKey != resolved.key) {
    return Promise.reject(createDatabaseError('database_initialization_conflict'))
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

export const getDB = getAppDB

export const getDatabaseInitialization = (): Readonly<{ cacheRoot: string, schemaVersion: 6 | 7 }> => {
  if (health.status != 'ready' || writeDb == null || readyInitialization == null ||
    (readyInitialization.schemaVersion != 6 && readyInitialization.schemaVersion != 7)) {
    throw createDatabaseError('database_not_ready')
  }
  return Object.freeze({
    cacheRoot: readyInitialization.cacheRoot,
    schemaVersion: readyInitialization.schemaVersion,
  })
}

export const getDatabaseHealth = (): DatabaseHealth => health.status == 'recovery'
  ? { ...health, diagnostics: [...health.diagnostics] }
  : { ...health }
