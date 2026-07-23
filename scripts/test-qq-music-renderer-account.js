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

const loadAccountStore = (getQQMusicAccountStatus, logoutQQMusic = async() => {}) => {
  return loadTsModule(path.join(__dirname, '../src/renderer/store/qqMusic.ts'), {
    '@common/utils/vueTools': { ref, shallowRef: ref, computed },
    '@renderer/utils/ipc': { getQQMusicAccountStatus, logoutQQMusic },
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
  const store = loadTsModule(path.join(__dirname, '../src/renderer/store/qqMusic.ts'), {
    '@common/utils/vueTools': { ref, shallowRef: ref, computed },
    '@renderer/utils/ipc': {
      getQQMusicAccountStatus: async() => {
        getCount++
        const result = getResults.shift()
        if (result instanceof Error) throw result
        return result
      },
      logoutQQMusic: async() => {},
    },
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

  const store = loadTsModule(path.join(__dirname, '../src/renderer/store/qqMusic.ts'), {
    '@common/utils/vueTools': { ref, shallowRef: ref, computed },
    '@renderer/utils/ipc': {
      getQQMusicAccountStatus: async() => {
        getCount++
        const result = getResults.shift()
        if (result instanceof Error) throw result
        return result
      },
      logoutQQMusic: async() => { logoutCount++ },
    },
  })

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

const testQrPolling = async() => {
  const timers = new Map()
  const unmountCallbacks = []
  let nextTimerId = 1
  let createResults = []
  let checkHandler
  let checkKeys = []
  let accountStatus = null
  let loginSuccessCount = 0
  const isLoggedIn = ref(false)
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
    accountStatus = null
    loginSuccessCount = 0
    isLoggedIn.value = false
  }

  const { useQQMusicLoginQr } = loadTsModule(
    path.join(__dirname, '../src/renderer/views/Recommend/useQQMusicLoginQr.ts'),
    {
      '@common/utils/vueTools': {
        ref,
        shallowRef: ref,
        computed,
        onBeforeUnmount: callback => unmountCallbacks.push(callback),
      },
      '@renderer/utils/ipc': {
        createQQMusicLoginQr: async() => createResults.shift(),
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
    createResults.push({ key: 'first', qrimg: 'data:first' })
    const pendingResults = [
      { state: 'waiting', message: '', isLoggedIn: false, profile: null },
      { state: 'scanned', message: '', isLoggedIn: false, profile: null },
      { state: 'success', message: '', isLoggedIn: true, profile: { uin: '123', nickname: 'QQ 账号' } },
    ]
    checkHandler = async() => pendingResults.shift()
    const polling = useQQMusicLoginQr(async() => { loginSuccessCount++ })

    await polling.handleCreateLoginQr()
    assert.strictEqual(polling.showLoginPanel.value, true)
    assert.strictEqual(polling.qrImg.value, 'data:first')
    assert.strictEqual(polling.qrStatusText.value, '请使用手机 QQ 扫码登录')
    assert.strictEqual(timers.size, 1)

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
    assert.deepStrictEqual(checkKeys, ['first', 'first', 'first'])
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
    takeTimer()
    closing.handleCloseLogin()
    closeCheck.resolve({ state: 'waiting', message: '', isLoggedIn: false, profile: null })
    await settle()
    assert.strictEqual(closing.showLoginPanel.value, false)
    assert.strictEqual(timers.size, 0)

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
    expiring.handleShowLogin()
    await settle()
    assert.strictEqual(expiring.qrInfo.value.key, 'replacement')
    assert.strictEqual(expiring.qrImg.value, 'data:replacement')
    assert.strictEqual(timers.size, 1)

    reset()
    createResults.push(
      { key: 'old', qrimg: 'data:old' },
      { key: 'current', qrimg: 'data:current' },
    )
    const oldCheck = deferred()
    checkHandler = key => key == 'old'
      ? oldCheck.promise
      : Promise.resolve({ state: 'waiting', message: '', isLoggedIn: false, profile: null })
    const replacing = useQQMusicLoginQr(async() => {})
    await replacing.handleCreateLoginQr()
    takeTimer()
    await replacing.handleCreateLoginQr()
    assert.strictEqual(replacing.qrInfo.value.key, 'current')
    assert.strictEqual(timers.size, 1)
    oldCheck.resolve({
      state: 'success',
      message: '',
      isLoggedIn: true,
      profile: { uin: 'stale', nickname: '旧账号' },
    })
    await settle()
    assert.strictEqual(replacing.qrInfo.value.key, 'current')
    assert.strictEqual(replacing.qrStatusText.value, '请使用手机 QQ 扫码登录')
    assert.strictEqual(accountStatus, null)
    assert.strictEqual(timers.size, 1)

    assert.strictEqual(unmountCallbacks.length, 1)
    unmountCallbacks[0]()
    assert.strictEqual(timers.size, 0)
  } finally {
    global.window = originalWindow
  }
}

const main = async() => {
  await testLatestForcedInitWins()
  await testOlderInitCannotClearNewerBookkeeping()
  await testAccountMutationsInvalidateOlderInit()
  await testPendingLogoutPermanentlyInvalidatesOlderInit()
  await testAccountInitRetry()
  await testAccountStore()
  await testQrPolling()
  console.log('QQ Music renderer account tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
