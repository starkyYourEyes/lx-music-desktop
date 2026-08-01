const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const loadHandlers = () => {
  const handlers = new Map()
  const calls = []
  const parser = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/ipcValidation.ts'))
  const runtimePool = {
    getStatus() {}, ensure() {}, request() {}, cancel() {}, acquireLease() {}, releaseLease() {}, releaseOwner() {},
  }
  const register = loadTsModule(path.join(__dirname, '../../src/main/modules/winMain/rendererEvent/userApi.ts'), {
    '@common/ipcNames': {
      WIN_MAIN_RENDERER_EVENT_NAME: {
        import_user_api: 'import',
        replace_user_api_from_github: 'replace',
        remove_user_api: 'remove',
        set_user_api: 'set',
        get_user_api_list: 'list',
        get_user_api_status: 'status',
        user_api_set_allow_update_alert: 'allow',
        request_user_api: 'request',
        request_user_api_cancel: 'cancel',
        ensure_user_api: 'ensure',
        acquire_user_api_runtime: 'acquire',
        release_user_api_runtime: 'release',
        user_api_status: 'status-change',
        user_api_show_update_alert: 'show-alert',
      },
    },
    '@common/mainIpc': {
      mainHandle: (name, handler) => handlers.set(name, handler),
      mainOn: (name, handler) => handlers.set(name, handler),
    },
    '@common/utils': { log: { error() {} } },
    '@main/modules/userApi': {
      importApi() {},
      replaceApisFromGitHub() {},
      removeApi() {},
      setApi() {},
      getApiList() {},
      getStatus() {},
      setAllowShowUpdateAlert() {},
      takeReplacementFailureApiList() {},
      request: value => calls.push(['request', value]),
      cancelRequest: value => calls.push(['cancel', value]),
    },
    '@main/modules/userApi/ipcValidation': parser,
    '@main/modules/userApi/runtimeError': { normalizeRuntimeFailure: error => error },
    '@main/modules/userApi/runtimePool': { getUserApiRuntimePool: () => runtimePool },
    '@main/modules/winMain/main': { sendEvent() {} },
  }).default
  register()
  return { handlers, calls, sender: { id: 31, once() {} } }
}

test('rejects malformed user API request envelopes before dispatch without echoing data', async() => {
  const { handlers, calls, sender } = loadHandlers()
  const secret = 'request-data-must-not-appear'

  await assert.rejects(
    handlers.get('request')({ event: { sender }, params: { apiId: 'user_api/a', requestId: 'one', data: secret, extra: true } }),
    error => error.message == 'Invalid User API request payload' && !error.message.includes(secret),
  )
  await assert.rejects(
    handlers.get('request')({ event: { sender }, params: { requestKey: '', data: secret } }),
    /Invalid User API request payload/,
  )
  assert.deepEqual(calls, [])
})

test('rejects malformed user API cancellation envelopes before dispatch', async() => {
  const { handlers, calls, sender } = loadHandlers()
  await assert.rejects(
    async() => handlers.get('cancel')({ event: { sender }, params: { apiId: 'user_api/a', requestId: 'one', reason: 'nope' } }),
    /Invalid User API cancellation payload/,
  )
  await assert.rejects(async() => handlers.get('cancel')({ event: { sender }, params: { requestKey: 'old', extra: true } }), /Invalid User API cancellation payload/)
  assert.deepEqual(calls, [])
})
