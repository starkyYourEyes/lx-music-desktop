const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

test('source-aware renderer events route requests, proxy replies, and status to their owning runtime', async() => {
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  global.setTimeout = () => ({})
  global.clearTimeout = () => {}
  const handlers = new Map()
  const calls = []
  const statuses = []
  const apiA = { id: 'user_api/a', name: 'A', description: '', sources: {} }
  const apiB = { id: 'user_api/b', name: 'B', description: '', sources: {} }
  const eventModule = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/rendererEvent/rendererEvent.ts'), {
    '@common/mainIpc': { mainOn: (name, handler) => handlers.set(name, handler) },
    './name': { init: 'init', response: 'response', openDevTools: 'open', showUpdateAlert: 'alert', getProxy: 'proxy', request: 'request', proxyUpdate: 'proxy-update' },
    '../main': {
      createWindow: async() => {}, getProxy: () => ({ host: 'proxy.test', port: 8080 }), openDevTools() {}, sendEvent() {},
      createSourceRuntime: async() => {}, sendSourceEvent: (apiId, name, payload) => calls.push([apiId, name, payload]),
      getSourceRuntimeByWebContentsId: id => id == 1 ? { identity: { apiId: apiA.id, generation: 1 } } : { identity: { apiId: apiB.id, generation: 1 } },
    },
    '../utils': { getUserApis: () => [apiA, apiB] },
    '@main/modules/winMain': { sendShowUpdateAlert() {}, sendStatusChange: status => statuses.push(status) },
  })

  try {
    eventModule.init()
    const pending = eventModule.request({ apiId: apiA.id, requestId: 'request-a', data: { source: 'kw' } })
    await Promise.resolve()
    await Promise.resolve()
    handlers.get('proxy')({ event: { sender: { id: 2 } }, params: {} })
    handlers.get('init')({ event: { sender: { id: 1 } }, params: { status: true, message: '', data: { sources: {} } } })

    assert.deepEqual(calls.map(([apiId, name]) => [apiId, name]), [
      [apiA.id, 'request'],
      [apiB.id, 'proxy-update'],
    ])
    assert.deepEqual(statuses, [{ apiId: apiA.id, status: true, apiInfo: { ...apiA, sources: {} } }])
    eventModule.cancelRequest({ apiId: apiA.id, requestId: 'request-a' })
    await assert.rejects(pending, /Cancel request/)
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
})
