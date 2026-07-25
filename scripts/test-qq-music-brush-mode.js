const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')
const statePath = path.join(root, 'src/renderer/store/qqBrushMode/state.ts')
const actionPath = path.join(root, 'src/renderer/store/qqBrushMode/action.ts')
const QQ_BRUSH_MODE_TEMP_LIST_ID = 'tx__qq_brush_mode'
const LIST_IDS = { TEMP: 'temp' }

const ref = value => ({ value })
const shallowReactive = value => value
const markRawList = value => value
const toRaw = value => value
const song = id => ({ id, name: id, singer: 'Singer', source: 'tx', interval: null, meta: {} })

const loadHarness = () => {
  const state = loadTsModule(statePath, {
    '@common/utils/vueTools': { ref, shallowReactive },
  })
  const responses = []
  const requests = []
  const setTempListCalls = []
  const playListCalls = []
  const playInfo = { playerListId: null }
  const playMusicInfo = { musicInfo: null }
  const tempListMeta = { id: '' }
  let clearPlayedListCalls = 0

  const action = loadTsModule(actionPath, {
    '@common/constants': { LIST_IDS },
    '@common/utils/vueTools': { markRawList, toRaw },
    '@renderer/core/player': {
      playList: (listId, index) => {
        playInfo.playerListId = listId
        playListCalls.push({ listId, index })
      },
    },
    '@renderer/store/list/action': {
      setTempList: async(id, list) => {
        tempListMeta.id = id
        setTempListCalls.push({ id, list })
      },
    },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/player/action': {
      clearPlayedList: () => { clearPlayedListCalls++ },
    },
    '@renderer/store/player/state': { playInfo, playMusicInfo },
    '@renderer/utils/ipc': {
      getQQMusicBrushSongs: continuation => {
        requests.push(continuation)
        assert(responses.length, `missing brush response for continuation=${continuation}`)
        const response = responses.shift()
        return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
      },
    },
    '@renderer/views/Recommend/constants': { QQ_BRUSH_MODE_TEMP_LIST_ID },
    './state': state,
  })

  return {
    action,
    state,
    responses,
    requests,
    setTempListCalls,
    playListCalls,
    playInfo,
    playMusicInfo,
    tempListMeta,
    get clearPlayedListCalls() { return clearPlayedListCalls },
  }
}

const testIndependentQueueAndContinuation = async() => {
  const harness = loadHarness()
  harness.responses.push(['a', 'b', 'c', 'd', 'e'].map(song))

  await harness.action.prepareQQBrushModeQueue('account-a')
  assert.deepStrictEqual(harness.requests, [false])
  assert.deepStrictEqual(harness.state.qqBrushModeQueue.map(item => item.id), ['a', 'b', 'c', 'd', 'e'])

  await harness.action.enterQQBrushMode('account-a')
  assert.strictEqual(harness.state.isQQBrushMode.value, true)
  assert.strictEqual(harness.state.qqBrushModeOwnerAccountKey.value, 'account-a')
  assert.strictEqual(harness.setTempListCalls.at(-1).id, QQ_BRUSH_MODE_TEMP_LIST_ID)
  assert.deepStrictEqual(harness.playListCalls.at(-1), { listId: 'temp', index: 0 })
  assert.strictEqual(harness.clearPlayedListCalls, 1)

  harness.playMusicInfo.musicInfo = song('c')
  harness.responses.push([song('b'), song('f'), song('g')])
  const appended = await harness.action.ensureQQBrushModeNextSongs('account-a')
  assert.deepStrictEqual(harness.requests, [false, true])
  assert.deepStrictEqual(appended.map(item => item.id), ['f', 'g'])
  assert.deepStrictEqual(
    harness.state.qqBrushModeQueue.map(item => item.id),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  )
  assert.strictEqual(harness.setTempListCalls.at(-1).id, QQ_BRUSH_MODE_TEMP_LIST_ID)
}

const testWiringAndIsolation = () => {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
  const action = read('src/renderer/store/qqBrushMode/action.ts')
  const page = read('src/renderer/views/QQRecommend/index.vue')
  const player = read('src/renderer/core/useApp/usePlayer/usePlayer.ts')
  const constants = read('src/renderer/views/Recommend/constants.ts')
  const types = read('src/renderer/views/Recommend/types.ts')

  assert.doesNotMatch(action, /store\/qqGuessLike|\.\.\/qqGuessLike/)
  assert.match(constants, /QQ_BRUSH_MODE_CARD_ID\s*=\s*'qq_brush_mode'/)
  assert.match(constants, /QQ_BRUSH_MODE_TEMP_LIST_ID\s*=\s*'tx__qq_brush_mode'/)
  assert.match(types, /isQQBrushMode\?: boolean/)
  assert.match(page, /guessLikeCard\.value,[\s\S]*dailyRecommendCard\.value,[\s\S]*brushModeCard\.value/)
  assert.match(page, /useQQBrushModePlayback/)
  assert.match(player, /ensureQQBrushModeNextSongs/)
  assert.match(player, /syncQQBrushModeWithPlayer/)
}

const main = async() => {
  assert(fs.existsSync(statePath), 'QQ Brush Mode state module should exist')
  assert(fs.existsSync(actionPath), 'QQ Brush Mode action module should exist')
  await testIndependentQueueAndContinuation()
  testWiringAndIsolation()
  console.log('QQ Music Brush Mode tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
