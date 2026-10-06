const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')
const { accountRepository, musicUrlAuthorization } = require('./test-utils/qq-account-repository')

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
let singletonGetFeedbackCookie
let storeFactoryCallCount = 0
class QQMusicAuthError extends Error {}
class QQMusicCredentialRefreshError extends Error {
  constructor(kind) {
    super(`QQ Music credential refresh ${kind}`)
    this.name = 'QQMusicCredentialRefreshError'
    this.kind = kind
  }
}
const unavailableCredentialService = {
  refresh: async() => {
    throw new QQMusicCredentialRefreshError('unavailable')
  },
  getRefreshDueAt: () => null,
}
let nextLoginSequence = 0
const nextLoginRequestId = () =>
  `10000000-0000-4000-8000-${String(++nextLoginSequence).padStart(12, '0')}`
const isQQMusicLoginRequestId = requestId =>
  typeof requestId == 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)

const loginCalls = {
  create: [],
  cancel: [],
  dispose: 0,
}
const loginService = {
  createLoginQr: async(requestId, startedAt) => {
    loginCalls.create.push({ requestId, startedAt })
    return { key: requestId, qrimg: 'data:image/png;base64,AA==' }
  },
  checkLoginQr: async() => pendingLoginPromise ?? loginResult,
  cancelLoginQr: async requestId => {
    loginCalls.cancel.push(requestId)
  },
  disposeAll: async() => {
    loginCalls.dispose++
  },
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
const feedbackService = {
  likeMusic: async() => {},
  dislikeMusic: async() => {},
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
      isQQMusicLoginRequestId,
    },
    './userPlaylists': { createQQMusicUserPlaylistService: () => ({}) },
    './auth': { getQQMusicAccountUin },
    './credential': {
      createQQMusicCredentialService: () => unavailableCredentialService,
      isQQMusicCredentialRefreshError: error =>
        error instanceof QQMusicCredentialRefreshError,
    },
    './song': {
      createQQMusicSongService: options => {
        singletonGetCookie = options.getCookie
        return songService
      },
      QQMusicAuthError,
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
    './feedback': {
      createQQMusicFeedbackService: options => {
        singletonGetFeedbackCookie = options.getCookie
        return feedbackService
      },
    },
  },
)
assert.strictEqual(storeFactoryCallCount, 0)

const createFacade = () => createQQMusicAccountService({
  accounts: accountRepository(data),
  musicUrlAuthorization,
  loginService,
  songService,
  dailyRecommendService,
  homeRecommendService,
  playlistDetailService,
  feedbackService,
  credentialService: unavailableCredentialService,
  onRefreshDiagnostic: () => {},
  now: () => 123456,
})

const createQr = async service => {
  const requestId = nextLoginRequestId()
  return service.createLoginQr(requestId, Date.now())
}

global.lx = { accountRepository: accountRepository(data), musicUrlAuthorization }

const main = async() => {
  getSingletonAccountStatus()
  assert.strictEqual(storeFactoryCallCount, 0, 'singleton must use initialized account repository, never the legacy store')
  assert.strictEqual(singletonGetDailyRecommendCookie, singletonGetCookie)
  assert.strictEqual(singletonGetHomeRecommendCookie, singletonGetCookie)
  assert.strictEqual(singletonGetPlaylistDetailCookie, singletonGetCookie)
  assert.strictEqual(singletonGetFeedbackCookie, singletonGetCookie)
  await createSingletonLoginQr(nextLoginRequestId(), Date.now())
  assert.strictEqual(storeFactoryCallCount, 0, 'singleton must use initialized account repository, never the legacy store')

  const service = createFacade()
  assert.deepStrictEqual(service.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  const created = await createQr(service)
  assert.strictEqual(created.qrimg, 'data:image/png;base64,AA==')

  const result = await service.checkLoginQr(created.key)
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
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  assert.strictEqual(
    data.get('qqMusicAccount').cookie,
    'uin=o123; qqmusic_key=secret',
  )
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  songError = null
  loginResult = {
    state: 'success',
    message: '登录成功',
    cookie: 'qqmusic_uin=456; qqmusic_key=new-secret',
  }
  const restartedQr = await createQr(restarted)
  await restarted.checkLoginQr(restartedQr.key)
  assert.strictEqual(restarted.getAccountStatus().isLoggedIn, true)
  const disposalsBeforeLogout = loginCalls.dispose
  await restarted.logout()
  assert.strictEqual(loginCalls.dispose, disposalsBeforeLogout + 1)
  assert.deepStrictEqual(restarted.getAccountStatus(), {
    isLoggedIn: false,
    profile: null,
  })
  assert.deepStrictEqual(data.get('neteaseAccount'), { cookie: 'keep-netease' })

  const staleQr = await createQr(restarted)
  let resolveStaleLogin
  pendingLoginPromise = new Promise(resolve => {
    resolveStaleLogin = resolve
  })
  const staleLoginCheck = restarted.checkLoginQr(staleQr.key)
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

  const accountAQr = await createQr(restarted)
  let resolveAccountALogin
  pendingLoginPromise = new Promise(resolve => {
    resolveAccountALogin = resolve
  })
  const accountALoginCheck = restarted.checkLoginQr(accountAQr.key)
  const accountBQr = await createQr(restarted)
  pendingLoginPromise = null
  loginResult = {
    state: 'success',
    message: '登录成功',
    cookie: 'uin=oB; qqmusic_key=account-b',
  }
  await restarted.checkLoginQr(accountBQr.key)
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
  const missingUinQr = await createQr(restarted)
  await assert.rejects(restarted.checkLoginQr(missingUinQr.key), error => {
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
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, true)
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
  dailyRecommendError = null

  data.set('qqMusicAccount', accountB)
  homeRecommendError = new QQMusicAuthError('expired')
  await assert.rejects(raceFacade.getHomeRecommendation(), QQMusicAuthError)
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, true)
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
  homeRecommendError = null

  data.set('qqMusicAccount', accountB)
  playlistDetailError = new QQMusicAuthError('expired')
  await assert.rejects(raceFacade.getPlaylistDetail('211111', 1), QQMusicAuthError)
  assert.strictEqual(raceFacade.getAccountStatus().isLoggedIn, true)
  assert.deepStrictEqual(data.get('qqMusicAccount'), accountB)
  playlistDetailError = null

  const createId = '10000000-0000-4000-8000-999999999999'
  assert.deepStrictEqual(await service.createLoginQr(createId, 1234), {
    key: createId,
    qrimg: 'data:image/png;base64,AA==',
  })
  assert.deepStrictEqual(loginCalls.create.at(-1), {
    requestId: createId,
    startedAt: 1234,
  })

  await service.cancelLoginQr(createId)
  assert.strictEqual(loginCalls.cancel.at(-1), createId)

  const disposalsBeforeExplicitDispose = loginCalls.dispose
  await service.disposeLoginQr()
  assert.strictEqual(loginCalls.dispose, disposalsBeforeExplicitDispose + 1)
}

main().then(() => {
  console.log('QQ Music account tests passed')
}).catch(err => {
  console.error(err)
  process.exitCode = 1
})
