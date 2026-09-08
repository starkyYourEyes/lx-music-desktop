/* eslint-disable n/no-deprecated-api */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const typescript = require('typescript')

const root = path.resolve(__dirname, '..')
const previousLoader = require.extensions['.ts']
require.extensions['.ts'] = (mod, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: filename,
  }).outputText
  mod._compile(output, filename)
}

const previousNativeRequire = global.__non_webpack_require__
global.__non_webpack_require__ = require
const { createKugouApiClient, createKugouRequest } = require(path.join(root, 'src/main/modules/kugouMusic/api.ts'))
const { createKugouRecommendationService, KugouAuthError } = require(path.join(root, 'src/main/modules/kugouMusic/recommend.ts'))
if (previousNativeRequire == null) delete global.__non_webpack_require__
else global.__non_webpack_require__ = previousNativeRequire
require.extensions['.ts'] = previousLoader

const song = (overrides = {}) => ({
  hash: 'ABC123',
  songname: 'Song',
  singername: 'Singer',
  album_name: 'Album',
  duration: 185,
  album_sizable_cover: 'https://img.example/cover.jpg',
  filesize: 1024 * 1024,
  ...overrides,
})

test('normalizes public playlist and rank responses from nested body.data and direct data', async() => {
  const calls = []
  const api = createKugouApiClient({
    top_playlist: async params => { calls.push(['top_playlist', params]); return { body: { code: 0, data: { list: [{ specialid: 7, name: 'Mix', intro: 'desc', imgurl: '' }] } } } },
    rank_list: async params => { calls.push(['rank_list', params]); return { data: { info: [{ rankid: 8, rankname: 'Top', imgurl: '' }] } } },
    rank_audio: async params => { calls.push(['rank_audio', params]); return { body: { code: 0, data: { songs: [song()] } } } },
  })
  const service = createKugouRecommendationService({ api, getCookie: () => '' })
  const publicResult = await service.getPublicRecommendation()
  assert.equal(publicResult.playlists[0].source, 'kg')
  assert.equal(publicResult.playlists[0].img, '')
  assert.equal(publicResult.ranks[0].source, 'kg')
  assert.equal(typeof calls[0][1].cookie.KUGOU_API_MID, 'string')
  assert.equal('token' in calls[0][1].cookie, false)
})

test('normalizes private songs, removes duplicates, and keeps required KuGou metadata', async() => {
  const api = createKugouApiClient({
    recommend_songs: async params => { assert.equal(params.cookie.userid, '42'); return { body: { code: 0, data: [song(), song({ hash: 'ABC123', songname: 'Duplicate' }), song({ hash: 'DEF456', songname: 'Second' })] } } },
    everyday_style_recommend: async params => { assert.equal(params.cookie.userid, '42'); return { data: { songs: [song({ hash: 'STYLE' })] } } },
    fm_recommend: async params => { assert.equal(params.cookie.userid, '42'); return { body: { code: 0, data: { songs: [{ fmid: 'fm-1' }] } } } },
    fm_songs: async params => { assert.equal(params.cookie.userid, '42'); assert.equal(params.fmid, 'fm-1'); return { data: { songs: [song({ hash: 'FM' })] } } },
  })
  const service = createKugouRecommendationService({ api, getCookie: () => 'userid=42' })
  const daily = await service.getDailyRecommendSongs()
  assert.equal(daily.length, 2)
  assert.deepEqual(Object.keys(daily[0].meta).sort(), ['_qualitys', 'albumName', 'hash', 'picUrl', 'qualitys', 'songId'].sort())
  assert.equal(daily[0].source, 'kg')
  assert.equal((await service.getStyleRecommendation()).length, 1)
  assert.equal((await service.getPrivateFmSongs()).length, 1)
})

test('returns empty lists for missing data and classifies explicit authentication failures', async() => {
  const api = createKugouApiClient({
    top_playlist: async() => ({ body: { code: 0, data: null } }),
    rank_list: async() => ({ body: { code: 0, data: null } }),
    rank_audio: async() => ({ body: { code: 0, data: null } }),
    recommend_songs: async() => ({ body: { code: 401, msg: 'login required' } }),
  })
  const service = createKugouRecommendationService({ api, getCookie: () => 'secret=redacted' })
  assert.deepEqual((await service.getPublicRecommendation()).playlists, [])
  await assert.rejects(service.getDailyRecommendSongs(), error => error instanceof KugouAuthError)
  const noCookie = createKugouRecommendationService({ api, getCookie: () => '' })
  await assert.rejects(noCookie.getDailyRecommendSongs(), error => error instanceof KugouAuthError)
})

test('wraps transport failures without exposing cookie values', async() => {
  const api = createKugouApiClient({ recommend_songs: async() => { throw new Error('request failed userid=42') } })
  const service = createKugouRecommendationService({ api, getCookie: () => 'userid=42' })
  await assert.rejects(service.getDailyRecommendSongs(), error => error.message == 'KuGou recommendation request failed' && !error.message.includes('42'))
})

test('classifies auth envelopes from rejected responses and every recommendation endpoint', async() => {
  const endpointNames = ['top_playlist', 'rank_list', 'rank_audio', 'everyday_style_recommend', 'fm_recommend', 'fm_songs']
  for (const endpoint of endpointNames) {
    const fixture = async() => ({ body: { code: 401, msg: 'login required' } })
    const api = createKugouApiClient({ top_playlist: fixture, rank_list: fixture, rank_audio: fixture, recommend_songs: fixture, everyday_style_recommend: fixture, fm_recommend: fixture, fm_songs: fixture, [endpoint]: fixture })
    const service = createKugouRecommendationService({ api, getCookie: () => 'userid=42' })
    const operation = endpoint == 'top_playlist' || endpoint == 'rank_list'
      ? service.getPublicRecommendation()
      : endpoint == 'rank_audio' ? service.getRankRecommendation()
        : endpoint == 'everyday_style_recommend' ? service.getStyleRecommendation()
          : endpoint == 'fm_recommend' ? service.getPrivateFmSongs() : service.getPrivateFmSongs()
    await assert.rejects(operation, error => error instanceof KugouAuthError)
  }
  const rejected = createKugouRecommendationService({
    api: createKugouApiClient({
      top_playlist: async() => {
        throw Object.assign(new Error('rejected response'), {
          response: { status: 502, body: { code: 401, msg: 'login required' } },
        })
      },
      rank_list: async() => { throw new Error('rank transport failed') },
    }),
    getCookie: () => 'userid=42',
  })
  await assert.rejects(rejected.getPublicRecommendation(), error => error instanceof KugouAuthError)
})

test('classifies rank_audio auth when rank_list succeeds', async() => {
  const api = createKugouApiClient({
    rank_list: async() => ({ body: { code: 0, data: { info: [{ rankid: 8, rankname: 'Top' }] } } }),
    rank_audio: async() => ({ body: { code: 401, msg: 'login required' } }),
  })
  const service = createKugouRecommendationService({ api, getCookie: () => '' })
  await assert.rejects(service.getRankRecommendation(), error => error instanceof KugouAuthError)
})

test('classifies fm_songs auth when fm_recommend succeeds', async() => {
  const api = createKugouApiClient({
    fm_recommend: async() => ({ body: { code: 0, data: { songs: [{ fmid: 'fm-1' }] } } }),
    fm_songs: async() => ({ body: { code: 401, msg: 'login required' } }),
  })
  const service = createKugouRecommendationService({ api, getCookie: () => 'userid=42' })
  await assert.rejects(service.getPrivateFmSongs(), error => error instanceof KugouAuthError)
})

test('rejects body status and error_code failures without leaking payloads', async() => {
  const makeService = response => createKugouRecommendationService({
    api: createKugouApiClient({ top_playlist: async() => response, rank_list: async() => response }),
    getCookie: () => '',
  })
  await assert.rejects(makeService({ body: { status: 0, msg: 'failed' } }).getPublicRecommendation(), /KuGou recommendation request failed/)
  await assert.rejects(makeService({ body: { error_code: 9, msg: 'failed' } }).getPublicRecommendation(), /KuGou recommendation request failed/)
})

test('uses distinct KuGou hashes for quality metadata and ignores zero sizes', async() => {
  const api = createKugouApiClient({ recommend_songs: async() => ({ body: { code: 0, data: [song({ filesize: '0', filesize_320: 2048, hash_320: 'HASH320', filesize_flac: 0, hash_flac: 'HASHFLAC' })] } }) })
  const result = await createKugouRecommendationService({ api, getCookie: () => 'userid=42' }).getDailyRecommendSongs()
  assert.deepEqual(result[0].meta.qualitys, [{ type: '320k', size: '2.00 KB', hash: 'HASH320' }])
})

test('uses one private device identity for public, private, and account calls', async() => {
  const calls = []
  const capture = async params => {
    calls.push(params)
    return { body: { status: 1, data: {} } }
  }
  const api = createKugouApiClient({
    top_playlist: capture,
    recommend_songs: capture,
    user_detail: capture,
  })

  await api.topPlaylist()
  await api.recommendSongs({ cookie: 'token=auth-fixture;userid=42;KUGOU_API_MID=stored-device' })
  await api.userInfo({ cookie: 'token=auth-fixture;userid=42' })

  const identityKeys = ['KUGOU_API_MID', 'KUGOU_API_GUID', 'KUGOU_API_DEV', 'KUGOU_API_WEBGL']
  for (const key of identityKeys) {
    assert.ok(calls[0].cookie[key])
    assert.equal(calls[1].cookie[key], calls[0].cookie[key])
    assert.equal(calls[2].cookie[key], calls[0].cookie[key])
  }
  assert.notEqual(calls[1].cookie.KUGOU_API_MID, 'stored-device')
  assert.equal(calls[1].cookie.token, 'auth-fixture')
  assert.equal(calls[1].cookie.userid, '42')
  assert.equal(calls[2].cookie.token, 'auth-fixture')
})

test('loads pinned endpoint modules without importing server dotenv side effects', async() => {
  const packageRoot = path.dirname(require.resolve('kugoumusicapi'))
  const serverPath = path.join(packageRoot, 'server.js')
  delete require.cache[serverPath]
  let requestOptions
  const api = createKugouApiClient(undefined, {
    request: async options => {
      requestOptions = options
      return { status: 200, body: { status: 1, data: {} }, cookie: [], headers: {} }
    },
  })

  assert.equal(require.cache[serverPath], undefined)
  await api.userInfo({ cookie: 'token=auth-fixture;userid=42' })
  assert.equal(new URL(requestOptions.url, requestOptions.baseURL || 'https://gateway.kugou.com').protocol, 'https:')
  assert.equal(requestOptions.url, '/v3/get_my_info')
})

test('rejects plaintext requests before credentials reach the network and ignores proxy environment state', async() => {
  assert.equal(typeof createKugouRequest, 'function')
  const calls = []
  const fetchFixture = async(url, options) => {
    calls.push({ url: String(url), options })
    return {
      status: 200,
      ok: true,
      headers: { get: () => null, getSetCookie: () => [] },
      text: async() => JSON.stringify({ status: 1, data: {} }),
    }
  }
  const request = createKugouRequest(fetchFixture)
  await assert.rejects(request({
    baseURL: 'http://relation.user.kugou.com',
    url: '/v1/get_my_userinfo',
    method: 'POST',
    data: { token: 'auth-fixture', userid: 42 },
    cookie: { token: 'auth-fixture', userid: '42' },
  }), /HTTPS/)
  assert.equal(calls.length, 0)

  const previousProxy = process.env.KUGOU_API_PROXY
  process.env.KUGOU_API_PROXY = 'http://launch-directory-proxy.invalid:8080'
  try {
    await request({
      url: '/public-fixture',
      method: 'GET',
      cookie: { KUGOU_API_MID: 'device-fixture' },
      notSignature: true,
    })
  } finally {
    if (previousProxy == null) delete process.env.KUGOU_API_PROXY
    else process.env.KUGOU_API_PROXY = previousProxy
  }
  assert.equal(new URL(calls[0].url).protocol, 'https:')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal('proxy' in calls[0].options, false)
  assert.equal('dispatcher' in calls[0].options, false)
})

test('normalizes pinned response envelopes and nested quality metadata', async() => {
  const rankSong = {
    audio_id: 7001,
    songname: 'Rank song',
    author_name: 'Rank artist',
    audio_info: {
      duration_128: 185000,
      filesize_128: 1024,
      hash_128: 'RANK128',
      filesize_320: 2048,
      hash_320: 'RANK320',
      filesize_flac: 4096,
      hash_flac: 'RANKFLAC',
      filesize_high: 8192,
      hash_high: 'RANKHIGH',
    },
    album_info: {
      album_name: 'Rank album',
      sizable_cover: 'https://img.example/{size}/rank.jpg',
    },
  }
  const recommendationSong = {
    songid: 7002,
    songname: 'Daily song',
    author_name: 'Daily artist',
    album_name: 'Daily album',
    time_length: 186,
    sizable_cover: 'https://img.example/{size}/daily.jpg',
    filesize_128: 1024,
    hash_128: 'DAILY128',
    filesize_320: 2048,
    hash_320: 'DAILY320',
  }
  const api = createKugouApiClient({
    top_playlist: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: { special_list: [{ specialid: 9, specialname: 'Pinned mix', imgurl: 'https://img.example/{size}/mix.jpg', nickname: 'Editor' }] } },
      cookie: [],
    }),
    rank_list: async() => ({
      status: 200,
      body: { status: 1, errcode: 0, data: { info: [{ rankid: 8, rankname: 'Pinned rank', imgurl: 'https://img.example/{size}/rank-list.jpg' }] } },
      cookie: [],
    }),
    rank_audio: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: { songlist: [rankSong] } },
      cookie: [],
    }),
    recommend_songs: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: { song_list: [recommendationSong] } },
      cookie: [],
    }),
    everyday_style_recommend: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: { song_list: [{ ...recommendationSong, songid: 7003, hash_128: 'STYLE128' }] } },
      cookie: [],
    }),
    fm_recommend: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: [{ fmid: '100' }] },
      cookie: [],
    }),
    fm_songs: async() => ({
      status: 200,
      body: { status: 1, error_code: 0, data: [{ fmid: 100, songs: [{ audio_id: 7004, name: 'FM artist - FM song', time: 187000, size: 1024, hash: 'FM128', '320size': 2048, '320hash': 'FM320' }] }] },
      cookie: [],
    }),
  })
  const service = createKugouRecommendationService({ api, getCookie: () => 'token=auth-fixture;userid=42' })

  const publicResult = await service.getPublicRecommendation()
  const rankResult = await service.getRankRecommendation()
  const daily = await service.getDailyRecommendSongs()
  const style = await service.getStyleRecommendation()
  const fm = await service.getPrivateFmSongs()

  assert.equal(publicResult.playlists[0].name, 'Pinned mix')
  assert.equal(publicResult.playlists[0].img, 'https://img.example/240/mix.jpg')
  assert.equal(publicResult.ranks[0].img, 'https://img.example/240/rank-list.jpg')
  assert.deepEqual(rankResult.songs[0], {
    id: 'kg_7001',
    name: 'Rank song',
    singer: 'Rank artist',
    source: 'kg',
    interval: '03:05',
    meta: {
      songId: '7001',
      albumName: 'Rank album',
      picUrl: 'https://img.example/240/rank.jpg',
      hash: 'RANK128',
      qualitys: [
        { type: '128k', size: '1.00 KB', hash: 'RANK128' },
        { type: '320k', size: '2.00 KB', hash: 'RANK320' },
        { type: 'flac', size: '4.00 KB', hash: 'RANKFLAC' },
        { type: 'flac24bit', size: '8.00 KB', hash: 'RANKHIGH' },
      ],
      _qualitys: {
        '128k': { size: '1.00 KB', hash: 'RANK128' },
        '320k': { size: '2.00 KB', hash: 'RANK320' },
        flac: { size: '4.00 KB', hash: 'RANKFLAC' },
        flac24bit: { size: '8.00 KB', hash: 'RANKHIGH' },
      },
    },
  })
  assert.equal(daily[0].singer, 'Daily artist')
  assert.equal(daily[0].interval, '03:06')
  assert.equal(daily[0].meta.picUrl, 'https://img.example/240/daily.jpg')
  assert.equal(style[0].meta.hash, 'STYLE128')
  assert.equal(fm[0].name, 'FM song')
  assert.equal(fm[0].singer, 'FM artist')
  assert.deepEqual(fm[0].meta.qualitys, [
    { type: '128k', size: '1.00 KB', hash: 'FM128' },
    { type: '320k', size: '2.00 KB', hash: 'FM320' },
  ])
})

test('settles public playlist and rank sources independently', async() => {
  const rankOnly = createKugouRecommendationService({
    api: createKugouApiClient({
      top_playlist: async() => { throw new Error('playlist transport failed') },
      rank_list: async() => ({ body: { status: 1, data: { info: [{ rankid: 8, rankname: 'Available rank' }] } } }),
    }),
    getCookie: () => '',
  })
  assert.deepEqual(await rankOnly.getPublicRecommendation(), {
    playlists: [],
    ranks: [{ id: '8', source: 'kg', name: 'Available rank', img: '', description: '', songs: [] }],
  })

  const playlistOnly = createKugouRecommendationService({
    api: createKugouApiClient({
      top_playlist: async() => ({ body: { status: 1, data: { special_list: [{ specialid: 9, specialname: 'Available mix' }] } } }),
      rank_list: async() => { throw new Error('rank transport failed') },
    }),
    getCookie: () => '',
  })
  assert.equal((await playlistOnly.getPublicRecommendation()).playlists[0].name, 'Available mix')
})

test('invalidates private authentication for HTTP 401 and 403 but not transport failures', async() => {
  for (const status of [401, 403]) {
    let authInvalidations = 0
    const auth = createKugouRecommendationService({
      api: createKugouApiClient({ recommend_songs: async() => ({ status, body: {} }) }),
      getCookie: () => 'token=auth-fixture;userid=42',
      onAuthFailure: async() => { authInvalidations++ },
    })
    await assert.rejects(auth.getDailyRecommendSongs(), error => error instanceof KugouAuthError)
    assert.equal(authInvalidations, 1)
  }

  let authInvalidations = 0
  const transport = createKugouRecommendationService({
    api: createKugouApiClient({ recommend_songs: async() => { throw new Error('network unavailable') } }),
    getCookie: () => 'token=auth-fixture;userid=42',
    onAuthFailure: async() => { authInvalidations++ },
  })
  await assert.rejects(transport.getDailyRecommendSongs(), /KuGou recommendation request failed/)
  assert.equal(authInvalidations, 0)
})

test('does not classify generic token text as an authentication failure', async() => {
  let authInvalidations = 0
  const service = createKugouRecommendationService({
    api: createKugouApiClient({
      recommend_songs: async() => ({ body: { status: 0, msg: 'token bucket temporarily unavailable' } }),
    }),
    getCookie: () => 'token=auth-fixture;userid=42',
    onAuthFailure: async() => { authInvalidations++ },
  })

  await assert.rejects(service.getDailyRecommendSongs(), error => !(error instanceof KugouAuthError))
  assert.equal(authInvalidations, 0)
})
