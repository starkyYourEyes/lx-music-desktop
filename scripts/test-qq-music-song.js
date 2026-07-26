const assert = require('node:assert')
const fs = require('node:fs')
const { createHash } = require('node:crypto')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const requestModulePath = path.join(__dirname, '../src/main/modules/qqMusic/request.ts')
const requestModule = fs.existsSync(requestModulePath) ? loadTsModule(requestModulePath) : {}
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
const newRequestKey = 'music.radioProxy.MbTrackRadioSvr.get_radio_track'

let request
let fetchCalls = 0
const fetchImpl = async(url, options) => {
  fetchCalls++
  request = { url, options }
  const body = JSON.parse(options.body)
  return {
    ok: true,
    status: 200,
    json: async() => body[newRequestKey]
      ? { code: 0, [newRequestKey]: { code: 0, data: { id: 99, name: 'Guess You Like', tracks } } }
      : { code: 0, songlist: { code: 0, data: { tracks } } },
  }
}

const {
  createQQMusicSongService,
  isQQMusicAuthError,
  normalizeGuessLikeSongs,
  QQMusicAuthError,
} = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/song.ts'),
  {
    '@common/utils/common': {
      formatPlayTime: value => `time:${value}`,
      sizeFormate: value => `size:${value}`,
    },
    './auth': { getCookieValue },
    './request': requestModule,
  },
)

const validCookie = [
  'uin=o123',
  'qqmusic_key=secret',
  'qqmusic_guid=guid-123',
  'uid=uid-123',
  'psrf_access_token_expiresAt=456',
  'psrf_qqaccess_token=access-token',
  'psrf_qqopenid=open-id',
  'psrf_qqunionid=union-id',
  'tmeLoginType=2',
  'wid=wid-123',
].join('; ')

const service = createQQMusicSongService({
  fetchImpl,
  getCookie: () => validCookie,
})

const assertNormalizedSongs = songs => {
  assert.strictEqual(songs.length, 1)
  assert.deepStrictEqual(songs[0], {
    id: 'tx_song-mid',
    name: 'Song',
    singer: 'Singer',
    source: 'tx',
    interval: 'time:185',
    meta: {
      songId: 'song-mid',
      albumName: 'Album',
      albumId: 'album-mid',
      picUrl: 'https://y.gtimg.cn/music/photo_new/T002R500x500M000album-mid.jpg',
      strMediaMid: 'media-mid',
      id: 17,
      albumMid: 'album-mid',
      qualitys: [
        { type: 'flac', size: 'size:4096' },
        { type: '320k', size: 'size:2048' },
        { type: '128k', size: 'size:1024' },
      ],
      _qualitys: {
        flac: { size: 'size:4096' },
        '320k': { size: 'size:2048' },
        '128k': { size: 'size:1024' },
      },
    },
  })
}

const createFetchWithPayload = payload => async() => ({
  ok: true,
  status: 200,
  json: async() => payload,
})

const run = async() => {
  const songs = await service.getGuessLikeSongs()
  const requestUrl = new URL(request.url)
  assert.strictEqual(requestUrl.origin + requestUrl.pathname, 'https://u6.y.qq.com/cgi-bin/musics.fcg')
  const sign = requestUrl.searchParams.get('sign')
  assert.match(sign, /^zza[a-z0-9]{10,16}[0-9a-f]{32}$/)
  assert.strictEqual(
    sign.slice(-32),
    createHash('md5').update(`CJBPACrRuNy7${request.options.body}`).digest('hex'),
  )
  assert.strictEqual(request.options.method, 'POST')
  assert.strictEqual(request.options.headers['Content-Type'], 'application/json')
  assert.strictEqual(request.options.headers.Referer, 'https://y.qq.com/')
  assert.strictEqual(request.options.headers.Cookie, validCookie)
  const body = JSON.parse(request.options.body)
  assert.strictEqual(body[newRequestKey].module, 'music.radioProxy.MbTrackRadioSvr')
  assert.strictEqual(body[newRequestKey].method, 'get_radio_track')
  assert.deepStrictEqual(body[newRequestKey].param, { id: 99, num: 15 })
  assert.deepStrictEqual(body.comm, {
    _channelid: '19',
    _os_version: '6.2.9200-2',
    authst: 'secret',
    ct: '19',
    cv: '2116',
    guid: 'guid-123',
    patch: '118',
    psrf_access_token_expiresAt: 456,
    psrf_qqaccess_token: 'access-token',
    psrf_qqopenid: 'open-id',
    psrf_qqunionid: 'union-id',
    tmeAppID: 'qqmusic',
    tmeLoginType: 2,
    uid: 'uid-123',
    uin: '123',
    wid: 'wid-123',
  })
  assertNormalizedSongs(songs)

  await service.getGuessLikeSongs({ continuation: true })
  assert.deepStrictEqual(JSON.parse(request.options.body)[newRequestKey].param, { id: 99, num: 15 })

  await service.getGuessLikeSongs({ radioMode: 'brush' })
  assert.deepStrictEqual(JSON.parse(request.options.body)[newRequestKey].param, { id: 99, num: 5 })

  await service.getGuessLikeSongs({ apiVersion: 'legacy' })
  assert.match(String(request.url), /musicu\.fcg/)
  assert.strictEqual(new URL(request.url).searchParams.get('loginUin'), '123')
  const legacyBody = JSON.parse(request.options.body)
  assert.deepStrictEqual(legacyBody.comm, { ct: 24, cv: 0 })
  assert.strictEqual(legacyBody.songlist.module, 'mb_track_radio_svr')
  assert.strictEqual(legacyBody.songlist.method, 'get_radio_track')
  assert.deepStrictEqual(legacyBody.songlist.param, { id: 99, firstplay: 1, num: 15 })

  await service.getGuessLikeSongs({ continuation: true, apiVersion: 'legacy' })
  assert.deepStrictEqual(JSON.parse(request.options.body).songlist.param, {
    id: 99,
    firstplay: 0,
    num: 15,
  })
  assert.strictEqual(fetchCalls, 5)

  const malformedSingerSongs = normalizeGuessLikeSongs({
    songlist: {
      data: {
        tracks: [{ id: 20, mid: 'null-singer', name: 'No Singer', singer: null, file: {} }],
      },
    },
  })
  assert.strictEqual(malformedSingerSongs.length, 1)
  assert.strictEqual(malformedSingerSongs[0].singer, '')

  const noCookie = createQQMusicSongService({ fetchImpl, getCookie: () => '' })
  await assert.rejects(noCookie.getGuessLikeSongs(), QQMusicAuthError)
  assert.strictEqual(fetchCalls, 5)

  for (const payload of [
    { code: 1000 },
    { code: 0, [newRequestKey]: { code: 1000 } },
  ]) {
    const expired = createQQMusicSongService({
      fetchImpl: createFetchWithPayload(payload),
      getCookie: () => validCookie,
    })
    await assert.rejects(expired.getGuessLikeSongs(), QQMusicAuthError)
  }

  const failed = createQQMusicSongService({
    fetchImpl: createFetchWithPayload({ code: 1, [newRequestKey]: { code: 500 } }),
    getCookie: () => validCookie,
  })
  await assert.rejects(failed.getGuessLikeSongs(), error => {
    assert.strictEqual(isQQMusicAuthError(error), false)
    assert.ok(!String(error).includes('secret'))
    return true
  })
  assert.strictEqual(isQQMusicAuthError({ name: 'QQMusicAuthError' }), true)
}

run().then(() => {
  console.log('QQ Music song tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
