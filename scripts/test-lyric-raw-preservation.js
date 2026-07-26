const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const appSetting = { 'player.isS2t': true }
const identity = value => value
const { buildLyricInfo } = loadTsModule(
  path.join(__dirname, '../src/renderer/core/music/utils.ts'),
  {
    '@renderer/store': { qualityList: { value: {} } },
    '@renderer/store/utils': { assertApiSupport: () => true },
    '@renderer/utils/musicSdk': { __esModule: true, default: {} },
    '@renderer/utils/ipc': { getMusicUrl: async() => null, getPlayerLyric: async() => null },
    '@renderer/store/setting': { appSetting },
    '@renderer/utils': {
      langS2T: async value => `T:${value}`,
      toNewMusicInfo: identity,
      toOldMusicInfo: identity,
    },
    '@renderer/utils/message': { requestMsg: { tooManyRequests: 'too many requests' } },
    '@renderer/utils/musicSdk/api-source': { apis: () => ({}) },
  },
)

const run = async() => {
  const result = await buildLyricInfo({
    lyric: 'edited lyric',
    tlyric: 'edited translation',
    rlyric: 'edited romanization',
    lxlyric: 'edited extended lyric',
    rawlrcInfo: {
      lyric: 'original lyric',
      tlyric: 'original translation',
      rlyric: 'original romanization',
      lxlyric: 'original extended lyric',
    },
  })

  assert.strictEqual(result.lyric, 'T:edited lyric')
  assert.deepStrictEqual(result.rawlrcInfo, {
    lyric: 'T:original lyric',
    tlyric: 'T:original translation',
    rlyric: 'T:original romanization',
    lxlyric: 'T:original extended lyric',
  })

  const partialRawResult = await buildLyricInfo({
    lyric: 'edited lyric',
    tlyric: 'edited translation',
    rlyric: '',
    lxlyric: '',
    rawlrcInfo: {
      lyric: '',
      tlyric: 'original translation',
      rlyric: '',
      lxlyric: '',
    },
  })
  assert.deepStrictEqual(partialRawResult.rawlrcInfo, {
    lyric: '',
    tlyric: 'T:original translation',
    rlyric: '',
    lxlyric: '',
  })
}

run().then(() => {
  console.log('lyric raw preservation tests passed')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
