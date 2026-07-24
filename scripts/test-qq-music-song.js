const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const { getCookieValue } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)

let request
let fetchCalls = 0
const fetchImpl = async(url, options) => {
  fetchCalls++
  request = { url, options }
  return {
    ok: true,
    json: async() => ({
      code: 0,
      songlist: {
        code: 0,
        data: {
          tracks: [
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
          ],
        },
      },
    }),
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
  },
)

const service = createQQMusicSongService({
  fetchImpl,
  getCookie: () => 'uin=o123; qqmusic_key=secret',
})

service.getGuessLikeSongs().then(async songs => {
  assert.match(String(request.url), /musicu\.fcg/)
  assert.strictEqual(new URL(request.url).searchParams.get('loginUin'), '123')
  assert.strictEqual(request.options.method, 'POST')
  assert.strictEqual(request.options.headers['Content-Type'], 'application/json')
  assert.strictEqual(request.options.headers.Referer, 'https://y.qq.com/')
  assert.strictEqual(request.options.headers.Cookie, 'uin=o123; qqmusic_key=secret')
  const body = JSON.parse(request.options.body)
  assert.deepStrictEqual(body.comm, { ct: 24, cv: 0 })
  assert.strictEqual(body.songlist.module, 'mb_track_radio_svr')
  assert.strictEqual(body.songlist.method, 'get_radio_track')
  assert.deepStrictEqual(body.songlist.param, { id: 99, firstplay: 1, num: 15 })
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

  const malformedSingerSongs = normalizeGuessLikeSongs({
    songlist: {
      data: {
        tracks: [{ id: 20, mid: 'null-singer', name: 'No Singer', singer: null, file: {} }],
      },
    },
  })
  assert.strictEqual(malformedSingerSongs.length, 1)
  assert.strictEqual(malformedSingerSongs[0].singer, '')

  await service.getGuessLikeSongs({ continuation: true })
  const continuationBody = JSON.parse(request.options.body)
  assert.deepStrictEqual(continuationBody.songlist.param, {
    id: 99,
    firstplay: 0,
    num: 15,
  })
  assert.strictEqual(fetchCalls, 2)
  const noCookie = createQQMusicSongService({ fetchImpl, getCookie: () => '' })
  await assert.rejects(noCookie.getGuessLikeSongs(), QQMusicAuthError)
  assert.strictEqual(fetchCalls, 2)

  const createFetchWithPayload = payload => async() => ({
    ok: true,
    json: async() => payload,
  })
  const expired = createQQMusicSongService({
    fetchImpl: createFetchWithPayload({ code: 0, songlist: { code: 1000 } }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(expired.getGuessLikeSongs(), QQMusicAuthError)

  const failed = createQQMusicSongService({
    fetchImpl: createFetchWithPayload({ code: 1, songlist: { code: 500 } }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(failed.getGuessLikeSongs(), error => {
    assert.strictEqual(isQQMusicAuthError(error), false)
    return true
  })
  assert.strictEqual(isQQMusicAuthError({ name: 'QQMusicAuthError' }), true)
}).then(() => {
  console.log('QQ Music song tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
