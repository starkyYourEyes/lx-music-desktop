const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const { getCookieValue } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)

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
})

const { createQQMusicDailyRecommendService } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/dailyRecommend.ts'),
  {
    './auth': { getCookieValue },
    './song': songModule,
  },
)

const run = async() => {
  let request
  const fetchImpl = async(url, options) => {
    request = { url, options }
    return { ok: true, status: 200, json: async() => ({ code: 0, daily30: { code: 0, data: { tracks } } }) }
  }
  const service = createQQMusicDailyRecommendService({
    fetchImpl,
    getCookie: () => 'uin=o123; qqmusic_key=secret; tmeLoginType=2',
  })
  const songs = await service.getDailyRecommendSongs()
  assert.strictEqual(String(request.url), 'https://u6.y.qq.com/cgi-bin/musicu.fcg')
  assert.strictEqual(request.options.method, 'POST')
  assert.strictEqual(request.options.headers['Content-Type'], 'application/json')
  assert.strictEqual(request.options.headers.Referer, 'https://y.qq.com/')
  assert.strictEqual(request.options.headers.Cookie, 'uin=o123; qqmusic_key=secret; tmeLoginType=2')
  assert.deepStrictEqual(JSON.parse(request.options.body), {
    comm: { ct: 20, cv: 2116, uin: '123', authst: 'secret', tmeLoginType: 2 },
    daily30: { module: 'music.ai_track_daily_svr', method: 'get_daily_track', param: {} },
  })
  await createQQMusicDailyRecommendService({
    fetchImpl,
    getCookie: () => 'qqmusic_uin=o456; qqmusic_key=another-secret',
  }).getDailyRecommendSongs()
  assert.deepStrictEqual(JSON.parse(request.options.body).comm, {
    ct: 20, cv: 2116, uin: '456', authst: 'another-secret', tmeLoginType: 2,
  })
  for (const loginType of ['0', '-1', '1.5']) {
    await createQQMusicDailyRecommendService({
      fetchImpl,
      getCookie: () => `uin=o456; qqmusic_key=another-secret; tmeLoginType=${loginType}`,
    }).getDailyRecommendSongs()
    assert.strictEqual(JSON.parse(request.options.body).comm.tmeLoginType, 2)
  }
  assert.deepStrictEqual(songs, [{
    id: 'tx_song-mid', name: 'Song', singer: 'Singer', source: 'tx', interval: 'time:185',
    meta: {
      songId: 'song-mid', albumName: 'Album', albumId: 'album-mid',
      picUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000album-mid.jpg',
      strMediaMid: 'media-mid', id: 17, albumMid: 'album-mid',
      qualitys: [{ type: 'flac', size: 'size:4096' }, { type: '320k', size: 'size:2048' }, { type: '128k', size: 'size:1024' }],
      _qualitys: { flac: { size: 'size:4096' }, '320k': { size: 'size:2048' }, '128k': { size: 'size:1024' } },
    },
  }])

  const { QQMusicAuthError } = songModule
  const noCookie = createQQMusicDailyRecommendService({ fetchImpl, getCookie: () => '' })
  await assert.rejects(noCookie.getDailyRecommendSongs(), QQMusicAuthError)
  const httpFailed = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload({}, false, 503), getCookie: () => 'uin=o123; qqmusic_key=secret' })
  await assert.rejects(httpFailed.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  const leakingFetchFailure = createQQMusicDailyRecommendService({
    fetchImpl: async() => { throw new Error('request failed for secret') },
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(leakingFetchFailure.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  let timeoutCallback
  let clearedTimer
  const aborting = createQQMusicDailyRecommendService({
    fetchImpl: async(_url, options) => new Promise((_resolve, reject) => {
      assert.ok(options.signal instanceof AbortSignal)
      options.signal.addEventListener('abort', () => reject(new Error('request failed for secret')))
    }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
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
  for (const payload of [{ code: 1000 }, { code: 0, daily30: { code: 1000 } }]) {
    const expired = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload(payload), getCookie: () => 'uin=o123; qqmusic_key=secret' })
    await assert.rejects(expired.getDailyRecommendSongs(), QQMusicAuthError)
  }
  const businessFailed = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload({ code: 0, daily30: { code: 1 } }), getCookie: () => 'uin=o123; qqmusic_key=secret' })
  await assert.rejects(businessFailed.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
  const malformed = createQQMusicDailyRecommendService({ fetchImpl: createFetchWithPayload({ code: 0, daily30: { code: 0, data: { tracks: {} } } }), getCookie: () => 'uin=o123; qqmusic_key=secret' })
  await assert.rejects(malformed.getDailyRecommendSongs(), error => !(error instanceof QQMusicAuthError) && !String(error).includes('secret'))
}

run().then(() => console.log('QQ Music daily 30 tests passed')).catch(error => {
  console.error(error)
  process.exitCode = 1
})
