const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const createHarness = () => {
  const requests = []
  const cancellations = []
  const dialogs = []
  const appSetting = {
    'common.apiSource': 'user_api/a',
    'common.apiFallbackMode': false,
    'common.apiFallbackSources': [],
  }
  const userApi = { status: false, message: '', apis: {}, list: [], listLoaded: false }
  const qualityList = { value: {} }
  let statusListener
  const previousWindow = global.window
  global.window = {
    lx: { apiInitPromise: [null, true, () => {}] },
    setTimeout,
  }
  const module = loadTsModule(path.join(__dirname, '../../src/renderer/core/useApp/useInitUserApi.ts'), {
    '@common/utils/vueTools': {
      onBeforeUnmount() {},
      watch: (_source, callback, options) => {
        if (options?.immediate) callback()
        return () => {}
      },
    },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/utils/ipc': {
      onUserApiStatus(listener) { statusListener = listener; return () => {} },
      getUserApiList: async() => [],
      onShowUserApiUpdateAlert: () => () => {},
      sendUserApiRequest: async params => {
        requests.push(structuredClone(params))
        return { ok: true, value: { data: { url: 'https://media.test/song' } }, data: { url: 'https://media.test/song' } }
      },
      userApiRequestCancel: params => cancellations.push(structuredClone(params)),
    },
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
  })
  module.default()
  return {
    appSetting,
    cancellations,
    dialogs,
    qualityList,
    requests,
    status: params => statusListener({ params }),
    userApi,
    restore() { global.window = previousWindow },
  }
}

const sourceInfo = id => ({
  id,
  name: id,
  description: '',
  sources: {
    wy: {
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
    request.canceleFn()

    assert.equal(harness.requests.length, 1)
    assert.equal(harness.requests[0].apiId, 'user_api/a')
    assert.match(harness.requests[0].requestId, /^request__/)
    assert.equal(Object.hasOwn(harness.requests[0], 'requestKey'), false)
    assert.deepEqual(harness.cancellations, [{
      apiId: 'user_api/a',
      requestId: harness.requests[0].requestId,
    }])
    assert.deepEqual(await request.promise, {
      type: '320k',
      url: 'https://media.test/song',
      source: 'wy',
      persistentCache: false,
    })
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
