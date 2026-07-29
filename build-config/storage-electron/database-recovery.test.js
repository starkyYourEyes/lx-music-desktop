const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
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
const MIGRATION_3_CHECKSUM = '9243aa510e8355d2c3d0f687c6736654adf584ec6007b1bcf46f374a9d694e41'
const tempDirs = []
const databases = []

const V3_SCHEMA = `
  CREATE TABLE db_info (
    id INTEGER NOT NULL UNIQUE,
    field_name TEXT,
    field_value TEXT,
    PRIMARY KEY(id AUTOINCREMENT)
  );
  CREATE TABLE my_list (
    id TEXT NOT NULL PRIMARY KEY,
    name TEXT NOT NULL,
    source TEXT,
    sourceListId TEXT,
    position INTEGER NOT NULL,
    locationUpdateTime INTEGER
  );
  CREATE TABLE my_list_music_info (
    id TEXT NOT NULL,
    listId TEXT NOT NULL,
    name TEXT NOT NULL,
    singer TEXT NOT NULL,
    source TEXT NOT NULL,
    interval TEXT,
    meta TEXT NOT NULL,
    UNIQUE(id, listId)
  );
  CREATE INDEX index_my_list_music_info ON my_list_music_info(id, listId);
  CREATE TABLE my_list_music_info_order (
    listId TEXT NOT NULL,
    musicInfoId TEXT NOT NULL,
    "order" INTEGER NOT NULL
  );
  CREATE INDEX index_my_list_music_info_order ON my_list_music_info_order(listId, musicInfoId);
  CREATE TABLE music_info_other_source (
    source_id TEXT NOT NULL,
    id TEXT NOT NULL,
    source TEXT NOT NULL,
    name TEXT NOT NULL,
    singer TEXT NOT NULL,
    meta TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    UNIQUE(source_id, id)
  );
  CREATE INDEX index_music_info_other_source ON music_info_other_source(source_id, id);
  CREATE TABLE lyric (id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, text TEXT NOT NULL);
  CREATE TABLE music_url (id TEXT NOT NULL, url TEXT NOT NULL);
  CREATE TABLE download_list (
    id TEXT NOT NULL PRIMARY KEY,
    isComplate INTEGER NOT NULL,
    status TEXT NOT NULL,
    statusText TEXT NOT NULL,
    progress_downloaded INTEGER NOT NULL,
    progress_total INTEGER NOT NULL,
    url TEXT,
    quality TEXT NOT NULL,
    ext TEXT NOT NULL,
    fileName TEXT NOT NULL,
    filePath TEXT NOT NULL,
    musicInfo TEXT NOT NULL,
    position INTEGER NOT NULL
  );
  CREATE TABLE dislike_list (type TEXT NOT NULL, content TEXT NOT NULL, meta TEXT);
  CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    checksum TEXT NOT NULL CHECK(length(checksum) = 64),
    applied_at_ms INTEGER NOT NULL CHECK(typeof(applied_at_ms) = 'integer' AND applied_at_ms >= 0)
  );
  CREATE TABLE migration_markers (
    name TEXT PRIMARY KEY,
    source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
    completed_at_ms INTEGER NOT NULL CHECK(typeof(completed_at_ms) = 'integer' AND completed_at_ms >= 0),
    details_json TEXT NOT NULL CHECK(json_valid(details_json))
  );
  INSERT INTO db_info(field_name, field_value) VALUES ('version', '3');
  INSERT INTO schema_migrations(version, name, checksum, applied_at_ms)
    VALUES (3, 'storage_foundation', '${MIGRATION_3_CHECKSUM}', 1000);
`

const SYNTHETIC_CONTRACT = {
  tables: [
    {
      name: 'parent',
      columns: [
        { name: 'id', type: 'INTEGER', notNull: false, primaryKeyPosition: 1 },
        { name: 'code', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      ],
      indexes: [{ name: 'parent_code_unique', columns: ['code'], unique: true }],
      foreignKeys: [],
    },
    {
      name: 'child',
      columns: [
        { name: 'id', type: 'INTEGER', notNull: false, primaryKeyPosition: 1 },
        { name: 'parent_code', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      ],
      indexes: [{ name: 'child_parent_code', columns: ['parent_code'], unique: false }],
      foreignKeys: [{
        name: 'child_parent_code_fk',
        table: 'parent',
        from: ['parent_code'],
        to: ['code'],
        onUpdate: 'CASCADE',
        onDelete: 'RESTRICT',
      }],
    },
  ],
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
  try {
    const dbService = require('../../src/main/worker/dbService/db.ts')
    dbService.close?.()
  } catch {}
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

const tempDir = prefix => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(directory)
  return directory
}

const openTracked = (filename, options) => {
  const db = new Database(filename, options)
  databases.push(db)
  return db
}

const makePaths = prefix => {
  const root = tempDir(prefix)
  const dataPath = path.join(root, 'profile')
  const backupDir = path.join(root, 'backups')
  fs.mkdirSync(dataPath, { recursive: true })
  return { root, dataPath, backupDir, databasePath: path.join(dataPath, 'lx.data.db') }
}

const createV3Database = databasePath => {
  const db = openTracked(databasePath)
  db.exec(V3_SCHEMA)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

const clearDbServiceCache = () => {
  for (const filename of [
    '../../src/main/worker/dbService/db.ts',
    '../../src/main/worker/dbService/databaseBackup.ts',
    '../../src/main/worker/dbService/verifyDB.ts',
  ]) {
    try { delete require.cache[require.resolve(filename)] } catch {}
  }
}

const loadDbServiceWithBoundaries = ({
  backupModule,
  migrateModule,
  verifyModule,
  DatabaseImplementation,
  fileSystem,
  pathModule,
} = {}) => {
  clearDbServiceCache()
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (DatabaseImplementation && request == 'better-sqlite3') return DatabaseImplementation
    if (fileSystem && request == 'node:fs') return fileSystem
    if (pathModule && request == 'node:path') return pathModule
    if (backupModule && request == './databaseBackup') return backupModule
    if (migrateModule && request == './migrate') return migrateModule
    if (verifyModule && request == './verifyDB') return verifyModule
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require('../../src/main/worker/dbService/db.ts')
  } finally {
    Module._load = originalLoad
  }
}

const loadWorkerAdapterWithInit = initImplementation => {
  const indexPath = require.resolve('../../src/main/worker/dbService/index.ts')
  delete require.cache[indexPath]
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (request == './db') {
      return {
        init: initImplementation,
        close: () => {},
        getDatabaseHealth: () => ({ status: 'closed' }),
      }
    }
    if (request == '../utils/worker') return { exposeWorker: () => {} }
    if (request == './modules/index') return {}
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(indexPath)
  } finally {
    Module._load = originalLoad
    delete require.cache[indexPath]
  }
}

const initOptions = paths => ({
  dataPath: paths.dataPath,
  backupDir: paths.backupDir,
  previousShutdownWasClean: true,
})

describe('online backup', () => {
  it('kills live-file copy implementations by backing up committed WAL frames', async() => {
    const root = tempDir('lx-recovery-wal-')
    const source = path.join(root, 'source.db')
    const destination = path.join(root, 'nested', 'backup.db')
    const db = openTracked(source)
    db.pragma('journal_mode = WAL')
    db.pragma('wal_autocheckpoint = 0')
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)')
    const { createOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')

    await createOnlineBackup(db, destination)

    const restored = openTracked(destination, { readonly: true, fileMustExist: true })
    assert.equal(restored.prepare('SELECT count(*) count FROM items').get().count, 1)
    assert.equal(restored.pragma('quick_check', { simple: true }), 'ok')
  })

  it('kills overwrite implementations by preserving an existing backup artifact', async() => {
    const root = tempDir('lx-recovery-no-overwrite-')
    const source = path.join(root, 'source.db')
    const destination = path.join(root, 'backup.db')
    const db = openTracked(source)
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY)')
    fs.writeFileSync(destination, 'verified artifact')
    const { createOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')

    await assert.rejects(createOnlineBackup(db, destination))

    assert.equal(fs.readFileSync(destination, 'utf8'), 'verified artifact')
  })

  it('kills unverified-backup implementations by rejecting an invalid backup candidate', async() => {
    const root = tempDir('lx-recovery-invalid-backup-')
    const destination = path.join(root, 'backup.db')
    const fakeDb = { backup: async target => fs.writeFileSync(target, 'not sqlite') }
    const { createOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')

    await assert.rejects(createOnlineBackup(fakeDb, destination))

    assert.equal(fs.readFileSync(destination, 'utf8'), 'not sqlite')
  })
})

describe('PRAGMA structural verification', () => {
  const createSynthetic = (sql) => {
    const db = openTracked(':memory:')
    db.pragma('foreign_keys = OFF')
    db.exec(sql)
    return db
  }

  const validSyntheticSql = `
    CREATE TABLE parent(id INTEGER PRIMARY KEY, code TEXT NOT NULL);
    CREATE UNIQUE INDEX parent_code_unique ON parent(code);
    CREATE TABLE child(
      id INTEGER PRIMARY KEY,
      parent_code TEXT NOT NULL,
      FOREIGN KEY(parent_code) REFERENCES parent(code) ON UPDATE CASCADE ON DELETE RESTRICT
    );
    CREATE INDEX child_parent_code ON child(parent_code);
  `

  it('kills sqlite_master SQL-text comparison by accepting equivalent formatting and declaration order', () => {
    const db = createSynthetic(validSyntheticSql)
    const { verifyDatabaseAgainstContract } = require('../../src/main/worker/dbService/verifyDB.ts')

    const result = verifyDatabaseAgainstContract(db, SYNTHETIC_CONTRACT, {
      runQuickCheck: false,
      runForeignKeyCheck: false,
    })

    assert.deepEqual(result, { ok: true, diagnostics: [] })
  })

  it('kills permissive table/column verification by rejecting missing tables and columns', () => {
    const { verifyDatabaseAgainstContract } = require('../../src/main/worker/dbService/verifyDB.ts')
    const missingTable = createSynthetic('CREATE TABLE parent(id INTEGER PRIMARY KEY, code TEXT NOT NULL); CREATE UNIQUE INDEX parent_code_unique ON parent(code)')
    const missingColumn = createSynthetic(validSyntheticSql.replace(
      'CREATE TABLE child(\n      id INTEGER PRIMARY KEY,',
      'CREATE TABLE child(\n      wrong INTEGER PRIMARY KEY,',
    ))

    assert.deepEqual(verifyDatabaseAgainstContract(missingTable, SYNTHETIC_CONTRACT, {
      runQuickCheck: false,
      runForeignKeyCheck: false,
    }), { ok: false, reason: 'schema_invalid', diagnostics: ['schema.table_missing:child'] })
    assert.equal(verifyDatabaseAgainstContract(missingColumn, SYNTHETIC_CONTRACT, {
      runQuickCheck: false,
      runForeignKeyCheck: false,
    }).reason, 'schema_invalid')
  })

  it('kills weak column and index verification by rejecting nullability, uniqueness, and index order mutations', () => {
    const { verifyDatabaseAgainstContract } = require('../../src/main/worker/dbService/verifyDB.ts')
    const cases = [
      validSyntheticSql.replace('parent_code TEXT NOT NULL,', 'parent_code TEXT,'),
      validSyntheticSql.replace('CREATE UNIQUE INDEX parent_code_unique', 'CREATE INDEX parent_code_unique'),
      validSyntheticSql.replace('child_parent_code ON child(parent_code)', 'child_parent_code ON child(id, parent_code)'),
    ]

    for (const sql of cases) {
      const result = verifyDatabaseAgainstContract(createSynthetic(sql), SYNTHETIC_CONTRACT, {
        runQuickCheck: false,
        runForeignKeyCheck: false,
      })
      assert.equal(result.reason, 'schema_invalid')
      assert.equal(result.diagnostics.every(code => !code.includes('CREATE TABLE')), true)
    }
  })

  it('kills incomplete FK verification by rejecting missing and mismatched FK actions/columns', () => {
    const { verifyDatabaseAgainstContract } = require('../../src/main/worker/dbService/verifyDB.ts')
    const cases = [
      validSyntheticSql.replace(
        'parent_code TEXT NOT NULL,\n      FOREIGN KEY(parent_code) REFERENCES parent(code) ON UPDATE CASCADE ON DELETE RESTRICT',
        'parent_code TEXT NOT NULL',
      ),
      validSyntheticSql.replace('REFERENCES parent(code)', 'REFERENCES parent(id)'),
      validSyntheticSql.replace('ON UPDATE CASCADE', 'ON UPDATE NO ACTION'),
      validSyntheticSql.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE'),
    ]

    for (const sql of cases) {
      const result = verifyDatabaseAgainstContract(createSynthetic(sql), SYNTHETIC_CONTRACT, {
        runQuickCheck: false,
        runForeignKeyCheck: false,
      })
      assert.deepEqual(result, {
        ok: false,
        reason: 'schema_invalid',
        diagnostics: ['schema.foreign_key_invalid:child.child_parent_code_fk'],
      })
    }
  })

  it('kills skipped FK-check implementations by mapping real violation rows without leaking row payloads', () => {
    const db = createSynthetic(validSyntheticSql)
    db.exec("INSERT INTO child(id, parent_code) VALUES (7, 'secret-parent-code')")
    const { verifyDatabaseAgainstContract } = require('../../src/main/worker/dbService/verifyDB.ts')

    const result = verifyDatabaseAgainstContract(db, SYNTHETIC_CONTRACT, {
      runQuickCheck: false,
      runForeignKeyCheck: true,
    })

    assert.deepEqual(result, {
      ok: false,
      reason: 'foreign_key_check_failed',
      diagnostics: ['foreign_key_check.failed'],
    })
    assert.equal(JSON.stringify(result).includes('secret-parent-code'), false)
    assert.equal(JSON.stringify(result).includes('7'), false)
  })
})

describe('database startup orchestration', () => {
  it('kills missing-backup fresh initialization by migrating v2 through a verified online backup', async() => {
    const paths = makePaths('lx-recovery-fresh-')
    const dbService = loadDbServiceWithBoundaries()

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'ready')
    assert.equal(result.existed, false)
    assert.equal(result.schemaVersion, 3)
    assert.deepEqual(result.migratedVersions, [3])
    assert.match(result.backupPath, /lx\.data\.db\.pre-migration-v2-to-v3\.\d+-0\.backup$/)
    assert.equal(path.dirname(result.backupPath), path.resolve(paths.backupDir))
    const backup = openTracked(result.backupPath, { readonly: true, fileMustExist: true })
    assert.equal(backup.pragma('quick_check', { simple: true }), 'ok')
    assert.equal(backup.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '2')
    assert.equal(dbService.getAppDB().pragma('foreign_keys', { simple: true }), 1)
    assert.equal(dbService.getAppDB().pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(fs.existsSync(path.join(paths.dataPath, 'activity.db')), false)
  })

  it('kills backup-after-migration and skipped-check implementations by preserving exact observable order', async() => {
    const paths = makePaths('lx-recovery-order-')
    const events = []
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    const actualMigrate = require('../../src/main/worker/dbService/migrate.ts')
    const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        createOnlineBackup: async(...args) => {
          events.push('backup')
          return actualBackup.createOnlineBackup(...args)
        },
      },
      migrateModule: {
        ...actualMigrate,
        getPendingMigrations: (...args) => {
          events.push('pending')
          return actualMigrate.getPendingMigrations(...args)
        },
        runMigrations: (...args) => {
          events.push('migration')
          return actualMigrate.runMigrations(...args)
        },
      },
      verifyModule: {
        ...actualVerify,
        verifyDatabase: (...args) => {
          events.push(`verify:${args[1].runQuickCheck}:${args[1].runForeignKeyCheck}`)
          return actualVerify.verifyDatabase(...args)
        },
      },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'ready')
    assert.deepEqual(events, ['pending', 'backup', 'migration', 'verify:true:true'])
  })

  it('kills unnecessary maintenance by skipping backup/quick/FK for clean no-pending startup', async() => {
    const paths = makePaths('lx-recovery-clean-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const calls = []
    const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: { createOnlineBackup: async() => { calls.push('backup') } },
      verifyModule: {
        ...actualVerify,
        verifyDatabase: (db, options) => {
          calls.push(options)
          return actualVerify.verifyDatabase(db, options)
        },
      },
    })

    const result = await dbService.init(initOptions(paths))

    assert.deepEqual(result, {
      status: 'ready', existed: true, schemaVersion: 3, migratedVersions: [], backupPath: null,
    })
    assert.deepEqual(calls, [{ runQuickCheck: false, runForeignKeyCheck: false }])
  })

  it('kills skipped unclean checks by running quick_check but not FK check without migration', async() => {
    const paths = makePaths('lx-recovery-unclean-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const calls = []
    const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
    const dbService = loadDbServiceWithBoundaries({
      verifyModule: {
        ...actualVerify,
        verifyDatabase: (db, options) => {
          calls.push(options)
          return actualVerify.verifyDatabase(db, options)
        },
      },
    })

    const result = await dbService.init({ ...initOptions(paths), previousShutdownWasClean: false })

    assert.equal(result.status, 'ready')
    assert.deepEqual(calls, [{ runQuickCheck: true, runForeignKeyCheck: false }])
  })

  it('kills migration-after-backup-failure by returning recovery and leaving v2 authoritative', async() => {
    const paths = makePaths('lx-recovery-backup-fail-')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: { createOnlineBackup: async() => { throw new Error('secret backup failure') } },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'backup_failed')
    assert.equal(result.diagnostics.includes('secret backup failure'), false)
    const readonly = openTracked(paths.databasePath, { readonly: true, fileMustExist: true })
    assert.equal(readonly.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '2')
    assert.equal(readonly.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined)
    assert.deepEqual(dbService.getDatabaseHealth(), {
      status: 'recovery', readOnly: true, reason: 'backup_failed', diagnostics: ['backup.failed'],
    })
  })

  it('kills migration-after-invalid-backup by preserving the failed candidate and v2 source', async() => {
    const paths = makePaths('lx-recovery-invalid-candidate-')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        createOnlineBackup: async(_db, destination) => {
          fs.writeFileSync(destination, 'invalid backup candidate')
          throw new Error('backup verification failed')
        },
      },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.reason, 'backup_failed')
    assert.equal(fs.readFileSync(result.backupPath, 'utf8'), 'invalid backup candidate')
    const readonly = openTracked(paths.databasePath, { readonly: true, fileMustExist: true })
    assert.equal(readonly.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '2')
    assert.equal(readonly.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get(), undefined)
  })

  it('kills destructive recovery by preserving invalid existing bytes and attempting read-only reopen', async() => {
    const paths = makePaths('lx-recovery-invalid-')
    fs.writeFileSync(paths.databasePath, 'not sqlite')
    const before = fs.readFileSync(paths.databasePath)
    const openModes = []
    class TrackingDatabase {
      constructor(filename, options) {
        openModes.push({ filename, options })
        return new Database(filename, options)
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: TrackingDatabase })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(fs.readFileSync(paths.databasePath), before)
    assert.equal(fs.existsSync(`${paths.databasePath}.recreated`), false)
    assert.equal(openModes.some(call => call.options?.readonly === true && call.options?.fileMustExist === true), true)
    assert.equal(dbService.getDatabaseHealth().status, 'recovery')
    assert.throws(() => dbService.getAppDB(), error => error.message == 'database_not_ready' && error.code == 'database_not_ready')
  })

  it('kills recovery escalation by returning only sanitized codes when read-only reopen also fails', async() => {
    const paths = makePaths('lx-recovery-readonly-fail-')
    fs.writeFileSync(paths.databasePath, 'not sqlite')
    const dbService = loadDbServiceWithBoundaries()

    const result = await dbService.init(initOptions(paths))

    assert.deepEqual(result, {
      status: 'recovery',
      reason: 'open_failed',
      databasePath: path.resolve(paths.databasePath),
      backupPath: null,
      diagnostics: ['open.failed', 'readonly_reopen.failed'],
    })
    assert.deepEqual(dbService.getDatabaseHealth(), {
      status: 'recovery', readOnly: false, reason: 'open_failed', diagnostics: ['open.failed', 'readonly_reopen.failed'],
    })
  })

  it('kills wrong error mapping by returning exact recovery reasons for each startup boundary', async() => {
    const cases = [
      ['migration_failed', { getPendingMigrations: () => { throw new Error('checksum drift secret') } }],
      ['migration_failed', {
        getPendingMigrations: () => [{ version: 3 }],
        getSchemaVersion: () => 2,
        runMigrations: () => { throw new Error('migration payload secret') },
      }],
    ]
    const actualMigrate = require('../../src/main/worker/dbService/migrate.ts')
    for (const [reason, overrides] of cases) {
      const paths = makePaths(`lx-recovery-map-${reason}-`)
      const dbService = loadDbServiceWithBoundaries({ migrateModule: { ...actualMigrate, ...overrides } })
      const result = await dbService.init(initOptions(paths))
      assert.equal(result.reason, reason)
      assert.equal(JSON.stringify(result).includes('secret'), false)
      dbService.close()
    }
  })

  it('kills trusted-ledger drift by mapping real migration name/checksum mismatches to recovery', async() => {
    for (const mutation of [
      "UPDATE schema_migrations SET name = 'changed_name' WHERE version = 3",
      "UPDATE schema_migrations SET checksum = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE version = 3",
    ]) {
      const paths = makePaths('lx-recovery-ledger-drift-')
      const existing = createV3Database(paths.databasePath)
      existing.exec(mutation)
      existing.close()
      const dbService = loadDbServiceWithBoundaries()

      const result = await dbService.init(initOptions(paths))

      assert.equal(result.reason, 'migration_failed')
      assert.equal(result.backupPath, null)
      assert.deepEqual(result.diagnostics, ['migration.plan_failed'])
      dbService.close()
    }
  })

  it('kills collapsed verification mapping by preserving schema/quick/FK exact reasons', async() => {
    for (const reason of ['schema_invalid', 'quick_check_failed', 'foreign_key_check_failed']) {
      const paths = makePaths(`lx-recovery-verify-${reason}-`)
      const existing = createV3Database(paths.databasePath)
      existing.close()
      const dbService = loadDbServiceWithBoundaries({
        verifyModule: {
          verifyDatabase: () => ({ ok: false, reason, diagnostics: [`${reason}.stable`] }),
        },
      })
      const result = await dbService.init({ ...initOptions(paths), previousShutdownWasClean: false })
      assert.equal(result.reason, reason)
      assert.deepEqual(result.diagnostics.slice(0, 1), [`${reason}.stable`])
      dbService.close()
    }
  })

  it('kills thrown-verifier escapes by closing write and returning schema recovery', async() => {
    const paths = makePaths('lx-recovery-verifier-throw-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const dbService = loadDbServiceWithBoundaries({
      verifyModule: { verifyDatabase: () => { throw new Error('secret verifier failure') } },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.reason, 'schema_invalid')
    assert.deepEqual(result.diagnostics, ['schema.verify_failed'])
    assert.equal(JSON.stringify(result).includes('secret'), false)
    assert.throws(() => dbService.getAppDB(), /database_not_ready/)
  })

  it('kills backup collision overwrites by selecting the first unused counter', async() => {
    const paths = makePaths('lx-recovery-collision-')
    fs.mkdirSync(paths.backupDir, { recursive: true })
    const originalNow = Date.now
    Date.now = () => 1234
    const occupied = path.join(paths.backupDir, 'lx.data.db.pre-migration-v2-to-v3.1234-0.backup')
    fs.writeFileSync(occupied, 'existing verified artifact')
    try {
      const dbService = loadDbServiceWithBoundaries()
      const result = await dbService.init(initOptions(paths))
      assert.equal(result.backupPath, path.join(path.resolve(paths.backupDir), 'lx.data.db.pre-migration-v2-to-v3.1234-1.backup'))
      assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing verified artifact')
    } finally {
      Date.now = originalNow
    }
  })

  it('kills data-path traversal by rejecting a resolved database candidate outside its root', async() => {
    const paths = makePaths('lx-recovery-data-containment-')
    const escaped = path.join(paths.root, 'escaped-data.db')
    const pathModule = {
      ...path,
      resolve: (...segments) => segments.at(-1) == 'lx.data.db' ? escaped : path.resolve(...segments),
    }
    const dbService = loadDbServiceWithBoundaries({ pathModule })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(result.diagnostics, ['open.path_invalid', 'readonly_reopen.failed'])
    assert.equal(fs.existsSync(escaped), false)
  })

  it('kills backup-path traversal by rejecting a resolved candidate outside backupDir', async() => {
    const paths = makePaths('lx-recovery-backup-containment-')
    const escaped = path.join(paths.root, 'escaped-backup.db')
    const pathModule = {
      ...path,
      resolve: (...segments) => typeof segments.at(-1) == 'string' && segments.at(-1).endsWith('.backup')
        ? escaped
        : path.resolve(...segments),
    }
    const dbService = loadDbServiceWithBoundaries({ pathModule })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.reason, 'backup_failed')
    assert.equal(result.backupPath, null)
    assert.equal(fs.existsSync(escaped), false)
  })

  it('kills stale connection leaks by making close idempotent and health closed', async() => {
    const paths = makePaths('lx-recovery-close-')
    const dbService = loadDbServiceWithBoundaries()
    const result = await dbService.init(initOptions(paths))
    assert.equal(result.status, 'ready')

    dbService.close()
    dbService.close()

    assert.deepEqual(dbService.getDatabaseHealth(), { status: 'closed' })
    assert.throws(() => dbService.getAppDB(), error => error.message == 'database_not_ready' && error.code == 'database_not_ready')
  })
})

describe('transitional worker startup adapter', () => {
  it('kills destructive null recovery mapping by throwing a fixed error for legacy callers', async() => {
    const calls = []
    const { initForWorker } = loadWorkerAdapterWithInit(async options => {
      calls.push(options)
      return {
        status: 'recovery',
        reason: 'schema_invalid',
        databasePath: 'secret-path',
        backupPath: null,
        diagnostics: ['schema.table_missing:secret'],
      }
    })

    await assert.rejects(initForWorker('C:\\profiles\\alice'), error => error.message == 'database_recovery_required')

    assert.deepEqual(calls, [{
      dataPath: 'C:\\profiles\\alice',
      backupDir: path.join('C:\\profiles\\alice', 'backups'),
      previousShutdownWasClean: false,
    }])
  })

  it('kills startup-result leakage by mapping legacy ready to the old existed boolean only', async() => {
    const { initForWorker } = loadWorkerAdapterWithInit(async() => ({
      status: 'ready', existed: true, schemaVersion: 3, migratedVersions: [], backupPath: null,
    }))

    assert.equal(await initForWorker('C:\\profiles\\alice'), true)
  })
})
