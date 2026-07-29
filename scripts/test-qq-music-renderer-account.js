const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const ref = value => ({ value })
const computed = getter => ({
  get value() {
    return getter()
  },
})

const settle = async() => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const deferred = () => {
  let resolveDeferred
  let rejectDeferred
  const promise = new Promise((resolve, reject) => {
    resolveDeferred = resolve
    rejectDeferred = reject
  })
  return { promise, resolve: resolveDeferred, reject: rejectDeferred }
}

const loadAccountStore = (
  getQQMusicAccountStatus,
  logoutQQMusic = async() => {},
  resetQQGuessLikeQueue = () => {},
  resetQQDailyRecommend = () => {},
  resetQQBrushModeQueue = () => {},
) => {
  return loadTsModule(path.join(__dirname, '../src/renderer/store/qqMusic.ts'), {
    '@common/utils/vueTools': { ref, shallowRef: ref, computed },
    '@renderer/utils/ipc': { getQQMusicAccountStatus, logoutQQMusic },
    '@renderer/store/qqGuessLike/action': { resetQQGuessLikeQueue },
    '@renderer/store/qqBrushMode/action': { resetQQBrushModeQueue },
    '@renderer/store/qqDailyRecommend/action': { resetQQDailyRecommend },
  })
}

const testLatestForcedInitWins = async() => {
  const olderResult = deferred()
  const newerResult = deferred()
  const results = [olderResult.promise, newerResult.promise]
  let getCount = 0
  const store = loadAccountStore(async() => results[getCount++])

  const olderInit = store.initQQMusicAccount(true)
  const newerInit = store.initQQMusicAccount(true)
  newerResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'newer', nickname: '较新账号' },
  })
  await newerInit
  olderResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'older', nickname: '较旧账号' },
  })
  await olderInit

  assert.strictEqual(getCount, 2)
  assert.strictEqual(store.profile.value.uin, 'newer')
}

const testOlderInitCannotClearNewerBookkeeping = async() => {
  const olderResult = deferred()
  const newerResult = deferred()
  const results = [olderResult.promise, newerResult.promise]
  let getCount = 0
  const store = loadAccountStore(async() => results[getCount++])

  const olderInit = store.initQQMusicAccount(true)
  const newerInit = store.initQQMusicAccount(true)
  olderResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'older', nickname: '较旧账号' },
  })
  await olderInit
  assert.strictEqual(store.isInitingQQMusicAccount.value, true)

  let joinedInitResolved = false
  const joinedInit = store.initQQMusicAccount().then(() => {
    joinedInitResolved = true
  })
  await settle()
  assert.strictEqual(getCount, 2)
  assert.strictEqual(joinedInitResolved, false)

  newerResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'newer', nickname: '较新账号' },
  })
  await Promise.all([newerInit, joinedInit])
  assert.strictEqual(store.isInitingQQMusicAccount.value, false)
  assert.strictEqual(store.profile.value.uin, 'newer')
}

const testAccountMutationsInvalidateOlderInit = async() => {
  const logoutInitResult = deferred()
  const logoutStore = loadAccountStore(async() => logoutInitResult.promise)
  const pendingLogoutInit = logoutStore.initQQMusicAccount()
  await logoutStore.logoutQQMusicAccount()
  logoutInitResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'stale-after-logout', nickname: '旧账号' },
  })
  await pendingLogoutInit
  assert.deepStrictEqual(logoutStore.accountStatus.value, {
    isLoggedIn: false,
    profile: null,
  })

  const qrInitResult = deferred()
  const qrStore = loadAccountStore(async() => qrInitResult.promise)
  const pendingQrInit = qrStore.initQQMusicAccount()
  qrStore.setQQMusicAccountStatus({
    isLoggedIn: true,
    profile: { uin: 'qr-login', nickname: '扫码账号' },
  })
  qrInitResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'stale-init', nickname: '旧账号' },
  })
  await pendingQrInit
  assert.strictEqual(qrStore.profile.value.uin, 'qr-login')
}

const testPendingLogoutPermanentlyInvalidatesOlderInit = async() => {
  const initResult = deferred()
  const logoutResult = deferred()
  let getCount = 0
  const store = loadAccountStore(
    async() => {
      getCount++
      return initResult.promise
    },
    async() => logoutResult.promise,
  )
  const baselineStatus = {
    isLoggedIn: true,
    profile: { uin: 'baseline', nickname: '退出前账号' },
  }
  store.setQQMusicAccountStatus(baselineStatus)

  const pendingInit = store.initQQMusicAccount(true)
  const pendingLogout = store.logoutQQMusicAccount()
  const expectedLogoutFailure = assert.rejects(pendingLogout, /logout failed/)
  initResult.resolve({
    isLoggedIn: true,
    profile: { uin: 'stale-during-logout', nickname: '旧初始化账号' },
  })
  await pendingInit
  assert.deepStrictEqual(store.accountStatus.value, baselineStatus)

  logoutResult.reject(new Error('logout failed'))
  await expectedLogoutFailure
  assert.deepStrictEqual(store.accountStatus.value, baselineStatus)

  await store.initQQMusicAccount()
  assert.strictEqual(getCount, 1)
  assert.deepStrictEqual(store.accountStatus.value, baselineStatus)
}

const testAccountInitRetry = async() => {
  let getCount = 0
  const getResults = [
    new Error('status unavailable'),
    { isLoggedIn: true, profile: { uin: 'retry', nickname: '重试账号' } },
  ]
  const store = loadAccountStore(async() => {
    getCount++
    const result = getResults.shift()
    if (result instanceof Error) throw result
    return result
  })

  await assert.rejects(store.initQQMusicAccount(), /status unavailable/)
  assert.strictEqual(getCount, 1)
  assert.deepStrictEqual(store.accountStatus.value, { isLoggedIn: false, profile: null })
  assert.strictEqual(store.isQQMusicAccountInited.value, false)
  assert.strictEqual(store.isInitingQQMusicAccount.value, false)

  await store.initQQMusicAccount()
  assert.strictEqual(getCount, 2)
  assert.strictEqual(store.isQQMusicAccountInited.value, true)
  assert.strictEqual(store.profile.value.uin, 'retry')
}

const testAccountStore = async() => {
  let getCount = 0
  let logoutCount = 0
  const getResults = [
    { isLoggedIn: true, profile: { uin: 'o123', nickname: 'QQ 音乐账号' } },
  ]

  const store = loadAccountStore(
    async() => {
      getCount++
      const result = getResults.shift()
      if (result instanceof Error) throw result
      return result
    },
    async() => { logoutCount++ },
  )

  await Promise.all([store.initQQMusicAccount(), store.initQQMusicAccount()])
  assert.strictEqual(getCount, 1)
  assert.strictEqual(store.isLoggedIn.value, true)
  assert.strictEqual(store.profile.value.uin, 'o123')
  assert.strictEqual(store.isInitingQQMusicAccount.value, false)
  assert.strictEqual(store.isQQMusicAccountInited.value, true)

  await store.initQQMusicAccount()
  assert.strictEqual(getCount, 1)

  store.setQQMusicAccountStatus({
    isLoggedIn: true,
    profile: { uin: '456', nickname: '新账号' },
    cookie: 'must-not-be-copied',
  })
  assert.deepStrictEqual(store.accountStatus.value, {
    isLoggedIn: true,
    profile: { uin: '456', nickname: '新账号' },
  })

  getResults.push({ isLoggedIn: false, profile: null })
  await store.initQQMusicAccount(true)
  assert.strictEqual(getCount, 2)
  assert.strictEqual(store.isLoggedIn.value, false)

  await store.logoutQQMusicAccount()
  assert.strictEqual(logoutCount, 1)
  assert.deepStrictEqual(store.accountStatus.value, { isLoggedIn: false, profile: null })
}

const testAccountIdentityInvalidatesQQGuessLikeQueue = async() => {
  let resetCount = 0
  let brushResetCount = 0
  const store = loadAccountStore(
    async() => ({ isLoggedIn: false, profile: null }),
    async() => {},
    () => { resetCount++ },
    () => {},
    () => { brushResetCount++ },
  )
  const status = uin => ({
    isLoggedIn: true,
    profile: { uin, nickname: `account-${uin}` },
  })

  store.setQQMusicAccountStatus(status('account-a'))
  store.setQQMusicAccountStatus(status('account-a'))
  assert.strictEqual(resetCount, 1)
  assert.strictEqual(brushResetCount, 1)

  store.setQQMusicAccountStatus(status('account-b'))
  assert.strictEqual(resetCount, 2)
  assert.strictEqual(brushResetCount, 2)

  await store.logoutQQMusicAccount()
  assert.strictEqual(resetCount, 3)
  assert.strictEqual(brushResetCount, 3)
}

const testQrPolling = async() => {
  const timers = new Map()
  const unmountCallbacks = []
  let nextTimerId = 1
  let createResults = []
  let checkHandler
  let checkKeys = []
  const makeRequestId = sequence =>
    `20000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`
  const createIds = []
  const cancelledIds = []
  const cancelGates = []
  let requestIndex = 0
  let accountStatus = null
  let loginSuccessCount = 0
  const isLoggedIn = ref(false)
  const originalWindow = global.window
  const originalHTMLImageElement = global.HTMLImageElement
  const animationFrames = []
  const measures = []
  let performanceNow = 100

  class FakeHTMLImageElement {
    constructor({
      connected = true,
      naturalWidth = 218,
      naturalHeight = 218,
      width = 218,
      height = 218,
      display = 'block',
      visibility = 'visible',
      opacity = '1',
    } = {}) {
      this.isConnected = connected
      this.naturalWidth = naturalWidth
      this.naturalHeight = naturalHeight
      this.bounds = { width, height }
      this.style = { display, visibility, opacity }
    }

    getBoundingClientRect() {
      return this.bounds
    }
  }
  global.HTMLImageElement = FakeHTMLImageElement

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
    crypto: {
      randomUUID: () => makeRequestId(++requestIndex),
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback)
      return animationFrames.length
    },
    getComputedStyle: image => image.style,
    performance: {
      now: () => performanceNow,
      measure: (name, options) => measures.push({ name, options }),
    },
  }

  const takeTimer = () => {
    assert.strictEqual(timers.size, 1)
    const [id, callback] = timers.entries().next().value
    timers.delete(id)
    callback()
  }

  const reset = () => {
    timers.clear()
    unmountCallbacks.length = 0
    createResults = []
    checkKeys = []
    createIds.length = 0
    cancelledIds.length = 0
    cancelGates.length = 0
    requestIndex = 0
    accountStatus = null
    loginSuccessCount = 0
    isLoggedIn.value = false
    animationFrames.length = 0
    measures.length = 0
    performanceNow = 100
  }

  const { isRenderedQQMusicQrImage, useQQMusicLoginQr } = loadTsModule(
    path.join(__dirname, '../src/renderer/views/Recommend/useQQMusicLoginQr.ts'),
    {
      '@common/utils/vueTools': {
        ref,
        shallowRef: ref,
        computed,
        onBeforeUnmount: callback => unmountCallbacks.push(callback),
      },
      '@renderer/utils/ipc': {
        createQQMusicLoginQr: async requestId => {
          createIds.push(requestId)
          const result = await createResults.shift()
          return { ...result, key: requestId }
        },
        cancelQQMusicLoginQr: async requestId => {
          cancelledIds.push(requestId)
          const gate = cancelGates.shift()
          if (gate) await gate.promise
        },
        checkQQMusicLoginQr: async key => {
          checkKeys.push(key)
          return checkHandler(key)
        },
      },
      '@renderer/store/qqMusic': {
        isLoggedIn,
        setQQMusicAccountStatus: status => {
          accountStatus = {
            isLoggedIn: status.isLoggedIn,
            profile: status.profile,
          }
          isLoggedIn.value = status.isLoggedIn
        },
      },
    },
  )

  try {
    reset()
    performanceNow = 100
    createResults.push({ key: 'first', qrimg: 'data:first' })
    const pendingResults = [
      { state: 'waiting', message: '', isLoggedIn: false, profile: null },
      { state: 'scanned', message: '', isLoggedIn: false, profile: null },
      { state: 'success', message: '', isLoggedIn: true, profile: { uin: '123', nickname: 'QQ 账号' } },
    ]
    checkHandler = async() => pendingResults.shift()
    const polling = useQQMusicLoginQr(async() => { loginSuccessCount++ })

    await polling.handleCreateLoginQr()
    const firstRequestId = createIds[0]
    assert.strictEqual(firstRequestId, makeRequestId(1))
    assert.strictEqual(polling.qrInfo.value.key, firstRequestId)
    assert.deepStrictEqual(checkKeys, [])
    assert.strictEqual(polling.showLoginPanel.value, true)
    assert.strictEqual(polling.qrImg.value, 'data:first')
    assert.strictEqual(polling.qrStatusText.value, '请使用手机 QQ 扫码登录')
    assert.strictEqual(timers.size, 1)

    const image = new FakeHTMLImageElement()
    performanceNow = 2_450
    polling.handleQrImageLoad({ currentTarget: image })
    assert.strictEqual(measures.length, 0)
    assert.strictEqual(animationFrames.length, 1)
    polling.handleQrImageLoad({ currentTarget: image })
    assert.strictEqual(animationFrames.length, 2)
    animationFrames.shift()()
    animationFrames.shift()()
    assert.deepStrictEqual(measures, [{
      name: 'qq-music-login-qr-visible',
      options: {
        start: 100,
        end: 2450,
      },
    }])

    polling.handleQrImageLoad({ currentTarget: image })
    assert.strictEqual(animationFrames.length, 0)
    assert.strictEqual(measures.length, 1)

    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ naturalWidth: 0 })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ naturalHeight: 0 })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ connected: false })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ width: 0 })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ height: 0 })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ display: 'none' })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ visibility: 'hidden' })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ visibility: 'collapse' })),
      false,
    )
    assert.strictEqual(
      isRenderedQQMusicQrImage(new FakeHTMLImageElement({ opacity: '0' })),
      false,
    )

    takeTimer()
    await settle()
    assert.strictEqual(polling.qrStatusText.value, '请使用手机 QQ 扫码登录')
    assert.strictEqual(timers.size, 1)

    takeTimer()
    await settle()
    assert.strictEqual(polling.qrStatusText.value, '已扫码，请在手机上确认登录')
    assert.strictEqual(timers.size, 1)

    takeTimer()
    await settle()
    assert.deepStrictEqual(checkKeys, [
      firstRequestId,
      firstRequestId,
      firstRequestId,
    ])
    assert.deepStrictEqual(accountStatus, {
      isLoggedIn: true,
      profile: { uin: '123', nickname: 'QQ 账号' },
    })
    assert.strictEqual(polling.qrStatusText.value, '登录成功')
    assert.strictEqual(loginSuccessCount, 1)
    assert.strictEqual(timers.size, 0)

    reset()
    createResults.push({ key: 'close', qrimg: 'data:close' })
    const closeCheck = deferred()
    checkHandler = () => closeCheck.promise
    const closing = useQQMusicLoginQr(async() => {})
    await closing.handleCreateLoginQr()
    const closingRequestId = createIds[0]
    takeTimer()
    closing.handleCloseLogin()
    assert.deepStrictEqual(cancelledIds, [closingRequestId])
    closeCheck.resolve({ state: 'waiting', message: '', isLoggedIn: false, profile: null })
    await settle()
    assert.strictEqual(closing.showLoginPanel.value, false)
    assert.strictEqual(timers.size, 0)

    reset()
    const createGate = deferred()
    createResults.push(createGate.promise)
    const earlyClose = useQQMusicLoginQr(async() => {})
    const pendingCreate = earlyClose.handleCreateLoginQr()
    await settle()
    const earlyRequestId = createIds[0]
    earlyClose.handleCloseLogin()
    assert.deepStrictEqual(cancelledIds, [earlyRequestId])
    createGate.reject(new Error('cancelled creation'))
    await pendingCreate
    assert.notStrictEqual(earlyClose.qrStatusText.value, '二维码生成失败，请重试')
    assert.strictEqual(earlyClose.showLoginPanel.value, false)

    reset()
    createResults.push(
      { key: 'expired', qrimg: 'data:expired' },
      { key: 'replacement', qrimg: 'data:replacement' },
    )
    checkHandler = async() => ({ state: 'expired', message: '', isLoggedIn: false, profile: null })
    const expiring = useQQMusicLoginQr(async() => {})
    await expiring.handleCreateLoginQr()
    takeTimer()
    await settle()
    assert.strictEqual(expiring.qrStatusText.value, '二维码已过期，请重新获取')
    assert.strictEqual(timers.size, 0)
    expiring.handleQrImageLoad({
      currentTarget: new FakeHTMLImageElement(),
    })
    assert.strictEqual(animationFrames.length, 0)
    expiring.handleShowLogin()
    await settle()
    const expiryReplacementId = createIds[1]
    assert.strictEqual(expiryReplacementId, makeRequestId(2))
    assert.strictEqual(expiring.qrInfo.value.key, expiryReplacementId)
    assert.strictEqual(expiring.qrImg.value, 'data:replacement')
    assert.strictEqual(timers.size, 1)

    reset()
    createResults.push(Promise.reject(
      new Error('QQ Music login QR creation timed out'),
    ))
    const timedOut = useQQMusicLoginQr(async() => {})
    await timedOut.handleCreateLoginQr()
    assert.strictEqual(timedOut.qrStatusText.value, '二维码生成超时，请重试')
    assert.strictEqual(timedOut.showLoginPanel.value, true)

    reset()
    createResults.push(
      { qrimg: 'data:old' },
      { qrimg: 'data:current' },
    )
    checkHandler = async() => ({
      state: 'waiting',
      message: '',
      isLoggedIn: false,
      profile: null,
    })
    const replacing = useQQMusicLoginQr(async() => {})
    await replacing.handleCreateLoginQr()
    const refreshOldRequestId = createIds[0]
    replacing.handleQrImageLoad({
      currentTarget: new FakeHTMLImageElement(),
    })
    assert.strictEqual(animationFrames.length, 1)

    const cancelGate = deferred()
    cancelGates.push(cancelGate)
    const refresh = replacing.handleCreateLoginQr()
    await settle()
    assert.deepStrictEqual(cancelledIds, [refreshOldRequestId])
    assert.strictEqual(createIds.length, 1)
    cancelGate.resolve()
    await refresh
    const refreshCurrentRequestId = createIds[1]
    assert.notStrictEqual(refreshCurrentRequestId, refreshOldRequestId)
    assert.strictEqual(replacing.qrInfo.value.key, refreshCurrentRequestId)
    const measureCountBeforeStaleFrame = measures.length
    animationFrames.shift()()
    assert.strictEqual(measures.length, measureCountBeforeStaleFrame)

    reset()
    performanceNow = 3_000
    createResults.push({ qrimg: 'data:stale-visible' })
    const staleVisibility = useQQMusicLoginQr(async() => {})
    await staleVisibility.handleCreateLoginQr()
    staleVisibility.handleQrImageLoad({
      currentTarget: new FakeHTMLImageElement(),
    })
    assert.strictEqual(animationFrames.length, 1)
    const measureCount = measures.length
    staleVisibility.handleCloseLogin()
    animationFrames.shift()()
    assert.strictEqual(measures.length, measureCount)

    reset()
    createResults.push(
      { key: 'old', qrimg: 'data:old' },
      { key: 'current', qrimg: 'data:current' },
    )
    const oldCheck = deferred()
    let oldRequestId
    checkHandler = key => key == oldRequestId
      ? oldCheck.promise
      : Promise.resolve({ state: 'waiting', message: '', isLoggedIn: false, profile: null })
    const staleCheck = useQQMusicLoginQr(async() => {})
    await staleCheck.handleCreateLoginQr()
    oldRequestId = createIds[0]
    takeTimer()
    await staleCheck.handleCreateLoginQr()
    const currentRequestId = createIds[1]
    assert.strictEqual(staleCheck.qrInfo.value.key, currentRequestId)
    assert.strictEqual(timers.size, 1)
    oldCheck.resolve({
      state: 'success',
      message: '',
      isLoggedIn: true,
      profile: { uin: 'stale', nickname: '旧账号' },
    })
    await settle()
    assert.strictEqual(staleCheck.qrInfo.value.key, currentRequestId)
    assert.strictEqual(accountStatus, null)
    assert.strictEqual(timers.size, 1)

    assert.strictEqual(unmountCallbacks.length, 1)
    unmountCallbacks[0]()
    assert.strictEqual(cancelledIds.at(-1), currentRequestId)
    assert.strictEqual(timers.size, 0)
  } finally {
    global.window = originalWindow
    global.HTMLImageElement = originalHTMLImageElement
  }
}

const main = async() => {
  await testLatestForcedInitWins()
  await testOlderInitCannotClearNewerBookkeeping()
  await testAccountMutationsInvalidateOlderInit()
  await testPendingLogoutPermanentlyInvalidatesOlderInit()
  await testAccountInitRetry()
  await testAccountStore()
  await testAccountIdentityInvalidatesQQGuessLikeQueue()
  await testQrPolling()
  console.log('QQ Music renderer account tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
