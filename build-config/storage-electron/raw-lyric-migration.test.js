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
})
