import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { createOnlineBackup } from './databaseBackup'
import { getPendingMigrations, getSchemaVersion, runMigrations } from './migrate'
import { migrations } from './migrations'
import tables, { LEGACY_DB_VERSION } from './tables'
import { verifyDatabase } from './verifyDB'

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
  backupDir: string
  previousShutdownWasClean: boolean
  targetSchemaVersion?: number
}

let writeDb: Database.Database | null = null
let recoveryDb: Database.Database | null = null
let initializingDb: Database.Database | null = null
let health: DatabaseHealth = { status: 'closed' }
let initializationKey: string | null = null
let initializationPromise: Promise<DatabaseStartupResult> | null = null
let cachedStartupResult: DatabaseStartupResult | null = null
let lifecycleGeneration = 0

const pathExists = (filePath: string): boolean => {
  try {
    fs.statSync(filePath)
    return true
  } catch (error) {
    if (error != null && typeof error == 'object' && 'code' in error && error.code == 'ENOENT') return false
    throw error
  }
}

const resolveContainedPath = (rootPath: string, childName: string): string => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(root, childName)
  const relative = path.relative(root, candidate)
  if (relative.startsWith(`..${path.sep}`) || relative == '..' || path.isAbsolute(relative)) {
    throw new Error('path_outside_root')
  }
  return candidate
}

const getNativeOptions = (): { nativeBinding?: string } => {
  const nativeBinding = path.resolve(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  return pathExists(nativeBinding) ? { nativeBinding } : {}
}

const initTables = (db: Database.Database): void => {
  db.exec(`
    ${Array.from(tables.values()).join('\n')}
    INSERT INTO "main"."db_info" ("field_name", "field_value") VALUES ('version', '${LEGACY_DB_VERSION}');
  `)
}

const safeClose = (db: Database.Database | null): void => {
  if (!db?.open) return
  try {
    db.close()
  } catch {}
}

export const close = (): void => {
  lifecycleGeneration++
  safeClose(initializingDb)
  safeClose(writeDb)
  safeClose(recoveryDb)
  initializingDb = null
  writeDb = null
  recoveryDb = null
  initializationKey = null
  initializationPromise = null
  cachedStartupResult = null
  health = { status: 'closed' }
}

const allocateBackupPath = (
  backupDir: string,
  fromVersion: number,
  toVersion: number,
): string => {
  const resolvedBackupDir = path.resolve(backupDir)
  fs.mkdirSync(resolvedBackupDir, { recursive: true })
  const timestamp = Date.now()
  for (let counter = 0; counter < Number.MAX_SAFE_INTEGER; counter++) {
    const name = `lx.data.db.pre-migration-v${fromVersion}-to-v${toVersion}.${timestamp}-${counter}.backup`
    const candidate = resolveContainedPath(resolvedBackupDir, name)
    if (!pathExists(candidate)) return candidate
  }
  throw new Error('backup_name_exhausted')
}

const reopenReadOnly = (
  databasePath: string,
  nativeOptions: { nativeBinding?: string },
): { db: Database.Database | null, diagnostic: string | null } => {
  let db: Database.Database | null = null
  try {
    db = new Database(databasePath, { ...nativeOptions, readonly: true, fileMustExist: true })
    db.pragma('schema_version', { simple: true })
    return { db, diagnostic: null }
  } catch {
    safeClose(db)
    return { db: null, diagnostic: 'readonly_reopen.failed' }
  }
}

const enterRecovery = (
  reason: DatabaseRecoveryReason,
  databasePath: string,
  backupPath: string | null,
  diagnostics: string[],
  localWriteDb: Database.Database | null,
  nativeOptions: { nativeBinding?: string },
): DatabaseStartupResult => {
  safeClose(localWriteDb)
  if (initializingDb == localWriteDb) initializingDb = null
  writeDb = null
  const reopened = reopenReadOnly(databasePath, nativeOptions)
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
      backupDir: path.resolve(options.backupDir),
    }
    return {
      key: JSON.stringify([
        normalized.dataPath,
        normalized.backupDir,
        normalized.previousShutdownWasClean,
        normalized.targetSchemaVersion == null ? null : String(normalized.targetSchemaVersion),
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
    databasePath = resolveContainedPath(path.resolve(options.dataPath), 'lx.data.db')
    path.resolve(options.backupDir)
    nativeOptions = getNativeOptions()
  } catch {
    const fallbackPath = typeof options.dataPath == 'string'
      ? path.resolve(options.dataPath, 'lx.data.db')
      : path.resolve('lx.data.db')
    return enterRecovery('open_failed', fallbackPath, null, ['open.path_invalid'], null, nativeOptions)
  }

  let existed: boolean
  try {
    existed = pathExists(databasePath)
    if (!existed) fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  } catch {
    return enterRecovery('open_failed', databasePath, null, ['open.stat_failed'], null, nativeOptions)
  }

  let localWriteDb: Database.Database | null = null
  try {
    localWriteDb = new Database(databasePath, {
      ...nativeOptions,
      ...(existed ? { fileMustExist: true } : {}),
    })
    initializingDb = localWriteDb
    localWriteDb.pragma('foreign_keys = ON')
    localWriteDb.pragma('journal_mode = WAL')
    if (!existed) initTables(localWriteDb)
  } catch {
    return enterRecovery('open_failed', databasePath, null, ['open.failed'], localWriteDb, nativeOptions)
  }

  let pending
  let fromVersion: number
  try {
    pending = getPendingMigrations(localWriteDb, migrations, { targetSchemaVersion: options.targetSchemaVersion })
    fromVersion = getSchemaVersion(localWriteDb)
  } catch {
    return enterRecovery('migration_failed', databasePath, null, ['migration.plan_failed'], localWriteDb, nativeOptions)
  }

  let backupPath: string | null = null
  if (pending.length > 0) {
    try {
      backupPath = allocateBackupPath(options.backupDir, fromVersion, pending[pending.length - 1].version)
      await createOnlineBackup(localWriteDb, backupPath)
    } catch {
      if (!isCurrentAttempt(generation, key)) {
        safeClose(localWriteDb)
        throw createDatabaseError('database_initialization_cancelled')
      }
      return enterRecovery('backup_failed', databasePath, backupPath, ['backup.failed'], localWriteDb, nativeOptions)
    }
    if (!isCurrentAttempt(generation, key)) {
      safeClose(localWriteDb)
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
    return enterRecovery('migration_failed', databasePath, backupPath, ['migration.failed'], localWriteDb, nativeOptions)
  }

  let verification: ReturnType<typeof verifyDatabase>
  try {
    verification = verifyDatabase(localWriteDb, {
      runQuickCheck: migratedVersions.length > 0 || !options.previousShutdownWasClean,
      runForeignKeyCheck: migratedVersions.length > 0,
    })
  } catch {
    return enterRecovery(
      'schema_invalid',
      databasePath,
      backupPath,
      ['schema.verify_failed'],
      localWriteDb,
      nativeOptions,
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
    )
  }

  writeDb = localWriteDb
  initializingDb = null
  recoveryDb = null
  health = { status: 'ready', readOnly: false, schemaVersion }
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
      safeClose(initializingDb)
      initializingDb = null
      initializationPromise = null
      initializationKey = null
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

export const getDatabaseHealth = (): DatabaseHealth => health.status == 'recovery'
  ? { ...health, diagnostics: [...health.diagnostics] }
  : { ...health }
