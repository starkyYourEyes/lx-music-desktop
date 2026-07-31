const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const { createRuntimeWindowHarness } = require('../test-utils/playback-fallback-harness')

const createDeferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const createRuntime = options => {
  const runtime = {
    identity: { apiId: options.apiInfo.id, generation: options.generation },
    window: { isDestroyed: () => false },
  }
  runtime.window.identity = runtime.identity
  return runtime
}

const loadMain = (overrides = {}) => {
  const calls = []
  const listeners = new Map()
  const hooks = []
  let generation = 0
  const runtimeWindow = {
    createRuntimeWindow: async options => {
      hooks.push(options.hooks)
      const runtime = createRuntime(options)
      calls.push(['create', runtime.identity])
      return runtime
    },
    initializeRuntimeWindow: async runtime => {
      calls.push(['initialize', runtime.identity])
      return true
    },
    disposeRuntimeWindow: async runtime => {
      calls.push(['dispose', runtime.identity])
    },
    clearRuntimeSession: async() => {},
    getRuntimePartition: () => 'partition',
    ...overrides,
  }
  global.envParams = { cmdParams: {} }
  global.lx = {
    appSetting: { 'network.proxy.enable': true, 'network.proxy.host': 'proxy.test', 'network.proxy.port': 8080 },
    event_app: {
      on(name, listener) { listeners.set(name, listener) },
      off(name, listener) { if (listeners.get(name) == listener) listeners.delete(name) },
    },
  }
  const main = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/main.ts'), {
    '@common/mainIpc': { mainSend: (window, name, payload) => calls.push(['send', window.identity, name, payload]) },
    '@common/utils': { log: { error() {} } },
    '@main/utils': { openDevTools() {} },
    './runtimeWindow': runtimeWindow,
  })
  return { main, calls, hooks, listeners, nextGeneration: () => ++generation }
}

test('source runtimes coexist and proxy updates target every registered source', async() => {
  const { main, calls, listeners } = loadMain()
  assert.equal(typeof main.createSourceRuntime, 'function')
  await main.createSourceRuntime({ id: 'user_api/a' })
  await main.createSourceRuntime({ id: 'user_api/b' })

  main.sendSourceEvent('user_api/a', 'userApi_request', { requestKey: 'a' })
  listeners.get('updated_config')(['network.proxy.host'])

  assert.deepEqual(calls.filter(([kind]) => kind == 'dispose'), [])
  assert.deepEqual(calls.filter(([, identity, name]) => name == 'userApi_request').map(([, identity]) => identity.apiId), ['user_api/a'])
  assert.deepEqual(calls.filter(([, identity, name]) => name == 'userApi_proxyUpdate').map(([, identity]) => identity.apiId).sort(), [
    'user_api/a',
    'user_api/b',
  ])
})

test('a stale close callback cannot remove a replacement source runtime', async() => {
  const { main, calls, hooks } = loadMain()
  assert.equal(typeof main.createSourceRuntime, 'function')
  await main.createSourceRuntime({ id: 'user_api/a' })
  await main.disposeSourceRuntime('user_api/a')
  await main.createSourceRuntime({ id: 'user_api/a' })

  hooks[0].onClosed({ apiId: 'user_api/a', generation: 1 })
  main.sendSourceEvent('user_api/a', 'userApi_request', { requestKey: 'new' })

  assert.deepEqual(calls.filter(([, identity, name]) => name == 'userApi_request').map(([, identity]) => identity), [
    { apiId: 'user_api/a', generation: 2 },
  ])
})

test('concurrent creation for one source returns one published runtime', async() => {
  const creation = createDeferred()
  const created = []
  const { main } = loadMain({
    createRuntimeWindow: async options => {
      const runtime = createRuntime(options)
      created.push(runtime)
      await creation.promise
      return runtime
    },
  })
  const apiInfo = { id: 'user_api/concurrent' }

  const first = main.createSourceRuntime(apiInfo)
  const second = main.createSourceRuntime(apiInfo)
  await Promise.resolve()
  creation.resolve()

  const [firstRuntime, secondRuntime] = await Promise.all([first, second])
  assert.strictEqual(firstRuntime, secondRuntime)
  assert.strictEqual(main.getSourceRuntime(apiInfo.id), firstRuntime)
  assert.equal(created.length, 1)
})

test('failed initialization is cleaned up and a later creation publishes a new runtime', async() => {
  const initializeFailure = new Error('initialization failed')
  const created = []
  const disposed = []
  let initializationAttempts = 0
  const { main, listeners } = loadMain({
    createRuntimeWindow: async options => {
      const runtime = createRuntime(options)
      created.push(runtime)
      return runtime
    },
    initializeRuntimeWindow: async() => {
      if (initializationAttempts++ == 0) throw initializeFailure
      return true
    },
    disposeRuntimeWindow: async runtime => {
      disposed.push(runtime)
    },
  })
  const apiInfo = { id: 'user_api/retry' }

  await assert.rejects(main.createSourceRuntime(apiInfo), error => error === initializeFailure)
  assert.equal(main.getSourceRuntime(apiInfo.id), null)
  assert.deepEqual(disposed, [created[0]])
  assert.equal(listeners.has('updated_config'), false)

  const runtime = await main.createSourceRuntime(apiInfo)
  assert.notStrictEqual(runtime, created[0])
  assert.strictEqual(main.getSourceRuntime(apiInfo.id), runtime)
  assert.equal(created.length, 2)
})

test('disposal waits for a pending creation before releasing its runtime', async() => {
  const creation = createDeferred()
  const disposed = []
  const { main, listeners } = loadMain({
    createRuntimeWindow: async options => {
      await creation.promise
      return createRuntime(options)
    },
    disposeRuntimeWindow: async runtime => {
      disposed.push(runtime)
    },
  })
  const apiInfo = { id: 'user_api/closing' }

  const creating = main.createSourceRuntime(apiInfo)
  const disposing = main.disposeSourceRuntime(apiInfo.id)
  creation.resolve()
  const [runtime] = await Promise.all([creating, disposing])

  assert.deepEqual(disposed, [runtime])
  assert.equal(main.getSourceRuntime(apiInfo.id), null)
  assert.equal(listeners.has('updated_config'), false)
})

test('initialization failure retains a cleanup-failed runtime until the next same-source creation retries it', async() => {
  const initializationFailure = new Error('initialization failed')
  const harness = createRuntimeWindowHarness({ destroyFailures: 1 })
  let initializationAttempts = 0
  global.envParams = { cmdParams: {} }
  global.lx = {
    appSetting: { 'network.proxy.enable': false, 'network.proxy.host': '' },
    event_app: { on() {}, off() {} },
  }
  const main = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/main.ts'), {
    '@common/mainIpc': { mainSend() {} },
    '@common/utils': { log: { error() {} } },
    '@main/utils': { openDevTools() {} },
    './runtimeWindow': {
      createRuntimeWindow: options => harness.runtimeWindow.createRuntimeWindow({ ...options, deps: harness.deps }),
      initializeRuntimeWindow: async(runtime, apiInfo) => {
        if (initializationAttempts++ == 0) throw initializationFailure
        return harness.runtimeWindow.initializeRuntimeWindow(runtime, apiInfo, harness.deps)
      },
      disposeRuntimeWindow: (runtime, options) => harness.runtimeWindow.disposeRuntimeWindow(runtime, options, harness.deps),
      clearRuntimeSession: async() => {},
      getRuntimePartition: () => 'partition',
    },
  })
  const apiInfo = { id: 'user_api/retry-cleanup', name: 'Retry', description: '', sources: {} }

  await assert.rejects(main.createSourceRuntime(apiInfo), error => error === initializationFailure)
  const failedWindow = harness.windows[0]
  assert.equal(failedWindow.destroyed, false)
  assert.equal(failedWindow.listenerCount('closed'), 1)

  const replacement = await main.createSourceRuntime(apiInfo)
  assert.equal(failedWindow.destroyed, true)
  assert.equal(harness.windows.length, 2)
  assert.strictEqual(main.getSourceRuntime(apiInfo.id), replacement)
})
