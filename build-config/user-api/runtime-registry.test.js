const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const loadMain = () => {
  const calls = []
  const listeners = new Map()
  const hooks = []
  let generation = 0
  const runtimeWindow = {
    createRuntimeWindow: async options => {
      hooks.push(options.hooks)
      const runtime = {
        identity: { apiId: options.apiInfo.id, generation: options.generation },
        window: { isDestroyed: () => false },
      }
      runtime.window.identity = runtime.identity
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
