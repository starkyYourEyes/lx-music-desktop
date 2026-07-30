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
      indexes: [{ name: 'parent_code_unique', columns: ['code'], unique: true, partial: false }],
      foreignKeys: [],
    },
    {
      name: 'child',
      columns: [
        { name: 'id', type: 'INTEGER', notNull: false, primaryKeyPosition: 1 },
        { name: 'parent_code', type: 'TEXT', notNull: true, primaryKeyPosition: 0 },
      ],
      indexes: [{ name: 'child_parent_code', columns: ['parent_code'], unique: false, partial: false }],
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

const createDatabaseSymlinkOrSkip = (testContext, {
  target,
  link,
  dangling,
  contents,
}) => {
  if (!dangling) fs.writeFileSync(target, contents)
  try {
    fs.symlinkSync(target, link, 'file')
    return { targetArtifact: target }
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code) || process.platform != 'win32') throw error
    try {
      fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(target, { recursive: true })
      const targetArtifact = path.join(target, 'sentinel')
      if (!dangling) fs.writeFileSync(targetArtifact, contents)
      fs.symlinkSync(target, link, 'junction')
      if (dangling) fs.rmSync(target, { recursive: true, force: true })
      return { targetArtifact }
    } catch (junctionError) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(junctionError?.code)) {
        testContext.skip(`Filesystem links are unavailable on ${process.platform}: ${junctionError.code}`)
        return null
      }
      throw junctionError
    }
  }
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

const loadRealWorkerAdapter = () => {
  const indexPath = require.resolve('../../src/main/worker/dbService/index.ts')
  clearDbServiceCache()
  delete require.cache[indexPath]
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
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

  it('kills check-then-write races by atomically reserving one concurrent destination owner', async() => {
    const root = tempDir('lx-recovery-atomic-backup-')
    const destination = path.join(root, 'backup.db')
    const db = openTracked(':memory:')
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)')
    const actualBackup = db.backup.bind(db)
    let backupCalls = 0
    let releaseBarrier
    const bothReachedBackup = new Promise(resolve => { releaseBarrier = resolve })
    const coordinatedDb = new Proxy(db, {
      get(target, property) {
        if (property != 'backup') {
          const value = Reflect.get(target, property)
          return typeof value == 'function' ? value.bind(target) : value
        }
        return async(targetPath) => {
          backupCalls++
          if (backupCalls == 2) releaseBarrier()
          await Promise.race([bothReachedBackup, new Promise(resolve => setTimeout(resolve, 50))])
          return actualBackup(targetPath)
        }
      },
    })
    const { createOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')

    const results = await Promise.allSettled([
      createOnlineBackup(coordinatedDb, destination),
      createOnlineBackup(coordinatedDb, destination),
    ])

    assert.equal(backupCalls, 1)
    assert.equal(results.filter(result => result.status == 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status == 'rejected').length, 1)
    const restored = openTracked(destination, { readonly: true, fileMustExist: true })
    assert.equal(restored.prepare('SELECT count(*) count FROM items').get().count, 1)
    assert.equal(restored.pragma('quick_check', { simple: true }), 'ok')
  })

  it('kills unverified-backup implementations by rejecting an invalid backup candidate', async() => {
    const root = tempDir('lx-recovery-invalid-backup-')
    const destination = path.join(root, 'backup.db')
    const fakeDb = { backup: async target => fs.writeFileSync(target, 'not sqlite') }
    const { createOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')

    await assert.rejects(createOnlineBackup(fakeDb, destination))

    assert.equal(fs.readFileSync(destination, 'utf8'), 'not sqlite')
  })

  it('uses the packaged native binding when verifying an online backup', async() => {
    const root = tempDir('lx-recovery-packaged-binding-')
    const source = path.join(root, 'source.db')
    const destination = path.join(root, 'backup.db')
    const expectedNativeBinding = require.resolve('better-sqlite3/build/Release/better_sqlite3.node')
    const db = openTracked(source)
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)')
    const backupPath = require.resolve('../../src/main/worker/dbService/databaseBackup.ts')
    delete require.cache[backupPath]
    const originalLoad = Module._load
    class PackagedBindingDatabase {
      constructor(filename, options) {
        if (!options?.readonly || !options.fileMustExist) {
          throw new Error('backup_verification_must_be_readonly')
        }
        if (options?.readonly && options.nativeBinding != expectedNativeBinding) {
          throw new Error('packaged_default_binding_lookup_failed')
        }
        return new Database(filename, options)
      }
    }
    Module._load = function(request, parent, isMain) {
      if (request == 'better-sqlite3') return PackagedBindingDatabase
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      const { createOnlineBackup } = require(backupPath)

      await createOnlineBackup(db, destination, {
        nativeBinding: expectedNativeBinding,
        readonly: false,
        fileMustExist: false,
      })
    } finally {
      Module._load = originalLoad
      delete require.cache[backupPath]
    }

    const restored = openTracked(destination, { readonly: true, fileMustExist: true })
    assert.equal(restored.pragma('quick_check', { simple: true }), 'ok')
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

  it('kills partial/expression index substitution by requiring complete column indexes', () => {
    const { verifyDatabaseAgainstContract } = require('../../src/main/worker/dbService/verifyDB.ts')
    const cases = [
      validSyntheticSql.replace(
        'CREATE UNIQUE INDEX parent_code_unique ON parent(code);',
        "CREATE UNIQUE INDEX parent_code_unique ON parent(code) WHERE code <> '';",
      ),
      validSyntheticSql.replace(
        'CREATE UNIQUE INDEX parent_code_unique ON parent(code);',
        'CREATE UNIQUE INDEX parent_code_unique ON parent(lower(code));',
      ),
    ]

    for (const sql of cases) {
      assert.deepEqual(verifyDatabaseAgainstContract(createSynthetic(sql), SYNTHETIC_CONTRACT, {
        runQuickCheck: false,
        runForeignKeyCheck: false,
      }), {
        ok: false,
        reason: 'schema_invalid',
        diagnostics: ['schema.index_invalid:parent.parent_code_unique'],
      })
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
  it('kills fresh writes before authoritative pragmas by configuring FK and WAL before baseline DDL', async() => {
    const paths = makePaths('lx-recovery-fresh-order-')
    const events = []
    class OrderedDatabase {
      constructor(...args) {
        const real = new Database(...args)
        events.push('open')
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'pragma') {
              return (statement, options) => {
                if (statement == 'foreign_keys = ON') events.push('foreign_keys')
                if (statement == 'journal_mode = WAL') events.push('wal')
                return target.pragma(statement, options)
              }
            }
            if (property == 'exec') {
              return (sql) => {
                if (sql.includes('CREATE TABLE "db_info"')) events.push('baseline_write')
                return target.exec(sql)
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: OrderedDatabase })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'ready')
    assert.deepEqual(events.slice(0, 4), ['open', 'foreign_keys', 'wal', 'baseline_write'])
  })

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

  it('passes the startup packaged binding into read-only backup verification', async() => {
    const paths = makePaths('lx-recovery-startup-packaged-binding-')
    const installedNativeBinding = require.resolve('better-sqlite3/build/Release/better_sqlite3.node')
    const bindingSuffix = path.join('better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
    const verificationOpens = []
    let expectedNativeBinding
    class PackagedBindingDatabase {
      constructor(filename, options) {
        if (!options?.readonly) {
          if (typeof options?.nativeBinding != 'string') throw new Error('startup_native_binding_missing')
          expectedNativeBinding = options.nativeBinding
        } else {
          verificationOpens.push(options)
          if (options.nativeBinding != expectedNativeBinding) {
            throw new Error('packaged_default_binding_lookup_failed')
          }
          if (!options.fileMustExist) throw new Error('backup_verification_must_be_readonly')
        }
        return new Database(filename, options?.nativeBinding == null
          ? options
          : { ...options, nativeBinding: installedNativeBinding })
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: PackagedBindingDatabase,
      fileSystem: {
        ...fs,
        statSync: filename => String(filename).endsWith(bindingSuffix)
          ? fs.statSync(installedNativeBinding)
          : fs.statSync(filename),
      },
    })

    try {
      const result = await dbService.init(initOptions(paths))

      assert.deepEqual({
        status: result.status,
        reason: result.status == 'recovery' ? result.reason : null,
      }, { status: 'ready', reason: null })
      assert.deepEqual(verificationOpens, [{
        nativeBinding: expectedNativeBinding,
        readonly: true,
        fileMustExist: true,
      }])
    } finally {
      dbService.close()
      clearDbServiceCache()
    }
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

  it('runs both integrity checks after an unclean startup without pending migrations', async() => {
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
    assert.deepEqual(calls, [{ runQuickCheck: true, runForeignKeyCheck: true }])
  })

  for (const recoveryReason of ['quick_check_failed', 'foreign_key_check_failed']) {
    it(`restarts ${recoveryReason} recovery with both integrity checks before ready`, async() => {
      const paths = makePaths(`lx-recovery-restart-${recoveryReason}-`)
      const runtimeRoot = path.join(paths.root, 'runtime')
      const existing = createV3Database(paths.databasePath)
      existing.close()
      const { createRunState } = require('../../src/main/startup/runState.ts')
      const { createStorageCoordinator } = require('../../src/main/startup/storageCoordinator.ts')
      const createCoordinatorFor = (dbService, previousCleanValues) => createStorageCoordinator({
        runState: createRunState({ runtimeRoot }),
        initDatabase: previousShutdownWasClean => {
          previousCleanValues.push(previousShutdownWasClean)
          return dbService.init({ ...initOptions(paths), previousShutdownWasClean })
        },
        closeDatabase: () => dbService.close(),
        runMigrationHooks: async() => undefined,
        initSettings: async() => {},
        registerModules: () => {},
        appInited: () => {},
        showRecovery: async() => {},
        flushStores: async() => {},
      })
      const firstPreviousCleanValues = []
      const firstDbService = loadDbServiceWithBoundaries({
        verifyModule: {
          verifyDatabase: () => ({
            ok: false,
            reason: recoveryReason,
            diagnostics: [`${recoveryReason}.stable`],
          }),
        },
      })
      const firstCoordinator = createCoordinatorFor(firstDbService, firstPreviousCleanValues)

      assert.equal((await firstCoordinator.start()).status, 'recovery')
      await firstCoordinator.shutdown()
      const cleanMarkerBeforeRestart = JSON.parse(
        fs.readFileSync(path.join(runtimeRoot, 'run-state.v1.json'), 'utf8'),
      ).clean

      const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
      const verificationOptions = []
      const secondDbService = loadDbServiceWithBoundaries({
        verifyModule: {
          ...actualVerify,
          verifyDatabase: (db, options) => {
            verificationOptions.push(options)
            return actualVerify.verifyDatabase(db, options)
          },
        },
      })
      const secondPreviousCleanValues = []
      const secondCoordinator = createCoordinatorFor(secondDbService, secondPreviousCleanValues)

      assert.equal((await secondCoordinator.start()).status, 'ready')
      assert.deepEqual({
        cleanMarkerBeforeRestart,
        firstPreviousCleanValues,
        secondPreviousCleanValues,
        verificationOptions,
      }, {
        cleanMarkerBeforeRestart: false,
        firstPreviousCleanValues: [false],
        secondPreviousCleanValues: [false],
        verificationOptions: [{ runQuickCheck: true, runForeignKeyCheck: true }],
      })
    })
  }

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

  it('enables and verifies foreign keys before exposing a read-only recovery connection', async() => {
    const paths = makePaths('lx-recovery-readonly-fk-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const readonlyPragmas = []
    class TrackingDatabase {
      constructor(filename, options) {
        const real = new Database(filename, options)
        if (!options?.readonly) return real
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'pragma') {
              return (statement, pragmaOptions) => {
                readonlyPragmas.push(statement)
                return target.pragma(statement, pragmaOptions)
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: TrackingDatabase,
      verifyModule: {
        verifyDatabase: () => ({
          ok: false,
          reason: 'quick_check_failed',
          diagnostics: ['quick_check.failed'],
        }),
      },
    })

    const result = await dbService.init({ ...initOptions(paths), previousShutdownWasClean: false })

    assert.equal(result.status, 'recovery')
    assert.equal(dbService.getDatabaseHealth().readOnly, true)
    assert.deepEqual(readonlyPragmas, ['foreign_keys = ON', 'foreign_keys', 'schema_version'])
  })

  it('rejects a recovery connection when foreign-key enforcement cannot be verified', async() => {
    const paths = makePaths('lx-recovery-readonly-fk-disabled-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const readonlyPragmas = []
    class DisabledForeignKeysDatabase {
      constructor(filename, options) {
        const real = new Database(filename, options)
        if (!options?.readonly) return real
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'pragma') {
              return (statement, pragmaOptions) => {
                readonlyPragmas.push(statement)
                if (statement == 'foreign_keys' && pragmaOptions?.simple) return 0
                return target.pragma(statement, pragmaOptions)
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: DisabledForeignKeysDatabase,
      verifyModule: {
        verifyDatabase: () => ({
          ok: false,
          reason: 'quick_check_failed',
          diagnostics: ['quick_check.failed'],
        }),
      },
    })

    const result = await dbService.init({ ...initOptions(paths), previousShutdownWasClean: false })

    assert.deepEqual(result.diagnostics, ['quick_check.failed', 'readonly_reopen.failed'])
    assert.deepEqual(dbService.getDatabaseHealth(), {
      status: 'recovery',
      readOnly: false,
      reason: 'quick_check_failed',
      diagnostics: ['quick_check.failed', 'readonly_reopen.failed'],
    })
    assert.deepEqual(readonlyPragmas, ['foreign_keys = ON', 'foreign_keys'])
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
    assert.deepEqual(result.diagnostics, ['open.path_invalid'])
    assert.equal(fs.existsSync(escaped), false)
  })

  it('rejects a dangling authoritative database symlink without opening or following it', async(t) => {
    const paths = makePaths('lx-recovery-dangling-symlink-')
    const danglingTarget = path.join(paths.root, 'missing-external.db')
    if (createDatabaseSymlinkOrSkip(t, {
      target: danglingTarget,
      link: paths.databasePath,
      dangling: true,
    }) == null) return
    let openCalls = 0
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: TrackingDatabase })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(result.diagnostics, ['open.target_symlink'])
    assert.equal(openCalls, 0)
    assert.equal(fs.existsSync(danglingTarget), false)
    assert.equal(fs.lstatSync(paths.databasePath).isSymbolicLink(), true)
  })

  it('rejects an external-target database symlink without opening or modifying its target', async(t) => {
    const paths = makePaths('lx-recovery-external-symlink-')
    const externalTarget = path.join(paths.root, 'external.db')
    const link = createDatabaseSymlinkOrSkip(t, {
      target: externalTarget,
      link: paths.databasePath,
      dangling: false,
      contents: 'EXTERNAL_DATABASE_SECRET_4D18',
    })
    if (link == null) return
    const before = fs.readFileSync(link.targetArtifact)
    let openCalls = 0
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: TrackingDatabase })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'recovery')
    assert.deepEqual(result.diagnostics, ['open.target_symlink'])
    assert.equal(openCalls, 0)
    assert.deepEqual(fs.readFileSync(link.targetArtifact), before)
  })

  it('rejects a non-regular authoritative database target without opening it', async() => {
    const paths = makePaths('lx-recovery-directory-target-')
    fs.mkdirSync(paths.databasePath)
    let openCalls = 0
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: TrackingDatabase })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'recovery')
    assert.deepEqual(result.diagnostics, ['open.target_not_regular'])
    assert.equal(openCalls, 0)
    assert.equal(fs.lstatSync(paths.databasePath).isDirectory(), true)
  })

  it('returns sanitized recovery when another creator wins the missing-target reservation race', async() => {
    const paths = makePaths('lx-recovery-create-race-')
    const competingBytes = 'RACING_DATABASE_SECRET_681B'
    let raceInjected = false
    const racingFileSystem = {
      ...fs,
      openSync(filePath, flags, mode) {
        if (path.resolve(filePath) == path.resolve(paths.databasePath) && flags == 'wx' && !raceInjected) {
          raceInjected = true
          fs.writeFileSync(paths.databasePath, competingBytes)
        }
        return fs.openSync(filePath, flags, mode)
      },
    }
    let openCalls = 0
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: TrackingDatabase,
      fileSystem: racingFileSystem,
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(raceInjected, true)
    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(result.diagnostics, ['open.reserve_conflict'])
    assert.equal(openCalls, 0)
    assert.equal(fs.readFileSync(paths.databasePath, 'utf8'), competingBytes)
    assert.equal(JSON.stringify(result).includes(competingBytes), false)
  })

  it('rejects an external target identity swapped at the SQLite open boundary without configuring it', async() => {
    const paths = makePaths('lx-recovery-open-swap-')
    const originalPath = path.join(paths.root, 'original.db')
    const externalPath = path.join(paths.root, 'external.db')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const external = createV3Database(externalPath)
    external.close()
    const externalBefore = fs.readFileSync(externalPath)
    let swapped = false
    const pragmaCalls = []
    class OpenBoundarySwapDatabase {
      constructor(filename, options) {
        if (!options?.readonly && path.resolve(filename) == path.resolve(paths.databasePath) && !swapped) {
          fs.renameSync(paths.databasePath, originalPath)
          fs.linkSync(externalPath, paths.databasePath)
          swapped = true
        }
        const real = new Database(filename, options)
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'pragma') {
              return (...args) => {
                pragmaCalls.push(args[0])
                return target.pragma(...args)
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: OpenBoundarySwapDatabase })

    const result = await dbService.init(initOptions(paths))

    assert.equal(swapped, true)
    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'open_failed')
    assert.deepEqual(result.diagnostics, ['open.target_changed'])
    assert.deepEqual(pragmaCalls, [])
    assert.deepEqual(fs.readFileSync(externalPath), externalBefore)
    assert.equal(fs.lstatSync(paths.databasePath).isFile(), true)
    assert.equal(fs.statSync(paths.databasePath).ino, fs.statSync(externalPath).ino)
    assert.equal(fs.existsSync(originalPath), true)
  })

  it('rejects a recovery target swapped during writable close before read-only reopen', async() => {
    const paths = makePaths('lx-recovery-close-swap-')
    const originalPath = path.join(paths.root, 'original.db')
    const externalPath = path.join(paths.root, 'external.db')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const external = createV3Database(externalPath)
    external.close()
    const externalBefore = fs.readFileSync(externalPath)
    let swapped = false
    let readonlyOpenCalls = 0
    class CloseBoundarySwapDatabase {
      constructor(filename, options) {
        if (options?.readonly) readonlyOpenCalls++
        const real = new Database(filename, options)
        if (options?.readonly) return real
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'close') {
              return () => {
                target.close()
                if (swapped) return
                fs.renameSync(paths.databasePath, originalPath)
                fs.linkSync(externalPath, paths.databasePath)
                swapped = true
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: CloseBoundarySwapDatabase,
      verifyModule: {
        verifyDatabase: () => ({
          ok: false,
          reason: 'quick_check_failed',
          diagnostics: ['quick_check.failed'],
        }),
      },
    })

    try {
      const result = await dbService.init({ ...initOptions(paths), previousShutdownWasClean: false })

      assert.equal(swapped, true)
      assert.deepEqual(result, {
        status: 'recovery',
        reason: 'quick_check_failed',
        databasePath: path.resolve(paths.databasePath),
        backupPath: null,
        diagnostics: ['quick_check.failed', 'readonly_reopen.failed'],
      })
      assert.deepEqual(dbService.getDatabaseHealth(), {
        status: 'recovery',
        readOnly: false,
        reason: 'quick_check_failed',
        diagnostics: ['quick_check.failed', 'readonly_reopen.failed'],
      })
      assert.equal(readonlyOpenCalls, 0)
      assert.deepEqual(fs.readFileSync(externalPath), externalBefore)
      assert.equal(fs.statSync(paths.databasePath).ino, fs.statSync(externalPath).ino)
      assert.equal(fs.existsSync(originalPath), true)
    } finally {
      dbService.close()
    }
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

  it('propagates a writable close failure through shutdown and leaves the run unclean', async() => {
    const paths = makePaths('lx-recovery-close-failure-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const closeError = new Error('native-close-secret-91C7')
    let closeCalls = 0
    class CloseOnceDatabase {
      constructor(filename, options) {
        const real = new Database(filename, options)
        if (options?.readonly) return real
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'close') {
              return () => {
                closeCalls++
                if (closeCalls == 1) throw closeError
                return target.close()
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: CloseOnceDatabase })
    let markedClean = false
    const { createStorageCoordinator } = require('../../src/main/startup/storageCoordinator.ts')
    const coordinator = createStorageCoordinator({
      runState: {
        begin: async() => true,
        markClean: async() => { markedClean = true },
      },
      initDatabase: () => dbService.init(initOptions(paths)),
      closeDatabase: () => dbService.close(),
      runMigrationHooks: async() => undefined,
      initSettings: async() => {},
      registerModules: () => {},
      appInited: () => {},
      showRecovery: async() => {},
      flushStores: async() => {},
    })

    assert.equal((await coordinator.start()).status, 'ready')
    await assert.rejects(coordinator.shutdown(), error => error === closeError)
    assert.equal(markedClean, false)
    assert.equal(dbService.getDatabaseHealth().status, 'ready')
    dbService.close()
    assert.equal(closeCalls, 2)
    assert.deepEqual(dbService.getDatabaseHealth(), { status: 'closed' })
  })

  it('does not reopen read-only when the recovery write connection cannot close', async() => {
    const paths = makePaths('lx-recovery-write-close-failure-')
    const existing = createV3Database(paths.databasePath)
    existing.close()
    const closeSecret = 'recovery-native-close-secret-D320'
    let writeCloseCalls = 0
    let readonlyOpenCalls = 0
    class RecoveryCloseFaultDatabase {
      constructor(filename, options) {
        const real = new Database(filename, options)
        if (options?.readonly) {
          readonlyOpenCalls++
          return real
        }
        return new Proxy(real, {
          get(target, property) {
            const value = Reflect.get(target, property)
            if (property == 'close') {
              return () => {
                writeCloseCalls++
                if (writeCloseCalls == 1) throw new Error(closeSecret)
                return target.close()
              }
            }
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: RecoveryCloseFaultDatabase,
      verifyModule: {
        verifyDatabase: () => ({
          ok: false,
          reason: 'quick_check_failed',
          diagnostics: ['quick_check.failed'],
        }),
      },
    })

    const result = await dbService.init({ ...initOptions(paths), previousShutdownWasClean: false })

    assert.deepEqual(result, {
      status: 'recovery',
      reason: 'quick_check_failed',
      databasePath: path.resolve(paths.databasePath),
      backupPath: null,
      diagnostics: ['quick_check.failed', 'write_close.failed'],
    })
    assert.deepEqual(dbService.getDatabaseHealth(), {
      status: 'recovery',
      readOnly: false,
      reason: 'quick_check_failed',
      diagnostics: ['quick_check.failed', 'write_close.failed'],
    })
    assert.equal(readonlyOpenCalls, 0)
    assert.equal(JSON.stringify(result).includes(closeSecret), false)
    dbService.close()
    assert.equal(writeCloseCalls, 2)
  })

  it('kills duplicate same-key initialization by sharing backup work and cloning cached results', async() => {
    const paths = makePaths('lx-recovery-init-reuse-')
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    let openCalls = 0
    let backupCalls = 0
    let releaseBackup
    let signalBackupStarted
    const backupStarted = new Promise(resolve => { signalBackupStarted = resolve })
    const backupBarrier = new Promise(resolve => { releaseBackup = resolve })
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: TrackingDatabase,
      backupModule: {
        createOnlineBackup: async(...args) => {
          backupCalls++
          signalBackupStarted()
          await backupBarrier
          return actualBackup.createOnlineBackup(...args)
        },
      },
    })
    const firstPromise = dbService.init(initOptions(paths))
    await backupStarted
    const secondPromise = dbService.init({
      dataPath: path.join(paths.dataPath, '.'),
      backupDir: path.join(paths.backupDir, 'nested', '..'),
      previousShutdownWasClean: true,
    })
    await new Promise(resolve => setImmediate(resolve))
    releaseBackup()

    const [first, second] = await Promise.all([firstPromise, secondPromise])

    assert.equal(first.status, 'ready')
    assert.deepEqual(second, first)
    assert.notEqual(second, first)
    assert.equal(openCalls, 1)
    assert.equal(backupCalls, 1)
    const stableHandle = dbService.getAppDB()
    first.migratedVersions.push(99)
    const third = await dbService.init(initOptions(paths))
    assert.deepEqual(third.migratedVersions, [3])
    assert.equal(dbService.getAppDB(), stableHandle)
    assert.equal(openCalls, 1)
    assert.equal(backupCalls, 1)
  })

  it('kills profile replacement by rejecting different keys while active and initialized', async() => {
    const firstPaths = makePaths('lx-recovery-init-conflict-a-')
    const secondPaths = makePaths('lx-recovery-init-conflict-b-')
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    let releaseBackup
    let signalBackupStarted
    const backupStarted = new Promise(resolve => { signalBackupStarted = resolve })
    const backupBarrier = new Promise(resolve => { releaseBackup = resolve })
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        createOnlineBackup: async(...args) => {
          signalBackupStarted()
          await backupBarrier
          return actualBackup.createOnlineBackup(...args)
        },
      },
    })
    const firstPromise = dbService.init(initOptions(firstPaths))
    await backupStarted
    const activeConflict = dbService.init(initOptions(secondPaths))
    setTimeout(releaseBackup, 50)

    await assert.rejects(activeConflict, error =>
      error.message == 'database_initialization_conflict' && error.code == 'database_initialization_conflict')
    const first = await firstPromise
    assert.equal(first.status, 'ready')
    const stableHandle = dbService.getAppDB()
    await assert.rejects(dbService.init(initOptions(secondPaths)), error =>
      error.message == 'database_initialization_conflict' && error.code == 'database_initialization_conflict')
    assert.equal(dbService.getAppDB(), stableHandle)
    assert.equal(fs.existsSync(secondPaths.databasePath), false)
  })

  it('kills repeated recovery reopen by caching cloned same-key recovery results', async() => {
    const paths = makePaths('lx-recovery-init-recovery-cache-')
    fs.writeFileSync(paths.databasePath, 'not sqlite')
    let openCalls = 0
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({ DatabaseImplementation: TrackingDatabase })

    const first = await dbService.init(initOptions(paths))
    first.diagnostics.push('caller mutation')
    const second = await dbService.init(initOptions(paths))

    assert.equal(first.status, 'recovery')
    assert.equal(second.status, 'recovery')
    assert.notEqual(second, first)
    assert.deepEqual(second.diagnostics, ['open.failed', 'readonly_reopen.failed'])
    assert.equal(openCalls, 2)
  })

  it('kills permanent initialization locks by allowing a new profile only after close', async() => {
    const firstPaths = makePaths('lx-recovery-init-close-a-')
    const secondPaths = makePaths('lx-recovery-init-close-b-')
    const dbService = loadDbServiceWithBoundaries()
    assert.equal((await dbService.init(initOptions(firstPaths))).status, 'ready')

    dbService.close()

    assert.equal((await dbService.init(initOptions(secondPaths))).status, 'ready')
    assert.equal(fs.existsSync(secondPaths.databasePath), true)
  })

  it('kills orphaned initializing writers by invalidating an active attempt on close', async() => {
    const firstPaths = makePaths('lx-recovery-init-cancel-a-')
    const secondPaths = makePaths('lx-recovery-init-cancel-b-')
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    let releaseBackup
    let signalBackupStarted
    const backupStarted = new Promise(resolve => { signalBackupStarted = resolve })
    const backupBarrier = new Promise(resolve => { releaseBackup = resolve })
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        createOnlineBackup: async(...args) => {
          signalBackupStarted()
          await backupBarrier
          return actualBackup.createOnlineBackup(...args)
        },
      },
    })
    const cancelled = dbService.init(initOptions(firstPaths))
    await backupStarted

    dbService.close()
    const replacement = dbService.init(initOptions(secondPaths))
    await new Promise(resolve => setImmediate(resolve))
    releaseBackup()

    await assert.rejects(cancelled, error =>
      error.message == 'database_initialization_cancelled' && error.code == 'database_initialization_cancelled')
    assert.equal((await replacement).status, 'ready')
    assert.equal(dbService.getDatabaseHealth().status, 'ready')
    assert.equal(dbService.getAppDB().open, true)
  })
})

describe('worker startup API', () => {
  it('keeps recovery results available to direct object callers', async() => {
    const calls = []
    const { init } = loadWorkerAdapterWithInit(async options => {
      calls.push(options)
      return {
        status: 'recovery',
        reason: 'schema_invalid',
        databasePath: 'secret-path',
        backupPath: null,
        diagnostics: ['schema.table_missing:secret'],
      }
    })
    const options = {
      dataPath: 'C:\\profiles\\alice',
      backupDir: path.join('C:\\profiles\\alice', 'backups'),
      previousShutdownWasClean: false,
    }

    assert.deepEqual(await init(options), {
      status: 'recovery',
      reason: 'schema_invalid',
      databasePath: 'secret-path',
      backupPath: null,
      diagnostics: ['schema.table_missing:secret'],
    })
    assert.deepEqual(calls, [options])
  })

  it('returns ready startup metadata to direct object callers', async() => {
    const { init } = loadWorkerAdapterWithInit(async() => ({
      status: 'ready', existed: true, schemaVersion: 3, migratedVersions: [], backupPath: null,
    }))

    assert.deepEqual(await init({
      dataPath: 'C:\\profiles\\alice',
      backupDir: path.join('C:\\profiles\\alice', 'backups'),
      previousShutdownWasClean: true,
    }), { status: 'ready', existed: true, schemaVersion: 3, migratedVersions: [], backupPath: null })
  })

  it('reuses the same real object startup result without reinitialization', async() => {
    const paths = makePaths('lx-recovery-adapter-reuse-')
    const { init } = loadRealWorkerAdapter()

    const first = await init(initOptions(paths))
    const handle = require('../../src/main/worker/dbService/db.ts').getAppDB()
    const second = await init({
      dataPath: path.join(paths.dataPath, '.'),
      backupDir: path.join(paths.backupDir, 'nested', '..'),
      previousShutdownWasClean: true,
    })

    assert.equal(first.status, 'ready')
    assert.equal(first.existed, false)
    assert.deepEqual(second, first)
    assert.equal(require('../../src/main/worker/dbService/db.ts').getAppDB(), handle)
    assert.equal(fs.readdirSync(paths.backupDir).filter(name => name.endsWith('.backup')).length, 1)
  })
})
