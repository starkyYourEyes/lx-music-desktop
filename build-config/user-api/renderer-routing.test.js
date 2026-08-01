const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

test('renderer events preserve explicit owner-aware source routing across setting changes', async() => {
  const handlers = new Map()
  const calls = []
  const pool = {
    acceptInit: (senderId, params) => calls.push(['init', senderId, params]),
    acceptResponse: (senderId, params) => calls.push(['response', senderId, params]),
    handleOpenDevTools: (senderId, params) => calls.push(['open', senderId, params]),
    handleShowUpdateAlert: (senderId, params) => calls.push(['alert', senderId, params]),
    handleGetProxy: (senderId, params) => calls.push(['proxy', senderId, params]),
    request: async(params, ownerId) => {
      calls.push(['request', ownerId, params])
      return { ok: true, value: params.data }
    },
    cancel: (params, ownerId) => calls.push(['cancel', ownerId, params]),
    getStatus: apiId => ({ apiId, status: true }),
  }
  const eventModule = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/rendererEvent/rendererEvent.ts'), {
    '@common/mainIpc': { mainOn: (name, handler) => handlers.set(name, handler) },
    './name': {
      init: 'init', response: 'response', openDevTools: 'open', showUpdateAlert: 'alert', getProxy: 'proxy',
    },
    '../runtimePool': { getUserApiRuntimePool: () => pool },
  })

  eventModule.init(pool)
  handlers.get('proxy')({ event: { sender: { id: 22 } }, params: { identity: { apiId: 'user_api/b', generation: 1 } } })
  await eventModule.request({ apiId: 'user_api/a', requestId: 'source-request', data: 'source-data' }, 11)
  eventModule.cancelRequest({ apiId: 'user_api/a', requestId: 'source-request' }, 11)

  assert.deepEqual(calls, [
    ['proxy', 22, { identity: { apiId: 'user_api/b', generation: 1 } }],
    ['request', 11, { apiId: 'user_api/a', requestId: 'source-request', data: 'source-data' }],
    ['cancel', 11, { apiId: 'user_api/a', requestId: 'source-request' }],
  ])
})
