const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const Database = require('better-sqlite3')
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

const createFixture = async() => {
  const fixture = createTestStorageRoot('raw-lyric-migration')
  fixtures.push(fixture)
  const profileRoot = path.join(fixture.path, 'profile')
  const result = await dbService.init({
    dataPath: profileRoot,
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

afterEach(async() => {
  try { await cacheDb.closeCacheDatabase() } catch {}
  try { dbService.close() } catch {}
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
  for (const modulePath of [
    '../../src/main/worker/dbService/modules/lyric/raw/repository.ts',
    '../../src/main/migration/cache/rawLyrics.ts',
  ]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
})

describe('raw lyric cache migration', () => {
  it('hashes canonical tuples with binary UTF-8 ordering and u32be length prefixes', () => {
    const { canonicalRawLyricHash } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    assert.equal(canonicalRawLyricHash([
      { provider: '\u00e9', sourceTrackId: '2', lyricType: 'tlyric', text: '\u8bd1' },
      { provider: 'z', sourceTrackId: '10', lyricType: 'lyric', text: 'A\u{1f600}' },
      { provider: 'legacy', sourceTrackId: '1', lyricType: 'rlyric', text: '' },
    ]), 'b9d0e5e1dd3b20a7ecb99c099426c9d428d03d2fbbdec84b6b5230136d440f71')
  })

  it('copies all raw variants and leaves edited rows byte-identical', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('song-1', 'lyric', Buffer.from('raw lyric').toString('base64'), 'raw')
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('song-1', 'tlyric', Buffer.from('translation').toString('base64'), 'raw')
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('song-1', 'rlyric', Buffer.from('romanized').toString('base64'), 'raw')
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('song-1', 'lxlyric', Buffer.from('word timing').toString('base64'), 'raw')
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('song-1', 'lyric', Buffer.from('edited bytes').toString('base64'), 'edited')
    const editedBefore = db.prepare(`SELECT id, type, text, source FROM lyric WHERE source = 'edited'`).all()

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    const result = await migrateRawLyrics({ nowMs: 1000 })

    assert.equal(result.sourceRows, 4)
    assert.equal(result.targetRows, 4)
    assert.equal(result.sourceOwnerGroups, 1)
    assert.equal(result.targetOwnerGroups, 1)
    assert.equal(result.sourceSha256, result.targetSha256)
    assert.deepEqual(db.prepare(`SELECT id, type, text, source FROM lyric WHERE source = 'edited'`).all(), editedBefore)
  })

  it('treats canonical empty base64 as a valid empty lyric variant', async() => {
    await createFixture()
    dbService.getAppDB().prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('empty', 'lyric', '', 'raw')

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    const result = await migrateRawLyrics({ nowMs: 1000 })

    assert.equal(result.status, 'complete')
    assert.equal(result.sourceRows, 1)
    assert.equal(result.skippedInvalidRows, 0)
    const row = await cacheDb.runCacheRead(db => db.prepare(`
      SELECT text, byte_size AS byteSize FROM raw_lyrics
      WHERE provider = 'legacy' AND source_track_id = 'empty' AND lyric_type = 'lyric'
    `).get())
    assert.deepEqual(row, { status: 'hit', value: { text: '', byteSize: 0 } })
  })

  it('verifies the authoritative marker after writing it', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('marker', 'lyric', Buffer.from('value').toString('base64'), 'raw')
    db.exec(`
      CREATE TRIGGER corrupt_raw_lyric_marker AFTER INSERT ON migration_markers
      WHEN NEW.name = 'legacy_cache_v1.raw_lyrics'
      BEGIN
        UPDATE migration_markers SET source_sha256 = '${'0'.repeat(64)}' WHERE name = NEW.name;
      END;
    `)

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    await assert.rejects(migrateRawLyrics({ nowMs: 1000 }), error => error?.code == 'raw_lyric_marker_invalid')
  })

  it('does not return invalid authoritative raw payloads through schema-6 fallback', async() => {
    await createFixture()
    dbService.getAppDB().prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('bad-fallback', 'lyric', 'not valid base64!', 'raw')

    const { rawLyricGet } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    assert.deepEqual(await rawLyricGet({ provider: 'tx', sourceTrackId: 'bad-fallback', nowMs: 1000 }), { status: 'miss' })
  })

  it('ignores unsupported authoritative lyric types during schema-6 fallback', async() => {
    await createFixture()
    const insert = dbService.getAppDB().prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
    insert.run('typed-fallback', 'lyric', Buffer.from('supported').toString('base64'), 'raw')
    insert.run('typed-fallback', 'arbitrary', Buffer.from('must not leak').toString('base64'), 'raw')

    const { rawLyricGet } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    assert.deepEqual(await rawLyricGet({ provider: 'tx', sourceTrackId: 'typed-fallback', nowMs: 1000 }), {
      status: 'hit', value: { lyric: 'supported' },
    })
  })

  it('maps malformed existing markers to a fixed code before cache mutation', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('marker-invalid', 'lyric', Buffer.from('value').toString('base64'), 'raw')
    db.prepare(`INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json) VALUES (?, ?, ?, ?)`)
      .run('legacy_cache_v1.raw_lyrics', 'f'.repeat(64), 1, '{}')

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    await assert.rejects(migrateRawLyrics({ nowMs: 1000 }), error => error?.code == 'raw_lyric_marker_invalid')
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`SELECT count(*) AS count FROM raw_lyrics WHERE provider = 'legacy'`).get().count), {
      status: 'hit', value: 0,
    })
  })

  it('rejects a conflicting marker before mutating legacy cache rows', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('marker-conflict', 'lyric', Buffer.from('authoritative').toString('base64'), 'raw')
    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    const first = await migrateRawLyrics({ nowMs: 100 })
    assert.equal(first.status, 'complete')

    db.prepare('INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)')
      .run('marker-conflict-late', 'lyric', Buffer.from('late authoritative').toString('base64'), 'raw')
    await cacheDb.runCacheImmediate(cache => {
      cache.prepare(`UPDATE raw_lyrics SET text = ?, byte_size = ? WHERE provider = 'legacy' AND source_track_id = 'marker-conflict'`)
        .run('disposable', Buffer.byteLength('disposable'))
      cache.prepare(`UPDATE raw_lyric_groups SET byte_size = ?, created_at_ms = ?, last_accessed_at_ms = ? WHERE provider = 'legacy' AND source_track_id = 'marker-conflict'`)
        .run(Buffer.byteLength('disposable'), 55, 55)
    })

    await assert.rejects(migrateRawLyrics({ nowMs: 200 }), error => error?.code == 'raw_lyric_marker_conflict')
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT r.text, g.byte_size AS byteSize, g.created_at_ms AS createdAtMs, g.last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyrics r JOIN raw_lyric_groups g USING (provider, source_track_id)
      WHERE r.provider = 'legacy' AND r.source_track_id = 'marker-conflict'
    `).get()), {
      status: 'hit',
      value: { text: 'disposable', byteSize: Buffer.byteLength('disposable'), createdAtMs: 55, lastAccessedAtMs: 55 },
    })
  })

  it('rejects noncanonical marker JSON bytes before mutating legacy cache rows', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('marker-noncanonical', 'lyric', Buffer.from('authoritative').toString('base64'), 'raw')
    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    assert.equal((await migrateRawLyrics({ nowMs: 100 })).status, 'complete')
    const marker = db.prepare(`SELECT details_json AS detailsJson FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics')
    db.prepare(`UPDATE migration_markers SET details_json = ? WHERE name = ?`)
      .run(JSON.stringify(JSON.parse(marker.detailsJson), null, 2), 'legacy_cache_v1.raw_lyrics')
    await cacheDb.runCacheImmediate(cache => {
      cache.prepare(`UPDATE raw_lyrics SET text = ?, byte_size = ? WHERE provider = 'legacy' AND source_track_id = 'marker-noncanonical'`)
        .run('disposable', Buffer.byteLength('disposable'))
      cache.prepare(`UPDATE raw_lyric_groups SET byte_size = ?, created_at_ms = ?, last_accessed_at_ms = ? WHERE provider = 'legacy' AND source_track_id = 'marker-noncanonical'`)
        .run(Buffer.byteLength('disposable'), 55, 55)
    })

    await assert.rejects(migrateRawLyrics({ nowMs: 200 }), error => error?.code == 'raw_lyric_marker_invalid')
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT r.text, g.created_at_ms AS createdAtMs, g.last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyrics r JOIN raw_lyric_groups g USING (provider, source_track_id)
      WHERE r.provider = 'legacy' AND r.source_track_id = 'marker-noncanonical'
    `).get()), { status: 'hit', value: { text: 'disposable', createdAtMs: 55, lastAccessedAtMs: 55 } })
  })

  it('revalidates a matching marker and repairs only a disposable target', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('marker-reuse', 'lyric', Buffer.from('authoritative').toString('base64'), 'raw')
    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    assert.equal((await migrateRawLyrics({ nowMs: 100 })).status, 'complete')
    const markerBefore = db.prepare(`SELECT source_sha256, completed_at_ms, details_json FROM migration_markers WHERE name = ?`)
      .get('legacy_cache_v1.raw_lyrics')

    assert.equal((await migrateRawLyrics({ nowMs: 200 })).status, 'already-complete')
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT created_at_ms AS createdAtMs, last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyric_groups WHERE provider = 'legacy' AND source_track_id = 'marker-reuse'
    `).get()), { status: 'hit', value: { createdAtMs: 100, lastAccessedAtMs: 100 } })

    await cacheDb.runCacheImmediate(cache => {
      cache.prepare(`DELETE FROM raw_lyric_groups WHERE provider = 'legacy' AND source_track_id = 'marker-reuse'`).run()
    })
    const repaired = await migrateRawLyrics({ nowMs: 300 })
    assert.equal(repaired.status, 'already-complete')
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT r.text, g.created_at_ms AS createdAtMs, g.last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyrics r JOIN raw_lyric_groups g USING (provider, source_track_id)
      WHERE r.provider = 'legacy' AND r.source_track_id = 'marker-reuse'
    `).get()), { status: 'hit', value: { text: 'authoritative', createdAtMs: 300, lastAccessedAtMs: 300 } })
    assert.deepEqual(db.prepare(`SELECT source_sha256, completed_at_ms, details_json FROM migration_markers WHERE name = ?`)
      .get('legacy_cache_v1.raw_lyrics'), markerBefore)
  })

  it('rolls back an interrupted replacement without a marker and retries to verified success', async() => {
    const fixture = await createFixture()
    const db = dbService.getAppDB()
    const insert = db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
    insert.run('first', 'lyric', Buffer.from('first source').toString('base64'), 'raw')
    insert.run('second', 'lyric', Buffer.from('second source').toString('base64'), 'raw')
    const { rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'legacy', sourceTrackId: 'old', lyrics: { lyric: 'original target' }, nowMs: 10 })
    await cacheDb.runCacheImmediate(cache => cache.exec(`
      CREATE TRIGGER interrupt_legacy_copy BEFORE INSERT ON raw_lyrics
      WHEN NEW.provider = 'legacy' AND NEW.source_track_id = 'second'
      BEGIN SELECT RAISE(ABORT, 'interrupted'); END;
    `))

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    assert.deepEqual(await migrateRawLyrics({ nowMs: 200 }), { status: 'unavailable', code: 'cache_operation_failed' })
    assert.equal(db.prepare(`SELECT count(*) AS count FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics').count, 0)

    const cachePath = path.join(fixture.path, 'cache', 'cache.db')
    const interrupted = new Database(cachePath)
    assert.deepEqual(interrupted.prepare(`
      SELECT provider, source_track_id AS sourceTrackId, lyric_type AS lyricType, text
      FROM raw_lyrics WHERE provider = 'legacy' ORDER BY source_track_id, lyric_type
    `).all(), [{ provider: 'legacy', sourceTrackId: 'old', lyricType: 'lyric', text: 'original target' }])
    interrupted.exec(`DROP TRIGGER interrupt_legacy_copy`)
    interrupted.close()

    assert.equal((await cacheDb.openCacheDatabase()).status, 'ready')
    const retried = await migrateRawLyrics({ nowMs: 300 })
    assert.equal(retried.status, 'complete')
    assert.equal(retried.sourceRows, 2)
    assert.equal(retried.targetRows, 2)
    assert.equal(retried.sourceOwnerGroups, 2)
    assert.equal(retried.targetOwnerGroups, 2)
    assert.equal(retried.sourceSha256, retried.targetSha256)
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT source_track_id AS sourceTrackId, text FROM raw_lyrics
      WHERE provider = 'legacy' ORDER BY source_track_id
    `).all()), {
      status: 'hit',
      value: [
        { sourceTrackId: 'first', text: 'first source' },
        { sourceTrackId: 'second', text: 'second source' },
      ],
    })
    assert.equal(db.prepare(`SELECT count(*) AS count FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics').count, 1)
  })

  it('replaces and verifies a committed unmarked target after a simulated crash', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    const insert = db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
    insert.run('crash-a', 'lyric', Buffer.from('first').toString('base64'), 'raw')
    insert.run('crash-b', 'tlyric', Buffer.from('second').toString('base64'), 'raw')
    const { replaceRawProvider, rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'keep', lyrics: { lyric: 'other provider' }, nowMs: 1 })
    assert.equal((await replaceRawProvider('legacy', [
      { provider: 'legacy', sourceTrackId: 'crash-a', lyricType: 'lyric', text: 'first' },
      { provider: 'legacy', sourceTrackId: 'crash-b', lyricType: 'tlyric', text: 'second' },
    ], 100)).status, 'completed')
    assert.equal(db.prepare(`SELECT count(*) AS count FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics').count, 0)

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    const retried = await migrateRawLyrics({ nowMs: 200 })
    assert.equal(retried.status, 'complete')
    assert.equal(retried.sourceSha256, retried.targetSha256)
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT provider, source_track_id AS sourceTrackId, lyric_type AS lyricType, text
      FROM raw_lyrics ORDER BY provider, source_track_id, lyric_type
    `).all()), {
      status: 'hit',
      value: [
        { provider: 'legacy', sourceTrackId: 'crash-a', lyricType: 'lyric', text: 'first' },
        { provider: 'legacy', sourceTrackId: 'crash-b', lyricType: 'tlyric', text: 'second' },
        { provider: 'tx', sourceTrackId: 'keep', lyricType: 'lyric', text: 'other provider' },
      ],
    })
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT source_track_id AS sourceTrackId, created_at_ms AS createdAtMs, last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyric_groups WHERE provider = 'legacy' ORDER BY source_track_id
    `).all()), {
      status: 'hit',
      value: [
        { sourceTrackId: 'crash-a', createdAtMs: 200, lastAccessedAtMs: 200 },
        { sourceTrackId: 'crash-b', createdAtMs: 200, lastAccessedAtMs: 200 },
      ],
    })
    assert.equal(db.prepare(`SELECT count(*) AS count FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics').count, 1)
  })

  it('clears only legacy targets and writes the exact empty marker when all source rows are invalid', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    const insert = db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
    insert.run('', 'lyric', Buffer.from('empty id').toString('base64'), 'raw')
    insert.run('x'.repeat(1025), 'tlyric', Buffer.from('long id').toString('base64'), 'raw')
    insert.run('invalid-base64', 'rlyric', 'not base64', 'raw')
    insert.run('invalid-utf8', 'lxlyric', '/w==', 'raw')
    insert.run('edited', 'lyric', Buffer.from('edited bytes').toString('base64'), 'edited')
    const editedBefore = db.prepare(`SELECT id, type, text, source FROM lyric WHERE source = 'edited'`).all()
    const { rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'legacy', sourceTrackId: 'stale', lyrics: { lyric: 'remove me' }, nowMs: 1 })
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'keep', lyrics: { lyric: 'keep me' }, nowMs: 2 })

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    const result = await migrateRawLyrics({ nowMs: 1234 })
    const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    assert.deepEqual(result, {
      status: 'complete',
      sourceRows: 0,
      sourceOwnerGroups: 0,
      skippedInvalidRows: 4,
      sourceSha256: emptySha256,
      targetRows: 0,
      targetOwnerGroups: 0,
      targetSha256: emptySha256,
    })
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT provider, source_track_id AS sourceTrackId, text FROM raw_lyrics ORDER BY provider, source_track_id
    `).all()), { status: 'hit', value: [{ provider: 'tx', sourceTrackId: 'keep', text: 'keep me' }] })
    assert.deepEqual(db.prepare(`SELECT id, type, text, source FROM lyric WHERE source = 'edited'`).all(), editedBefore)
    assert.deepEqual(db.prepare(`
      SELECT source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs, details_json AS detailsJson
      FROM migration_markers WHERE name = ?
    `).get('legacy_cache_v1.raw_lyrics'), {
      sourceSha256: emptySha256,
      completedAtMs: 1234,
      detailsJson: canonical({
        version: 1,
        provider: 'legacy',
        tupleEncoding: 'u32be-length-prefixed-utf8-v1',
        sourceRows: 0,
        sourceOwnerGroups: 0,
        skippedInvalidRows: 4,
        sourceSha256: emptySha256,
        targetRows: 0,
        targetOwnerGroups: 0,
        targetSha256: emptySha256,
      }),
    })
  })

  it('returns unavailable without writing a marker when the cache cannot run migration', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('unavailable', 'lyric', Buffer.from('source').toString('base64'), 'raw')
    await cacheDb.closeCacheDatabase()

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    assert.deepEqual(await migrateRawLyrics({ nowMs: 100 }), { status: 'unavailable', code: 'cache_open_failed' })
    assert.equal(db.prepare(`SELECT count(*) AS count FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics').count, 0)
  })

  it('rejects duplicate valid source tuples before cache mutation', async() => {
    await createFixture()
    const db = dbService.getAppDB()
    const insert = db.prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
    insert.run('duplicate', 'lyric', Buffer.from('first source').toString('base64'), 'raw')
    insert.run('duplicate', 'lyric', Buffer.from('second source').toString('base64'), 'raw')
    const { rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'legacy', sourceTrackId: 'sentinel', lyrics: { lyric: 'preserve me' }, nowMs: 10 })

    const { migrateRawLyrics } = require('../../src/main/migration/cache/rawLyrics.ts')
    await assert.rejects(migrateRawLyrics({ nowMs: 100 }), error => error?.code == 'raw_lyric_attestation_failed')

    assert.equal(await cacheDb.getCacheLifecycleState(), 'ready')
    assert.equal(db.prepare(`SELECT count(*) AS count FROM migration_markers WHERE name = ?`).get('legacy_cache_v1.raw_lyrics').count, 0)
    assert.deepEqual(await cacheDb.runCacheRead(cache => cache.prepare(`
      SELECT r.provider, r.source_track_id AS sourceTrackId, r.lyric_type AS lyricType, r.text,
        g.byte_size AS byteSize, g.created_at_ms AS createdAtMs, g.last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyrics r JOIN raw_lyric_groups g USING (provider, source_track_id)
      WHERE r.provider = 'legacy' ORDER BY r.source_track_id, r.lyric_type
    `).all()), {
      status: 'hit',
      value: [{
        provider: 'legacy', sourceTrackId: 'sentinel', lyricType: 'lyric', text: 'preserve me',
        byteSize: Buffer.byteLength('preserve me'), createdAtMs: 10, lastAccessedAtMs: 10,
      }],
    })
  })

  it('prefers exact providers, then legacy cache, then schema-6 authoritative fallback', async() => {
    await createFixture()
    const { rawLyricGet, rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    assert.deepEqual(await rawLyricPut({ provider: 'legacy', sourceTrackId: 'one', lyrics: { lyric: 'old' }, nowMs: 10 }), { status: 'stored' })
    assert.deepEqual(await rawLyricPut({ provider: 'tx', sourceTrackId: 'one', lyrics: { lyric: 'new' }, nowMs: 20 }), { status: 'stored' })
    assert.deepEqual(await rawLyricGet({ provider: 'tx', sourceTrackId: 'one', nowMs: 30 }), { status: 'hit', value: { lyric: 'new' } })
    assert.deepEqual(await rawLyricGet({ provider: 'kw', sourceTrackId: 'one', nowMs: 40 }), { status: 'hit', value: { lyric: 'old' } })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT provider, last_accessed_at_ms AS lastAccessedAtMs FROM raw_lyric_groups
      WHERE source_track_id = 'one' ORDER BY provider
    `).all()), {
      status: 'hit',
      value: [
        { provider: 'legacy', lastAccessedAtMs: 40 },
        { provider: 'tx', lastAccessedAtMs: 30 },
      ],
    })
    dbService.getAppDB().prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('app-only', 'lyric', Buffer.from('app').toString('base64'), 'raw')
    assert.deepEqual(await rawLyricGet({ provider: 'kw', sourceTrackId: 'app-only', nowMs: 30 }), { status: 'hit', value: { lyric: 'app' } })
    await rawLyricPut({ provider: 'legacy', sourceTrackId: 'unavailable', lyrics: { lyric: 'stale cache' }, nowMs: 50 })
    dbService.getAppDB().prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('unavailable', 'lyric', Buffer.from('authoritative app').toString('base64'), 'raw')
    await cacheDb.closeCacheDatabase()
    assert.deepEqual(await rawLyricGet({ provider: 'kw', sourceTrackId: 'unavailable', nowMs: 60 }), {
      status: 'hit', value: { lyric: 'authoritative app' },
    })
  })

  it('atomically replaces the complete owner group with exact UTF-8 bytes and timestamps', async() => {
    await createFixture()
    const { rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'song', lyrics: { lyric: 'old', tlyric: 'old translation' }, nowMs: 1 })
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'song', lyrics: { lyric: 'A\u{1f600}', tlyric: '\u8bd1', rlyric: 'roman', lxlyric: 'timing' }, nowMs: 20 })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT byte_size AS byteSize, created_at_ms AS createdAtMs, last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyric_groups WHERE provider = 'tx' AND source_track_id = 'song'
    `).get()), { status: 'hit', value: { byteSize: 5 + 3 + 5 + 6, createdAtMs: 20, lastAccessedAtMs: 20 } })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT lyric_type AS lyricType, byte_size AS byteSize FROM raw_lyrics
      WHERE provider = 'tx' AND source_track_id = 'song' ORDER BY lyric_type
    `).all()), {
      status: 'hit',
      value: [
        { lyricType: 'lxlyric', byteSize: 6 },
        { lyricType: 'lyric', byteSize: 5 },
        { lyricType: 'rlyric', byteSize: 5 },
        { lyricType: 'tlyric', byteSize: 3 },
      ],
    })
    const { rawLyricGet } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricGet({ provider: 'tx', sourceTrackId: 'song', nowMs: 5 })
    await rawLyricGet({ provider: 'tx', sourceTrackId: 'song', nowMs: 25 })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT created_at_ms AS createdAtMs, last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyric_groups WHERE provider = 'tx' AND source_track_id = 'song'
    `).get()), { status: 'hit', value: { createdAtMs: 20, lastAccessedAtMs: 25 } })
  })

  it('keeps edited lyric APIs authoritative when cache is unavailable', async() => {
    await createFixture()
    await cacheDb.closeCacheDatabase()
    const lyric = require('../../src/main/worker/dbService/modules/lyric/index.ts')

    lyric.editedLyricAdd('edited-one', { lyric: 'first', tlyric: 'translation' })
    lyric.editedLyricAdd('edited-two', { lyric: 'second' })
    assert.deepEqual(lyric.getEditedLyric('edited-one'), { lyric: 'first', tlyric: 'translation' })
    assert.equal(lyric.editedLyricCount(), 3)
    lyric.editedLyricUpdateAddAndUpdate('edited-one', { lyric: 'updated' })
    assert.deepEqual(lyric.getEditedLyric('edited-one'), { lyric: 'updated', tlyric: 'translation' })
    lyric.editedLyricRemove(['edited-one'])
    assert.equal(lyric.editedLyricCount(), 1)
    lyric.editedLyricClear()
    assert.equal(lyric.editedLyricCount(), 0)
    assert.equal(await cacheDb.getCacheLifecycleState(), 'closed')
  })

  it('rejects malformed lyric variants before cache mutation', async() => {
    await createFixture()
    const { rawLyricGet, rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'validated', lyrics: { lyric: 'keep' }, nowMs: 10 })

    await assert.rejects(
      rawLyricPut({ provider: 'tx', sourceTrackId: 'validated', lyrics: { lyric: 7 }, nowMs: 20 }),
      /raw_lyric_input_invalid/,
    )

    assert.equal(await cacheDb.getCacheLifecycleState(), 'ready')
    assert.deepEqual(await rawLyricGet({ provider: 'tx', sourceTrackId: 'validated', nowMs: 30 }), {
      status: 'hit', value: { lyric: 'keep' },
    })
  })
})
