const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
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
const {
  bootstrapDatabaseSchema,
  getMigrationMarker,
  getPendingMigrations,
  getSchemaVersion,
  putMigrationMarker,
  runMigrations,
} = require('../../src/main/worker/dbService/migrate.ts')
const { migration3 } = require('../../src/main/worker/dbService/migrations/0003_storage_foundation.ts')
const { migrations } = require('../../src/main/worker/dbService/migrations/index.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const MIGRATION_3_CHECKSUM = '9243aa510e8355d2c3d0f687c6736654adf584ec6007b1bcf46f374a9d694e41'
const LEGACY_SCHEMA = new Map([
  ['db_info', 'CREATE TABLE db_info (field_name TEXT, field_value TEXT)'],
  ['my_list', 'CREATE TABLE my_list (id TEXT PRIMARY KEY)'],
  ['my_list_music_info', 'CREATE TABLE my_list_music_info (id TEXT, listId TEXT)'],
  ['index_my_list_music_info', 'CREATE INDEX index_my_list_music_info ON my_list_music_info (id, listId)'],
  ['my_list_music_info_order', 'CREATE TABLE my_list_music_info_order (listId TEXT, musicInfoId TEXT)'],
  ['index_my_list_music_info_order', 'CREATE INDEX index_my_list_music_info_order ON my_list_music_info_order (listId, musicInfoId)'],
  ['music_info_other_source', 'CREATE TABLE music_info_other_source (source_id TEXT, id TEXT)'],
  ['index_music_info_other_source', 'CREATE INDEX index_music_info_other_source ON music_info_other_source (source_id, id)'],
  ['lyric', 'CREATE TABLE lyric (id TEXT)'],
  ['music_url', 'CREATE TABLE music_url (id TEXT)'],
  ['download_list', 'CREATE TABLE download_list (id TEXT PRIMARY KEY)'],
  ['dislike_list', 'CREATE TABLE dislike_list (type TEXT, content TEXT)'],
])

const databases = []
const tempDirs = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

const hasObject = (db, name) => Boolean(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name))

const createLegacyDatabase = (version, options = {}) => {
  const db = new Database(':memory:')
  databases.push(db)
  const omitted = new Set(options.omit ?? [])
  if (options.omitDislike) omitted.add('dislike_list')
  for (const [name, sql] of LEGACY_SCHEMA) {
    if (!omitted.has(name)) db.exec(sql)
  }
  if (!omitted.has('db_info')) {
    db.prepare('INSERT INTO db_info (field_name, field_value) VALUES (?, ?)').run('version', version)
  }
  return db
}

const checksum = source => crypto.createHash('sha256').update(source).digest('hex')

const createMigration = (version, name, up = () => {}) => ({
  version,
  name,
  checksum: checksum(`test migration ${version}: ${name}`),
  up,
})

const migration4 = createMigration(4, 'test_four', db => db.exec('CREATE TABLE migration_four (id INTEGER PRIMARY KEY)'))
const migration5 = createMigration(5, 'test_five', db => db.exec('CREATE TABLE migration_five (id INTEGER PRIMARY KEY)'))
const migration6 = createMigration(6, 'test_six', db => db.exec('CREATE TABLE migration_six (id INTEGER PRIMARY KEY)'))
const migration7 = createMigration(7, 'test_seven', db => db.exec('CREATE TABLE migration_seven (id INTEGER PRIMARY KEY)'))

const readLegacyVersion = db => db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value
const readLedger = db => db.prepare('SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version').all()

const loadDbServiceWithBoundaries = ({ DatabaseImplementation, fileSystem = fs }) => {
  const dbServicePath = require.resolve('../../src/main/worker/dbService/db.ts')
  const boundaryDependencyPaths = [
    require.resolve('../../src/main/worker/dbService/databaseBackup.ts'),
    require.resolve('../../src/main/worker/dbService/verifyDB.ts'),
  ]
  const originalLoad = Module._load
  delete require.cache[dbServicePath]
  for (const dependencyPath of boundaryDependencyPaths) delete require.cache[dependencyPath]
  Module._load = function(request, parent, isMain) {
    if (request == 'better-sqlite3') return DatabaseImplementation
    if (request == 'node:fs') return fileSystem
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(dbServicePath)
  } finally {
    Module._load = originalLoad
    delete require.cache[dbServicePath]
    for (const dependencyPath of boundaryDependencyPaths) delete require.cache[dependencyPath]
  }
}

describe('database migrations', () => {
  it('bootstraps a missing database to the requested registry target atomically', () => {
    const db = new Database(':memory:')
    databases.push(db)
    const bootstrapMigration4 = createMigration(4, 'bootstrap_four', database => {
      database.exec('CREATE TABLE bootstrap_four (id INTEGER PRIMARY KEY)')
    })

    const result = bootstrapDatabaseSchema(db, [migration3, bootstrapMigration4], { now: () => 1234 })

    assert.deepEqual(result, { fromVersion: 2, toVersion: 4, applied: [3, 4] })
    assert.equal(getSchemaVersion(db), 4)
    assert.equal(hasObject(db, 'bootstrap_four'), true)
    assert.deepEqual(readLedger(db).map(row => [row.version, row.name]), [
      [3, 'storage_foundation'],
      [4, 'bootstrap_four'],
    ])
  })

  it('rolls back the baseline and ledger when fresh bootstrap fails', () => {
    const db = new Database(':memory:')
    databases.push(db)
    const failingMigration4 = createMigration(4, 'bootstrap_failure', database => {
      database.exec('CREATE TABLE bootstrap_partial (id INTEGER PRIMARY KEY)')
      throw new Error('injected bootstrap failure')
    })

    assert.throws(
      () => bootstrapDatabaseSchema(db, [migration3, failingMigration4], { now: () => 1234 }),
      /injected bootstrap failure/,
    )
    assert.equal(hasObject(db, 'db_info'), false)
    assert.equal(hasObject(db, 'schema_migrations'), false)
    assert.equal(hasObject(db, 'migration_markers'), false)
    assert.equal(hasObject(db, 'bootstrap_partial'), false)
  })

  it('bridges legacy version 2 and applies all pending migrations atomically', () => {
    const db = createLegacyDatabase('2')

    const result = runMigrations(db, [migration3], { now: () => 1000 })

    assert.deepEqual(result, { fromVersion: 2, toVersion: 3, applied: [3] })
    assert.deepEqual(readLedger(db), [{
      version: 3,
      name: 'storage_foundation',
      checksum: MIGRATION_3_CHECKSUM,
      applied_at_ms: 1000,
    }])
    assert.deepEqual(
      { version: migration3.version, name: migration3.name, checksum: migration3.checksum },
      { version: 3, name: 'storage_foundation', checksum: MIGRATION_3_CHECKSUM },
    )
    assert.equal(readLegacyVersion(db), '3')
    assert.equal(getSchemaVersion(db), 3)
  })

  it('samples and freezes one migration timestamp before up and verifies after ledger and mirror writes', () => {
    const db = createLegacyDatabase('2')
    const observations = []
    let sampled = false
    let upContext
    const contextualMigration = {
      version: 3,
      name: 'contextual_three',
      checksum: checksum('contextual migration three'),
      up(database, context) {
        observations.push('up')
        assert.equal(sampled, true)
        assert.equal(Object.isFrozen(context), true)
        assert.equal(context.appliedAtMs, 4321)
        assert.equal(hasObject(database, 'contextual_three'), false)
        upContext = context
        database.exec('CREATE TABLE contextual_three (id INTEGER PRIMARY KEY)')
      },
      verify(database, context) {
        observations.push('verify')
        assert.equal(context, upContext)
        assert.deepEqual(readLedger(database), [{
          version: 3,
          name: 'contextual_three',
          checksum: checksum('contextual migration three'),
          applied_at_ms: 4321,
        }])
        assert.equal(readLegacyVersion(database), '3')
      },
    }

    assert.deepEqual(runMigrations(db, [contextualMigration], {
      now: () => {
        sampled = true
        observations.push('timestamp')
        return 4321
      },
    }), { fromVersion: 2, toVersion: 3, applied: [3] })
    assert.deepEqual(observations, ['timestamp', 'up', 'verify'])
  })

  it('rolls back migration, ledger, and mirror when post-ledger verification fails', () => {
    const db = createLegacyDatabase('2')
    const migration = {
      version: 3,
      name: 'verify_failure',
      checksum: checksum('verify failure'),
      up(database) { database.exec('CREATE TABLE verify_failure (id INTEGER PRIMARY KEY)') },
      verify() { throw new Error('injected post-ledger verification failure') },
    }
    assert.throws(
      () => runMigrations(db, [migration], { now: () => 9 }),
      /injected post-ledger verification failure/,
    )
    assert.equal(hasObject(db, 'verify_failure'), false)
    assert.equal(hasObject(db, 'schema_migrations'), false)
    assert.equal(readLegacyVersion(db), '2')
  })

  it('rolls back bootstrap and every pending migration when a later migration fails', () => {
    const db = createLegacyDatabase('2')
    const throwingMigration4 = createMigration(4, 'throwing_four', migratedDb => {
      migratedDb.exec('CREATE TABLE migration_four (id INTEGER PRIMARY KEY)')
      throw new Error('injected migration failure')
    })

    assert.throws(() => runMigrations(db, [migration3, throwingMigration4]), /injected migration failure/)

    assert.equal(hasObject(db, 'migration_markers'), false)
    assert.equal(hasObject(db, 'schema_migrations'), false)
    assert.equal(hasObject(db, 'migration_four'), false)
    assert.equal(readLegacyVersion(db), '2')
  })

  it('repairs a legacy version 1 database inside the migration transaction', () => {
    const db = createLegacyDatabase('1', { omitDislike: true })

    const result = runMigrations(db, [migration3], { now: () => 1000 })

    assert.deepEqual(result, { fromVersion: 1, toVersion: 3, applied: [3] })
    assert.equal(hasObject(db, 'dislike_list'), true)
    assert.equal(readLegacyVersion(db), '3')
  })

  it('rolls back the legacy version 1 repair when a pending migration fails', () => {
    const db = createLegacyDatabase('1', { omitDislike: true })
    const throwingMigration4 = createMigration(4, 'throwing_four', () => { throw new Error('injected migration failure') })

    assert.throws(() => runMigrations(db, [migration3, throwingMigration4]), /injected migration failure/)

    assert.equal(hasObject(db, 'dislike_list'), false)
    assert.equal(hasObject(db, 'schema_migrations'), false)
    assert.equal(readLegacyVersion(db), '1')
  })

  it('rejects unsupported or malformed legacy versions before creating the ledger', () => {
    for (const version of ['0', '2x', '4']) {
      const db = createLegacyDatabase(version)
      assert.throws(() => runMigrations(db, [migration3]), /legacy.*version/i)
      assert.equal(hasObject(db, 'schema_migrations'), false)
    }

    const duplicate = createLegacyDatabase('2')
    duplicate.prepare('INSERT INTO db_info (field_name, field_value) VALUES (?, ?)').run('version', '2')
    assert.throws(() => runMigrations(duplicate, [migration3]), /legacy.*version/i)
    assert.equal(hasObject(duplicate, 'schema_migrations'), false)
  })

  it('rejects malformed legacy table sets before repair or bootstrap', () => {
    const v1 = createLegacyDatabase('1', { omit: ['my_list'], omitDislike: true })
    assert.throws(() => runMigrations(v1, [migration3]), /legacy.*schema/i)
    assert.equal(hasObject(v1, 'dislike_list'), false)
    assert.equal(hasObject(v1, 'schema_migrations'), false)

    const v2 = createLegacyDatabase('2', { omitDislike: true })
    assert.throws(() => runMigrations(v2, [migration3]), /legacy.*schema/i)
    assert.equal(hasObject(v2, 'schema_migrations'), false)

    const extra = createLegacyDatabase('2')
    extra.exec('CREATE TABLE unexpected_legacy_table (id INTEGER)')
    assert.throws(() => runMigrations(extra, [migration3]), /legacy.*schema/i)
    assert.equal(hasObject(extra, 'schema_migrations'), false)
  })

  it('rejects duplicate, unordered, non-contiguous, or malformed migration registries', () => {
    const cases = [
      [migration3, { ...migration3, name: 'duplicate_three' }],
      [migration4, migration3],
      [migration3, createMigration(5, 'gap_five')],
      [{ ...migration3, checksum: 'A'.repeat(64) }],
      [{ ...migration3, checksum: '0'.repeat(63) }],
    ]
    for (const registry of cases) {
      const db = createLegacyDatabase('2')
      assert.throws(() => getPendingMigrations(db, registry), /migration registry/i)
      assert.equal(hasObject(db, 'schema_migrations'), false)
    }
  })

  it('reruns idempotently without changing applied migration records', () => {
    const db = createLegacyDatabase('2')
    let clockCalls = 0
    runMigrations(db, [migration3], { now: () => ++clockCalls * 1000 })
    const before = readLedger(db)

    const result = runMigrations(db, [migration3], { now: () => ++clockCalls * 1000 })

    assert.deepEqual(result, { fromVersion: 3, toVersion: 3, applied: [] })
    assert.deepEqual(readLedger(db), before)
    assert.equal(clockCalls, 1)
  })

  it('stops at an inclusive migration target and resumes from that exact boundary', () => {
    const db = createLegacyDatabase('2')
    const registry = [migration3, migration4, migration5]

    const first = runMigrations(db, registry, { targetSchemaVersion: 4, now: () => 1000 })
    assert.deepEqual(first, { fromVersion: 2, toVersion: 4, applied: [3, 4] })
    assert.deepEqual(readLedger(db).map(row => row.version), [3, 4])
    assert.equal(hasObject(db, 'migration_five'), false)
    assert.equal(readLegacyVersion(db), '4')

    const second = runMigrations(db, registry, { targetSchemaVersion: 5, now: () => 2000 })
    assert.deepEqual(second, { fromVersion: 4, toVersion: 5, applied: [5] })
    assert.deepEqual(readLedger(db).map(row => row.version), [3, 4, 5])
    assert.equal(hasObject(db, 'migration_five'), true)
    assert.equal(readLegacyVersion(db), '5')
  })

  it('caps every omitted-target migration entry point at schema 6', () => {
    const registry = [migration3, migration4, migration5, migration6, migration7]
    const pendingDb = createLegacyDatabase('2')
    assert.deepEqual(getPendingMigrations(pendingDb, registry).map(migration => migration.version), [3, 4, 5, 6])

    const runnerDb = createLegacyDatabase('2')
    assert.deepEqual(runMigrations(runnerDb, registry, { now: () => 1000 }), {
      fromVersion: 2,
      toVersion: 6,
      applied: [3, 4, 5, 6],
    })
    assert.equal(hasObject(runnerDb, 'migration_seven'), false)

    const bootstrapDb = new Database(':memory:')
    databases.push(bootstrapDb)
    assert.deepEqual(bootstrapDatabaseSchema(bootstrapDb, registry, { now: () => 1000 }), {
      fromVersion: 2,
      toVersion: 6,
      applied: [3, 4, 5, 6],
    })
    assert.equal(hasObject(bootstrapDb, 'migration_seven'), false)
  })

  it('rejects migration targets outside an inclusive contiguous boundary', () => {
    const registry = [migration3, migration4]
    for (const targetSchemaVersion of [1, 2.5, 5, Number.POSITIVE_INFINITY]) {
      const db = createLegacyDatabase('2')
      assert.throws(
        () => getPendingMigrations(db, registry, { targetSchemaVersion }),
        /target schema version/i,
      )
      assert.equal(hasObject(db, 'schema_migrations'), false)
    }
  })

  it('rejects changed names, checksums, and missing registry entries for applied migrations', () => {
    const changedName = createLegacyDatabase('2')
    runMigrations(changedName, [migration3])
    assert.throws(
      () => runMigrations(changedName, [{ ...migration3, name: 'changed_name' }]),
      /name/i,
    )

    const changedChecksum = createLegacyDatabase('2')
    runMigrations(changedChecksum, [migration3])
    assert.throws(
      () => runMigrations(changedChecksum, [{ ...migration3, checksum: '0'.repeat(64) }]),
      /checksum/i,
    )

    const missing = createLegacyDatabase('2')
    runMigrations(missing, [migration3, migration4])
    assert.throws(() => getPendingMigrations(missing, [migration3]), /missing.*4/i)
  })

  it('uses the ledger as authoritative after migration bootstrap', () => {
    const db = createLegacyDatabase('2')
    runMigrations(db, [migration3])
    db.prepare("UPDATE db_info SET field_value = '1' WHERE field_name = 'version'").run()

    assert.equal(getSchemaVersion(db), 3)
  })

  it('round-trips migration markers with canonical versioned object details', () => {
    const db = createLegacyDatabase('2')
    runMigrations(db, [migration3])
    const marker = {
      name: 'legacy_config_v1.settings',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 1234,
      detailsJson: '{"z":2,"version":1,"a":{"y":2,"x":1}}',
    }

    putMigrationMarker(db, marker)

    assert.deepEqual(getMigrationMarker(db, marker.name), {
      ...marker,
      detailsJson: '{"a":{"x":1,"y":2},"version":1,"z":2}',
    })
  })

  it('rejects invalid migration marker names, hashes, timestamps, and envelopes', () => {
    const db = createLegacyDatabase('2')
    runMigrations(db, [migration3])
    const valid = {
      name: 'legacy_config_v1.settings',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 0,
      detailsJson: '{"version":1}',
    }
    const invalid = [
      { ...valid, name: '' },
      { ...valid, sourceSha256: 'A'.repeat(64) },
      { ...valid, sourceSha256: 'a'.repeat(63) },
      { ...valid, completedAtMs: -1 },
      { ...valid, completedAtMs: 1.5 },
      { ...valid, completedAtMs: Number.POSITIVE_INFINITY },
      { ...valid, detailsJson: 'not json' },
      { ...valid, detailsJson: '[]' },
      { ...valid, detailsJson: '{"wrong":1}' },
      { ...valid, detailsJson: '{"version":2}' },
    ]

    for (const marker of invalid) assert.throws(() => putMigrationMarker(db, marker), /migration marker/i)
    assert.equal(db.prepare('SELECT count(*) AS count FROM migration_markers').get().count, 0)
  })

  it('enforces migration marker constraints for direct SQL writes', () => {
    const db = createLegacyDatabase('2')
    runMigrations(db, [migration3])
    const insert = db.prepare(`
      INSERT INTO migration_markers (name, source_sha256, completed_at_ms, details_json)
      VALUES (?, ?, ?, ?)
    `)
    const invalidRows = [
      ['short-sha', 'a'.repeat(63), 0, '{"version":1}'],
      ['negative-time', 'a'.repeat(64), -1, '{"version":1}'],
      ['fractional-time', 'a'.repeat(64), 1.5, '{"version":1}'],
      ['invalid-json', 'a'.repeat(64), 0, 'not json'],
    ]

    for (const row of invalidRows) assert.throws(() => insert.run(...row), /constraint/i)
    assert.equal(db.prepare('SELECT count(*) AS count FROM migration_markers').get().count, 0)
  })

  it('reuses same-source migration markers without overwriting original details', () => {
    const db = createLegacyDatabase('2')
    runMigrations(db, [migration3])
    const original = {
      name: 'legacy_config_v1.settings',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 1000,
      detailsJson: '{"version":1,"attempt":1}',
    }
    putMigrationMarker(db, original)

    putMigrationMarker(db, { ...original, completedAtMs: 2000, detailsJson: '{"version":1,"attempt":2}' })

    assert.deepEqual(getMigrationMarker(db, original.name), {
      ...original,
      detailsJson: '{"attempt":1,"version":1}',
    })
  })

  it('rejects conflicting-source migration markers without exposing or replacing payloads', () => {
    const db = createLegacyDatabase('2')
    runMigrations(db, [migration3])
    const original = {
      name: 'legacy_config_v1.settings',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 1000,
      detailsJson: '{"version":1,"secret":"not-in-error"}',
    }
    putMigrationMarker(db, original)

    assert.throws(
      () => putMigrationMarker(db, { ...original, sourceSha256: 'b'.repeat(64) }),
      error => error.message.includes(original.name) && error.message.includes('conflict') && !error.message.includes('not-in-error'),
    )
    assert.deepEqual(getMigrationMarker(db, original.name), {
      ...original,
      detailsJson: '{"secret":"not-in-error","version":1}',
    })
  })

  it('maps an existing app database open error to recovery without a create fallback', async() => {
    const fixture = createTestStorageRoot('lx-migration-open-error')
    tempDirs.push(fixture)
    const profileRoot = fixture.path
    fs.writeFileSync(path.join(profileRoot, 'lx.data.db'), '')
    const openError = new Error('injected existing database open failure')
    const fallbackError = new Error('create fallback must not run')
    let openCalls = 0
    class FailingDatabase {
      constructor() {
        openCalls++
        throw openCalls == 1 ? openError : fallbackError
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: FailingDatabase })

    const result = await dbService.init({
      dataPath: profileRoot,
      cacheRoot: path.join(profileRoot, 'cache'),
      backupsRoot: path.join(profileRoot, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(result.diagnostics, ['open.failed', 'readonly_reopen.failed'])
    assert.equal(openCalls, 2)
  })

  it('maps app database stat errors to recovery without attempting write open or create', async() => {
    const fixture = createTestStorageRoot('lx-migration-stat-error')
    tempDirs.push(fixture)
    const profileRoot = fixture.path
    const databasePath = path.join(profileRoot, 'lx.data.db')
    const statError = Object.assign(new Error('injected database stat failure'), { code: 'EACCES' })
    let openCalls = 0
    class UnexpectedDatabase {
      constructor() {
        openCalls++
        throw new Error('database open must not run')
      }
    }
    const fileSystem = {
      ...fs,
      lstatSync(target) {
        if (target == databasePath) throw statError
        return fs.lstatSync(target)
      },
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: UnexpectedDatabase, fileSystem })

    const result = await dbService.init({
      dataPath: profileRoot,
      cacheRoot: path.join(profileRoot, 'cache'),
      backupsRoot: path.join(profileRoot, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(result.diagnostics, ['open.target_inspect_failed'])
    assert.equal(openCalls, 0)
  })

  it('bootstraps a new app database without migration backup metadata', async() => {
    const fixture = createTestStorageRoot('lx-migration-init')
    tempDirs.push(fixture)
    const profileRoot = fixture.path
    const dbService = require('../../src/main/worker/dbService/db.ts')

    const backupsRoot = path.join(profileRoot, 'backups')
    const result = await dbService.init({
      dataPath: profileRoot,
      cacheRoot: path.join(profileRoot, 'cache'),
      backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    const db = dbService.getAppDB()
    databases.push(db)
    const targetMigrations = migrations.filter(migration => migration.version <= 6)

    assert.equal(result.status, 'ready')
    assert.deepEqual({
      existed: result.existed,
      schemaVersion: result.schemaVersion,
      migratedVersions: result.migratedVersions,
      backupPath: result.backupPath,
    }, {
      existed: false,
      schemaVersion: 6,
      migratedVersions: [],
      backupPath: null,
    })
    assert.equal(dbService.getAppDB(), db)
    assert.equal(getSchemaVersion(db), 6)
    assert.deepEqual(
      readLedger(db).map(row => [row.version, row.name, row.checksum]),
      targetMigrations.map(migration => [migration.version, migration.name, migration.checksum]),
    )
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal(db.pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(fs.existsSync(backupsRoot), false)
    assert.equal(fs.existsSync(path.join(profileRoot, 'lx.data.db')), true)
    assert.equal(fs.existsSync(path.join(profileRoot, 'activity.db')), false)
  })
})
