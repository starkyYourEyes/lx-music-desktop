const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

test('active runtime survives a failed close and can be retried', async() => {
  const calls = []
  let disposeFailures = 1
  const runtime = { identity: { apiId: 'user_api/a', generation: 1 }, window: { isDestroyed: () => false } }
  global.envParams = { cmdParams: {} }
  global.lx = {
    appSetting: { 'network.proxy.enable': false, 'network.proxy.host': '' },
    event_app: { on() {}, off() {} },
  }
  const main = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/main.ts'), {
    '@common/mainIpc': { mainSend: (_window, name, payload) => calls.push(['send', name, payload]) },
    '@common/utils': { log: { error() {} } },
    '@main/utils': { openDevTools() {} },
    './runtimeWindow': {
      createRuntimeWindow: async options => {
        calls.push(['create', options.apiInfo.id])
        return runtime
      },
      initializeRuntimeWindow: async(_runtime, apiInfo) => {
        calls.push(['initialize', apiInfo.id])
        return true
      },
      disposeRuntimeWindow: async(_runtime, options) => {
        calls.push(['dispose', options.clearSession])
        if (disposeFailures--) throw new Error('destroy failed')
      },
      clearRuntimeSession: async() => {},
      getRuntimePartition: () => 'partition',
    },
  })

  assert.equal(typeof main.createWindow, 'function')
  await main.createWindow({ id: 'user_api/a' })
  assert.deepEqual(calls.slice(0, 2), [['create', 'user_api/a'], ['initialize', 'user_api/a']])
  await assert.rejects(main.closeWindow(), /destroy failed/)
  main.sendEvent('userApi_request', { requestKey: 'retry' })
  await main.closeWindow()
  assert.deepEqual(calls.filter(([name]) => name == 'dispose'), [
    ['dispose', true],
    ['dispose', true],
  ])
  assert.deepEqual(calls.at(-1), ['dispose', true])
})
