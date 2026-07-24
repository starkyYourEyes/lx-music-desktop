const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const ref = value => ({ value })
const computed = getter => ({ get value() { return getter() } })

const deferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

const flushAsyncWork = () => new Promise(resolve => setImmediate(resolve))
const song = id => ({ id, name: id, singer: 'Singer', source: 'tx', interval: null, meta: {} })
const root = path.resolve(__dirname, '..')

const testLatestLoadCoordinator = async() => {
  const { createLatestLoadCoordinator } = loadTsModule(
    path.join(root, 'src/renderer/views/Recommend/accountLoadCoordinator.ts'),
  )

  const firstLoad = deferred()
  const latestLoad = deferred()
  const calls = []
  let currentAccount = 'A'
  const coordinator = createLatestLoadCoordinator(async force => {
    calls.push([currentAccount, force])
    await (calls.length == 1 ? firstLoad.promise : latestLoad.promise)
  })

  const requestA = coordinator.request()
  await Promise.resolve()
  assert.deepStrictEqual(calls, [['A', false]])

  currentAccount = 'B'
  const requestB = coordinator.request(true)
  currentAccount = 'C'
  const requestC = coordinator.request(false)
  firstLoad.resolve()
  await requestA
  await requestB
  await Promise.resolve()
  assert.deepStrictEqual(calls, [['A', false], ['C', true]])
  latestLoad.resolve()
  await requestC

  const invalidatedLoad = deferred()
  const invalidationCalls = []
  const invalidationCoordinator = createLatestLoadCoordinator(async force => {
    invalidationCalls.push(force)
    if (invalidationCalls.length == 1) await invalidatedLoad.promise
  })
  const runningRequest = invalidationCoordinator.request()
  await Promise.resolve()
  const invalidatedRequest = invalidationCoordinator.request(true)
  invalidationCoordinator.invalidate()
  invalidatedLoad.resolve()
  await runningRequest
  await invalidatedRequest
  assert.deepStrictEqual(invalidationCalls, [false])
  await invalidationCoordinator.request(false)
  assert.deepStrictEqual(invalidationCalls, [false, false])

  const recoveryCalls = []
  const recoveryCoordinator = createLatestLoadCoordinator(async force => {
    recoveryCalls.push(force)
    if (recoveryCalls.length == 1) throw new Error('load failed')
  })
  await assert.rejects(recoveryCoordinator.request(true), /load failed/)
  await recoveryCoordinator.request(false)
  assert.deepStrictEqual(recoveryCalls, [true, false])
}

const createQQGuessLikePlaybackHarness = ({ accountKey = 'A', loadSongs }) => {
  const isPlay = ref(false)
  const enterCalls = []
  let currentAccountKey = accountKey
  let accountRevision = 0
  let activeAccountKey = null
  let loginRequiredCalls = 0
  let pauseCalls = 0
  let playCalls = 0

  const { useQQGuessLikePlayback } = loadTsModule(
    path.join(root, 'src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts'),
    {
      '@renderer/core/player': {
        pause: () => { pauseCalls++ },
        play: () => { playCalls++ },
      },
      '@renderer/store/qqGuessLike/action': {
        enterQQGuessLikeMode: async key => {
          enterCalls.push(key)
          activeAccountKey = key
        },
        isQQGuessLikeListActive: key => activeAccountKey != null && activeAccountKey == key,
      },
      '@renderer/store/player/state': { isPlay },
    },
  )

  const playback = useQQGuessLikePlayback({
    loadSongs,
    getAccountKey: () => currentAccountKey,
    getAccountRevision: () => accountRevision,
    onLoginRequired: () => { loginRequiredCalls++ },
  })

  return {
    playback,
    isPlay,
    enterCalls,
    getAccountKey: () => currentAccountKey,
    setAccountKey: value => {
      if (currentAccountKey != value) accountRevision++
      currentAccountKey = value
    },
    setActiveAccountKey: value => { activeAccountKey = value },
    get loginRequiredCalls() { return loginRequiredCalls },
    get pauseCalls() { return pauseCalls },
    get playCalls() { return playCalls },
  }
}

const toggleQQGuessLike = playback => playback.handleCardAction({ id: 'qq_guess_like' })

const testQQGuessLikePlaybackRequiresLogin = async() => {
  let loadCalls = 0
  const harness = createQQGuessLikePlaybackHarness({
    accountKey: null,
    loadSongs: async() => {
      loadCalls++
      return [song('unexpected')]
    },
  })

  await toggleQQGuessLike(harness.playback)

  assert.strictEqual(harness.loginRequiredCalls, 1)
  assert.strictEqual(loadCalls, 0)
  assert.deepStrictEqual(harness.enterCalls, [])
}

const testQQGuessLikePlaybackPausesAndResumesActiveList = async() => {
  const harness = createQQGuessLikePlaybackHarness({
    loadSongs: async() => { throw new Error('active playback must not reload') },
  })
  harness.setActiveAccountKey('A')
  harness.isPlay.value = true

  await toggleQQGuessLike(harness.playback)
  assert.strictEqual(harness.pauseCalls, 1)
  assert.strictEqual(harness.playCalls, 0)

  harness.isPlay.value = false
  await toggleQQGuessLike(harness.playback)
  assert.strictEqual(harness.pauseCalls, 1)
  assert.strictEqual(harness.playCalls, 1)
}

const testQQGuessLikePlaybackActivatesOncePerPendingAccount = async() => {
  const pending = deferred()
  let loadCalls = 0
  const harness = createQQGuessLikePlaybackHarness({
    loadSongs: async() => {
      loadCalls++
      return pending.promise
    },
  })

  const first = toggleQQGuessLike(harness.playback)
  const second = toggleQQGuessLike(harness.playback)
  await Promise.resolve()
  assert.strictEqual(loadCalls, 1)

  pending.resolve([song('ready')])
  await Promise.all([first, second])

  assert.deepStrictEqual(harness.enterCalls, ['A'])
}

const testQQGuessLikePlaybackRetriesRejectedAndEmptyLoads = async() => {
  let loadCalls = 0
  const harness = createQQGuessLikePlaybackHarness({
    loadSongs: async() => {
      loadCalls++
      if (loadCalls == 1) throw new Error('temporary load failure')
      if (loadCalls == 2) return []
      return [song('recovered')]
    },
  })

  await assert.rejects(toggleQQGuessLike(harness.playback), /temporary load failure/)
  await toggleQQGuessLike(harness.playback)
  await toggleQQGuessLike(harness.playback)

  assert.strictEqual(loadCalls, 3)
  assert.deepStrictEqual(harness.enterCalls, ['A'])
}

const testQQGuessLikePlaybackScopesPendingActivationToAccount = async() => {
  const accountA = deferred()
  const accountB = deferred()
  const loadAccounts = []
  let harness
  harness = createQQGuessLikePlaybackHarness({
    loadSongs: async() => {
      const accountKey = harness.getAccountKey()
      loadAccounts.push(accountKey)
      return accountKey == 'A' ? accountA.promise : accountB.promise
    },
  })

  const activationA = toggleQQGuessLike(harness.playback)
  await Promise.resolve()
  harness.setAccountKey('B')
  const activationB = toggleQQGuessLike(harness.playback)
  await Promise.resolve()

  assert.deepStrictEqual(loadAccounts, ['A', 'B'],
    'account B should start without waiting for account A activation')

  accountB.resolve([song('account-b')])
  await activationB
  accountA.resolve([song('stale-account-a')])
  await activationA

  assert.deepStrictEqual(harness.enterCalls, ['B'],
    'the stale account A activation must not replace account B playback')
}

const testQQGuessLikePlaybackInvalidatesPendingAccountRoundTrip = async() => {
  const oldAccountA = deferred()
  const newAccountA = deferred()
  let loadCalls = 0
  const harness = createQQGuessLikePlaybackHarness({
    loadSongs: async() => ++loadCalls == 1 ? oldAccountA.promise : newAccountA.promise,
  })

  const oldActivation = toggleQQGuessLike(harness.playback)
  await Promise.resolve()
  harness.setAccountKey('B')
  harness.setAccountKey('A')
  const newActivation = toggleQQGuessLike(harness.playback)
  await Promise.resolve()
  assert.strictEqual(loadCalls, 2)

  oldAccountA.resolve([song('stale-account-a')])
  await oldActivation
  assert.deepStrictEqual(harness.enterCalls, [],
    'an activation from an earlier account revision must not survive A-B-A')

  newAccountA.resolve([song('current-account-a')])
  await newActivation
  assert.deepStrictEqual(harness.enterCalls, ['A'])
}

const testQQGuessLikeDataRetriesCurrentAccount = async() => {
  const queue = []
  const isLoading = ref(false)
  const responses = [new Error('temporary queue failure'), [song('fresh')]]
  const prepareCalls = []
  const accountRefreshes = []
  const accountKey = 'account-a'

  const { useQQGuessLikeData } = loadTsModule(
    path.join(root, 'src/renderer/views/Recommend/useQQGuessLikeData.ts'),
    {
      '@common/utils/vueTools': { computed, ref },
      '@renderer/store/qqGuessLike/action': {
        prepareQQGuessLikeQueue: async(key, force) => {
          prepareCalls.push([key, force])
          const response = responses.shift()
          if (response instanceof Error) throw response
          queue.splice(0, queue.length, ...response)
          return response
        },
      },
      '@renderer/store/qqGuessLike/state': {
        isLoadingQQGuessLike: isLoading,
        qqGuessLikeQueue: queue,
      },
      '@renderer/store/qqMusic': {
        getQQMusicAccountKey: () => accountKey,
        initQQMusicAccount: async force => { accountRefreshes.push(force) },
      },
    },
  )
  const data = useQQGuessLikeData()

  assert.deepStrictEqual(await data.load(), [])
  assert.notStrictEqual(data.loadError.value, '')
  assert.deepStrictEqual(accountRefreshes, [true])

  assert.deepStrictEqual(await data.load(true), [song('fresh')])
  assert.strictEqual(data.loadError.value, '')
  assert.deepStrictEqual(data.songs.value, [song('fresh')])
  assert.deepStrictEqual(prepareCalls, [['account-a', false], ['account-a', true]])
}

const createEndedPlaybackHarness = continuation => {
  const appEventHandlers = new Map()
  const playNextCalls = []
  const playMusicInfo = {
    musicInfo: song('ended'),
    listId: 'list-a',
    isTempPlay: false,
  }
  const playInfo = {
    playIndex: 2,
    playerListId: 'list-a',
    playerPlayIndex: 2,
  }
  const tempListMeta = { id: '' }
  const previousWindow = global.window
  const noop = () => {}
  const hotkey = action => ({ action })

  global.window = {
    lx: { isPlayedStop: false },
    key_event: { on: noop, off: noop },
    app_event: {
      on: (name, handler) => { appEventHandlers.set(name, handler) },
      off: noop,
      setProgress: noop,
    },
  }

  const usePlayer = loadTsModule(path.join(root, 'src/renderer/core/useApp/usePlayer/usePlayer.ts'), {
    '@common/utils/vueTools': { onBeforeUnmount: noop, watch: noop },
    '@renderer/plugins/i18n': { useI18n: () => value => value },
    '@renderer/utils': { setTitle: noop },
    '@renderer/plugins/player': {
      getCurrentTime: () => 0,
      getDuration: () => 0,
      setPause: noop,
      setStop: noop,
    },
    './useMediaSessionInfo': noop,
    './usePlayProgress': noop,
    './usePlayEvent': noop,
    './useLyric': noop,
    './useVolume': noop,
    './useWatchList': noop,
    './usePlaybackRate': noop,
    './useSoundEffect': noop,
    './useMaxOutputChannelCount': noop,
    './usePreloadNextMusic': noop,
    '@renderer/store/player/state': {
      musicInfo: { id: 'ended', name: 'ended', singer: 'Singer' },
      playMusicInfo,
      playInfo,
      playedList: [],
    },
    '@renderer/store/player/action': {
      setPlay: noop,
      setAllStatus: noop,
      addPlayedList: noop,
      clearPlayedList: noop,
    },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/recentPlay/action': { addRecentPlayMusic: noop, initRecentPlayList: noop },
    '@renderer/store/listeningTime/action': { initListeningTimeStats: noop, saveListeningTimeStatsNow: noop },
    '@renderer/store/setting': { appSetting: { 'player.togglePlayMethod': 'listLoop' } },
    '@common/hotKey': {
      HOTKEY_PLAYER: {
        next: hotkey('next'),
        prev: hotkey('prev'),
        toggle_play: hotkey('toggle_play'),
        music_love: hotkey('music_love'),
        music_unlove: hotkey('music_unlove'),
        music_dislike: hotkey('music_dislike'),
        seekbackward: hotkey('seekbackward'),
        seekforward: hotkey('seekforward'),
      },
    },
    '@renderer/core/player': {
      playNext: async force => { playNextCalls.push(force) },
      pause: noop,
      playPrev: noop,
      togglePlay: noop,
      collectMusic: noop,
      uncollectMusic: noop,
      dislikeMusic: noop,
    },
    '@renderer/core/player/utils': { setPowerSaveBlocker: noop },
    '@renderer/store/privateFm/action': {
      ensurePrivateFmNextSongs: async() => {},
      syncPrivateFmModeWithPlayer: noop,
    },
    '@renderer/store/qqGuessLike/action': {
      ensureQQGuessLikeNextSongs: async() => continuation.promise,
      syncQQGuessLikeModeWithPlayer: noop,
    },
    '@renderer/store/qqMusic': {
      getQQMusicAccountKey: () => 'account-a',
      initQQMusicAccount: async() => {},
    },
  }).default
  usePlayer()

  return {
    ended: appEventHandlers.get('playerEnded'),
    playMusicInfo,
    playInfo,
    tempListMeta,
    playNextCalls,
    restore: () => {
      if (previousWindow === undefined) delete global.window
      else global.window = previousWindow
    },
  }
}

const testEndedContinuationDoesNotAdvanceChangedPlayback = async() => {
  const continuation = deferred()
  const harness = createEndedPlaybackHarness(continuation)
  try {
    harness.ended()
    await Promise.resolve()
    harness.playMusicInfo.musicInfo = song('manually-selected')
    harness.playMusicInfo.listId = 'list-b'
    harness.playInfo.playIndex = 0
    harness.playInfo.playerListId = 'list-b'
    harness.playInfo.playerPlayIndex = 0
    harness.tempListMeta.id = 'other-temp-owner'

    continuation.resolve([])
    await flushAsyncWork()

    assert.deepStrictEqual(harness.playNextCalls, [],
      'an ended callback must not advance playback selected while continuation was pending')
  } finally {
    harness.restore()
  }

  const currentContinuation = deferred()
  const currentHarness = createEndedPlaybackHarness(currentContinuation)
  try {
    currentHarness.ended()
    await Promise.resolve()
    assert.deepStrictEqual(currentHarness.playNextCalls, [])

    currentContinuation.resolve([])
    await flushAsyncWork()
    assert.deepStrictEqual(currentHarness.playNextCalls, [true],
      'unchanged playback should advance only after continuation finishes')
  } finally {
    currentHarness.restore()
  }
}

const testDedicatedQQRecommendationWiring = () => {
  const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
  const aside = read('src/renderer/components/layout/Aside/index.vue')
  const qqPage = read('src/renderer/views/QQRecommend/index.vue')
  const qqData = read('src/renderer/views/Recommend/useQQGuessLikeData.ts')
  const qqPlayback = read('src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts')
  const qqAccount = read('src/renderer/store/qqMusic.ts')

  const qqAction = aside.match(/const\s+handleQQMusicAction[\s\S]*?(?=const\s+handleNeteaseAction)/)?.[0] || ''
  assert.match(qqAction, /route\.path\s*==\s*'\/qq-recommend'/)
  assert.match(qqAction, /path:\s*'\/qq-recommend'/)
  assert.match(qqAction, /login:\s*'qq'/)

  assert.match(qqPage, /useQQGuessLikeData/)
  assert.match(qqPage, /useQQGuessLikePlayback/)
  assert.match(qqPage, /window\.addEventListener\('show-qq-music-login'/)
  assert.match(qqPage, /window\.removeEventListener\('show-qq-music-login'/)
  assert.doesNotMatch(qqPage, /resetPlayback|HomeRecommend|homeRecommend/)

  assert.match(qqData, /prepareQQGuessLikeQueue/)
  assert.match(qqData, /qqGuessLikeQueue/)
  assert.match(qqPlayback, /enterQQGuessLikeMode/)
  assert.match(qqPlayback, /isQQGuessLikeListActive/)
  assert.match(qqPage, /getAccountRevision:\s*\(\)\s*=>\s*accountRevision/)
  assert.match(qqAccount, /resetQQGuessLikeQueue/)
  assert.match(qqAccount, /resetQQDailyRecommend/)
}

const main = async() => {
  await testLatestLoadCoordinator()
  await testQQGuessLikePlaybackRequiresLogin()
  await testQQGuessLikePlaybackPausesAndResumesActiveList()
  await testQQGuessLikePlaybackActivatesOncePerPendingAccount()
  await testQQGuessLikePlaybackRetriesRejectedAndEmptyLoads()
  await testQQGuessLikePlaybackScopesPendingActivationToAccount()
  await testQQGuessLikePlaybackInvalidatesPendingAccountRoundTrip()
  await testQQGuessLikeDataRetriesCurrentAccount()
  await testEndedContinuationDoesNotAdvanceChangedPlayback()
  testDedicatedQQRecommendationWiring()
  console.log('QQ Music account menu and recommendation state tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
