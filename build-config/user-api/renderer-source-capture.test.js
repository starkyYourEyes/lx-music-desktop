const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const deferred = () => {
  let resolve
  const promise = new Promise(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

const createHarness = () => {
  const requests = []
  const cancellations = []
  const dialogs = []
  const appSetting = {
    'common.apiSource': 'user_api/a',
    'common.apiFallbackMode': false,
    'common.apiFallbackSources': [],
  }
  const userApi = {
    status: false,
    message: '',
    apis: {},
    list: [],
    listLoaded: false,
    runtimeStates: {},
    capabilities: {},
  }
  const qualityList = { value: {} }
  const requestResponse = deferred()
  let ensureCount = 0
  let ensureResult
  let statusListener
  const previousWindow = global.window
  global.window = {
    lx: { apiInitPromise: [null, true, () => {}] },
    setTimeout,
  }
  const ipc = {
    onUserApiStatus(listener) { statusListener = listener; return () => {} },
    getUserApiList: async() => [],
    onShowUserApiUpdateAlert: () => () => {},
    ensureUserApi: async apiId => {
      ensureCount++
      return ensureResult ?? {
        ok: true,
        value: { apiId, status: true, apiInfo: userApi.runtimeStates[apiId]?.apiInfo },
      }
    },
    sendUserApiRequest: async params => {
      requests.push(structuredClone(params))
      await requestResponse.promise
      return {
        ok: true,
        value: {
          source: params.data.source,
          action: params.data.action,
          data: { url: 'https://media.test/song' },
        },
      }
    },
    userApiRequestCancel: params => cancellations.push(structuredClone(params)),
  }
  const sourceSelectors = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/sourceSelectors.ts'),
  )
  const primarySource = loadTsModule(path.join(__dirname, '../../src/renderer/core/music/primarySource.ts'), {
    '@common/utils/playbackSourceError': loadTsModule(
      path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
    ),
    '@renderer/store': { qualityList, userApi },
    '@renderer/store/setting': { appSetting },
    '@renderer/utils/ipc': ipc,
    '@renderer/utils/musicSdk/api-source': { supportQuality: {} },
    './playback/sourceSelectors': sourceSelectors,
  })
  const module = loadTsModule(path.join(__dirname, '../../src/renderer/core/useApp/useInitUserApi.ts'), {
    '@common/utils/vueTools': {
      onBeforeUnmount() {},
      watch: (_source, callback, options) => {
        if (options?.immediate) callback()
        return () => {}
      },
    },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/utils/ipc': ipc,
    '@common/utils/electron': { openUrl() {} },
    '@renderer/store': { qualityList, userApi },
    '@renderer/store/setting': { appSetting, updateSetting() {} },
    '@renderer/plugins/Dialog': { dialog: async options => { dialogs.push(options); return false } },
    '@renderer/core/apiSource': { setUserApi: async() => {} },
    '@renderer/utils/musicSdk/api-source-info': [],
    '@common/utils/playbackSourceSetting': {
      reconcilePlaybackSourceRegistry: setting => ({
        'common.apiFallbackMode': setting['common.apiFallbackMode'],
        'common.apiFallbackSources': [...setting['common.apiFallbackSources']],
      }),
    },
    '@renderer/core/music/primarySource': primarySource,
    '@renderer/core/music/playback/sourceSelectors': sourceSelectors,
  })
  module.default()
  return {
    appSetting,
    cancellations,
    dialogs,
    get ensureCount() { return ensureCount },
    setEnsureResult(result) { ensureResult = result },
    primarySource,
    qualityList,
    requests,
    resolveRequest: () => requestResponse.resolve(),
    status: params => statusListener({ params }),
    userApi,
    restore() { global.window = previousWindow },
  }
}

const sourceInfo = (id, source = 'wy') => ({
  id,
  name: id,
  description: '',
  sources: {
    [source]: {
      type: 'music',
      actions: ['musicUrl', 'lyric', 'pic'],
      qualitys: ['128k', '320k'],
    },
  },
})

test('request and cancellation keep the API identity captured by the source closure', async() => {
  const harness = createHarness()
  try {
    harness.status({ apiId: 'user_api/a', status: true, apiInfo: sourceInfo('user_api/a') })
    const request = harness.userApi.apis.wy.getMusicUrl({ id: 'song', source: 'wy' }, '320k')
    harness.appSetting['common.apiSource'] = 'user_api/b'
    await new Promise(resolve => setImmediate(resolve))
    request.canceleFn()

    assert.equal(harness.requests.length, 1)
    assert.equal(harness.requests[0].apiId, 'user_api/a')
    assert.match(harness.requests[0].requestId, /^primary__/)
    assert.equal(Object.hasOwn(harness.requests[0], 'requestKey'), false)
    assert.deepEqual(harness.cancellations, [{
      apiId: 'user_api/a',
      requestId: harness.requests[0].requestId,
      reason: 'cancelled',
    }])
    harness.resolveRequest()
    await assert.rejects(request.promise, error => (
      error?.name == 'PlaybackSourceError' && error?.kind == 'cancelled'
    ))
  } finally {
    harness.restore()
  }
})

test('fallback lifecycle events cannot overwrite the selected primary status', () => {
  const harness = createHarness()
  try {
    harness.status({ apiId: 'user_api/a', status: true, apiInfo: sourceInfo('user_api/a') })
    assert.equal(harness.userApi.status, true)

    harness.status({
      apiId: 'user_api/b',
      status: false,
      message: 'fallback failed',
      apiInfo: sourceInfo('user_api/b'),
    })

    assert.equal(harness.userApi.status, true)
    assert.equal(harness.userApi.message, undefined)
    assert.equal(harness.dialogs.length, 0)
  } finally {
    harness.restore()
  }
})

test('source replacement invalidates a pending ensure without apiInfo before establishing replacement capabilities', async() => {
  const harness = createHarness()
  try {
    const staleEnsure = deferred()
    harness.setEnsureResult(staleEnsure.promise)
    const staleCapabilities = harness.primarySource.ensurePrimarySourceCapabilities()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(harness.ensureCount, 1)

    harness.status({
      apiId: 'user_api/a',
      status: false,
      message: 'User API source changed',
    })

    assert.equal(harness.userApi.runtimeStates['user_api/a'].status, false)
    assert.equal(Object.hasOwn(harness.userApi.capabilities, 'user_api/a'), false)
    staleEnsure.resolve({
      ok: true,
      value: { apiId: 'user_api/a', status: true, apiInfo: sourceInfo('user_api/a', 'wy') },
    })
    await assert.rejects(staleCapabilities, error => error?.kind == 'sourceChanged')
    assert.equal(Object.hasOwn(harness.userApi.capabilities, 'user_api/a'), false)

    harness.setEnsureResult({
      ok: true,
      value: {
        apiId: 'user_api/a',
        status: true,
        apiInfo: sourceInfo('user_api/a', 'tx'),
      },
    })
    const capabilities = await harness.primarySource.ensurePrimarySourceCapabilities()

    assert.equal(harness.ensureCount, 2)
    assert.deepEqual(Object.keys(capabilities.sources), ['tx'])
    assert.deepEqual(Object.keys(harness.userApi.capabilities['user_api/a'].sources), ['tx'])
  } finally {
    harness.restore()
  }
})

test('source replacement evicts an existing cached capability before ensuring replacement capabilities', async() => {
  const harness = createHarness()
  try {
    harness.status({ apiId: 'user_api/a', status: true, apiInfo: sourceInfo('user_api/a', 'wy') })
    assert.deepEqual(Object.keys(harness.userApi.capabilities['user_api/a'].sources), ['wy'])

    harness.status({
      apiId: 'user_api/a',
      status: false,
      message: 'User API source changed',
    })

    assert.equal(harness.userApi.runtimeStates['user_api/a'].status, false)
    assert.equal(Object.hasOwn(harness.userApi.capabilities, 'user_api/a'), false)

    harness.setEnsureResult({
      ok: true,
      value: {
        apiId: 'user_api/a',
        status: true,
        apiInfo: sourceInfo('user_api/a', 'tx'),
      },
    })
    const capabilities = await harness.primarySource.ensurePrimarySourceCapabilities()

    assert.equal(harness.ensureCount, 1)
    assert.deepEqual(Object.keys(capabilities.sources), ['tx'])
    assert.deepEqual(Object.keys(harness.userApi.capabilities['user_api/a'].sources), ['tx'])
  } finally {
    harness.restore()
  }
})
