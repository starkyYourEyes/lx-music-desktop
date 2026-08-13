const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// Electron ABI tests transpile the source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const Database = require('better-sqlite3')
const dbService = require('../../src/main/worker/dbService/db.ts')
const {
  CACHE_MIGRATION_CHECKSUM,
  CACHE_MIGRATION_NAME,
  CACHE_MIGRATION_V1_CHECKSUM,
  CACHE_MIGRATION_V1_NAME,
  CACHE_SCHEMA_VERSION,
  migrateCacheSchemaV1ToV2,
} = require('../../src/main/worker/dbService/cacheMigrate.ts')
const { CACHE_SCHEMA_SOURCE } = require('../../src/main/worker/dbService/cacheTables.ts')
const { verifyCacheSchema } = require('../../src/main/worker/dbService/cacheSchemaContract.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const cacheModulePath = '../../src/main/worker/dbService/cacheDb.ts'
const MAX_CACHE_PREFLIGHT_BYTES = 256 * 1024 * 1024
const fixtures = []
const cacheServices = []

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256Text = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const sha256File = filename => fs.existsSync(filename)
  ? crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  : null

const nodeIdentity = filename => {
  const stat = fs.lstatSync(filename, { bigint: true })
  return { dev: stat.dev, ino: stat.ino }
}

const fileNodeSnapshot = filename => ({
  ...nodeIdentity(filename),
  bytes: fs.readFileSync(filename),
})

const cacheArtifactSnapshots = cachePath => Object.fromEntries([
  cachePath,
  `${cachePath}-wal`,
  `${cachePath}-shm`,
].filter(filename => fs.existsSync(filename)).map(filename => [filename, fileNodeSnapshot(filename)]))

const calculateWalChecksum = (value, length, byteOrder, initial = [0, 0]) => {
  let [first, second] = initial
  const readWord = byteOrder == 'BE'
    ? offset => value.readUInt32BE(offset)
    : offset => value.readUInt32LE(offset)
  for (let offset = 0; offset < length; offset += 8) {
    first = (first + readWord(offset) + second) >>> 0
    second = (second + readWord(offset + 4) + first) >>> 0
  }
  return [first, second]
}

const rewriteWalChecksums = wal => {
  const byteOrder = wal.readUInt32BE(0) == 0x377f0683 ? 'BE' : 'LE'
  let checksum = calculateWalChecksum(wal, 24, byteOrder)
  wal.writeUInt32BE(checksum[0], 24)
  wal.writeUInt32BE(checksum[1], 28)
  const pageSize = wal.readUInt32BE(8)
  const frameSize = 24 + pageSize
  for (let position = 32; position + frameSize <= wal.length; position += frameSize) {
    const frame = wal.subarray(position, position + frameSize)
    checksum = calculateWalChecksum(frame, 8, byteOrder, checksum)
    checksum = calculateWalChecksum(frame.subarray(24), pageSize, byteOrder, checksum)
    frame.writeUInt32BE(checksum[0], 16)
    frame.writeUInt32BE(checksum[1], 20)
  }
}

const lastCommittedWalFrame = wal => {
  const frameSize = 24 + wal.readUInt32BE(8)
  let committed = null
  for (let position = 32; position + frameSize <= wal.length; position += frameSize) {
    if (wal.readUInt32BE(position + 4) != 0) committed = position
  }
  assert.notEqual(committed, null)
  return committed
}

const schemaSnapshot = cachePath => {
  const db = new Database(cachePath, { readonly: true, fileMustExist: true })
  try {
    return db.prepare(`
      SELECT type, name, tbl_name, sql FROM sqlite_master
      ORDER BY type, name
    `).all()
  } finally {
    db.close()
  }
}

const appFingerprint = databasePath => Object.fromEntries([
  databasePath,
  `${databasePath}-wal`,
  `${databasePath}-shm`,
].map(filename => [filename, sha256File(filename)]))

const completeMarker = () => {
  const detailsJson = canonical({
    version: 1,
    checks: [
      { name: 'credentials', version: 1, state: 'complete', evidenceSha256: 'a'.repeat(64) },
      { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: 'b'.repeat(64) },
      { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: 'c'.repeat(64) },
      { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: 'd'.repeat(64) },
      { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: 'e'.repeat(64) },
      { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: 'f'.repeat(64) },
      { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: '0'.repeat(64) },
    ],
  })
  return {
    name: 'legacy_data_v1.cross_artifact_complete',
    sourceSha256: sha256Text(detailsJson),
    completedAtMs: 1,
    detailsJson,
  }
}

const loadCacheModule = () => {
  try {
    return require(cacheModulePath)
  } catch (error) {
    if (error?.code == 'MODULE_NOT_FOUND' && String(error.message).includes('cacheDb')) {
      assert.fail('guarded cache database module is not implemented')
    }
    throw error
  }
}

const createCacheService = options => {
  const service = loadCacheModule().createCacheDatabaseService(options)
  cacheServices.push(service)
  return service
}

const createAppFixture = async({ withPrerequisite = true, prefix = 'cache-db', nestedCacheParent = false } = {}) => {
  const fixture = createTestStorageRoot(prefix)
  fixtures.push(fixture)
  const profileRoot = path.join(fixture.path, 'profile')
  const cacheParent = nestedCacheParent ? path.join(fixture.path, 'cache-parent') : fixture.path
  if (nestedCacheParent) fs.mkdirSync(cacheParent)
  const cacheRoot = path.join(cacheParent, 'cache')
  const backupsRoot = path.join(fixture.path, 'backups')
  const appDbPath = path.join(profileRoot, 'lx.data.db')
  const startup = await dbService.init({
    dataPath: profileRoot,
    cacheRoot,
    backupsRoot,
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(startup.status, 'ready')
  const db = dbService.getAppDB()
  if (withPrerequisite) {
    const marker = completeMarker()
    db.prepare(`
      INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
      VALUES (?, ?, ?, ?)
    `).run(marker.name, marker.sourceSha256, marker.completedAtMs, marker.detailsJson)
  }
  db.pragma('wal_checkpoint(PASSIVE)')
  return { fixture, profileRoot, cacheParent, cacheRoot, backupsRoot, appDbPath, db }
}

const closeService = async service => {
  try { await service.closeCacheDatabase() } catch {}
}

afterEach(async() => {
  for (const service of cacheServices.splice(0).reverse()) await closeService(service)
  try { dbService.close() } catch {}
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
  try { delete require.cache[require.resolve(cacheModulePath)] } catch {}
})

const cacheTableNames = [
  'cache_schema_migrations',
  'music_urls',
  'other_source_groups',
  'other_sources',
  'raw_lyric_groups',
  'raw_lyrics',
]

const expectedColumns = {
  cache_schema_migrations: ['version', 'name', 'checksum', 'applied_at_ms'],
  raw_lyric_groups: ['provider', 'source_track_id', 'byte_size', 'created_at_ms', 'last_accessed_at_ms'],
  raw_lyrics: ['provider', 'source_track_id', 'lyric_type', 'text', 'byte_size'],
  music_urls: [
    'provider', 'account_scope', 'source_track_id', 'quality', 'url',
    'reported_quality',
    'expires_at_ms', 'created_at_ms', 'last_accessed_at_ms',
  ],
  other_source_groups: [
    'original_provider', 'original_track_id', 'byte_size', 'expires_at_ms',
    'created_at_ms', 'last_accessed_at_ms',
  ],
  other_sources: [
    'original_provider', 'original_track_id', 'rank', 'candidate_provider',
    'candidate_track_id', 'candidate_json', 'byte_size',
  ],
}

const EXACT_CACHE_SCHEMA_V1_SOURCE = `CREATE TABLE cache_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0)
);

CREATE TABLE raw_lyric_groups (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, source_track_id)
);

CREATE TABLE raw_lyrics (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  lyric_type TEXT NOT NULL CHECK(lyric_type IN ('lyric','tlyric','rlyric','lxlyric')),
  text TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(provider, source_track_id, lyric_type),
  FOREIGN KEY(provider, source_track_id)
    REFERENCES raw_lyric_groups(provider, source_track_id) ON DELETE CASCADE
);

CREATE TABLE music_urls (
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  url TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, account_scope, source_track_id, quality)
);

CREATE TABLE other_source_groups (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(original_provider, original_track_id)
);

CREATE TABLE other_sources (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(rank >= 0),
  candidate_provider TEXT NOT NULL,
  candidate_track_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(original_provider, original_track_id, rank),
  UNIQUE(original_provider, original_track_id, candidate_provider, candidate_track_id),
  FOREIGN KEY(original_provider, original_track_id)
    REFERENCES other_source_groups(original_provider, original_track_id) ON DELETE CASCADE
);

CREATE INDEX raw_lyric_groups_lru
ON raw_lyric_groups(last_accessed_at_ms, created_at_ms, provider COLLATE BINARY, source_track_id COLLATE BINARY);

CREATE INDEX music_urls_expiry
ON music_urls(expires_at_ms, provider COLLATE BINARY, account_scope COLLATE BINARY,
  source_track_id COLLATE BINARY, quality COLLATE BINARY);

CREATE INDEX music_urls_lru
ON music_urls(last_accessed_at_ms, created_at_ms, provider COLLATE BINARY,
  account_scope COLLATE BINARY, source_track_id COLLATE BINARY, quality COLLATE BINARY);

CREATE INDEX other_source_groups_expiry
ON other_source_groups(expires_at_ms, original_provider COLLATE BINARY, original_track_id COLLATE BINARY);

CREATE INDEX other_source_groups_lru
ON other_source_groups(last_accessed_at_ms, created_at_ms,
  original_provider COLLATE BINARY, original_track_id COLLATE BINARY);`

const CACHE_SCHEMA_V1_CHECKSUM = sha256Text(EXACT_CACHE_SCHEMA_V1_SOURCE)

const createExactV1Cache = (cachePath, { withRows = false, schemaSource = EXACT_CACHE_SCHEMA_V1_SOURCE,
  checksum = CACHE_SCHEMA_V1_CHECKSUM, userVersion = 1 } = {}) => {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const db = new Database(cachePath)
  try {
    db.pragma('foreign_keys = ON')
    db.exec(schemaSource)
    db.prepare(`
      INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (1, 'cache_schema_v1', ?, 111)
    `).run(checksum)
    if (withRows) {
      db.exec(`
        INSERT INTO raw_lyric_groups VALUES ('tx', 'legacy', 6, 1, 2);
        INSERT INTO raw_lyrics VALUES ('tx', 'legacy', 'lyric', '[00:00]legacy', 6);
        INSERT INTO music_urls VALUES (
          'tx', 'profile-v1:uin:1', 'legacy', '320k',
          'https://media.invalid/legacy', 10, 1, 2
        );
        INSERT INTO other_source_groups VALUES ('tx', 'legacy', 12, 10, 1, 2);
        INSERT INTO other_sources VALUES ('tx', 'legacy', 0, 'wy', 'candidate', '{}', 12);
      `)
    }
    db.pragma(`user_version = ${userVersion}`)
  } finally {
    db.close()
  }
}

const rewriteTableSql = (db, table, from, to) => {
  db.unsafeMode(true)
  const schemaVersion = db.pragma('schema_version', { simple: true })
  db.pragma('writable_schema = ON')
  try {
    const update = db.prepare(`
      UPDATE sqlite_schema SET sql = replace(sql, ?, ?)
      WHERE type = 'table' AND name = ?
    `).run(from, to, table)
    assert.equal(update.changes, 1)
    db.pragma(`schema_version = ${schemaVersion + 1}`)
  } finally {
    db.pragma('writable_schema = OFF')
  }
}

const createCacheFromSchemaSource = (cachePath, schemaSource) => {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true })
  const db = new Database(cachePath)
  try {
    db.pragma('foreign_keys = ON')
    db.exec(schemaSource)
    db.prepare(`
      INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(1, CACHE_MIGRATION_V1_NAME, CACHE_MIGRATION_V1_CHECKSUM, 1)
    db.prepare(`
      INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM, 1)
    db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`)
  } finally {
    db.close()
  }
}

describe('guarded cache database', () => {
  it('creates schema version 2 with nullable checked reported quality', async() => {
    const { cacheRoot } = await createAppFixture()
    const service = createCacheService({ now: () => 1234 })
    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'created', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    const db = new Database(path.join(cacheRoot, 'cache.db'), { readonly: true })
    try {
      const column = db.pragma('table_info("music_urls")').find(row => row.name == 'reported_quality')
      assert.deepEqual({ type: column.type, notnull: column.notnull }, { type: 'TEXT', notnull: 0 })
      assert.throws(() => db.prepare(`INSERT INTO music_urls(
        provider, account_scope, source_track_id, quality, url, reported_quality,
        expires_at_ms, created_at_ms, last_accessed_at_ms
      ) VALUES ('tx','profile-v1:uin:1','x','320k','https://audio','hires',10,1,1)`).run())
    } finally {
      db.close()
    }
  })

  it('atomically migrates exact schema v1 rows to v2 with null reported quality', async() => {
    const { cacheRoot } = await createAppFixture()
    createExactV1Cache(path.join(cacheRoot, 'cache.db'), { withRows: true })
    const service = createCacheService({ now: () => 5678 })
    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    const db = new Database(path.join(cacheRoot, 'cache.db'), { readonly: true })
    try {
      assert.equal(db.pragma('user_version', { simple: true }), 2)
      assert.deepEqual(db.prepare(`SELECT url, reported_quality AS reportedQuality FROM music_urls`).get(), {
        url: 'https://media.invalid/legacy', reportedQuality: null,
      })
      assert.equal(db.prepare('SELECT count(*) AS count FROM raw_lyrics').get().count, 1)
      assert.equal(db.prepare('SELECT count(*) AS count FROM other_sources').get().count, 1)
      assert.deepEqual(db.prepare(`SELECT version, name FROM cache_schema_migrations ORDER BY version`).all(), [
        { version: 1, name: 'cache_schema_v1' },
        { version: 2, name: 'cache_schema_v2_reported_quality' },
      ])
    } finally {
      db.close()
    }
  })

  it('rolls back schema v2 when migration failure is injected before commit', async() => {
    const { cacheRoot } = await createAppFixture()
    const cachePath = path.join(cacheRoot, 'cache.db')
    createExactV1Cache(cachePath, { withRows: true })
    const before = sha256File(cachePath)
    const db = new Database(cachePath)
    assert.throws(() => migrateCacheSchemaV1ToV2(
      db,
      5678,
      candidate => verifyCacheSchema(candidate).ok,
      { beforeCommitV2() { throw new Error('injected migration failure') } },
    ), /injected migration failure/)
    db.close()
    assert.equal(sha256File(cachePath), before)
    const check = new Database(cachePath, { readonly: true })
    try {
      assert.equal(check.pragma('user_version', { simple: true }), 1)
      assert.equal(check.prepare('SELECT count(*) AS count FROM cache_schema_migrations').get().count, 1)
      assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'music_urls_v2'").get().count, 0)
      assert.equal(check.prepare('SELECT url FROM music_urls').get().url, 'https://media.invalid/legacy')
    } finally {
      check.close()
    }
  })

  it('rejects malformed schema v1 without changing its artifact fingerprint', async(t) => {
    const cases = [
      {
        name: 'ledger checksum',
        create(cachePath) { createExactV1Cache(cachePath, { checksum: 'f'.repeat(64) }) },
      },
      {
        name: 'URL column definition',
        create(cachePath) {
          createExactV1Cache(cachePath, {
            schemaSource: EXACT_CACHE_SCHEMA_V1_SOURCE.replace('url TEXT NOT NULL,', 'url TEXT,'),
          })
        },
      },
      {
        name: 'index definition',
        create(cachePath) {
          createExactV1Cache(cachePath, {
            schemaSource: EXACT_CACHE_SCHEMA_V1_SOURCE.replace(
              'source_track_id COLLATE BINARY, quality COLLATE BINARY);',
              'source_track_id COLLATE NOCASE, quality COLLATE BINARY);',
            ),
          })
        },
      },
      {
        name: 'check constraint',
        create(cachePath) {
          createExactV1Cache(cachePath, {
            schemaSource: EXACT_CACHE_SCHEMA_V1_SOURCE.replace('expires_at_ms >= 0', 'expires_at_ms > 0'),
          })
        },
      },
      {
        name: 'user_version',
        create(cachePath) { createExactV1Cache(cachePath, { userVersion: 3 }) },
      },
    ]
    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        const { cacheRoot } = await createAppFixture({ prefix: 'malformed-schema-v1' })
        const cachePath = path.join(cacheRoot, 'cache.db')
        testCase.create(cachePath)
        const before = sha256File(cachePath)
        const service = createCacheService({ now: () => 5678 })
        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_schema_invalid',
        })
        assert.equal(sha256File(cachePath), before)
        await closeService(service)
        dbService.close()
      })
    }
  })

  it('creates a missing cache root only after re-reading the phase-3 prerequisite', async() => {
    const { cacheParent, cacheRoot, appDbPath } = await createAppFixture({ withPrerequisite: false })
    const before = appFingerprint(appDbPath)
    const parentBefore = nodeIdentity(cacheParent)
    const service = createCacheService()

    await assert.rejects(service.openCacheDatabase(), error =>
      error?.message == 'cache_phase3_prerequisite_invalid' &&
      error?.code == 'cache_phase3_prerequisite_invalid')

    assert.equal(fs.existsSync(cacheRoot), false)
    assert.equal(fs.existsSync(path.join(cacheRoot, 'cache.db')), false)
    assert.deepEqual(nodeIdentity(cacheParent), parentBefore)
    assert.deepEqual(appFingerprint(appDbPath), before)
    assert.equal(await service.getCacheLifecycleState(), 'closed')
  })

  it('rejects a cache-root parent replacement before child creation', async() => {
    const { fixture, cacheParent, cacheRoot, appDbPath } = await createAppFixture({
      prefix: 'cache-parent-replacement',
      nestedCacheParent: true,
    })
    const parked = path.join(fixture.path, 'parked-cache-parent')
    let swapped = false
    const fileSystem = {
      ...fs,
      mkdirSync(targetPath, options) {
        if (!swapped && path.resolve(String(targetPath)) == path.resolve(cacheRoot)) {
          swapped = true
          fs.renameSync(cacheParent, parked)
          fs.mkdirSync(cacheParent)
        }
        return fs.mkdirSync(targetPath, options)
      },
    }
    const before = appFingerprint(appDbPath)
    const service = createCacheService({ fileSystem })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(swapped, true)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('does not adopt a cache root replaced by a final pathname lookup', async() => {
    const { fixture, cacheRoot } = await createAppFixture({ prefix: 'cache-final-root-lookup' })
    const parked = path.join(fixture.path, 'parked-cache-root')
    fs.mkdirSync(cacheRoot)
    let swapped = false
    const fileSystem = {
      ...fs,
      lstatSync(targetPath, options) {
        const caller = new Error().stack?.split('\n').at(2) ?? ''
        if (path.resolve(String(targetPath)) == path.resolve(cacheRoot) && caller.includes('prepareCacheRoot')) {
          swapped = true
          fs.renameSync(cacheRoot, parked)
          fs.mkdirSync(cacheRoot)
        }
        return fs.lstatSync(targetPath, options)
      },
    }
    const service = createCacheService({ fileSystem })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'created', schemaVersion: 2, diagnostic: null,
    })
    assert.equal(swapped, false)
  })

  it('creates schema version 2 with the exact ownership tables, indexes, foreign keys, and ledger', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture()
    const before = appFingerprint(appDbPath)
    const service = createCacheService({ now: () => 1234 })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'created', schemaVersion: 2, diagnostic: null,
    })

    const cachePath = path.join(cacheRoot, 'cache.db')
    const inspection = new Database(cachePath, { readonly: true, fileMustExist: true })
    try {
      const tables = inspection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map(row => row.name)
      assert.deepEqual(tables, cacheTableNames)
      for (const [table, columns] of Object.entries(expectedColumns)) {
        assert.deepEqual(inspection.pragma(`table_info("${table}")`).map(row => row.name), columns)
      }
      assert.deepEqual(inspection.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND sql IS NOT NULL
        ORDER BY name
      `).all().map(row => row.name), [
        'music_urls_expiry',
        'music_urls_lru',
        'other_source_groups_expiry',
        'other_source_groups_lru',
        'raw_lyric_groups_lru',
      ])
      assert.deepEqual(inspection.pragma('foreign_key_list("raw_lyrics")').map(row => ({
        table: row.table, from: row.from, to: row.to, onDelete: row.on_delete,
      })), [
        { table: 'raw_lyric_groups', from: 'provider', to: 'provider', onDelete: 'CASCADE' },
        { table: 'raw_lyric_groups', from: 'source_track_id', to: 'source_track_id', onDelete: 'CASCADE' },
      ])
      assert.deepEqual(inspection.pragma('foreign_key_list("other_sources")').map(row => ({
        table: row.table, from: row.from, to: row.to, onDelete: row.on_delete,
      })), [
        { table: 'other_source_groups', from: 'original_provider', to: 'original_provider', onDelete: 'CASCADE' },
        { table: 'other_source_groups', from: 'original_track_id', to: 'original_track_id', onDelete: 'CASCADE' },
      ])
      const ledger = inspection.prepare(`
        SELECT version, name, checksum, applied_at_ms FROM cache_schema_migrations
        ORDER BY version
      `).all()
      assert.deepEqual(ledger.map(row => ({ version: row.version, name: row.name })), [
        { version: 1, name: 'cache_schema_v1' },
        { version: 2, name: 'cache_schema_v2_reported_quality' },
      ])
      assert.equal(ledger.every(row => /^[a-f0-9]{64}$/.test(row.checksum)), true)
      assert.equal(ledger.every(row => row.applied_at_ms == 1234), true)
      assert.equal(inspection.pragma('user_version', { simple: true }), 2)
      assert.equal(inspection.pragma('quick_check', { simple: true }), 'ok')
      assert.deepEqual(inspection.pragma('foreign_key_check'), [])
    } finally {
      inspection.close()
    }
    if (process.platform != 'win32') assert.equal(fs.statSync(cachePath).mode & 0o077, 0)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('applies private artifact modes through guarded descriptors instead of paths', async() => {
    const { appDbPath } = await createAppFixture({ prefix: 'cache-descriptor-mode' })
    const before = appFingerprint(appDbPath)
    let pathModeCalls = 0
    const guardedModeFs = {
      ...fs,
      chmodSync() {
        pathModeCalls++
        throw Object.assign(new Error('private-path-mode-race'), { code: 'EIO' })
      },
    }
    const service = createCacheService({ fileSystem: guardedModeFs })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'created', schemaVersion: 2, diagnostic: null,
    })
    assert.equal(pathModeCalls, 0)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('degrades without replacing malformed bytes, wrong schemas, or corrupt sidecars', async(t) => {
    const cases = [
      {
        name: 'malformed database bytes',
        diagnostic: 'cache_integrity_failed',
        seed(cachePath) { fs.writeFileSync(cachePath, 'not a sqlite database') },
      },
      {
        name: 'syntactically valid wrong schema',
        diagnostic: 'cache_schema_invalid',
        seed(cachePath) {
          const db = new Database(cachePath)
          db.exec('CREATE TABLE wrong_owner(id TEXT PRIMARY KEY); PRAGMA user_version = 1')
          db.close()
        },
      },
      {
        name: 'corrupt WAL',
        diagnostic: 'cache_integrity_failed',
        async seed(cachePath, service) {
          assert.equal((await service.openCacheDatabase()).status, 'created')
          await service.closeCacheDatabase()
          fs.writeFileSync(`${cachePath}-wal`, Buffer.alloc(64, 0x6b))
        },
      },
      {
        name: 'corrupt SHM',
        diagnostic: 'cache_integrity_failed',
        async seed(cachePath, service) {
          assert.equal((await service.openCacheDatabase()).status, 'created')
          await service.closeCacheDatabase()
          fs.writeFileSync(`${cachePath}-shm`, Buffer.alloc(64, 0x73))
        },
      },
    ]

    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-recreate' })
        fs.mkdirSync(cacheRoot, { recursive: true })
        const cachePath = path.join(cacheRoot, 'cache.db')
        const seedService = createCacheService()
        await testCase.seed(cachePath, seedService)
        await closeService(seedService)
        const artifactsBefore = cacheArtifactSnapshots(cachePath)
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: testCase.diagnostic,
        })
        assert.deepEqual(cacheArtifactSnapshots(cachePath), artifactsBefore)
        assert.equal(await service.getCacheLifecycleState(), 'unavailable')
        assert.deepEqual(await service.runCacheRead(() => assert.fail('cache handle was installed')), {
          status: 'unavailable', code: testCase.diagnostic,
        })
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('rejects an oversized existing image without reading or opening it through SQLite', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-preflight-main-bound' })
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    await seed.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${cachePath}${suffix}`)) fs.unlinkSync(`${cachePath}${suffix}`)
    }
    const descriptor = fs.openSync(cachePath, 'r+')
    try {
      fs.ftruncateSync(descriptor, MAX_CACHE_PREFLIGHT_BYTES + 4096)
    } finally {
      fs.closeSync(descriptor)
    }
    const prefix = Buffer.alloc(4096)
    const prefixDescriptor = fs.openSync(cachePath, 'r')
    try {
      assert.equal(fs.readSync(prefixDescriptor, prefix, 0, prefix.length, 0), prefix.length)
    } finally {
      fs.closeSync(prefixDescriptor)
    }
    const before = {
      identity: nodeIdentity(cachePath),
      size: fs.statSync(cachePath).size,
      prefix,
      app: appFingerprint(appDbPath),
    }
    let constructions = 0
    class CountingDatabase {
      constructor(filename, options) {
        constructions++
        return new Database(filename, options)
      }
    }
    const service = createCacheService({ DatabaseImplementation: CountingDatabase })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_capacity_unavailable',
    })
    assert.equal(constructions, 0)
    assert.deepEqual(nodeIdentity(cachePath), before.identity)
    assert.equal(fs.statSync(cachePath).size, before.size)
    const verifyDescriptor = fs.openSync(cachePath, 'r')
    try {
      const prefix = Buffer.alloc(4096)
      assert.equal(fs.readSync(verifyDescriptor, prefix, 0, prefix.length, 0), prefix.length)
      assert.deepEqual(prefix, before.prefix)
    } finally {
      fs.closeSync(verifyDescriptor)
    }
    assert.deepEqual(appFingerprint(appDbPath), before.app)
  })

  it('degrades without removing orphan corrupt WAL and SHM artifacts', async(t) => {
    for (const suffix of ['-wal', '-shm']) {
      await t.test(suffix.slice(1).toUpperCase(), async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-orphan-sidecar' })
        fs.mkdirSync(cacheRoot, { recursive: true })
        const cachePath = path.join(cacheRoot, 'cache.db')
        const sidecarPath = `${cachePath}${suffix}`
        fs.writeFileSync(sidecarPath, Buffer.alloc(64, 0x5a))
        const sidecarBefore = fileNodeSnapshot(sidecarPath)
        assert.equal(fs.existsSync(cachePath), false)
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
        })
        assert.equal(fs.existsSync(cachePath), false)
        assert.deepEqual(fileNodeSnapshot(sidecarPath), sidecarBefore)
        assert.equal(await service.getCacheLifecycleState(), 'unavailable')
        assert.deepEqual(await service.runCacheRead(() => assert.fail('cache handle was installed')), {
          status: 'unavailable', code: 'cache_integrity_failed',
        })
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('degrades without replacing structurally invalid sidecars with plausible headers', async(t) => {
    const cases = [
      {
        name: 'WAL',
        suffix: '-wal',
        bytes() {
          const value = Buffer.alloc(64)
          value.writeUInt32BE(0x377f0682, 0)
          return value
        },
      },
      {
        name: 'SHM',
        suffix: '-shm',
        bytes() {
          const value = Buffer.alloc(64)
          value[os.endianness() == 'LE' ? 'writeUInt32LE' : 'writeUInt32BE'](3007000, 0)
          return value
        },
      },
    ]
    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-sidecar-header' })
        const seed = createCacheService()
        assert.equal((await seed.openCacheDatabase()).status, 'created')
        await seed.closeCacheDatabase()
        const cachePath = path.join(cacheRoot, 'cache.db')
        const sidecarPath = `${cachePath}${testCase.suffix}`
        fs.writeFileSync(sidecarPath, testCase.bytes())
        const sidecarBefore = fileNodeSnapshot(sidecarPath)
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
        })
        assert.deepEqual(fileNodeSnapshot(sidecarPath), sidecarBefore)
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('degrades without replacing an aligned WAL with a corrupt commit frame', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-frame-checksum' })
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    await seed.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${cachePath}${suffix}`)) fs.unlinkSync(`${cachePath}${suffix}`)
    }

    const wal = Buffer.alloc(32 + 24 + 4096)
    wal.writeUInt32BE(0x377f0682, 0)
    wal.writeUInt32BE(3007000, 4)
    wal.writeUInt32BE(4096, 8)
    wal.writeUInt32BE(0, 12)
    wal.writeUInt32BE(0x12345678, 16)
    wal.writeUInt32BE(0x87654321, 20)
    wal.writeUInt32BE(0x4d3d3725, 24)
    wal.writeUInt32BE(0x26687451, 28)
    wal.writeUInt32BE(1, 32)
    wal.writeUInt32BE(1, 36)
    wal.writeUInt32BE(0x12345678, 40)
    wal.writeUInt32BE(0x87654321, 44)
    wal.fill(0x5a, 56)
    fs.writeFileSync(`${cachePath}-wal`, wal)
    const walBefore = fileNodeSnapshot(`${cachePath}-wal`)
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
    })
    assert.deepEqual(fileNodeSnapshot(`${cachePath}-wal`), walBefore)
    assert.deepEqual(appFingerprint(appDbPath), before)

    await closeService(service)
    dbService.close()
  })

  it('reconstructs schema and data that exist only in a committed WAL', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-only-state' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    assert.deepEqual(await seed.runCacheWrite(db => {
      db.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', 'wal-only', 0, 1, 1)
      `).run()
    }), { status: 'stored' })
    const databaseBytes = fs.readFileSync(cachePath)
    const walBytes = fs.readFileSync(`${cachePath}-wal`)
    const shmBytes = fs.readFileSync(`${cachePath}-shm`)
    assert.ok(walBytes.length > 32)

    const mainOnlyBytes = Buffer.from(databaseBytes)
    mainOnlyBytes[18] = 1
    mainOnlyBytes[19] = 1
    const mainOnly = new Database(mainOnlyBytes, { readonly: true })
    try {
      const { verifyCacheSchema } = require('../../src/main/worker/dbService/cacheSchemaContract.ts')
      assert.notDeepEqual(verifyCacheSchema(mainOnly), { ok: true })
    } finally {
      mainOnly.close()
    }
    await seed.closeCacheDatabase()

    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, walBytes)
    fs.writeFileSync(`${cachePath}-shm`, shmBytes)
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT provider FROM raw_lyric_groups WHERE source_track_id = 'wal-only'
    `).pluck().get()), { status: 'hit', value: 'tx' })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('rejects checksum-valid WAL frames that exceed reconstruction bounds', async(t) => {
    const cases = [
      {
        name: 'commit database size',
        diagnostic: 'cache_capacity_unavailable',
        mutate(wal, frame, maximumPage) { wal.writeUInt32BE(maximumPage + 1, frame + 4) },
      },
      {
        name: 'frame page number',
        diagnostic: 'cache_integrity_failed',
        mutate(wal, frame) { wal.writeUInt32BE(0xffffffff, frame) },
      },
    ]
    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-replay-bound' })
        const cachePath = path.join(cacheRoot, 'cache.db')
        const seed = createCacheService()
        assert.equal((await seed.openCacheDatabase()).status, 'created')
        assert.deepEqual(await seed.runCacheWrite(db => {
          db.prepare(`
            INSERT INTO raw_lyric_groups(
              provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
            ) VALUES ('tx', 'wal-bound', 0, 1, 1)
          `).run()
        }), { status: 'stored' })
        const databaseBytes = fs.readFileSync(cachePath)
        const walBytes = fs.readFileSync(`${cachePath}-wal`)
        const shmBytes = fs.readFileSync(`${cachePath}-shm`)
        await seed.closeCacheDatabase()

        const wal = Buffer.from(walBytes)
        const pageSize = wal.readUInt32BE(8)
        const maximumPage = Math.floor(MAX_CACHE_PREFLIGHT_BYTES / pageSize)
        testCase.mutate(wal, lastCommittedWalFrame(wal), maximumPage)
        rewriteWalChecksums(wal)
        fs.writeFileSync(cachePath, databaseBytes)
        fs.writeFileSync(`${cachePath}-wal`, wal)
        fs.writeFileSync(`${cachePath}-shm`, shmBytes)
        const artifactsBefore = cacheArtifactSnapshots(cachePath)
        const before = appFingerprint(appDbPath)
        let constructions = 0
        class CountingDatabase {
          constructor(filename, options) {
            constructions++
            return new Database(filename, options)
          }
        }
        const service = createCacheService({ DatabaseImplementation: CountingDatabase })

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: testCase.diagnostic,
        })
        assert.equal(constructions, 0)
        assert.deepEqual(cacheArtifactSnapshots(cachePath), artifactsBefore)
        assert.deepEqual(appFingerprint(appDbPath), before)
      })
    }
  })

  it('ignores a checksum-valid WAL that has no commit marker', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-no-commit' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    await seed.closeCacheDatabase()
    const databaseBytes = fs.readFileSync(cachePath)

    const writer = createCacheService()
    assert.equal((await writer.openCacheDatabase()).status, 'ready')
    assert.deepEqual(await writer.runCacheWrite(db => {
      db.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', 'not-committed', 0, 1, 1)
      `).run()
    }), { status: 'stored' })
    const wal = fs.readFileSync(`${cachePath}-wal`)
    const pageSize = wal.readUInt32BE(8)
    const frameSize = 24 + pageSize
    for (let position = 32; position + frameSize <= wal.length; position += frameSize) {
      wal.writeUInt32BE(0, position + 4)
    }
    rewriteWalChecksums(wal)
    await writer.closeCacheDatabase()

    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, wal)
    fs.writeFileSync(`${cachePath}-shm`, Buffer.alloc(32768))
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT provider FROM raw_lyric_groups WHERE source_track_id = 'not-committed'
    `).pluck().get()), { status: 'miss' })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('ignores a checksum-valid uncommitted frame after the last commit', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-uncommitted-tail' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    assert.deepEqual(await seed.runCacheWrite(db => {
      db.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', 'committed-prefix', 0, 1, 1)
      `).run()
    }), { status: 'stored' })
    const databaseBytes = fs.readFileSync(cachePath)
    const committedWal = fs.readFileSync(`${cachePath}-wal`)
    const shmBytes = fs.readFileSync(`${cachePath}-shm`)
    await seed.closeCacheDatabase()

    const pageSize = committedWal.readUInt32BE(8)
    const frame = Buffer.alloc(24 + pageSize)
    frame.writeUInt32BE(1, 0)
    frame.writeUInt32BE(committedWal.readUInt32BE(16), 8)
    frame.writeUInt32BE(committedWal.readUInt32BE(20), 12)
    const wal = Buffer.concat([committedWal, frame])
    rewriteWalChecksums(wal)
    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, wal)
    fs.writeFileSync(`${cachePath}-shm`, shmBytes)
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT provider FROM raw_lyric_groups WHERE source_track_id = 'committed-prefix'
    `).pluck().get()), { status: 'hit', value: 'tx' })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('reconstructs a valid grow-then-shrink WAL to the last commit size', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-grow-shrink' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    fs.mkdirSync(cacheRoot, { recursive: true })
    const writer = new Database(cachePath)
    let databaseBytes
    let walBytes
    let shmBytes
    try {
      writer.pragma('page_size = 512')
      writer.pragma('auto_vacuum = FULL')
      writer.pragma('foreign_keys = ON')
      writer.exec(CACHE_SCHEMA_SOURCE)
      writer.prepare(`
        INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(1, CACHE_MIGRATION_V1_NAME, CACHE_MIGRATION_V1_CHECKSUM, 1)
      writer.prepare(`
        INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
        VALUES (?, ?, ?, ?)
      `).run(CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM, 1)
      writer.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`)
      assert.equal(String(writer.pragma('journal_mode = WAL', { simple: true })).toLowerCase(), 'wal')
      writer.pragma('wal_autocheckpoint = 0')
      const insertGroup = writer.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', ?, ?, 1, 1)
      `)
      const insertLyric = writer.prepare(`
        INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size)
        VALUES ('tx', ?, 'lyric', ?, ?)
      `)
      const text = 'x'.repeat(4096)
      writer.transaction(() => {
        for (let index = 0; index < 256; index++) {
          const sourceTrackId = `grow-${index}`
          insertGroup.run(sourceTrackId, text.length)
          insertLyric.run(sourceTrackId, text, text.length)
        }
      })()
      writer.exec('DELETE FROM raw_lyric_groups')
      databaseBytes = fs.readFileSync(cachePath)
      walBytes = fs.readFileSync(`${cachePath}-wal`)
      shmBytes = fs.readFileSync(`${cachePath}-shm`)
    } finally {
      writer.close()
    }

    const pageSize = walBytes.readUInt32BE(8)
    const frameSize = 24 + pageSize
    let finalDatabasePages = 0
    let maximumFramePage = 0
    let commitCount = 0
    for (let position = 32; position + frameSize <= walBytes.length; position += frameSize) {
      maximumFramePage = Math.max(maximumFramePage, walBytes.readUInt32BE(position))
      const commitPages = walBytes.readUInt32BE(position + 4)
      if (commitPages != 0) {
        finalDatabasePages = commitPages
        commitCount++
      }
    }
    assert.ok(commitCount >= 2)
    assert.ok(maximumFramePage > finalDatabasePages)
    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, walBytes)
    fs.writeFileSync(`${cachePath}-shm`, shmBytes)
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT count(*) FROM raw_lyric_groups
    `).pluck().get()), { status: 'hit', value: 0 })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('keeps a valid committed WAL prefix when SQLite ignores an incomplete crash tail', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-crash-tail' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    assert.deepEqual(await seed.runCacheWrite(db => {
      db.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', 'crash-tail', 0, 1, 1)
      `).run()
    }), { status: 'stored' })
    const databaseBytes = fs.readFileSync(cachePath)
    const walBytes = fs.readFileSync(`${cachePath}-wal`)
    const shmBytes = fs.readFileSync(`${cachePath}-shm`)
    assert.ok(walBytes.length > 32)
    await seed.closeCacheDatabase()

    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, Buffer.concat([walBytes, Buffer.alloc(17, 0xa5)]))
    fs.writeFileSync(`${cachePath}-shm`, shmBytes)
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT provider FROM raw_lyric_groups WHERE source_track_id = 'crash-tail'
    `).pluck().get()), { status: 'hit', value: 'tx' })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('keeps a valid committed WAL prefix when SQLite ignores an invalid reuse frame', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-wal-reuse-tail' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    assert.deepEqual(await seed.runCacheWrite(db => {
      db.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', 'reuse-tail', 0, 1, 1)
      `).run()
    }), { status: 'stored' })
    const databaseBytes = fs.readFileSync(cachePath)
    const walBytes = fs.readFileSync(`${cachePath}-wal`)
    const shmBytes = fs.readFileSync(`${cachePath}-shm`)
    assert.ok(walBytes.length > 32)
    await seed.closeCacheDatabase()

    const pageSize = walBytes.readUInt32BE(8)
    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, Buffer.concat([walBytes, Buffer.alloc(24 + pageSize, 0xa5)]))
    fs.writeFileSync(`${cachePath}-shm`, shmBytes)
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT provider FROM raw_lyric_groups WHERE source_track_id = 'reuse-tail'
    `).pluck().get()), { status: 'hit', value: 'tx' })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('degrades without replacing a cache whose migration checksum no longer matches', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture()
    const first = createCacheService()
    assert.equal((await first.openCacheDatabase()).status, 'created')
    await first.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    const tamper = new Database(cachePath)
    tamper.prepare('UPDATE cache_schema_migrations SET checksum = ? WHERE version = 1').run('f'.repeat(64))
    tamper.close()
    const cacheBefore = nodeIdentity(cachePath)
    const schemaBefore = schemaSnapshot(cachePath)
    const before = appFingerprint(appDbPath)
    const replacement = createCacheService()

    assert.deepEqual(await replacement.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_schema_invalid',
    })
    assert.deepEqual(nodeIdentity(cachePath), cacheBefore)
    assert.deepEqual(schemaSnapshot(cachePath), schemaBefore)
    const check = new Database(cachePath, { readonly: true })
    assert.equal(check.prepare('SELECT checksum FROM cache_schema_migrations').get().checksum, 'f'.repeat(64))
    check.close()
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('degrades without replacing a cache whose persisted CHECK constraint was weakened', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-weakened-check' })
    const first = createCacheService()
    assert.equal((await first.openCacheDatabase()).status, 'created')
    await first.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    const tamper = new Database(cachePath)
    try {
      tamper.unsafeMode(true)
      const schemaVersion = tamper.pragma('schema_version', { simple: true })
      tamper.pragma('writable_schema = ON')
      const update = tamper.prepare(`
        UPDATE sqlite_schema
        SET sql = replace(sql, 'CHECK(byte_size >= 0)', 'CHECK(byte_size >= -1)')
        WHERE type = 'table' AND name = 'raw_lyric_groups'
      `).run()
      assert.equal(update.changes, 1)
      tamper.pragma(`schema_version = ${schemaVersion + 1}`)
    } finally {
      tamper.pragma('writable_schema = OFF')
      tamper.close()
    }
    const cacheBefore = nodeIdentity(cachePath)
    const schemaBefore = schemaSnapshot(cachePath)
    const before = appFingerprint(appDbPath)
    const replacement = createCacheService()

    assert.deepEqual(await replacement.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_schema_invalid',
    })
    assert.deepEqual(nodeIdentity(cachePath), cacheBefore)
    assert.deepEqual(schemaSnapshot(cachePath), schemaBefore)
    assert.equal(schemaBefore.find(row => row.name == 'raw_lyric_groups').sql.includes('byte_size >= -1'), true)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('degrades without replacing a cache whose deterministic index collation was changed', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-index-collation' })
    const first = createCacheService()
    assert.equal((await first.openCacheDatabase()).status, 'created')
    await first.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    const tamper = new Database(cachePath)
    tamper.exec(`
      DROP INDEX raw_lyric_groups_lru;
      CREATE INDEX raw_lyric_groups_lru
      ON raw_lyric_groups(
        last_accessed_at_ms, created_at_ms,
        provider COLLATE NOCASE, source_track_id COLLATE BINARY
      );
    `)
    tamper.close()
    const cacheBefore = nodeIdentity(cachePath)
    const schemaBefore = schemaSnapshot(cachePath)
    const before = appFingerprint(appDbPath)
    const replacement = createCacheService()

    assert.deepEqual(await replacement.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_schema_invalid',
    })
    assert.deepEqual(nodeIdentity(cachePath), cacheBefore)
    assert.deepEqual(schemaSnapshot(cachePath), schemaBefore)
    const check = new Database(cachePath, { readonly: true })
    try {
      const provider = check.pragma('index_xinfo("raw_lyric_groups_lru")')
        .find(row => row.name == 'provider')
      assert.equal(provider.coll, 'NOCASE')
      assert.equal(provider.desc, 0)
    } finally {
      check.close()
    }
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('degrades without replacing caches with extra checks, defaults, columns, views, or triggers', async(t) => {
    const cases = [
      {
        name: 'extra CHECK',
        mutate(db) {
          rewriteTableSql(
            db,
            'raw_lyric_groups',
            'PRIMARY KEY(provider, source_track_id)',
            "CHECK(provider <> ''), PRIMARY KEY(provider, source_track_id)",
          )
        },
      },
      {
        name: 'column default',
        mutate(db) {
          rewriteTableSql(db, 'raw_lyric_groups', 'provider TEXT NOT NULL,', "provider TEXT NOT NULL DEFAULT 'fallback',")
        },
      },
      {
        name: 'hidden generated column',
        mutate(db) {
          db.exec('ALTER TABLE raw_lyric_groups ADD COLUMN provider_copy TEXT GENERATED ALWAYS AS (provider) VIRTUAL')
        },
      },
      {
        name: 'extra view',
        mutate(db) {
          db.exec('CREATE VIEW unexpected_cache_view AS SELECT provider FROM raw_lyric_groups')
        },
      },
      {
        name: 'extra trigger',
        mutate(db) {
          db.exec(`
            CREATE TRIGGER unexpected_cache_trigger AFTER INSERT ON raw_lyric_groups
            BEGIN SELECT 1; END
          `)
        },
      },
    ]

    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-exact-schema' })
        const seed = createCacheService()
        assert.equal((await seed.openCacheDatabase()).status, 'created')
        await seed.closeCacheDatabase()
        const cachePath = path.join(cacheRoot, 'cache.db')
        const tamper = new Database(cachePath)
        try {
          testCase.mutate(tamper)
          tamper.pragma('wal_checkpoint(TRUNCATE)')
        } finally {
          tamper.close()
        }
        for (const suffix of ['-wal', '-shm']) {
          const sidecarPath = `${cachePath}${suffix}`
          if (fs.existsSync(sidecarPath)) fs.unlinkSync(sidecarPath)
        }
        const preflight = new Database(cachePath, { readonly: true, fileMustExist: true })
        try {
          const { verifyCacheSchema } = require('../../src/main/worker/dbService/cacheSchemaContract.ts')
          assert.deepEqual(verifyCacheSchema(preflight), {
            ok: false, diagnostic: 'cache_schema_invalid',
          })
        } finally {
          preflight.close()
        }
        const cacheBefore = nodeIdentity(cachePath)
        const schemaBefore = schemaSnapshot(cachePath)
        const before = appFingerprint(appDbPath)
        const replacement = createCacheService()

        assert.deepEqual(await replacement.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_schema_invalid',
        })
        assert.deepEqual(nodeIdentity(cachePath), cacheBefore)
        assert.deepEqual(schemaSnapshot(cachePath), schemaBefore)
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(replacement)
        dbService.close()
      })
    }
  })

  it('rejects table-level semantics outside the canonical cache v2 DDL', async(t) => {
    const cases = [
      {
        name: 'deferred foreign key',
        table: 'raw_lyrics',
        from: 'REFERENCES raw_lyric_groups(provider, source_track_id) ON DELETE CASCADE',
        to: `REFERENCES raw_lyric_groups(provider, source_track_id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED`,
        forbidden: /DEFERRABLE/i,
      },
      {
        name: 'primary-key conflict clause',
        table: 'raw_lyric_groups',
        from: 'PRIMARY KEY(provider, source_track_id)',
        to: 'PRIMARY KEY(provider, source_track_id) ON CONFLICT REPLACE',
        forbidden: /ON CONFLICT/i,
      },
      {
        name: 'STRICT table option',
        table: 'music_urls',
        from: 'PRIMARY KEY(provider, account_scope, source_track_id, quality)\n)',
        to: 'PRIMARY KEY(provider, account_scope, source_track_id, quality)\n) STRICT',
        forbidden: /\bSTRICT\b/i,
      },
      {
        name: 'WITHOUT ROWID table option',
        table: 'other_source_groups',
        from: 'PRIMARY KEY(original_provider, original_track_id)\n)',
        to: 'PRIMARY KEY(original_provider, original_track_id)\n) WITHOUT ROWID',
        forbidden: /WITHOUT\s+ROWID/i,
      },
    ]

    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-table-ddl' })
        const cachePath = path.join(cacheRoot, 'cache.db')
        const mutatedSource = CACHE_SCHEMA_SOURCE.replace(testCase.from, testCase.to)
        assert.notEqual(mutatedSource, CACHE_SCHEMA_SOURCE)
        createCacheFromSchemaSource(cachePath, mutatedSource)
        const before = appFingerprint(appDbPath)
        const preflight = new Database(cachePath, { readonly: true, fileMustExist: true })
        try {
          const { verifyCacheSchema } = require('../../src/main/worker/dbService/cacheSchemaContract.ts')
          assert.deepEqual(verifyCacheSchema(preflight), {
            ok: false, diagnostic: 'cache_schema_invalid',
          })
        } finally {
          preflight.close()
        }
        const cacheBefore = nodeIdentity(cachePath)
        const schemaBefore = schemaSnapshot(cachePath)
        const replacement = createCacheService()

        assert.deepEqual(await replacement.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_schema_invalid',
        })
        assert.deepEqual(nodeIdentity(cachePath), cacheBefore)
        assert.deepEqual(schemaSnapshot(cachePath), schemaBefore)
        const check = new Database(cachePath, { readonly: true, fileMustExist: true })
        try {
          const sql = check.prepare(`
            SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
          `).get(testCase.table).sql
          assert.equal(testCase.forbidden.test(sql), true)
        } finally {
          check.close()
        }
        assert.deepEqual(appFingerprint(appDbPath), before)
      })
    }
  })

  it('accepts canonical table DDL after stable whitespace and identifier-quote normalization', async() => {
    const { cacheRoot } = await createAppFixture({ prefix: 'cache-table-ddl-normalization' })
    const seed = createCacheService()
    assert.equal((await seed.openCacheDatabase()).status, 'created')
    await seed.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    const tamper = new Database(cachePath)
    try {
      rewriteTableSql(tamper, 'raw_lyric_groups',
        'CREATE TABLE raw_lyric_groups (', 'create\n  table "raw_lyric_groups" (')
      rewriteTableSql(tamper, 'raw_lyric_groups',
        'provider TEXT NOT NULL,', '[provider] text not null,')
      rewriteTableSql(tamper, 'raw_lyric_groups',
        'source_track_id TEXT NOT NULL,', '`source_track_id` TEXT NOT NULL,')
      rewriteTableSql(tamper, 'raw_lyric_groups',
        'PRIMARY KEY(provider, source_track_id)', 'primary key([provider], "source_track_id")')
      tamper.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      tamper.close()
    }
    const inspection = new Database(cachePath, { readonly: true, fileMustExist: true })
    try {
      const { verifyCacheSchema } = require('../../src/main/worker/dbService/cacheSchemaContract.ts')
      assert.deepEqual(verifyCacheSchema(inspection), { ok: true })
      assert.deepEqual(verifyCacheSchema(inspection), { ok: true })
    } finally {
      inspection.close()
    }
    const service = createCacheService()
    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'ready', schemaVersion: 2, diagnostic: null,
    })
  })

  it('rejects link and non-file cache targets without changing their targets or the app database', async(t) => {
    const directoryCase = await createAppFixture({ prefix: 'cache-invalid-directory' })
    fs.mkdirSync(directoryCase.cacheRoot, { recursive: true })
    fs.mkdirSync(path.join(directoryCase.cacheRoot, 'cache.db'))
    const directoryBefore = appFingerprint(directoryCase.appDbPath)
    const directoryService = createCacheService()
    assert.deepEqual(await directoryService.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(fs.lstatSync(path.join(directoryCase.cacheRoot, 'cache.db')).isDirectory(), true)
    assert.deepEqual(appFingerprint(directoryCase.appDbPath), directoryBefore)
    await closeService(directoryService)
    dbService.close()

    const linkCase = await createAppFixture({ prefix: 'cache-invalid-link' })
    fs.mkdirSync(linkCase.cacheRoot, { recursive: true })
    const external = path.join(linkCase.fixture.path, 'outside.db')
    const secret = 'external-cache-target-secret-8D22'
    fs.writeFileSync(external, secret)
    try {
      fs.symlinkSync(external, path.join(linkCase.cacheRoot, 'cache.db'), 'file')
    } catch (error) {
      if (process.platform == 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
        t.diagnostic(`file symlink unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const linkBefore = appFingerprint(linkCase.appDbPath)
    const linkService = createCacheService()
    assert.deepEqual(await linkService.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(fs.readFileSync(external, 'utf8'), secret)
    assert.deepEqual(appFingerprint(linkCase.appDbPath), linkBefore)
  })

  it('rejects pre-existing hard-linked cache database, WAL, and SHM artifacts', async(t) => {
    for (const artifactName of ['cache.db', 'cache.db-wal', 'cache.db-shm']) {
      await t.test(artifactName, async() => {
        const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-hard-link' })
        if (artifactName == 'cache.db') {
          fs.mkdirSync(cacheRoot, { recursive: true })
        } else {
          const seed = createCacheService()
          assert.equal((await seed.openCacheDatabase()).status, 'created')
          await seed.closeCacheDatabase()
        }
        const artifactPath = path.join(cacheRoot, artifactName)
        if (fs.existsSync(artifactPath) && artifactName != 'cache.db') fs.unlinkSync(artifactPath)
        const external = path.join(fixture.path, `outside-${artifactName}`)
        fs.writeFileSync(external, artifactName == 'cache.db' ? 'outside-cache-database' : '')
        fs.linkSync(external, artifactPath)
        const externalBefore = sha256File(external)
        const appBefore = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
        })
        assert.equal(sha256File(external), externalBefore)
        assert.equal(fs.statSync(external).nlink, 2)
        assert.deepEqual(appFingerprint(appDbPath), appBefore)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('rejects existing and dangling cache-root directory links before recursive creation', async(t) => {
    for (const dangling of [false, true]) {
      await t.test(dangling ? 'dangling link' : 'existing link', async() => {
        const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-root-link' })
        const externalRoot = path.join(fixture.path, dangling ? 'removed-cache-target' : 'outside-cache-root')
        fs.mkdirSync(externalRoot)
        try {
          fs.symlinkSync(externalRoot, cacheRoot, process.platform == 'win32' ? 'junction' : 'dir')
        } catch (error) {
          if (process.platform == 'win32' && ['EPERM', 'EACCES'].includes(error?.code)) {
            t.diagnostic(`directory link unavailable: ${error.code}`)
            dbService.close()
            return
          }
          throw error
        }
        if (dangling) fs.rmdirSync(externalRoot)
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
        })
        assert.equal(fs.lstatSync(cacheRoot).isSymbolicLink(), true)
        if (!dangling) assert.deepEqual(fs.readdirSync(externalRoot), [])
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('detects a visible target replacement at the SQLite open boundary', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-target-swap' })
    const initial = createCacheService()
    assert.equal((await initial.openCacheDatabase()).status, 'created')
    await initial.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    const parked = path.join(fixture.path, 'parked-cache.db')
    const external = path.join(fixture.path, 'external-cache.db')
    fs.copyFileSync(cachePath, external)
    const externalBefore = sha256File(external)
    const before = appFingerprint(appDbPath)
    let swapped = false
    class SwappingDatabase {
      constructor(filename, options) {
        if (!swapped && path.resolve(filename) == path.resolve(cachePath)) {
          fs.renameSync(cachePath, parked)
          fs.linkSync(external, cachePath)
          swapped = true
        }
        return new Database(filename, options)
      }
    }
    const service = createCacheService({ DatabaseImplementation: SwappingDatabase })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(swapped, true)
    assert.equal(sha256File(external), externalBefore)
    assert.equal(fs.existsSync(parked), true)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('revalidates artifact size after descriptor reading and before pathname open', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-preflight-size-race' })
    const initial = createCacheService()
    assert.equal((await initial.openCacheDatabase()).status, 'created')
    await initial.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(`${cachePath}${suffix}`)) fs.unlinkSync(`${cachePath}${suffix}`)
    }
    const identityBefore = nodeIdentity(cachePath)
    const sizeBefore = fs.statSync(cachePath).size
    const before = appFingerprint(appDbPath)
    let readObserved = false
    let injected = false
    let constructions = 0
    const changingFs = {
      ...fs,
      readSync(...args) {
        const bytesRead = fs.readSync(...args)
        readObserved = true
        return bytesRead
      },
      fstatSync(...args) {
        const stats = fs.fstatSync(...args)
        if (readObserved && !injected) {
          fs.appendFileSync(cachePath, Buffer.alloc(4096))
          injected = true
        }
        return stats
      },
    }
    class CountingDatabase {
      constructor(filename, options) {
        constructions++
        return new Database(filename, options)
      }
    }
    const service = createCacheService({
      fileSystem: changingFs,
      DatabaseImplementation: CountingDatabase,
    })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(readObserved, true)
    assert.equal(injected, true)
    assert.equal(constructions, 0)
    assert.deepEqual(nodeIdentity(cachePath), identityBefore)
    assert.equal(fs.statSync(cachePath).size, sizeBefore + 4096)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('rejects a sidecar replacement before SQLite can mutate its external hard-link target', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-sidecar-swap' })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const initial = createCacheService()
    assert.equal((await initial.openCacheDatabase()).status, 'created')
    const databaseBytes = fs.readFileSync(cachePath)
    const walBytes = fs.readFileSync(`${cachePath}-wal`)
    const shmBytes = fs.readFileSync(`${cachePath}-shm`)
    await initial.closeCacheDatabase()
    fs.writeFileSync(cachePath, databaseBytes)
    fs.writeFileSync(`${cachePath}-wal`, walBytes)
    fs.writeFileSync(`${cachePath}-shm`, shmBytes)

    const shmPath = `${cachePath}-shm`
    const parked = path.join(fixture.path, 'parked-cache.db-shm')
    const external = path.join(fixture.path, 'external-cache.db-shm')
    fs.writeFileSync(external, Buffer.alloc(32768))
    const externalBefore = sha256File(external)
    const before = appFingerprint(appDbPath)
    let swapped = false
    class SidecarSwappingDatabase {
      constructor(filename, options) {
        if (!swapped && path.resolve(filename) == path.resolve(cachePath)) {
          fs.renameSync(shmPath, parked)
          fs.linkSync(external, shmPath)
          swapped = true
        }
        return new Database(filename, options)
      }
    }
    const service = createCacheService({ DatabaseImplementation: SidecarSwappingDatabase })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(swapped, true)
    assert.equal(sha256File(external), externalBefore)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('does not start isolation when restoring a moved replacement would persistently fail', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-no-isolate-restore' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const parked = path.join(fixture.path, 'parked-owned-cache.db')
    const external = path.join(fixture.path, 'external-replacement.db')
    const quarantineId = '11111111-1111-4111-8111-111111111111'
    const quarantinePath = path.join(cacheRoot, `.cache.db.isolate-${quarantineId}`)
    fs.writeFileSync(cachePath, 'owned-corrupt-cache-6C42')
    fs.writeFileSync(external, 'external-replacement-6C42')
    const rootBefore = nodeIdentity(cacheRoot)
    const ownedBefore = fileNodeSnapshot(cachePath)
    const externalBefore = fileNodeSnapshot(external)
    const appBefore = appFingerprint(appDbPath)
    const destructiveCalls = []
    let injected = false
    let restoreAttempts = 0
    const faultFs = {
      ...fs,
      renameSync(source, destination) {
        destructiveCalls.push(['rename', path.resolve(source), path.resolve(destination)])
        if (!injected && path.resolve(source) == path.resolve(cachePath) &&
          path.resolve(destination) == path.resolve(quarantinePath)) {
          fs.renameSync(cachePath, parked)
          fs.linkSync(external, cachePath)
          injected = true
          return fs.renameSync(source, destination)
        }
        if (path.resolve(source) == path.resolve(quarantinePath) &&
          path.resolve(destination) == path.resolve(cachePath)) {
          restoreAttempts++
          throw Object.assign(new Error('persistent-restore-denied'), { code: 'EACCES' })
        }
        return fs.renameSync(source, destination)
      },
      unlinkSync(filename) {
        destructiveCalls.push(['unlink', path.resolve(filename)])
        return fs.unlinkSync(filename)
      },
      chmodSync(filename, mode) {
        destructiveCalls.push(['chmod', path.resolve(filename)])
        return fs.chmodSync(filename, mode)
      },
    }
    const service = createCacheService({ fileSystem: faultFs, randomUUID: () => quarantineId })

    const result = await service.openCacheDatabase()

    assert.deepEqual(destructiveCalls, [])
    assert.equal(injected, false)
    assert.equal(restoreAttempts, 0)
    assert.deepEqual(result, {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
    })
    assert.deepEqual(nodeIdentity(cacheRoot), rootBefore)
    assert.deepEqual(fileNodeSnapshot(cachePath), ownedBefore)
    assert.deepEqual(fileNodeSnapshot(external), externalBefore)
    assert.equal(fs.statSync(external).nlink, 1)
    assert.equal(fs.existsSync(parked), false)
    assert.equal(fs.existsSync(quarantinePath), false)
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
    assert.deepEqual(await service.runCacheRead(() => assert.fail('cache handle was installed')), {
      status: 'unavailable', code: 'cache_integrity_failed',
    })
    assert.deepEqual(appFingerprint(appDbPath), appBefore)
  })

  it('does not move a replacement when a new node would occupy the published path', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-no-isolate-occupied' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const parked = path.join(fixture.path, 'parked-owned-cache.db')
    const replacement = path.join(fixture.path, 'external-replacement.db')
    const occupant = path.join(fixture.path, 'new-published-occupant.db')
    const quarantineId = '22222222-2222-4222-8222-222222222222'
    const quarantinePath = path.join(cacheRoot, `.cache.db.isolate-${quarantineId}`)
    fs.writeFileSync(cachePath, 'owned-corrupt-cache-71A4')
    fs.writeFileSync(replacement, 'external-replacement-71A4')
    fs.writeFileSync(occupant, 'new-published-occupant-71A4')
    const rootBefore = nodeIdentity(cacheRoot)
    const ownedBefore = fileNodeSnapshot(cachePath)
    const replacementBefore = fileNodeSnapshot(replacement)
    const occupantBefore = fileNodeSnapshot(occupant)
    const appBefore = appFingerprint(appDbPath)
    const destructiveCalls = []
    let injected = false
    const swappingFs = {
      ...fs,
      renameSync(source, destination) {
        destructiveCalls.push(['rename', path.resolve(source), path.resolve(destination)])
        if (!injected && path.resolve(source) == path.resolve(cachePath) &&
          path.resolve(destination) == path.resolve(quarantinePath)) {
          fs.renameSync(cachePath, parked)
          fs.linkSync(replacement, cachePath)
          fs.renameSync(source, destination)
          fs.linkSync(occupant, cachePath)
          injected = true
          return
        }
        return fs.renameSync(source, destination)
      },
      unlinkSync(filename) {
        destructiveCalls.push(['unlink', path.resolve(filename)])
        return fs.unlinkSync(filename)
      },
      chmodSync(filename, mode) {
        destructiveCalls.push(['chmod', path.resolve(filename)])
        return fs.chmodSync(filename, mode)
      },
    }
    const service = createCacheService({ fileSystem: swappingFs, randomUUID: () => quarantineId })

    const result = await service.openCacheDatabase()

    assert.deepEqual(destructiveCalls, [])
    assert.equal(injected, false)
    assert.deepEqual(result, {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
    })
    assert.deepEqual(nodeIdentity(cacheRoot), rootBefore)
    assert.deepEqual(fileNodeSnapshot(cachePath), ownedBefore)
    assert.deepEqual(fileNodeSnapshot(replacement), replacementBefore)
    assert.deepEqual(fileNodeSnapshot(occupant), occupantBefore)
    assert.equal(fs.statSync(replacement).nlink, 1)
    assert.equal(fs.statSync(occupant).nlink, 1)
    assert.equal(fs.existsSync(parked), false)
    assert.equal(fs.existsSync(quarantinePath), false)
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
    assert.deepEqual(await service.runCacheRead(() => assert.fail('cache handle was installed')), {
      status: 'unavailable', code: 'cache_integrity_failed',
    })
    assert.deepEqual(appFingerprint(appDbPath), appBefore)
  })

  it('does not isolate through an equivalent cache-root identity replacement', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-no-isolate-root' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const parkedRoot = path.join(fixture.path, 'parked-owned-cache-root')
    const replacement = path.join(fixture.path, 'replacement-root-cache.db')
    const quarantineId = '33333333-3333-4333-8333-333333333333'
    const quarantinePath = path.join(cacheRoot, `.cache.db.isolate-${quarantineId}`)
    fs.writeFileSync(cachePath, 'owned-corrupt-cache-root-9E17')
    fs.writeFileSync(replacement, 'replacement-root-cache-9E17')
    const rootBefore = nodeIdentity(cacheRoot)
    const ownedBefore = fileNodeSnapshot(cachePath)
    const replacementBefore = fileNodeSnapshot(replacement)
    const appBefore = appFingerprint(appDbPath)
    const destructiveCalls = []
    let injected = false
    const swappingFs = {
      ...fs,
      renameSync(source, destination) {
        destructiveCalls.push(['rename', path.resolve(source), path.resolve(destination)])
        if (!injected && path.resolve(source) == path.resolve(cachePath) &&
          path.resolve(destination) == path.resolve(quarantinePath)) {
          fs.renameSync(cacheRoot, parkedRoot)
          fs.mkdirSync(cacheRoot)
          fs.linkSync(replacement, cachePath)
          injected = true
        }
        return fs.renameSync(source, destination)
      },
      unlinkSync(filename) {
        destructiveCalls.push(['unlink', path.resolve(filename)])
        return fs.unlinkSync(filename)
      },
      chmodSync(filename, mode) {
        destructiveCalls.push(['chmod', path.resolve(filename)])
        return fs.chmodSync(filename, mode)
      },
    }
    const service = createCacheService({ fileSystem: swappingFs, randomUUID: () => quarantineId })

    const result = await service.openCacheDatabase()

    assert.deepEqual(destructiveCalls, [])
    assert.equal(injected, false)
    assert.deepEqual(result, {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
    })
    assert.deepEqual(nodeIdentity(cacheRoot), rootBefore)
    assert.deepEqual(fileNodeSnapshot(cachePath), ownedBefore)
    assert.deepEqual(fileNodeSnapshot(replacement), replacementBefore)
    assert.equal(fs.statSync(replacement).nlink, 1)
    assert.equal(fs.existsSync(parkedRoot), false)
    assert.equal(fs.existsSync(quarantinePath), false)
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
    assert.deepEqual(await service.runCacheRead(() => assert.fail('cache handle was installed')), {
      status: 'unavailable', code: 'cache_integrity_failed',
    })
    assert.deepEqual(appFingerprint(appDbPath), appBefore)
  })

  it('maps open failures to fixed non-secret diagnostics and preserves authoritative access', async(t) => {
    const cases = [
      { code: 'ENOSPC', expected: 'cache_capacity_unavailable' },
      { code: 'SQLITE_FULL', expected: 'cache_capacity_unavailable' },
      { code: 'EACCES', expected: 'cache_open_failed' },
      { code: 'INJECTED_PRIVATE_4B7E', expected: 'cache_open_failed' },
    ]
    for (const testCase of cases) {
      await t.test(testCase.code, async() => {
        const { db, appDbPath } = await createAppFixture({ prefix: 'cache-open-fault' })
        const before = appFingerprint(appDbPath)
        class FailingDatabase {
          constructor() {
            throw Object.assign(new Error(`private-path-and-url-${testCase.code}`), { code: testCase.code })
          }
        }
        const service = createCacheService({ DatabaseImplementation: FailingDatabase })

        const result = await service.openCacheDatabase()

        assert.deepEqual(result, {
          status: 'unavailable', schemaVersion: null, diagnostic: testCase.expected,
        })
        assert.equal(JSON.stringify(result).includes('private-path-and-url'), false)
        assert.equal(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '6')
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('does not invoke pathname deletion while degrading a corrupt cache', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-no-delete' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    fs.writeFileSync(cachePath, 'malformed-cache-secret-31D9')
    const cacheBefore = fileNodeSnapshot(cachePath)
    const before = appFingerprint(appDbPath)
    const destructiveCalls = []
    const faultFs = {
      ...fs,
      renameSync(source, destination) {
        destructiveCalls.push(['rename', path.resolve(source), path.resolve(destination)])
        return fs.renameSync(source, destination)
      },
      unlinkSync(filename) {
        destructiveCalls.push(['unlink', path.resolve(filename)])
        return fs.unlinkSync(filename)
      },
      chmodSync(filename, mode) {
        destructiveCalls.push(['chmod', path.resolve(filename)])
        return fs.chmodSync(filename, mode)
      },
    }
    const service = createCacheService({ fileSystem: faultFs })

    const result = await service.openCacheDatabase()

    assert.deepEqual(result, {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_integrity_failed',
    })
    assert.deepEqual(destructiveCalls, [])
    assert.equal(JSON.stringify(result).includes('31D9'), false)
    assert.deepEqual(fileNodeSnapshot(cachePath), cacheBefore)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })
})
