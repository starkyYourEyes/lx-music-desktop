const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const loadTsModule = require('./qq-music-test-loader')

const ref = value => ({ value })
const computed = getter => ({
  get value() {
    return getter()
  },
})
const shallowReactive = value => value
const markRawList = value => value
const toRaw = value => value

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const settle = async() => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const song = id => ({
  id: `tx_${id}`,
  source: 'tx',
  name: id,
  singer: 'Synthetic singer',
  interval: null,
  meta: { picUrl: `${id}.jpg`, id: id.length * 100, songType: 0 },
})

const createDailyStore = (getSongs = async() => [], options = {}) => {
  const playInfo = { playerListId: null }
  const playMusicInfo = { musicInfo: null }
  const tempListMeta = { id: options.initialTempListId ?? null }
  const tempList = [...(options.initialTempList ?? [])]
  let accountKey = options.accountKey ?? 'A'
  let dislikeCalls = 0
  const calls = { setTempList: [], clearPlayedList: 0, playList: [], playNext: 0 }
  const state = loadTsModule(path.join(__dirname, '../src/renderer/store/qqDailyRecommend/state.ts'), {
    '@common/utils/vueTools': { ref, shallowReactive, computed },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/store/player/state': { playInfo },
    '@renderer/store/list/state': { tempListMeta },
  })
  const action = loadTsModule(path.join(__dirname, '../src/renderer/store/qqDailyRecommend/action.ts'), {
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@common/utils/vueTools': { markRawList, toRaw },
    '@renderer/core/player': {
      playList: (...args) => calls.playList.push(args),
      playNext: async() => { calls.playNext++ },
    },
    '@renderer/store/list/action': {
      getListMusicsFromCache: listId => listId == 'temp' ? tempList : [],
      setTempList: async(id, list) => {
        calls.setTempList.push([id, list])
        if (options.setTempList) return options.setTempList(id, list, { tempList, tempListMeta })
        tempListMeta.id = id
        tempList.splice(0, tempList.length, ...list)
      },
    },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/player/action': {
      clearPlayedList: () => { calls.clearPlayedList++ },
    },
    '@renderer/store/player/state': { playInfo, playMusicInfo },
    '@renderer/utils/ipc': {
      getQQMusicDailyRecommendSongs: getSongs,
      dislikeQQMusic: async musicInfo => {
        dislikeCalls++
        if (options.dislikeQQMusic) return options.dislikeQQMusic(musicInfo)
      },
    },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => accountKey },
    './state': state,
  })
  return {
    state,
    action,
    playInfo,
    playMusicInfo,
    tempListMeta,
    tempList,
    calls,
    getDislikeCalls: () => dislikeCalls,
    setAccountKey: value => { accountKey = value },
  }
}

const testStateIdentityAndPlayingListDetection = () => {
  const playInfo = vue.reactive({ playerListId: 'temp' })
  const tempListMeta = { id: 'tx__qq_daily_30' }
  const state = loadTsModule(path.join(__dirname, '../src/renderer/store/qqDailyRecommend/state.ts'), {
    '@common/utils/vueTools': {
      ref: vue.ref,
      shallowReactive: vue.shallowReactive,
      computed: vue.computed,
    },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/store/player/state': { playInfo },
    '@renderer/store/list/state': { tempListMeta },
  })
  const isPlaying = () => typeof state.isQQDailyRecommendPlayingList == 'function'
    ? state.isQQDailyRecommendPlayingList()
    : state.isQQDailyRecommendPlayingList.value
  assert.strictEqual(state.QQ_DAILY_RECOMMEND_LIST_ID, 'qq_daily_30')
  assert.strictEqual(state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID, 'tx__qq_daily_30')
  assert.strictEqual(isPlaying(), true)
  tempListMeta.id = 'another_temp_list'
  assert.strictEqual(isPlaying(), false)
}

const testCurrentAccountCacheAndRequestDedupe = async() => {
  const request = deferred()
  let requestCount = 0
  const { state, action } = createDailyStore(() => {
    requestCount++
    return request.promise
  })

  const first = action.prepareQQDailyRecommend('A')
  const duplicate = action.prepareQQDailyRecommend('A')
  assert.strictEqual(requestCount, 1)
  request.resolve([song('A-1')])
  assert.deepStrictEqual(await first, [song('A-1')])
  assert.deepStrictEqual(await duplicate, [song('A-1')])
  assert.deepStrictEqual(await action.prepareQQDailyRecommend('A'), [song('A-1')])
  assert.strictEqual(requestCount, 1)
  assert.strictEqual(state.qqDailyRecommendOwnerAccountKey.value, 'A')
}

const testAccountSwitchRejectsLateResult = async() => {
  const requestA = deferred()
  const requestB = deferred()
  const requests = [requestA.promise, requestB.promise]
  const { state, action } = createDailyStore(() => requests.shift())

  const staleA = action.prepareQQDailyRecommend('A')
  const currentB = action.prepareQQDailyRecommend('B')
  requestA.resolve([song('A-late')])
  assert.deepStrictEqual(await staleA, [])
  requestB.resolve([song('B-current')])
  assert.deepStrictEqual(await currentB, [song('B-current')])
  assert.deepStrictEqual(state.qqDailyRecommendSongs, [song('B-current')])
  assert.strictEqual(action.isQQDailyRecommendListActive('A'), false)
  assert.strictEqual(action.isQQDailyRecommendListActive('B'), false)
}

const testAccountSwitchDoesNotReactivateOldDailyList = async() => {
  const { state, action, playInfo, tempListMeta } = createDailyStore(async() => [song('current')])
  await action.prepareQQDailyRecommend('A')
  await action.playQQDailyRecommend('A')
  playInfo.playerListId = 'temp'
  tempListMeta.id = state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID
  assert.strictEqual(action.isQQDailyRecommendListActive('A'), true)

  await action.prepareQQDailyRecommend('B')
  await action.prepareQQDailyRecommend('A')
  assert.strictEqual(tempListMeta.id, state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID)
  assert.strictEqual(action.isQQDailyRecommendListActive('A'), false)

  await action.playQQDailyRecommend('A')
  assert.strictEqual(action.isQQDailyRecommendListActive('A'), true)
}

const testAccountSwitchKeepsLoadingOwnedByCurrentRequest = async() => {
  const requestA = deferred()
  const requestB = deferred()
  const requests = [requestA.promise, requestB.promise]
  const { state, action } = createDailyStore(() => requests.shift())

  const staleA = action.prepareQQDailyRecommend('A')
  const currentB = action.prepareQQDailyRecommend('B')
  assert.strictEqual(state.isLoadingQQDailyRecommend.value, true)
  requestA.resolve([song('A-late')])
  assert.deepStrictEqual(await staleA, [])
  assert.strictEqual(state.qqDailyRecommendOwnerAccountKey.value, 'B')
  assert.deepStrictEqual(state.qqDailyRecommendSongs, [])
  assert.strictEqual(state.isLoadingQQDailyRecommend.value, true)

  requestB.resolve([song('B-current')])
  assert.deepStrictEqual(await currentB, [song('B-current')])
  assert.strictEqual(state.isLoadingQQDailyRecommend.value, false)
}

const testForceRefreshLatestResultWins = async() => {
  const first = deferred()
  const second = deferred()
  const requests = [first.promise, second.promise]
  const { state, action } = createDailyStore(() => requests.shift())

  const stale = action.prepareQQDailyRecommend('A', true)
  const current = action.prepareQQDailyRecommend('A', true)
  second.resolve([song('latest')])
  assert.deepStrictEqual(await current, [song('latest')])
  first.resolve([song('stale')])
  assert.deepStrictEqual(await stale, [])
  assert.deepStrictEqual(state.qqDailyRecommendSongs, [song('latest')])
}

const testResetAndFailuresLeaveRequestsRetryable = async() => {
  const pending = deferred()
  let requestCount = 0
  const results = [
    pending.promise,
    Promise.reject(new Error('network unavailable')),
    Promise.resolve([]),
    Promise.resolve([song('retry')]),
  ]
  const { state, action } = createDailyStore(() => {
    requestCount++
    return results.shift()
  })

  const stale = action.prepareQQDailyRecommend('A')
  action.resetQQDailyRecommend()
  pending.resolve([song('stale')])
  assert.deepStrictEqual(await stale, [])
  assert.strictEqual(state.qqDailyRecommendSongs.length, 0)
  assert.strictEqual(state.qqDailyRecommendOwnerAccountKey.value, null)
  assert.strictEqual(state.isLoadingQQDailyRecommend.value, false)

  await assert.rejects(action.prepareQQDailyRecommend('A'), /network unavailable/)
  assert.strictEqual(state.isLoadingQQDailyRecommend.value, false)
  assert.deepStrictEqual(await action.prepareQQDailyRecommend('A'), [])
  assert.deepStrictEqual(await action.prepareQQDailyRecommend('A'), [song('retry')])
  assert.strictEqual(requestCount, 4)
}

const testPlaybackInstallsClonedListAndGuardsStaleAccount = async() => {
  const { state, action, playInfo, tempListMeta, calls } = createDailyStore(async() => [song('one'), song('two')])
  await action.prepareQQDailyRecommend('B')
  await action.playQQDailyRecommend('B', 99)
  assert.strictEqual(calls.setTempList.length, 1)
  assert.strictEqual(calls.setTempList[0][0], 'tx__qq_daily_30')
  assert.deepStrictEqual(calls.setTempList[0][1], [song('one'), song('two')])
  assert.notStrictEqual(calls.setTempList[0][1], state.qqDailyRecommendSongs)
  assert.strictEqual(calls.clearPlayedList, 1)
  assert.deepStrictEqual(calls.playList, [['temp', 1]])

  playInfo.playerListId = 'temp'
  tempListMeta.id = state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID
  assert.strictEqual(action.isQQDailyRecommendListActive('B'), true)
  action.resetQQDailyRecommend()
  assert.strictEqual(action.isQQDailyRecommendListActive('B'), false)

  const installing = deferred()
  const staleStore = createDailyStore(async() => [song('account-b')])
  await staleStore.action.prepareQQDailyRecommend('B')
  const staleAction = loadTsModule(path.join(__dirname, '../src/renderer/store/qqDailyRecommend/action.ts'), {
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@common/utils/vueTools': { markRawList, toRaw },
    '@renderer/core/player': {
      playList: (...args) => staleStore.calls.playList.push(args),
      playNext: async() => { staleStore.calls.playNext++ },
    },
    '@renderer/store/list/action': {
      getListMusicsFromCache: () => staleStore.tempList,
      setTempList: () => installing.promise,
    },
    '@renderer/store/list/state': { tempListMeta: staleStore.tempListMeta },
    '@renderer/store/player/action': { clearPlayedList: () => { staleStore.calls.clearPlayedList++ } },
    '@renderer/store/player/state': {
      playInfo: staleStore.playInfo,
      playMusicInfo: staleStore.playMusicInfo,
    },
    '@renderer/utils/ipc': {
      getQQMusicDailyRecommendSongs: async() => [song('account-a')],
      dislikeQQMusic: async() => {},
    },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => 'B' },
    './state': staleStore.state,
  })
  const pendingPlay = staleAction.playQQDailyRecommend('B')
  await settle()
  void staleAction.prepareQQDailyRecommend('A')
  installing.resolve()
  await pendingPlay
  assert.strictEqual(staleStore.calls.clearPlayedList, 0)
  assert.deepStrictEqual(staleStore.calls.playList, [])
}

const testStalePlaybackRestoresPreviousTempList = async() => {
  const installing = deferred()
  const previousSongs = [song('previous')]
  const store = createDailyStore(
    async() => [song('account-a')],
    {
      initialTempListId: 'other_temp_list',
      initialTempList: previousSongs,
      setTempList: (id, list, { tempList, tempListMeta }) => {
        tempListMeta.id = id
        tempList.splice(0, tempList.length, ...list)
        return installing.promise
      },
    },
  )
  await store.action.prepareQQDailyRecommend('A')
  const pendingPlay = store.action.playQQDailyRecommend('A')
  await settle()
  assert.strictEqual(store.tempListMeta.id, store.state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID)
  assert.deepStrictEqual(store.tempList, [song('account-a')])

  store.action.resetQQDailyRecommend()
  installing.resolve()
  await pendingPlay
  assert.strictEqual(store.tempListMeta.id, 'other_temp_list')
  assert.deepStrictEqual(store.tempList, previousSongs)
  assert.strictEqual(store.calls.clearPlayedList, 0)
  assert.deepStrictEqual(store.calls.playList, [])
}

const testStalePlaybackDoesNotClobberNewerTempList = async() => {
  const installing = deferred()
  const store = createDailyStore(
    async() => [song('account-a')],
    {
      initialTempListId: 'old_temp_list',
      initialTempList: [song('old')],
      setTempList: (id, list, { tempList, tempListMeta }) => {
        tempListMeta.id = id
        tempList.splice(0, tempList.length, ...list)
        return installing.promise
      },
    },
  )
  await store.action.prepareQQDailyRecommend('A')
  const pendingPlay = store.action.playQQDailyRecommend('A')
  await settle()
  store.action.resetQQDailyRecommend()
  store.tempListMeta.id = 'newer_temp_list'
  store.tempList.splice(0, store.tempList.length, song('newer'))
  installing.resolve()
  await pendingPlay
  assert.strictEqual(store.tempListMeta.id, 'newer_temp_list')
  assert.deepStrictEqual(store.tempList, [song('newer')])
}

const testStaleDailyInstallDoesNotClobberNewerDailyInstall = async() => {
  const installingA = deferred()
  let requestCount = 0
  let installCount = 0
  const store = createDailyStore(
    async() => {
      requestCount++
      return requestCount == 1 ? [song('account-a')] : [song('account-b')]
    },
    {
      setTempList: (id, list, { tempList, tempListMeta }) => {
        tempListMeta.id = id
        tempList.splice(0, tempList.length, ...list)
        installCount++
        return installCount == 1 ? installingA.promise : Promise.resolve()
      },
    },
  )
  await store.action.prepareQQDailyRecommend('A')
  const pendingAPlay = store.action.playQQDailyRecommend('A')
  await settle()

  await store.action.prepareQQDailyRecommend('B')
  await store.action.playQQDailyRecommend('B')
  store.playInfo.playerListId = 'temp'
  assert.deepStrictEqual(store.tempList, [song('account-b')])
  assert.strictEqual(store.action.isQQDailyRecommendListActive('B'), true)

  installingA.resolve()
  await pendingAPlay
  assert.strictEqual(store.tempListMeta.id, store.state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID)
  assert.deepStrictEqual(store.tempList, [song('account-b')])
  assert.strictEqual(store.action.isQQDailyRecommendListActive('B'), true)
}

const testRejectedInstallRestoresPreviousTempListAndRethrows = async() => {
  const installError = new Error('temporary list persistence failed')
  const previousSongs = [song('previous')]
  let installCount = 0
  const store = createDailyStore(
    async() => [song('account-a')],
    {
      initialTempListId: 'previous_temp_list',
      initialTempList: previousSongs,
      setTempList: (id, list, { tempList, tempListMeta }) => {
        tempListMeta.id = id
        tempList.splice(0, tempList.length, ...list)
        installCount++
        return installCount == 1 ? Promise.reject(installError) : Promise.resolve()
      },
    },
  )
  await store.action.prepareQQDailyRecommend('A')
  await assert.rejects(store.action.playQQDailyRecommend('A'), error => error === installError)
  assert.strictEqual(store.tempListMeta.id, 'previous_temp_list')
  assert.deepStrictEqual(store.tempList, previousSongs)
  assert.strictEqual(store.calls.clearPlayedList, 0)
  assert.deepStrictEqual(store.calls.playList, [])
}

const testRejectedStaleInstallDoesNotClobberNewerDailyInstall = async() => {
  const rejectedA = deferred()
  let requestCount = 0
  let installCount = 0
  const store = createDailyStore(
    async() => {
      requestCount++
      return requestCount == 1 ? [song('account-a')] : [song('account-b')]
    },
    {
      setTempList: (id, list, { tempList, tempListMeta }) => {
        tempListMeta.id = id
        tempList.splice(0, tempList.length, ...list)
        installCount++
        return installCount == 1 ? rejectedA.promise : Promise.resolve()
      },
    },
  )
  await store.action.prepareQQDailyRecommend('A')
  const pendingAPlay = store.action.playQQDailyRecommend('A')
  await settle()

  await store.action.prepareQQDailyRecommend('B')
  await store.action.playQQDailyRecommend('B')
  store.playInfo.playerListId = 'temp'
  rejectedA.reject(new Error('A install failed'))
  await assert.rejects(pendingAPlay, /A install failed/)
  assert.deepStrictEqual(store.tempList, [song('account-b')])
  assert.strictEqual(store.action.isQQDailyRecommendListActive('B'), true)
}

const testPlaybackWaitsForCurrentForceRefresh = async() => {
  const refresh = deferred()
  let requestCount = 0
  const { state, action, playInfo, tempListMeta, calls } = createDailyStore(() => {
    requestCount++
    return requestCount == 1 ? Promise.resolve([song('old')]) : refresh.promise
  })
  await action.prepareQQDailyRecommend('A')
  const pendingRefresh = action.prepareQQDailyRecommend('A', true)
  const pendingPlay = action.playQQDailyRecommend('A')
  await settle()
  assert.strictEqual(calls.setTempList.length, 0)
  refresh.resolve([song('new')])
  await Promise.all([pendingRefresh, pendingPlay])
  assert.deepStrictEqual(state.qqDailyRecommendSongs, [song('new')])
  assert.deepStrictEqual(calls.setTempList, [['tx__qq_daily_30', [song('new')]]])
  playInfo.playerListId = 'temp'
  tempListMeta.id = state.QQ_DAILY_RECOMMEND_TEMP_LIST_ID
  assert.strictEqual(action.isQQDailyRecommendListActive('A'), true)
}

const testPlaybackLoadsEmptyQueueBeforeStarting = async() => {
  const request = deferred()
  let requestCount = 0
  const { state, action, calls } = createDailyStore(() => {
    requestCount++
    return request.promise
  })

  const pendingPlay = action.playQQDailyRecommend('A')
  await settle()
  assert.strictEqual(requestCount, 1)
  assert.strictEqual(calls.setTempList.length, 0)
  request.resolve([song('loaded')])
  await pendingPlay
  assert.deepStrictEqual(state.qqDailyRecommendSongs, [song('loaded')])
  assert.deepStrictEqual(calls.setTempList, [['tx__qq_daily_30', [song('loaded')]]])
  assert.strictEqual(calls.clearPlayedList, 1)
  assert.deepStrictEqual(calls.playList, [['temp', 0]])
}

const testEmptyPlaybackErrorIsSanitized = async() => {
  const { action } = createDailyStore(async() => [])
  await assert.rejects(action.playQQDailyRecommend('A'), error => {
    assert.strictEqual(error.message, 'QQ Daily 30 has no songs')
    return true
  })
}

const testAcceptedDailyDislikeRemovesAndAdvances = async() => {
  const store = createDailyStore(async() => [song('one'), song('two'), song('three')])
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A', 1)
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('two')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('two'), 'A')
  assert.ok(snapshot)
  assert.strictEqual(await store.action.dislikeQQDailyRecommendMusic(song('two'), snapshot), true)
  assert.strictEqual(store.getDislikeCalls(), 1)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs.map(item => item.id), ['tx_one', 'tx_three'])
  assert.deepStrictEqual(store.tempList.map(item => item.id), ['tx_one', 'tx_three'])
  assert.deepStrictEqual(store.calls.playList.at(-1), ['temp', 1, { automatic: true, reason: 'dislike', startReason: 'auto' }])
}

const testDuplicateDailyDislikeSharesOneRequest = async() => {
  const pending = deferred()
  const store = createDailyStore(async() => [song('one'), song('two')], {
    dislikeQQMusic: () => pending.promise,
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const first = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  const duplicate = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  assert.strictEqual(first, duplicate)
  assert.strictEqual(store.getDislikeCalls(), 1)
  pending.resolve()
  await first
}

const testRejectedDailyDislikeKeepsQueue = async() => {
  const store = createDailyStore(async() => [song('one'), song('two')], {
    dislikeQQMusic: async() => { throw new Error('synthetic feedback failure') },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const playCalls = store.calls.playList.length
  await assert.rejects(store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot))
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs.map(item => item.id), ['tx_one', 'tx_two'])
  assert.strictEqual(store.calls.playList.length, playCalls)
}

const testStaleDailyDislikeSuccessKeepsCurrentSession = async() => {
  const pending = deferred()
  let loads = 0
  const store = createDailyStore(async() => {
    return loads++ == 0 ? [song('one'), song('two')] : [song('account-b')]
  }, {
    dislikeQQMusic: () => pending.promise,
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const request = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  store.setAccountKey('B')
  await store.action.prepareQQDailyRecommend('B')
  pending.resolve()
  assert.strictEqual(await request, false)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs.map(item => item.id), ['tx_account-b'])
}

const testRejectedDailyDislikeInstallRestoresPreviousTempList = async() => {
  const installError = new Error('synthetic reduced temp install failure')
  let installCount = 0
  const store = createDailyStore(async() => [song('one'), song('two')], {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      return installCount == 2 ? Promise.reject(installError) : Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const playCalls = store.calls.playList.length

  await assert.rejects(
    store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot),
    error => error === installError,
  )

  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [song('one'), song('two')])
  assert.deepStrictEqual(store.tempList, [song('one'), song('two')])
  assert.strictEqual(store.calls.playList.length, playCalls)
  assert.strictEqual(store.calls.playNext, 0)
}

const testPendingDailyDislikeAccountSwitchRestoresPreviousPlayback = async() => {
  const reducedInstall = deferred()
  let installCount = 0
  let loads = 0
  const store = createDailyStore(async() => {
    return loads++ == 0 ? [song('one'), song('two')] : [song('account-b')]
  }, {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      return installCount == 2 ? reducedInstall.promise : Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const request = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  await settle()
  assert.deepStrictEqual(store.tempList, [song('two')])

  store.setAccountKey('B')
  await store.action.prepareQQDailyRecommend('B')
  reducedInstall.resolve()

  assert.strictEqual(await request, false)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [song('account-b')])
  assert.deepStrictEqual(store.tempList, [song('one'), song('two')])
  assert.strictEqual(store.calls.playList.length, 1)
  assert.strictEqual(store.calls.playNext, 0)
}

const testPendingDailyDislikeLogoutRestoresPreviousPlayback = async() => {
  const reducedInstall = deferred()
  let installCount = 0
  const store = createDailyStore(async() => [song('one'), song('two')], {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      return installCount == 2 ? reducedInstall.promise : Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const request = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  await settle()
  assert.deepStrictEqual(store.tempList, [song('two')])

  store.setAccountKey(null)
  store.action.resetQQDailyRecommend()
  reducedInstall.resolve()

  assert.strictEqual(await request, false)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [])
  assert.deepStrictEqual(store.tempList, [song('one'), song('two')])
  assert.strictEqual(store.calls.playList.length, 1)
  assert.strictEqual(store.calls.playNext, 0)
}

const testPendingDailyDislikeTrackChangeDoesNotCommitOrAdvance = async() => {
  const reducedInstall = deferred()
  let installCount = 0
  const store = createDailyStore(async() => [song('one'), song('two')], {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      return installCount == 2 ? reducedInstall.promise : Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const request = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  await settle()

  store.playMusicInfo.musicInfo = song('two')
  reducedInstall.resolve()

  assert.strictEqual(await request, false)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [song('one'), song('two')])
  assert.deepStrictEqual(store.tempList, [song('one'), song('two')])
  assert.strictEqual(store.calls.playList.length, 1)
  assert.strictEqual(store.calls.playNext, 0)
}

const testNewDailyInstallSupersedesPendingDislikeRollback = async() => {
  const reducedInstall = deferred()
  let installCount = 0
  let loads = 0
  const store = createDailyStore(async() => {
    return loads++ == 0 ? [song('one'), song('two')] : [song('account-b')]
  }, {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      return installCount == 2 ? reducedInstall.promise : Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const request = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  await settle()

  store.setAccountKey('B')
  await store.action.prepareQQDailyRecommend('B')
  await store.action.playQQDailyRecommend('B')
  store.playMusicInfo.musicInfo = song('account-b')
  const installCalls = store.calls.setTempList.length
  reducedInstall.resolve()

  assert.strictEqual(await request, false)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [song('account-b')])
  assert.deepStrictEqual(store.tempList, [song('account-b')])
  assert.strictEqual(store.calls.setTempList.length, installCalls)
  assert.strictEqual(store.calls.playList.length, 2)
  assert.strictEqual(store.calls.playNext, 0)
}

const testSameSessionTempInstallSupersedesPendingDislikeCommit = async() => {
  const reducedInstall = deferred()
  let installCount = 0
  const store = createDailyStore(async() => [song('one'), song('two')], {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      return installCount == 2 ? reducedInstall.promise : Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const snapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const request = store.action.dislikeQQDailyRecommendMusic(song('one'), snapshot)
  await settle()
  assert.deepStrictEqual(store.tempList, [song('two')])

  await store.action.syncQQDailyRecommendTempList()
  const clearPlayedListCalls = store.calls.clearPlayedList
  const playListCalls = store.calls.playList.length
  const playNextCalls = store.calls.playNext
  assert.deepStrictEqual(store.tempList, [song('one'), song('two')])
  reducedInstall.resolve()

  assert.strictEqual(await request, false)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [song('one'), song('two')])
  assert.deepStrictEqual(store.tempList, [song('one'), song('two')])
  assert.strictEqual(store.calls.clearPlayedList, clearPlayedListCalls)
  assert.strictEqual(store.calls.playList.length, playListCalls)
  assert.strictEqual(store.calls.playNext, playNextCalls)
}

const testNewTrackRejectedInstallRestoresQueueAfterPendingFeedback = async() => {
  const firstReducedInstall = deferred()
  const secondInstallError = new Error('synthetic second reduced install failure')
  let installCount = 0
  const store = createDailyStore(async() => [song('one'), song('two'), song('three')], {
    setTempList: (id, list, { tempList, tempListMeta }) => {
      tempListMeta.id = id
      tempList.splice(0, tempList.length, ...list)
      installCount++
      const ids = list.map(item => item.id)
      if (installCount == 2) return firstReducedInstall.promise
      if (ids.join() == 'tx_one,tx_three') return Promise.reject(secondInstallError)
      return Promise.resolve()
    },
  })
  await store.action.prepareQQDailyRecommend('A')
  await store.action.playQQDailyRecommend('A')
  store.playInfo.playerListId = 'temp'
  store.playMusicInfo.musicInfo = song('one')
  const firstSnapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('one'), 'A')
  const first = store.action.dislikeQQDailyRecommendMusic(song('one'), firstSnapshot)
  await settle()
  assert.deepStrictEqual(store.tempList.map(item => item.id), ['tx_two', 'tx_three'])

  store.playMusicInfo.musicInfo = song('two')
  const secondSnapshot = store.action.getQQDailyRecommendFeedbackSnapshot(song('two'), 'A')
  const second = store.action.dislikeQQDailyRecommendMusic(song('two'), secondSnapshot)
  await settle()
  firstReducedInstall.resolve()

  assert.strictEqual(await first, false)
  await assert.rejects(second, error => error === secondInstallError)
  assert.strictEqual(store.getDislikeCalls(), 2)
  assert.deepStrictEqual(store.state.qqDailyRecommendSongs, [song('one'), song('two'), song('three')])
  assert.deepStrictEqual(store.tempList, [song('one'), song('two'), song('three')])
  assert.strictEqual(store.calls.playList.length, 1)
  assert.strictEqual(store.calls.playNext, 0)
}

const testDailyPlaylistDetailUsesCachedSongs = async() => {
  const first = { ...song('first'), singer: 'Singer 1' }
  const second = { ...song('second'), singer: 'Singer 2' }
  const { action } = createDailyStore(async() => [first, second])
  await action.prepareQQDailyRecommend('A')
  const detail = await action.getQQDailyRecommendPlaylistDetail()
  assert.strictEqual(detail.id, 'qq_daily_30')
  assert.strictEqual(detail.source, 'tx')
  assert.strictEqual(detail.info.name, '\u6bcf\u65e530\u9996')
  assert.strictEqual(detail.info.img, 'first.jpg')
  assert.strictEqual(detail.info.author, 'Singer 1')
  assert.deepStrictEqual(detail.list, [first, second])
  assert.strictEqual(detail.total, 2)
}

const testSongListLoadsDailyDetailWithoutCallingQQProvider = async() => {
  let providerDetailCalls = 0
  let dailyDetailCalls = 0
  let accountKey = 'A'
  const dailyGeneration = ref(0)
  const createDailyDetail = key => ({
    id: 'qq_daily_30',
    source: 'tx',
    list: [song(`${key}-first`), song(`${key}-second`)],
    total: 2,
    page: 1,
    limit: 2,
    key: null,
    desc: 'personalized',
    info: {
      name: '\u6bcf\u65e530\u9996',
      img: `${key}-first.jpg`,
      desc: `${key}-first`,
      author: '',
      play_count: '',
    },
    noItemLabel: '',
  })
  const listState = {
    tags: {},
    listInfo: {},
    listDetailInfo: {},
    selectListInfo: {},
    isVisibleListDetail: ref(false),
    openSongListInputInfo: {},
  }
  const songListAction = loadTsModule(path.join(__dirname, '../src/renderer/store/songList/action.ts'), {
    '@renderer/utils': {
      deduplicationList: list => list,
      toNewMusicInfo: music => music,
    },
    '@renderer/utils/musicSdk': {
      tx: {
        songList: {
          getListDetail: async() => {
            providerDetailCalls++
            return createDailyDetail(accountKey)
          },
        },
      },
    },
    '@renderer/utils/ipc': { getNeteasePlaylistDetail: async() => createDailyDetail(accountKey) },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => accountKey },
    '@renderer/store/dailyRecommend/action': {
      getDailyRecommendPlaylistDetail: async() => createDailyDetail(accountKey),
      loadDailyRecommendSongs: async() => [],
    },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
    '@renderer/store/qqDailyRecommend/action': {
      getQQDailyRecommendPlaylistDetail: async(force) => {
        dailyDetailCalls++
        if (force) dailyGeneration.value++
        return createDailyDetail(accountKey)
      },
    },
    '@renderer/store/qqDailyRecommend/state': {
      QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30',
      qqDailyRecommendGeneration: dailyGeneration,
    },
    '@common/utils/vueTools': {
      markRaw: value => value,
      markRawList: value => value,
    },
    './state': listState,
  })

  const detail = await songListAction.getListDetail('qq_daily_30', 'tx', 1)
  const cachedDetail = await songListAction.getListDetail('qq_daily_30', 'tx', 1)
  const forceDetail = await songListAction.getListDetail('qq_daily_30', 'tx', 1, true)
  const cachedForceDetail = await songListAction.getListDetail('qq_daily_30', 'tx', 1)
  accountKey = 'B'
  const accountBDetail = await songListAction.getListDetail('qq_daily_30', 'tx', 1)
  const allSongs = await songListAction.getListDetailAll('qq_daily_30', 'tx')
  dailyGeneration.value++
  const resetAccountBDetail = await songListAction.getListDetail('qq_daily_30', 'tx', 1)
  assert.strictEqual(detail.info.name, '\u6bcf\u65e530\u9996')
  assert.deepStrictEqual(cachedDetail.list, createDailyDetail('A').list)
  assert.deepStrictEqual(forceDetail.list, createDailyDetail('A').list)
  assert.deepStrictEqual(cachedForceDetail.list, createDailyDetail('A').list)
  assert.deepStrictEqual(accountBDetail.list, createDailyDetail('B').list)
  assert.deepStrictEqual(allSongs, createDailyDetail('B').list)
  assert.deepStrictEqual(resetAccountBDetail.list, createDailyDetail('B').list)
  assert.strictEqual(providerDetailCalls, 0)
  assert.strictEqual(dailyDetailCalls, 5)
}

const testStaleDailyForceRefreshCannotOverwriteNewerCache = async() => {
  const first = deferred()
  const second = deferred()
  const dailyGeneration = ref(0)
  let dailyDetailCalls = 0
  const detail = name => ({
    id: 'qq_daily_30',
    source: 'tx',
    list: [song(name)],
    total: 1,
    page: 1,
    limit: 1,
    key: null,
    desc: null,
    info: { name, img: '', desc: null, author: '', play_count: '' },
    noItemLabel: '',
  })
  const songListAction = loadTsModule(path.join(__dirname, '../src/renderer/store/songList/action.ts'), {
    '@renderer/utils': { deduplicationList: list => list, toNewMusicInfo: music => music },
    '@renderer/utils/musicSdk': { tx: { songList: { getListDetail: async() => { throw new Error('provider should not load') } } } },
    '@renderer/utils/ipc': { getNeteasePlaylistDetail: async() => { throw new Error('NetEase should not load') } },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => 'A' },
    '@renderer/store/dailyRecommend/action': {
      getDailyRecommendPlaylistDetail: async() => detail('netease'),
      loadDailyRecommendSongs: async() => [],
    },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
    '@renderer/store/qqDailyRecommend/action': {
      getQQDailyRecommendPlaylistDetail: async(force) => {
        assert.strictEqual(force, true)
        dailyDetailCalls++
        dailyGeneration.value++
        return dailyDetailCalls == 1 ? first.promise : second.promise
      },
    },
    '@renderer/store/qqDailyRecommend/state': {
      QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30',
      qqDailyRecommendGeneration: dailyGeneration,
    },
    '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value },
    './state': {
      tags: {}, listInfo: {}, listDetailInfo: {}, selectListInfo: {},
      isVisibleListDetail: ref(false), openSongListInputInfo: {},
    },
  })

  const stale = songListAction.getListDetail('qq_daily_30', 'tx', 1, true)
  const current = songListAction.getListDetail('qq_daily_30', 'tx', 1, true)
  second.resolve(detail('current'))
  assert.deepStrictEqual((await current).list, [song('current')])
  first.resolve(detail('stale'))
  await stale
  const cached = await songListAction.getListDetail('qq_daily_30', 'tx', 1)
  assert.deepStrictEqual(cached.list, [song('current')])
  assert.strictEqual(dailyDetailCalls, 2)
}

const testDailyDetailAccountLifecycleReloadsOnlyDailyDetail = async() => {
  const source = vue.ref('tx')
  const id = vue.ref('qq_daily_30')
  const page = vue.ref(1)
  const refresh = vue.ref(false)
  const accountKey = vue.ref('A')
  const calls = { clear: 0, reload: [] }
  const lifecycle = loadTsModule(path.join(__dirname, '../src/renderer/views/songList/Detail/useQQDailyRecommendAccount.ts'), {
    '@common/utils/vueTools': { watch: vue.watch },
    '@renderer/store/qqDailyRecommend/state': { QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30' },
  })
  lifecycle.useQQDailyRecommendDetailAccount({
    accountKey,
    source,
    id,
    page,
    refresh,
    clear: () => { calls.clear++ },
    reload: (...args) => { calls.reload.push(args) },
  })

  accountKey.value = 'B'
  await vue.nextTick()
  assert.strictEqual(calls.clear, 1)
  assert.deepStrictEqual(calls.reload, [['tx', 'qq_daily_30', 1, false]])

  accountKey.value = null
  await vue.nextTick()
  assert.strictEqual(calls.clear, 2)
  assert.deepStrictEqual(calls.reload[1], ['tx', 'qq_daily_30', 1, false])

  source.value = 'wy'
  id.value = 'ordinary'
  accountKey.value = 'C'
  await vue.nextTick()
  assert.strictEqual(calls.clear, 2)
  assert.strictEqual(calls.reload.length, 2)
}

const testDailyDetailCoverUsesCurrentMetadataInsteadOfRouteArtwork = () => {
  const source = vue.ref('tx')
  const id = vue.ref('qq_daily_30')
  const picUrl = vue.ref('A-route.jpg')
  const detailImg = vue.ref('A-detail.jpg')
  const detailAccount = loadTsModule(path.join(__dirname, '../src/renderer/views/songList/Detail/useQQDailyRecommendAccount.ts'), {
    '@common/utils/vueTools': { computed: vue.computed, watch: vue.watch },
    '@renderer/store/qqDailyRecommend/state': { QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30' },
  })
  const cover = detailAccount.useQQDailyRecommendDetailCover({ source, id, picUrl, detailImg })
  assert.strictEqual(cover.value, 'A-detail.jpg')
  detailImg.value = 'B-detail.jpg'
  assert.strictEqual(cover.value, 'B-detail.jpg')
  detailImg.value = ''
  assert.strictEqual(cover.value, '')
  id.value = 'ordinary-qq-list'
  assert.strictEqual(cover.value, 'A-route.jpg')
  picUrl.value = ''
  detailImg.value = 'ordinary-detail.jpg'
  assert.strictEqual(cover.value, 'ordinary-detail.jpg')
}

const testStaleDailyDetailRejectionDoesNotClearCurrentAccount = async() => {
  const pendingA = deferred()
  const pendingB = deferred()
  let accountKey = 'A'
  const dailyGeneration = ref(0)
  const listDetailInfo = {
    list: [], id: '', source: 'kw', total: 0, limit: 30, page: 1,
    key: null, info: {}, noItemLabel: '',
  }
  const detail = name => ({
    id: 'qq_daily_30', source: 'tx', list: [song(name)], total: 1, page: 1, limit: 1,
    key: null, desc: null,
    info: { name, img: `${name}.jpg`, desc: null, author: '', play_count: '' },
    noItemLabel: '',
  })
  const originalWindow = global.window
  global.window = { i18n: { t: key => key } }
  try {
    const songListAction = loadTsModule(path.join(__dirname, '../src/renderer/store/songList/action.ts'), {
      '@renderer/utils': { deduplicationList: list => list, toNewMusicInfo: music => music },
      '@renderer/utils/musicSdk': { tx: { songList: { getListDetail: async() => { throw new Error('provider should not load') } } } },
      '@renderer/utils/ipc': { getNeteasePlaylistDetail: async() => { throw new Error('NetEase should not load') } },
      '@renderer/store/qqMusic': { getQQMusicAccountKey: () => accountKey },
      '@renderer/store/dailyRecommend/action': {
        getDailyRecommendPlaylistDetail: async() => detail('netease'),
        loadDailyRecommendSongs: async() => [],
      },
      '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
      '@renderer/store/qqDailyRecommend/action': {
        getQQDailyRecommendPlaylistDetail: async() => accountKey == 'A' ? pendingA.promise : pendingB.promise,
      },
      '@renderer/store/qqDailyRecommend/state': {
        QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30',
        qqDailyRecommendGeneration: dailyGeneration,
      },
      '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value },
      './state': {
        tags: {}, listInfo: {}, listDetailInfo, selectListInfo: {},
        isVisibleListDetail: ref(false), openSongListInputInfo: {},
      },
    })

    const staleA = songListAction.getAndSetListDetail('qq_daily_30', 'tx', 1)
    accountKey = 'B'
    const currentB = songListAction.getAndSetListDetail('qq_daily_30', 'tx', 1)
    pendingB.resolve(detail('B-current'))
    await currentB
    pendingA.reject(new Error('A failed late'))
    await assert.rejects(staleA, /A failed late/)
    assert.deepStrictEqual(listDetailInfo.list, [song('B-current')])
    assert.strictEqual(listDetailInfo.info.name, 'B-current')
    assert.strictEqual(listDetailInfo.noItemLabel, '')
  } finally {
    global.window = originalWindow
  }
}

const createDailyPlaybackComposable = ({ accountKey = 'A', loadSongs = async() => [song('one')], isActive = () => false } = {}) => {
  const calls = { pause: 0, play: 0, playDaily: 0, login: 0, routes: [] }
  let currentAccountKey = accountKey
  const isPlay = ref(true)
  const composable = loadTsModule(path.join(__dirname, '../src/renderer/views/QQRecommend/useQQDailyRecommendPlayback.ts'), {
    '@renderer/core/player': {
      pause: () => { calls.pause++ },
      play: () => { calls.play++ },
    },
    '@common/utils/vueRouter': {
      useRoute: () => ({ name: 'qq-recommend' }),
      useRouter: () => ({ push: async route => { calls.routes.push(route) } }),
    },
    '@renderer/store/qqDailyRecommend/action': {
      isQQDailyRecommendListActive: isActive,
      playQQDailyRecommend: async() => { calls.playDaily++ },
    },
    '@renderer/store/qqDailyRecommend/state': { QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30' },
    '@renderer/store/player/state': { isPlay },
  }).useQQDailyRecommendPlayback({
    loadSongs,
    getAccountKey: () => currentAccountKey,
    onLoginRequired: () => { calls.login++ },
  })
  return {
    composable,
    calls,
    setAccountKey: value => { currentAccountKey = value },
    isPlay,
  }
}

const testDailyPlaybackComposableInteractions = async() => {
  const card = { id: 'qq_daily_30', source: 'tx', img: 'cover.jpg' }
  const loggedOut = createDailyPlaybackComposable({ accountKey: null })
  await loggedOut.composable.handleCardPlay(card)
  await loggedOut.composable.handleCardOpen(card)
  assert.strictEqual(loggedOut.calls.login, 2)
  assert.deepStrictEqual(loggedOut.calls.routes, [])
  assert.strictEqual(loggedOut.calls.playDaily, 0)

  const active = createDailyPlaybackComposable({ isActive: () => true })
  await active.composable.handleCardPlay(card)
  assert.strictEqual(active.calls.pause, 1)
  assert.strictEqual(active.calls.playDaily, 0)
  assert.deepStrictEqual(active.calls.routes, [])
  await active.composable.handleCardOpen(card)
  assert.strictEqual(active.calls.routes.length, 1)
  assert.strictEqual(active.calls.routes[0].path, '/songList/detail')
  assert.strictEqual(active.calls.routes[0].query.id, 'qq_daily_30')

  const songs = deferred()
  const pending = createDailyPlaybackComposable({ loadSongs: () => songs.promise })
  const first = pending.composable.handleCardPlay(card)
  const duplicate = pending.composable.handleCardPlay(card)
  pending.setAccountKey('B')
  songs.resolve([song('late-A')])
  await Promise.all([first, duplicate])
  assert.strictEqual(pending.calls.playDaily, 0)
}

const testDetailPlaybackDelegatesToDailyOwnerAndCardPauses = async() => {
  const store = createDailyStore(async() => [song('one'), song('two')])
  let dailyActivations = 0
  let pauseCalls = 0
  let genericDetailLoads = 0
  const detailAction = loadTsModule(path.join(__dirname, '../src/renderer/views/songList/Detail/action.ts'), {
    '@renderer/store/list/state': { tempListMeta: store.tempListMeta, userLists: [] },
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => false } },
    '@renderer/store/list/importSourceList': { importSourceList: async() => {} },
    '@renderer/store/songList/action': {
      getListDetail: async() => { genericDetailLoads++; return { list: [] } },
      getListDetailAll: async() => { genericDetailLoads++; return [] },
    },
    '@renderer/store/list/action': { createUserList: async() => {}, setTempList: async() => {} },
    '@renderer/core/player/action': { playList: () => {} },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@renderer/utils': { toMD5: value => value },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
    '@renderer/store/qqDailyRecommend/state': { QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30' },
    '@renderer/store/qqDailyRecommend/action': {
      playQQDailyRecommend: async(accountKey, index) => {
        dailyActivations++
        await store.action.playQQDailyRecommend(accountKey, index)
      },
    },
    '@renderer/store/qqMusic': { getQQMusicAccountKey: () => 'A' },
  })

  await detailAction.playSongListDetail('qq_daily_30', 'tx', undefined, 1)
  store.playInfo.playerListId = 'temp'
  assert.strictEqual(dailyActivations, 1)
  assert.strictEqual(genericDetailLoads, 0)
  assert.strictEqual(store.action.isQQDailyRecommendListActive('A'), true)

  const cardPlayback = loadTsModule(path.join(__dirname, '../src/renderer/views/QQRecommend/useQQDailyRecommendPlayback.ts'), {
    '@renderer/core/player': { pause: () => { pauseCalls++ }, play: () => {} },
    '@common/utils/vueRouter': {
      useRoute: () => ({ name: 'qq-recommend' }),
      useRouter: () => ({ push: async() => {} }),
    },
    '@renderer/store/qqDailyRecommend/action': {
      isQQDailyRecommendListActive: store.action.isQQDailyRecommendListActive,
      playQQDailyRecommend: store.action.playQQDailyRecommend,
    },
    '@renderer/store/qqDailyRecommend/state': store.state,
    '@renderer/store/player/state': { isPlay: ref(true) },
  }).useQQDailyRecommendPlayback({
    loadSongs: async() => store.state.qqDailyRecommendSongs,
    getAccountKey: () => 'A',
    onLoginRequired: () => {},
  })
  await cardPlayback.handleCardPlay({ id: 'qq_daily_30', source: 'tx', img: '' })
  assert.strictEqual(pauseCalls, 1)
  assert.strictEqual(dailyActivations, 1)
}

const testDailyPageComposablesUseSharedPlaybackAndDetailLoader = () => {
  const dailyCard = fs.readFileSync(path.join(__dirname, '../src/renderer/views/QQRecommend/useQQDailyRecommendCard.ts'), 'utf8')
  const dailyData = fs.readFileSync(path.join(__dirname, '../src/renderer/views/QQRecommend/useQQDailyRecommendData.ts'), 'utf8')
  const dailyPlayback = fs.readFileSync(path.join(__dirname, '../src/renderer/views/QQRecommend/useQQDailyRecommendPlayback.ts'), 'utf8')
  const songListAction = fs.readFileSync(path.join(__dirname, '../src/renderer/store/songList/action.ts'), 'utf8')

  assert.match(dailyCard, /isQQDailyRecommend:\s*true/)
  assert.match(dailyCard, /QQ_DAILY_RECOMMEND_LIST_ID/)
  assert.match(dailyData, /prepareQQDailyRecommend/)
  assert.match(dailyPlayback, /isQQDailyRecommendListActive/)
  assert.match(dailyPlayback, /playQQDailyRecommend/)
  assert.match(dailyPlayback, /path:\s*'\/songList\/detail'/)
  assert.match(songListAction, /source == 'tx' && id == QQ_DAILY_RECOMMEND_LIST_ID/)
  assert.match(songListAction, /getQQDailyRecommendPlaylistDetail\(isRefresh, getQQMusicAccountKey\(\)\)/)
}

const testAccountStoreResetsBothQQRecommendationStates = () => {
  let guessLikeResets = 0
  let brushModeResets = 0
  let dailyResets = 0
  const store = loadTsModule(path.join(__dirname, '../src/renderer/store/qqMusic.ts'), {
    '@common/utils/vueTools': { ref, shallowRef: ref, computed },
    '@renderer/utils/ipc': { getQQMusicAccountStatus: async() => ({ isLoggedIn: false, profile: null }), logoutQQMusic: async() => {} },
    '@renderer/store/qqGuessLike/action': { resetQQGuessLikeQueue: () => { guessLikeResets++ } },
    '@renderer/store/qqBrushMode/action': { resetQQBrushModeQueue: () => { brushModeResets++ } },
    '@renderer/store/qqDailyRecommend/action': { resetQQDailyRecommend: () => { dailyResets++ } },
  })
  const status = uin => ({ isLoggedIn: true, profile: { uin, nickname: uin } })
  store.setQQMusicAccountStatus(status('A'))
  store.setQQMusicAccountStatus(status('A'))
  store.setQQMusicAccountStatus(status('B'))
  assert.strictEqual(guessLikeResets, 2)
  assert.strictEqual(brushModeResets, 2)
  assert.strictEqual(dailyResets, 2)
}

const main = async() => {
  testStateIdentityAndPlayingListDetection()
  await testCurrentAccountCacheAndRequestDedupe()
  await testAccountSwitchRejectsLateResult()
  await testAccountSwitchDoesNotReactivateOldDailyList()
  await testAccountSwitchKeepsLoadingOwnedByCurrentRequest()
  await testForceRefreshLatestResultWins()
  await testResetAndFailuresLeaveRequestsRetryable()
  await testPlaybackInstallsClonedListAndGuardsStaleAccount()
  await testStalePlaybackRestoresPreviousTempList()
  await testStalePlaybackDoesNotClobberNewerTempList()
  await testStaleDailyInstallDoesNotClobberNewerDailyInstall()
  await testRejectedInstallRestoresPreviousTempListAndRethrows()
  await testRejectedStaleInstallDoesNotClobberNewerDailyInstall()
  await testPlaybackWaitsForCurrentForceRefresh()
  await testPlaybackLoadsEmptyQueueBeforeStarting()
  await testEmptyPlaybackErrorIsSanitized()
  await testAcceptedDailyDislikeRemovesAndAdvances()
  await testDuplicateDailyDislikeSharesOneRequest()
  await testRejectedDailyDislikeKeepsQueue()
  await testStaleDailyDislikeSuccessKeepsCurrentSession()
  await testRejectedDailyDislikeInstallRestoresPreviousTempList()
  await testNewDailyInstallSupersedesPendingDislikeRollback()
  await testSameSessionTempInstallSupersedesPendingDislikeCommit()
  await testPendingDailyDislikeLogoutRestoresPreviousPlayback()
  await testPendingDailyDislikeAccountSwitchRestoresPreviousPlayback()
  await testPendingDailyDislikeTrackChangeDoesNotCommitOrAdvance()
  await testNewTrackRejectedInstallRestoresQueueAfterPendingFeedback()
  await testDailyPlaylistDetailUsesCachedSongs()
  await testSongListLoadsDailyDetailWithoutCallingQQProvider()
  await testStaleDailyForceRefreshCannotOverwriteNewerCache()
  await testDailyDetailAccountLifecycleReloadsOnlyDailyDetail()
  testDailyDetailCoverUsesCurrentMetadataInsteadOfRouteArtwork()
  await testStaleDailyDetailRejectionDoesNotClearCurrentAccount()
  await testDailyPlaybackComposableInteractions()
  await testDetailPlaybackDelegatesToDailyOwnerAndCardPauses()
  testDailyPageComposablesUseSharedPlaybackAndDetailLoader()
  testAccountStoreResetsBothQQRecommendationStates()
  console.log('QQ Music Daily 30 renderer tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
