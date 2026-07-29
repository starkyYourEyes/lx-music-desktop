const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { test } = require('node:test')
const typescript = require('typescript')

// Electron ABI tests transpile the source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const Database = require('better-sqlite3')
const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
const actualMigrate = require('../../src/main/worker/dbService/migrate.ts')
const actualMigrations = require('../../src/main/worker/dbService/migrations/index.ts')
const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
const tables = require('../../src/main/worker/dbService/tables.ts').default
const { createAtomicJsonFile } = require('../../src/main/storage/atomicJsonFile.ts')

const MIGRATION_3_CHECKSUM = '9243aa510e8355d2c3d0f687c6736654adf584ec6007b1bcf46f374a9d694e41'
const FOUNDATION_V3_SCHEMA = [
  {
    name: 'db_info',
    type: 'table',
    columns: [
      { name: 'id', type: 'INTEGER', notNull: true, primaryKeyPosition: 1 },
      { name: 'field_name', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
      { name: 'field_value', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
    ],
    indexes: [{ columns: ['id'], unique: true, partial: false }],
    foreignKeys: [],
  },
  {
    name: 'my_list',
    type: 'table',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKeyPosition: 1 },
      { name: 'name', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'source', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
      { name: 'sourceListId', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
      { name: 'position', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
      { name: 'locationUpdateTime', type: 'INTEGER', notNull: false, primaryKeyPosition: 0 },
    ],
    indexes: [{ columns: ['id'], unique: true, partial: false }],
    foreignKeys: [],
  },
  {
    name: 'my_list_music_info',
    type: 'table',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'listId', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'name', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'singer', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'source', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'interval', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
      { name: 'meta', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [
      { columns: ['id', 'listId'], unique: false, partial: false },
      { columns: ['id', 'listId'], unique: true, partial: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'my_list_music_info_order',
    type: 'table',
    columns: [
      { name: 'listId', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'musicInfoId', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'order', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [{ columns: ['listId', 'musicInfoId'], unique: false, partial: false }],
    foreignKeys: [],
  },
  {
    name: 'music_info_other_source',
    type: 'table',
    columns: [
      { name: 'source_id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'source', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'name', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'singer', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'meta', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'order', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [
      { columns: ['source_id', 'id'], unique: false, partial: false },
      { columns: ['source_id', 'id'], unique: true, partial: false },
    ],
    foreignKeys: [],
  },
  {
    name: 'lyric',
    type: 'table',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'source', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'type', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'text', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [],
    foreignKeys: [],
  },
  {
    name: 'music_url',
    type: 'table',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'url', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [],
    foreignKeys: [],
  },
  {
    name: 'download_list',
    type: 'table',
    columns: [
      { name: 'id', type: 'TEXT', notNull: true, primaryKeyPosition: 1 },
      { name: 'isComplate', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
      { name: 'status', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'statusText', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'progress_downloaded', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
      { name: 'progress_total', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
      { name: 'url', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
      { name: 'quality', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'ext', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'fileName', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'filePath', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'musicInfo', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'position', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [{ columns: ['id'], unique: true, partial: false }],
    foreignKeys: [],
  },
  {
    name: 'dislike_list',
    type: 'table',
    columns: [
      { name: 'type', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'content', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'meta', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
    ],
    indexes: [],
    foreignKeys: [],
  },
  {
    name: 'schema_migrations',
    type: 'table',
    columns: [
      { name: 'version', type: 'INTEGER', notNull: false, primaryKeyPosition: 1 },
      { name: 'name', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'checksum', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'applied_at_ms', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [],
    foreignKeys: [],
  },
  {
    name: 'migration_markers',
    type: 'table',
    columns: [
      { name: 'name', type: 'TEXT', notNull: false, primaryKeyPosition: 1 },
      { name: 'source_sha256', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      { name: 'completed_at_ms', type: 'INTEGER', notNull: true, primaryKeyPosition: 0 },
      { name: 'details_json', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
    ],
    indexes: [{ columns: ['name'], unique: true, partial: false }],
    foreignKeys: [],
  },
]

const sha256Bytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const sha256File = async filePath => sha256Bytes(await fsp.readFile(filePath))

const quotePragmaValue = value => `'${value.replaceAll("'", "''")}'`
const compareJson = (left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))

const readFoundationSchema = db => FOUNDATION_V3_SCHEMA.map(({ name }) => {
  const object = db.prepare('SELECT type FROM sqlite_master WHERE name = ?').get(name)
  const columns = db.pragma(`table_info(${quotePragmaValue(name)})`).map(column => ({
    name: column.name,
    type: column.type,
    notNull: column.notnull == 1,
    primaryKeyPosition: column.pk,
  }))
  const indexes = db.pragma(`index_list(${quotePragmaValue(name)})`).map(index => ({
    columns: db.pragma(`index_info(${quotePragmaValue(index.name)})`)
      .sort((left, right) => left.seqno - right.seqno)
      .map(column => column.name),
    unique: index.unique == 1,
    partial: index.partial == 1,
  })).sort(compareJson)
  const foreignKeysById = new Map()
  for (const row of db.pragma(`foreign_key_list(${quotePragmaValue(name)})`)) {
    let relationship = foreignKeysById.get(row.id)
    if (relationship == null) {
      relationship = {
        table: row.table,
        from: [],
        to: [],
        onUpdate: row.on_update,
        onDelete: row.on_delete,
        match: row.match,
      }
      foreignKeysById.set(row.id, relationship)
    }
    relationship.from[row.seq] = row.from
    relationship.to[row.seq] = row.to
  }
  return {
    name,
    type: object?.type ?? null,
    columns,
    indexes,
    foreignKeys: Array.from(foreignKeysById.values()),
  }
})

const createFaultTracker = () => {
  let hits = 0
  return {
    hit() { hits++ },
    count: () => hits,
  }
}

const makeDatabasePaths = async prefix => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix))
  const dataPath = path.join(root, 'profile')
  const backupDir = path.join(root, 'backups')
  await fsp.mkdir(dataPath, { recursive: true })
  return { root, dataPath, backupDir, databasePath: path.join(dataPath, 'lx.data.db') }
}

const createV2Database = databasePath => {
  const db = new Database(databasePath)
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    db.exec(`${Array.from(tables.values()).join('\n')}
      INSERT INTO db_info(field_name, field_value) VALUES ('version', '2');
    `)
    db.prepare(`
      INSERT INTO my_list(id, name, source, sourceListId, position, locationUpdateTime)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('foundation-sentinel', 'Foundation sentinel', 'local', 'source-list', 7, 123456)
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

const createV3Database = databasePath => {
  createV2Database(databasePath)
  const db = new Database(databasePath)
  try {
    db.pragma('foreign_keys = ON')
    db.pragma('journal_mode = WAL')
    actualMigrate.runMigrations(db, actualMigrations.migrations, { now: () => 1000 })
    db.pragma('wal_checkpoint(TRUNCATE)')
  } finally {
    db.close()
  }
}

const clearDbServiceCache = () => {
  try { delete require.cache[require.resolve('../../src/main/worker/dbService/db.ts')] } catch {}
}

const loadDbService = ({
  backupModule,
  migrateModule,
  migrationsModule,
  verifyModule,
  DatabaseImplementation,
} = {}) => {
  clearDbServiceCache()
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (backupModule && request == './databaseBackup') return backupModule
    if (migrateModule && request == './migrate') return migrateModule
    if (migrationsModule && request == './migrations') return migrationsModule
    if (verifyModule && request == './verifyDB') return verifyModule
    if (DatabaseImplementation && request == 'better-sqlite3') return DatabaseImplementation
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require('../../src/main/worker/dbService/db.ts')
  } finally {
    Module._load = originalLoad
  }
}

const databaseMetadata = databasePath => {
  const db = new Database(databasePath, { readonly: true, fileMustExist: true })
  try {
    const hasLedger = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get() != null
    return {
      quickCheck: db.pragma('quick_check', { simple: true }),
      foreignKeyFailures: db.pragma('foreign_key_check'),
      foundationSchema: readFoundationSchema(db),
      version: db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value,
      migration: hasLedger
        ? db.prepare('SELECT version, name, checksum FROM schema_migrations ORDER BY version').get()
        : null,
      sentinelCount: db.prepare("SELECT count(*) count FROM my_list WHERE id = 'foundation-sentinel'").get().count,
    }
  } finally {
    db.close()
  }
}

const backupArtifacts = async backupDir => {
  try {
    return (await fsp.readdir(backupDir)).filter(name => name.endsWith('.backup'))
  } catch (error) {
    if (error.code == 'ENOENT') return []
    throw error
  }
}

const assertPriorBackup = result => {
  assert.equal(typeof result.backupPath, 'string')
  assert.equal(fs.existsSync(result.backupPath), true)
  const backup = databaseMetadata(result.backupPath)
  assert.equal(backup.quickCheck, 'ok')
  assert.equal(backup.version, '2')
  assert.equal(backup.migration, null)
  assert.equal(backup.sentinelCount, 1)
  assert.deepEqual(backup.foreignKeyFailures, [])
}

const observingDatabase = (databasePath, tracker, quickCheckResult) => class ObservingDatabase {
  constructor(...args) {
    const db = new Database(...args)
    return new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property)
        if (property == 'pragma') {
          return (statement, options) => {
            if (statement == 'quick_check' && path.resolve(args[0]) == path.resolve(databasePath)) {
              tracker.hit()
              if (quickCheckResult != null) return quickCheckResult
            }
            return target.pragma(statement, options)
          }
        }
        return typeof value == 'function' ? value.bind(target) : value
      },
    })
  }
}

const databaseBoundaries = (fixtureCase, databasePath, tracker) => {
  switch (fixtureCase.fault) {
    case 'before_backup':
      return {
        backupModule: {
          createOnlineBackup: async() => {
            tracker.hit()
            throw new Error('injected before backup')
          },
        },
      }
    case 'after_backup':
      return {
        backupModule: {
          createOnlineBackup: async(...args) => {
            await actualBackup.createOnlineBackup(...args)
            tracker.hit()
            throw new Error('injected after backup')
          },
        },
      }
    case 'inside_migration_3': {
      const migration3 = actualMigrations.migration3
      return {
        migrationsModule: {
          ...actualMigrations,
          migrations: [{
            ...migration3,
            up(db) {
              migration3.up(db)
              tracker.hit()
              throw new Error('injected inside migration 3')
            },
          }],
        },
      }
    }
    case 'after_migration_commit':
      return {
        migrateModule: {
          ...actualMigrate,
          runMigrations: (...args) => {
            actualMigrate.runMigrations(...args)
            tracker.hit()
            throw new Error('injected after migration commit')
          },
        },
      }
    case 'before_structural_validation':
      return {
        verifyModule: {
          ...actualVerify,
          verifyDatabase: () => {
            tracker.hit()
            throw new Error('injected before structural validation')
          },
        },
      }
    case 'corrupt_existing_db':
      return {
        DatabaseImplementation: class TrackingDatabase {
          constructor(filename, options) {
            if (path.resolve(filename) == path.resolve(databasePath) && options?.readonly !== true) tracker.hit()
            return new Database(filename, options)
          }
        },
      }
    case 'observe_unclean_quick_check':
      return { DatabaseImplementation: observingDatabase(databasePath, tracker) }
    case 'quick_check_failure':
      return { DatabaseImplementation: observingDatabase(databasePath, tracker, 'injected quick-check failure') }
    case 'foreign_key_failure':
      return {
        migrateModule: {
          ...actualMigrate,
          runMigrations: (db, ...args) => {
            const result = actualMigrate.runMigrations(db, ...args)
            db.pragma('foreign_keys = OFF')
            db.exec(`
              CREATE TABLE foundation_failure_parent(id INTEGER PRIMARY KEY);
              CREATE TABLE foundation_failure_child(
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES foundation_failure_parent(id)
              );
              INSERT INTO foundation_failure_child(id, parent_id) VALUES (1, 404);
            `)
            db.pragma('foreign_keys = ON')
            tracker.hit()
            return result
          },
        },
      }
    default:
      throw new Error(`Unknown database fault ${fixtureCase.fault}`)
  }
}

const databaseCases = [
  {
    name: 'before backup',
    fixture: 'v2',
    fault: 'before_backup',
    status: 'recovery',
    reason: 'backup_failed',
    diagnostics: ['backup.failed'],
    authoritative: 'original',
    backup: 'not-started',
    previousShutdownWasClean: true,
  },
  {
    name: 'after backup',
    fixture: 'v2',
    fault: 'after_backup',
    status: 'recovery',
    reason: 'backup_failed',
    diagnostics: ['backup.failed'],
    authoritative: 'original',
    backup: 'prior',
    previousShutdownWasClean: true,
  },
  {
    name: 'inside migration 3',
    fixture: 'v2',
    fault: 'inside_migration_3',
    status: 'recovery',
    reason: 'migration_failed',
    diagnostics: ['migration.failed'],
    authoritative: 'original',
    backup: 'prior',
    previousShutdownWasClean: true,
  },
  {
    name: 'after migration commit',
    fixture: 'v2',
    fault: 'after_migration_commit',
    status: 'recovery',
    reason: 'migration_failed',
    diagnostics: ['migration.failed'],
    authoritative: 'committed',
    backup: 'prior',
    previousShutdownWasClean: true,
  },
  {
    name: 'before structural validation',
    fixture: 'v2',
    fault: 'before_structural_validation',
    status: 'recovery',
    reason: 'schema_invalid',
    diagnostics: ['schema.verify_failed'],
    authoritative: 'committed',
    backup: 'prior',
    previousShutdownWasClean: true,
  },
  {
    name: 'corrupt existing DB',
    fixture: 'corrupt',
    fault: 'corrupt_existing_db',
    status: 'recovery',
    reason: 'open_failed',
    diagnostics: ['open.failed', 'readonly_reopen.failed'],
    authoritative: 'corrupt',
    backup: 'not-needed',
    previousShutdownWasClean: true,
  },
  {
    name: 'unclean run with valid DB',
    fixture: 'v3',
    fault: 'observe_unclean_quick_check',
    status: 'ready',
    authoritative: 'original',
    backup: 'not-needed',
    previousShutdownWasClean: false,
  },
  {
    name: 'quick-check failure',
    fixture: 'v3',
    fault: 'quick_check_failure',
    status: 'recovery',
    reason: 'quick_check_failed',
    diagnostics: ['quick_check.failed'],
    authoritative: 'original',
    backup: 'not-needed',
    previousShutdownWasClean: false,
  },
  {
    name: 'foreign-key failure',
    fixture: 'v2',
    fault: 'foreign_key_failure',
    status: 'recovery',
    reason: 'foreign_key_check_failed',
    diagnostics: ['foreign_key_check.failed'],
    authoritative: 'committed-with-fk-failure',
    backup: 'prior',
    previousShutdownWasClean: true,
  },
]

test('database Foundation failure matrix', async t => {
  for (const fixtureCase of databaseCases) {
    await t.test(fixtureCase.name, async() => {
      const paths = await makeDatabasePaths(`lx-foundation-${fixtureCase.fault}-`)
      const tracker = createFaultTracker()
      let dbService
      try {
        if (fixtureCase.fixture == 'v2') createV2Database(paths.databasePath)
        else if (fixtureCase.fixture == 'v3') createV3Database(paths.databasePath)
        else await fsp.writeFile(paths.databasePath, Buffer.from('corrupt-foundation-database\0bytes'))
        const originalBytes = await fsp.readFile(paths.databasePath)
        const originalSha256 = sha256Bytes(originalBytes)
        dbService = loadDbService(databaseBoundaries(fixtureCase, paths.databasePath, tracker))

        const result = await dbService.init({
          dataPath: paths.dataPath,
          backupDir: paths.backupDir,
          previousShutdownWasClean: fixtureCase.previousShutdownWasClean,
        })

        assert.equal(result.status, fixtureCase.status)
        if (fixtureCase.status == 'recovery') {
          assert.equal(result.reason, fixtureCase.reason)
          assert.deepEqual(result.diagnostics, fixtureCase.diagnostics)
        } else {
          assert.equal(result.schemaVersion, 3)
          assert.deepEqual(result.migratedVersions, [])
          assert.equal(result.backupPath, null)
        }
        assert.equal(tracker.count(), 1, `${fixtureCase.name} boundary was not reached exactly once`)

        dbService.close()
        dbService = null
        const authoritativeSha256 = await sha256File(paths.databasePath)
        if (fixtureCase.authoritative == 'original' || fixtureCase.authoritative == 'corrupt') {
          assert.equal(authoritativeSha256, originalSha256)
        } else {
          assert.notEqual(authoritativeSha256, originalSha256)
        }

        if (fixtureCase.authoritative == 'corrupt') {
          assert.deepEqual(await fsp.readFile(paths.databasePath), originalBytes)
          assert.equal((await fsp.stat(paths.databasePath)).size, originalBytes.length)
        } else {
          const authoritative = databaseMetadata(paths.databasePath)
          assert.equal(authoritative.quickCheck, 'ok')
          assert.equal(authoritative.sentinelCount, 1)
          if (fixtureCase.authoritative == 'original') {
            assert.equal(authoritative.version, fixtureCase.fixture == 'v2' ? '2' : '3')
            if (fixtureCase.fixture == 'v2') assert.equal(authoritative.migration, null)
          } else {
            assert.equal(authoritative.version, '3')
            assert.equal(authoritative.migration.version, 3)
            assert.equal(authoritative.migration.name, 'storage_foundation')
            assert.equal(authoritative.migration.checksum, MIGRATION_3_CHECKSUM)
            assert.deepEqual(authoritative.foundationSchema, FOUNDATION_V3_SCHEMA)
            if (fixtureCase.authoritative == 'committed-with-fk-failure') {
              assert.equal(authoritative.foreignKeyFailures.length, 1)
            } else {
              assert.deepEqual(authoritative.foreignKeyFailures, [])
            }
          }
        }

        if (fixtureCase.backup == 'prior') {
          assertPriorBackup(result)
        } else {
          assert.deepEqual(await backupArtifacts(paths.backupDir), [])
          if (fixtureCase.backup == 'not-started') assert.equal(fs.existsSync(result.backupPath), false)
          else assert.equal(result.backupPath, null)
        }
      } finally {
        dbService?.close()
        clearDbServiceCache()
        await fsp.rm(paths.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    })
  }
})

const atomicCases = [
  { name: 'atomic JSON failure before rename', timing: 'before', destination: { n: 1 }, previous: { n: 1 } },
  { name: 'atomic JSON failure after rename', timing: 'after', destination: { n: 2 }, previous: { n: 1 } },
]

const isCounter = value => value != null && typeof value == 'object' &&
  !Array.isArray(value) && Number.isInteger(value.n)

const readValidCounter = async filePath => {
  const value = JSON.parse(await fsp.readFile(filePath, 'utf8'))
  assert.equal(isCounter(value), true)
  return value
}

test('atomic JSON Foundation failure matrix', async t => {
  for (const fixtureCase of atomicCases) {
    await t.test(fixtureCase.name, async() => {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `lx-foundation-atomic-${fixtureCase.timing}-`))
      const target = path.join(root, 'settings.json')
      const tracker = createFaultTracker()
      try {
        await fsp.writeFile(target, '{"n":1}')
        const originalSha256 = await sha256File(target)
        const faultFs = {
          ...fsp,
          async rename(source, destination) {
            if (destination != target) return fsp.rename(source, destination)
            if (fixtureCase.timing == 'after') await fsp.rename(source, destination)
            tracker.hit()
            throw new Error(`injected ${fixtureCase.timing} destination rename`)
          },
        }
        const file = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: faultFs })

        await assert.rejects(file.replace({ n: 2 }), new RegExp(`injected ${fixtureCase.timing}`))

        assert.equal(tracker.count(), 1, `${fixtureCase.name} boundary was not reached exactly once`)
        assert.deepEqual(await readValidCounter(target), fixtureCase.destination)
        assert.deepEqual(await readValidCounter(`${target}.previous`), fixtureCase.previous)
        assert.equal(await sha256File(`${target}.previous`), originalSha256)
        if (fixtureCase.timing == 'before') assert.equal(await sha256File(target), originalSha256)
        else assert.notEqual(await sha256File(target), originalSha256)
      } finally {
        await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      }
    })
  }
})
