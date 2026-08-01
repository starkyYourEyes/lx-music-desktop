const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const { createPoolHarness } = require('../test-utils/playback-fallback-harness')

const removeEventName = 'remove_user_api'
const ensureEventName = 'ensure_user_api'
const createIpcNames = values => new Proxy(values, {
  get(target, property) {
    return Reflect.has(target, property) ? Reflect.get(target, property) : String(property)
  },
})
const winMainEventNames = createIpcNames({
  remove_user_api: removeEventName,
  ensure_user_api: ensureEventName,
})
const emptyEventNames = createIpcNames({})
const hotKeyGroup = new Proxy({}, {
  get(_target, property) {
    return { name: String(property), action: String(property) }
  },
})

const createMainRemoveHarness = removeImplementation => {
  const registeredHandlers = new Map()
  const retainedLists = new WeakMap()
  let nextRetainedList
  const runtimePool = {
    async releaseOwner() {},
    getStatus() {},
    request() {},
    async ensure() {},
    cancel() {},
    acquireLease() {},
    async releaseLease() {},
  }
  const runtime = loadTsModule(
    path.join(__dirname, '../../src/main/modules/winMain/rendererEvent/userApi.ts'),
    {
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: winMainEventNames },
      '@common/mainIpc': {
        mainHandle(name, handler) {
          registeredHandlers.set(name, handler)
        },
        mainOn() {},
      },
      '@common/utils': { log: { error() {} } },
      '@main/modules/userApi': {
        createReplacementFailureApiListCarrier: () => ({}),
        getApiList() {},
        importApi() {},
        replaceApisFromGitHub() {},
        async removeApi(apiIds, failureCarrier) {
          try {
            return await removeImplementation(apiIds)
          } catch (error) {
            if (nextRetainedList != null && failureCarrier != null) {
              retainedLists.set(failureCarrier, nextRetainedList)
              nextRetainedList = undefined
            }
            throw error
          }
        },
        setApi() {},
        setAllowShowUpdateAlert() {},
        takeReplacementFailureApiList(error) {
          const apiList = retainedLists.get(error)
          retainedLists.delete(error)
          return apiList
        },
      },
      '@main/modules/userApi/runtimeError': { normalizeRuntimeFailure: error => error },
      '@main/modules/userApi/runtimePool': { getUserApiRuntimePool: () => runtimePool },
      '@main/modules/winMain/main': { sendEvent() {} },
    },
  )
  runtime.default()
  const removeHandler = registeredHandlers.get(removeEventName)
  assert.equal(typeof removeHandler, 'function')
  return {
    invoke: apiIds => removeHandler({ params: apiIds }),
    retain(apiList) {
      nextRetainedList = apiList
    },
  }
}

const createRendererRemoveHarness = rendererInvoke => loadTsModule(
  path.join(__dirname, '../../src/renderer/utils/ipc.ts'),
  {
    '@common/rendererIpc': {
      rendererSend() {},
      rendererInvoke,
      rendererOn() {},
      rendererOff() {},
    },
    '@common/ipcNames': {
      HOTKEY_RENDERER_EVENT_NAME: emptyEventNames,
      WIN_MAIN_RENDERER_EVENT_NAME: winMainEventNames,
      CMMON_EVENT_NAME: emptyEventNames,
    },
    '@common/utils/vueTools': {
      markRaw: value => value,
      toRaw: value => value,
    },
    '@common/hotKey': {
      __esModule: true,
      HOTKEY_PLAYER: hotKeyGroup,
      HOTKEY_COMMON: hotKeyGroup,
      HOTKEY_DESKTOP_LYRIC: hotKeyGroup,
    },
    '@common/constants': {
      APP_EVENT_NAMES: { winMainName: 'main', winLyricName: 'lyric' },
      DATA_KEYS: {},
      DEFAULT_SETTING: {},
    },
  },
)

const createMainEnsureHarness = ensureImplementation => {
  const registeredHandlers = new Map()
  const runtimePool = {
    async releaseOwner() {},
    getStatus(apiId) { return { apiId, status: true } },
    request() {},
    ensure: ensureImplementation,
    cancel() {},
    acquireLease() {},
    async releaseLease() {},
  }
  const runtimeErrors = loadTsModule(path.join(
    __dirname,
    '../../src/main/modules/userApi/runtimeError.ts',
  ))
  const runtime = loadTsModule(
    path.join(__dirname, '../../src/main/modules/winMain/rendererEvent/userApi.ts'),
    {
      '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: winMainEventNames },
      '@common/mainIpc': {
        mainHandle(name, handler) { registeredHandlers.set(name, handler) },
        mainOn() {},
      },
      '@common/utils': { log: { error() {} } },
      '@main/modules/userApi': {
        createReplacementFailureApiListCarrier: () => ({}),
        getApiList() {},
        importApi() {},
        replaceApisFromGitHub() {},
        removeApi() {},
        setApi() {},
        setAllowShowUpdateAlert() {},
        takeReplacementFailureApiList() {},
      },
      '@main/modules/userApi/runtimeError': runtimeErrors,
      '@main/modules/userApi/runtimePool': { getUserApiRuntimePool: () => runtimePool },
      '@main/modules/winMain/main': { sendEvent() {} },
    },
  )
  runtime.default()
  const ensureHandler = registeredHandlers.get(ensureEventName)
  assert.equal(typeof ensureHandler, 'function')
  return apiId => ensureHandler({ params: apiId })
}

const retainedApiList = [{
  id: 'retained-source',
  name: 'Retained source',
  description: 'Committed after lifecycle failure',
  allowShowUpdateAlert: false,
}]

test('payload API identity cannot impersonate the bound sender', async() => {
  const harness = createPoolHarness()
  await harness.bind('a', 101, 1)
  const before = structuredClone(harness.pool.getStatus('a'))
  const accepted = harness.pool.acceptInit(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: { sources: {} },
  })
  assert.equal(accepted, false)
  assert.deepEqual(harness.pool.getStatus('a'), before)
})

test('cancel requires API ID request ID and owner webContents ID', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'r', data: {} }, 11)
  await harness.waitForPending('a', 'r')
  harness.pool.cancel({ apiId: 'a', requestId: 'r', reason: 'cancelled' }, 12)
  assert.equal(await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')]), 'pending')
  harness.pool.cancel({ apiId: 'a', requestId: 'r', reason: 'cancelled' }, 11)
  assert.equal((await pending).ok, false)
})

test('update alerts and developer tools use the trusted sender binding', async() => {
  const harness = createPoolHarness()
  await harness.bind('a', 101, 1, { name: 'Trusted A', allowShowUpdateAlert: true })
  harness.sendUpdateAlert(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: { log: 'release' },
  })
  harness.openDevTools(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: undefined,
  })
  harness.getProxy(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: undefined,
  })
  assert.deepEqual(harness.alerts, [])
  assert.deepEqual(harness.devToolsIds, [])
  assert.deepEqual(harness.proxyRecipients, [])
  harness.sendUpdateAlert(101, {
    identity: { apiId: 'a', generation: 1 }, status: true, data: { log: 'release' },
  })
  harness.openDevTools(101, {
    identity: { apiId: 'a', generation: 1 }, status: true, data: undefined,
  })
  harness.getProxy(101, {
    identity: { apiId: 'a', generation: 1 }, status: true, data: undefined,
  })
  assert.equal(harness.alerts[0].name, 'Trusted A')
  assert.deepEqual(harness.devToolsIds, ['a'])
  assert.deepEqual(harness.proxyRecipients, ['a'])
})

test('the ensure IPC response preserves a trusted initialization timeout kind', async() => {
  const timeoutFailure = {
    name: 'PlaybackSourceError',
    message: 'User API initialization timed out',
    scope: 'source',
    kind: 'timeout',
    apiId: 'a',
  }
  const invoke = createMainEnsureHarness(async() => { throw timeoutFailure })

  assert.deepEqual(await invoke('a'), { ok: false, error: timeoutFailure })
})

test('the ensure IPC response normalizes untrusted failures as initialization errors', async() => {
  const failure = Object.assign(new Error(`${'m'.repeat(1100)}\nprivate details`), {
    kind: 'timeout',
    arbitrary: 'must not cross IPC',
  })
  const invoke = createMainEnsureHarness(async() => { throw failure })

  const result = await invoke('a')
  assert.deepEqual(result, {
    ok: false,
    error: {
      name: 'PlaybackSourceError',
      message: 'm'.repeat(1024),
      scope: 'source',
      kind: 'initialization',
      apiId: 'a',
    },
  })
  assert.equal(Object.prototype.hasOwnProperty.call(result.error, 'arbitrary'), false)
})

test('direct delete main handler returns a structured success result', async() => {
  const removedApiList = [{
    id: 'remaining-source',
    name: 'Remaining source',
    description: 'Still installed',
    allowShowUpdateAlert: false,
  }]
  const harness = createMainRemoveHarness(async() => removedApiList)

  assert.deepEqual(await harness.invoke(['removed-source']), {
    success: true,
    apiList: removedApiList,
  })
})

test('direct delete main handler rethrows an ordinary failure unchanged', async() => {
  const failure = new Error('ordinary delete failure')
  const harness = createMainRemoveHarness(async() => { throw failure })

  await assert.rejects(() => harness.invoke(['source']), error => error === failure)
})

test('direct delete main handler returns and consumes a retained failure list', async() => {
  const failure = new Error('runtime close failed after delete commit')
  const harness = createMainRemoveHarness(async() => { throw failure })
  harness.retain(retainedApiList)

  assert.deepEqual(await harness.invoke(['source']), {
    success: false,
    apiList: retainedApiList,
    error: { message: failure.message },
  })
  await assert.rejects(() => harness.invoke(['source']), error => error === failure)
})

test('direct delete main handler bounds retained failure fields and excludes arbitrary data', async() => {
  const failure = Object.assign(new Error(`${'m'.repeat(600)}\nsecret script contents`), {
    code: 'c'.repeat(150),
    detail: 'd'.repeat(600),
    arbitrary: 'must not cross IPC',
  })
  const harness = createMainRemoveHarness(async() => { throw failure })
  harness.retain(retainedApiList)

  const result = await harness.invoke(['source'])
  assert.deepEqual(result, {
    success: false,
    apiList: retainedApiList,
    error: {
      message: 'm'.repeat(500),
      code: 'c'.repeat(100),
      detail: 'd'.repeat(500),
    },
  })
  assert.equal(Object.prototype.hasOwnProperty.call(result.error, 'arbitrary'), false)
})

test('direct delete renderer helper returns and publishes the committed success list', async() => {
  const result = { success: true, apiList: retainedApiList }
  const invocations = []
  const runtime = createRendererRemoveHarness(async(channel, apiIds) => {
    invocations.push({ channel, apiIds })
    return result
  })
  let publishedList

  const apiList = await runtime.removeUserApi(['source'], list => { publishedList = list })

  assert.equal(apiList, retainedApiList)
  assert.equal(publishedList, retainedApiList)
  assert.deepEqual(invocations, [{ channel: removeEventName, apiIds: ['source'] }])
})

test('direct delete renderer helper publishes a retained list before rejecting with bounded details', async() => {
  const events = []
  const serializedError = {
    message: 'runtime close failed after delete commit',
    code: 'USER_API_RUNTIME_CLOSE_FAILED',
    detail: 'retained-source',
  }
  const runtime = createRendererRemoveHarness(async() => ({
    success: false,
    apiList: retainedApiList,
    error: serializedError,
  }))

  await assert.rejects(
    () => runtime.removeUserApi(['source'], apiList => {
      events.push({ type: 'published', apiList })
    }),
    error => {
      events.push({ type: 'rejected', error })
      assert(error instanceof Error)
      assert.equal(error.message, serializedError.message)
      assert.equal(error.code, serializedError.code)
      assert.equal(error.detail, serializedError.detail)
      assert.equal(error.apiList, retainedApiList)
      return true
    },
  )
  assert.deepEqual(events.map(event => event.type), ['published', 'rejected'])
  assert.equal(events[0].apiList, retainedApiList)
})

test('direct delete renderer helper preserves an ordinary invoke rejection without publishing', async() => {
  const failure = new Error('IPC unavailable')
  const runtime = createRendererRemoveHarness(async() => { throw failure })
  let published = false

  await assert.rejects(
    () => runtime.removeUserApi(['source'], () => { published = true }),
    error => error === failure,
  )
  assert.equal(published, false)
})
