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
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const Database = require('better-sqlite3')
const { migrations } = require('../../src/main/worker/dbService/migrations/index.ts')
const { runMigrations } = require('../../src/main/worker/dbService/migrate.ts')
const tables = require('../../src/main/worker/dbService/tables.ts').default
const currentSchemaVersion = 6
const currentMigrationVersions = migrations
  .filter(migration => migration.version <= currentSchemaVersion)
  .map(migration => migration.version)
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')
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
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

const tempDir = prefix => {
  const fixture = createTestStorageRoot(prefix)
  tempDirs.push(fixture)
  return fixture.path
}

const backupArtifactNames = root => fs.readdirSync(root)
  .filter(name => name != '.lx-test-storage-root-owner')

const stageArtifactNames = root => backupArtifactNames(root)
  .filter(name => /^\.lx-backup-[0-9a-f]{32}\.stage$/.test(name))

const openTracked = (filename, options) => {
  const db = new Database(filename, options)
  databases.push(db)
  return db
}

const makePaths = prefix => {
  const root = tempDir(prefix)
  const dataPath = path.join(root, 'profile')
  const cacheRoot = path.join(root, 'cache')
  const backupsRoot = path.join(root, 'backups')
  fs.mkdirSync(dataPath, { recursive: true })
  return { root, dataPath, cacheRoot, backupsRoot, databasePath: path.join(dataPath, 'lx.data.db') }
}

const createDatabaseSymlinkOrSkip = (testContext, {
  target,
  link,
  dangling,
  contents,
}, fsApi = fs) => {
  const resolvedTarget = path.resolve(target)
  const resolvedLink = path.resolve(link)
  const fixtureRoot = path.dirname(path.dirname(resolvedLink))
  if (path.relative(fixtureRoot, path.dirname(resolvedTarget)) != '' || resolvedTarget == fixtureRoot) {
    throw new Error('Database link target must be a direct fixture child')
  }

  let targetIdentity = null
  if (!dangling) {
    fsApi.writeFileSync(resolvedTarget, contents)
    targetIdentity = fsApi.lstatSync(resolvedTarget, { bigint: true })
    if (targetIdentity.isSymbolicLink() || !targetIdentity.isFile()) {
      throw new Error('Database link target must be a regular file')
    }
  }
  try {
    fsApi.symlinkSync(resolvedTarget, resolvedLink, 'file')
    return { targetArtifact: resolvedTarget }
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error?.code) || process.platform != 'win32') throw error
    try {
      if (targetIdentity != null) {
        const current = fsApi.lstatSync(resolvedTarget, { bigint: true })
        if (current.isSymbolicLink() || !current.isFile() ||
          current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino) {
          throw new Error('Database link target ownership changed')
        }
        fsApi.unlinkSync(resolvedTarget)
      } else {
        assert.throws(() => fsApi.lstatSync(resolvedTarget), error => error?.code == 'ENOENT')
      }
      fsApi.mkdirSync(resolvedTarget)
      const directoryIdentity = fsApi.lstatSync(resolvedTarget, { bigint: true })
      if (directoryIdentity.isSymbolicLink() || !directoryIdentity.isDirectory()) {
        throw new Error('Database junction target must be a non-link directory')
      }
      const targetArtifact = path.join(resolvedTarget, 'sentinel')
      if (!dangling) fsApi.writeFileSync(targetArtifact, contents)
      fsApi.symlinkSync(resolvedTarget, resolvedLink, 'junction')
      if (dangling) {
        const current = fsApi.lstatSync(resolvedTarget, { bigint: true })
        if (current.isSymbolicLink() || !current.isDirectory() ||
          current.dev !== directoryIdentity.dev || current.ino !== directoryIdentity.ino) {
          throw new Error('Database junction target ownership changed')
        }
        fsApi.rmdirSync(resolvedTarget)
      }
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

const createCurrentDatabase = databasePath => {
  const db = createV3Database(databasePath)
  runMigrations(db, migrations, { targetSchemaVersion: currentSchemaVersion, now: () => 1000 })
  return db
}

const createV2Database = databasePath => {
  const db = openTracked(databasePath)
  db.exec(`
    ${Array.from(tables.values()).join('\n')}
    INSERT INTO db_info(field_name, field_value) VALUES ('version', '2');
  `)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  return db
}

const readSchemaVersion = databasePath => {
  const db = openTracked(databasePath, { readonly: true, fileMustExist: true })
  return Number(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value)
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

const loadBackupWithBoundaries = ({ fileSystem, directDirectoryModule, DatabaseImplementation } = {}) => {
  const backupPath = require.resolve('../../src/main/worker/dbService/databaseBackup.ts')
  delete require.cache[backupPath]
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (DatabaseImplementation && request == 'better-sqlite3') return DatabaseImplementation
    if (fileSystem && request == 'node:fs') return fileSystem
    if (directDirectoryModule && request == '../../storage/directDirectory') return directDirectoryModule
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(backupPath)
  } finally {
    Module._load = originalLoad
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
  cacheRoot: paths.cacheRoot,
  backupsRoot: paths.backupsRoot,
  previousShutdownWasClean: true,
  targetSchemaVersion: 6,
})

describe('guarded online backup', () => {
  const createGuardedBackup = ({ db, backupsRoot, basenamePrefix = 'lx.data.db.backup', sourceSchemaVersion = 2, verifier } = {}) => {
    const backup = require('../../src/main/worker/dbService/databaseBackup.ts')
    const reservation = backup.reserveOnlineBackup({ backupsRoot, basenamePrefix, sourceSchemaVersion })
    return backup.completeOnlineBackup(db, reservation, {}, verifier ?? (() => {}))
  }

  it('writes one unique standalone backup whose exact path is read-only SQLite', () => {
    const root = tempDir('lx-recovery-unique-backup-')
    const backupsRoot = path.join(root, 'backups')
    const db = createV2Database(path.join(root, 'source.db'))
    db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1)')
    const snapshot = db.serialize()
    assert.equal(snapshot[18], 2)
    assert.equal(snapshot[19], 2)

    const guard = createGuardedBackup({ db, backupsRoot })

    assert.match(guard.basename, /^lx\.data\.db\.backup\.[a-f0-9]{32}\.backup$/)
    assert.deepEqual(backupArtifactNames(backupsRoot), [guard.basename])
    assert.equal(fs.lstatSync(guard.path, { bigint: true }).nlink, 1n)
    const artifactBytes = fs.readFileSync(guard.path)
    assert.deepEqual([artifactBytes[18], artifactBytes[19]], [1, 1])
    assert.deepEqual(artifactBytes.subarray(0, 18), snapshot.subarray(0, 18))
    assert.deepEqual(artifactBytes.subarray(20), snapshot.subarray(20))
    assert.equal(guard.sha256, crypto.createHash('sha256').update(artifactBytes).digest('hex'))
    const restored = openTracked(guard.path, { readonly: true, fileMustExist: true })
    assert.equal(restored.pragma('quick_check', { simple: true }), 'ok')
    guard.close()
  })

  it('rejects mixed or invalid SQLite journal header versions without rewriting the attempt', () => {
    for (const versions of [[2, 1], [3, 3]]) {
      const root = tempDir(`lx-recovery-invalid-header-${versions.join('-')}-`)
      const backupsRoot = path.join(root, 'backups')
      const db = createV2Database(':memory:')
      const bytes = Buffer.from(db.serialize())
      bytes[18] = versions[0]
      bytes[19] = versions[1]
      const source = new Proxy(db, {
        get: (target, property) => property == 'serialize' ? () => Buffer.from(bytes) : Reflect.get(target, property),
      })
      const backup = require('../../src/main/worker/dbService/databaseBackup.ts')
      const reservation = backup.reserveOnlineBackup({
        backupsRoot,
        basenamePrefix: 'lx.data.db.backup',
        sourceSchemaVersion: 2,
      })

      assert.throws(() => backup.completeOnlineBackup(source, reservation, {}, () => {}))
      assert.deepEqual(backupArtifactNames(backupsRoot), [reservation.basename])
      assert.equal(fs.readFileSync(reservation.path).length, 0)
    }
  })

  it('retains one partial unique attempt on write or verification failure', () => {
    for (const failure of ['write', 'verification']) {
      const root = tempDir(`lx-recovery-partial-${failure}-`)
      const backupsRoot = path.join(root, 'backups')
      const db = createV2Database(':memory:')
      const backup = require('../../src/main/worker/dbService/databaseBackup.ts')
      const reservation = backup.reserveOnlineBackup({
        backupsRoot,
        basenamePrefix: 'lx.data.db.backup',
        sourceSchemaVersion: 2,
      })
      const source = failure == 'write'
        ? new Proxy(db, { get: (target, property) => property == 'serialize' ? () => 'not bytes' : Reflect.get(target, property) })
        : db

      assert.throws(
        () => backup.completeOnlineBackup(source, reservation, {}, () => {
          if (failure == 'verification') throw new Error('injected verification failure')
        }),
      )

      assert.deepEqual(backupArtifactNames(backupsRoot), [reservation.basename])
      assert.equal(fs.lstatSync(reservation.path, { bigint: true }).nlink, 1n)
      assert.throws(() => fs.fstatSync(reservation.descriptor), error => error?.code == 'EBADF')
      assert.throws(() => fs.fstatSync(reservation.root.descriptor), error => error?.code == 'EBADF')
    }
  })

  it('does not overwrite or choose an occupied artifact', () => {
    const root = tempDir('lx-recovery-occupied-backup-')
    const backupsRoot = path.join(root, 'backups')
    fs.mkdirSync(backupsRoot)
    const occupied = 'lx.data.db.backup.00000000000000000000000000000000.backup'
    fs.writeFileSync(path.join(backupsRoot, occupied), 'occupied')
    const db = createV2Database(':memory:')

    const guard = createGuardedBackup({ db, backupsRoot })

    assert.notEqual(guard.basename, occupied)
    assert.equal(fs.readFileSync(path.join(backupsRoot, occupied), 'utf8'), 'occupied')
    assert.deepEqual(backupArtifactNames(backupsRoot).sort(), [occupied, guard.basename].sort())
    guard.close()
  })

  it('rejects in-place mutation without deleting the changed artifact', () => {
    const root = tempDir('lx-recovery-in-place-backup-change-')
    const backupsRoot = path.join(root, 'backups')
    const db = createV2Database(':memory:')
    const guard = createGuardedBackup({ db, backupsRoot })
    const changedBytes = Buffer.alloc(guard.byteLength, 0x58)
    fs.writeFileSync(guard.path, changedBytes)

    assert.throws(() => guard.revalidate(), /backup_evidence_changed/)
    assert.deepEqual(fs.readFileSync(guard.path), changedBytes)
    guard.close()
  })

  it('rejects a generic or wrong-kind reservation at database completion', () => {
    const root = tempDir('lx-recovery-wrong-kind-')
    const backupsRoot = path.join(root, 'backups')
    fs.mkdirSync(backupsRoot)
    const { validateDirectDirectory, closeDirectDirectory } = require('../../src/main/storage/directDirectory.js')
    const { reserveExclusiveArtifact, closeArtifactReservation } = require('../../src/main/storage/exclusiveArtifact.js')
    const rootGuard = validateDirectDirectory(backupsRoot)
    const generic = reserveExclusiveArtifact(rootGuard, {
      prefix: 'not-a-database.',
      suffix: '.backup',
      artifactKind: 'test-v1',
    })
    const db = createV2Database(':memory:')
    const { completeOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')

    assert.throws(() => completeOnlineBackup(db, generic, {}, () => {}), /backup_reservation_invalid/)

    closeArtifactReservation(generic)
    closeDirectDirectory(rootGuard)
  })

  it('closes both artifact and owned root descriptors when an online reservation is abandoned', () => {
    const root = tempDir('lx-recovery-close-reservation-')
    const backup = require('../../src/main/worker/dbService/databaseBackup.ts')
    const reservation = backup.reserveOnlineBackup({
      backupsRoot: path.join(root, 'backups'),
      basenamePrefix: 'lx.data.db.backup',
      sourceSchemaVersion: 2,
    })

    backup.closeOnlineBackupReservation(reservation)

    assert.throws(() => fs.fstatSync(reservation.descriptor), error => error?.code == 'EBADF')
    assert.throws(() => fs.fstatSync(reservation.root.descriptor), error => error?.code == 'EBADF')
  })

  it('closes a newly opened backup root when post-creation revalidation fails', () => {
    const root = tempDir('lx-recovery-root-revalidation-close-')
    const backupsRoot = path.join(root, 'backups')
    const direct = require('../../src/main/storage/directDirectory.js')
    let ownerGuard
    let rootGuard
    const guardedDirect = {
      ...direct,
      createDirectChildDirectory(parent, basename, options) {
        rootGuard = direct.createDirectChildDirectory(parent, basename, options)
        return rootGuard
      },
      validateDirectDirectory(directoryPath, options) {
        const guard = direct.validateDirectDirectory(directoryPath, options)
        if (path.resolve(directoryPath) == path.resolve(backupsRoot)) rootGuard = guard
        else if (path.resolve(directoryPath) == path.resolve(root)) ownerGuard = guard
        return guard
      },
      revalidateDirectDirectory(guard) {
        if (guard == rootGuard) throw new Error('injected root revalidation failure')
        return direct.revalidateDirectDirectory(guard)
      },
    }
    const backup = loadBackupWithBoundaries({ directDirectoryModule: guardedDirect })

    assert.throws(() => backup.reserveOnlineBackup({
      backupsRoot,
      basenamePrefix: 'lx.data.db.backup',
      sourceSchemaVersion: 2,
    }), /injected root revalidation failure/)

    const descriptorClosed = guard => {
      try {
        fs.fstatSync(guard.descriptor)
        return false
      } catch (error) {
        return error?.code == 'EBADF'
      }
    }
    const ownerClosed = descriptorClosed(ownerGuard)
    const rootClosed = descriptorClosed(rootGuard)
    if (!rootClosed) direct.closeDirectDirectory(rootGuard)
    assert.equal(ownerClosed, true)
    assert.equal(rootClosed, true)
  })

  it('finishes root descriptor cleanup and preserves context when guarded close throws', () => {
    const root = tempDir('lx-recovery-root-close-error-')
    const backupsRoot = path.join(root, 'backups')
    const direct = require('../../src/main/storage/directDirectory.js')
    const primaryError = new Error('injected root revalidation failure')
    const cleanupError = new Error('injected root guarded-close failure')
    let rootGuard
    let revalidationFailed = false
    const guardedDirect = {
      ...direct,
      validateDirectDirectory(directoryPath, options) {
        const guard = direct.validateDirectDirectory(directoryPath, options)
        if (path.resolve(directoryPath) == path.resolve(backupsRoot)) rootGuard = guard
        return guard
      },
      revalidateDirectDirectory(guard) {
        if (guard == rootGuard && !revalidationFailed) {
          revalidationFailed = true
          throw primaryError
        }
        return direct.revalidateDirectDirectory(guard)
      },
      closeDirectDirectory(guard) {
        if (guard == rootGuard) throw cleanupError
        return direct.closeDirectDirectory(guard)
      },
    }
    const backup = loadBackupWithBoundaries({ directDirectoryModule: guardedDirect })
    let thrown
    try {
      backup.reserveOnlineBackup({
        backupsRoot,
        basenamePrefix: 'lx.data.db.backup',
        sourceSchemaVersion: 2,
      })
    } catch (error) {
      thrown = error
    }
    let rootClosed = false
    try {
      fs.fstatSync(rootGuard.descriptor)
    } catch (error) {
      rootClosed = error?.code == 'EBADF'
    }
    if (!rootClosed) fs.closeSync(rootGuard.descriptor)

    assert.equal(thrown, primaryError)
    assert.deepEqual(thrown.cleanupErrors, [cleanupError])
    assert.equal(rootClosed, true)
  })

  it('wraps a frozen primary error without discarding cleanup context', () => {
    const root = tempDir('lx-recovery-frozen-primary-cleanup-')
    const backupsRoot = path.join(root, 'backups')
    const direct = require('../../src/main/storage/directDirectory.js')
    const primaryError = Object.freeze(Object.assign(
      new Error('frozen root revalidation failure'),
      { code: 'frozen_primary_failure' },
    ))
    const cleanupError = new Error('injected frozen-primary close failure')
    let rootGuard
    let revalidationFailed = false
    const guardedDirect = {
      ...direct,
      validateDirectDirectory(directoryPath, options) {
        const guard = direct.validateDirectDirectory(directoryPath, options)
        if (path.resolve(directoryPath) == path.resolve(backupsRoot)) rootGuard = guard
        return guard
      },
      revalidateDirectDirectory(guard) {
        if (guard == rootGuard && !revalidationFailed) {
          revalidationFailed = true
          throw primaryError
        }
        return direct.revalidateDirectDirectory(guard)
      },
      closeDirectDirectory(guard) {
        if (guard == rootGuard) throw cleanupError
        return direct.closeDirectDirectory(guard)
      },
    }
    const backup = loadBackupWithBoundaries({ directDirectoryModule: guardedDirect })
    let thrown
    try {
      backup.reserveOnlineBackup({
        backupsRoot,
        basenamePrefix: 'lx.data.db.backup',
        sourceSchemaVersion: 2,
      })
    } catch (error) {
      thrown = error
    }
    assert.throws(() => fs.fstatSync(rootGuard.descriptor), error => error?.code == 'EBADF')

    assert.equal(thrown instanceof AggregateError, true)
    assert.equal(thrown.cause, primaryError)
    assert.equal(thrown.code, primaryError.code)
    assert.equal(thrown.message, primaryError.message)
    assert.equal(Object.isFrozen(thrown.cleanupErrors), true)
    assert.equal(thrown.cleanupErrors.includes(cleanupError), true)
    assert.equal(thrown.errors.includes(primaryError), true)
    assert.equal(thrown.errors.includes(cleanupError), true)
  })

  it('does not close a same-directory descriptor reused after guarded close', () => {
    const root = tempDir('lx-recovery-root-close-reuse-')
    const backupsRoot = path.join(root, 'backups')
    const direct = require('../../src/main/storage/directDirectory.js')
    const primaryError = new Error('injected root revalidation failure')
    const cleanupError = new Error('injected post-close failure')
    let rootGuard
    let replacementDescriptor
    let revalidationFailed = false
    const guardedDirect = {
      ...direct,
      validateDirectDirectory(directoryPath, options) {
        const guard = direct.validateDirectDirectory(directoryPath, options)
        if (path.resolve(directoryPath) == path.resolve(backupsRoot)) rootGuard = guard
        return guard
      },
      revalidateDirectDirectory(guard) {
        if (guard == rootGuard && !revalidationFailed) {
          revalidationFailed = true
          throw primaryError
        }
        return direct.revalidateDirectDirectory(guard)
      },
      closeDirectDirectory(guard) {
        if (guard != rootGuard) return direct.closeDirectDirectory(guard)
        direct.closeDirectDirectory(guard)
        replacementDescriptor = fs.openSync(backupsRoot, 'r')
        throw cleanupError
      },
    }
    const reusedDescriptorFs = new Proxy(fs, {
      get(target, property) {
        if (property == 'fstatSync') {
          return (descriptor, options) => fs.fstatSync(
            descriptor == rootGuard?.descriptor && replacementDescriptor != null
              ? replacementDescriptor
              : descriptor,
            options,
          )
        }
        if (property == 'closeSync') {
          return descriptor => fs.closeSync(
            descriptor == rootGuard?.descriptor && replacementDescriptor != null
              ? replacementDescriptor
              : descriptor,
          )
        }
        return Reflect.get(target, property)
      },
    })
    const backup = loadBackupWithBoundaries({
      directDirectoryModule: guardedDirect,
      fileSystem: reusedDescriptorFs,
    })
    let thrown
    try {
      backup.reserveOnlineBackup({
        backupsRoot,
        basenamePrefix: 'lx.data.db.backup',
        sourceSchemaVersion: 2,
      })
    } catch (error) {
      thrown = error
    }
    let replacementOpen = false
    try {
      replacementOpen = fs.fstatSync(replacementDescriptor).isDirectory()
    } catch {}
    if (replacementOpen) fs.closeSync(replacementDescriptor)

    assert.equal(thrown, primaryError)
    assert.equal(thrown.cleanupErrors.includes(cleanupError), true)
    assert.equal(replacementOpen, true)
  })

  it('rejects and retains a backup root created by a raced winner', () => {
    const root = tempDir('lx-recovery-root-creation-race-')
    const backupsRoot = path.join(root, 'backups')
    const direct = require('../../src/main/storage/directDirectory.js')
    let raceInjected = false
    const injectWinner = () => {
      if (raceInjected) return
      raceInjected = true
      fs.mkdirSync(backupsRoot, { mode: 0o700 })
    }
    const racingDirect = {
      ...direct,
      createDirectChildDirectory(parent, basename, options) {
        injectWinner()
        return direct.createDirectChildDirectory(parent, basename, options)
      },
    }
    const racingFs = new Proxy(fs, {
      get(target, property) {
        if (property == 'mkdirSync') {
          return (directoryPath, options) => {
            if (path.resolve(directoryPath) == path.resolve(backupsRoot)) {
              injectWinner()
              throw Object.assign(new Error('raced backup root winner'), { code: 'EEXIST' })
            }
            return fs.mkdirSync(directoryPath, options)
          }
        }
        return Reflect.get(target, property)
      },
    })
    const backup = loadBackupWithBoundaries({
      fileSystem: racingFs,
      directDirectoryModule: racingDirect,
    })
    let reservation
    let thrown
    try {
      reservation = backup.reserveOnlineBackup({
        backupsRoot,
        basenamePrefix: 'lx.data.db.backup',
        sourceSchemaVersion: 2,
      })
    } catch (error) {
      thrown = error
    }
    if (reservation != null) backup.closeOnlineBackupReservation(reservation)

    assert.equal(thrown?.code, 'EEXIST')
    assert.equal(fs.statSync(backupsRoot).isDirectory(), true)
    assert.deepEqual(backupArtifactNames(backupsRoot), [])
  })

  it('reopens recorded backup evidence read-only and rejects hash length or schema mismatch', () => {
    const root = tempDir('lx-recovery-recorded-backup-')
    const backupsRoot = path.join(root, 'backups')
    const db = createV2Database(':memory:')
    const backup = require('../../src/main/worker/dbService/databaseBackup.ts')
    const completed = createGuardedBackup({ db, backupsRoot })
    const record = {
      backupsRoot,
      basename: completed.basename,
      expectedSha256: completed.sha256,
      expectedByteLength: completed.byteLength,
      expectedSourceSchemaVersion: completed.sourceSchemaVersion,
      nativeOptions: {},
      verifier: candidate => assert.equal(candidate.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '2'),
    }
    completed.close()

    const recorded = backup.verifyRecordedOnlineBackup(record)
    recorded.revalidate()
    recorded.close()
    assert.throws(() => backup.verifyRecordedOnlineBackup({ ...record, expectedSha256: '0'.repeat(64) }))
    assert.throws(() => backup.verifyRecordedOnlineBackup({ ...record, expectedByteLength: record.expectedByteLength + 1 }))
    assert.throws(() => backup.verifyRecordedOnlineBackup({ ...record, expectedSourceSchemaVersion: 3 }))
  })

  it('verifies a legacy one-link backup only through the compatibility API', () => {
    const root = tempDir('lx-recovery-legacy-backup-')
    const filePath = path.join(root, 'legacy.backup')
    const db = createV2Database(':memory:')
    fs.writeFileSync(filePath, db.serialize(), { mode: 0o600 })
    const { verifyLegacyOnlineBackup } = require('../../src/main/worker/dbService/databaseBackup.ts')
    let checked = false

    verifyLegacyOnlineBackup(filePath, {}, candidate => {
      checked = candidate.pragma('quick_check', { simple: true }) == 'ok'
    })

    assert.equal(checked, true)
  })

  it('verifies only the exact legacy path without scanning retained siblings', () => {
    const root = tempDir('lx-recovery-legacy-linked-backup-')
    const stagePath = path.join(root, `.lx-backup-${'a'.repeat(32)}.stage`)
    const filePath = path.join(root, 'legacy.backup')
    const db = createV2Database(':memory:')
    fs.writeFileSync(stagePath, db.serialize(), { mode: 0o600 })
    fs.linkSync(stagePath, filePath)
    const noScanFs = new Proxy(fs, {
      get(target, property) {
        if (property == 'readdirSync') return () => { throw new Error('legacy_directory_scan_forbidden') }
        return Reflect.get(target, property)
      },
    })
    const { verifyLegacyOnlineBackup } = loadBackupWithBoundaries({ fileSystem: noScanFs })

    verifyLegacyOnlineBackup(filePath, {}, candidate => {
      assert.equal(candidate.pragma('quick_check', { simple: true }), 'ok')
    })

    assert.equal(fs.lstatSync(stagePath, { bigint: true }).nlink, 2n)
    assert.equal(fs.lstatSync(filePath, { bigint: true }).nlink, 2n)
  })

  it('rejects non-standalone legacy WAL bytes before any SQLite open or sidecar', () => {
    const root = tempDir('lx-recovery-legacy-wal-backup-')
    const filePath = path.join(root, 'legacy.backup')
    const db = createV2Database(path.join(root, 'source.db'))
    const snapshot = db.serialize()
    assert.deepEqual([snapshot[18], snapshot[19]], [2, 2])
    fs.writeFileSync(filePath, snapshot, { mode: 0o600 })
    const opens = []
    class ExactPathDatabase {
      constructor(filename, options) {
        opens.push({ filename, options })
        return new Database(filename, options)
      }
    }
    const { verifyLegacyOnlineBackup } = loadBackupWithBoundaries({
      DatabaseImplementation: ExactPathDatabase,
    })

    assert.throws(
      () => verifyLegacyOnlineBackup(filePath, {}, () => {}),
      /backup_snapshot_invalid/,
    )

    assert.deepEqual(opens, [])
    assert.deepEqual(fs.readFileSync(filePath), snapshot)
    assert.equal(fs.existsSync(`${filePath}-wal`), false)
    assert.equal(fs.existsSync(`${filePath}-shm`), false)
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
  it('keeps the guard open through migration and rejects final replacement', async() => {
    const paths = makePaths('lx-recovery-final-backup-replacement-')
    createV2Database(paths.databasePath).close()
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    let replaced = false
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        ...actualBackup,
        completeOnlineBackup(...args) {
          const guard = actualBackup.completeOnlineBackup(...args)
          return Object.freeze({
            ...guard,
            revalidate() {
              if (!replaced) {
                fs.renameSync(guard.path, `${guard.path}.original`)
                fs.writeFileSync(guard.path, 'replacement', { flag: 'wx', mode: 0o600 })
                replaced = true
              }
              guard.revalidate()
            },
          })
        },
      },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'backup_failed')
    assert.equal(readSchemaVersion(paths.databasePath), 2)
    const attempts = backupArtifactNames(paths.backupsRoot)
      .filter(name => name.endsWith('.backup'))
    assert.equal(attempts.length, 1)
    assert.equal(fs.readFileSync(path.join(paths.backupsRoot, attempts[0]), 'utf8'), 'replacement')
  })

  it('retains existedBeforeOpen across cached init and schema publication', async() => {
    const paths = makePaths('lx-recovery-existence-snapshot-')
    createCurrentDatabase(paths.databasePath).close()
    const dbService = loadDbServiceWithBoundaries()

    const first = await dbService.init(initOptions(paths))
    const cached = await dbService.init(initOptions(paths))

    assert.equal(dbService.getDatabaseInitialization().existedBeforeOpen, true)
    assert.deepEqual(cached, first)
  })

  it('publishes committed schema 7 state before propagating a backup guard close failure', async() => {
    const paths = makePaths('lx-recovery-advance-close-failure-')
    createCurrentDatabase(paths.databasePath).close()
    const fixtureCacheModulePaths = [
      '../../src/main/worker/dbService/migrations/index.ts',
      '../../src/main/worker/dbService/migrations/0007_cache_cleanup.ts',
      '../../src/main/worker/dbService/cacheDb.ts',
      '../../src/main/worker/dbService/modules/phase3/index.ts',
      '../../src/main/worker/dbService/modules/lyric/raw/repository.ts',
      '../../src/main/worker/dbService/modules/music_url/index.ts',
      '../../src/main/worker/dbService/modules/music_other_source/index.ts',
      '../../src/main/worker/dbService/modules/cacheLifecycle/prune.ts',
      '../../src/main/migration/cache/rawLyrics.ts',
      '../../src/main/migration/cache/cutover.ts',
    ]
    const fixtureModulePaths = [
      '../../src/main/worker/dbService/db.ts',
      '../../src/main/worker/dbService/databaseBackup.ts',
      '../../src/main/worker/dbService/verifyDB.ts',
      ...fixtureCacheModulePaths,
    ]
    const resetFixtureModules = (modulePaths = fixtureModulePaths) => {
      for (const filename of modulePaths) {
        try { delete require.cache[require.resolve(filename)] } catch {}
      }
    }
    resetFixtureModules()
    let dbService = null
    let cacheDb = null
    let injectedCloseCalls = 0
    try {
      const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
      dbService = loadDbServiceWithBoundaries({
        backupModule: {
          ...actualBackup,
          completeOnlineBackup(...args) {
            const guard = actualBackup.completeOnlineBackup(...args)
            return Object.freeze({
              ...guard,
              close() {
                guard.close()
                injectedCloseCalls++
                throw Object.assign(new Error('injected backup guard close failure'), {
                  code: 'injected_backup_guard_close_failure',
                })
              },
            })
          },
        },
      })
      const initialized = await dbService.init(initOptions(paths))
      assert.equal(initialized.status, 'ready')
      const database = dbService.getAppDB()
      const phase3 = require('../../src/common/storage/phase3.ts')
      const manifest = phase3.createPhase3Manifest({
        version: 1,
        completedAtMs: 1,
        checks: {
          credentials: { state: 'complete', evidenceSha256: 'a'.repeat(64) },
          accountProfile: { state: 'complete', evidenceSha256: 'b'.repeat(64) },
          phase2: { state: 'complete', evidenceSha256: 'c'.repeat(64) },
          playbackActivity: { state: 'complete', evidenceSha256: 'd'.repeat(64) },
          quarantine: { state: 'complete', evidenceSha256: 'e'.repeat(64) },
          playbackWriter: { state: 'complete', evidenceSha256: 'f'.repeat(64) },
          playbackReader: { state: 'complete', evidenceSha256: '0'.repeat(64) },
        },
      })
      const manifestJson = phase3.phase3ManifestJson(manifest)
      database.prepare(`
        INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
        VALUES (?, ?, ?, ?)
      `).run('legacy_data_v1.cross_artifact_complete', phase3.phase3ManifestSha256(manifest), 1, manifestJson)

      cacheDb = require('../../src/main/worker/dbService/cacheDb.ts')
      assert.deepEqual(await cacheDb.openCacheDatabase(), {
        status: 'created',
        schemaVersion: 1,
        diagnostic: null,
      })
      const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      const rawLyrics = require('../../src/main/migration/cache/rawLyrics.ts')
      assert.deepEqual(await rawLyrics.migrateRawLyrics({ nowMs: 10 }), {
        status: 'complete',
        sourceRows: 0,
        sourceOwnerGroups: 0,
        skippedInvalidRows: 0,
        sourceSha256: emptySha256,
        targetRows: 0,
        targetOwnerGroups: 0,
        targetSha256: emptySha256,
      })
      const cutover = require('../../src/main/migration/cache/cutover.ts')
      const attestation = await cutover.attestSchema6TypedOwnership(database, 20)
      assert.equal(attestation.status, 'completed')
      const prerequisites = cutover.verifySchema6CutoverPrerequisites(database)
      assert.equal(prerequisites.rawMarker.name, 'legacy_cache_v1.raw_lyrics')
      assert.equal(prerequisites.rawLyricsDeletedRows, 0)
      assert.deepEqual(prerequisites.readWriteMarker, attestation.value)

      await assert.rejects(
        dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot }),
        error => {
          assert.equal(error?.code, 'database_advance_backup_invalid')
          assert.equal(error?.message, 'database_advance_backup_invalid')
          assert.equal(error?.cause, undefined)
          assert.equal(error?.details, undefined)
          assert.doesNotMatch(error?.stack ?? '', /injected backup guard close failure/)
          return true
        },
      )

      assert.equal(injectedCloseCalls, 1)
      assert.equal(readSchemaVersion(paths.databasePath), 7)
      assert.equal(dbService.getDatabaseInitialization().schemaVersion, 7)
      const committed = cutover.verifySchema7SteadyState(database)
      assert.equal(committed.cutoverDetails.version, 2)
      assert.equal(committed.cutoverDetails.backupRequired, true)
      assert.equal(cutover.readBackupPreparedMarker(database), null)
      const committedCutoverMarker = { ...committed.cutoverMarker }
      const recordedBackupBasename = committed.cutoverDetails.backupBasename
      const recordedBackupByteLength = committed.cutoverDetails.backupByteLength
      const recordedBackupSha256 = committed.cutoverDetails.backupSha256
      const recordedBackupPath = path.join(paths.backupsRoot, recordedBackupBasename)
      const recordedBackupBytes = fs.readFileSync(recordedBackupPath)
      assert.equal(recordedBackupBytes.length, recordedBackupByteLength)
      assert.equal(
        crypto.createHash('sha256').update(recordedBackupBytes).digest('hex'),
        recordedBackupSha256,
      )
      const committedArtifacts = backupArtifactNames(paths.backupsRoot).sort()
      assert.deepEqual(committedArtifacts, [recordedBackupBasename])

      const parkedBackupPath = `${recordedBackupPath}.original`
      const replacementBackupPath = `${recordedBackupPath}.replacement`
      let replacement = null
      let originalParked = false
      try {
        fs.copyFileSync(recordedBackupPath, replacementBackupPath)
        replacement = new Database(replacementBackupPath)
        replacement.prepare(`
          INSERT INTO local_state(key, version, value_json, updated_at_ms)
          VALUES ('view_prev_state', 1, '{"replacement":true}', 30)
          ON CONFLICT(key) DO UPDATE SET
            version = excluded.version,
            value_json = excluded.value_json,
            updated_at_ms = excluded.updated_at_ms
        `).run()
        replacement.close()
        replacement = null
        fs.renameSync(recordedBackupPath, parkedBackupPath)
        originalParked = true
        fs.renameSync(replacementBackupPath, recordedBackupPath)
        await assert.rejects(
          dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot }),
          error => error?.code == 'database_advance_backup_invalid',
        )
      } finally {
        try {
          if (replacement?.open) replacement.close()
        } finally {
          try {
            if (originalParked) {
              if (fs.existsSync(recordedBackupPath)) fs.unlinkSync(recordedBackupPath)
              fs.renameSync(parkedBackupPath, recordedBackupPath)
            }
          } finally {
            if (fs.existsSync(replacementBackupPath)) fs.unlinkSync(replacementBackupPath)
          }
        }
      }

      const retried = await dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot })
      assert.equal(retried.schemaVersion, 7)
      assert.equal(retried.backupPath, recordedBackupPath)
      assert.equal(injectedCloseCalls, 1)
      assert.deepEqual(backupArtifactNames(paths.backupsRoot).sort(), committedArtifacts)
      assert.deepEqual(cutover.verifySchema7SteadyState(database).cutoverMarker, committedCutoverMarker)
      assert.equal(cutover.readBackupPreparedMarker(database), null)
    } finally {
      if (dbService == null) {
        resetFixtureModules()
      } else {
        try {
          await cacheDb?.closeCacheDatabase()
        } finally {
          try {
            dbService.close()
          } finally {
            resetFixtureModules(fixtureCacheModulePaths)
          }
        }
      }
    }
  })

  it('rejects caller-supplied existence state', async() => {
    const paths = makePaths('lx-recovery-caller-existence-')
    const dbService = loadDbServiceWithBoundaries()

    await assert.rejects(
      dbService.init({ ...initOptions(paths), existedBeforeOpen: true }),
      error => error?.code == 'database_initialization_invalid',
    )
    assert.equal(fs.existsSync(paths.databasePath), false)
  })

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

  it('bootstraps a fresh database without entering the backup boundary', async() => {
    const paths = makePaths('lx-recovery-fresh-')
    let backupCalls = 0
    const verificationOptions = []
    const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        reserveOnlineBackup: () => {
          backupCalls++
          throw new Error('fresh startup must not create a backup')
        },
      },
      verifyModule: {
        ...actualVerify,
        verifyDatabase: (db, options) => {
          verificationOptions.push(options)
          return actualVerify.verifyDatabase(db, options)
        },
      },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.status, 'ready')
    assert.equal(result.existed, false)
    assert.equal(result.schemaVersion, currentSchemaVersion)
    assert.deepEqual(result.migratedVersions, [])
    assert.equal(result.backupPath, null)
    assert.equal(backupCalls, 0)
    assert.equal(fs.existsSync(paths.backupsRoot), false)
    assert.deepEqual(verificationOptions, [{ runQuickCheck: true, runForeignKeyCheck: true }])
    assert.equal(dbService.getAppDB().pragma('foreign_keys', { simple: true }), 1)
    assert.equal(dbService.getAppDB().pragma('journal_mode', { simple: true }), 'wal')
    assert.equal(fs.existsSync(path.join(paths.dataPath, 'activity.db')), false)
  })

  it('passes the startup packaged binding into read-only backup verification', async() => {
    const paths = makePaths('lx-recovery-startup-packaged-binding-')
    createV2Database(paths.databasePath).close()
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
          verificationOpens.push({ filename, fromBytes: Buffer.isBuffer(filename), options })
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
      const expectedOptions = {
        nativeBinding: expectedNativeBinding,
        readonly: true,
        fileMustExist: true,
      }
      assert.deepEqual(verificationOpens.map(entry => entry.options), [expectedOptions])
      assert.equal(verificationOpens[0].fromBytes, false)
      assert.equal(verificationOpens[0].filename, path.toNamespacedPath(result.backupPath))
    } finally {
      dbService.close()
      clearDbServiceCache()
    }
  })

  it('kills backup-after-migration and skipped-check implementations by preserving exact observable order', async() => {
    const paths = makePaths('lx-recovery-order-')
    createV2Database(paths.databasePath).close()
    const events = []
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    const actualMigrate = require('../../src/main/worker/dbService/migrate.ts')
    const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        ...actualBackup,
        completeOnlineBackup: (...args) => {
          events.push('backup')
          return actualBackup.completeOnlineBackup(...args)
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
    const existing = createCurrentDatabase(paths.databasePath)
    existing.close()
    const calls = []
    const actualVerify = require('../../src/main/worker/dbService/verifyDB.ts')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: { reserveOnlineBackup: () => { calls.push('backup'); throw new Error('unexpected backup') } },
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
      status: 'ready', existed: true, schemaVersion: currentSchemaVersion, migratedVersions: [], backupPath: null,
      preparedCutoverPending: false,
    })
    assert.deepEqual(calls, [{ runQuickCheck: false, runForeignKeyCheck: false }])
  })

  it('rejects missing or structurally invalid account profile tables before ready', async() => {
    const cases = [
      {
        mutate: db => db.exec('DROP TABLE account_profiles'),
        diagnostic: 'schema.table_missing:account_profiles',
      },
      {
        mutate: db => db.exec('ALTER TABLE account_profiles RENAME COLUMN profile_json TO profile_data'),
        diagnostic: 'schema.column_missing:account_profiles.profile_json',
      },
      {
        mutate: db => db.exec(`
          ALTER TABLE account_profiles RENAME TO invalid_account_profiles;
          CREATE TABLE account_profiles (
            provider TEXT,
            profile_json TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
          DROP TABLE invalid_account_profiles;
        `),
        diagnostic: 'schema.column_primary_key:account_profiles.provider',
      },
    ]

    for (const { mutate, diagnostic } of cases) {
      const paths = makePaths('lx-recovery-account-profile-schema-')
      const existing = createCurrentDatabase(paths.databasePath)
      mutate(existing)
      existing.close()
      const dbService = loadDbServiceWithBoundaries()

      const result = await dbService.init(initOptions(paths))

      assert.equal(result.status, 'recovery')
      assert.equal(result.reason, 'schema_invalid')
      assert.equal(result.backupPath, null)
      assert.equal(result.diagnostics.includes(diagnostic), true)
      dbService.close()
    }
  })

  it('runs both integrity checks after an unclean startup without pending migrations', async() => {
    const paths = makePaths('lx-recovery-unclean-')
    const existing = createCurrentDatabase(paths.databasePath)
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
      const existing = createCurrentDatabase(paths.databasePath)
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
        checkCredentials: async() => ({
          vaultReadable: true,
          profileRepositoryReadable: true,
          activePlaintextSources: [],
        }),
        interruptStalePlaybackSessions: async() => 0,
        runPlaybackTypedSmoke: async() => ({ version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64) }),
        getPhase3AttestationPrerequisites: async() => ({ version: 1 }),
        completePhase3Attestation: async() => {},
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
    createV2Database(paths.databasePath).close()
    const dbService = loadDbServiceWithBoundaries({
      backupModule: { reserveOnlineBackup: () => { throw new Error('secret backup failure') } },
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
    createV2Database(paths.databasePath).close()
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    const dbService = loadDbServiceWithBoundaries({
      backupModule: {
        ...actualBackup,
        completeOnlineBackup(db, reservation, nativeOptions) {
          return actualBackup.completeOnlineBackup(db, reservation, nativeOptions, () => {
            throw new Error('backup verification failed')
          })
        },
      },
    })

    const result = await dbService.init(initOptions(paths))

    assert.equal(result.reason, 'backup_failed')
    assert.equal(fs.existsSync(result.backupPath), true)
    assert.equal(fs.lstatSync(result.backupPath, { bigint: true }).nlink, 1n)
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
    const existing = createCurrentDatabase(paths.databasePath)
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
    const existing = createCurrentDatabase(paths.databasePath)
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
      const existing = createCurrentDatabase(paths.databasePath)
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
      const existing = createCurrentDatabase(paths.databasePath)
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
    const existing = createCurrentDatabase(paths.databasePath)
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

  it('kills backup collision overwrites by selecting a unique direct artifact', async() => {
    const paths = makePaths('lx-recovery-collision-')
    createV2Database(paths.databasePath).close()
    fs.mkdirSync(paths.backupsRoot, { recursive: true })
    const occupied = path.join(paths.backupsRoot, `lx.data.db.pre-migration-v2-to-v${currentSchemaVersion}.00000000000000000000000000000000.backup`)
    fs.writeFileSync(occupied, 'existing verified artifact')
    const dbService = loadDbServiceWithBoundaries()
    const result = await dbService.init(initOptions(paths))
    assert.match(path.basename(result.backupPath), /^lx\.data\.db\.pre-migration-v2-to-v6\.[a-f0-9]{32}\.backup$/)
    assert.notEqual(result.backupPath, occupied)
    assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing verified artifact')
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
    const existing = createCurrentDatabase(paths.databasePath)
    existing.close()
    const external = createCurrentDatabase(externalPath)
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
    const existing = createCurrentDatabase(paths.databasePath)
    existing.close()
    const external = createCurrentDatabase(externalPath)
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

  it('keeps unique backup publication beneath backupsRoot', async() => {
    const paths = makePaths('lx-recovery-backup-containment-')
    createV2Database(paths.databasePath).close()
    const dbService = loadDbServiceWithBoundaries()

    const result = await dbService.init(initOptions(paths))

    assert.deepEqual({ status: result.status, reason: result.reason ?? null }, { status: 'ready', reason: null })
    assert.equal(path.dirname(result.backupPath), path.resolve(paths.backupsRoot))
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
    const existing = createCurrentDatabase(paths.databasePath)
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
      checkCredentials: async() => ({
        vaultReadable: true,
        profileRepositoryReadable: true,
        activePlaintextSources: [],
      }),
      interruptStalePlaybackSessions: async() => 0,
      runPlaybackTypedSmoke: async() => ({ version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64) }),
      getPhase3AttestationPrerequisites: async() => ({ version: 1 }),
      completePhase3Attestation: async() => {},
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
    const existing = createCurrentDatabase(paths.databasePath)
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

  it('reuses cached initialization without repeating guarded backup work', async() => {
    const paths = makePaths('lx-recovery-init-reuse-')
    createV2Database(paths.databasePath).close()
    const actualBackup = require('../../src/main/worker/dbService/databaseBackup.ts')
    let openCalls = 0
    let backupCalls = 0
    class TrackingDatabase {
      constructor(...args) {
        openCalls++
        return new Database(...args)
      }
    }
    const dbService = loadDbServiceWithBoundaries({
      DatabaseImplementation: TrackingDatabase,
      backupModule: {
        ...actualBackup,
        completeOnlineBackup(...args) {
          backupCalls++
          return actualBackup.completeOnlineBackup(...args)
        },
      },
    })
    const first = await dbService.init(initOptions(paths))
    const opensAfterFirst = openCalls
    const second = await dbService.init({
      dataPath: path.join(paths.dataPath, '.'),
      cacheRoot: path.join(paths.cacheRoot, 'nested', '..'),
      backupsRoot: path.join(paths.backupsRoot, 'nested', '..'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(first.status, 'ready')
    assert.deepEqual(second, first)
    assert.notEqual(second, first)
    assert.equal(openCalls, opensAfterFirst)
    assert.equal(backupCalls, 1)
    const stableHandle = dbService.getAppDB()
    first.migratedVersions.push(99)
    const third = await dbService.init(initOptions(paths))
    assert.deepEqual(third.migratedVersions, currentMigrationVersions)
    assert.equal(dbService.getAppDB(), stableHandle)
    assert.equal(openCalls, opensAfterFirst)
    assert.equal(backupCalls, 1)
  })

  it('rejects profile replacement after initialization', async() => {
    const firstPaths = makePaths('lx-recovery-init-conflict-a-')
    const secondPaths = makePaths('lx-recovery-init-conflict-b-')
    createV2Database(firstPaths.databasePath).close()
    const dbService = loadDbServiceWithBoundaries()
    const first = await dbService.init(initOptions(firstPaths))
    assert.equal(first.status, 'ready')
    const stableHandle = dbService.getAppDB()
    await assert.rejects(dbService.init(initOptions(secondPaths)), error =>
      error.message == 'database_initialization_conflict' && error.code == 'database_initialization_conflict')
    assert.equal(dbService.getAppDB(), stableHandle)
    assert.equal(fs.existsSync(secondPaths.databasePath), false)
  })

  it('uses only verified non-recursive cleanup when file symlinks fall back to junctions', t => {
    if (process.platform != 'win32') return t.skip('Junction fallback is Windows-specific')

    for (const dangling of [false, true]) {
      const paths = makePaths(`lx-recovery-junction-cleanup-${dangling ? 'dangling' : 'existing'}-`)
      const target = path.join(paths.root, dangling ? 'missing-target.db' : 'existing-target.db')
      const link = path.join(paths.dataPath, dangling ? 'dangling-link.db' : 'existing-link.db')
      const calls = []
      const fsApi = {
        ...fs,
        symlinkSync(source, destination, type) {
          calls.push(`symlink:${type}`)
          if (type == 'file') throw Object.assign(new Error('file symlink unavailable'), { code: 'EPERM' })
          return fs.symlinkSync(source, destination, type)
        },
        unlinkSync(targetPath) {
          calls.push(`unlink:${targetPath}`)
          return fs.unlinkSync(targetPath)
        },
        rmdirSync(targetPath) {
          calls.push(`rmdir:${targetPath}`)
          return fs.rmdirSync(targetPath)
        },
        rmSync() {
          throw new Error('recursive target cleanup is forbidden')
        },
      }

      const result = createDatabaseSymlinkOrSkip(t, {
        target,
        link,
        dangling,
        contents: 'SAFE_TARGET_CONTENTS',
      }, fsApi)

      assert.notEqual(result, null)
      assert.deepEqual(calls.filter(call => call.startsWith('symlink:')), ['symlink:file', 'symlink:junction'])
      assert.deepEqual(calls.filter(call => call.startsWith('unlink:')), dangling ? [] : [`unlink:${target}`])
      assert.deepEqual(calls.filter(call => call.startsWith('rmdir:')), dangling ? [`rmdir:${target}`] : [])
    }
  })

  it('rejects conflicting cache, backup, and schema-target initialization identities', async() => {
    const paths = makePaths('lx-recovery-init-storage-identity-')
    const dbService = loadDbServiceWithBoundaries()
    assert.equal((await dbService.init(initOptions(paths))).status, 'ready')

    for (const override of [
      { cacheRoot: path.join(paths.root, 'other-cache') },
      { backupsRoot: path.join(paths.root, 'other-backups') },
      { targetSchemaVersion: 5 },
    ]) {
      await assert.rejects(dbService.init({ ...initOptions(paths), ...override }), error =>
        error.message == 'database_initialization_conflict' && error.code == 'database_initialization_conflict')
    }
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
      cacheRoot: path.join('C:\\profiles\\alice-cache'),
      backupsRoot: path.join('C:\\profiles\\alice', 'backups'),
      previousShutdownWasClean: false,
      targetSchemaVersion: 6,
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
      status: 'ready', existed: true, schemaVersion: 3, migratedVersions: [], backupPath: null, preparedCutoverPending: false,
    }))

    assert.deepEqual(await init({
      dataPath: 'C:\\profiles\\alice',
      cacheRoot: path.join('C:\\profiles\\alice-cache'),
      backupsRoot: path.join('C:\\profiles\\alice', 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    }), { status: 'ready', existed: true, schemaVersion: 3, migratedVersions: [], backupPath: null, preparedCutoverPending: false })
  })

  it('reuses the same real object startup result without reinitialization', async() => {
    const paths = makePaths('lx-recovery-adapter-reuse-')
    const { init } = loadRealWorkerAdapter()

    const first = await init(initOptions(paths))
    const handle = require('../../src/main/worker/dbService/db.ts').getAppDB()
    const second = await init({
      dataPath: path.join(paths.dataPath, '.'),
      cacheRoot: path.join(paths.cacheRoot, 'nested', '..'),
      backupsRoot: path.join(paths.backupsRoot, 'nested', '..'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })

    assert.equal(first.status, 'ready')
    assert.equal(first.existed, false)
    assert.deepEqual(second, first)
    assert.equal(require('../../src/main/worker/dbService/db.ts').getAppDB(), handle)
    assert.equal(fs.existsSync(paths.backupsRoot), false)
  })
})
