const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const registryPath = path.join(__dirname, '../../src/main/services/sessionRegistry.ts')

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

const isSettled = async promise => Promise.race([
  promise.then(() => true, () => true),
  new Promise(resolve => setImmediate(() => resolve(false))),
])

const createSession = ({ failures = {}, firstCacheGate } = {}) => {
  const state = {
    cookies: [{ name: 'uin', value: '123' }],
    localStorage: { token: 'keep-me' },
  }
  const calls = []
  return {
    calls,
    state,
    cookies: { get: async() => state.cookies },
    async clearCache() {
      calls.push('clearCache')
      if (firstCacheGate) await firstCacheGate.promise
      if (failures.cache) throw new Error('private cache failure')
    },
    async clearStorageData(options) {
      calls.push(options ? `clearStorageData:${options.storages.join(',')}` : 'clearStorageData:all')
      if (!options || options.storages.includes('localstorage')) state.localStorage = {}
      if (failures.storage) throw new Error('private storage failure')
    },
    async clearCodeCaches(options) {
      calls.push(`clearCodeCaches:${JSON.stringify(options)}`)
      if (failures.code) throw new Error('private code failure')
    },
    async clearAuthCache() {
      calls.push('clearAuthCache')
    },
  }
}

const loadRegistry = () => loadTsModule(registryPath)

test('registration rejects unbounded or non-stable keys', () => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const session = createSession()

  for (const key of ['', 'user api:one', 'user-api/one', `user-api:${'a'.repeat(120)}`]) {
    assert.throws(() => registry.register({ key, session }), /invalid_session_registry_key/)
  }
})

test('exact-pair registrations deduplicate clearing and retain matching tokens', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const session = createSession()
  const first = registry.register({ key: 'user-api:one', session })
  const second = registry.register({ key: 'user-api:one', session })

  first.unregister()
  first.unregister()
  await registry.clearRegisteredCaches()
  assert.equal(session.calls.filter(call => call == 'clearCache').length, 1)

  second.unregister()
  await registry.clearRegisteredCaches()
  assert.equal(session.calls.filter(call => call == 'clearCache').length, 1)
})

test('key and session identity collisions are rejected without exposing either identity', () => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const firstSession = createSession()
  const secondSession = createSession()
  registry.register({ key: 'user-api:one', session: firstSession })

  assert.throws(
    () => registry.register({ key: 'user-api:one', session: secondSession }),
    error => error.message == 'session_registry_key_collision',
  )
  assert.throws(
    () => registry.register({ key: 'user-api:two', session: firstSession }),
    error => error.message == 'session_registry_identity_collision',
  )
})

test('an old matching token cannot unregister a later owner of the same key', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const oldSession = createSession()
  const old = registry.register({ key: 'user-api:one', session: oldSession })
  old.unregister()
  const currentSession = createSession()
  registry.register({ key: 'user-api:one', session: currentSession })

  old.unregister()
  await registry.clearRegisteredCaches()

  assert.deepEqual(oldSession.calls, [])
  assert.deepEqual(currentSession.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches:{}',
  ])
})

test('clearing invokes only the three cache categories in order and preserves cookies and local storage', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const session = createSession()
  registry.register({ key: 'main:win-main', session })
  const cookieFixture = await session.cookies.get({})
  const localStorageFixture = { ...session.state.localStorage }

  const results = await registry.clearRegisteredCaches()

  assert.deepEqual(session.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches:{}',
  ])
  assert.deepEqual(results, [
    { key: 'main:win-main', category: 'cache', status: 'cleared' },
    { key: 'main:win-main', category: 'cache-storage', status: 'cleared' },
    { key: 'main:win-main', category: 'code-cache', status: 'cleared' },
  ])
  assert.deepEqual(await session.cookies.get({}), cookieFixture)
  assert.deepEqual(session.state.localStorage, localStorageFixture)
})

test('category failures are fixed diagnostics and do not skip later categories or sessions', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const failing = createSession({ failures: { cache: true, storage: true } })
  const healthy = createSession()
  registry.register({ key: 'user-api:failing', session: failing })
  registry.register({ key: 'user-api:healthy', session: healthy })

  const results = await registry.clearRegisteredCaches()

  assert.deepEqual(failing.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches:{}',
  ])
  assert.deepEqual(healthy.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches:{}',
  ])
  assert.deepEqual(results.filter(result => result.status == 'failed'), [
    { key: 'user-api:failing', category: 'cache', status: 'failed', code: 'session_cache_clear_failed' },
    { key: 'user-api:failing', category: 'cache-storage', status: 'failed', code: 'session_cache_clear_failed' },
  ])
  assert.equal(JSON.stringify(results).includes('private'), false)
})

test('concurrent clear callers receive the same single-flight promise and one clear', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const gate = deferred()
  const session = createSession({ firstCacheGate: gate })
  registry.register({ key: 'main:win-main', session })

  const first = registry.clearRegisteredCaches()
  const second = registry.clearRegisteredCaches()
  assert.strictEqual(first, second)
  gate.resolve()
  assert.strictEqual(await first, await second)
  assert.equal(session.calls.filter(call => call == 'clearCache').length, 1)
})

test('a session registered midway stays behind the barrier until its categories are cleared', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const gate = deferred()
  const firstSession = createSession({ firstCacheGate: gate })
  registry.register({ key: 'main:win-main', session: firstSession })

  const clearing = registry.clearRegisteredCaches()
  while (!firstSession.calls.length) await new Promise(resolve => setImmediate(resolve))
  const lateSession = createSession()
  const late = registry.register({ key: 'user-api:late', session: lateSession })
  assert.equal(await isSettled(late.ready), false)

  gate.resolve()
  await clearing
  await late.ready
  assert.deepEqual(lateSession.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches:{}',
  ])
})

test('a registration queued at final category completion is admitted before atomic barrier release', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const firstSession = createSession()
  registry.register({ key: 'main:win-main', session: firstSession })
  const lateSession = createSession()
  let late
  const originalThen = Promise.prototype.then
  let interceptFinalizer = true
  Promise.prototype.then = function(onFulfilled, onRejected) {
    if (!interceptFinalizer || !String(onFulfilled).includes('activeClear')) {
      return originalThen.call(this, onFulfilled, onRejected)
    }
    interceptFinalizer = false
    return originalThen.call(this, value => {
      late = registry.register({ key: 'user-api:release-race', session: lateSession })
      return onFulfilled?.(value)
    }, onRejected)
  }
  let clearing
  try {
    clearing = registry.clearRegisteredCaches()
  } finally {
    Promise.prototype.then = originalThen
  }
  if (interceptFinalizer) {
    late = registry.register({ key: 'user-api:release-race', session: lateSession })
  }
  await clearing
  await late.ready

  assert.deepEqual(lateSession.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches:{}',
  ])
})

test('an admitted exact pair can revive after disposal without a duplicate clear', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const gate = deferred()
  const session = createSession({ firstCacheGate: gate })
  const original = registry.register({ key: 'user-api:one', session })
  const clearing = registry.clearRegisteredCaches()
  while (!session.calls.length) await new Promise(resolve => setImmediate(resolve))
  original.unregister()

  const revived = registry.register({ key: 'user-api:one', session })
  gate.resolve()
  const results = await clearing
  await revived.ready

  assert.equal(session.calls.filter(call => call == 'clearCache').length, 1)
  assert.equal(results.length, 3)
})

test('admitted key and identity bindings remain reserved until barrier release', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const gate = deferred()
  const session = createSession({ firstCacheGate: gate })
  const original = registry.register({ key: 'user-api:one', session })
  const clearing = registry.clearRegisteredCaches()
  while (!session.calls.length) await new Promise(resolve => setImmediate(resolve))
  original.unregister()

  assert.throws(
    () => registry.register({ key: 'user-api:one', session: createSession() }),
    error => error.message == 'session_registry_key_collision',
  )
  assert.throws(
    () => registry.register({ key: 'user-api:two', session }),
    error => error.message == 'session_registry_identity_collision',
  )
  gate.resolve()
  await clearing
})

const createRuntimeHarness = ({ ready = Promise.resolve(), destroyFailures = 0 } = {}) => {
  const { createRuntimeWindowHarness } = require('../test-utils/playback-fallback-harness')
  const registrations = []
  let remainingDestroyFailures = destroyFailures
  const harness = createRuntimeWindowHarness({ destroyFailures: remainingDestroyFailures })
  harness.deps.sessionRegistry = {
    register(input) {
      const registration = { input, unregisterCalls: 0 }
      registrations.push(registration)
      return {
        ready,
        unregister() { registration.unregisterCalls++ },
      }
    },
  }
  return { harness, registrations }
}

test('User API normal ownership awaits readiness and unregisters after successful disposal', async() => {
  const gate = deferred()
  const { harness, registrations } = createRuntimeHarness({ ready: gate.promise })
  const creating = harness.create({ id: 'user_api/a' }, 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(harness.windows.length, 0)
  gate.resolve()
  const runtime = await creating
  assert.match(registrations[0].input.key, /^user-api:[0-9a-f]{32}$/)
  assert.strictEqual(registrations[0].input.session, runtime.session)

  await harness.dispose(runtime, { clearSession: false })
  assert.equal(registrations[0].unregisterCalls, 1)
})

test('User API creation and disposal failures retain ownership until matching cleanup succeeds', async() => {
  const { harness, registrations } = createRuntimeHarness()
  const runtime = await harness.create({ id: 'user_api/a' }, 1)
  const originalDestroy = runtime.window.destroy.bind(runtime.window)
  let fail = true
  runtime.window.destroy = () => {
    if (fail) throw new Error('destroy failed')
    originalDestroy()
  }

  await assert.rejects(harness.dispose(runtime, { clearSession: false }), /destroy failed/)
  assert.equal(registrations[0].unregisterCalls, 0)
  fail = false
  await harness.dispose(runtime, { clearSession: false })
  assert.equal(registrations[0].unregisterCalls, 1)

  const readFailure = createRuntimeHarness()
  readFailure.harness.deps.readRuntimeHtml = async() => { throw new Error('read failed') }
  await assert.rejects(readFailure.harness.create({ id: 'user_api/b' }, 1), /read failed/)
  assert.equal(readFailure.registrations[0].unregisterCalls, 1)
})

test('an externally closed User API window releases its encapsulated registration', async() => {
  const { harness, registrations } = createRuntimeHarness()
  const runtime = await harness.create({ id: 'user_api/a' }, 1)

  runtime.window.destroy()

  assert.equal(registrations[0].unregisterCalls, 1)
})

test('User API no-window session clearing registers, awaits, narrows clearing, and unregisters', async() => {
  const gate = deferred()
  const { harness, registrations } = createRuntimeHarness({ ready: gate.promise })
  const clearing = harness.runtimeWindow.clearRuntimeSession('user_api/never-opened', harness.deps)
  await new Promise(resolve => setImmediate(resolve))
  const ownedSession = registrations[0].input.session
  assert.deepEqual(ownedSession.cleanupCalls, [])

  gate.resolve()
  await clearing
  assert.deepEqual(ownedSession.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
  assert.equal(registrations[0].unregisterCalls, 1)
})

test('User API no-window category failures keep fixed diagnostics and release ownership', async() => {
  const { harness, registrations } = createRuntimeHarness()
  const diagnostics = []
  harness.deps.logError = (...values) => diagnostics.push(values)
  const session = harness.deps.fromPartition('starky-lx-user-api-override')
  session.clearCache = async() => { throw new Error('private partition path') }
  const originalFromPartition = harness.deps.fromPartition
  harness.deps.fromPartition = () => session

  await harness.runtimeWindow.clearRuntimeSession('user_api/failing', harness.deps)

  harness.deps.fromPartition = originalFromPartition
  assert.deepEqual(diagnostics, [['session_cache_clear_failed', 'cache']])
  assert.equal(registrations[0].unregisterCalls, 1)
})

test('main window construction waits for readiness and releases its matching token on close', async() => {
  const gate = deferred()
  const registrations = []
  const windows = []
  const targetSession = {}
  class FakeWindow {
    constructor(options) {
      this.options = options
      this.listeners = new Map()
      this.webContents = { isDestroyed: () => false }
      windows.push(this)
    }
    on(name, listener) { this.listeners.set(name, listener) }
    once(name, listener) { this.listeners.set(name, listener) }
    async loadURL() {}
    isDestroyed() { return false }
    close() {}
    emit(name) { this.listeners.get(name)?.() }
  }
  global.envParams = { cmdParams: { dt: true } }
  global.lx = {
    sessionRegistry: {
      register(input) {
        const item = { input, unregisterCalls: 0 }
        registrations.push(item)
        return { ready: gate.promise, unregister: () => { item.unregisterCalls++ } }
      },
    },
    appSetting: { 'common.windowSizeId': 0, 'common.startInFullscreen': false },
    theme: { shouldUseDarkColors: false, theme: { colors: { '--color-primary-light-1000': '#fff' } } },
    event_app: { main_window_created() {} },
  }
  const main = loadTsModule(path.join(__dirname, '../../src/main/modules/winMain/main.ts'), {
    electron: { BrowserWindow: FakeWindow, dialog: {}, session: { fromPartition: () => targetSession } },
    'node:path': { join: (...parts) => parts.join('/') },
    './utils': { createTaskBarButtons() {}, getWindowSizeInfo: () => ({ width: 800, height: 600 }) },
    '@common/utils': { getPlatform: () => 'win32', isLinux: false, isWin: true },
    '@main/utils': { getProxy: () => null, openDevTools() {} },
    '@main/utils/sessionProxy': { configureSessionProxy: async() => {} },
    '@common/mainIpc': { mainSend() {} },
    './rendererEvent': { sendFocus() {}, sendTaskbarButtonClick() {} },
    '@common/utils/electron': { encodePath: value => value },
  })

  const creating = main.createWindow()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.length, 0)
  gate.resolve()
  await creating
  assert.equal(windows.length, 1)
  assert.deepEqual(registrations[0].input, { key: 'main:win-main', session: targetSession })
  windows[0].emit('closed')
  assert.equal(registrations[0].unregisterCalls, 1)
})

test('the main app event owner observes creation rejection using only the fixed code', async() => {
  const listeners = new Map()
  const errors = []
  global.lx = {
    appSetting: { 'player.isShowTaskProgess': false },
    hotKey: { config: { global: { keys: {} } } },
    event_app: { on: (name, listener) => listeners.set(name, listener) },
    player_status: { duration: 0 },
  }
  const module = loadTsModule(path.join(__dirname, '../../src/main/modules/winMain/index.ts'), {
    './rendererEvent': Object.assign(() => {}, { handleKeyDown() {}, hotKeyConfigUpdate() {} }),
    '@common/constants': { APP_EVENT_NAMES: { winMainName: 'main' } },
    './main': {
      createWindow: async() => { throw new Error('secret partition collision') },
      minimize() {}, setProgressBar() {}, setProxy() {}, setThumbarButtons() {}, toggleHide() {}, toggleMinimize() {},
    },
    '@common/hotKey': { HOTKEY_COMMON: { close: { action: 'close' }, hide_toggle: { action: 'hide' }, min: { action: 'min' }, min_toggle: { action: 'min-toggle' } } },
    '@main/app': { quitApp() {} },
  })
  const originalError = console.error
  console.error = value => errors.push(value)
  try {
    module.default()
    listeners.get('app_inited')()
    await new Promise(resolve => setImmediate(resolve))
  } finally {
    console.error = originalError
  }
  assert.deepEqual(errors, ['main_window_creation_failed'])
})

test('QQ transient cache:false sessions await readiness and unregister after idempotent disposal', async() => {
  const gate = deferred()
  const registrations = []
  const windows = []
  const fromPartitionCalls = []
  let navigationGuardFailure = false
  let proxyFailure = false
  let destroyFailures = 0
  const loginSession = {
    cookies: { get: async() => [] },
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    async clearStorageData() {}, async clearCache() {}, async clearCodeCaches() {},
  }
  class FakeWindow {
    constructor() {
      this.destroyed = false
      this.listeners = new Map()
      const frame = {
        url: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin',
        executeJavaScript: async() => ({ x: 1, y: 1, width: 20, height: 20, complete: true, naturalWidth: 20, naturalHeight: 20 }),
      }
      this.webContents = {
        mainFrame: { frames: [frame] },
        on() {}, removeListener() {}, setWindowOpenHandler() {},
        executeJavaScript: async() => ({ x: 10, y: 10, width: 100, height: 100 }),
        capturePage: async() => ({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,qr' }),
      }
      windows.push(this)
    }
    on(name, listener) { this.listeners.set(name, listener) }
    removeListener(name) { this.listeners.delete(name) }
    async loadURL() {}
    isDestroyed() { return this.destroyed }
    destroy() {
      if (destroyFailures > 0) {
        destroyFailures--
        throw new Error('private destroy failure')
      }
      this.destroyed = true
    }
  }
  global.lx = {
    sessionRegistry: {
      register(input) {
        const item = { input, unregisterCalls: 0 }
        registrations.push(item)
        return { ready: gate.promise, unregister: () => { item.unregisterCalls++ } }
      },
    },
  }
  const browserAuth = loadTsModule(path.join(__dirname, '../../src/main/modules/qqMusic/browserAuth.ts'), {
    electron: {
      BrowserWindow: FakeWindow,
      session: { fromPartition: (...args) => { fromPartitionCalls.push(args); return loginSession } },
    },
    '@main/utils/sessionProxy': {
      configureSessionProxy: async() => {
        if (proxyFailure) throw new Error('private proxy failure')
      },
    },
    '@main/utils/webContentsNavigationGuard': {
      registerWebContentsNavigationGuard: () => {
        if (navigationGuardFailure) throw new Error('private navigation guard failure')
        return () => {}
      },
    },
    './auth': { getQQMusicAccountUin: () => null },
  })
  const controller = new AbortController()
  const creating = browserAuth.createQQMusicBrowserAuthSession({
    signal: controller.signal, startedAt: Date.now(), deadlineAt: Date.now() + 5_000, proxy: null, onDiagnostic() {},
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(windows.length, 0)
  assert.equal(fromPartitionCalls[0][1].cache, false)
  gate.resolve()
  const auth = await creating
  assert.match(registrations[0].input.key, /^qq-music-auth:[0-9a-f-]+$/)
  assert.strictEqual(registrations[0].input.session, loginSession)

  const firstDestroy = auth.destroy()
  const secondDestroy = auth.destroy()
  assert.strictEqual(firstDestroy, secondDestroy)
  await firstDestroy
  assert.equal(registrations[0].unregisterCalls, 1)

  loginSession.setPermissionRequestHandler = () => { throw new Error('private setup failure') }
  const windowCount = windows.length
  await assert.rejects(
    browserAuth.createQQMusicBrowserAuthSession({
      signal: new AbortController().signal,
      startedAt: Date.now(),
      deadlineAt: Date.now() + 5_000,
      proxy: null,
      onDiagnostic() {},
    }),
    error => error.message == 'QQ Music login QR creation failed',
  )
  assert.equal(windows.length, windowCount)
  assert.equal(registrations[1].unregisterCalls, 1)

  loginSession.setPermissionRequestHandler = () => {}
  navigationGuardFailure = true
  await assert.rejects(
    browserAuth.createQQMusicBrowserAuthSession({
      signal: new AbortController().signal,
      startedAt: Date.now(),
      deadlineAt: Date.now() + 5_000,
      proxy: null,
      onDiagnostic() {},
    }),
    error => error.message == 'QQ Music login QR creation failed',
  )
  assert.equal(windows.at(-1).destroyed, true)
  assert.equal(registrations[2].unregisterCalls, 1)

  navigationGuardFailure = false
  proxyFailure = true
  destroyFailures = 1
  await assert.rejects(
    browserAuth.createQQMusicBrowserAuthSession({
      signal: new AbortController().signal,
      startedAt: Date.now(),
      deadlineAt: Date.now() + 5_000,
      proxy: null,
      onDiagnostic() {},
    }),
    error => error.message == 'QQ Music login QR creation failed',
  )
  assert.equal(windows.at(-1).destroyed, true)
  assert.equal(registrations[3].unregisterCalls, 1)
})
