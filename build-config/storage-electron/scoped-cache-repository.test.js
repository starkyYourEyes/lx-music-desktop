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
const DAY_MS = 24 * 60 * 60 * 1000

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
  const fixture = createTestStorageRoot('scoped-cache-repository')
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

const repositoryFunction = (modulePath, name) => {
  const repository = require(modulePath)
  assert.equal(typeof repository[name], 'function', `${name} scoped repository function is missing`)
  return repository[name]
}

const urlKey = (accountScope, nowMs, overrides = {}) => ({
  provider: 'tx',
  accountScope,
  sourceTrackId: 'track-1',
  quality: '320k',
  nowMs,
  ...overrides,
})

const owner = (nowMs = 1, overrides = {}) => ({
  originalProvider: 'local',
  originalTrackId: 'original-1',
  nowMs,
  ...overrides,
})

const candidate = (id, source = 'tx', extra = {}) => ({
  id,
  name: `name-${id}`,
  singer: `singer-${id}`,
  source,
  interval: null,
  meta: {
    songId: id,
    albumName: `album-${id}`,
    qualitys: [],
    _qualitys: {},
  },
  ...extra,
})

afterEach(async() => {
  try { await cacheDb.closeCacheDatabase() } catch {}
  try { dbService.close() } catch {}
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
  for (const modulePath of [
    '../../src/main/worker/dbService/modules/music_url/index.ts',
    '../../src/main/worker/dbService/modules/music_other_source/index.ts',
    '../../src/common/storage/cacheValidation.ts',
  ]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
})

describe('scoped URL cache repository', () => {
  it('never returns an expired or differently scoped URL and touches only a valid hit', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_url/index.ts'
    const put = repositoryFunction(modulePath, 'musicUrlPut')
    const get = repositoryFunction(modulePath, 'musicUrlGet')

    assert.deepEqual(await put({ ...urlKey('profile-v1:uin:10001', 1), url: 'https://media.invalid/a', providerExpiresAtMs: 100 }), { status: 'stored' })
    assert.deepEqual(await get(urlKey('profile-v1:uin:other', 50)), { status: 'miss' })
    assert.deepEqual(await get(urlKey('profile-v1:uin:10001', 100)), { status: 'miss' })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT last_accessed_at_ms AS lastAccessedAtMs FROM music_urls
      WHERE provider = 'tx' AND account_scope = 'profile-v1:uin:10001'
    `).get()), { status: 'hit', value: { lastAccessedAtMs: 1 } })
    assert.deepEqual(await get(urlKey('profile-v1:uin:10001', 99)), { status: 'hit', value: 'https://media.invalid/a' })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT last_accessed_at_ms AS lastAccessedAtMs FROM music_urls
      WHERE provider = 'tx' AND account_scope = 'profile-v1:uin:10001'
    `).get()), { status: 'hit', value: { lastAccessedAtMs: 99 } })
  })

  it('uses the exact 15 minute TTL unless provider expiry is supplied', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_url/index.ts'
    const put = repositoryFunction(modulePath, 'musicUrlPut')
    await put({ ...urlKey('profile-v1:user-id:7', 123), url: 'https://media.invalid/default' })
    await put({ ...urlKey('profile-v1:user-id:7', 123, { sourceTrackId: 'provider' }), url: 'https://media.invalid/provider', providerExpiresAtMs: 200 })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT source_track_id AS sourceTrackId, expires_at_ms AS expiresAtMs
      FROM music_urls ORDER BY source_track_id
    `).all()), {
      status: 'hit',
      value: [
        { sourceTrackId: 'provider', expiresAtMs: 200 },
        { sourceTrackId: 'track-1', expiresAtMs: 900123 },
      ],
    })
  })

  it('invalidates only the requested account or provider without exposing URL values', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_url/index.ts'
    const put = repositoryFunction(modulePath, 'musicUrlPut')
    const invalidateAccount = repositoryFunction(modulePath, 'musicUrlInvalidateAccount')
    const invalidateSource = repositoryFunction(modulePath, 'musicUrlInvalidateSource')
    await put({ ...urlKey('profile-v1:uin:a', 1), url: 'https://media.invalid/a' })
    await put({ ...urlKey('profile-v1:uin:b', 1, { sourceTrackId: 'b' }), url: 'https://media.invalid/b' })
    await put({ ...urlKey('profile-v1:user-id:9', 1, { provider: 'wy', sourceTrackId: 'c' }), url: 'https://media.invalid/c' })
    assert.equal(await invalidateAccount({ provider: 'tx', accountScope: 'profile-v1:uin:a' }), 1)
    assert.equal(await invalidateSource({ provider: 'tx' }), 1)
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`SELECT provider, count(*) AS count FROM music_urls GROUP BY provider`).all()), {
      status: 'hit', value: [{ provider: 'wy', count: 1 }],
    })
  })

  it('rejects hostile exact-shape inputs with fixed diagnostics that never contain the bearer URL', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_url/index.ts'
    const put = repositoryFunction(modulePath, 'musicUrlPut')
    const get = repositoryFunction(modulePath, 'musicUrlGet')
    const bearer = 'https://media.invalid/private-token-value'
    for (const input of [
      { ...urlKey('profile-v1:uin:a', 1), url: bearer, cookie: 'secret' },
      { ...urlKey('profile-v1:uin:a', -1), url: bearer },
      { ...urlKey('profile-v1:uin:a', 1), url: bearer, providerExpiresAtMs: Number.MAX_SAFE_INTEGER + 1 },
      Object.assign(Object.create(null), { ...urlKey('profile-v1:uin:a', 1), url: bearer }),
    ]) {
      await assert.rejects(put(input), error => error?.code == 'music_url_input_invalid' && !String(error.message).includes(bearer))
    }
    await assert.rejects(get({ ...urlKey('profile-v1:uin:a', 1), extra: true }), error => error?.code == 'music_url_input_invalid')
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`SELECT count(*) AS count FROM music_urls`).get()), {
      status: 'hit', value: { count: 0 },
    })
  })

  it('returns unavailable through lifecycle gates without touching the cache artifact', async() => {
    const fixture = await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_url/index.ts'
    const put = repositoryFunction(modulePath, 'musicUrlPut')
    const get = repositoryFunction(modulePath, 'musicUrlGet')
    await cacheDb.closeCacheDatabase()
    const cachePath = path.join(fixture.path, 'cache', 'cache.db')
    const before = fs.statSync(cachePath)
    assert.deepEqual(await get(urlKey('profile-v1:uin:a', 1)), { status: 'unavailable', code: 'cache_open_failed' })
    assert.deepEqual(await put({ ...urlKey('profile-v1:uin:a', 1), url: 'https://media.invalid/a' }), { status: 'unavailable', code: 'cache_open_failed' })
    const after = fs.statSync(cachePath)
    assert.equal(after.ino, before.ino)
    assert.equal(after.size, before.size)
  })

  it('makes the lifecycle unavailable without deleting a semantically invalid URL row', async() => {
    const fixture = await createFixture()
    await cacheDb.runCacheWrite(db => db.prepare(`
      INSERT INTO music_urls(
        provider, account_scope, source_track_id, quality, url,
        expires_at_ms, created_at_ms, last_accessed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('tx', 'profile-v1:uin:a', 'invalid', '320k', 'https://media.invalid/retained', 1.5, 1, 1))
    const get = repositoryFunction('../../src/main/worker/dbService/modules/music_url/index.ts', 'musicUrlGet')
    assert.deepEqual(await get(urlKey('profile-v1:uin:a', 1, { sourceTrackId: 'invalid' })), {
      status: 'unavailable', code: 'cache_operation_failed',
    })
    const db = new Database(path.join(fixture.path, 'cache', 'cache.db'))
    assert.equal(db.prepare(`SELECT count(*) AS count FROM music_urls WHERE source_track_id = 'invalid'`).get().count, 1)
    db.close()
  })
})

describe('scoped alternate-source cache repository', () => {
  it('atomically replaces the complete owner group, preserves rank order, and deletes on empty replacement', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    const get = repositoryFunction(modulePath, 'otherSourcesGet')
    await put({ ...owner(1), candidates: [candidate('a'), candidate('b', 'wy')] })
    await put({ ...owner(2), candidates: [candidate('b', 'wy')] })
    assert.deepEqual((await get(owner(3))).value.map(value => value.id), ['b'])
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT rank, candidate_track_id AS candidateTrackId FROM other_sources ORDER BY rank
    `).all()), { status: 'hit', value: [{ rank: 0, candidateTrackId: 'b' }] })
    assert.deepEqual(await put({ ...owner(4), candidates: [] }), { status: 'stored' })
    assert.deepEqual(await get(owner(5)), { status: 'miss' })
  })

  it('expires after exactly 30 days and touches only the selected owner on a valid hit', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    const get = repositoryFunction(modulePath, 'otherSourcesGet')
    await put({ ...owner(10), candidates: [candidate('a')] })
    await put({ ...owner(20, { originalTrackId: 'other' }), candidates: [candidate('b')] })
    assert.equal((await get(owner(10 + 30 * DAY_MS - 1))).status, 'hit')
    assert.deepEqual(await get(owner(10 + 30 * DAY_MS)), { status: 'miss' })
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`
      SELECT original_track_id AS originalTrackId, last_accessed_at_ms AS lastAccessedAtMs
      FROM other_source_groups ORDER BY original_track_id
    `).all()), {
      status: 'hit',
      value: [
        { originalTrackId: 'original-1', lastAccessedAtMs: 10 + 30 * DAY_MS - 1 },
        { originalTrackId: 'other', lastAccessedAtMs: 20 },
      ],
    })
  })

  it('stores exact UTF-8 JSON bytes and returns strict deep clones with stream fields stripped', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    const get = repositoryFunction(modulePath, 'otherSourcesGet')
    const input = candidate('utf8', 'tx', {
      name: 'A\u{1f600}',
      url: 'https://media.invalid/strip-root',
      playUrl: 'https://media.invalid/strip-play',
      meta: {
        songId: 'utf8', albumName: '\u4e13\u8f91', qualitys: [], _qualitys: {},
        streamUrl: 'https://media.invalid/strip-meta',
      },
    })
    await put({ ...owner(100), candidates: [input] })
    const stored = await cacheDb.runCacheRead(db => db.prepare(`
      SELECT candidate_json AS candidateJson, byte_size AS byteSize FROM other_sources
    `).get())
    assert.equal(stored.status, 'hit')
    assert.equal(stored.value.byteSize, Buffer.byteLength(stored.value.candidateJson, 'utf8'))
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare(`SELECT byte_size AS byteSize FROM other_source_groups`).get()), {
      status: 'hit', value: { byteSize: stored.value.byteSize },
    })
    const result = await get(owner(101))
    assert.equal(result.status, 'hit')
    assert.equal('url' in result.value[0], false)
    assert.equal('playUrl' in result.value[0], false)
    assert.equal('streamUrl' in result.value[0].meta, false)
    result.value[0].meta.albumName = 'mutated'
    assert.equal((await get(owner(102))).value[0].meta.albumName, '\u4e13\u8f91')
  })

  it('rejects credentials, duplicate candidate identities, and duplicate explicit ranks before mutation', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    const get = repositoryFunction(modulePath, 'otherSourcesGet')
    await put({ ...owner(1), candidates: [candidate('keep')] })
    const invalidGroups = [
      [candidate('secret', 'tx', { meta: { songId: 'secret', albumName: '', qualitys: [], _qualitys: {}, token: 'credential' } })],
      [candidate('same'), candidate('same')],
      [candidate('rank-a', 'tx', { rank: 0 }), candidate('rank-b', 'wy', { rank: 0 })],
    ]
    for (const candidates of invalidGroups) {
      await assert.rejects(put({ ...owner(2), candidates }), error => error?.code == 'other_sources_input_invalid')
      assert.deepEqual((await get(owner(3))).value.map(value => value.id), ['keep'])
    }
  })

  it('rejects hostile candidate identities, ranks, and prototype-bearing metadata before mutation', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    const get = repositoryFunction(modulePath, 'otherSourcesGet')
    await put({ ...owner(1), candidates: [candidate('keep')] })
    const prototypeCandidate = candidate('prototype')
    prototypeCandidate.meta = JSON.parse(
      '{"songId":"prototype","albumName":"","qualitys":[],"_qualitys":{},"__proto__":{"token":"credential"}}',
    )
    const invalidGroups = [
      [candidate('local-provider', 'local')],
      [candidate(' noncanonical-id')],
      [candidate('null-rank', 'tx', { rank: null })],
      [prototypeCandidate],
    ]
    for (const candidates of invalidGroups) {
      await assert.rejects(put({ ...owner(2), candidates }), error => error?.code == 'other_sources_input_invalid')
      assert.deepEqual((await get(owner(3))).value.map(value => value.id), ['keep'])
    }
  })

  it('rolls back the owner delete when a ranked insert fails', async() => {
    const fixture = await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    await put({ ...owner(1), candidates: [candidate('keep')] })
    await cacheDb.runCacheImmediate(db => db.exec(`
      CREATE TRIGGER fail_other_source_insert BEFORE INSERT ON other_sources
      WHEN NEW.candidate_track_id = 'fail'
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
    `))
    assert.deepEqual(await put({ ...owner(2), candidates: [candidate('fail')] }), {
      status: 'unavailable', code: 'cache_operation_failed',
    })
    const db = new Database(path.join(fixture.path, 'cache', 'cache.db'))
    assert.deepEqual(db.prepare(`
      SELECT candidate_track_id AS candidateTrackId FROM other_sources
      WHERE original_provider = 'local' AND original_track_id = 'original-1'
    `).all(), [{ candidateTrackId: 'keep' }])
    db.close()
  })

  it('rejects hostile ownership shapes and returns unavailable through lifecycle gates', async() => {
    await createFixture()
    const modulePath = '../../src/main/worker/dbService/modules/music_other_source/index.ts'
    const put = repositoryFunction(modulePath, 'otherSourcesPut')
    const get = repositoryFunction(modulePath, 'otherSourcesGet')
    await assert.rejects(put({ ...owner(1), candidates: [candidate('a')], extra: true }), error => error?.code == 'other_sources_input_invalid')
    await assert.rejects(get({ ...owner(1), extra: true }), error => error?.code == 'other_sources_input_invalid')
    await cacheDb.closeCacheDatabase()
    assert.deepEqual(await get(owner(2)), { status: 'unavailable', code: 'cache_open_failed' })
    assert.deepEqual(await put({ ...owner(2), candidates: [candidate('a')] }), { status: 'unavailable', code: 'cache_open_failed' })
  })

  it('makes the lifecycle unavailable without deleting a corrupt owner group', async() => {
    const fixture = await createFixture()
    await cacheDb.runCacheWrite(db => db.prepare(`
      INSERT INTO other_source_groups(
        original_provider, original_track_id, byte_size, expires_at_ms, created_at_ms, last_accessed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('local', 'corrupt', 7, 1000, 1, 1))
    const get = repositoryFunction('../../src/main/worker/dbService/modules/music_other_source/index.ts', 'otherSourcesGet')
    assert.deepEqual(await get(owner(2, { originalTrackId: 'corrupt' })), {
      status: 'unavailable', code: 'cache_operation_failed',
    })
    const db = new Database(path.join(fixture.path, 'cache', 'cache.db'))
    assert.equal(db.prepare(`SELECT count(*) AS count FROM other_source_groups WHERE original_track_id = 'corrupt'`).get().count, 1)
    db.close()
  })
})

describe('cache identity validation', () => {
  it('derives only normalized public profile scopes and rejects identity-less profiles', () => {
    const validation = require('../../src/common/storage/cacheValidation.ts')
    assert.equal(typeof validation.neteaseAccountScope, 'function')
    assert.equal(typeof validation.qqMusicAccountScope, 'function')
    assert.equal(validation.neteaseAccountScope({ userId: 7 }), 'profile-v1:user-id:7')
    assert.equal(validation.neteaseAccountScope({ userId: 0 }), null)
    assert.equal(validation.neteaseAccountScope({ userId: 1.5 }), null)
    assert.equal(validation.qqMusicAccountScope({ uin: '10001' }), 'profile-v1:uin:10001')
    assert.equal(validation.qqMusicAccountScope({ uin: ' 10001' }), null)
    assert.equal(validation.qqMusicAccountScope({ uin: 'x\n' }), null)
    assert.equal(validation.qqMusicAccountScope({ uin: '\u754c'.repeat(43) }), null)
    assert.equal(validation.qqMusicAccountScope(null), null)
  })
})
