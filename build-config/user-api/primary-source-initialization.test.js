const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const deferred = () => {
  let resolve
  const promise = new Promise(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const customStatus = (apiId, source = 'wy') => ({
  apiId,
  status: true,
  apiInfo: {
    id: apiId,
    sources: {
      [source]: {
        name: source,
        type: 'music',
        actions: ['musicUrl'],
        qualitys: ['128k'],
      },
    },
  },
})

const initializationFailure = (apiId, message) => ({
  ok: false,
  error: {
    name: 'PlaybackSourceError',
    message,
    scope: 'source',
    kind: 'initialization',
    apiId,
  },
})

const createHarness = ({ primaryId = 'user_api_primary', ensure } = {}) => {
  const apiSource = { value: '' }
  const qualityList = { value: {} }
  const userApi = {
    status: false,
    message: 'initing',
    runtimeStates: {},
    capabilities: {},
  }
  const appSetting = { 'common.apiSource': primaryId }
  const ensureCalls = []
  const persistedPrimaryIds = []
  const sourceSelectors = loadTsModule(path.join(
    __dirname,
    '../../src/renderer/core/music/playback/sourceSelectors.ts',
  ))
  const apiSourceModule = loadTsModule(path.join(
    __dirname,
    '../../src/renderer/core/apiSource.ts',
  ), {
    '@renderer/store': { apiSource, qualityList, userApi },
    '@renderer/store/setting': {
      appSetting,
      setApiSource(apiId) {
        persistedPrimaryIds.push(apiId)
        appSetting['common.apiSource'] = apiId
      },
    },
    '@renderer/core/music/playback/sourceSelectors': sourceSelectors,
    '@renderer/utils/ipc': {
      ensureUserApi(apiId) {
        ensureCalls.push(apiId)
        return ensure?.(apiId) ?? Promise.resolve({ ok: true, value: customStatus(apiId) })
      },
    },
    '@renderer/utils/musicSdk/api-source': {
      supportQuality: {
        builtin: { wy: ['128k', '320k'] },
      },
    },
  })

  return {
    apiSourceModule,
    apiSource,
    qualityList,
    userApi,
    appSetting,
    ensureCalls,
    persistedPrimaryIds,
    setPrimary(apiId) {
      appSetting['common.apiSource'] = apiId
    },
  }
}

test('a cold custom primary is ensured exactly once and leaves initializing after success', async() => {
  const ready = deferred()
  const harness = createHarness({ ensure: () => ready.promise })

  const first = harness.apiSourceModule.setUserApi('user_api_primary')
  const duplicate = harness.apiSourceModule.setUserApi('user_api_primary')

  assert.deepEqual(harness.ensureCalls, ['user_api_primary'])
  ready.resolve({ ok: true, value: customStatus('user_api_primary') })
  await Promise.all([first, duplicate])

  assert.equal(harness.apiSource.value, 'user_api_primary')
  assert.equal(harness.userApi.status, true)
  assert.equal(harness.userApi.message, undefined)
  assert.deepEqual(harness.qualityList.value, { wy: ['128k'] })
})

test('a cold custom primary leaves initializing after initialization failure', async() => {
  const harness = createHarness({
    ensure: apiId => Promise.resolve(initializationFailure(apiId, 'custom source failed to initialize')),
  })

  await harness.apiSourceModule.setUserApi('user_api_primary')

  assert.deepEqual(harness.ensureCalls, ['user_api_primary'])
  assert.equal(harness.userApi.status, false)
  assert.equal(harness.userApi.message, 'custom source failed to initialize')
})

test('a rejected initialization transport leaves initializing with a visible failure', async() => {
  const harness = createHarness({
    ensure: () => Promise.reject(new Error('initialization IPC unavailable')),
  })

  await harness.apiSourceModule.setUserApi('user_api_primary')

  assert.deepEqual(harness.ensureCalls, ['user_api_primary'])
  assert.equal(harness.userApi.status, false)
  assert.equal(harness.userApi.message, 'initialization IPC unavailable')
})

test('a failed custom primary can retry the same source', async() => {
  let attempt = 0
  const harness = createHarness({
    ensure: apiId => ++attempt == 1
      ? Promise.resolve(initializationFailure(apiId, 'temporary initialization failure'))
      : Promise.resolve({ ok: true, value: customStatus(apiId) }),
  })

  await harness.apiSourceModule.setUserApi('user_api_primary')
  await harness.apiSourceModule.setUserApi('user_api_primary')

  assert.deepEqual(harness.ensureCalls, ['user_api_primary', 'user_api_primary'])
  assert.equal(harness.userApi.status, true)
  assert.equal(harness.userApi.message, undefined)
  assert.deepEqual(harness.qualityList.value, { wy: ['128k'] })
})

test('a stale custom-primary result cannot overwrite the newly selected primary state', async() => {
  const oldResult = deferred()
  const newResult = deferred()
  const harness = createHarness({
    primaryId: 'user_api_old',
    ensure: apiId => apiId == 'user_api_old' ? oldResult.promise : newResult.promise,
  })

  const selectingOld = harness.apiSourceModule.setUserApi('user_api_old')
  harness.setPrimary('user_api_new')
  const selectingNew = harness.apiSourceModule.setUserApi('user_api_new')
  newResult.resolve({ ok: true, value: customStatus('user_api_new', 'kg') })
  await selectingNew

  oldResult.resolve(initializationFailure('user_api_old', 'stale source failed'))
  await selectingOld

  assert.deepEqual(harness.ensureCalls, ['user_api_old', 'user_api_new'])
  assert.equal(harness.apiSource.value, 'user_api_new')
  assert.equal(harness.userApi.status, true)
  assert.equal(harness.userApi.message, undefined)
  assert.deepEqual(harness.qualityList.value, { kg: ['128k'] })
  assert.deepEqual(harness.persistedPrimaryIds, [])
})

test('an older result cannot overwrite a newer selection of the same custom primary', async() => {
  const firstResult = deferred()
  const secondResult = deferred()
  let attempt = 0
  const harness = createHarness({
    ensure: () => ++attempt == 1 ? firstResult.promise : secondResult.promise,
  })

  const selectingFirst = harness.apiSourceModule.setUserApi('user_api_primary')
  harness.setPrimary('builtin')
  await harness.apiSourceModule.setUserApi('builtin')
  harness.setPrimary('user_api_primary')
  const selectingSecond = harness.apiSourceModule.setUserApi('user_api_primary')

  secondResult.resolve({ ok: true, value: customStatus('user_api_primary', 'kg') })
  await selectingSecond
  firstResult.resolve(initializationFailure('user_api_primary', 'stale source failed'))
  await selectingFirst

  assert.deepEqual(harness.ensureCalls, ['user_api_primary', 'user_api_primary'])
  assert.equal(harness.apiSource.value, 'user_api_primary')
  assert.equal(harness.userApi.status, true)
  assert.equal(harness.userApi.message, undefined)
  assert.deepEqual(harness.qualityList.value, { kg: ['128k'] })
  assert.deepEqual(harness.persistedPrimaryIds, [])
})

test('a built-in primary becomes ready without ensuring a custom runtime', async() => {
  const harness = createHarness({ primaryId: 'builtin' })

  await harness.apiSourceModule.setUserApi('builtin')

  assert.deepEqual(harness.ensureCalls, [])
  assert.equal(harness.apiSource.value, 'builtin')
  assert.equal(harness.userApi.status, true)
  assert.equal(harness.userApi.message, undefined)
  assert.deepEqual(harness.qualityList.value, { wy: ['128k', '320k'] })
})
