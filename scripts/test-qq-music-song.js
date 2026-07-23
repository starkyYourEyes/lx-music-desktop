const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const { getCookieValue } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)

let request
const fetchImpl = async(url, options) => {
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

const { createQQMusicSongService, QQMusicAuthError } = loadTsModule(
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

service.getGuessLikeSongs().then(songs => {
  assert.match(String(request.url), /musicu\.fcg/)
  assert.strictEqual(request.options.headers.Cookie, 'uin=o123; qqmusic_key=secret')
  const body = JSON.parse(request.options.body)
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

  const noCookie = createQQMusicSongService({ fetchImpl, getCookie: () => '' })
  return assert.rejects(noCookie.getGuessLikeSongs(), QQMusicAuthError)
}).then(() => {
  console.log('QQ Music song tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
