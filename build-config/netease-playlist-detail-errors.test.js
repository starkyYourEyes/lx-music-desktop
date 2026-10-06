const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const loadMainDetail = response => {
  global.lx = { accountRepository: {}, musicUrlAuthorization: {} }
  return loadTsModule(path.join(root, 'src/main/modules/netease.ts'), {
    './netease/api': { createNeteaseApiClient: () => ({ playlist_detail: response }) },
    '@common/performance/featurePolicy': {},
    '@main/services/optionalResources': {},
    '@common/utils/common': {},
    '@common/utils/neteaseDailySongCategory': { parseDailySongCategoryPlaylistId: () => null },
    './netease/account': { createNeteaseAccountService: () => ({ getCookie: () => 'test-cookie' }) },
    './neteasePlaylist': {},
    './netease/userPlaylists': {},
  }).getRecommendPlaylistDetail
}

for (const field of ['message', 'msg']) {
  test(`main playlist detail normalizes a rejected body.${field} without exposing the response cookie`, async() => {
    const message = 'The playlist creator has made this playlist private'
    const response = { status: 401, body: { code: 401, [field]: message }, cookie: ['sensitive-cookie'] }
    const getDetail = loadMainDetail(async() => { throw response })
    await assert.rejects(getDetail('6766661664'), error => {
      assert.ok(error instanceof Error)
      assert.equal(error.message, message)
      assert.equal(error.cookie, undefined)
      assert.doesNotMatch(String(error), /sensitive-cookie|\[object Object\]/)
      return true
    })
  })
}

const loadRendererDetail = (primary, fallback) => loadTsModule(path.join(root, 'src/renderer/store/songList/action.ts'), {
  '@renderer/utils': { deduplicationList: list => list, toNewMusicInfo: value => value },
  '@renderer/utils/musicSdk': { __esModule: true, default: { wy: { songList: { getListDetail: fallback } } } },
  '@renderer/utils/ipc': { getNeteasePlaylistDetail: primary },
  '@renderer/store/qqMusic': { getQQMusicAccountKey: () => null },
  '@renderer/store/dailyRecommend/action': {},
  '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
  '@renderer/store/qqDailyRecommend/action': {},
  '@renderer/store/qqDailyRecommend/state': { QQ_DAILY_RECOMMEND_LIST_ID: 'qq-daily', qqDailyRecommendGeneration: { value: 0 } },
  '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value },
  './state': {},
}).getListDetail

test('a failed source fallback preserves the original playlist access error', async() => {
  const primaryError = new Error('The playlist creator has made this playlist private')
  let fallbackCalls = 0
  const getDetail = loadRendererDetail(
    async() => { throw primaryError },
    async() => { fallbackCalls++; throw new Error('try max num') },
  )
  await assert.rejects(getDetail('6766661664', 'wy', 1), error => error === primaryError)
  assert.equal(fallbackCalls, 1)
})

test('a successful source fallback still supplies the playlist songs', async() => {
  const fallbackDetail = { id: '42', source: 'wy', list: [{ id: 'song' }], info: {}, total: 1, limit: 1000 }
  const getDetail = loadRendererDetail(
    async() => { throw new Error('primary unavailable') },
    async() => fallbackDetail,
  )
  assert.deepEqual((await getDetail('42', 'wy', 1)).list, [{ id: 'song' }])
})
