const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const settle = async() => {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise(resolve => setImmediate(resolve))
}

const withWatchdog = async(promise, timeoutMs, message) => {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

global.lx = { sessionRegistry: { register: () => ({ ready: Promise.resolve(), unregister() {} }) } }

let harness

class FakeBrowserWindow extends EventEmitter {
  constructor(options) {
    super()
    this.webContents = harness.webContents
    this.destroyed = false
    harness.options = options
    harness.window = this
  }

  loadURL(url) {
    harness.events.push('navigation-started')
    harness.authorizeUrl = url
    return harness.navigation.promise
  }

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    harness.destroyCount++
  }
}

const createHarness = () => {
  const navigation = deferred()
  const proxyGate = deferred()
  const frame = {
    url: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin',
    async executeJavaScript(source) {
      if (source.includes('naturalWidth')) {
        harness.events.push('qr-image-ready')
        return {
          x: 10,
          y: 12,
          width: 100,
          height: 100,
          complete: true,
          naturalWidth: 100,
          naturalHeight: 100,
        }
      }
      return 'waiting'
    },
  }
  const webContents = new EventEmitter()
  webContents.mainFrame = { frames: [frame] }
  webContents.executeJavaScript = async() => ({
    x: 20,
    y: 30,
    width: 300,
    height: 300,
  })
  webContents.capturePage = async() => ({
    isEmpty: () => false,
    toDataURL: () => 'data:image/png;base64,qr',
  })
  webContents.setWindowOpenHandler = () => {}

  const loginSession = {
    setPermissionRequestHandler() {},
    setPermissionCheckHandler() {},
    cookies: { get: async() => [] },
    clearAuthCache: async() => {},
    clearStorageData: async() => {},
    clearCache: async() => {},
    clearCodeCaches: async() => {},
  }

  return {
    navigation,
    proxyGate,
    frame,
    webContents,
    loginSession,
    events: [],
    destroyCount: 0,
    options: null,
    window: null,
    authorizeUrl: '',
  }
}

const auth = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/browserAuth.ts'),
  {
    electron: {
      BrowserWindow: FakeBrowserWindow,
      session: {
        fromPartition() {
          return harness.loginSession
        },
      },
    },
    './auth': {
      getQQMusicAccountUin: cookie =>
        /(?:^|;\s*)uin=([^;]+)/.exec(cookie)?.[1] ?? '',
    },
    '@main/utils/sessionProxy': {
      async configureSessionProxy(_session, proxy) {
        harness.events.push(proxy ? 'proxy-fixed-started' : 'proxy-direct-started')
        await harness.proxyGate.promise
        harness.events.push('proxy-configured')
      },
    },
    '@main/utils/webContentsNavigationGuard': {
      registerWebContentsNavigationGuard: () => () => {},
    },
  },
)

const createSession = (controller, extra = {}) => auth.createQQMusicBrowserAuthSession({
  signal: controller.signal,
  startedAt: Date.now(),
  deadlineAt: Date.now() + 1_000,
  proxy: { host: '127.0.0.1', port: 7890 },
  onDiagnostic: event => harness.events.push(event.stage),
  ...extra,
})

const testProxyPrecedesNavigation = async() => {
  harness = createHarness()
  const controller = new AbortController()
  const pending = createSession(controller)
  await settle()
  assert.deepEqual(harness.events, ['proxy-fixed-started'])

  harness.proxyGate.resolve()
  const authSession = await pending
  assert.ok(harness.events.indexOf('proxy-configured') <
    harness.events.indexOf('navigation-started'))
  await authSession.destroy()
}

const testDirectModePrecedesNavigation = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const startedAt = Date.now()
  const authSession = await auth.createQQMusicBrowserAuthSession({
    signal: new AbortController().signal,
    startedAt,
    deadlineAt: startedAt + 1_000,
    proxy: null,
    onDiagnostic: event => harness.events.push(event.stage),
  })
  assert.ok(harness.events.indexOf('proxy-direct-started') <
    harness.events.indexOf('navigation-started'))
  await authSession.destroy()
}

const testQrReturnsWhileLoadIsPending = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const authSession = await createSession(new AbortController())
  assert.equal(harness.navigation.promise instanceof Promise, true)
  assert.equal(authSession.qrimg, 'data:image/png;base64,qr')
  assert.equal(harness.events.includes('qr-image-ready'), true)
  await authSession.destroy()
}

const testAllowedAbortIsObservedAndNonterminal = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const authSession = await createSession(new AbortController())
    harness.webContents.emit(
      'will-redirect',
      { preventDefault() {} },
      'https://graph.qq.com/oauth2.0/authorize',
      false,
      true,
    )
    const error = new Error('ERR_ABORTED')
    error.code = 'ERR_ABORTED'
    error.errno = -3
    harness.navigation.reject(error)
    await settle()
    assert.deepEqual(unhandled, [])
    assert.deepEqual(await authSession.check(), {
      state: 'waiting',
      message: '等待扫码',
    })
    await authSession.destroy()
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

const testTransientFrameDetachKeepsDiscovering = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const execute = harness.frame.executeJavaScript
  let imageInfoAttempts = 0
  harness.frame.executeJavaScript = async source => {
    if (source.includes('naturalWidth') && imageInfoAttempts++ == 0) {
      throw new Error('frame was detached')
    }
    return execute.call(harness.frame, source)
  }

  const authSession = await createSession(new AbortController())
  assert.equal(authSession.qrimg, 'data:image/png;base64,qr')
  assert.ok(imageInfoAttempts >= 2)
  await authSession.destroy()
}

const testPreCancelledCreationObservesLateProxyRejection = async() => {
  harness = createHarness()
  const controller = new AbortController()
  controller.abort()
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    await assert.rejects(
      createSession(controller),
      /QQ Music login QR creation failed/,
    )
    harness.proxyGate.reject(new Error('late pre-cancelled proxy rejection'))
    await settle()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

const testExpiredCreationObservesLateProxyRejection = async() => {
  harness = createHarness()
  const unhandled = []
  const onUnhandled = error => unhandled.push(error)
  process.on('unhandledRejection', onUnhandled)
  try {
    const startedAt = Date.now()
    await assert.rejects(
      auth.createQQMusicBrowserAuthSession({
        signal: new AbortController().signal,
        startedAt,
        deadlineAt: startedAt - 1,
        proxy: null,
        onDiagnostic: event => harness.events.push(event.stage),
      }),
      /QQ Music login QR creation failed/,
    )
    harness.proxyGate.reject(new Error('late expired proxy rejection'))
    await settle()
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
}

const testFatalMainFrameFailureExpiresCapturedQr = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const authSession = await createSession(new AbortController())

  harness.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'ERR_NAME_NOT_RESOLVED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  await settle()

  assert.deepEqual(await authSession.check(), {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.equal(harness.destroyCount, 1)
}

const testAbortDuringProxySetupDestroysOnce = async() => {
  harness = createHarness()
  const controller = new AbortController()
  const pending = createSession(controller)
  await settle()
  controller.abort()
  await assert.rejects(pending, /QQ Music login QR creation failed/)
  assert.equal(harness.destroyCount, 1)
  harness.proxyGate.resolve()
  await settle()
  assert.equal(harness.destroyCount, 1)
}

const testOneDeadlineIncludesProxySetup = async() => {
  harness = createHarness()
  const startedAt = Date.now()
  const pending = auth.createQQMusicBrowserAuthSession({
    signal: new AbortController().signal,
    startedAt,
    deadlineAt: startedAt + 25,
    proxy: null,
    cleanupTimeoutMs: 10,
    onDiagnostic: event => harness.events.push(event.stage),
  })

  await assert.rejects(pending, /QQ Music login QR creation failed/)
  assert.equal(harness.destroyCount, 1)
  assert.equal(harness.events.includes('timed-out'), true)
  harness.proxyGate.resolve()
}

const testStageSettlementAfterDeadlineCannotWin = async() => {
  harness = createHarness()
  const originalNow = Date.now
  let now = 100
  Date.now = () => now
  try {
    const pending = auth.createQQMusicBrowserAuthSession({
      signal: new AbortController().signal,
      startedAt: 100,
      deadlineAt: 10_100,
      proxy: null,
      cleanupTimeoutMs: 10,
      onDiagnostic: event => harness.events.push(event.stage),
    })
    await settle()
    assert.equal(harness.events.includes('proxy-direct-started'), true)

    now = 10_101
    harness.proxyGate.resolve()
    await assert.rejects(pending, /QQ Music login QR creation failed/)
    assert.equal(harness.events.includes('navigation-started'), false)
    assert.equal(harness.events.includes('timed-out'), true)
    assert.equal(harness.destroyCount, 1)
  } finally {
    Date.now = originalNow
  }
}

const testCleanupHasIndependentSettlementBudget = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  harness.loginSession.clearAuthCache = () => new Promise(() => {})
  harness.loginSession.clearStorageData = () => new Promise(() => {})
  harness.loginSession.clearCache = () => new Promise(() => {})
  const diagnostics = []
  const authSession = await createSession(new AbortController(), {
    cleanupTimeoutMs: 15,
    onDiagnostic: event => diagnostics.push(event),
  })

  const startedAt = Date.now()
  await withWatchdog(
    authSession.destroy(),
    250,
    'partition cleanup did not settle within its test budget',
  )
  assert.ok(Date.now() - startedAt < 250)
  assert.equal(harness.destroyCount, 1)
  assert.equal(
    diagnostics.some(event => event.stage == 'partition-cleanup-timed-out'),
    true,
  )
  assert.doesNotMatch(
    JSON.stringify(diagnostics),
    /https?:|base64|cookie|qq-music-login:|authorizeUrl|target/i,
  )
}

const testDestroyReusesCleanupPromise = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const cleanupGate = deferred()
  const cleanupCalls = {
    auth: 0,
    storage: 0,
    cache: 0,
    code: 0,
  }
  harness.loginSession.clearCodeCaches = async() => { cleanupCalls.code++; await cleanupGate.promise }
  harness.loginSession.clearAuthCache = async() => {
    cleanupCalls.auth++
    await cleanupGate.promise
  }
  harness.loginSession.clearStorageData = async options => {
    assert.deepEqual(options, { storages: ['cachestorage'] })
    cleanupCalls.storage++
    await cleanupGate.promise
  }
  harness.loginSession.clearCache = async() => {
    cleanupCalls.cache++
    await cleanupGate.promise
  }
  const authSession = await createSession(new AbortController(), {
    cleanupTimeoutMs: 1_000,
  })

  const firstCleanup = authSession.destroy()
  const repeatedCleanup = authSession.destroy()

  assert.strictEqual(repeatedCleanup, firstCleanup)
  assert.equal(harness.destroyCount, 1)
  await settle()
  assert.deepEqual(cleanupCalls, { auth: 0, storage: 1, cache: 1, code: 1 })

  cleanupGate.resolve()
  await withWatchdog(firstCleanup, 250, 'partition cleanup did not settle')
  assert.strictEqual(authSession.destroy(), firstCleanup)
  assert.deepEqual(cleanupCalls, { auth: 0, storage: 1, cache: 1, code: 1 })
  assert.equal(harness.destroyCount, 1)
}

const testAbortDuringFrameDiscoveryDestroysOnce = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  harness.webContents.mainFrame.frames = []
  const controller = new AbortController()
  const pending = createSession(controller)
  await settle()
  assert.equal(harness.events.includes('navigation-started'), true)

  controller.abort()
  await assert.rejects(pending, /QQ Music login QR creation failed/)
  assert.equal(harness.destroyCount, 1)
}

const testAbortDuringCaptureDestroysOnce = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const capture = deferred()
  harness.webContents.capturePage = () => capture.promise
  const controller = new AbortController()
  const pending = createSession(controller)
  await settle()
  assert.equal(harness.events.includes('qr-image-ready'), true)

  controller.abort()
  await assert.rejects(pending, /QQ Music login QR creation failed/)
  assert.equal(harness.destroyCount, 1)
  capture.resolve({
    isEmpty: () => false,
    toDataURL: () => 'data:image/png;base64,late',
  })
  await settle()
  assert.equal(harness.destroyCount, 1)
}

const testFatalLoadInterruptsHungCapture = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const capture = deferred()
  harness.webContents.capturePage = () => capture.promise
  const pending = createSession(new AbortController())
  await settle()
  assert.equal(harness.events.includes('qr-image-ready'), true)

  harness.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'ERR_NAME_NOT_RESOLVED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  await assert.rejects(pending, /QQ Music login QR creation failed/)
  assert.equal(harness.destroyCount, 1)
  capture.resolve({
    isEmpty: () => false,
    toDataURL: () => 'data:image/png;base64,late',
  })
}

const testExpectedInitialAbortEventIsOneShot = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const authSession = await createSession(new AbortController())
  harness.webContents.emit(
    'will-redirect',
    { preventDefault() {} },
    'https://graph.qq.com/oauth2.0/authorize',
    false,
    true,
  )
  harness.webContents.emit(
    'did-fail-load',
    {},
    -3,
    'ERR_ABORTED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  await settle()
  assert.equal((await authSession.check()).state, 'waiting')
  assert.equal(harness.destroyCount, 0)

  const error = new Error('ERR_ABORTED')
  error.code = 'ERR_ABORTED'
  error.errno = -3
  harness.navigation.reject(error)
  await settle()
  assert.equal((await authSession.check()).state, 'waiting')

  harness.webContents.emit(
    'did-fail-load',
    {},
    -3,
    'ERR_ABORTED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  await settle()
  assert.equal((await authSession.check()).state, 'expired')
  assert.equal(harness.destroyCount, 1)
}

const testSubframeCannotArmInitialAbortExemption = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const authSession = await createSession(new AbortController())
  harness.webContents.emit('will-frame-navigate', {
    preventDefault() {},
    url: 'https://graph.qq.com/oauth2.0/authorize',
    isMainFrame: false,
  })
  const error = new Error('ERR_ABORTED')
  error.code = 'ERR_ABORTED'
  error.errno = -3
  harness.navigation.reject(error)
  await settle()

  assert.equal((await authSession.check()).state, 'expired')
  assert.equal(harness.destroyCount, 1)
}

const testUnexpectedWindowCloseIsTerminal = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const authSession = await createSession(new AbortController())
  harness.window.emit('closed')
  await settle()

  assert.equal((await authSession.check()).state, 'expired')
  assert.equal(harness.destroyCount, 1)
}

const testTerminalDuringCookieReadCannotReturnCredentials = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const cookieGate = deferred()
  let cookieReads = 0
  harness.loginSession.cookies.get = async() => {
    cookieReads++
    return cookieGate.promise
  }
  const authSession = await createSession(new AbortController())
  const checking = authSession.check()
  await Promise.resolve()
  assert.equal(cookieReads, 1)

  harness.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'ERR_NAME_NOT_RESOLVED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  cookieGate.resolve([
    { name: 'uin', value: 'o123', domain: '.qq.com' },
    { name: 'qqmusic_key', value: 'must-not-escape', domain: '.qq.com' },
  ])
  const result = await checking

  assert.deepEqual(result, {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.equal(Object.hasOwn(result, 'cookie'), false)
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape/)
  assert.equal(harness.destroyCount, 1)
}

const testTerminalDuringCookieRejectionIsExpired = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const cookieGate = deferred()
  harness.loginSession.cookies.get = async() => cookieGate.promise
  const authSession = await createSession(new AbortController())
  const checking = authSession.check()
  await Promise.resolve()

  harness.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'ERR_NAME_NOT_RESOLVED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  cookieGate.reject(new Error('must-not-escape'))
  const result = await checking

  assert.deepEqual(result, {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.doesNotMatch(JSON.stringify(result), /must-not-escape/)
  assert.equal(harness.destroyCount, 1)
}

const testTerminalDuringFrameStateRejectionIsExpired = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const authSession = await createSession(new AbortController())
  const stateGate = deferred()
  let stateReads = 0
  harness.frame.executeJavaScript = async() => {
    stateReads++
    return stateGate.promise
  }
  const checking = authSession.check()
  await settle()
  assert.equal(stateReads, 1)

  harness.webContents.emit(
    'did-fail-load',
    {},
    -105,
    'ERR_NAME_NOT_RESOLVED',
    'https://graph.qq.com/oauth2.0/show',
    true,
  )
  stateGate.reject(new Error('detached status frame'))
  const result = await checking

  assert.deepEqual(result, {
    state: 'expired',
    message: '二维码已失效，请重新获取',
  })
  assert.equal(harness.destroyCount, 1)
}

const testCleanupSyncThrowIsContained = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const diagnostics = []
  let storageCalls = 0
  let cacheCalls = 0
  harness.loginSession.clearAuthCache = () => {
    throw new Error('synchronous cleanup failure')
  }
  harness.loginSession.clearStorageData = async() => {
    storageCalls++
  }
  harness.loginSession.clearCache = async() => {
    cacheCalls++
  }
  const authSession = await createSession(new AbortController(), {
    onDiagnostic: event => diagnostics.push(event),
  })

  await withWatchdog(
    authSession.destroy(),
    250,
    'synchronous cleanup throw escaped bounded settlement',
  )
  assert.equal(storageCalls, 1)
  assert.equal(cacheCalls, 1)
  assert.equal(
    diagnostics.some(event => event.stage == 'partition-cleanup-completed'),
    true,
  )
  assert.doesNotMatch(
    JSON.stringify(diagnostics),
    /synchronous cleanup failure/,
  )
  assert.equal(harness.destroyCount, 1)
}

const testCancellationThenLoadRejectionStaysNonterminal = async() => {
  harness = createHarness()
  harness.proxyGate.resolve()
  const diagnostics = []
  const controller = new AbortController()
  const authSession = await createSession(controller, {
    onDiagnostic: event => diagnostics.push(event),
  })

  controller.abort()
  const error = new Error('ERR_ABORTED')
  error.code = 'ERR_ABORTED'
  error.errno = -3
  harness.navigation.reject(error)
  await settle()

  assert.equal(
    diagnostics.some(event => event.stage == 'terminal-failure'),
    false,
  )
  assert.equal((await authSession.check()).state, 'expired')
  assert.equal(harness.destroyCount, 1)
}

const main = async() => {
  await testProxyPrecedesNavigation()
  await testDirectModePrecedesNavigation()
  await testQrReturnsWhileLoadIsPending()
  await testAllowedAbortIsObservedAndNonterminal()
  await testTransientFrameDetachKeepsDiscovering()
  await testPreCancelledCreationObservesLateProxyRejection()
  await testExpiredCreationObservesLateProxyRejection()
  await testFatalMainFrameFailureExpiresCapturedQr()
  await testAbortDuringProxySetupDestroysOnce()
  await testOneDeadlineIncludesProxySetup()
  await testStageSettlementAfterDeadlineCannotWin()
  await testCleanupHasIndependentSettlementBudget()
  await testDestroyReusesCleanupPromise()
  await testAbortDuringFrameDiscoveryDestroysOnce()
  await testAbortDuringCaptureDestroysOnce()
  await testFatalLoadInterruptsHungCapture()
  await testExpectedInitialAbortEventIsOneShot()
  await testSubframeCannotArmInitialAbortExemption()
  await testUnexpectedWindowCloseIsTerminal()
  await testTerminalDuringCookieReadCannotReturnCredentials()
  await testTerminalDuringCookieRejectionIsExpired()
  await testTerminalDuringFrameStateRejectionIsExpired()
  await testCleanupSyncThrowIsContained()
  await testCancellationThenLoadRejectionStaysNonterminal()
  console.log('QQ Music browser auth lifecycle tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
