const assert = require('node:assert')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const { getCookieValue, getGtk } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)
const requestModulePath = path.join(__dirname, '../src/main/modules/qqMusic/request.ts')
const requestModule = fs.existsSync(requestModulePath) ? loadTsModule(requestModulePath) : {}

const tracks = [
  {
    id: 17,
    mid: 'song-mid',
    name: 'Song',
    interval: 185,
    singer: [{ name: 'Singer' }],
    album: { mid: 'album-mid', name: 'Album' },
    file: {
      media_mid: 'media-mid',
      size_128mp3: 1024,
      size_320mp3: 2048,
      size_flac: 4096,
      size_hires: 0,
    },
  },
  { id: 18, mid: 'song-mid', name: 'Duplicate', file: {} },
  { id: 19, mid: '', name: 'Malformed', file: {} },
]

const createFetchWithPayload = (payload, ok = true, status = 200) => async(url, options) => ({
  ok,
  status,
  json: async() => payload,
  request: { url, options },
})

const songModule = loadTsModule(path.join(__dirname, '../src/main/modules/qqMusic/song.ts'), {
  '@common/utils/common': {
    formatPlayTime: value => `time:${value}`,
    sizeFormate: value => `size:${value}`,
  },
  './auth': { getCookieValue },
  './request': requestModule,
})

const { createQQMusicDailyRecommendService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/dailyRecommend.ts'),
  {
    './auth': { getCookieValue, getGtk },
    './song': songModule,
    './request': requestModule,
  },
)

const run = async() => {
  let request
  const fetchImpl = async(url, options) => {
    request = { url, options }
    return { ok: true, status: 200, json: async() => ({ code: 0, req_1: { code: 0, data: { songlist: tracks } } }) }
  }
  const service = createQQMusicDailyRecommendService({
    fetchImpl,
    getCookie: () => 'qqmusic_uin=123; qqmusic_key=secret; qqmusic_guid=guid-123; uid=uid-123',
  })
  const songs = await service.getDailyRecommendSongs()
  const requestUrl = new URL(request.url)
  assert.strictEqual(requestUrl.origin + requestUrl.pathname, 'https://u6.y.qq.com/cgi-bin/musics.fcg')
  const sign = requestUrl.searchParams.get('sign')
  assert.match(sign, /^zza[a-z0-9]{10,16}[0-9a-f]{32}$/)
  assert.ok(!String(request.url).includes('secret'))
  assert.strictEqual(request.options.method, 'POST')
  assert.strictEqual(request.options.headers['Content-Type'], 'application/json')
  assert.strictEqual(request.options.headers.Referer, 'https://y.qq.com/')
  assert.strictEqual(request.options.headers.Cookie, 'qqmusic_uin=123; qqmusic_key=secret; qqmusic_guid=guid-123; uid=uid-123')
  assert.strictEqual(
    sign.slice(-32),
    createHash('md5').update(`CJBPACrRuNy7${request.options.body}`).digest('hex'),
  )
  assert.deepStrictEqual(JSON.parse(request.options.body), {
    comm: {
      format: 'json',
      ct: 20,
      cv: 2116,
      platform: 'wk_v17',
      uid: 'uid-123',
      guid: 'guid-123',
      inCharset: 'utf-8',
      outCharset: 'utf-8',
      notice: 0,
      needNewCode: 1,
      uin: '123',
      g_tk_new_20200303: 461122539,
      g_tk: 461122539,
    },
    req_1: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: 0,
        userinfo: 1,
        tag: 1,
        is_pc: 1,
        guid: 'guid-123',
        enc_host_uin: '123',
        dirid: 202,
      },
    },
  })
  await createQQMusicDailyRecommendService({
    fetchImpl,
    getCookie: () => 'uin=o456; qm_keyst=another-secret; qqmusic_guid=guid-456; uid=uid-456',
  }).getDailyRecommendSongs()
  const fallbackBody = JSON.parse(request.options.body)
  assert.strictEqual(fallbackBody.comm.uin, '456')
  assert.strictEqual(fallbackBody.req_1.param.enc_host_uin, '456')
  assert.strictEqual(fallbackBody.comm.guid, 'guid-456')
  assert.strictEqual(fallbackBody.comm.uid, 'uid-456')
  assert.strictEqual(fallbackBody.comm.g_tk, fallbackBody.comm.g_tk_new_20200303)
  const cookieWithoutDeviceIds = 'qqmusic_uin=789; qqmusic_key=fallback-secret'
  await createQQMusicDailyRecommendService({
    fetchImpl,
    getCookie: () => cookieWithoutDeviceIds,
  }).getDailyRecommendSongs()
  const generatedDeviceBody = JSON.parse(request.options.body)
  assert.match(generatedDeviceBody.comm.guid, /^[0-9a-f]{32}$/)
  assert.match(generatedDeviceBody.comm.uid, /^\d{10}$/)
  assert.strictEqual(generatedDeviceBody.req_1.param.guid, generatedDeviceBody.comm.guid)
  await createQQMusicDailyRecommendService({
    fetchImpl,
    getCookie: () => cookieWithoutDeviceIds,
  }).getDailyRecommendSongs()
  const repeatedDeviceBody = JSON.parse(request.options.body)
  assert.strictEqual(repeatedDeviceBody.comm.guid, generatedDeviceBody.comm.guid)
  assert.strictEqual(repeatedDeviceBody.comm.uid, generatedDeviceBody.comm.uid)
  assert.deepStrictEqual(songs, [{
    id: 'tx_song-mid', name: 'Song', singer: 'Singer', source: 'tx', interval: 'time:185',
    meta: {
      songId: 'song-mid', albumName: 'Album', albumId: 'album-mid',
      picUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000album-mid.jpg',
      strMediaMid: 'media-mid', id: 17, albumMid: 'album-mid',
      songType: undefined,
      qualitys: [{ type: 'flac', size: 'size:4096' }, { type: '320k', size: 'size:2048' }, { type: '128k', size: 'size:1024' }],
      _qualitys: { flac: { size: 'size:4096' }, '320k': { size: 'size:2048' }, '128k': { size: 'size:1024' } },
    },
  }])

  const { QQMusicAuthError } = songModule
  const noCookie = createQQMusicDailyRecommendService({ fetchImpl, getCookie: () => '' })
  await assert.rejects(noCookie.getDailyRecommendSongs(), QQMusicAuthError)
  for (const incompleteCookie of [
    'qqmusic_key=secret; qqmusic_guid=guid-123; uid=uid-123',
    'qqmusic_uin=123; qqmusic_guid=guid-123; uid=uid-123',
  ]) {
    const incomplete = createQQMusicDailyRecommendService({ fetchImpl, getCookie: () => incompleteCookie })
    await assert.rejects(incomplete.getDailyRecommendSongs(), QQMusicAuthError)
  }
  const validCookie = 'qqmusic_uin=123; qqmusic_key=secret; qqmusic_guid=guid-123; uid=uid-123'
  const httpFailed = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload({}, false, 503), getCookie: () => validCookie })
  await assert.rejects(httpFailed.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  const leakingFetchFailure = createQQMusicDailyRecommendService({
    fetchImpl: async() => { throw new Error('request failed for secret') },
    getCookie: () => validCookie,
  })
  await assert.rejects(leakingFetchFailure.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  let timeoutCallback
  let clearedTimer
  const aborting = createQQMusicDailyRecommendService({
    fetchImpl: async(_url, options) => new Promise((_resolve, reject) => {
      assert.ok(options.signal instanceof AbortSignal)
      options.signal.addEventListener('abort', () => reject(new Error('request failed for secret')))
    }),
    getCookie: () => validCookie,
    setTimeoutImpl: (callback, delay) => {
      assert.strictEqual(delay, 10_000)
      timeoutCallback = callback
      return 'daily30-timer'
    },
    clearTimeoutImpl: timer => { clearedTimer = timer },
  })
  const abortedRequest = aborting.getDailyRecommendSongs()
  await Promise.resolve()
  assert.strictEqual(typeof timeoutCallback, 'function')
  timeoutCallback()
  await assert.rejects(abortedRequest, error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  assert.strictEqual(clearedTimer, 'daily30-timer')
  for (const payload of [{ code: 1000 }, { code: 0, req_1: { code: 1000 } }]) {
    const expired = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload(payload), getCookie: () => validCookie })
    await assert.rejects(expired.getDailyRecommendSongs(), QQMusicAuthError)
  }
  const businessFailed = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload({ code: 0, req_1: { code: 1 } }), getCookie: () => validCookie })
  await assert.rejects(businessFailed.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  const malformed = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload({ code: 0, req_1: { code: 0, data: { songlist: {} } } }), getCookie: () => validCookie })
  await assert.rejects(malformed.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
}

run().then(() => console.log('QQ Music daily 30 tests passed')).catch(error => {
  console.error(error)
  process.exitCode = 1
})
