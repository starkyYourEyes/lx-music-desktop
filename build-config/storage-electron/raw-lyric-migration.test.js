const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
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

  it('prefers exact providers, then legacy cache, then schema-6 authoritative fallback', async() => {
    await createFixture()
    const { rawLyricGet, rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    assert.deepEqual(await rawLyricPut({ provider: 'legacy', sourceTrackId: 'one', lyrics: { lyric: 'old' }, nowMs: 10 }), { status: 'stored' })
    assert.deepEqual(await rawLyricPut({ provider: 'tx', sourceTrackId: 'one', lyrics: { lyric: 'new' }, nowMs: 20 }), { status: 'stored' })
    assert.deepEqual(await rawLyricGet({ provider: 'tx', sourceTrackId: 'one', nowMs: 30 }), { status: 'hit', value: { lyric: 'new' } })
    assert.deepEqual(await rawLyricGet({ provider: 'kw', sourceTrackId: 'one', nowMs: 30 }), { status: 'hit', value: { lyric: 'old' } })
    dbService.getAppDB().prepare(`INSERT INTO lyric(id, type, text, source) VALUES (?, ?, ?, ?)`)
      .run('app-only', 'lyric', Buffer.from('app').toString('base64'), 'raw')
    assert.deepEqual(await rawLyricGet({ provider: 'kw', sourceTrackId: 'app-only', nowMs: 30 }), { status: 'hit', value: { lyric: 'app' } })
  })

  it('atomically replaces the complete owner group with exact UTF-8 bytes and timestamps', async() => {
    await createFixture()
    const { rawLyricPut } = require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'song', lyrics: { lyric: 'old', tlyric: 'old translation' }, nowMs: 1 })
    await rawLyricPut({ provider: 'tx', sourceTrackId: 'song', lyrics: { lyric: 'A\u{1f600}', rlyric: 'roman', lxlyric: 'timing' }, nowMs: 20 })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT byte_size AS byteSize, created_at_ms AS createdAtMs, last_accessed_at_ms AS lastAccessedAtMs
      FROM raw_lyric_groups WHERE provider = 'tx' AND source_track_id = 'song'
    `).get()), { status: 'hit', value: { byteSize: 5 + 5 + 6, createdAtMs: 20, lastAccessedAtMs: 20 } })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT lyric_type AS lyricType FROM raw_lyrics WHERE provider = 'tx' AND source_track_id = 'song' ORDER BY lyric_type
    `).all().map(row => row.lyricType)), { status: 'hit', value: ['lxlyric', 'lyric', 'rlyric'] })
  })
})
