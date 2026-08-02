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
  CACHE_SCHEMA_VERSION,
} = require('../../src/main/worker/dbService/cacheMigrate.ts')
const { CACHE_SCHEMA_SOURCE } = require('../../src/main/worker/dbService/cacheTables.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const cacheModulePath = '../../src/main/worker/dbService/cacheDb.ts'
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

const createAppFixture = async({ withPrerequisite = true, prefix = 'cache-db' } = {}) => {
  const fixture = createTestStorageRoot(prefix)
  fixtures.push(fixture)
  const profileRoot = path.join(fixture.path, 'profile')
  const cacheRoot = path.join(fixture.path, 'cache')
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
  return { fixture, profileRoot, cacheRoot, backupsRoot, appDbPath, db }
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
    `).run(CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM, 1)
    db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`)
  } finally {
    db.close()
  }
}

describe('guarded cache database', () => {
  it('does not touch the cache target before the Phase 3 prerequisite', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ withPrerequisite: false })
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    await assert.rejects(service.openCacheDatabase(), error =>
      error?.message == 'cache_phase3_prerequisite_invalid' &&
      error?.code == 'cache_phase3_prerequisite_invalid')

    assert.equal(fs.existsSync(cacheRoot), false)
    assert.deepEqual(appFingerprint(appDbPath), before)
    assert.equal(await service.getCacheLifecycleState(), 'closed')
  })

  it('creates schema version 1 with the exact ownership tables, indexes, foreign keys, and ledger', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture()
    const before = appFingerprint(appDbPath)
    const service = createCacheService({ now: () => 1234 })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'created', schemaVersion: 1, diagnostic: null,
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
      `).get()
      assert.equal(ledger.version, 1)
      assert.equal(ledger.name, 'cache_schema_v1')
      assert.match(ledger.checksum, /^[a-f0-9]{64}$/)
      assert.equal(ledger.applied_at_ms, 1234)
      assert.equal(inspection.pragma('user_version', { simple: true }), 1)
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
      status: 'created', schemaVersion: 1, diagnostic: null,
    })
    assert.equal(pathModeCalls, 0)
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('recreates malformed bytes, wrong schemas, wrong checksums, and corrupt sidecars', async(t) => {
    const cases = [
      {
        name: 'malformed database bytes',
        seed(cachePath) { fs.writeFileSync(cachePath, 'not a sqlite database') },
      },
      {
        name: 'syntactically valid wrong schema',
        seed(cachePath) {
          const db = new Database(cachePath)
          db.exec('CREATE TABLE wrong_owner(id TEXT PRIMARY KEY); PRAGMA user_version = 1')
          db.close()
        },
      },
      {
        name: 'corrupt WAL',
        async seed(cachePath, service) {
          assert.equal((await service.openCacheDatabase()).status, 'created')
          await service.closeCacheDatabase()
          fs.writeFileSync(`${cachePath}-wal`, Buffer.alloc(64, 0x6b))
        },
      },
      {
        name: 'corrupt SHM',
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
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'recreated', schemaVersion: 1, diagnostic: null,
        })
        const inspection = new Database(cachePath, { readonly: true })
        try {
          assert.equal(inspection.pragma('quick_check', { simple: true }), 'ok')
        } finally {
          inspection.close()
        }
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('recreates orphan corrupt WAL and SHM artifacts in the first open call', async(t) => {
    for (const suffix of ['-wal', '-shm']) {
      await t.test(suffix.slice(1).toUpperCase(), async() => {
        const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-orphan-sidecar' })
        fs.mkdirSync(cacheRoot, { recursive: true })
        const cachePath = path.join(cacheRoot, 'cache.db')
        fs.writeFileSync(`${cachePath}${suffix}`, Buffer.alloc(64, 0x5a))
        assert.equal(fs.existsSync(cachePath), false)
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'recreated', schemaVersion: 1, diagnostic: null,
        })
        const inspection = new Database(cachePath, { readonly: true, fileMustExist: true })
        try {
          assert.equal(inspection.pragma('quick_check', { simple: true }), 'ok')
        } finally {
          inspection.close()
        }
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('recreates structurally invalid sidecars with plausible first header words', async(t) => {
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
        fs.writeFileSync(`${cachePath}${testCase.suffix}`, testCase.bytes())
        const before = appFingerprint(appDbPath)
        const service = createCacheService()

        assert.deepEqual(await service.openCacheDatabase(), {
          status: 'recreated', schemaVersion: 1, diagnostic: null,
        })
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(service)
        dbService.close()
      })
    }
  })

  it('recreates an aligned WAL with a valid header and corrupt commit frame', async() => {
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
    const before = appFingerprint(appDbPath)
    const service = createCacheService()

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'recreated', schemaVersion: 1, diagnostic: null,
    })
    assert.deepEqual(appFingerprint(appDbPath), before)

    await closeService(service)
    dbService.close()
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
      status: 'ready', schemaVersion: 1, diagnostic: null,
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
      status: 'ready', schemaVersion: 1, diagnostic: null,
    })
    assert.deepEqual(await service.runCacheRead(db => db.prepare(`
      SELECT provider FROM raw_lyric_groups WHERE source_track_id = 'reuse-tail'
    `).pluck().get()), { status: 'hit', value: 'tx' })
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('recreates a valid cache whose migration checksum no longer matches', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture()
    const first = createCacheService()
    assert.equal((await first.openCacheDatabase()).status, 'created')
    await first.closeCacheDatabase()
    const cachePath = path.join(cacheRoot, 'cache.db')
    const tamper = new Database(cachePath)
    tamper.prepare('UPDATE cache_schema_migrations SET checksum = ? WHERE version = 1').run('f'.repeat(64))
    tamper.close()
    const before = appFingerprint(appDbPath)
    const replacement = createCacheService()

    assert.deepEqual(await replacement.openCacheDatabase(), {
      status: 'recreated', schemaVersion: 1, diagnostic: null,
    })
    const check = new Database(cachePath, { readonly: true })
    assert.notEqual(check.prepare('SELECT checksum FROM cache_schema_migrations').get().checksum, 'f'.repeat(64))
    check.close()
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('recreates a cache whose persisted CHECK constraint was weakened', async() => {
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
    const before = appFingerprint(appDbPath)
    const replacement = createCacheService()

    assert.deepEqual(await replacement.openCacheDatabase(), {
      status: 'recreated', schemaVersion: 1, diagnostic: null,
    })
    const check = new Database(cachePath)
    try {
      assert.throws(() => check.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('tx', 'negative', -1, 1, 1)
      `).run(), error => error?.code == 'SQLITE_CONSTRAINT_CHECK')
    } finally {
      check.close()
    }
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('recreates a cache whose deterministic index collation was changed', async() => {
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
    const before = appFingerprint(appDbPath)
    const replacement = createCacheService()

    assert.deepEqual(await replacement.openCacheDatabase(), {
      status: 'recreated', schemaVersion: 1, diagnostic: null,
    })
    const check = new Database(cachePath, { readonly: true })
    try {
      const provider = check.pragma('index_xinfo("raw_lyric_groups_lru")')
        .find(row => row.name == 'provider')
      assert.equal(provider.coll, 'BINARY')
      assert.equal(provider.desc, 0)
    } finally {
      check.close()
    }
    assert.deepEqual(appFingerprint(appDbPath), before)
  })

  it('recreates caches with extra checks, defaults, hidden columns, views, or triggers', async(t) => {
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
        const before = appFingerprint(appDbPath)
        const replacement = createCacheService()

        assert.deepEqual(await replacement.openCacheDatabase(), {
          status: 'recreated', schemaVersion: 1, diagnostic: null,
        })
        const check = new Database(cachePath, { readonly: true, fileMustExist: true })
        try {
          const columns = check.pragma('table_xinfo("raw_lyric_groups")')
          assert.deepEqual(columns.map(row => row.name), expectedColumns.raw_lyric_groups)
          assert.equal(columns.every(row => row.dflt_value == null && row.hidden == 0), true)
          assert.equal(check.prepare(`
            SELECT count(*) count FROM sqlite_master WHERE type IN ('view', 'trigger')
          `).get().count, 0)
          assert.equal(check.prepare(`
            SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'raw_lyric_groups'
          `).get().sql.includes("provider <> ''"), false)
        } finally {
          check.close()
        }
        assert.deepEqual(appFingerprint(appDbPath), before)

        await closeService(replacement)
        dbService.close()
      })
    }
  })

  it('rejects table-level semantics outside the canonical cache v1 DDL', async(t) => {
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
        const replacement = createCacheService()

        assert.deepEqual(await replacement.openCacheDatabase(), {
          status: 'recreated', schemaVersion: 1, diagnostic: null,
        })
        const check = new Database(cachePath, { readonly: true, fileMustExist: true })
        try {
          const sql = check.prepare(`
            SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
          `).get(testCase.table).sql
          assert.equal(testCase.forbidden.test(sql), false)
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
      status: 'ready', schemaVersion: 1, diagnostic: null,
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

  it('restores the exact artifact moved by an isolation-boundary replacement', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-isolate-artifact-swap' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const parked = path.join(fixture.path, 'parked-owned-cache.db')
    const external = path.join(fixture.path, 'external-replacement.db')
    const quarantineId = '11111111-1111-4111-8111-111111111111'
    const quarantinePath = path.join(cacheRoot, `.cache.db.isolate-${quarantineId}`)
    fs.writeFileSync(cachePath, 'owned-corrupt-cache-6C42')
    fs.writeFileSync(external, 'external-replacement-6C42')
    const ownedBefore = fileNodeSnapshot(cachePath)
    const externalBefore = fileNodeSnapshot(external)
    const appBefore = appFingerprint(appDbPath)
    const unlinkedQuarantines = []
    let replacementBeforeMove
    let injected = false
    const swappingFs = {
      ...fs,
      renameSync(source, destination) {
        if (!injected && path.resolve(source) == path.resolve(cachePath) &&
          path.resolve(destination) == path.resolve(quarantinePath)) {
          fs.renameSync(cachePath, parked)
          fs.linkSync(external, cachePath)
          replacementBeforeMove = fileNodeSnapshot(cachePath)
          injected = true
        }
        return fs.renameSync(source, destination)
      },
      unlinkSync(filename) {
        if (path.resolve(filename) == path.resolve(quarantinePath)) unlinkedQuarantines.push(filename)
        return fs.unlinkSync(filename)
      },
    }
    const service = createCacheService({
      fileSystem: swappingFs,
      randomUUID: () => quarantineId,
    })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(injected, true)
    assert.deepEqual(unlinkedQuarantines, [])
    assert.equal(fs.existsSync(cachePath), true, 'moved replacement was not restored')
    assert.deepEqual(fileNodeSnapshot(cachePath), replacementBeforeMove)
    assert.deepEqual(fileNodeSnapshot(external), externalBefore)
    assert.deepEqual(fileNodeSnapshot(parked), ownedBefore)
    assert.equal(fs.existsSync(quarantinePath), false)
    assert.deepEqual(appFingerprint(appDbPath), appBefore)
  })

  it('restores the exact artifact moved after a cache-root replacement', async() => {
    const { fixture, cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-isolate-root-swap' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    const parkedRoot = path.join(fixture.path, 'parked-owned-cache-root')
    const quarantineId = '22222222-2222-4222-8222-222222222222'
    const quarantinePath = path.join(cacheRoot, `.cache.db.isolate-${quarantineId}`)
    fs.writeFileSync(cachePath, 'owned-corrupt-cache-root-9E17')
    const ownedRootBefore = nodeIdentity(cacheRoot)
    const ownedBefore = fileNodeSnapshot(cachePath)
    const appBefore = appFingerprint(appDbPath)
    const unlinkedQuarantines = []
    let replacementRootBefore
    let replacementBeforeMove
    let injected = false
    const swappingFs = {
      ...fs,
      renameSync(source, destination) {
        if (!injected && path.resolve(source) == path.resolve(cachePath) &&
          path.resolve(destination) == path.resolve(quarantinePath)) {
          fs.renameSync(cacheRoot, parkedRoot)
          fs.mkdirSync(cacheRoot)
          fs.writeFileSync(cachePath, 'replacement-root-cache-9E17')
          replacementRootBefore = nodeIdentity(cacheRoot)
          replacementBeforeMove = fileNodeSnapshot(cachePath)
          injected = true
        }
        return fs.renameSync(source, destination)
      },
      unlinkSync(filename) {
        if (path.resolve(filename) == path.resolve(quarantinePath)) unlinkedQuarantines.push(filename)
        return fs.unlinkSync(filename)
      },
    }
    const service = createCacheService({
      fileSystem: swappingFs,
      randomUUID: () => quarantineId,
    })

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(injected, true)
    assert.deepEqual(unlinkedQuarantines, [])
    assert.deepEqual(nodeIdentity(cacheRoot), replacementRootBefore)
    assert.equal(fs.existsSync(cachePath), true, 'root replacement artifact was not restored')
    assert.deepEqual(fileNodeSnapshot(cachePath), replacementBeforeMove)
    assert.deepEqual(nodeIdentity(parkedRoot), ownedRootBefore)
    assert.deepEqual(fileNodeSnapshot(path.join(parkedRoot, 'cache.db')), ownedBefore)
    assert.equal(fs.existsSync(quarantinePath), false)
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

  it('reports a fixed delete failure while isolating corrupt cache artifacts', async() => {
    const { cacheRoot, appDbPath } = await createAppFixture({ prefix: 'cache-delete-fault' })
    fs.mkdirSync(cacheRoot, { recursive: true })
    const cachePath = path.join(cacheRoot, 'cache.db')
    fs.writeFileSync(cachePath, 'malformed-cache-secret-31D9')
    const before = appFingerprint(appDbPath)
    const faultFs = {
      ...fs,
      renameSync(source, destination) {
        if (path.resolve(source) == path.resolve(cachePath)) {
          throw Object.assign(new Error('private-delete-path-31D9'), { code: 'EACCES' })
        }
        return fs.renameSync(source, destination)
      },
    }
    const service = createCacheService({ fileSystem: faultFs })

    const result = await service.openCacheDatabase()

    assert.deepEqual(result, {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_delete_failed',
    })
    assert.equal(JSON.stringify(result).includes('31D9'), false)
    assert.equal(fs.readFileSync(cachePath, 'utf8'), 'malformed-cache-secret-31D9')
    assert.deepEqual(appFingerprint(appDbPath), before)
  })
})
