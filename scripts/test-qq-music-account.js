const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const { getQQMusicAccountUin } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)

const data = new Map([['neteaseAccount', { cookie: 'keep-netease' }]])
const store = {
  get: key => data.get(key),
  set: (key, value) => data.set(key, value),
}
let loginResult = {
  state: 'success',
  message: '登录成功',
  cookie: 'uin=o123; qqmusic_key=secret',
}
let songError = null
let pendingSongPromise = null
let pendingLoginPromise = null
let singletonGetCookie
let singletonGetDailyRecommendCookie
let singletonGetHomeRecommendCookie
let singletonGetPlaylistDetailCookie
let storeFactoryCallCount = 0
class QQMusicAuthError extends Error {}
const loginService = {
  createLoginQr: async() => ({ key: 'opaque', qrimg: 'data:image/png;base64,AA==' }),
  checkLoginQr: async() => pendingLoginPromise ?? loginResult,
}
const songService = {
  getGuessLikeSongs: async() => {
    if (pendingSongPromise) return pendingSongPromise
    if (songError) throw songError
    return [{ id: 'tx_mid' }]
  },
}
let dailyRecommendError = null
const dailyRecommendSongs = [{ id: 'tx_daily_mid' }]
const dailyRecommendService = {
  getDailyRecommendSongs: async() => {
    if (dailyRecommendError) throw dailyRecommendError
    return dailyRecommendSongs
  },
}
let homeRecommendError = null
const homeRecommendation = {
  title: 'Hi Alice 今日为你推荐',
  featuredPlaylists: [],
  privatePlaylists: [],
  relatedSongTitle: '',
  relatedSongGroups: [],
  guidePlaylists: [],
}
const homeRecommendService = {
  getHomeRecommendation: async() => {
    if (homeRecommendError) throw homeRecommendError
    return homeRecommendation
  },
}
let playlistDetailError = null
const playlistDetail = {
  id: '211111',
  source: 'tx',
  list: [{ id: 'tx_playlist_mid' }],
}
const playlistDetailService = {
  getPlaylistDetail: async(id, page) => {
    if (playlistDetailError) throw playlistDetailError
    return { ...playlistDetail, id, page }
  },
}

const {
  createQQMusicAccountService,
  getAccountStatus: getSingletonAccountStatus,
  createLoginQr: createSingletonLoginQr,
} = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/index.ts'),
  {
    '@common/constants': {
      DATA_KEYS: { qqMusicAccount: 'qqMusicAccount' },
      STORE_NAMES: { DATA: 'data' },
    },
    '@main/utils/store': () => {
      storeFactoryCallCount++
      return store
    },
    './login': {
      createQQMusicLoginService: () => loginService,
    },
    './auth': { getQQMusicAccountUin },
    './song': {
      createQQMusicSongService: options => {
        singletonGetCookie = options.getCookie
        return songService
      },
      isQQMusicAuthError: error => error instanceof QQMusicAuthError,
    },
    './dailyRecommend': {
      createQQMusicDailyRecommendService: options => {
        singletonGetDailyRecommendCookie = options.getCookie
        return dailyRecommendService
      },
    },
    './homeRecommend': {
      createQQMusicHomeRecommendService: options => {
        singletonGetHomeRecommendCookie = options.getCookie
        return homeRecommendService
      },
    },
    './playlistDetail': {
      createQQMusicPlaylistDetailService: options => {
        singletonGetPlaylistDetailCookie = options.getCookie
        return playlistDetailService
      },
    },
  },
)
assert.strictEqual(storeFactoryCallCount, 0)

const createFacade = () => createQQMusicAccountService({
  store,
  loginService,
  songService,
  dailyRecommendService,
  homeRecommendService,
  playlistDetailService,
  now: () => 123456,
})

const main = async() => {
  getSingletonAccountStatus()
  assert.strictEqual(storeFactoryCallCount, 1)
  assert.strictEqual(singletonGetDailyRecommendCookie, singletonGetCookie)
  assert.strictEqual(singletonGetHomeRecommendCookie, singletonGetCookie)
  assert.strictEqual(singletonGetPlaylistDetailCookie, singletonGetCookie)
  await createSingletonLoginQr()
  assert.strictEqual(storeFactoryCallCount, 1)

  const service = createFacade()
  assert.deepStrictEqual(service.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(await service.createLoginQr(), {
    key: 'opaque',
    qrimg: 'data:image/png;base64,AA==',
  })

  const result = await service.checkLoginQr('opaque')
  assert.deepStrictEqual(result, {
    state: 'success',
    message: '登录成功',
    isLoggedIn: true,
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
  })
  assert.strictEqual(Object.hasOwn(result, 'cookie'), false)
  assert.deepStrictEqual(data.get('qqMusicAccount'), {
    cookie: 'uin=o123; qqmusic_key=secret',
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
    updatedAt: 123456,
  })

  const restarted = createFacade()
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: true,
    profile: { uin: 'o123', nickname: 'QQ 音乐账号' },
  })
  assert.deepStrictEqual(await restarted.getGuessLikeSongs(), [{ id: 'tx_mid' }])
  assert.deepStrictEqual(await restarted.getDailyRecommendSongs(), dailyRecommendSongs)
  assert.deepStrictEqual(await restarted.getHomeRecommendation(), homeRecommendation)
  assert.deepStrictEqual(await restarted.getPlaylistDetail('211111', 1), {
    ...playlistDetail,
    id: '211111',
    page: 1,
  })

  homeRecommendError = new Error('home recommendation unavailable')
  await assert.rejects(restarted.getHomeRecommendation(), /home recommendation unavailable/)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  homeRecommendError = null

  playlistDetailError = new Error('playlist detail unavailable')
  await assert.rejects(restarted.getPlaylistDetail('211111', 1), /playlist detail unavailable/)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  playlistDetailError = null

  dailyRecommendError = new Error('daily recommendation unavailable')
  await assert.rejects(restarted.getDailyRecommendSongs(), /daily recommendation unavailable/)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  dailyRecommendError = null

  songError = new Error('network unavailable')
  await assert.rejects(restarted.getGuessLikeSongs(), /network unavailable/)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  songError = new QQMusicAuthError('expired')
  await assert.rejects(restarted.getGuessLikeSongs(), QQMusicAuthError)
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  songError = null
  loginResult = {
    state: 'success',
    message: '登录成功',
    cookie: 'qqmusic_uin=456; qqmusic_key=new-secret',
  }
  await restarted.checkLoginQr('new-opaque')
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  await restarted.logout()
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  await restarted.createLoginQr()
  let resolveStaleLogin
  pendingLoginPromise = new Promise(resolve => {
    resolveStaleLogin = resolve
  })
  const staleLoginCheck = restarted.checkLoginQr('opaque')
  await restarted.logout()
  resolveStaleLogin({
    state: 'success',
    message: '登录成功',
    cookie: 'uin=oStale; qqmusic_key=stale-secret',
  })
  assert.deepStrictEqual(await staleLoginCheck, {
    state: 'expired',
    message: '二维码已过期',
    isLoggedIn: false,
    profile: null,
  })
  pendingLoginPromise = null
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })

  await restarted.createLoginQr()
  let resolveAccountALogin
  pendingLoginPromise = new Promise(resolve => {
    resolveAccountALogin = resolve
  })
  const accountALoginCheck = restarted.checkLoginQr('opaque')
  await restarted.createLoginQr()
  pendingLoginPromise = null
  loginResult = {
    state: 'success',
    message: '登录成功',
    cookie: 'uin=oB; qqmusic_key=account-b',
  }
  await restarted.checkLoginQr('opaque')
  resolveAccountALogin({
    state: 'success',
    message: '登录成功',
    cookie: 'uin=oA; qqmusic_key=account-a',
  })
  assert.deepStrictEqual(await accountALoginCheck, {
    state: 'expired',
    message: '二维码已过期',
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: true,
    profile: { uin: 'oB', nickname: 'QQ 音乐账号' },
  })
  await restarted.logout()

  loginResult = {
    state: 'success',
    message: '登录成功',
    cookie: 'qqmusic_key=key-without-uin',
  }
  await assert.rejects(restarted.checkLoginQr('missing-uin'), error => {
    assert.strictEqual(error.message, 'QQ Music login check failed')
    assert.strictEqual(Object.hasOwn(error, 'cookie'), false)
    assert.strictEqual(String(error).includes('key-without-uin'), false)
    return true
  })
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.strictEqual(data.get('qqMusicAccount').cookie, '')

  data.set('qqMusicAccount', {
    cookie: 'qqmusic_key=stored-key-without-uin',
    profile: { uin: 'o999', nickname: 'QQ 音乐账号' },
    updatedAt: 200,
  })
  assert.deepStrictEqual(createFacade().getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.strictEqual(singletonGetCookie(), '')
  assert.strictEqual(singletonGetDailyRecommendCookie(), '')
  assert.strictEqual(singletonGetHomeRecommendCookie(), '')
  assert.strictEqual(singletonGetPlaylistDetailCookie(), '')

  data.set('qqMusicAccount', {
    cookie: 'uin=o123; qqmusic_key=stored-mismatch',
    profile: { uin: 'o456', nickname: 'QQ 音乐账号' },
    updatedAt: 201,
  })
  assert.deepStrictEqual(createFacade().getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.strictEqual(singletonGetCookie(), '')
  assert.strictEqual(singletonGetDailyRecommendCookie(), '')
  assert.strictEqual(singletonGetHomeRecommendCookie(), '')
  assert.strictEqual(singletonGetPlaylistDetailCookie(), '')
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  data.set('qqMusicAccount', {
    cookie: 'uin=oA; qqmusic_key=account-a',
    profile: { uin: 'oA', nickname: 'QQ 音乐账号' },
    updatedAt: 301,
  })
  let rejectAccountA
  pendingSongPromise = new Promise((resolve, reject) => {
    rejectAccountA = reject
  })
  const raceFacade = createFacade()
  const accountARequest = raceFacade.getGuessLikeSongs()
  const accountB = {
    cookie: 'uin=oB; qqmusic_key=account-b',
    profile: { uin: 'oB', nickname: 'QQ 音乐账号' },
    updatedAt: 302,
  }
  data.set('qqMusicAccount', accountB)
  rejectAccountA(new QQMusicAuthError('account A expired'))
  await assert.rejects(accountARequest, QQMusicAuthError)
  pendingSongPromise = null
  assert.deepStrictEqual(raceFacade.getAccountStatus(), {
    isLoggedIn: true,
    profile: accountB.profile,
  })
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)

  data.set('qqMusicAccount', accountB)
  dailyRecommendError = new QQMusicAuthError('expired')
  await assert.rejects(raceFacade.getDailyRecommendSongs(), QQMusicAuthError)
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, false)
  dailyRecommendError = null

  data.set('qqMusicAccount', accountB)
  homeRecommendError = new QQMusicAuthError('expired')
  await assert.rejects(raceFacade.getHomeRecommendation(), QQMusicAuthError)
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, false)
  homeRecommendError = null

  data.set('qqMusicAccount', accountB)
  playlistDetailError = new QQMusicAuthError('expired')
  await assert.rejects(raceFacade.getPlaylistDetail('211111', 1), QQMusicAuthError)
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, false)
  playlistDetailError = null
}

main().then(() => {
  console.log('QQ Music account tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
