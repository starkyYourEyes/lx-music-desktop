const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const registryPath = path.join(__dirname, '../../src/main/services/sessionRegistry.ts')
const defaultSessionLifetimePath = path.join(__dirname, '../../src/main/services/defaultSessionLifetime.ts')
const applicationPath = path.join(__dirname, '../../src/main/application.ts')

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
const loadDefaultSessionLifetime = () => loadTsModule(defaultSessionLifetimePath)

const createLifetimeFixture = () => {
  const ready = deferred()
  const registrations = []
  const registry = {
    register(input) {
      const registration = { input, unregisterCalls: 0 }
      registrations.push(registration)
      return {
        ready: ready.promise,
        unregister() { registration.unregisterCalls++ },
      }
    },
  }
  const { createDefaultSessionLifetime } = loadDefaultSessionLifetime()
  const defaultSession = createSession()
  return {
    defaultSession,
    lifetime: createDefaultSessionLifetime(registry),
    ready,
    registrations,
    async shutdown() {},
  }
}

const createApplicationHarness = () => {
  const appReady = deferred()
  const admissionReady = deferred()
  const registrations = []
  const startCallbacks = []
  let startCalls = 0
  const defaultSession = createSession()
  const coordinator = {
    async start() {
      startCalls++
      return { status: 'started' }
    },
    async shutdown() {},
  }
  const appListeners = new Map()
  const app = {
    whenReady: () => appReady.promise,
    on: (name, listener) => appListeners.set(name, listener),
    exit() {},
    quit() {},
  }
  const initGlobalData = () => {
    global.portableProfileStartup = null
    global.storagePaths = {
      cacheRoot: 'memory:cache',
      runtimeRoot: 'memory:runtime',
      profileRoot: 'memory:profile',
      backupsRoot: 'memory:backups',
    }
    global.lxOldDataPath = 'memory:legacy'
    global.lx = {
      worker: { dbService: {} },
      sessionRegistry: {
        register(input) {
          const registration = { input, unregisterCalls: 0 }
          registrations.push(registration)
          return {
            ready: admissionReady.promise,
            unregister() { registration.unregisterCalls++ },
          }
        },
      },
      cacheManager: null,
      storage: null,
      runTemp: null,
      themeAssets: null,
      credentialVault: {},
      accountRepository: {},
      event_app: { app_inited() {} },
    }
  }

  loadTsModule(applicationPath, {
    electron: { app, session: { defaultSession } },
    './utils/logInit': { initLog() {} },
    '@common/error': {},
    './app': {
      initGlobalData,
      initSingleInstanceHandle() {},
      applyElectronEnvParams() {},
      registerDeeplink: callback => startCallbacks.push(callback),
      listenerAppEvent: callback => startCallbacks.push(callback),
    },
    '@common/utils': { isLinux: false },
    '@main/app': {
      completePhase3StartupAttestation() {},
      initAppSetting() {},
      runPlaybackActivityMigration() {},
      runStorageMigrationHooks() {},
    },
    '@main/modules': () => {},
    '@main/utils/store': { flushStores() {} },
    '@main/startup/runState': { createRunState: () => ({}) },
    '@main/startup/storageCoordinator': {
      checkCredentialStartup() {},
      createStorageCoordinator: () => coordinator,
    },
    '@main/startup/recovery': { showStorageRecovery() {} },
    '@main/migration/legacyData/source': { readLegacyDataSource() {} },
    '@main/migration/portableProfile': { acknowledgePortableProfileStartup() {} },
    '@main/utils/tempLifecycle': { createRunTempHandle() {} },
    '@main/services/themeAssetManager': { createThemeAssetManager() {} },
    '@main/services/cacheManager': { createCacheManager: () => ({}) },
    '@main/services/defaultSessionLifetime': loadDefaultSessionLifetime(),
    '@common/storage/cache': { STORAGE_CACHE_GENERATION_EVENT: 'cache-generation' },
    '@main/modules/winMain/main': { sendEvent() {} },
  })

  return {
    admissionReady,
    appReady,
    defaultSession,
    registrations,
    startCallbacks,
    get startCalls() { return startCalls },
    beginShutdown() {
      const event = {
        prevented: false,
        preventDefault() { this.prevented = true },
      }
      appListeners.get('before-quit')(event)
      return event
    },
  }
}

test('admits the default session before application startup and never unregisters it', async() => {
  const fixture = createLifetimeFixture()
  const first = fixture.lifetime.admit(fixture.defaultSession)
  const second = fixture.lifetime.admit(fixture.defaultSession)

  assert.strictEqual(first, second)
  assert.deepEqual(Object.keys(fixture.lifetime), ['admit'])
  assert.equal(fixture.registrations.length, 1)
  assert.deepEqual(fixture.registrations[0].input, {
    key: 'electron:default',
    session: fixture.defaultSession,
  })
  fixture.ready.resolve()
  await first
  await fixture.shutdown()
  assert.equal(fixture.registrations[0].unregisterCalls, 0)
})

test('rejects a different default session after admission without replacing the lifetime owner', async() => {
  const fixture = createLifetimeFixture()
  const admitted = fixture.lifetime.admit(fixture.defaultSession)

  await assert.rejects(
    fixture.lifetime.admit(createSession()),
    error => error.message == 'default_session_changed',
  )
  assert.equal(fixture.registrations.length, 1)
  fixture.ready.resolve()
  await admitted
})

test('a clear started during shutdown still includes the lifetime default session', async() => {
  const { createSessionRegistry } = loadRegistry()
  const { createDefaultSessionLifetime } = loadDefaultSessionLifetime()
  const registry = createSessionRegistry()
  const clearGate = deferred()
  const defaultSession = createSession({ firstCacheGate: clearGate })
  let unregisterCalls = 0
  const lifetime = createDefaultSessionLifetime({
    register(input) {
      const registration = registry.register(input)
      return {
        ready: registration.ready,
        unregister() {
          unregisterCalls++
          registration.unregister()
        },
      }
    },
  })
  await lifetime.admit(defaultSession)

  const clearing = registry.clearRegisteredCaches()
  while (!defaultSession.calls.length) await new Promise(resolve => setImmediate(resolve))
  const beginShutdown = () => {}
  beginShutdown()
  clearGate.resolve()
  const results = await clearing

  assert.deepEqual(results, [
    { key: 'electron:default', category: 'cache', status: 'cleared' },
    { key: 'electron:default', category: 'cache-storage', status: 'cleared' },
    { key: 'electron:default', category: 'code-cache', status: 'cleared' },
  ])
  assert.equal(unregisterCalls, 0)
})

test('application startup callbacks wait for default-session admission after Electron readiness', async() => {
  const fixture = createApplicationHarness()
  assert.equal(fixture.startCallbacks.length, 2)
  assert.strictEqual(fixture.startCallbacks[0], fixture.startCallbacks[1])

  fixture.startCallbacks[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.startCalls, 0)
  assert.equal(fixture.registrations.length, 0)

  fixture.appReady.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.startCalls, 0)
  assert.equal(fixture.registrations.length, 1)
  assert.deepEqual(fixture.registrations[0].input, {
    key: 'electron:default',
    session: fixture.defaultSession,
  })

  fixture.startCallbacks[1]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.registrations.length, 1)
  assert.equal(fixture.startCalls, 0)

  fixture.admissionReady.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.startCalls, 3)
  const shutdownEvent = fixture.beginShutdown()
  assert.equal(shutdownEvent.prevented, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(fixture.registrations[0].unregisterCalls, 0)
})

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

test('User API disposal remains registered until its session cleanup finishes', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const { createRuntimeWindowHarness } = require('../test-utils/playback-fallback-harness')
  const harness = createRuntimeWindowHarness()
  harness.deps.sessionRegistry = registry
  const runtime = await harness.create({ id: 'user_api/owned-cleanup' }, 1)
  const cleanupGate = deferred()
  let cacheCalls = 0
  runtime.session.clearCache = async() => {
    cacheCalls++
    await cleanupGate.promise
  }

  const disposing = harness.dispose(runtime, { clearSession: true })
  while (cacheCalls < 1) await new Promise(resolve => setImmediate(resolve))
  const clearing = registry.clearRegisteredCaches()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(await isSettled(clearing), false)
  assert.equal(cacheCalls, 2)
  cleanupGate.resolve()
  await disposing
  const results = await clearing
  assert.deepEqual(results.map(result => result.category), ['cache', 'cache-storage', 'code-cache'])
})

test('User API cleanup after external close reacquires ownership for a concurrent registry clear', async() => {
  const { createSessionRegistry } = loadRegistry()
  const registry = createSessionRegistry()
  const { createRuntimeWindowHarness } = require('../test-utils/playback-fallback-harness')
  const harness = createRuntimeWindowHarness()
  harness.deps.sessionRegistry = registry
  const runtime = await harness.create({ id: 'user_api/closed-cleanup' }, 1)
  runtime.window.destroy()
  const cleanupGate = deferred()
  let cacheCalls = 0
  runtime.session.clearCache = async() => {
    cacheCalls++
    await cleanupGate.promise
  }

  const disposing = harness.dispose(runtime, { clearSession: true })
  while (cacheCalls < 1) await new Promise(resolve => setImmediate(resolve))
  const clearing = registry.clearRegisteredCaches()
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(await isSettled(clearing), false)
  assert.equal(cacheCalls, 2)
  cleanupGate.resolve()
  await disposing
  const results = await clearing
  assert.deepEqual(results.map(result => result.category), ['cache', 'cache-storage', 'code-cache'])
})

const createConcurrentDisposalHarness = async({ externallyClose = true } = {}) => {
  const { createRuntimeWindowHarness } = require('../test-utils/playback-fallback-harness')
  const harness = createRuntimeWindowHarness()
  const registrations = []
  let nextReady = Promise.resolve()
  harness.deps.sessionRegistry = {
    register(input) {
      const registration = { input, unregisterCalls: 0, ready: nextReady }
      registrations.push(registration)
      return {
        ready: registration.ready,
        unregister() { registration.unregisterCalls++ },
      }
    },
  }
  const runtime = await harness.create({ id: 'user_api/concurrent-disposal' }, 1)
  if (externallyClose) runtime.window.destroy()
  return {
    harness,
    registrations,
    runtime,
    setNextReady(ready) { nextReady = ready },
  }
}

test('concurrent User API cleanup after external close shares readiness and one disposal', async() => {
  const gate = deferred()
  const context = await createConcurrentDisposalHarness()
  context.setNextReady(gate.promise)

  const first = context.harness.dispose(context.runtime, { clearSession: true })
  const second = context.harness.dispose(context.runtime, { clearSession: true })
  await new Promise(resolve => setImmediate(resolve))

  assert.strictEqual(first, second)
  assert.deepEqual(context.runtime.session.cleanupCalls, [])
  assert.equal(context.registrations[1].unregisterCalls, 0)

  gate.resolve()
  await Promise.all([first, second])
  assert.deepEqual(context.runtime.session.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
  assert.equal(context.registrations[1].unregisterCalls, 1)
})

test('a concurrent cleanup request upgrades an in-flight disposal that began without clearing', async() => {
  const context = await createConcurrentDisposalHarness()

  const withoutCleanup = context.harness.dispose(context.runtime, { clearSession: false })
  const withCleanup = context.harness.dispose(context.runtime, { clearSession: true })

  assert.strictEqual(withoutCleanup, withCleanup)
  await withCleanup
  assert.deepEqual(context.runtime.session.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
  assert.equal(context.registrations[1].unregisterCalls, 1)
})

test('a next-microtask cleanup request joins a still-settling disposal', async() => {
  const context = await createConcurrentDisposalHarness()
  const withoutCleanup = context.harness.dispose(context.runtime, { clearSession: false })
  let firstSettled = false
  void withoutCleanup.then(() => { firstSettled = true })

  await Promise.resolve()
  assert.equal(firstSettled, false)
  const withCleanup = context.harness.dispose(context.runtime, { clearSession: true })

  assert.strictEqual(withoutCleanup, withCleanup)
  await withCleanup
  assert.deepEqual(context.runtime.session.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
  assert.equal(context.registrations[1].unregisterCalls, 1)
})

test('cleanup arriving after core teardown joins before final disposal settlement', async() => {
  const context = await createConcurrentDisposalHarness({ externallyClose: false })
  const withoutCleanup = context.harness.dispose(context.runtime, { clearSession: false })
  let firstSettled = false
  void withoutCleanup.then(() => { firstSettled = true })

  await Promise.resolve()
  assert.equal(context.runtime.window.isDestroyed(), true)
  assert.equal(firstSettled, false)
  const withCleanup = context.harness.dispose(context.runtime, { clearSession: true })

  assert.strictEqual(withoutCleanup, withCleanup)
  await withCleanup
  assert.deepEqual(context.runtime.session.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
  assert.equal(context.registrations.length, 1)
  assert.equal(context.registrations[0].unregisterCalls, 1)
})

test('shared User API disposal failure retains ownership and permits one later retry', async() => {
  const context = await createConcurrentDisposalHarness()
  const cleanupFailure = new Error('fixed cleanup observer failure')
  let shouldFail = true
  let cacheCalls = 0
  context.runtime.session.clearCache = async() => {
    cacheCalls++
    if (shouldFail) throw new Error('private cache failure')
  }
  context.harness.deps.logError = () => {
    if (shouldFail) throw cleanupFailure
  }

  const first = context.harness.dispose(context.runtime, { clearSession: true })
  const second = context.harness.dispose(context.runtime, { clearSession: true })
  assert.strictEqual(first, second)
  await assert.rejects(first, error => error === cleanupFailure)
  await assert.rejects(second, error => error === cleanupFailure)
  assert.equal(context.registrations[1].unregisterCalls, 0)
  assert.equal(cacheCalls, 1)

  shouldFail = false
  const retry = context.harness.dispose(context.runtime, { clearSession: true })
  assert.notStrictEqual(retry, first)
  await retry
  assert.equal(cacheCalls, 2)
  assert.equal(context.registrations.length, 2)
  assert.equal(context.registrations[1].unregisterCalls, 1)

  await context.harness.dispose(context.runtime, { clearSession: true })
  assert.equal(cacheCalls, 2)
  assert.equal(context.registrations[1].unregisterCalls, 1)
})

test('main window construction waits for readiness and releases its matching token on close', async() => {
  const gate = deferred()
  const registrations = []
  const windows = []
  const targetSession = {}
  let quitCalls = 0
  let closePreventCalls = 0
  let mainWindowCloseCalls = 0
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
    hide() { this.hideCalls = (this.hideCalls ?? 0) + 1 }
    setProgressBar() {}
    emit(name, ...args) { this.listeners.get(name)?.(...args) }
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
    appSetting: { 'common.windowSizeId': 0, 'common.startInFullscreen': false, 'tray.enable': false },
    isSkipTrayQuit: false,
    theme: { shouldUseDarkColors: false, theme: { colors: { '--color-primary-light-1000': '#fff' } } },
    event_app: { main_window_created() {}, main_window_close() { mainWindowCloseCalls++ } },
  }
  const main = loadTsModule(path.join(__dirname, '../../src/main/modules/winMain/main.ts'), {
    electron: { app: { quit() { quitCalls++ } }, BrowserWindow: FakeWindow, dialog: {}, session: { fromPartition: () => targetSession } },
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
  windows[0].emit('close', { preventDefault() { closePreventCalls++ } })
  assert.equal(closePreventCalls, 1)
  assert.equal(windows[0].hideCalls, 1)
  assert.equal(quitCalls, 1)
  assert.equal(mainWindowCloseCalls, 0)

  global.lx.isSkipTrayQuit = true
  windows[0].emit('close', { preventDefault() { closePreventCalls++ } })
  assert.equal(closePreventCalls, 1)
  assert.equal(windows[0].hideCalls, 1)
  assert.equal(quitCalls, 1)
  assert.equal(mainWindowCloseCalls, 1)
  windows[0].emit('closed')
  assert.equal(registrations[0].unregisterCalls, 1)
})

test('main load rollback failure retains ownership until a later successful close', async() => {
  const registrations = []
  const windows = []
  let destroyFailures = 1
  class FakeWindow {
    constructor() {
      this.destroyed = false
      this.listeners = new Map()
      this.webContents = { isDestroyed: () => false }
      windows.push(this)
    }
    on(name, listener) {
      let listeners = this.listeners.get(name)
      if (!listeners) this.listeners.set(name, listeners = new Set())
      listeners.add(listener)
    }
    once(name, listener) { this.on(name, listener) }
    async loadURL() { throw new Error('private load failure') }
    isDestroyed() { return this.destroyed }
    destroy() {
      if (destroyFailures > 0) {
        destroyFailures--
        throw new Error('private destroy failure')
      }
      this.destroyed = true
      this.emit('closed')
    }
    close() { this.destroy() }
    emit(name) {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener()
    }
  }
  global.envParams = { cmdParams: { dt: true } }
  global.lx = {
    sessionRegistry: {
      register() {
        const item = { unregisterCalls: 0 }
        registrations.push(item)
        return { ready: Promise.resolve(), unregister: () => { item.unregisterCalls++ } }
      },
    },
    appSetting: { 'common.windowSizeId': 0, 'common.startInFullscreen': false },
    theme: { shouldUseDarkColors: false, theme: { colors: { '--color-primary-light-1000': '#fff' } } },
    event_app: { main_window_created() {} },
  }
  const main = loadTsModule(path.join(__dirname, '../../src/main/modules/winMain/main.ts'), {
    electron: { BrowserWindow: FakeWindow, dialog: {}, session: { fromPartition: () => ({}) } },
    'node:path': { join: (...parts) => parts.join('/') },
    './utils': { createTaskBarButtons() {}, getWindowSizeInfo: () => ({ width: 800, height: 600 }) },
    '@common/utils': { getPlatform: () => 'win32', isLinux: false, isWin: true },
    '@main/utils': { getProxy: () => null, openDevTools() {} },
    '@main/utils/sessionProxy': { configureSessionProxy: async() => {} },
    '@common/mainIpc': { mainSend() {} },
    './rendererEvent': { sendFocus() {}, sendTaskbarButtonClick() {} },
    '@common/utils/electron': { encodePath: value => value },
  })

  await assert.rejects(main.createWindow(), error => error.message == 'main_window_creation_failed')
  assert.equal(registrations[0].unregisterCalls, 0)
  assert.equal(windows[0].destroyed, false)

  main.closeWindow()

  assert.equal(windows[0].destroyed, true)
  assert.equal(registrations[0].unregisterCalls, 1)
  assert.equal(main.isExistWindow(), false)
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
