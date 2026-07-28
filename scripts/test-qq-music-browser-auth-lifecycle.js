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

const main = async() => {
  await testProxyPrecedesNavigation()
  await testDirectModePrecedesNavigation()
  await testQrReturnsWhileLoadIsPending()
  await testAllowedAbortIsObservedAndNonterminal()
  await testTransientFrameDetachKeepsDiscovering()
  await testPreCancelledCreationObservesLateProxyRejection()
  await testExpiredCreationObservesLateProxyRejection()
  console.log('QQ Music browser auth lifecycle tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
