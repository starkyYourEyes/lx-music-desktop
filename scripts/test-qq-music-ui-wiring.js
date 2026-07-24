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

const deferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

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

const testStaticWiring = () => {
  const aside = fs.readFileSync(path.join(root, 'src/renderer/components/layout/Aside/index.vue'), 'utf8')
  const defaultSetting = fs.readFileSync(path.join(root, 'src/common/defaultSetting.ts'), 'utf8')
  const appSettingType = fs.readFileSync(path.join(root, 'src/common/types/app_setting.d.ts'), 'utf8')
  const settingRecommend = fs.readFileSync(path.join(root, 'src/renderer/views/Setting/components/SettingRecommend.vue'), 'utf8')
  const recommendIndex = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/index.vue'), 'utf8')
  const recommendConstants = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/constants.ts'), 'utf8')
  const recommendPlayback = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/useRecommendPlayback.ts'), 'utf8')
  const recommendTypes = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/types.ts'), 'utf8')
  const recommendCards = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/useRecommendCards.ts'), 'utf8')

  assert.match(
    aside,
    /import\s*{[^}]*initQQMusicAccount[^}]*isLoggedIn\s+as\s+qqIsLoggedIn[^}]*logoutQQMusicAccount[^}]*profile\s+as\s+qqProfile[^}]*}\s*from\s*'@renderer\/store\/qqMusic'/s,
    'Aside should import the QQ Music account store with explicit QQ aliases',
  )

  assert.match(
    aside,
    /import\s*{[^}]*initNeteaseAccount[^}]*isLoggedIn\s+as\s+neteaseIsLoggedIn[^}]*logoutNeteaseAccount[^}]*profile\s+as\s+neteaseProfile[^}]*}\s*from\s*'@renderer\/store\/netease'/s,
    'Aside should import the NetEase account store with explicit NetEase aliases',
  )

  assert.strictEqual(
    (aside.match(/:class="\$style\.providerRow"/g) || []).length,
    2,
    'Aside should render exactly two stable provider rows',
  )
  assert.match(aside, />QQ 音乐</)
  assert.match(aside, />网易云音乐</)

  assert.match(
    aside,
    /const\s+logoProfile\s*=\s*computed\(\(\)\s*=>[\s\S]*?neteaseProfile\.value\)/,
    'The top-level avatar should remain based on the NetEase profile',
  )
  assert.doesNotMatch(
    aside,
    /const\s+logoProfile[^\n]*qqProfile/,
    'QQ Music login should not replace the top-level avatar',
  )

  const qqAction = aside.match(/const\s+handleQQMusicAction[\s\S]*?(?=const\s+handleNeteaseAction)/)?.[0] || ''
  const neteaseAction = aside.match(/const\s+handleNeteaseAction[\s\S]*?(?=onMounted\()/)?.[0] || ''
  assert.match(qqAction, /logoutQQMusicAccount\(\)/)
  assert.doesNotMatch(qqAction, /logoutNeteaseAccount\(\)/)
  assert.match(neteaseAction, /logoutNeteaseAccount\(\)/)
  assert.doesNotMatch(neteaseAction, /logoutQQMusicAccount\(\)/)

  assert.match(
    qqAction,
    /if\s*\(route\.path\s*==\s*'\/recommend'\)\s*window\.dispatchEvent\(new Event\('show-qq-music-login'\)\)/,
    'QQ Music login should dispatch its event only while already on the recommend page',
  )
  assert.match(
    neteaseAction,
    /if\s*\(route\.path\s*==\s*'\/recommend'\)\s*window\.dispatchEvent\(new Event\('show-netease-login'\)\)/,
    'NetEase login should dispatch its event only while already on the recommend page',
  )
  assert.match(qqAction, /router\.push\([\s\S]*?login:\s*'qq'/)
  assert.match(neteaseAction, /router\.push\([\s\S]*?login:\s*'netease'/)
  assert.doesNotMatch(aside, /login:\s*'1'/)

  assert.match(
    aside,
    /Promise\.all\(\[\s*initQQMusicAccount\(\)\.catch\(\(\)\s*=>\s*null\),\s*initNeteaseAccount\(\)\.catch\(\(\)\s*=>\s*null\),?\s*]\)/s,
    'QQ Music and NetEase account initialization should run independently in parallel',
  )

  assert.match(defaultSetting, /'recommend\.qqGuessLikeLoggedOutVisible':\s*true/)
  assert.match(appSettingType, /'recommend\.qqGuessLikeLoggedOutVisible':\s*boolean/)
  const qqGuessLikeSetting = settingRecommend.match(/dt#recommend[^\r\n]*\r?\n([\s\S]*?)(?=dd\r?\n\s+h3#recommend_home_section_order)/)?.[1] || ''
  assert.match(qqGuessLikeSetting, /base-checkbox\(/)
  assert.match(qqGuessLikeSetting, /id="setting_recommend_qq_guess_like_logged_out_visible"/)
  assert.match(qqGuessLikeSetting, /:model-value="appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\]"/)
  assert.match(qqGuessLikeSetting, /:label="\$t\('setting__recommend_qq_guess_like_logged_out_visible'\)"/)
  assert.match(
    qqGuessLikeSetting,
    /@update:model-value="updateSetting\(\{ 'recommend\.qqGuessLikeLoggedOutVisible': \$event \}\)"/,
  )
  const setupReturn = settingRecommend.match(/return\s*\{[\s\S]*?\n\s*\}/)?.[0] || ''
  assert.match(setupReturn, /\bappSetting\s*,/)
  assert.match(setupReturn, /\bupdateSetting\s*,/)

  const locales = {
    'zh-CN': JSON.parse(fs.readFileSync(path.join(root, 'src/lang/zh-cn.json'), 'utf8')),
    'zh-TW': JSON.parse(fs.readFileSync(path.join(root, 'src/lang/zh-tw.json'), 'utf8')),
    'en-US': JSON.parse(fs.readFileSync(path.join(root, 'src/lang/en-us.json'), 'utf8')),
  }
  assert.strictEqual(
    locales['zh-CN'].setting__recommend_qq_guess_like_logged_out_visible,
    '未登录 QQ 音乐时显示“猜你喜欢”登录入口',
  )
  assert.strictEqual(
    locales['zh-TW'].setting__recommend_qq_guess_like_logged_out_visible,
    '未登入 QQ 音樂時顯示「猜你喜歡」登入入口',
  )
  assert.strictEqual(
    locales['en-US'].setting__recommend_qq_guess_like_logged_out_visible,
    'Show the Guess You Like login entry when QQ Music is signed out',
  )

  /*
  assert.match(qqGuessLikeSection, /v-if="!isLoggedIn && visibleWhenLoggedOut"/)
  assert.match(qqGuessLikeSection, /v-else-if="isLoggedIn && songs\.length"/)
  assert.match(qqGuessLikeSection, /similar-songs-section/)
  assert.match(qqGuessLikeSection, /title="猜你喜欢"/)
  assert.match(qqGuessLikeSection, /desc="[^"]*QQ 音乐[^"]*"/)
  assert.match(qqGuessLikeSection, />登录 QQ 音乐后获取猜你喜欢</)
  assert.match(qqGuessLikeSection, />登录 QQ 音乐</)
  assert.match(qqGuessLikeSection, /@click="\$emit\('login'\)"/)
  assert.match(qqGuessLikeSection, /@click="\$emit\('retry'\)"/)
  assert.match(qqGuessLikeSection, /@refresh="\$emit\('refresh'\)"/)
  assert.match(qqGuessLikeSection, /@play-all="\$emit\('play-all'\)"/)
  assert.match(qqGuessLikeSection, /@play="\$emit\('play', \$event\)"/)
  assert.match(qqGuessLikeSection, /@toggle-love="\$emit\('toggle-love', \$event\)"/)
  assert.match(qqGuessLikeSection, /:is-home-song-playing="isSongPlaying"/)
  assert.match(qqGuessLikeSection, /:is-home-song-loved="isSongLoved"/)
  assert.match(qqGuessLikeSection, /:refreshing="isRefreshing"/)
  assert.match(qqGuessLikeSection, /\(isLoading \|\| isRefreshing\)/)
  */
  assert.match(recommendConstants, /QQ_GUESS_LIKE_TEMP_LIST_ID\s*=\s*'tx__qq_guess_like'/)
  assert.match(recommendConstants, /QQ_GUESS_LIKE_CARD_ID\s*=\s*'qq_guess_like'/)
  assert.match(recommendTypes, /isQQGuessLike\?:\s*boolean/)
  assert.match(recommendCards, /QQ_GUESS_LIKE_CARD_ID/)
  assert.match(recommendCards, /isQQGuessLike:\s*true/)
  assert.match(recommendCards, /showQQGuessLike/)
  assert.match(recommendCards, /isLoadingQQGuessLike/)
  assert.match(recommendCards, /qqGuessLikeLoadError/)
  assert.match(recommendPlayback, /handleToggleQQGuessLikeCard/)
  assert.match(recommendPlayback, /getQQGuessLikeAccountKey/)
  assert.match(recommendPlayback, /onQQGuessLikeLoginRequired/)

  assert.match(
    recommendIndex,
    /import\s*{[^}]*initNeteaseAccount[^}]*isLoggedIn\s+as\s+neteaseIsLoggedIn[^}]*profile\s+as\s+neteaseProfile[^}]*}\s*from\s*'@renderer\/store\/netease'/s,
  )
  assert.match(
    recommendIndex,
    /import\s*{[^}]*initQQMusicAccount[^}]*isLoggedIn\s+as\s+qqIsLoggedIn[^}]*profile\s+as\s+qqProfile[^}]*}\s*from\s*'@renderer\/store\/qqMusic'/s,
  )
  assert.match(recommendIndex, /import { useQQMusicLoginQr } from '.\/useQQMusicLoginQr'/)
  assert.doesNotMatch(recommendIndex, /QQGuessLikeSection/)

  const specialCardsPosition = recommendIndex.indexOf('<SpecialCards')
  const neteaseLoopPosition = recommendIndex.indexOf('<template v-for="section in homeSectionOrder"')
  assert.ok(specialCardsPosition >= 0 && neteaseLoopPosition > specialCardsPosition, 'Special cards should remain before the NetEase home section loop')
  assert.match(recommendIndex, /<SpecialCards[\s\S]*?@toggle-card-play="handleToggleCardPlay"/)
  assert.match(recommendIndex, /showQQGuessLike/)
  assert.match(recommendIndex, /loadQQGuessLikeSongs/)
  assert.doesNotMatch(recommendIndex, /qqLoadCoordinator/)
  assert.doesNotMatch(recommendIndex, /handleRefreshQQGuessLike/)
  assert.doesNotMatch(recommendIndex, /void\s+initializeQQAccount\(\)/)

  const loginPanels = recommendIndex.match(/<login-panel[\s\S]*?\/>/g) || []
  assert.strictEqual(loginPanels.length, 2)
  assert.ok(loginPanels.some(panel => /title="登录 QQ 音乐"/.test(panel) && /instruction="请使用手机 QQ 扫码，并在手机上确认"/.test(panel)))
  assert.ok(loginPanels.some(panel => /title="登录网易云音乐"/.test(panel) && /instruction="请使用网易云音乐 App 扫码，并在手机上确认"/.test(panel)))
  const showQQWrapper = recommendIndex.match(/const handleShowQQLogin[\s\S]*?(?=const handleShowNeteaseLogin)/)?.[0] || ''
  const showNeteaseWrapper = recommendIndex.match(/const handleShowNeteaseLogin[\s\S]*?(?=const |watch\()/)?.[0] || ''
  assert.match(showQQWrapper, /handleCloseNeteaseLogin\(\)/)
  assert.match(showQQWrapper, /if\s*\(showQQLoginPanel\.value\)\s*return/)
  assert.match(showNeteaseWrapper, /handleCloseQQLogin\(\)/)
  assert.match(showNeteaseWrapper, /if\s*\(showNeteaseLoginPanel\.value\)\s*return/)

  const loginRouteWatch = recommendIndex.match(/watch\(\(\)\s*=>\s*route\.query\.login[\s\S]*?\},\s*\{\s*immediate:\s*true\s*\}\)/)?.[0] || ''
  assert.match(loginRouteWatch, /login\s*==\s*'qq'/)
  assert.match(loginRouteWatch, /login\s*==\s*'netease'/)
  assert.match(loginRouteWatch, /login\s*==\s*'1'/)
  assert.match(loginRouteWatch, /if\s*\(login\s*!=\s*null\)/)
  assert.match(loginRouteWatch, /const query\s*=\s*\{\s*\.\.\.route\.query\s*\}/)
  assert.match(loginRouteWatch, /delete query\.login/)
  assert.match(loginRouteWatch, /router\.replace\(\{\s*path:\s*route\.path,\s*query\s*\}\)\.catch\(_\s*=>\s*_\)/)

  assert.match(recommendIndex, /window\.addEventListener\('show-qq-music-login',\s*handleQQMusicLoginRequest\)/)
  assert.match(recommendIndex, /window\.addEventListener\('show-netease-login',\s*handleNeteaseLoginRequest\)/)
  assert.match(recommendIndex, /window\.removeEventListener\('show-qq-music-login',\s*handleQQMusicLoginRequest\)/)
  assert.match(recommendIndex, /window\.removeEventListener\('show-netease-login',\s*handleNeteaseLoginRequest\)/)
  assert.match(recommendIndex, /import { createLatestLoadCoordinator } from '.\/accountLoadCoordinator'/)
  assert.doesNotMatch(recommendIndex, /isHandling(?:QQ|Netease)QrLoginSuccess|(?:qq|netease)LifecycleRevision/)
  assert.match(recommendIndex, /const neteaseAccountKey\s*=\s*computed\(\(\)\s*=>\s*neteaseIsLoggedIn\.value\s*\?[\s\S]*?neteaseProfile\.value\?\.userId/)
  const neteaseAccountWatch = recommendIndex.match(/watch\(neteaseAccountKey,[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(neteaseAccountWatch, /suppressNextNeteaseAccountWatchKey[\s\S]*?if\s*\(value\s*==\s*suppressedKey\)\s*return/)
  assert.match(neteaseAccountWatch, /if\s*\(isInitializingNeteaseAccount\)[\s\S]*?forceNeteaseLoadAfterInitialization\s*=\s*true[\s\S]*?neteaseLoadCoordinator\.request\(true\)/)

  const neteaseQrSuccess = recommendIndex.match(/useNeteaseLoginQr\(async\(\)\s*=>\s*\{[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(neteaseQrSuccess, /const handledKey\s*=\s*neteaseAccountKey\.value[\s\S]*?suppressNextNeteaseAccountWatchKey\s*=\s*handledKey[\s\S]*?initializationHandledNeteaseKey\s*=\s*handledKey[\s\S]*?neteaseLoadCoordinator\.request\(true\)[\s\S]*?await nextTick\(\)/)

  const initializeNetease = recommendIndex.match(/const initializeNeteaseAccount\s*=\s*async\(\)\s*=>\s*\{[\s\S]*?\n}/)?.[0] || ''
  assert.match(initializeNetease, /await initNeteaseAccount\(\)[\s\S]*?await nextTick\(\)[\s\S]*?currentKey\s*=\s*neteaseAccountKey\.value[\s\S]*?handledKey\s*=\s*initializationHandledNeteaseKey/)
  assert.match(initializeNetease, /forceNeteaseLoadAfterInitialization\s*=\s*false[\s\S]*?initializationHandledNeteaseKey\s*=\s*null[\s\S]*?isInitializingNeteaseAccount\s*=\s*false/)
  assert.match(initializeNetease, /handledKey\s*==\s*currentKey[\s\S]*?&&\s*!force[\s\S]*?neteaseLoadCoordinator\.request\(force\s*\|\|\s*handledKey\s*!=\s*null\)/)
  assert.match(
    recommendIndex,
    /if\s*\(!isExploreMode\.value\s*&&\s*\([\s\S]*?qqIsLoggedIn\.value[\s\S]*?appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\][\s\S]*?\)\)\s*return ''/,
  )
  /*
  assert.match(qqGuessLikeSection, /loadError/)
  assert.match(qqGuessLikeSection, /暂无猜你喜欢歌曲/)
  */
}

const createQQPlaybackHarness = ({ accountKey = 'A', loadQQGuessLikeSongs }) => {
  const constants = loadTsModule(path.join(root, 'src/renderer/views/Recommend/constants.ts'))
  assert.strictEqual(constants.QQ_GUESS_LIKE_TEMP_LIST_ID, 'tx__qq_guess_like')

  const isPlay = ref(false)
  const playInfo = { playerListId: null }
  const playMusicInfo = { musicInfo: null }
  const tempListMeta = { id: '' }
  const setTempListCalls = []
  const playListCalls = []
  const routerPushes = []
  let loginRequiredCalls = 0
  let pauseCalls = 0
  let playCalls = 0
  const LIST_IDS = { TEMP: 'temp' }

  const playbackModule = loadTsModule(path.join(root, 'src/renderer/views/Recommend/useRecommendPlayback.ts'), {
    '@common/constants': { LIST_IDS },
    '@common/utils/vueRouter': {
      useRoute: () => ({ name: 'recommend' }),
      useRouter: () => ({ push: async location => { routerPushes.push(location) } }),
    },
    '@renderer/store/player/state': { isPlay, playInfo, playMusicInfo },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/list/action': {
      setTempList: async(id, songs) => { setTempListCalls.push([id, songs]) },
    },
    '@renderer/store/privateFm/action': { enterPrivateFmMode: async() => {} },
    '@renderer/store/privateFm/state': { isLoadingPrivateFm: ref(false), isPrivateFmMode: ref(false) },
    '@renderer/store/dailyRecommend/action': { playDailyRecommend: async() => {} },
    '@renderer/store/dailyRecommend/state': { isDailyRecommendPlayingList: ref(false), isLoadingDailyRecommend: ref(false) },
    '@renderer/core/player': {
      pause: () => { pauseCalls++ },
      play: () => { playCalls++ },
      playList: (listId, index) => { playListCalls.push([listId, index]) },
    },
    '@renderer/views/songList/Detail/action': { playSongListDetail: async() => {} },
    './constants': constants,
    './utils': { toCloneable: value => value },
  })

  const qqGuessLikeSongs = ref([])
  let currentAccountKey = accountKey
  const playback = playbackModule.useRecommendPlayback({
    homeStyleSongs: ref([]),
    homeSimilarSongs: ref([]),
    qqGuessLikeSongs,
    loadQQGuessLikeSongs,
    getQQGuessLikeAccountKey: () => currentAccountKey,
    onQQGuessLikeLoginRequired: () => { loginRequiredCalls++ },
    setError: () => {},
  })

  return {
    playback,
    qqGuessLikeSongs,
    setAccountKey: value => { currentAccountKey = value },
    playInfo,
    tempListMeta,
    isPlay,
    setTempListCalls,
    playListCalls,
    routerPushes,
    get loginRequiredCalls() { return loginRequiredCalls },
    get pauseCalls() { return pauseCalls },
    get playCalls() { return playCalls },
    LIST_IDS,
  }
}

const testQQRecommendCards = () => {
  const dailyRecommendSongs = [song('daily')]
  const privateFmQueue = [song('private')]
  const qqSong = { ...song('qq'), meta: { picUrl: 'https://example.com/qq.jpg' } }
  const qqGuessLikeSongs = ref([qqSong])
  const isLoadingQQGuessLike = ref(true)
  const qqGuessLikeLoadError = ref('')
  const showQQGuessLike = ref(true)
  const cardsModule = loadTsModule(path.join(root, 'src/renderer/views/Recommend/useRecommendCards.ts'), {
    '@common/utils/vueTools': { computed: getter => ({ get value() { return getter() } }) },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'wy__wy_daily_recommend', dailyRecommendSongs },
    '@renderer/store/privateFm/state': { privateFmQueue },
    './constants': { PRIVATE_FM_CARD_ID: 'private_fm', PRIVATE_RADAR_PLAYLIST_ID: 'radar', QQ_GUESS_LIKE_CARD_ID: 'qq_guess_like' },
  })

  const { specialCards } = cardsModule.useRecommendCards(ref([]), {
    qqGuessLikeSongs,
    isLoadingQQGuessLike,
    qqGuessLikeLoadError,
    showQQGuessLike,
  })
  assert.deepStrictEqual(specialCards.value.map(card => card.id), ['wy__wy_daily_recommend', 'private_fm', 'qq_guess_like'])
  const qqCard = specialCards.value.at(-1)
  assert.strictEqual(qqCard.isQQGuessLike, true)
  assert.match(qqCard.desc, /加载中/)
  assert.strictEqual(qqCard.img, qqSong.meta.picUrl)

  isLoadingQQGuessLike.value = false
  qqGuessLikeLoadError.value = '猜你喜欢加载失败，请稍后重试'
  assert.strictEqual(specialCards.value.at(-1).desc, qqGuessLikeLoadError.value)
  showQQGuessLike.value = false
  assert.deepStrictEqual(specialCards.value.map(card => card.id), ['wy__wy_daily_recommend', 'private_fm'])
}

const testQQRecommendPlayback = async() => {
  const pendingLoad = deferred()
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      return pendingLoad.promise
    },
  })

  const firstActivation = harness.playback.handleToggleQQGuessLikeCard()
  const secondActivation = harness.playback.handleToggleQQGuessLikeCard()
  await Promise.resolve()
  assert.strictEqual(loadCalls, 1, 'pending card activations should share one load')
  pendingLoad.resolve([song('qq-1'), song('qq-2')])
  await Promise.all([firstActivation, secondActivation])
  assert.strictEqual(harness.setTempListCalls.length, 1)
  assert.deepStrictEqual(harness.setTempListCalls[0], ['tx__qq_guess_like', harness.qqGuessLikeSongs.value])
  assert.deepStrictEqual(harness.playListCalls, [[harness.LIST_IDS.TEMP, 0]])

  harness.playInfo.playerListId = harness.LIST_IDS.TEMP
  harness.tempListMeta.id = 'tx__qq_guess_like'
  harness.isPlay.value = true
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(harness.pauseCalls, 1)
  harness.isPlay.value = false
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(harness.playCalls, 1)
  assert.strictEqual(loadCalls, 1, 'pause and resume should not refetch installed QQ songs')

  harness.playback.handleOpenPlaylist({ id: 'qq_guess_like', source: 'tx', img: '', isQQGuessLike: true })
  assert.deepStrictEqual(harness.routerPushes, [], 'opening a QQ card should not navigate to song-list detail')
}

const testQQCardLoggedOutRequiresLogin = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    accountKey: null,
    loadQQGuessLikeSongs: async() => { loadCalls++ },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(harness.loginRequiredCalls, 1)
  assert.strictEqual(loadCalls, 0)
  assert.deepStrictEqual(harness.routerPushes, [])
}

const testQQCardAccountOwnership = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      harness.qqGuessLikeSongs.value = [song(`qq-${loadCalls}`)]
    },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  harness.playInfo.playerListId = harness.LIST_IDS.TEMP
  harness.tempListMeta.id = 'tx__qq_guess_like'
  harness.isPlay.value = true
  harness.setAccountKey('B')
  harness.qqGuessLikeSongs.value = []
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2, 'account B must load its own QQ queue')
  assert.strictEqual(harness.setTempListCalls.length, 2)
  assert.strictEqual(harness.pauseCalls, 0, 'account B must not pause account A queue')
}

const testQQCardEmptyLoadsAreRetryable = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => { loadCalls++ },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2)
  assert.deepStrictEqual(harness.setTempListCalls, [])
  assert.deepStrictEqual(harness.playListCalls, [])
}

const loadGuessLikeModule = ({ isLoggedIn, profile, getSongs, initAccount = async() => {} }) => {
  return loadTsModule(path.join(root, 'src/renderer/views/Recommend/useQQGuessLikeData.ts'), {
    '@common/utils/vueTools': { ref },
    '@renderer/store/qqMusic': {
      isLoggedIn,
      profile,
      initQQMusicAccount: initAccount,
    },
    '@renderer/utils/ipc': { getQQMusicGuessLikeSongs: getSongs },
  })
}

const loadGuessLikeData = options => {
  return loadGuessLikeModule(options).useQQGuessLikeData()
}

const testLoggedOutClearsWithoutRequest = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'A' })
  let requestCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => {
      requestCount++
      return [song('A-1')]
    },
  })

  await state.load()
  state.loadError.value = 'old error'
  isLoggedIn.value = false
  profile.value = null
  await state.load()

  assert.strictEqual(requestCount, 1)
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.loadError.value, '')
  assert.strictEqual(state.isLoading.value, false)
  assert.strictEqual(state.isRefreshing.value, false)
}

const testAccountScopedCache = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'A' })
  const responses = [[song('A-1')], [song('B-1')]]
  let requestCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => responses[requestCount++],
  })

  await state.load()
  assert.deepStrictEqual(state.songs.value, [song('A-1')])
  await state.load()
  assert.strictEqual(requestCount, 1)

  profile.value = { uin: 'B' }
  const loadingB = state.load()
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.isLoading.value, true)
  await loadingB
  assert.deepStrictEqual(state.songs.value, [song('B-1')])

  profile.value = { uin: 'A' }
  await state.load()
  assert.strictEqual(requestCount, 2)
  assert.deepStrictEqual(state.songs.value, [song('A-1')])
}

const testModuleLevelCacheAcrossComposableInstances = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'shared-account' })
  const responses = [[song('shared')], [song('after-clear')]]
  let requestCount = 0
  const guessLikeModule = loadGuessLikeModule({
    isLoggedIn,
    profile,
    getSongs: async() => responses[requestCount++],
  })

  const firstState = guessLikeModule.useQQGuessLikeData()
  await firstState.load()
  assert.strictEqual(requestCount, 1)

  const secondState = guessLikeModule.useQQGuessLikeData()
  await secondState.load()
  assert.strictEqual(requestCount, 1)
  assert.deepStrictEqual(secondState.songs.value, [song('shared')])

  firstState.clear()
  const stateAfterClear = guessLikeModule.useQQGuessLikeData()
  await stateAfterClear.load()
  assert.strictEqual(requestCount, 2)
  assert.deepStrictEqual(stateAfterClear.songs.value, [song('after-clear')])
}

const testForceFailureAndEmptyCache = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'force-account' })
  const responses = [
    [song('old')],
    new Error('https://u.y.qq.com/private?cookie=secret'),
    [],
  ]
  const initCalls = []
  let requestCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => {
      const result = responses[requestCount++]
      if (result instanceof Error) throw result
      return result
    },
    initAccount: async force => {
      initCalls.push(force)
      throw new Error('account refresh failed independently')
    },
  })

  await state.load()
  await state.load(true)
  assert.deepStrictEqual(state.songs.value, [song('old')])
  assert.strictEqual(state.loadError.value, '猜你喜欢加载失败，请稍后重试')
  assert.doesNotMatch(state.loadError.value, /https|cookie|secret/)
  assert.deepStrictEqual(initCalls, [true])

  await state.load(true)
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.loadError.value, '')
  await state.load()
  assert.strictEqual(requestCount, 3)
  assert.deepStrictEqual(state.songs.value, [])
}

const testAccountRaceAndLoadingOwnership = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'A' })
  const requestA = deferred()
  const requestB = deferred()
  const requests = [requestA.promise, requestB.promise]
  let requestCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => requests[requestCount++],
  })

  const loadingA = state.load()
  profile.value = { uin: 'B' }
  const loadingB = state.load()
  requestA.resolve([song('A-late')])
  await loadingA
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.isLoading.value, true)

  requestB.resolve([song('B-current')])
  await loadingB
  assert.deepStrictEqual(state.songs.value, [song('B-current')])
  assert.strictEqual(state.isLoading.value, false)
}

const testStaleFailureDoesNotRefreshCurrentAccount = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'A' })
  const requestA = deferred()
  const requestB = deferred()
  const requests = [requestA.promise, requestB.promise]
  let requestCount = 0
  let initCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => requests[requestCount++],
    initAccount: async() => { initCount++ },
  })

  const loadingA = state.load()
  profile.value = { uin: 'B' }
  const loadingB = state.load()
  requestA.reject(new Error('stale A failure'))
  await loadingA
  assert.strictEqual(initCount, 0)
  assert.strictEqual(state.loadError.value, '')
  assert.strictEqual(state.isLoading.value, true)

  requestB.resolve([song('B-current')])
  await loadingB
  assert.deepStrictEqual(state.songs.value, [song('B-current')])
}

const testAuthLogoutStillFinishesOwnedLoading = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'auth-expired' })
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => { throw new Error('expired') },
    initAccount: async() => {
      isLoggedIn.value = false
      profile.value = null
    },
  })

  await state.load(true)
  assert.strictEqual(state.isRefreshing.value, false)
  assert.strictEqual(state.isLoading.value, false)
}

const testLatestForceWins = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'same-account' })
  const oldRequest = deferred()
  const newRequest = deferred()
  const requests = [oldRequest.promise, newRequest.promise]
  let requestCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => requests[requestCount++],
  })

  const older = state.load(true)
  const newer = state.load(true)
  newRequest.resolve([song('newer')])
  await newer
  oldRequest.resolve([song('older')])
  await older
  assert.deepStrictEqual(state.songs.value, [song('newer')])
}

const testClearAfterProfileReset = async() => {
  const isLoggedIn = ref(true)
  const profile = ref({ uin: 'clear-account' })
  const pending = deferred()
  const responses = [[song('cached')], pending.promise, [song('fresh')]]
  let requestCount = 0
  const state = loadGuessLikeData({
    isLoggedIn,
    profile,
    getSongs: async() => responses[requestCount++],
  })

  await state.load()
  const refreshing = state.load(true)
  isLoggedIn.value = false
  profile.value = null
  state.clear()
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.isRefreshing.value, false)

  pending.resolve([song('stale')])
  await refreshing
  assert.deepStrictEqual(state.songs.value, [])

  isLoggedIn.value = true
  profile.value = { uin: 'clear-account' }
  await state.load()
  assert.strictEqual(requestCount, 3)
  assert.deepStrictEqual(state.songs.value, [song('fresh')])
}

const main = async() => {
  await testLatestLoadCoordinator()
  testStaticWiring()
  testQQRecommendCards()
  await testQQRecommendPlayback()
  await testQQCardLoggedOutRequiresLogin()
  await testQQCardAccountOwnership()
  await testQQCardEmptyLoadsAreRetryable()
  await testLoggedOutClearsWithoutRequest()
  await testAccountScopedCache()
  await testModuleLevelCacheAcrossComposableInstances()
  await testForceFailureAndEmptyCache()
  await testAccountRaceAndLoadingOwnership()
  await testStaleFailureDoesNotRefreshCurrentAccount()
  await testAuthLogoutStillFinishesOwnedLoading()
  await testLatestForceWins()
  await testClearAfterProfileReset()
  console.log('QQ Music account menu and recommendation state tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
