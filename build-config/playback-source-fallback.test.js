const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createAdapterHarness,
  createColdUserApiRegistryHarness,
  createPrimaryCapabilityHarness,
  createColdPrimaryMusicEntryHarness,
  createOnlineProvider,
  createLocalProvider,
  selectPlaybackQuality,
  canStartPlaybackWithRegistry,
  canOpenPrimaryDownloadWithRegistry,
  deferred,
  onlineMusic,
  matchedTx,
  matchedKg,
  flacMusic,
  no128Music,
  localMusic,
} = require('./test-utils/playback-fallback-harness')

test('online matching is lazy and runs once across API sources', async() => {
  const calls = []
  const provider = createOnlineProvider(onlineMusic, async query => {
    calls.push(query)
    return [matchedTx, matchedKg]
  })
  assert.equal(calls.length, 0)
  assert.equal(provider.getOriginal(), onlineMusic)
  const [first, second] = await Promise.all([provider.getMatched(), provider.getMatched()])
  assert.equal(calls.length, 1)
  assert.equal(first, second)
  assert.deepEqual(first, [matchedTx, matchedKg])
})

test('source capability filtering does not rerun matching', async() => {
  let calls = 0
  const provider = createOnlineProvider(onlineMusic, async() => {
    calls++
    return [matchedTx, matchedKg]
  })
  assert.deepEqual(await provider.getMatched(new Set(['tx'])), [matchedTx])
  assert.deepEqual(await provider.getMatched(new Set(['kg'])), [matchedKg])
  assert.equal(calls, 1)
})

test('quality selection uses the active API source capabilities', () => {
  assert.equal(selectPlaybackQuality('flac', flacMusic, ['flac', '320k', '128k']), 'flac')
  assert.equal(selectPlaybackQuality('flac', flacMusic, ['128k']), '128k')
  assert.equal(selectPlaybackQuality('flac', no128Music, ['128k']), null)
})

test('local recovery discovers metadata and filename variants lazily in order', async() => {
  const queries = []
  const local = {
    ...localMusic,
    name: 'Song - Artist',
    singer: 'Metadata Artist',
    meta: { ...localMusic.meta, filePath: 'C:\\Music\\File Artist - File Song.mp3' },
  }
  const provider = createLocalProvider(local, async query => {
    queries.push([query.name, query.singer])
    return []
  })
  await provider.getBatch(0)
  assert.deepEqual(queries, [['Song - Artist', 'Metadata Artist']])
  await provider.getBatch(1)
  await provider.getBatch(2)
  await provider.getBatch(3)
  await provider.getBatch(4)
  assert.deepEqual(queries, [
    ['Song - Artist', 'Metadata Artist'],
    ['Song', 'Artist'],
    ['Artist', 'Song'],
    ['File Artist', 'File Song'],
    ['File Song', 'File Artist'],
  ])
  await provider.getBatch(4)
  assert.equal(queries.length, 5)
})

test('custom source requests carry explicit API and request IDs', async() => {
  const calls = []
  const adapter = createAdapterHarness({
    request: async params => {
      calls.push(params)
      return { ok: true, value: { data: { type: '320k', url: 'https://audio/a' } } }
    },
  })
  const result = await adapter.getMusicUrl({
    apiId: 'user_api_a', requestId: 'session:1', musicInfo: onlineMusic,
    quality: '320k', signal: new AbortController().signal,
  })
  assert.equal(calls[0].apiId, 'user_api_a')
  assert.equal(calls[0].requestId, 'session:1')
  assert.deepEqual(result, { url: 'https://audio/a', quality: '320k' })
})

test('custom local playback keeps the existing 128k cache-bucket convention', async() => {
  const calls = []
  const adapter = createAdapterHarness({
    request: async params => {
      calls.push(params)
      return { ok: true, value: { data: { type: null, url: 'https://audio/local' } } }
    },
  })
  const result = await adapter.getLocalMusicUrl({
    apiId: 'user_api_a', requestId: 'session:local', musicInfo: localMusic,
    signal: new AbortController().signal,
  })
  assert.equal(calls[0].data.info.type, null)
  assert.deepEqual(result, { url: 'https://audio/local', quality: '128k' })
})

test('built-in request selects API implementation by explicit ID', async() => {
  const adapter = createAdapterHarness({ selectedGlobalApiId: 'global-primary' })
  await adapter.getMusicUrl({
    apiId: 'explicit-fallback', requestId: 'r', musicInfo: onlineMusic,
    quality: '128k', signal: new AbortController().signal,
  })
  assert.deepEqual(adapter.builtinLookups, [{ apiId: 'explicit-fallback', platform: 'wy' }])
})

test('custom and built-in capabilities retain the SourceCapabilities wrapper', async() => {
  const customSources = { wy: { actions: ['musicUrl'], qualitys: ['128k'] } }
  const custom = createAdapterHarness({
    ensure: async apiId => ({
      ok: true,
      value: { apiId, status: true, apiInfo: { sources: customSources } },
    }),
  })
  assert.deepEqual(
    await custom.getCapabilities('user_api_a', new AbortController().signal),
    { sources: customSources },
  )
  const builtin = createAdapterHarness({
    builtinCapabilities: { tx: { actions: ['musicUrl'], qualitys: ['320k'] } },
  })
  assert.deepEqual(
    await builtin.getCapabilities('builtin', new AbortController().signal),
    { sources: { tx: { actions: ['musicUrl'], qualitys: ['320k'] } } },
  )
})

test('an imported custom source has no persisted capabilities after restart but remains playable', async() => {
  const registry = createColdUserApiRegistryHarness()
  const userApis = await registry.importAndRestart(`/*
 * @name Cold Source
 * @description cold profile fixture
 * @author test
 * @version 1.0.0
 */
globalThis.lx = globalThis.lx || {}`)
  assert.equal(userApis.length, 1)
  assert.equal(userApis[0].sources, undefined)
  const runtimeOnlySources = {
    wy: { name: 'WY', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  }
  const restarted = await registry.persistCapabilitiesAndRestart(
    userApis[0].id,
    runtimeOnlySources,
  )
  assert.equal(restarted[0].sources, undefined)
  assert.equal(registry.serializedUserApis[0].sources, undefined)
  const setting = {
    'common.apiSource': userApis[0].id,
    'common.apiFallbackSources': [],
  }
  assert.equal(canStartPlaybackWithRegistry('kg', setting, new Set([userApis[0].id])), true)
  assert.equal(canStartPlaybackWithRegistry('kg', setting, new Set()), false)
  assert.equal(canStartPlaybackWithRegistry('local', setting, new Set()), true)
  assert.equal(canStartPlaybackWithRegistry('webdav', setting, new Set()), true)
})

test('download lyric and picture entry points share one lazy primary initialization', async() => {
  const runtimeSources = {
    wy: { name: 'WY', type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: ['128k', '320k'] },
  }
  const harness = createPrimaryCapabilityHarness({
    primary: 'user_api_a',
    customApis: [{ id: 'user_api_a', name: 'A', description: '', allowShowUpdateAlert: false }],
    ensure: async apiId => ({
      ok: true,
      value: { apiId, status: true, apiInfo: { id: apiId, sources: runtimeSources } },
    }),
  })
  assert.equal(canOpenPrimaryDownloadWithRegistry(
    'wy', 'user_api_a', {}, new Set(['user_api_a']), {},
  ), true)
  assert.equal(harness.ensureCalls.length, 0)
  const downloadReady = harness.controller.ensurePrimaryCapabilities()
  const lyric = harness.controller.requestPrimaryAction({ source: 'wy', action: 'lyric', info: onlineMusic })
  const pic = harness.controller.requestPrimaryAction({ source: 'wy', action: 'pic', info: onlineMusic })
  await Promise.all([downloadReady, lyric.promise, pic.promise])
  assert.deepEqual(harness.ensureCalls, ['user_api_a'])
  assert.deepEqual(harness.qualityList, {
    wy: ['128k', '320k'],
  })
  assert.deepEqual(harness.requestActions, ['user_api_a:wy:lyric', 'user_api_a:wy:pic'])
})

test('cold missing-local music entry points initialize the primary without a global latch', async() => {
  const harness = createColdPrimaryMusicEntryHarness()
  const [music, lyric, picture] = await Promise.all([
    harness.getLocalMusicUrl(),
    harness.getLocalLyric(),
    harness.getLocalPicture(),
  ])
  assert.equal(music.url, 'https://audio/local')
  assert.equal(lyric.isFromCache, false)
  assert.equal(picture.url, 'https://image/local')
  assert.deepEqual(harness.ensureCalls, ['user_api_a'])
  assert.deepEqual(harness.requestActions, [
    'user_api_a:local:musicUrl',
    'user_api_a:local:lyric',
    'user_api_a:local:pic',
  ])
  assert.equal(harness.globalDataKeys.includes('apiInitPromise'), false)
})

test('a failed lazy primary initialization is retryable and does not change source settings', async() => {
  const setting = { primary: 'user_api_a', fallbacks: ['user_api_b'] }
  const harness = createPrimaryCapabilityHarness({
    primary: setting.primary,
    customApis: [{ id: 'user_api_a', name: 'A', description: '', allowShowUpdateAlert: false }],
    ensureResults: [
      { ok: false, error: { name: 'PlaybackSourceError', message: 'temporary', scope: 'source', kind: 'initialization', apiId: 'user_api_a' } },
      { ok: true, value: { apiId: 'user_api_a', status: true, apiInfo: { id: 'user_api_a', sources: {} } } },
    ],
  })
  await assert.rejects(harness.controller.ensurePrimaryCapabilities())
  await harness.controller.ensurePrimaryCapabilities()
  assert.equal(harness.ensureCalls.length, 2)
  assert.deepEqual(setting, { primary: 'user_api_a', fallbacks: ['user_api_b'] })
})

test('cold primary initialization reaches the broker before renderer registry hydration', async() => {
  const sources = {
    wy: { name: 'WY', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  }
  const harness = createPrimaryCapabilityHarness({
    primary: 'user_api_a',
    customApis: [],
    customRegistryLoaded: false,
    ensure: async apiId => ({
      ok: true,
      value: { apiId, status: true, apiInfo: { id: apiId, sources } },
    }),
  })

  assert.deepEqual(await harness.controller.ensurePrimaryCapabilities(), { sources })
  assert.deepEqual(harness.ensureCalls, ['user_api_a'])
})

test('invalidating a pending primary ensure rejects the old generation and permits a fresh one', async() => {
  const oldEnsure = deferred()
  const freshEnsure = deferred()
  const oldSources = {
    wy: { name: 'old', type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
  }
  const freshSources = {
    wy: { name: 'fresh', type: 'music', actions: ['musicUrl'], qualitys: ['320k'] },
  }
  const harness = createPrimaryCapabilityHarness({
    primary: 'user_api_a',
    customApis: [{ id: 'user_api_a', name: 'A', description: '', allowShowUpdateAlert: false }],
    ensureResults: [oldEnsure.promise, freshEnsure.promise],
  })

  const oldGeneration = harness.controller.ensurePrimaryCapabilities()
  await harness.waitForEnsureCall('user_api_a', 1)
  harness.controller.invalidate('user_api_a')
  const freshGeneration = harness.controller.ensurePrimaryCapabilities()
  await harness.waitForEnsureCall('user_api_a', 2)

  oldEnsure.resolve({
    ok: true,
    value: { apiId: 'user_api_a', status: true, apiInfo: { id: 'user_api_a', sources: oldSources } },
  })
  await assert.rejects(
    oldGeneration,
    error => error.scope == 'source' && error.kind == 'sourceChanged',
  )
  assert.deepEqual(harness.publishedCapabilities, [])

  freshEnsure.resolve({
    ok: true,
    value: { apiId: 'user_api_a', status: true, apiInfo: { id: 'user_api_a', sources: freshSources } },
  })
  assert.deepEqual(await freshGeneration, { sources: freshSources })
  assert.deepEqual(harness.publishedCapabilities, [{
    apiId: 'user_api_a', value: { sources: freshSources },
  }])
})

test('structured broker failures survive the renderer boundary', async() => {
  const adapter = createAdapterHarness({
    request: async() => ({
      ok: false,
      error: { name: 'PlaybackSourceError', message: 'busy', scope: 'source', kind: 'serverBusy', apiId: 'a' },
    }),
  })
  await assert.rejects(
    adapter.getMusicUrl({ apiId: 'a', requestId: 'r', musicInfo: onlineMusic, quality: '128k', signal: new AbortController().signal }),
    err => err.scope == 'source' && err.kind == 'serverBusy' && err.apiId == 'a',
  )
})

test('aborting sends a matching cancel and returns session cancellation', async() => {
  const cancels = []
  const controller = new AbortController()
  const adapter = createAdapterHarness({ request: () => new Promise(() => {}), cancel: value => cancels.push(value) })
  const promise = adapter.getMusicUrl({ apiId: 'a', requestId: 'r', musicInfo: onlineMusic, quality: '128k', signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, err => err.scope == 'session' && err.kind == 'cancelled')
  assert.deepEqual(cancels, [{ apiId: 'a', requestId: 'r', reason: 'cancelled' }])
})

test('a pre-aborted custom request never reaches the broker', async() => {
  const requests = []
  const cancels = []
  const controller = new AbortController()
  controller.abort()
  const adapter = createAdapterHarness({
    request: params => {
      requests.push(params)
      return new Promise(() => {})
    },
    cancel: params => cancels.push(params),
  })

  await assert.rejects(
    adapter.getMusicUrl({
      apiId: 'a', requestId: 'pre-aborted', musicInfo: onlineMusic,
      quality: '128k', signal: controller.signal,
    }),
    error => error.scope == 'session' && error.kind == 'cancelled',
  )
  assert.deepEqual(requests, [])
  assert.deepEqual(cancels, [])
})

test('attempt timeout abort cancels the matching broker request and remains source timeout', async() => {
  const cancels = []
  const adapter = createAdapterHarness({
    request: () => new Promise(() => {}),
    cancel: value => cancels.push(value),
  })
  const controller = new AbortController()
  const promise = adapter.getMusicUrl({
    apiId: 'a', requestId: 'r', musicInfo: onlineMusic, quality: '128k', signal: controller.signal,
  })
  controller.abort({ scope: 'source', kind: 'timeout' })
  await assert.rejects(promise, err => err.scope == 'source' && err.kind == 'timeout')
  assert.deepEqual(cancels, [{ apiId: 'a', requestId: 'r', reason: 'timeout' }])
})

test('built-in legacy rate-limit and busy errors normalize at the adapter boundary', async() => {
  const rateLimited = createAdapterHarness({
    builtinRequest: async() => { throw Object.assign(new Error('limited'), { statusCode: 429 }) },
  })
  await assert.rejects(
    rateLimited.getMusicUrl({ apiId: 'builtin', requestId: 'r1', musicInfo: onlineMusic, quality: '128k', signal: new AbortController().signal }),
    err => err.scope == 'source' && err.kind == 'rateLimit',
  )
  const legacyRateLimited = createAdapterHarness({
    builtinRequest: async() => { throw new Error('legacy-too-many-requests') },
    tooManyRequestsMessage: 'legacy-too-many-requests',
  })
  await assert.rejects(
    legacyRateLimited.getMusicUrl({ apiId: 'builtin', requestId: 'r1b', musicInfo: onlineMusic, quality: '128k', signal: new AbortController().signal }),
    err => err.scope == 'source' && err.kind == 'rateLimit',
  )
  const busy = createAdapterHarness({
    builtinRequest: async() => { throw new Error('legacy-server-busy-message') },
    serverBusyMessages: new Set(['legacy-server-busy-message']),
  })
  await assert.rejects(
    busy.getMusicUrl({ apiId: 'builtin', requestId: 'r2', musicInfo: onlineMusic, quality: '128k', signal: new AbortController().signal }),
    err => err.scope == 'source' && err.kind == 'serverBusy',
  )
})
