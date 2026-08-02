const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

require.extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')
const dbService = require('../../src/main/worker/dbService/db.ts')
const cacheDb = require('../../src/main/worker/dbService/cacheDb.ts')

const fixtures = []
const markerName = 'legacy_data_v1.cross_artifact_complete'
const nowMs = 1_000
const smallPolicy = {
  musicUrls: { fallbackTtlMs: 50, maxEntries: 2 },
  rawLyrics: { maxBytes: 1_000, maxTracks: 2, maxIdleMs: 100 },
  otherSources: { ttlMs: 100, maxBytes: 10 },
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const installPhase3Marker = () => {
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
  dbService.getAppDB().prepare(`
    INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(markerName, crypto.createHash('sha256').update(detailsJson).digest('hex'), 1, detailsJson)
}

const createFixture = async(name = 'cache-policy') => {
  const fixture = createTestStorageRoot(name)
  fixtures.push(fixture)
  const result = await dbService.init({
    dataPath: path.join(fixture.path, 'profile'),
    cacheRoot: path.join(fixture.path, 'cache'),
    backupsRoot: path.join(fixture.path, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(result.status, 'ready')
  installPhase3Marker()
  assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
  return fixture
}

const lifecycleModule = () => require('../../src/main/worker/dbService/modules/cacheLifecycle/prune.ts')

const createPruner = (overrides = {}) => lifecycleModule().createCachePruner({
  runImmediate: cacheDb.runCacheImmediate,
  policy: smallPolicy,
  ...overrides,
})

const seedUrl = (db, {
  provider = 'tx', scope = 'profile-v1:uin:7', track, quality = '320k',
  expiry = 2_000, created = 10, accessed = 20,
}) => db.prepare(`
  INSERT INTO music_urls(
    provider, account_scope, source_track_id, quality, url,
    expires_at_ms, created_at_ms, last_accessed_at_ms
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(provider, scope, track, quality, `https://media.invalid/${track}`, expiry, created, accessed)

const seedRaw = (db, provider, track, texts, { created = 10, accessed = 950 } = {}) => {
  const entries = Object.entries(texts)
  const total = entries.reduce((sum, [, text]) => sum + Buffer.byteLength(text, 'utf8'), 0)
  db.prepare(`
    INSERT INTO raw_lyric_groups(provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(provider, track, total, created, accessed)
  const insert = db.prepare(`
    INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size)
    VALUES (?, ?, ?, ?, ?)
  `)
  for (const [type, text] of entries) insert.run(provider, track, type, text, Buffer.byteLength(text, 'utf8'))
}

const seedOther = (db, provider, track, candidateIds, {
  expiry = 2_000, created = 10, accessed = 20,
} = {}) => {
  const rows = candidateIds.map((id, rank) => {
    const json = JSON.stringify({ id, name: '', singer: '', source: 'tx', interval: null, meta: {} })
    return { id, rank, json, bytes: Buffer.byteLength(json, 'utf8') }
  })
  db.prepare(`
    INSERT INTO other_source_groups(
      original_provider, original_track_id, byte_size, expires_at_ms, created_at_ms, last_accessed_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(provider, track, rows.reduce((sum, row) => sum + row.bytes, 0), expiry, created, accessed)
  const insert = db.prepare(`
    INSERT INTO other_sources(
      original_provider, original_track_id, rank, candidate_provider,
      candidate_track_id, candidate_json, byte_size
    ) VALUES (?, ?, ?, 'tx', ?, ?, ?)
  `)
  for (const row of rows) insert.run(provider, track, row.rank, row.id, row.json, row.bytes)
  return rows.reduce((sum, row) => sum + row.bytes, 0)
}

const seed = async(operation) => {
  const result = await cacheDb.runCacheImmediate(operation)
  assert.equal(result.status, 'completed')
}

afterEach(async() => {
  try { await cacheDb.closeCacheDatabase() } catch {}
  try { dbService.close() } catch {}
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
  for (const modulePath of [
    '../../src/main/worker/dbService/modules/cacheLifecycle/prune.ts',
    '../../src/main/worker/dbService/modules/cacheLifecycle/index.ts',
    '../../src/main/worker/dbService/modules/music_url/index.ts',
    '../../src/main/worker/dbService/modules/music_other_source/index.ts',
    '../../src/main/worker/dbService/modules/lyric/raw/repository.ts',
  ]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
})

describe('deterministic cache policy', () => {
  it('expires first and breaks equal LRU ties by binary owner keys without partial groups', async() => {
    await createFixture()
    const otherBytes = await cacheDb.runCacheImmediate(db => {
      seedUrl(db, { track: 'expired', expiry: nowMs })
      for (const track of ['b', 'a', 'c']) seedUrl(db, { track })
      seedRaw(db, 'z', 'expired', { lyric: 'old' }, { accessed: nowMs - smallPolicy.rawLyrics.maxIdleMs })
      seedRaw(db, 'b', '2', { lyric: 'b2' })
      seedRaw(db, 'a', '2', { lyric: 'a2' })
      seedRaw(db, 'a', '1', { lyric: 'a', tlyric: 't', rlyric: 'r', lxlyric: 'x' })
      const expired = seedOther(db, 'z', 'expired', ['expired'], { expiry: nowMs })
      const first = seedOther(db, 'b', '2', ['b'])
      const second = seedOther(db, 'a', '2', ['a'])
      const third = seedOther(db, 'a', '1', ['c'])
      return { expired, first, second, third }
    })
    assert.equal(otherBytes.status, 'completed')
    const policy = {
      ...smallPolicy,
      otherSources: { ...smallPolicy.otherSources, maxBytes: otherBytes.value.first + otherBytes.value.second },
    }

    const result = await createPruner({ policy }).prune({ nowMs, batchSize: 1 })

    assert.equal(result.status, 'completed')
    assert.deepEqual(result.musicUrls.expiredKeys, ['tx:profile-v1:uin:7:expired:320k'])
    assert.deepEqual(result.musicUrls.evictedKeys, ['tx:profile-v1:uin:7:a:320k'])
    assert.deepEqual(result.rawLyrics.expiredOwners, ['z:expired'])
    assert.deepEqual(result.rawLyrics.evictedOwners, ['a:1'])
    assert.deepEqual(result.otherSources.expiredOwners, ['z:expired'])
    assert.deepEqual(result.otherSources.evictedOwners, ['a:1'])
    assert.equal(result.rawLyrics.bytesAfter, 4)
    assert.equal(result.rawLyrics.ownerGroupsAfter, 2)
    assert.equal(result.rawLyrics.rowsAfter, 2)
    assert.equal(result.otherSources.bytesAfter, otherBytes.value.first + otherBytes.value.second)
    assert.deepEqual(await cacheDb.runCacheRead(db => ({
      urls: db.prepare(`SELECT source_track_id AS id FROM music_urls ORDER BY id COLLATE BINARY`).all(),
      raw: db.prepare(`SELECT provider, source_track_id AS id FROM raw_lyrics ORDER BY provider COLLATE BINARY, id COLLATE BINARY`).all(),
      other: db.prepare(`SELECT original_provider AS provider, original_track_id AS id FROM other_source_groups ORDER BY provider COLLATE BINARY, id COLLATE BINARY`).all(),
    })), {
      status: 'hit',
      value: {
        urls: [{ id: 'b' }, { id: 'c' }],
        raw: [{ provider: 'a', id: '2' }, { provider: 'b', id: '2' }],
        other: [{ provider: 'a', id: '2' }, { provider: 'b', id: '2' }],
      },
    })
  })

  it('keeps exact cap boundaries and reports exact UTF-8 group sums', async() => {
    await createFixture()
    const rawRepository = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    const otherRepository = require('../../src/main/worker/dbService/modules/music_other_source/index.ts')
    assert.deepEqual(await rawRepository.rawLyricPut({
      provider: 'wy', sourceTrackId: 'unicode', lyrics: { lyric: '汉字', tlyric: 'abc' }, nowMs: 10,
    }), { status: 'stored' })
    assert.deepEqual(await otherRepository.otherSourcesPut({
      originalProvider: 'wy', originalTrackId: 'unicode', nowMs: 10,
      candidates: [{ id: '歌', name: '歌曲', singer: '人', source: 'tx', interval: null, meta: {} }],
    }), { status: 'stored' })
    await seed(db => seedUrl(db, { track: 'one' }))
    const before = await cacheDb.runCacheRead(db => ({
      raw: db.prepare(`SELECT byte_size AS bytes FROM raw_lyric_groups`).get().bytes,
      rawRows: db.prepare(`SELECT sum(byte_size) AS bytes FROM raw_lyrics`).get().bytes,
      other: db.prepare(`SELECT byte_size AS bytes FROM other_source_groups`).get().bytes,
      otherRows: db.prepare(`SELECT sum(byte_size) AS bytes FROM other_sources`).get().bytes,
    }))
    assert.equal(before.status, 'hit')
    const policy = {
      musicUrls: { fallbackTtlMs: 50, maxEntries: 1 },
      rawLyrics: { maxBytes: before.value.raw, maxTracks: 1, maxIdleMs: 10_000 },
      otherSources: { ttlMs: 10_000, maxBytes: before.value.other },
    }
    let byteCalculations = 0

    const result = await createPruner({
      policy,
      utf8ByteLength: value => {
        byteCalculations++
        return Buffer.byteLength(value, 'utf8')
      },
    }).prune({ nowMs: 20, batchSize: 500 })

    assert.equal(result.status, 'completed')
    assert.equal(result.musicUrls.deletedRows, 0)
    assert.equal(result.rawLyrics.deletedOwners, 0)
    assert.equal(result.otherSources.deletedOwners, 0)
    assert.equal(before.value.raw, 9)
    assert.equal(before.value.raw, before.value.rawRows)
    assert.equal(before.value.other, before.value.otherRows)
    assert.equal(byteCalculations > 0, true)
    assert.equal(result.rawLyrics.bytesAfter, before.value.raw)
    assert.equal(result.otherSources.bytesAfter, before.value.other)
  })

  it('uses repeated bounded transactions and validates the batch boundary', async() => {
    await createFixture()
    await seed(db => {
      for (const track of ['a', 'b', 'c', 'd']) seedUrl(db, { track })
    })
    let transactions = 0
    const pruner = createPruner({
      runImmediate: operation => {
        transactions++
        return cacheDb.runCacheImmediate(operation)
      },
    })

    const result = await pruner.prune({ nowMs, batchSize: 1 })

    assert.equal(result.status, 'completed')
    assert.equal(result.musicUrls.deletedRows, 2)
    assert.equal(transactions >= 3, true)
    for (const batchSize of [0, 501, 1.5]) {
      await assert.rejects(pruner.prune({ nowMs, batchSize }), error => error?.code == 'cache_prune_input_invalid')
    }
  })

  it('rolls back a complete bounded batch when any owner deletion fails', async() => {
    const fixture = await createFixture()
    await seed(db => {
      seedRaw(db, 'a', '1', { lyric: 'one', tlyric: 'two' })
      seedRaw(db, 'b', '2', { lyric: 'three' })
      db.exec(`
        CREATE TRIGGER fail_raw_prune BEFORE DELETE ON raw_lyrics
        WHEN old.provider = 'a'
        BEGIN SELECT RAISE(ABORT, 'private rollback sentinel'); END;
      `)
    })
    const before = fs.statSync(path.join(fixture.path, 'cache', 'cache.db'))

    const result = await createPruner({
      policy: { ...smallPolicy, rawLyrics: { ...smallPolicy.rawLyrics, maxTracks: 1 } },
    }).prune({ nowMs, batchSize: 2 })

    assert.deepEqual(result, { status: 'unavailable', code: 'cache_operation_failed' })
    const db = require('better-sqlite3')(path.join(fixture.path, 'cache', 'cache.db'))
    assert.equal(db.prepare(`SELECT count(*) AS count FROM raw_lyric_groups`).get().count, 2)
    assert.equal(db.prepare(`SELECT count(*) AS count FROM raw_lyrics`).get().count, 3)
    db.close()
    assert.equal(fs.statSync(path.join(fixture.path, 'cache', 'cache.db')).ino, before.ino)
  })

  it('rejects offsetting per-owner byte total corruption without pruning either group', async() => {
    const fixture = await createFixture()
    await seed(db => {
      seedRaw(db, 'a', '1', { lyric: 'one' })
      seedRaw(db, 'b', '2', { lyric: 'three' })
      db.prepare(`UPDATE raw_lyric_groups SET byte_size = byte_size + 1 WHERE provider = 'a'`).run()
      db.prepare(`UPDATE raw_lyric_groups SET byte_size = byte_size - 1 WHERE provider = 'b'`).run()
    })

    const result = await createPruner().prune({ nowMs: 50, batchSize: 2 })

    assert.deepEqual(result, { status: 'unavailable', code: 'cache_operation_failed' })
    const db = require('better-sqlite3')(path.join(fixture.path, 'cache', 'cache.db'))
    assert.equal(db.prepare(`SELECT count(*) AS count FROM raw_lyric_groups`).get().count, 2)
    assert.equal(db.prepare(`SELECT count(*) AS count FROM raw_lyrics`).get().count, 2)
    db.close()
  })

  it('is an unavailable no-op and leaves the invalid cache artifact in place', async() => {
    const fixture = await createFixture()
    const cachePath = path.join(fixture.path, 'cache', 'cache.db')
    await cacheDb.closeCacheDatabase()
    fs.appendFileSync(cachePath, Buffer.from('invalid-tail'))
    const before = fs.readFileSync(cachePath)

    const result = await createPruner().prune({ nowMs, batchSize: 1 })

    assert.deepEqual(result, { status: 'unavailable', code: 'cache_open_failed' })
    assert.deepEqual(fs.readFileSync(cachePath), before)
  })

  it('shares the lifecycle FIFO gate with complete-owner replacement', async() => {
    await createFixture()
    const rawRepository = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await seed(db => seedRaw(db, 'a', 'old', { lyric: 'old' }, { accessed: 10 }))
    const write = rawRepository.rawLyricPut({
      provider: 'a', sourceTrackId: 'new',
      lyrics: { lyric: 'one', tlyric: 'two', rlyric: 'three', lxlyric: 'four' }, nowMs: 30,
    })
    const prune = createPruner({
      policy: { ...smallPolicy, rawLyrics: { ...smallPolicy.rawLyrics, maxTracks: 1 } },
    }).prune({ nowMs: 50, batchSize: 1 })

    assert.deepEqual(await write, { status: 'stored' })
    assert.equal((await prune).status, 'completed')
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT source_track_id AS id, count(*) AS rows
      FROM raw_lyrics GROUP BY provider, source_track_id
    `).all()), { status: 'hit', value: [{ id: 'new', rows: 4 }] })
  })

  it('schedules only strict post-write 110% excess and coalesces work while allowing idle pruning', async() => {
    const scheduled = []
    const pruneInputs = []
    const snapshot = {
      musicUrls: { rows: 2 },
      rawLyrics: { rows: 1, ownerGroups: 2, bytes: 11 },
      otherSources: { rows: 1, ownerGroups: 1, bytes: 11 },
    }
    const policy = {
      musicUrls: { fallbackTtlMs: 50, maxEntries: 2 },
      rawLyrics: { maxBytes: 10, maxTracks: 2, maxIdleMs: 100 },
      otherSources: { ttlMs: 100, maxBytes: 10 },
    }
    const scheduler = lifecycleModule().createCachePruneScheduler({
      policy,
      now: () => 123,
      schedule: task => { scheduled.push(task) },
      runSnapshot: async() => ({ status: 'completed', value: structuredClone(snapshot) }),
      prune: async input => {
        pruneInputs.push(input)
        return { status: 'completed' }
      },
    })

    scheduler.requestAfterWrite('musicUrls')
    scheduler.requestAfterWrite('rawLyrics')
    scheduler.requestAfterWrite('otherSources')
    assert.equal(scheduled.length, 1)
    scheduled.shift()()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(pruneInputs, [])

    snapshot.musicUrls.rows = 3
    scheduler.requestAfterWrite('musicUrls')
    scheduler.requestAfterWrite('musicUrls')
    assert.equal(scheduled.length, 1)
    scheduled.shift()()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(pruneInputs, [{ nowMs: 123, batchSize: 100 }])

    scheduler.requestIdle()
    assert.equal(scheduled.length, 1)
    scheduled.shift()()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(pruneInputs, [
      { nowMs: 123, batchSize: 100 },
      { nowMs: 123, batchSize: 100 },
    ])
  })

  it('requests post-write pruning only after the gated URL write settles', async() => {
    const write = {}
    write.promise = new Promise(resolve => { write.resolve = resolve })
    const requests = []
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (parent?.filename.endsWith(`${path.sep}music_url${path.sep}index.ts`) && request == '../../cacheDb') {
        return {
          runCacheRead: async() => ({ status: 'miss' }),
          runCacheWrite: async operation => {
            await write.promise
            operation({ prepare: () => ({ run: () => ({ changes: 1 }) }) })
            return { status: 'stored' }
          },
          runCacheImmediate: async() => ({ status: 'completed', value: 0 }),
        }
      }
      if (parent?.filename.endsWith(`${path.sep}music_url${path.sep}index.ts`) && request == '../cacheLifecycle/prune') {
        return { scheduleCachePruneAfterWrite: kind => requests.push(kind) }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    const modulePath = '../../src/main/worker/dbService/modules/music_url/index.ts'
    try {
      delete require.cache[require.resolve(modulePath)]
      const { musicUrlPut } = require(modulePath)
      const putting = musicUrlPut({
        provider: 'tx', accountScope: 'profile-v1:uin:7', sourceTrackId: 'track', quality: '320k',
        url: 'https://media.invalid/track', nowMs: 1,
      })
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(requests, [])
      write.resolve()
      assert.deepEqual(await putting, { status: 'stored' })
      assert.deepEqual(requests, ['musicUrls'])
    } finally {
      Module._load = originalLoad
      delete require.cache[require.resolve(modulePath)]
    }
  })
})
