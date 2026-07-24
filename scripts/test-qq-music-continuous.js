const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')
const statePath = path.join(root, 'src/renderer/store/qqGuessLike/state.ts')
const actionPath = path.join(root, 'src/renderer/store/qqGuessLike/action.ts')
const LIST_IDS = { TEMP: 'temp' }
const QQ_GUESS_LIKE_TEMP_LIST_ID = 'tx__qq_guess_like'

const ref = value => ({ value })
const shallowReactive = value => value
const markRawList = value => value
const toRaw = value => value
const song = id => ({
  id,
  name: id,
  singer: 'Singer',
  source: 'tx',
  interval: null,
  meta: {},
})

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const loadHarness = () => {
  const state = loadTsModule(statePath, {
    '@common/utils/vueTools': { ref, shallowReactive },
  })
  const playInfo = { playerListId: null }
  const playMusicInfo = { musicInfo: null }
  const tempListMeta = { id: '' }
  const responses = []
  const requestKinds = []
  const setTempListCalls = []
  const playListCalls = []
  let clearPlayedListCalls = 0

  const getQQMusicGuessLikeSongs = continuation => {
    requestKinds.push(continuation)
    assert(responses.length, `missing QQ response for continuation=${continuation}`)
    const response = responses.shift()
    if (response instanceof Error) return Promise.reject(response)
    if (response && typeof response.then == 'function') return response
    return Promise.resolve(response)
  }

  const setTempList = async(id, list) => {
    tempListMeta.id = id
    setTempListCalls.push({ id, list })
  }

  const action = loadTsModule(actionPath, {
    '@common/constants': { LIST_IDS },
    '@common/utils/vueTools': { markRawList, toRaw },
    '@renderer/core/player': {
      playList: (listId, index) => {
        playInfo.playerListId = listId
        playListCalls.push({ listId, index })
      },
    },
    '@renderer/store/list/action': { setTempList },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/player/action': {
      clearPlayedList: () => { clearPlayedListCalls++ },
    },
    '@renderer/store/player/state': { playInfo, playMusicInfo },
    '@renderer/utils/ipc': { getQQMusicGuessLikeSongs },
    '@renderer/views/Recommend/constants': { QQ_GUESS_LIKE_TEMP_LIST_ID },
    './state': state,
  })

  return {
    action,
    state,
    playInfo,
    playMusicInfo,
    tempListMeta,
    responses,
    requestKinds,
    setTempListCalls,
    playListCalls,
    get clearPlayedListCalls() { return clearPlayedListCalls },
  }
}

const prepareAndEnter = async(harness, ids = ['a', 'b', 'c', 'd', 'e']) => {
  harness.responses.push(ids.map(song))
  await harness.action.prepareQQGuessLikeQueue('account-a')
  await harness.action.enterQQGuessLikeMode('account-a')
}

const testInitialLoadAndEntry = async() => {
  const harness = loadHarness()
  harness.responses.push(['a', 'b', 'c'].map(song))

  await harness.action.prepareQQGuessLikeQueue('account-a')
  assert.deepStrictEqual(harness.requestKinds, [false])
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c'])

  await harness.action.enterQQGuessLikeMode('account-a')
  assert.strictEqual(harness.state.isQQGuessLikeMode.value, true)
  assert.strictEqual(harness.state.qqGuessLikeOwnerAccountKey.value, 'account-a')
  assert.deepStrictEqual(harness.setTempListCalls.at(-1).list.map(item => item.id), ['a', 'b', 'c'])
  assert.deepStrictEqual(harness.playListCalls.at(-1), { listId: 'temp', index: 0 })
  assert.strictEqual(harness.clearPlayedListCalls, 1)
}

const testThresholdSingleFlightAppendAndDeduplicate = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness)

  harness.playMusicInfo.musicInfo = song('a')
  await harness.action.ensureQQGuessLikeNextSongs('account-a')
  assert.deepStrictEqual(harness.requestKinds, [false])

  harness.playMusicInfo.musicInfo = song('c')
  const continuation = deferred()
  harness.responses.push(continuation.promise)
  const first = harness.action.ensureQQGuessLikeNextSongs('account-a')
  const second = harness.action.ensureQQGuessLikeNextSongs('account-a')
  assert.strictEqual(first, second)
  assert.deepStrictEqual(harness.requestKinds, [false, true])

  continuation.resolve([song('b'), song('f'), song('g')])
  await Promise.all([first, second])
  assert.deepStrictEqual(
    harness.state.qqGuessLikeQueue.map(item => item.id),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  )
  assert.deepStrictEqual(
    harness.setTempListCalls.at(-1).list.map(item => item.id),
    ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  )
}

const testAllDuplicateBatchIsNonDestructive = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness, ['a', 'b', 'c'])
  harness.playMusicInfo.musicInfo = song('b')
  harness.responses.push(['a', 'b', 'c'].map(song))
  const syncCount = harness.setTempListCalls.length

  const appended = await harness.action.ensureQQGuessLikeNextSongs('account-a')

  assert.deepStrictEqual(appended, [])
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c'])
  assert.strictEqual(harness.setTempListCalls.length, syncCount)
}

const testFailurePreservesQueueAndAllowsRetry = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness, ['a', 'b', 'c'])
  harness.playMusicInfo.musicInfo = song('b')
  harness.responses.push(new Error('temporary failure'))

  await assert.rejects(
    harness.action.ensureQQGuessLikeNextSongs('account-a'),
    /temporary failure/,
  )
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c'])

  harness.responses.push([song('d')])
  await harness.action.ensureQQGuessLikeNextSongs('account-a')
  assert.deepStrictEqual(harness.requestKinds, [false, true, true])
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c', 'd'])
}

const testForcedReloadDoesNotRaceActiveContinuation = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness, ['a', 'b', 'c'])
  harness.playMusicInfo.musicInfo = song('b')
  const continuation = deferred()
  harness.responses.push(continuation.promise, [song('replacement')])
  const pending = harness.action.ensureQQGuessLikeNextSongs('account-a')

  const forcedSnapshot = await harness.action.prepareQQGuessLikeQueue('account-a', true)

  assert.deepStrictEqual(harness.requestKinds, [false, true])
  assert.deepStrictEqual(forcedSnapshot.map(item => item.id), ['a', 'b', 'c'])
  continuation.resolve([song('d')])
  await pending
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c', 'd'])
}

const testResetRejectsStaleContinuation = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness, ['a', 'b', 'c'])
  harness.playMusicInfo.musicInfo = song('b')
  const continuation = deferred()
  harness.responses.push(continuation.promise)
  const pending = harness.action.ensureQQGuessLikeNextSongs('account-a')

  harness.action.resetQQGuessLikeQueue()
  continuation.resolve([song('stale')])
  await pending

  assert.deepStrictEqual(harness.state.qqGuessLikeQueue, [])
  assert.strictEqual(harness.state.isQQGuessLikeMode.value, false)
}

const testAccountChangeRejectsStaleContinuation = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness, ['a', 'b', 'c'])
  harness.playMusicInfo.musicInfo = song('b')
  const continuation = deferred()
  harness.responses.push(continuation.promise, ['x', 'y', 'z'].map(song))
  const pending = harness.action.ensureQQGuessLikeNextSongs('account-a')

  await harness.action.prepareQQGuessLikeQueue('account-b')
  continuation.resolve([song('stale')])
  await pending

  assert.strictEqual(harness.state.qqGuessLikeOwnerAccountKey.value, 'account-b')
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['x', 'y', 'z'])
}

const testTemporaryListReplacementDisablesModeAndRejectsStaleContinuation = async() => {
  const harness = loadHarness()
  await prepareAndEnter(harness, ['a', 'b', 'c'])
  harness.playMusicInfo.musicInfo = song('b')
  const continuation = deferred()
  harness.responses.push(continuation.promise)
  const pending = harness.action.ensureQQGuessLikeNextSongs('account-a')

  harness.tempListMeta.id = 'another-temp-owner'
  harness.action.syncQQGuessLikeModeWithPlayer('account-a')
  continuation.resolve([song('stale')])
  await pending

  assert.strictEqual(harness.state.isQQGuessLikeMode.value, false)
  assert.deepStrictEqual(harness.state.qqGuessLikeQueue.map(item => item.id), ['a', 'b', 'c'])
}

const testGlobalLifecycleWiring = () => {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
  const qqPage = read('src/renderer/views/QQRecommend/index.vue')
  const qqPlayback = read('src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts')
  const qqData = read('src/renderer/views/Recommend/useQQGuessLikeData.ts')
  const accountStore = read('src/renderer/store/qqMusic.ts')
  const player = read('src/renderer/core/useApp/usePlayer/usePlayer.ts')

  assert.doesNotMatch(qqPage, /resetPlayback/)
  assert.match(qqPlayback, /enterQQGuessLikeMode/)
  assert.match(qqPlayback, /isQQGuessLikeListActive/)
  assert.match(qqData, /prepareQQGuessLikeQueue/)
  assert.match(accountStore, /resetQQGuessLikeQueue/)
  assert.match(player, /syncQQGuessLikeModeWithPlayer/)
  assert.match(player, /ensureQQGuessLikeNextSongs/)
  assert.match(player, /initQQMusicAccount\(true\)/,
    'background QQ failures should refresh renderer account state')

  const endedBody = player.match(/const handleEnded = \(\) => \{([\s\S]*?)\n  \}/)?.[1] ?? ''
  const ensureIndex = endedBody.indexOf('await ensureContinuousNextSongs()')
  const playNextIndex = endedBody.indexOf('playNext(true)')
  assert(ensureIndex >= 0 && playNextIndex > ensureIndex,
    'media-ended continuation must finish before playNext(true)')
}

const tests = [
  testInitialLoadAndEntry,
  testThresholdSingleFlightAppendAndDeduplicate,
  testAllDuplicateBatchIsNonDestructive,
  testFailurePreservesQueueAndAllowsRetry,
  testForcedReloadDoesNotRaceActiveContinuation,
  testResetRejectsStaleContinuation,
  testAccountChangeRejectsStaleContinuation,
  testTemporaryListReplacementDisablesModeAndRejectsStaleContinuation,
  testGlobalLifecycleWiring,
]

const main = async() => {
  assert(fs.existsSync(statePath), 'QQ Guess You Like global state module should exist')
  assert(fs.existsSync(actionPath), 'QQ Guess You Like global action module should exist')
  for (const test of tests) await test()
  console.log('QQ Music continuous recommendation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
