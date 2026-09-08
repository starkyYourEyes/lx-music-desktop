const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const storePath = path.join(root, 'src/renderer/store/kugouMusic.ts')
const loginPath = path.join(root, 'src/renderer/views/KugouRecommend/useKugouMusicLoginQr.ts')

const createDeferred = () => {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

const createVueTools = cleanups => ({
  computed: getter => ({ get value() { return getter() } }),
  onBeforeUnmount: callback => cleanups.push(callback),
  ref: value => ({ value }),
  shallowRef: value => ({ value }),
})

const createHarness = ({
  status = { isLoggedIn: false, profile: null },
  getAccountStatus,
  checkLoginQr,
} = {}) => {
  const cleanups = []
  const calls = { status: 0, create: [], check: [], cancel: [], logout: 0 }
  const ipc = {
    getKugouMusicAccountStatus: async() => {
      calls.status++
      return getAccountStatus ? getAccountStatus() : status
    },
    createKugouMusicLoginQr: async requestId => {
      calls.create.push(requestId)
      return { requestId, image: 'data:image/png;base64,QR' }
    },
    checkKugouMusicLoginQr: async requestId => {
      calls.check.push(requestId)
      return checkLoginQr
        ? checkLoginQr(requestId)
        : { state: 'waiting', isLoggedIn: false, profile: null }
    },
    cancelKugouMusicLoginQr: async requestId => {
      calls.cancel.push(requestId)
    },
    logoutKugouMusic: async() => {
      calls.logout++
    },
  }
  const vueTools = createVueTools(cleanups)
  const store = loadTsModule(storePath, {
    '@common/utils/vueTools': vueTools,
    '@renderer/utils/ipc': ipc,
  })
  const login = loadTsModule(loginPath, {
    '@common/utils/vueTools': vueTools,
    '@renderer/utils/ipc': ipc,
    '@renderer/store/kugouMusic': store,
    '@root/lang': { useI18n: () => key => key },
  })
  return { calls, cleanups, ipc, login, store }
}

test('Kugou account initialization coalesces requests and revision changes the account key', async() => {
  const deferred = createDeferred()
  const harness = createHarness({ getAccountStatus: () => deferred.promise })

  const first = harness.store.initKugouMusicAccount()
  const second = harness.store.initKugouMusicAccount()
  assert.equal(harness.calls.status, 1)
  deferred.resolve({ isLoggedIn: true, profile: { userId: '42', nickname: 'Kugou' } })
  await Promise.all([first, second])
  const firstKey = harness.store.getKugouMusicAccountKey()

  await harness.store.initKugouMusicAccount(true)
  assert.equal(harness.calls.status, 2)
  assert.notEqual(harness.store.getKugouMusicAccountKey(), firstKey)
})

test('Kugou logout clears the renderer account state', async() => {
  const harness = createHarness({ status: { isLoggedIn: true, profile: { userId: '42', nickname: 'Kugou' } } })
  await harness.store.initKugouMusicAccount()
  await harness.store.logoutKugouMusicAccount()

  assert.equal(harness.calls.logout, 1)
  assert.equal(harness.store.isLoggedIn.value, false)
  assert.equal(harness.store.profile.value, null)
  assert.equal(harness.store.getKugouMusicAccountKey(), null)
})

test('Kugou QR authorization does not close the panel until account login is confirmed', async() => {
  const originalWindow = global.window
  const timers = []
  global.window = {
    clearTimeout: () => {},
    crypto: { randomUUID: () => 'b2c62e4e-bb0a-4a74-9482-a3d7754a88a8' },
    setTimeout: callback => {
      timers.push(callback)
      return timers.length
    },
  }

  try {
    const harness = createHarness({
      checkLoginQr: async() => ({
        code: 4,
        state: 'success',
        isLoggedIn: false,
        profile: null,
      }),
    })
    let successCalls = 0
    const login = harness.login.useKugouMusicLoginQr(async() => {
      successCalls++
    })

    await login.handleCreateLoginQr()
    timers.shift()()
    await new Promise(resolve => setImmediate(resolve))

    assert.equal(login.showLoginPanel.value, true)
    assert.equal(login.qrStatusText.value, 'kugou_recommend_qr_check_failed')
    assert.equal(harness.store.isLoggedIn.value, false)
    assert.equal(successCalls, 0)
    assert.equal(timers.length, 1)
  } finally {
    global.window = originalWindow
  }
})

test('a late successful Kugou QR check cannot commit after closing the login panel', async() => {
  const originalWindow = global.window
  const timers = []
  global.window = {
    clearTimeout: () => {},
    crypto: { randomUUID: () => 'b2c62e4e-bb0a-4a74-9482-a3d7754a88a8' },
    setTimeout: callback => {
      timers.push(callback)
      return timers.length
    },
  }

  try {
    const deferred = createDeferred()
    const harness = createHarness({ checkLoginQr: () => deferred.promise })
    let successCalls = 0
    const login = harness.login.useKugouMusicLoginQr(async() => {
      successCalls++
    })

    await login.handleCreateLoginQr()
    assert.match(harness.calls.create[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    timers.shift()()
    await new Promise(resolve => setImmediate(resolve))
    login.handleCloseLogin()
    deferred.resolve({
      state: 'success',
      isLoggedIn: true,
      profile: { userId: '42', nickname: 'Kugou' },
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(harness.calls.cancel, ['b2c62e4e-bb0a-4a74-9482-a3d7754a88a8'])
    assert.equal(harness.store.isLoggedIn.value, false)
    assert.equal(successCalls, 0)
  } finally {
    global.window = originalWindow
  }
})
