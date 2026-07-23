const assert = require('node:assert')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const babel = require('@babel/core')

const loadTsModule = (filePath, mocks = {}) => {
  const filename = path.resolve(filePath)
  const source = fs.readFileSync(filename, 'utf8')
  const { code } = babel.transformSync(source, {
    babelrc: false,
    configFile: false,
    filename,
    presets: [[require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }]],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  })

  const loadedModule = new Module(filename, module)
  loadedModule.filename = filename
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filename))

  const originalLoad = Module._load
  Module._load = (request, parent, isMain) => {
    if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request]
    return originalLoad(request, parent, isMain)
  }
  try {
    loadedModule._compile(code, filename)
  } finally {
    Module._load = originalLoad
  }
  return loadedModule.exports
}

const ref = value => ({ value })
const computed = getter => ({
  get value() {
    return getter()
  },
})
const deferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}
const settle = async() => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const root = path.resolve(__dirname, '..')
const recommendPath = path.join(root, 'src/renderer/views/Recommend/useRecommendData.ts')
const qrPath = path.join(root, 'src/renderer/views/Recommend/useNeteaseLoginQr.ts')

const playlist = id => ({ id, name: id, source: 'wy' })
const song = id => ({ id, name: id, singer: 'Singer', source: 'wy', interval: null, meta: {} })
const home = id => ({
  radarPlaylists: [playlist(`${id}-radar`)],
  styleSongsTitle: `${id} style`,
  styleSongs: [song(`${id}-style`)],
  dailySongCategoryPlaylists: [playlist(`${id}-daily`)],
  similarSongs: [song(`${id}-similar`)],
  recommendPlaylists: [playlist(`${id}-recommend`)],
  charts: [{ id: `${id}-chart`, name: `${id} chart`, songs: [] }],
})

const recommendConstants = {
  EXPLORE_PLAYLIST_LIMIT: 30,
  HOME_RECOMMEND_PLAYLIST_LIMIT: 12,
  HOME_SONG_LIMIT: 6,
  RECOMMEND_CACHE_TTL: 5 * 60 * 1000,
}

const loadRecommendComposable = ({ accountKey, getPlaylists, getHome }) => {
  const isLoggedIn = computed(() => accountKey.value != null)
  return loadTsModule(recommendPath, {
    '@common/utils/vueTools': {
      computed,
      nextTick: async() => {},
      ref,
      shallowRef: ref,
    },
    '@renderer/utils/ipc': {
      getNeteaseHomeRecommendation: getHome,
      getNeteaseRecommendPlaylists: getPlaylists,
    },
    '@renderer/store/netease': { isLoggedIn },
    '@renderer/store/setting': {
      appSetting: { 'recommend.dailySongCategoryTagKeys': [] },
    },
    '@renderer/store/privateFm/state': { isPrivateFmMode: ref(false) },
    '@renderer/store/privateFm/action': { preparePrivateFmQueue: async() => {} },
    '@renderer/store/dailyRecommend/action': { loadDailyRecommendSongs: async() => {} },
    './constants': recommendConstants,
  }).useRecommendData
}

const createRecommendState = ({
  accountKey,
  getPlaylists,
  getHome,
  isExploreMode = ref(false),
  onHomeSongsUpdated = () => {},
}) => {
  const useRecommendData = loadRecommendComposable({ accountKey, getPlaylists, getHome })
  return useRecommendData({
    accountKey,
    isExploreMode,
    playlistScrollRef: ref(null),
    onHomeSongsUpdated,
  })
}

const testSameAccountCacheHitRetainsPendingBackgroundOwnership = async() => {
  const accountKey = ref('same-account')
  const baseRequest = deferred()
  const chartRequest = deferred()
  const state = createRecommendState({
    accountKey,
    getPlaylists: async() => baseRequest.promise,
    getHome: async({ sections }) => sections.includes('charts')
      ? chartRequest.promise
      : home('same-account'),
  })

  await state.loadRecommendPlaylists(true)
  await state.loadRecommendPlaylists()

  baseRequest.resolve([playlist('same-account-late-base')])
  chartRequest.resolve(home('same-account-late-chart'))
  await settle()

  assert.deepStrictEqual(state.recommendPlaylists.value, [playlist('same-account-late-base')])
  assert.deepStrictEqual(state.homeCharts.value, home('same-account-late-chart').charts)
}

const testCacheHitDuringSameAccountRefreshSettlesLoading = async() => {
  const accountKey = ref('loading-account')
  let refreshRequests = null
  const state = createRecommendState({
    accountKey,
    getPlaylists: async() => refreshRequests?.base.promise ?? [playlist('loading-account-cached-base')],
    getHome: async({ sections }) => {
      if (!refreshRequests) return home('loading-account-cached')
      return sections.includes('charts')
        ? refreshRequests.charts.promise
        : refreshRequests.core.promise
    },
  })
  await state.loadRecommendPlaylists(true)
  await settle()

  refreshRequests = { base: deferred(), core: deferred(), charts: deferred() }
  const refreshing = state.loadRecommendPlaylists(true)
  await state.loadRecommendPlaylists()
  assert.strictEqual(state.isLoadingPlaylists.value, true)

  refreshRequests.base.resolve([playlist('loading-account-refreshed-base')])
  refreshRequests.charts.resolve(home('loading-account-refreshed-chart'))
  refreshRequests.core.resolve(home('loading-account-refreshed'))
  await refreshing
  await settle()

  assert.strictEqual(state.isLoadingPlaylists.value, false)
  assert.deepStrictEqual(state.recommendPlaylists.value, [playlist('loading-account-refreshed-base')])
}

const testHomeExploreHomeTransitionsRetainOnlyCurrentContextResults = async() => {
  const accountKey = ref('mode-account')
  const isExploreMode = ref(false)
  const homeBaseRequest = deferred()
  const homeChartRequest = deferred()
  const exploreBaseRequest = deferred()
  const state = createRecommendState({
    accountKey,
    isExploreMode,
    getPlaylists: async(_limit, isExplore) => isExplore
      ? exploreBaseRequest.promise
      : homeBaseRequest.promise,
    getHome: async({ sections }) => sections.includes('charts')
      ? homeChartRequest.promise
      : home('mode-account-home'),
  })

  await state.loadRecommendPlaylists(true)
  isExploreMode.value = true
  const loadingExplore = state.loadRecommendPlaylists(true)
  isExploreMode.value = false
  await state.loadRecommendPlaylists()

  exploreBaseRequest.resolve([playlist('mode-account-explore')])
  await loadingExplore
  homeBaseRequest.resolve([playlist('mode-account-home')])
  homeChartRequest.resolve(home('mode-account-home-chart'))
  await settle()

  assert.deepStrictEqual(state.recommendPlaylists.value, [playlist('mode-account-home')])
  assert.deepStrictEqual(state.homeCharts.value, home('mode-account-home-chart').charts)
  assert.strictEqual(state.isLoadingPlaylists.value, false)
}

const testLateAccountAResponsesCannotReplaceFailedAccountB = async() => {
  const accountKey = ref('A')
  const requests = {
    A: { base: deferred(), core: deferred(), charts: deferred() },
    B: { base: deferred(), core: deferred(), charts: deferred() },
  }
  let homeSongsUpdated = 0
  const state = createRecommendState({
    accountKey,
    getPlaylists: async() => requests[accountKey.value].base.promise,
    getHome: async({ sections }) => {
      const type = sections.includes('charts') ? 'charts' : 'core'
      return requests[accountKey.value][type].promise
    },
    onHomeSongsUpdated: () => { homeSongsUpdated++ },
  })

  const loadingA = state.loadRecommendPlaylists(true)
  accountKey.value = 'B'
  const loadingB = state.loadRecommendPlaylists(true)

  requests.B.base.reject(new Error('B base failed'))
  requests.B.charts.resolve({ ...home('B'), charts: [] })
  requests.B.core.reject(new Error('B core failed'))
  await loadingB
  await settle()

  requests.A.base.resolve([playlist('A-late-base')])
  requests.A.charts.resolve(home('A-late'))
  requests.A.core.resolve(home('A-late'))
  await loadingA
  await settle()

  assert.deepStrictEqual(state.recommendPlaylists.value, [])
  assert.deepStrictEqual(state.homeStyleSongs.value, [])
  assert.deepStrictEqual(state.homeCharts.value, [])
  assert.ok(['B base failed', 'B core failed'].includes(state.playlistLoadError.value))
  assert.strictEqual(state.isLoadingPlaylists.value, false)
  assert.strictEqual(homeSongsUpdated, 0)
}

const testAccountTransitionClearsVisibleRecommendationsImmediately = async() => {
  const accountKey = ref('A')
  let pendingB
  const state = createRecommendState({
    accountKey,
    getPlaylists: async() => accountKey.value == 'A' ? [playlist('A-base')] : pendingB.base.promise,
    getHome: async({ sections }) => {
      if (accountKey.value == 'A') return home('A')
      return sections.includes('charts') ? pendingB.charts.promise : pendingB.core.promise
    },
  })
  await state.loadRecommendPlaylists(true)
  await settle()
  assert.deepStrictEqual(state.homeStyleSongs.value, [song('A-style')])

  pendingB = { base: deferred(), core: deferred(), charts: deferred() }
  accountKey.value = 'B'
  const loadingB = state.loadRecommendPlaylists(true)

  assert.deepStrictEqual(state.recommendPlaylists.value, [])
  assert.deepStrictEqual(state.homeStyleSongs.value, [])
  assert.deepStrictEqual(state.homeCharts.value, [])

  pendingB.base.reject(new Error('B base failed'))
  pendingB.charts.resolve({ ...home('B'), charts: [] })
  pendingB.core.reject(new Error('B core failed'))
  await loadingB
}

const testRecommendationCachesAreAccountScopedAcrossRemounts = async() => {
  const accountKey = ref('A')
  const baseAccounts = []
  const coreAccounts = []
  const chartAccounts = []
  const getPlaylists = async() => {
    const key = accountKey.value
    baseAccounts.push(key)
    return [playlist(`${key}-base`)]
  }
  const getHome = async({ sections }) => {
    const key = accountKey.value
    if (sections.includes('charts')) chartAccounts.push(key)
    else coreAccounts.push(key)
    return home(key)
  }
  const useRecommendData = loadRecommendComposable({ accountKey, getPlaylists, getHome })
  const mount = () => useRecommendData({
    accountKey,
    isExploreMode: ref(false),
    playlistScrollRef: ref(null),
    onHomeSongsUpdated: () => {},
  })

  const stateA = mount()
  await stateA.loadRecommendPlaylists(true)
  await settle()

  accountKey.value = 'B'
  const stateB = mount()
  await stateB.loadRecommendPlaylists()
  await settle()
  assert.deepStrictEqual(stateB.recommendPlaylists.value, [playlist('B-base')])
  assert.deepStrictEqual(stateB.homeStyleSongs.value, [song('B-style')])
  assert.deepStrictEqual(baseAccounts, ['A', 'B'])
  assert.deepStrictEqual(coreAccounts, ['A', 'B'])
  assert.deepStrictEqual(chartAccounts, ['A', 'B'])

  accountKey.value = 'A'
  const remountedA = mount()
  await remountedA.loadRecommendPlaylists()
  await settle()
  assert.deepStrictEqual(remountedA.recommendPlaylists.value, [playlist('A-base')])
  assert.deepStrictEqual(remountedA.homeStyleSongs.value, [song('A-style')])
  assert.deepStrictEqual(baseAccounts, ['A', 'B'])
  assert.deepStrictEqual(coreAccounts, ['A', 'B'])
  assert.deepStrictEqual(chartAccounts, ['A', 'B'])
}

const createQrHarness = ({ createQr, checkQr }) => {
  const timers = new Map()
  const unmountCallbacks = []
  const statusUpdates = []
  const isLoggedIn = ref(false)
  let nextTimerId = 1
  let loginSuccessCount = 0
  const originalWindow = global.window
  global.window = {
    setTimeout(callback, delay) {
      assert.strictEqual(delay, 2000)
      const id = nextTimerId++
      timers.set(id, callback)
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
  }

  const { useNeteaseLoginQr } = loadTsModule(qrPath, {
    '@common/utils/vueTools': {
      computed,
      onBeforeUnmount: callback => unmountCallbacks.push(callback),
      ref,
      shallowRef: ref,
    },
    '@renderer/utils/ipc': {
      checkNeteaseLoginQr: checkQr,
      createNeteaseLoginQr: createQr,
    },
    '@renderer/store/netease': {
      isLoggedIn,
      setNeteaseAccountStatus: status => statusUpdates.push(status),
    },
    './constants': { LOGIN_QR_PENDING_CODES: new Set([801, 802]) },
  })
  const state = useNeteaseLoginQr(async() => { loginSuccessCount++ })

  return {
    state,
    timers,
    statusUpdates,
    get loginSuccessCount() { return loginSuccessCount },
    fireTimer() {
      const entry = timers.entries().next().value
      assert.ok(entry, 'expected a scheduled QR check')
      timers.delete(entry[0])
      entry[1]()
    },
    unmount() {
      for (const callback of unmountCallbacks) callback()
    },
    restore() {
      global.window = originalWindow
    },
  }
}

const testProviderSwitchCloseInvalidatesInflightQrCreate = async() => {
  const createRequest = deferred()
  const harness = createQrHarness({
    createQr: async() => createRequest.promise,
    checkQr: async() => ({ code: 801, message: 'waiting' }),
  })
  try {
    const creating = harness.state.handleCreateLoginQr()
    harness.state.handleCloseLogin()
    createRequest.resolve({ key: 'closed-create', qrimg: 'data:image/png;base64,closed' })
    await creating

    assert.strictEqual(harness.state.showLoginPanel.value, false)
    assert.strictEqual(harness.state.isCreatingQr.value, false)
    assert.strictEqual(harness.state.qrInfo.value, null)
    assert.strictEqual(harness.timers.size, 0)
  } finally {
    harness.restore()
  }
}

const testProviderSwitchCloseInvalidatesInflightQrCheck = async() => {
  const checkRequest = deferred()
  const harness = createQrHarness({
    createQr: async() => ({ key: 'closed-check', qrimg: 'data:image/png;base64,check' }),
    checkQr: async() => checkRequest.promise,
  })
  try {
    await harness.state.handleCreateLoginQr()
    harness.fireTimer()
    await settle()
    harness.state.handleCloseLogin()
    checkRequest.resolve({
      code: 803,
      message: 'authorized after close',
      isLoggedIn: true,
      profile: { userId: 1, nickname: 'stale' },
    })
    await settle()

    assert.deepStrictEqual(harness.statusUpdates, [])
    assert.strictEqual(harness.loginSuccessCount, 0)
    assert.strictEqual(harness.state.qrStatusText.value, '请使用 WY App 扫码登录')
    assert.strictEqual(harness.timers.size, 0)
  } finally {
    harness.restore()
  }
}

const testUnmountInvalidatesInflightQrCreate = async() => {
  const createRequest = deferred()
  const harness = createQrHarness({
    createQr: async() => createRequest.promise,
    checkQr: async() => ({ code: 801, message: 'waiting' }),
  })
  try {
    const creating = harness.state.handleCreateLoginQr()
    harness.unmount()
    createRequest.resolve({ key: 'unmounted-create', qrimg: 'data:image/png;base64,unmounted' })
    await creating

    assert.strictEqual(harness.state.qrInfo.value, null)
    assert.strictEqual(harness.timers.size, 0)
  } finally {
    harness.restore()
  }
}

const testUnmountInvalidatesInflightQrCheck = async() => {
  const checkRequest = deferred()
  const harness = createQrHarness({
    createQr: async() => ({ key: 'unmounted-check', qrimg: 'data:image/png;base64,check' }),
    checkQr: async() => checkRequest.promise,
  })
  try {
    await harness.state.handleCreateLoginQr()
    harness.fireTimer()
    await settle()
    harness.unmount()
    checkRequest.resolve({
      code: 803,
      message: 'authorized after unmount',
      isLoggedIn: true,
      profile: { userId: 2, nickname: 'stale' },
    })
    await settle()

    assert.deepStrictEqual(harness.statusUpdates, [])
    assert.strictEqual(harness.loginSuccessCount, 0)
    assert.strictEqual(harness.timers.size, 0)
  } finally {
    harness.restore()
  }
}

const groups = {
  recommend: [
    testSameAccountCacheHitRetainsPendingBackgroundOwnership,
    testCacheHitDuringSameAccountRefreshSettlesLoading,
    testHomeExploreHomeTransitionsRetainOnlyCurrentContextResults,
    testLateAccountAResponsesCannotReplaceFailedAccountB,
    testAccountTransitionClearsVisibleRecommendationsImmediately,
    testRecommendationCachesAreAccountScopedAcrossRemounts,
  ],
  qr: [
    testProviderSwitchCloseInvalidatesInflightQrCreate,
    testProviderSwitchCloseInvalidatesInflightQrCheck,
    testUnmountInvalidatesInflightQrCreate,
    testUnmountInvalidatesInflightQrCheck,
  ],
}

const main = async() => {
  const selectedGroup = process.argv[2]
  const tests = selectedGroup ? groups[selectedGroup] : Object.values(groups).flat()
  assert.ok(tests, `unknown test group: ${selectedGroup}`)
  const failures = []
  for (const test of tests) {
    try {
      await test()
    } catch (error) {
      failures.push({ name: test.name, error })
      console.error(`FAIL ${test.name}`)
      console.error(error)
    }
  }
  if (failures.length) throw new Error(`${failures.length} recommendation quality race test(s) failed`)
  console.log('Recommendation account and NetEase QR race tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
