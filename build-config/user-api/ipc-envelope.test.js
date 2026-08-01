const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const loadHandlers = (options = {}) => {
  const handlers = new Map()
  const calls = []
  const parser = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/ipcValidation.ts'))
  const runtimePool = {
    getStatus(apiId) {
      calls.push(['status', apiId])
      return { apiId, status: true }
    },
    ensure(apiId) {
      calls.push(['ensure', apiId])
      if (options.ensureError) throw options.ensureError
    },
    request() {},
    cancel() {},
    acquireLease(params, ownerId) { calls.push(['acquire', params, ownerId]) },
    async releaseLease(params, ownerId) { calls.push(['release', params, ownerId]) },
    releaseOwner() {},
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
    '@main/modules/userApi/runtimeError': loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/runtimeError.ts')),
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

test('requires explicit source identity for requests and cancellation', () => {
  const parser = loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/ipcValidation.ts'))

  assert.throws(
    () => parser.parseUserApiRequestPayload({ requestKey: 'legacy-request', data: {} }),
    /Invalid User API request payload/,
  )
  assert.throws(
    () => parser.parseUserApiCancellationPayload('legacy-request'),
    /Invalid User API cancellation payload/,
  )
})

test('drops malformed user API cancellation envelopes before dispatch', () => {
  const { handlers, calls, sender } = loadHandlers()
  const hostile = { requestId: 'one' }
  Object.defineProperty(hostile, 'apiId', {
    enumerable: true,
    get() { throw new Error('cancellation secret') },
  })

  for (const params of [
    { apiId: 'user_api/a', requestId: 'one', reason: 'nope' },
    { apiId: 'user_api/a', requestId: 'one', extra: true },
    hostile,
    'legacy-request',
  ]) {
    assert.doesNotThrow(() => handlers.get('cancel')({ event: { sender }, params }))
  }
  assert.deepEqual(calls, [])
})

test('rejects malformed ensure IDs with a fixed error before pool dispatch', async() => {
  const { handlers, calls } = loadHandlers()
  const secret = `ensure-sentinel-${'x'.repeat(300)}`

  await assert.rejects(
    handlers.get('ensure')({ params: secret }),
    error => error.message == 'Invalid User API ensure payload' && !error.message.includes(secret),
  )
  await assert.rejects(
    handlers.get('ensure')({ params: { apiId: 'user_api/a', secret } }),
    error => error.message == 'Invalid User API ensure payload' && !error.message.includes(secret),
  )
  assert.deepEqual(calls, [])
})

test('ensure preserves a normalized playback source failure kind', async() => {
  const sourceFailure = Object.assign(new Error('User API source changed'), {
    name: 'PlaybackSourceError',
    scope: 'source',
    kind: 'sourceChanged',
    apiId: 'user_api/a',
  })
  const { handlers } = loadHandlers({ ensureError: sourceFailure })

  const result = await handlers.get('ensure')({ params: 'user_api/a' })

  assert.equal(result.ok, false)
  assert.equal(result.error.kind, 'sourceChanged')
  assert.equal(result.error.scope, 'source')
})

test('drops malformed runtime lease envelopes before acquire and release dispatch', () => {
  const { handlers, calls, sender } = loadHandlers()
  const secret = 'lease-payload-must-not-appear'
  const hostile = {}
  Object.defineProperty(hostile, 'apiIds', {
    enumerable: true,
    get() { throw new Error(secret) },
  })
  Object.defineProperty(hostile, 'leaseId', {
    enumerable: true,
    value: 'lease-1',
  })

  for (const name of ['acquire', 'release']) {
    assert.doesNotThrow(
      () => handlers.get(name)({
        event: { sender },
        params: { apiIds: ['user_api/a'], leaseId: 'lease-1', extra: secret },
      }),
    )
    assert.doesNotThrow(
      () => handlers.get(name)({ event: { sender }, params: hostile }),
    )
  }
  assert.deepEqual(calls, [])

  handlers.get('acquire')({
    event: { sender },
    params: { apiIds: ['user_api/a', 'user_api/b'], leaseId: 'lease-1' },
  })
  handlers.get('release')({
    event: { sender },
    params: { apiIds: ['user_api/a'], leaseId: 'lease-1' },
  })
  assert.deepEqual(calls, [
    ['acquire', { apiIds: ['user_api/a', 'user_api/b'], leaseId: 'lease-1' }, 31],
    ['release', { apiIds: ['user_api/a'], leaseId: 'lease-1' }, 31],
  ])
})
