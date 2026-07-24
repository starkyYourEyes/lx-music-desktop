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

  assert.match(recommendConstants, /QQ_GUESS_LIKE_TEMP_LIST_ID\s*=\s*'tx__qq_guess_like'/)
  assert.match(recommendConstants, /QQ_GUESS_LIKE_CARD_ID\s*=\s*'qq_guess_like'/)
  assert.match(recommendTypes, /isQQGuessLike\?:\s*boolean/)
  assert.match(recommendCards, /QQ_GUESS_LIKE_CARD_ID/)
  assert.match(recommendCards, /isQQGuessLike:\s*true/)
  assert.match(recommendCards, /showQQGuessLike/)
  assert.match(recommendCards, /isQQGuessLikeLoading/)
  assert.match(recommendCards, /qqGuessLikeLoadError/)
  assert.match(recommendPlayback, /handleToggleQQGuessLikeCard/)
  assert.match(recommendPlayback, /resetQQGuessLikePlayback/)
  assert.match(recommendPlayback, /getQQGuessLikeAccountKey/)
  assert.match(recommendPlayback, /onQQGuessLikeLoginRequired/)
  assert.ok(
    recommendCards.indexOf('result.push(privateFmCard.value)') < recommendCards.indexOf('result.push(qqGuessLikeCard.value)'),
    'QQ Guess You Like should follow Private FM in the special-card order',
  )

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
  const specialCards = recommendIndex.match(/<SpecialCards[\s\S]*?\/>/)?.[0] || ''
  assert.match(specialCards, /:cards="specialCards"/)
  assert.match(specialCards, /@open="handleOpenPlaylist"/)
  assert.match(specialCards, /@toggle-card-play="handleToggleCardPlay"/)
  const showQQGuessLikeCardDeclaration = recommendIndex.match(/const\s+showQQGuessLikeCard\s*=\s*computed\([\s\S]*?(?=\n\s*const\s|\n\s*\n)/)?.[0] || ''
  assert.match(showQQGuessLikeCardDeclaration, /qqIsLoggedIn\.value\s*\|\|\s*appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\]/)
  const recommendCardsCall = recommendIndex.match(/useRecommendCards\(\s*specialSourcePlaylists\s*,\s*\{[\s\S]*?\}\s*\)/)?.[0] || ''
  assert.match(recommendCardsCall, /showQQGuessLike:\s*showQQGuessLikeCard/)
  assert.match(recommendCardsCall, /qqGuessLikeSongs/)
  assert.match(recommendCardsCall, /isQQGuessLikeLoading/)
  assert.match(recommendCardsCall, /qqGuessLikeLoadError/)
  const recommendPlaybackCall = recommendIndex.match(/useRecommendPlayback\(\{[\s\S]*?\n\}\)/)?.[0] || ''
  assert.match(recommendPlaybackCall, /loadQQGuessLikeSongs:\s*loadQQGuessLikeForPlayback/)
  assert.match(recommendPlaybackCall, /getQQGuessLikeAccountKey:\s*\(\)\s*=>\s*qqAccountKey\.value/)
  assert.match(recommendPlaybackCall, /onQQGuessLikeLoginRequired:\s*handleShowQQLogin/)
  const lazyQQPlaybackLoader = recommendIndex.match(/const\s+loadQQGuessLikeForPlayback\s*=\s*async\(\)\s*=>\s*\{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(lazyQQPlaybackLoader, /return\s+(?:await\s+)?loadQQGuessLikeSongs\(\)/)
  const playbackCallPosition = recommendIndex.indexOf('useRecommendPlayback({')
  assert.ok(recommendIndex.indexOf('const handleShowQQLogin') >= 0 && recommendIndex.indexOf('const handleShowQQLogin') < playbackCallPosition)
  assert.ok(recommendIndex.indexOf('const loadQQGuessLikeForPlayback') >= 0 && recommendIndex.indexOf('const loadQQGuessLikeForPlayback') < playbackCallPosition)
  assert.doesNotMatch(recommendIndex, /qqLoadCoordinator/)
  assert.doesNotMatch(recommendIndex, /handleRefreshQQGuessLike/)
  assert.doesNotMatch(recommendIndex, /handleToggleQQGuessLikeSongs/)
  assert.doesNotMatch(recommendIndex, /handlePlayQQGuessLikeSongs/)
  assert.doesNotMatch(recommendIndex, /isQQGuessLikeSongPlaying/)
  assert.doesNotMatch(recommendPlayback, /handleToggleQQGuessLikeSongs/)
  assert.doesNotMatch(recommendPlayback, /handlePlayQQGuessLikeSongs/)
  assert.doesNotMatch(recommendPlayback, /isQQGuessLikeSongPlaying/)

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
  const qqAccountWatch = recommendIndex.match(/watch\(qqAccountKey,[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(qqAccountWatch, /resetQQGuessLikePlayback\(\)[\s\S]*?clearQQGuessLikeSongs\(\)/)
  assert.match(qqAccountWatch, /clearQQGuessLikeSongs\(\)/)
  assert.match(qqAccountWatch, /if\s*\(value\)[\s\S]*?handleCloseQQLogin\(\)/)
  assert.doesNotMatch(qqAccountWatch, /loadQQGuessLikeSongs|loadQQGuessLikeForPlayback|qqLoadCoordinator/)
  const neteaseAccountWatch = recommendIndex.match(/watch\(neteaseAccountKey,[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(neteaseAccountWatch, /suppressNextNeteaseAccountWatchKey[\s\S]*?if\s*\(value\s*==\s*suppressedKey\)\s*return/)
  assert.match(neteaseAccountWatch, /if\s*\(isInitializingNeteaseAccount\)[\s\S]*?forceNeteaseLoadAfterInitialization\s*=\s*true[\s\S]*?neteaseLoadCoordinator\.request\(true\)/)

  const qqQrSuccess = recommendIndex.match(/useQQMusicLoginQr\(async\(\)\s*=>\s*\{[\s\S]*?\n}\)/)?.[0] || ''
  const neteaseQrSuccess = recommendIndex.match(/useNeteaseLoginQr\(async\(\)\s*=>\s*\{[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(qqQrSuccess, /handleCloseQQLogin\(\)/)
  assert.doesNotMatch(qqQrSuccess, /loadQQGuessLikeSongs|loadQQGuessLikeForPlayback|qqLoadCoordinator/)
  assert.match(neteaseQrSuccess, /const handledKey\s*=\s*neteaseAccountKey\.value[\s\S]*?suppressNextNeteaseAccountWatchKey\s*=\s*handledKey[\s\S]*?initializationHandledNeteaseKey\s*=\s*handledKey[\s\S]*?neteaseLoadCoordinator\.request\(true\)[\s\S]*?await nextTick\(\)/)

  const initializeNetease = recommendIndex.match(/const initializeNeteaseAccount\s*=\s*async\(\)\s*=>\s*\{[\s\S]*?\n}/)?.[0] || ''
  const initializeQQ = recommendIndex.match(/const initializeQQAccount\s*=\s*async\(\)\s*=>\s*\{[\s\S]*?\n}/)?.[0] || ''
  assert.match(initializeQQ, /await initQQMusicAccount\(\)/)
  assert.match(initializeQQ, /if\s*\(!qqAccountKey\.value\)\s*clearQQGuessLikeSongs\(\)/)
  assert.doesNotMatch(initializeQQ, /loadQQGuessLikeSongs|loadQQGuessLikeForPlayback|qqLoadCoordinator/)
  assert.match(initializeNetease, /await initNeteaseAccount\(\)[\s\S]*?await nextTick\(\)[\s\S]*?currentKey\s*=\s*neteaseAccountKey\.value[\s\S]*?handledKey\s*=\s*initializationHandledNeteaseKey/)
  assert.match(initializeNetease, /forceNeteaseLoadAfterInitialization\s*=\s*false[\s\S]*?initializationHandledNeteaseKey\s*=\s*null[\s\S]*?isInitializingNeteaseAccount\s*=\s*false/)
  assert.match(initializeNetease, /handledKey\s*==\s*currentKey[\s\S]*?&&\s*!force[\s\S]*?neteaseLoadCoordinator\.request\(force\s*\|\|\s*handledKey\s*!=\s*null\)/)
  assert.match(
    recommendIndex,
    /if\s*\(!isExploreMode\.value\s*&&\s*\([\s\S]*?qqIsLoggedIn\.value[\s\S]*?appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\][\s\S]*?\)\)\s*return ''/,
  )
  const onMountedBlock = recommendIndex.match(/onMounted\(\(\)\s*=>\s*\{[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(onMountedBlock, /void initializeQQAccount\(\)/)
  assert.match(onMountedBlock, /void initializeNeteaseAccount\(\)/)
}

const createQQPlaybackHarness = ({ accountKey = 'A', loadQQGuessLikeSongs, routerPush = async() => {} }) => {
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

  const playbackModule = loadTsModule(path.join(root, 'src/renderer/views/QQRecommend/useQQGuessLikePlayback.ts'), {
    '@common/constants': { LIST_IDS },
    '@common/utils/vueRouter': {
      useRoute: () => ({ name: 'recommend' }),
      useRouter: () => ({
        push: location => {
          routerPushes.push(location)
          return routerPush(location)
        },
      }),
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
    '@renderer/store/qqGuessLike/action': {
      enterQQGuessLikeMode: async(account) => {
        activeAccountKey = account
        setTempListCalls.push(['tx__qq_guess_like', [...qqGuessLikeSongs.value]])
        tempListMeta.id = 'tx__qq_guess_like'
        playInfo.playerListId = LIST_IDS.TEMP
        playListCalls.push([LIST_IDS.TEMP, 0])
      },
      isQQGuessLikeListActive: account => activeAccountKey == account &&
        playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == 'tx__qq_guess_like',
    },
  })

  const qqGuessLikeSongs = ref([])
  let currentAccountKey = accountKey
  let accountRevision = 0
  let activeAccountKey = null
  const guessPlayback = playbackModule.useQQGuessLikePlayback({
    loadSongs: async() => {
      const songs = await loadQQGuessLikeSongs()
      qqGuessLikeSongs.value = songs
      return songs
    },
    getAccountKey: () => currentAccountKey,
    getAccountRevision: () => accountRevision,
    onLoginRequired: () => { loginRequiredCalls++ },
  })
  const playback = {
    ...guessPlayback,
    handleToggleQQGuessLikeCard: () => guessPlayback.handleCardAction({ id: 'qq_guess_like', source: 'tx' }),
    handleToggleCardPlay: playlist => playlist.isQQGuessLike
      ? guessPlayback.handleCardAction(playlist)
      : routerPush(playlist),
    handleOpenPlaylist: playlist => {
      if (playlist.isQQGuessLike) return guessPlayback.handleCardAction(playlist)
      routerPushes.push(playlist)
      return routerPush(playlist)
    },
    isQQGuessLikePlayingList: () => activeAccountKey == currentAccountKey &&
      playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == 'tx__qq_guess_like',
    resetQQGuessLikePlayback: () => { activeAccountKey = null },
  }

  return {
    playback,
    qqGuessLikeSongs,
    setAccountKey: value => {
      if (currentAccountKey == value) return
      currentAccountKey = value
      accountRevision++
      playback.resetQQGuessLikePlayback()
    },
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

const testObsoleteQQRecommendCards = () => {
  const dailyRecommendSongs = [song('daily')]
  const privateFmQueue = [song('private')]
  const qqSong = { ...song('qq'), meta: { picUrl: 'https://example.com/qq.jpg' } }
  const qqGuessLikeSongs = ref([qqSong])
  const isQQGuessLikeLoading = ref(true)
  const qqGuessLikeLoadError = ref('')
  const showQQGuessLike = ref(true)
  const cardsModule = loadTsModule(path.join(root, 'src/renderer/views/Recommend/useRecommendCards.ts'), {
    '@common/utils/vueTools': { computed: getter => ({ get value() { return getter() } }) },
    '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'wy__wy_daily_recommend', dailyRecommendSongs },
    '@renderer/store/privateFm/state': { privateFmQueue },
    './constants': { PRIVATE_FM_CARD_ID: 'private_fm', PRIVATE_RADAR_PLAYLIST_ID: 'radar', QQ_GUESS_LIKE_CARD_ID: 'qq_guess_like' },
  })

  const { specialCards, getSpecialCardKicker } = cardsModule.useRecommendCards(ref([]), {
    qqGuessLikeSongs,
    isQQGuessLikeLoading,
    qqGuessLikeLoadError,
    showQQGuessLike,
  })
  assert.deepStrictEqual(specialCards.value.map(card => card.id), ['wy__wy_daily_recommend', 'private_fm', 'qq_guess_like'])
  const qqCard = specialCards.value.at(-1)
  assert.strictEqual(qqCard.isQQGuessLike, true)
  assert.strictEqual(getSpecialCardKicker(qqCard), 'QQ Music')
  assert.strictEqual(qqCard.desc, '正在从 QQ 音乐加载猜你喜欢...')
  assert.strictEqual(qqCard.img, qqSong.meta.picUrl)

  isQQGuessLikeLoading.value = false
  qqGuessLikeLoadError.value = '猜你喜欢加载失败，请稍后重试'
  assert.strictEqual(specialCards.value.at(-1).desc, qqGuessLikeLoadError.value)
  showQQGuessLike.value = false
  assert.deepStrictEqual(specialCards.value.map(card => card.id), ['wy__wy_daily_recommend', 'private_fm'])
}

const testQQRecommendCards = () => {
  const qqSong = { ...song('qq'), meta: { picUrl: 'https://example.com/qq.jpg' } }
  const cardsModule = loadTsModule(path.join(root, 'src/renderer/views/QQRecommend/useQQGuessLikeCard.ts'), {
    '@common/utils/vueTools': { computed: getter => ({ get value() { return getter() } }) },
    '@renderer/views/Recommend/constants': { QQ_GUESS_LIKE_CARD_ID: 'qq_guess_like' },
  })
  const songs = ref([qqSong])
  const isLoading = ref(true)
  const loadError = ref('')
  const isLoggedIn = ref(true)
  const { card, getKicker } = cardsModule.useQQGuessLikeCard({ songs, isLoading, loadError, isLoggedIn })
  assert.strictEqual(card.value.id, 'qq_guess_like')
  assert.strictEqual(card.value.isQQGuessLike, true)
  assert.strictEqual(card.value.img, qqSong.meta.picUrl)
  assert.strictEqual(getKicker(), 'QQ Music')

  isLoading.value = false
  loadError.value = 'load failed'
  assert.strictEqual(card.value.desc, 'load failed')
}

const testQQRecommendPlayback = async() => {
  const pendingLoad = deferred()
  const loadedSongs = [song('qq-1'), song('qq-2')]
  let loadCalls = 0
  const qqCard = { id: 'qq_guess_like', source: 'tx', img: '', isQQGuessLike: true }
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      await pendingLoad.promise
      harness.qqGuessLikeSongs.value = loadedSongs
      return loadedSongs
    },
  })

  const firstActivation = harness.playback.handleOpenPlaylist(qqCard)
  const secondActivation = harness.playback.handleToggleCardPlay(qqCard)
  await Promise.resolve()
  assert.strictEqual(loadCalls, 1, 'pending card activations should share one load')
  pendingLoad.resolve()
  await Promise.all([firstActivation, secondActivation])
  await flushAsyncWork()
  assert.strictEqual(harness.setTempListCalls.length, 1)
  assert.deepStrictEqual(harness.setTempListCalls[0], ['tx__qq_guess_like', loadedSongs])
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

  await harness.playback.handleOpenPlaylist(qqCard)
  assert.deepStrictEqual(harness.routerPushes, [], 'opening a QQ card should not navigate to song-list detail')
}

const testQQCardEntryMethodsStartPlayback = async() => {
  const qqCard = { id: 'qq_guess_like', source: 'tx', img: '', isQQGuessLike: true }
  const openHarness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      const songs = [song('open')]
      openHarness.qqGuessLikeSongs.value = songs
      return songs
    },
  })
  await openHarness.playback.handleOpenPlaylist(qqCard)
  await flushAsyncWork()
  assert.strictEqual(openHarness.setTempListCalls.length, 1)
  assert.deepStrictEqual(openHarness.playListCalls, [[openHarness.LIST_IDS.TEMP, 0]])
  assert.deepStrictEqual(openHarness.routerPushes, [])

  const toggleHarness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      const songs = [song('toggle')]
      toggleHarness.qqGuessLikeSongs.value = songs
      return songs
    },
  })
  await toggleHarness.playback.handleToggleCardPlay(qqCard)
  await flushAsyncWork()
  assert.strictEqual(toggleHarness.setTempListCalls.length, 1)
  assert.deepStrictEqual(toggleHarness.playListCalls, [[toggleHarness.LIST_IDS.TEMP, 0]])
  assert.deepStrictEqual(toggleHarness.routerPushes, [])
}

const testNormalPlaylistOpenAwaitsNavigation = async() => {
  const navigation = deferred()
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => [],
    routerPush: async() => navigation.promise,
  })

  const opening = harness.playback.handleOpenPlaylist({ id: 'normal', source: 'wy', img: '' })
  const outcome = await Promise.race([
    opening.then(() => 'settled'),
    flushAsyncWork().then(() => 'pending'),
  ])
  assert.strictEqual(outcome, 'pending', 'normal playlist open should await router navigation')

  navigation.resolve()
  await opening
  assert.strictEqual(harness.routerPushes.length, 1)
}

const testQQCardLoggedOutRequiresLogin = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    accountKey: null,
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      return []
    },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(harness.loginRequiredCalls, 1)
  assert.strictEqual(loadCalls, 0)
  assert.deepStrictEqual(harness.routerPushes, [])
}

const testQQCardEntryMethodsRequireLoginWithoutRouting = async() => {
  const qqCard = { id: 'qq_guess_like', source: 'tx', img: '', isQQGuessLike: true }
  const openHarness = createQQPlaybackHarness({
    accountKey: null,
    loadQQGuessLikeSongs: async() => { throw new Error('QQ loader must not run while logged out') },
  })
  await openHarness.playback.handleOpenPlaylist(qqCard)
  assert.strictEqual(openHarness.loginRequiredCalls, 1)
  assert.deepStrictEqual(openHarness.routerPushes, [])

  const toggleHarness = createQQPlaybackHarness({
    accountKey: null,
    loadQQGuessLikeSongs: async() => { throw new Error('QQ loader must not run while logged out') },
  })
  await toggleHarness.playback.handleToggleCardPlay(qqCard)
  assert.strictEqual(toggleHarness.loginRequiredCalls, 1)
  assert.deepStrictEqual(toggleHarness.routerPushes, [])
}

const testQQCardAccountOwnership = async() => {
  let loadCalls = 0
  const qqCard = { id: 'qq_guess_like', source: 'tx', img: '', isQQGuessLike: true }
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      const songs = [song(`qq-${loadCalls}`)]
      harness.qqGuessLikeSongs.value = songs
      return songs
    },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  harness.playInfo.playerListId = harness.LIST_IDS.TEMP
  harness.tempListMeta.id = 'tx__qq_guess_like'
  harness.isPlay.value = true
  harness.setAccountKey('B')
  assert.strictEqual(harness.playback.isQQGuessLikePlayingList(), false)
  assert.strictEqual(harness.playback.isCardPlaying(qqCard), false)
  harness.qqGuessLikeSongs.value = []
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2, 'account B must load its own QQ queue')
  assert.strictEqual(harness.setTempListCalls.length, 2)
  assert.strictEqual(harness.pauseCalls, 0, 'account B must not pause account A queue')
  assert.strictEqual(harness.playCalls, 0, 'account B must not resume account A queue')
}

const testQQCardPausedAccountOwnership = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      const songs = [song(`qq-${loadCalls}`)]
      harness.qqGuessLikeSongs.value = songs
      return songs
    },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  harness.playInfo.playerListId = harness.LIST_IDS.TEMP
  harness.tempListMeta.id = 'tx__qq_guess_like'
  harness.isPlay.value = false
  harness.setAccountKey('B')
  assert.strictEqual(harness.playback.isQQGuessLikePlayingList(), false)
  harness.qqGuessLikeSongs.value = []
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2, 'account B must load instead of resuming paused account A')
  assert.strictEqual(harness.setTempListCalls.length, 2)
  assert.deepStrictEqual(harness.playListCalls.at(-1), [harness.LIST_IDS.TEMP, 0])
  assert.strictEqual(harness.playCalls, 0, 'account B must not resume paused account A queue')
}

const testQQCardAccountRoundTripInvalidatesInstalledQueue = async() => {
  let loadCalls = 0
  const qqCard = { id: 'qq_guess_like', source: 'tx', img: '', isQQGuessLike: true }
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => [song(`round-trip-${++loadCalls}`)],
  })

  await harness.playback.handleToggleQQGuessLikeCard()
  harness.playInfo.playerListId = harness.LIST_IDS.TEMP
  harness.tempListMeta.id = 'tx__qq_guess_like'
  harness.isPlay.value = true
  harness.setAccountKey('B')
  harness.setAccountKey('A')

  assert.strictEqual(harness.playback.isQQGuessLikePlayingList(), false)
  assert.strictEqual(harness.playback.isCardPlaying(qqCard), false)
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2, 'returning to A must activate a new queue generation')
  assert.deepStrictEqual(harness.setTempListCalls.at(-1), ['tx__qq_guess_like', [song('round-trip-2')]])
  assert.strictEqual(harness.pauseCalls, 0)
  assert.strictEqual(harness.playCalls, 0)
}

const testQQCardAccountRoundTripInvalidatesPausedQueue = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => [song(`paused-round-trip-${++loadCalls}`)],
  })

  await harness.playback.handleToggleQQGuessLikeCard()
  harness.playInfo.playerListId = harness.LIST_IDS.TEMP
  harness.tempListMeta.id = 'tx__qq_guess_like'
  harness.isPlay.value = false
  harness.setAccountKey('B')
  harness.setAccountKey('A')

  assert.strictEqual(harness.playback.isQQGuessLikePlayingList(), false)
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2, 'returning to A must not resume its paused old generation')
  assert.deepStrictEqual(harness.setTempListCalls.at(-1), ['tx__qq_guess_like', [song('paused-round-trip-2')]])
  assert.strictEqual(harness.playCalls, 0)
}

const testQQPendingActivationCannotSurviveAccountRoundTrip = async() => {
  const oldLoad = deferred()
  const newLoad = deferred()
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      return loadCalls == 1 ? oldLoad.promise : newLoad.promise
    },
  })

  const oldActivation = harness.playback.handleToggleQQGuessLikeCard()
  await Promise.resolve()
  harness.setAccountKey('B')
  harness.setAccountKey('A')
  const newActivation = harness.playback.handleToggleQQGuessLikeCard()
  await Promise.resolve()
  assert.strictEqual(loadCalls, 2)

  oldLoad.resolve([song('old-A')])
  await oldActivation
  assert.deepStrictEqual(harness.setTempListCalls, [], 'old A generation must not install after A-B-A')
  assert.deepStrictEqual(harness.playListCalls, [])
  const duplicateNewActivation = harness.playback.handleToggleQQGuessLikeCard()
  await Promise.resolve()
  assert.strictEqual(loadCalls, 2, 'old A cleanup must not detach or duplicate the new A activation')

  newLoad.resolve([song('new-A')])
  await Promise.all([newActivation, duplicateNewActivation])
  assert.deepStrictEqual(harness.setTempListCalls, [['tx__qq_guess_like', [song('new-A')]]])
  assert.deepStrictEqual(harness.playListCalls, [[harness.LIST_IDS.TEMP, 0]])
}

const testQQActivationUsesAccountScopedSnapshot = async() => {
  const staleSongs = [song('stale-A')]
  const currentSongs = [song('current-B')]
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    accountKey: 'B',
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      return currentSongs
    },
  })
  harness.qqGuessLikeSongs.value = staleSongs

  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 1, 'B activation must load its account-scoped snapshot')
  assert.deepStrictEqual(harness.setTempListCalls, [['tx__qq_guess_like', currentSongs]])
  assert.notDeepStrictEqual(harness.setTempListCalls[0][1], staleSongs)
}

const testQQCardEmptyLoadsAreRetryable = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      return []
    },
  })
  await harness.playback.handleToggleQQGuessLikeCard()
  await harness.playback.handleToggleQQGuessLikeCard()
  assert.strictEqual(loadCalls, 2)
  assert.deepStrictEqual(harness.setTempListCalls, [])
  assert.deepStrictEqual(harness.playListCalls, [])
}

const testQQCardRejectedLoadsAreRetryable = async() => {
  let loadCalls = 0
  const harness = createQQPlaybackHarness({
    loadQQGuessLikeSongs: async() => {
      loadCalls++
      throw new Error('QQ loader rejected')
    },
  })
  await assert.rejects(harness.playback.handleToggleQQGuessLikeCard(), /QQ loader rejected/)
  await assert.rejects(harness.playback.handleToggleQQGuessLikeCard(), /QQ loader rejected/)
  assert.strictEqual(loadCalls, 2)
  assert.deepStrictEqual(harness.setTempListCalls, [])
  assert.deepStrictEqual(harness.playListCalls, [])
}

const loadGuessLikeModule = ({ isLoggedIn, profile, getSongs, initAccount = async() => {} }) => {
  const queue = []
  const isLoading = ref(false)
  const cache = new Map()
  let ownerAccountKey = null
  return loadTsModule(path.join(root, 'src/renderer/views/Recommend/useQQGuessLikeData.ts'), {
    '@common/utils/vueTools': {
      ref,
      computed: getter => ({ get value() { return getter() } }),
    },
    '@renderer/store/qqMusic': {
      getQQMusicAccountKey: () => isLoggedIn.value ? profile.value?.uin ?? null : null,
      initQQMusicAccount: initAccount,
    },
    '@renderer/store/qqGuessLike/action': {
      prepareQQGuessLikeQueue: async(accountKey, force = false) => {
        if (ownerAccountKey != accountKey) {
          ownerAccountKey = accountKey
          queue.splice(0, queue.length)
        }
        if (!force && cache.has(accountKey)) {
          queue.splice(0, queue.length, ...cache.get(accountKey))
          return queue
        }
        isLoading.value = true
        try {
          const songs = await getSongs()
          cache.set(accountKey, songs)
          if (ownerAccountKey == accountKey) queue.splice(0, queue.length, ...songs)
          return songs
        } finally {
          if (ownerAccountKey == accountKey) isLoading.value = false
        }
      },
      resetQQGuessLikeQueue: () => {
        ownerAccountKey = null
        queue.splice(0, queue.length)
        cache.clear()
        isLoading.value = false
      },
    },
    '@renderer/store/qqGuessLike/state': {
      isLoadingQQGuessLike: isLoading,
      qqGuessLikeQueue: queue,
    },
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

  const initialSnapshot = await state.load()
  state.loadError.value = 'old error'
  isLoggedIn.value = false
  profile.value = null
  const loggedOutSnapshot = await state.load()

  assert.deepStrictEqual(initialSnapshot, [song('A-1')])
  assert.deepStrictEqual(loggedOutSnapshot, [])
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

  const firstA = await state.load()
  assert.deepStrictEqual(state.songs.value, [song('A-1')])
  const cachedA = await state.load()
  assert.deepStrictEqual(firstA, [song('A-1')])
  assert.deepStrictEqual(cachedA, [song('A-1')])
  assert.strictEqual(requestCount, 1)

  profile.value = { uin: 'B' }
  const loadingB = state.load()
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.isLoading.value, true)
  const loadedB = await loadingB
  assert.deepStrictEqual(loadedB, [song('B-1')])
  assert.deepStrictEqual(state.songs.value, [song('B-1')])

  profile.value = { uin: 'A' }
  const returnedA = await state.load()
  assert.deepStrictEqual(returnedA, [song('A-1')])
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
  assert.deepStrictEqual(await firstState.load(), [song('shared')])
  assert.strictEqual(requestCount, 1)

  const secondState = guessLikeModule.useQQGuessLikeData()
  assert.deepStrictEqual(await secondState.load(), [song('shared')])
  assert.strictEqual(requestCount, 1)
  assert.deepStrictEqual(secondState.songs.value, [song('shared')])

  firstState.clear()
  const stateAfterClear = guessLikeModule.useQQGuessLikeData()
  assert.deepStrictEqual(await stateAfterClear.load(), [song('after-clear')])
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

  assert.deepStrictEqual(await state.load(), [song('old')])
  assert.deepStrictEqual(await state.load(true), [])
  assert.deepStrictEqual(state.songs.value, [song('old')])
  assert.strictEqual(state.loadError.value, '猜你喜欢加载失败，请稍后重试')
  assert.doesNotMatch(state.loadError.value, /https|cookie|secret/)
  assert.deepStrictEqual(initCalls, [true])

  assert.deepStrictEqual(await state.load(true), [])
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.loadError.value, '')
  assert.deepStrictEqual(await state.load(), [])
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
  assert.deepStrictEqual(await loadingA, [])
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.isLoading.value, true)

  requestB.resolve([song('B-current')])
  assert.deepStrictEqual(await loadingB, [song('B-current')])
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
  assert.deepStrictEqual(await loadingA, [])
  assert.strictEqual(initCount, 0)
  assert.strictEqual(state.loadError.value, '')
  assert.strictEqual(state.isLoading.value, true)

  requestB.resolve([song('B-current')])
  assert.deepStrictEqual(await loadingB, [song('B-current')])
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

  assert.deepStrictEqual(await state.load(true), [])
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
  assert.deepStrictEqual(await newer, [song('newer')])
  oldRequest.resolve([song('older')])
  assert.deepStrictEqual(await older, [])
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

  assert.deepStrictEqual(await state.load(), [song('cached')])
  const refreshing = state.load(true)
  isLoggedIn.value = false
  profile.value = null
  state.clear()
  assert.deepStrictEqual(state.songs.value, [])
  assert.strictEqual(state.isRefreshing.value, false)

  pending.resolve([song('stale')])
  assert.deepStrictEqual(await refreshing, [])
  assert.deepStrictEqual(state.songs.value, [])

  isLoggedIn.value = true
  profile.value = { uin: 'clear-account' }
  assert.deepStrictEqual(await state.load(), [song('fresh')])
  assert.strictEqual(requestCount, 3)
  assert.deepStrictEqual(state.songs.value, [song('fresh')])
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
  assert.doesNotMatch(qqPage, /resetPlayback/)

  assert.match(qqData, /prepareQQGuessLikeQueue/)
  assert.match(qqData, /qqGuessLikeQueue/)
  assert.match(qqPlayback, /enterQQGuessLikeMode/)
  assert.match(qqPlayback, /isQQGuessLikeListActive/)
  assert.match(qqAccount, /resetQQGuessLikeQueue/)
}

const main = async() => {
  await testLatestLoadCoordinator()
  testQQRecommendCards()
  await testQQRecommendPlayback()
  await testQQCardEntryMethodsStartPlayback()
  await testQQCardLoggedOutRequiresLogin()
  await testQQCardEntryMethodsRequireLoginWithoutRouting()
  await testQQCardAccountOwnership()
  await testQQCardPausedAccountOwnership()
  await testQQCardAccountRoundTripInvalidatesInstalledQueue()
  await testQQCardAccountRoundTripInvalidatesPausedQueue()
  await testQQPendingActivationCannotSurviveAccountRoundTrip()
  await testQQActivationUsesAccountScopedSnapshot()
  await testQQCardEmptyLoadsAreRetryable()
  await testQQCardRejectedLoadsAreRetryable()
  await testLoggedOutClearsWithoutRequest()
  await testAccountScopedCache()
  await testForceFailureAndEmptyCache()
  await testAccountRaceAndLoadingOwnership()
  await testStaleFailureDoesNotRefreshCurrentAccount()
  testDedicatedQQRecommendationWiring()
  console.log('QQ Music account menu and recommendation state tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
