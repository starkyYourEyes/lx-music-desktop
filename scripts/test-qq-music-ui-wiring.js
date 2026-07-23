const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

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
  const qqGuessLikeSetting = settingRecommend.match(/dt#recommend[^\n]*\n([\s\S]*?)(?=dd\n\s+h3#recommend_home_section_order)/)?.[1] || ''
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
  assert.match(qqGuessLikeSection, /loadError/)
  assert.match(qqGuessLikeSection, /暂无猜你喜欢歌曲/)
}

const loadGuessLikeData = ({ isLoggedIn, profile, getSongs, initAccount = async() => {} }) => {
  return loadTsModule(path.join(root, 'src/renderer/views/Recommend/useQQGuessLikeData.ts'), {
    '@common/utils/vueTools': { ref },
    '@renderer/store/qqMusic': {
      isLoggedIn,
      profile,
      initQQMusicAccount: initAccount,
    },
    '@renderer/utils/ipc': { getQQMusicGuessLikeSongs: getSongs },
  }).useQQGuessLikeData()
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
  await testLoggedOutClearsWithoutRequest()
  await testAccountScopedCache()
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
