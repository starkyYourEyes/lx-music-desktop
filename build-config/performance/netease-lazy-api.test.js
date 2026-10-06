const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const Module = require('node:module')
const load = require('../../scripts/test-utils/load-ts-module')

test('NetEase facade loads only used endpoints and preserves upstream cookie, proxy, and request arguments', async() => {
  const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts')
  const loaded = []
  const calls = []
  const request = async(...args) => { calls.push(args); return { body: { code: 200 }, cookie: ['updated=value'] } }
  const cookies = []
  const api = createNeteaseApiClient({
    loadEndpoint(name) { loaded.push(name); return async(query, send) => { cookies.push(query.cookie); return send('POST', `/api/${name}`, query, { proxy: query.proxy }) } },
    loadRequest: () => request,
    parseCookie: text => Object.fromEntries(text.split(';').map(pair => pair.trim().split('='))),
  })
  assert.deepEqual(loaded, [])
  for (const name of ['login_qr_key', 'login_qr_create', 'recommend_songs', 'song_url_v1', 'api']) {
    const result = await api[name]({ cookie: 'MUSIC_U=abc; __csrf=token', proxy: 'http://127.0.0.1:1080', id: 12 })
    assert.deepEqual(result.cookie, ['updated=value'])
  }
  assert.deepEqual(loaded, ['login_qr_key', 'login_qr_create', 'recommend_songs', 'song_url_v1', 'api'])
  assert.deepEqual(cookies[0], { MUSIC_U: 'abc', __csrf: 'token' })
  assert.equal(calls[0][0], 'POST')
  assert.equal(calls[0][3].proxy, 'http://127.0.0.1:1080')
  const cookie = { MUSIC_U: 'object-cookie' }
  await api.song_url_v1({ cookie })
  assert.equal(cookies.at(-1), cookie)
  assert.equal(loaded.filter(name => name == 'song_url_v1').length, 1)
})

test('recommendation activity excludes overlapping playback and account requests after prewarm', async() => {
  const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts')
  const previousLx = global.lx
  global.lx = { appSetting: {} }
  const pending = new Map()
  const states = []
  let api
  const main = load('src/main/modules/netease.ts', {
    './netease/api': {
      createNeteaseApiClient: dependencies => (api = createNeteaseApiClient({
        ...dependencies,
        loadEndpoint: name => () => new Promise((resolve, reject) => { pending.set(name, { resolve, reject }) }),
        loadRequest: () => async() => ({}),
      })),
    },
    '@common/performance/featurePolicy': { getFeatureMode: () => 'onDemand' },
    '@main/services/optionalResources': { reportOptionalResourceState: (_feature, state) => states.push(state) },
    '@common/utils/common': {},
    '@common/utils/neteaseDailySongCategory': {},
    './netease/account': {},
    './neteasePlaylist': {},
    './netease/userPlaylists': {},
  })
  try {
    main.prepareNeteaseRecommendation()
    const activity = () => states.filter(state => Object.hasOwn(state, 'active')).map(state => state.active)
    assert.deepEqual(activity(), [])
    const playback = api.song_url_v1()
    const account = api.login_status()
    assert.deepEqual(activity(), [])
    const first = api.recommend_songs()
    const second = api.personalized()
    assert.deepEqual(activity(), [true, true])
    pending.get('recommend_songs').resolve({})
    await first
    assert.equal(activity().at(-1), true)
    const failed = assert.rejects(second, /recommendation unavailable/)
    pending.get('personalized').reject(new Error('recommendation unavailable'))
    await failed
    assert.deepEqual(activity(), [true, true, true, false])
    pending.get('song_url_v1').resolve({})
    pending.get('login_status').resolve({})
    await Promise.all([playback, account])
    assert.deepEqual(activity(), [true, true, true, false])
  } finally { global.lx = previousLx }
})

test('real NetEase endpoint preparation excludes server and unrelated endpoints', () => {
  const before = new Set(Object.keys(require.cache))
  global.__non_webpack_require__ = Module.createRequire(path.resolve('package.json'))
  try {
    const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts')
    const client = createNeteaseApiClient()
    assert.equal(Object.keys(require.cache).filter(key => !before.has(key) && key.includes('@neteasecloudmusicapienhanced')).length, 0)
    client.prepare(['recommend_songs', 'personalized'])
    const added = Object.keys(require.cache).filter(key => !before.has(key)).map(key => key.replaceAll('\\', '/'))
    assert.ok(added.some(key => key.endsWith('/module/recommend_songs.js')))
    assert.equal(added.some(key => key.endsWith('/api/main.js') || key.endsWith('/api/server.js')), false)
    assert.equal(added.some(key => key.includes('/module/') && key.endsWith('/login_qr_check.js')), false)
  } finally { delete global.__non_webpack_require__ }
})

test('local account construction and fresh status use no upstream modules', async() => {
  let upstreamLoads = 0
  global.__non_webpack_require__ = () => { upstreamLoads++; throw new Error('unexpected upstream access') }
  const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts')
  const { createNeteaseAccountService } = load('src/main/modules/netease/account.ts')
  const createApi = createNeteaseApiClient()
  const account = createNeteaseAccountService({
    api: createApi,
    accounts: { getCookie: () => 'MUSIC_U=local', getStatus: () => ({ profile: { userId: 42, nickname: 'Local' }, updatedAtMs: Date.now() }) },
    musicUrlAuthorization: {},
  })
  try {
    assert.equal(account.getCookie(), 'MUSIC_U=local')
    assert.equal(account.getProfile().userId, 42)
    assert.equal((await account.getAccountStatus()).isLoggedIn, true)
    assert.equal(upstreamLoads, 0)
  } finally { delete global.__non_webpack_require__ }
})

test('pinned QR, recommendation, generic search and song URL endpoints retain upstream request options', async() => {
  global.__non_webpack_require__ = Module.createRequire(path.resolve('package.json'))
  const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts')
  const calls = []
  const api = createNeteaseApiClient({ loadRequest: () => async(...args) => { calls.push(args); return { body: { unikey: 'key', code: 200 }, cookie: ['a=b'] } } })
  const base = { cookie: 'MUSIC_U=a%2Bb; __csrf=encoded%20value', proxy: 'http://localhost:1080', realIP: '1.2.3.4' }
  try {
    assert.equal((await api.login_qr_key(base)).body.data.unikey, 'key')
    assert.match((await api.login_qr_create({ ...base, key: 'key' })).body.data.qrurl, /codekey=key/)
    await api.recommend_songs({ ...base, afresh: true })
    await api.api({ ...base, uri: '/api/search/get', data: { s: 'song', type: 1 }, crypto: 'weapi' })
    await api.song_url_v1({ ...base, id: 42, level: 'lossless' })
    assert.deepEqual(calls.map(call => call[0]), ['/api/login/qrcode/unikey', '/api/v3/discovery/recommend/songs', '/api/search/get', '/api/song/enhance/player/url/v1'])
    assert.deepEqual(calls[3][1], { ids: '[42]', level: 'lossless', encodeType: 'flac' })
    for (const call of calls) {
      assert.equal(call[2].proxy, base.proxy)
      assert.equal(call[2].realIP, base.realIP)
      assert.deepEqual(call[2].cookie, { MUSIC_U: 'a%2Bb', __csrf: 'encoded%20value' })
    }
  } finally { delete global.__non_webpack_require__ }
})

test('real request preparation never reads or creates a shared operating-system token file', () => {
  const fs = require('node:fs')
  const reads = []
  const guardedFs = {
    ...fs,
    openSync() { assert.fail('request preparation must not create a shared token file') },
    readFileSync(filename, ...args) {
      reads.push(String(filename))
      assert.notEqual(path.basename(String(filename)), 'anonymous_token', 'SDK token bootstrap must stay in memory')
      return fs.readFileSync(filename, ...args)
    },
  }
  const previous = global.__non_webpack_require__
  global.__non_webpack_require__ = Module.createRequire(path.resolve('package.json'))
  try {
    const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts', { 'node:fs': guardedFs })
    createNeteaseApiClient().prepare(['recommend_songs'])
    assert.ok(reads.some(file => file.endsWith('request.js')))
  } finally {
    if (previous === undefined) delete global.__non_webpack_require__
    else global.__non_webpack_require__ = previous
  }
})

test('scoped SDK loader preserves request arguments, dependency resolution and failures without global patches', async() => {
  const fs = require('node:fs')
  const os = require('node:os')
  const { createTestStorageRoot } = require('../storage/helpers/test-storage-root')
  const fixture = createTestStorageRoot('netease-sdk-boundary')
  const previousRequire = global.__non_webpack_require__
  const originalTmpdir = os.tmpdir
  const originalRead = fs.readFileSync
  const originalLoad = Module._load
  try {
    fs.mkdirSync(path.join(fixture.path, 'util'))
    fs.writeFileSync(path.join(fixture.path, 'util', 'value.json'), '{"value":42}')
    fs.writeFileSync(path.join(fixture.path, 'util', 'request.js'), [
      "const fs = require('fs'), path = require('path'), os = require('os')",
      "const token = fs.readFileSync(path.join(os.tmpdir(), 'anonymous_token'), 'utf8')",
      "const value = JSON.parse(fs.readFileSync(require.resolve('./value.json'), 'utf8')).value",
      "module.exports = async (...args) => { if(args[0] === 'fail') throw new Error('request rejected'); return { args, token, value, filename: __filename, directory: __dirname } }",
    ].join('\n'))
    global.__non_webpack_require__ = Object.assign(() => assert.fail('injected endpoint must remain isolated'), { resolve: () => path.join(fixture.path, 'index.js') })
    const { createNeteaseApiClient } = load('src/main/modules/netease/api.ts')
    let endpointLoads = 0
    const client = createNeteaseApiClient({ loadEndpoint: () => { endpointLoads++; return async(query, send) => send(query.method, query.data, query.cookie, query.proxy) } })
    const input = { method: 'POST', data: { id: 12 }, cookie: { MUSIC_U: 'synthetic' }, proxy: 'http://127.0.0.1:1080' }
    const result = await client.recommend_songs(input)
    assert.deepEqual(result.args, [input.method, input.data, input.cookie, input.proxy])
    assert.equal(result.token, '')
    assert.equal(result.value, 42)
    assert.equal(result.filename, path.join(fixture.path, 'util', 'request.js'))
    assert.equal(result.directory, path.join(fixture.path, 'util'))
    await assert.rejects(client.recommend_songs({ method: 'fail' }), /request rejected/)
    assert.equal(endpointLoads, 1)
    assert.deepEqual(fs.readdirSync(path.join(fixture.path, 'util')).sort(), ['request.js', 'value.json'])
    assert.equal(os.tmpdir, originalTmpdir)
    assert.equal(fs.readFileSync, originalRead)
    assert.equal(Module._load, originalLoad)
  } finally {
    if (previousRequire === undefined) delete global.__non_webpack_require__
    else global.__non_webpack_require__ = previousRequire
    fixture.cleanup()
  }
})
