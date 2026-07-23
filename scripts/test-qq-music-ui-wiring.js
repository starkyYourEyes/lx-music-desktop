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

const testStaticWiring = () => {
  const aside = fs.readFileSync(path.join(root, 'src/renderer/components/layout/Aside/index.vue'), 'utf8')
  const defaultSetting = fs.readFileSync(path.join(root, 'src/common/defaultSetting.ts'), 'utf8')
  const appSettingType = fs.readFileSync(path.join(root, 'src/common/types/app_setting.d.ts'), 'utf8')
  const settingRecommend = fs.readFileSync(path.join(root, 'src/renderer/views/Setting/components/SettingRecommend.vue'), 'utf8')
  const qqGuessLikeSection = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/components/QQGuessLikeSection.vue'), 'utf8')
  const recommendIndex = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/index.vue'), 'utf8')
  const recommendConstants = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/constants.ts'), 'utf8')
  const recommendPlayback = fs.readFileSync(path.join(root, 'src/renderer/views/Recommend/useRecommendPlayback.ts'), 'utf8')

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
  assert.match(recommendConstants, /QQ_GUESS_LIKE_TEMP_LIST_ID\s*=\s*'tx__qq_guess_like'/)
  assert.match(recommendPlayback, /qqGuessLikeSongs:/)
  for (const method of [
    'isQQGuessLikePlayingList',
    'isQQGuessLikePlaying',
    'isQQGuessLikeSongPlaying',
    'handleToggleQQGuessLikeSongs',
    'handlePlayQQGuessLikeSongs',
  ]) {
    assert.match(recommendPlayback, new RegExp(`\\b${method}\\b`), `Playback should expose ${method}`)
  }

  assert.match(
    recommendIndex,
    /import\s*{[^}]*initNeteaseAccount[^}]*isLoggedIn\s+as\s+neteaseIsLoggedIn[^}]*profile\s+as\s+neteaseProfile[^}]*}\s*from\s*'@renderer\/store\/netease'/s,
  )
  assert.match(
    recommendIndex,
    /import\s*{[^}]*initQQMusicAccount[^}]*isLoggedIn\s+as\s+qqIsLoggedIn[^}]*profile\s+as\s+qqProfile[^}]*}\s*from\s*'@renderer\/store\/qqMusic'/s,
  )
  assert.match(recommendIndex, /import QQGuessLikeSection from '.\/components\/QQGuessLikeSection\.vue'/)
  assert.match(recommendIndex, /import { useQQGuessLikeData } from '.\/useQQGuessLikeData'/)
  assert.match(recommendIndex, /import { useQQMusicLoginQr } from '.\/useQQMusicLoginQr'/)

  const specialCardsPosition = recommendIndex.indexOf('<SpecialCards')
  const qqSectionPosition = recommendIndex.indexOf('<QQGuessLikeSection')
  const neteaseLoopPosition = recommendIndex.indexOf('<template v-for="section in homeSectionOrder"')
  assert.ok(specialCardsPosition >= 0 && qqSectionPosition > specialCardsPosition)
  assert.ok(neteaseLoopPosition > qqSectionPosition, 'QQ recommendations should render before the NetEase home section loop')

  const qqSection = recommendIndex.slice(qqSectionPosition, neteaseLoopPosition)
  assert.match(qqSection, /:visible-when-logged-out="appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\]"/)
  assert.match(qqSection, /:is-logged-in="qqIsLoggedIn"/)
  assert.match(qqSection, /:songs="qqGuessLikeSongs"/)
  assert.match(qqSection, /@login="handleShowQQLogin"/)
  assert.match(qqSection, /@(retry|refresh)="handleRefreshQQGuessLike"/)
  assert.match(qqSection, /@play-all="handleToggleQQGuessLikeSongs"/)
  assert.match(qqSection, /@play="handlePlayQQGuessLikeSongs"/)
  assert.match(qqSection, /@toggle-love="handleToggleHomeSongLove"/)
  assert.match(recommendIndex, /recommendSongsForLove\s*=\s*computed\(\(\)\s*=>\s*\[[\s\S]*?\.\.\.qqGuessLikeSongs\.value/)

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
  assert.match(recommendIndex, /void initializeQQAccount\(\)[\s\S]*?void initializeNeteaseAccount\(\)/)
  assert.match(recommendIndex, /isHandlingQQQrLoginSuccess/)
  assert.match(recommendIndex, /handleCloseQQLogin\(\)[\s\S]*?loadQQGuessLikeSongs\(true\)/)
  const qqAccountWatch = recommendIndex.match(/watch\(qqAccountKey,[\s\S]*?\n}\)/)?.[0] || ''
  const neteaseAccountWatch = recommendIndex.match(/watch\(neteaseIsLoggedIn,[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(qqAccountWatch, /if\s*\(!value\)[\s\S]*?clearQQGuessLikeSongs\(\)[\s\S]*?loadQQGuessLikeSongs\(true\)/)
  assert.match(qqAccountWatch, /handleCloseQQLogin\(\)/)
  assert.match(neteaseAccountWatch, /if\s*\(value\)\s*handleCloseNeteaseLogin\(\)/)

  assert.match(recommendIndex, /let qqLifecycleRevision\s*=\s*0/)
  assert.match(recommendIndex, /let neteaseLifecycleRevision\s*=\s*0/)
  assert.match(recommendIndex, /let forceQQLoadAfterInitialization\s*=\s*false/)
  assert.match(recommendIndex, /let forceNeteaseLoadAfterInitialization\s*=\s*false/)

  const qqQrSuccess = recommendIndex.match(/useQQMusicLoginQr\(async\(\)\s*=>\s*\{[\s\S]*?\n}\)/)?.[0] || ''
  const neteaseQrSuccess = recommendIndex.match(/useNeteaseLoginQr\(async\(\)\s*=>\s*\{[\s\S]*?\n}\)/)?.[0] || ''
  assert.match(qqQrSuccess, /isHandlingQQQrLoginSuccess\s*=\s*true[\s\S]*?qqLifecycleRevision\+\+[\s\S]*?forceQQLoadAfterInitialization\s*=\s*false[\s\S]*?loadQQGuessLikeSongs\(true\)/)
  assert.match(neteaseQrSuccess, /isHandlingNeteaseQrLoginSuccess\s*=\s*true[\s\S]*?neteaseLifecycleRevision\+\+[\s\S]*?forceNeteaseLoadAfterInitialization\s*=\s*false[\s\S]*?loadRecommendPlaylists\(true\)/)

  assert.match(qqAccountWatch, /qqLifecycleRevision\+\+[\s\S]*?forceQQLoadAfterInitialization\s*=\s*false[\s\S]*?clearQQGuessLikeSongs\(\)/)
  assert.match(qqAccountWatch, /if\s*\(isHandlingQQQrLoginSuccess\)\s*return/)
  assert.match(qqAccountWatch, /if\s*\(isInitializingQQAccount\)\s*\{[\s\S]*?forceQQLoadAfterInitialization\s*=\s*true[\s\S]*?return/)
  assert.match(qqAccountWatch, /qqLifecycleRevision\+\+[\s\S]*?loadQQGuessLikeSongs\(true\)/)
  assert.match(neteaseAccountWatch, /if\s*\(isHandlingNeteaseQrLoginSuccess\)\s*return/)
  assert.match(neteaseAccountWatch, /if\s*\(isInitializingNeteaseAccount\)\s*\{[\s\S]*?forceNeteaseLoadAfterInitialization\s*=\s*true[\s\S]*?return/)
  assert.match(neteaseAccountWatch, /neteaseLifecycleRevision\+\+[\s\S]*?loadRecommendPlaylists\(true\)/)

  const initializeQQ = recommendIndex.match(/const initializeQQAccount\s*=\s*async\(\)\s*=>\s*\{[\s\S]*?\n}/)?.[0] || ''
  const initializeNetease = recommendIndex.match(/const initializeNeteaseAccount\s*=\s*async\(\)\s*=>\s*\{[\s\S]*?\n}/)?.[0] || ''
  assert.match(initializeQQ, /const revision\s*=\s*qqLifecycleRevision[\s\S]*?await initQQMusicAccount\(\)[\s\S]*?await nextTick\(\)[\s\S]*?if\s*\(revision\s*!=\s*qqLifecycleRevision\)\s*return/)
  assert.match(initializeQQ, /force\s*=\s*forceQQLoadAfterInitialization[\s\S]*?forceQQLoadAfterInitialization\s*=\s*false[\s\S]*?loadQQGuessLikeSongs\(force\)/)
  assert.match(initializeQQ, /forceQQLoadAfterInitialization\s*=\s*false[\s\S]*?isInitializingQQAccount\s*=\s*false[\s\S]*?loadQQGuessLikeSongs\(force\)/)
  assert.match(initializeNetease, /const revision\s*=\s*neteaseLifecycleRevision[\s\S]*?await initNeteaseAccount\(\)[\s\S]*?await nextTick\(\)[\s\S]*?if\s*\(revision\s*!=\s*neteaseLifecycleRevision\)\s*return/)
  assert.match(initializeNetease, /force\s*=\s*forceNeteaseLoadAfterInitialization[\s\S]*?forceNeteaseLoadAfterInitialization\s*=\s*false[\s\S]*?loadRecommendPlaylists\(force\)/)
  assert.match(initializeNetease, /forceNeteaseLoadAfterInitialization\s*=\s*false[\s\S]*?isInitializingNeteaseAccount\s*=\s*false[\s\S]*?loadRecommendPlaylists\(force\)/)
  assert.match(
    recommendIndex,
    /if\s*\(!isExploreMode\.value\s*&&\s*\([\s\S]*?qqIsLoggedIn\.value[\s\S]*?appSetting\['recommend\.qqGuessLikeLoggedOutVisible'\][\s\S]*?\)\)\s*return ''/,
  )
  assert.match(qqGuessLikeSection, /loadError/)
  assert.match(qqGuessLikeSection, /暂无猜你喜欢歌曲/)
}

const testQQRecommendPlayback = async() => {
  const constants = loadTsModule(path.join(root, 'src/renderer/views/Recommend/constants.ts'))
  assert.strictEqual(constants.QQ_GUESS_LIKE_TEMP_LIST_ID, 'tx__qq_guess_like')

  const isPlay = ref(false)
  const playInfo = { playerListId: null }
  const playMusicInfo = { musicInfo: null }
  const tempListMeta = { id: '' }
  const setTempListCalls = []
  const playListCalls = []
  let pauseCalls = 0
  let playCalls = 0
  const LIST_IDS = { TEMP: 'temp' }

  const playbackModule = loadTsModule(path.join(root, 'src/renderer/views/Recommend/useRecommendPlayback.ts'), {
    '@common/constants': { LIST_IDS },
    '@common/utils/vueRouter': {
      useRoute: () => ({ name: 'recommend' }),
      useRouter: () => ({ push: async() => {} }),
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

  const qqGuessLikeSongs = ref([song('qq-1'), song('qq-2'), song('qq-3')])
  const playback = playbackModule.useRecommendPlayback({
    homeStyleSongs: ref([]),
    homeSimilarSongs: ref([]),
    qqGuessLikeSongs,
    setError: () => {},
  })

  await playback.handleToggleQQGuessLikeSongs()
  assert.deepStrictEqual(setTempListCalls.at(-1), ['tx__qq_guess_like', qqGuessLikeSongs.value])
  assert.deepStrictEqual(playListCalls.at(-1), [LIST_IDS.TEMP, 0])

  playInfo.playerListId = LIST_IDS.TEMP
  tempListMeta.id = 'tx__qq_guess_like'
  isPlay.value = true
  await playback.handleToggleQQGuessLikeSongs()
  assert.strictEqual(pauseCalls, 1)
  isPlay.value = false
  await playback.handleToggleQQGuessLikeSongs()
  assert.strictEqual(playCalls, 1)

  tempListMeta.id = 'another-list'
  await playback.handlePlayQQGuessLikeSongs(1)
  assert.deepStrictEqual(playListCalls.at(-1), [LIST_IDS.TEMP, 1])
  await playback.handlePlayQQGuessLikeSongs(99)
  assert.deepStrictEqual(playListCalls.at(-1), [LIST_IDS.TEMP, 2])
  await playback.handlePlayQQGuessLikeSongs(-1)
  assert.deepStrictEqual(playListCalls.at(-1), [LIST_IDS.TEMP, 0])

  tempListMeta.id = 'tx__qq_guess_like'
  playMusicInfo.musicInfo = qqGuessLikeSongs.value[1]
  assert.strictEqual(playback.isQQGuessLikePlayingList(), true)
  assert.strictEqual(playback.isQQGuessLikePlaying(), false)
  isPlay.value = true
  assert.strictEqual(playback.isQQGuessLikePlaying(), true)
  assert.strictEqual(playback.isQQGuessLikeSongPlaying(qqGuessLikeSongs.value[1]), true)
  assert.strictEqual(playback.isQQGuessLikeSongPlaying(qqGuessLikeSongs.value[0]), false)
  tempListMeta.id = 'another-list'
  assert.strictEqual(playback.isQQGuessLikeSongPlaying(qqGuessLikeSongs.value[1]), false)
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
  testStaticWiring()
  await testQQRecommendPlayback()
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
