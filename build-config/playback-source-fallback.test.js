const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createAdapterHarness,
  createIntegrationHarness,
  createColdUserApiRegistryHarness,
  createPrimaryCapabilityHarness,
  createColdPrimaryMusicEntryHarness,
  createOnlineProvider,
  createLocalProvider,
  selectPlaybackQuality,
  canStartPlaybackWithRegistry,
  canOpenPrimaryDownloadWithRegistry,
  deferred,
  playbackError,
  createFakeClock,
  createCacheHarness,
  createSessionHarness,
  musicUrlKey,
  createLocalSessionHarness,
  createMusicFacadeHarness,
  resolvePolicyForReason,
  onlineMusic,
  matchedTx,
  matchedKg,
  flacMusic,
  no128Music,
  localMusic,
  webdavMusic,
  downloadItem,
  songB,
} = require('./test-utils/playback-fallback-harness')

test('a missing local file tries direct local action for every source before that source batches', async() => {
  const calls = []
  const session = createLocalSessionHarness({
    sourceIds: ['a', 'b'],
    directLocal: async apiId => { calls.push(`${apiId}:local`); throw playbackError('candidate', 'request', apiId) },
    requestOnline: async({ apiId, batch }) => {
      calls.push(`${apiId}:batch${batch}`)
      if (apiId == 'b') return { url: 'https://ok', quality: '128k' }
      throw playbackError('candidate', 'request', apiId)
    },
  })
  await session.nextCandidate()
  assert.deepEqual(calls, ['a:local', 'a:batch0', 'b:local', 'b:batch0'])
})

test('missing-local candidate batches stay ordered and are reused across API sources', async() => {
  const searchQueries = []
  const batches = [
    [{ ...matchedTx, id: 'batch-zero' }],
    [{ ...matchedKg, id: 'batch-one' }],
  ]
  const calls = []
  const session = createLocalSessionHarness({
    sourceIds: ['a', 'b'],
    findCandidates: async query => {
      const batch = batches[searchQueries.length] ?? []
      searchQueries.push([query.name, query.singer])
      return batch
    },
    directLocal: async apiId => {
      calls.push(`${apiId}:local`)
      throw playbackError('candidate', 'request', apiId)
    },
    requestOnline: async({ apiId, batch, musicInfo }) => {
      calls.push(`${apiId}:batch${batch}:${musicInfo.id}`)
      if (apiId == 'a' && batch == 1) throw playbackError('source', 'rateLimit', apiId)
      if (apiId == 'b' && batch == 1) return { url: 'https://ok', quality: '128k' }
      throw playbackError('candidate', 'request', apiId)
    },
  })
  await session.nextCandidate()
  assert.deepEqual(calls, [
    'a:local', 'a:batch0:batch-zero', 'a:batch1:batch-one',
    'b:local', 'b:batch0:batch-zero', 'b:batch1:batch-one',
  ])
  assert.equal(searchQueries.length, 2)
})

test('WebDAV bypasses API source sessions', async() => {
  const harness = createMusicFacadeHarness()
  const result = await harness.createPlaybackRequest({ musicInfo: webdavMusic, reason: 'initial' })
  assert.equal(result.kind, 'direct')
  assert.equal(result.resource.songIdentity, 'webdav:webdav-song')
  assert.equal(harness.sessionCreateCount, 0)
  assert.equal(harness.webdavCalls, 1)
})

test('download URL acquisition stays primary-only and exact-quality', async() => {
  const harness = createMusicFacadeHarness({ primary: 'a', fallbacks: ['b'] })
  await harness.getDownloadUrl(downloadItem)
  assert.deepEqual(harness.requestedApiIds, ['a'])
  assert.deepEqual(harness.cacheLookups, [`${downloadItem.metadata.musicInfo.id}_${downloadItem.metadata.quality}`])
})

test('force refresh continues after rejecting cache invalidation and a throwing reporter', async() => {
  const harness = createMusicFacadeHarness({
    rejectCacheInvalidation: Object.assign(new Error('private cache failure'), {
      code: 'SQLITE_IOERR',
    }),
    throwPersistenceReporter: true,
  })
  const result = await harness.createPlaybackRequest({
    musicInfo: onlineMusic, reason: 'forceRefresh',
  })
  assert.equal(result.kind, 'session')
  assert.equal(harness.sessionCreateCount, 1)
  assert.deepEqual(harness.persistenceFailures, [{
    operation: 'delete', errorName: 'Error', errorCode: 'SQLITE_IOERR',
  }])
})

test('force refresh observes synchronous invalidation failure and a throwing reporter', async() => {
  const harness = createMusicFacadeHarness({
    throwCacheInvalidationSynchronously: Object.assign(new Error('private synchronous failure'), {
      code: 'SQLITE_IOERR',
    }),
    throwPersistenceReporter: true,
  })
  const session = await harness.createOnlinePlaybackSession({
    musicInfo: onlineMusic,
    policy: 'fallback',
    cacheMode: 'bypass',
  })
  assert.equal(session.songIdentity, 'wy:song')
  assert.equal(harness.sessionCreateCount, 1)
  assert.deepEqual(harness.persistenceFailures, [{
    operation: 'delete', errorName: 'Error', errorCode: 'SQLITE_IOERR',
  }])
  assert.equal(JSON.stringify(harness.persistenceFailures).includes('private synchronous failure'), false)
})

test('force refresh holds one settings snapshot until invalidation settles', async() => {
  const cacheInvalidationGate = deferred()
  const harness = createMusicFacadeHarness({
    primary: 'old-primary',
    fallbacks: ['old-fallback'],
    requestedQuality: '320k',
    cacheInvalidationGate,
  })
  const creating = harness.createOnlinePlaybackSession({
    musicInfo: onlineMusic,
    policy: 'fallback',
    cacheMode: 'bypass',
  })
  assert.equal(harness.readSettingsCount, 1)
  assert.equal(harness.sessionCreateCount, 0)
  harness.updateSessionSettings({
    primaryId: 'new-primary',
    fallbackIds: ['new-fallback'],
    requestedQuality: '128k',
  })
  cacheInvalidationGate.resolve()
  await creating
  assert.equal(harness.readSettingsCount, 1)
  assert.deepEqual(harness.sessionCreateInputs, [{
    sourceIds: ['old-primary', 'old-fallback'],
    requestedQuality: '320k',
    cacheMode: 'bypass',
  }])
})

test('playing a downloaded item with a missing file uses online fallback resolution', async() => {
  const harness = createMusicFacadeHarness({ downloadedFileExists: false })
  const result = await harness.createPlaybackRequest({ musicInfo: downloadItem, reason: 'initial' })
  assert.equal(result.kind, 'session')
  assert.equal(harness.sessionCreateCount, 1)
})

test('lyrics and covers never request a fallback API source', async() => {
  const harness = createMusicFacadeHarness({ primary: 'a', fallbacks: ['b'] })
  await harness.getOnlineLyric(onlineMusic)
  await harness.getOnlinePic(onlineMusic)
  await harness.getLocalLyric(localMusic)
  await harness.getLocalPic(localMusic)
  assert.deepEqual(harness.apiActionCalls, [
    'a:wy:lyric', 'a:wy:pic', 'a:local:lyric', 'a:local:pic',
  ])
})

test('missing local network resolution does not persist an unvalidated URL', async() => {
  const harness = createMusicFacadeHarness()
  const url = await harness.getLocalUrl(localMusic)
  assert.equal(url, 'https://audio.test/local.mp3')
  assert.equal(harness.localMusicUrlSaves, 0)
})

test('WebDAV lyrics and covers stay on WebDAV IPC', async() => {
  const harness = createMusicFacadeHarness({ primary: 'a', fallbacks: ['b'] })
  await harness.getWebdavLyric(webdavMusic)
  await harness.getWebdavPic(webdavMusic)
  assert.deepEqual(harness.webdavActions, ['lyric', 'pic'])
  assert.deepEqual(harness.requestedApiIds, [])
})

test('download retry remains primary-only while preserving platform switching', async() => {
  const harness = createMusicFacadeHarness({ primary: 'a', fallbacks: ['b'], failFirstDownloadRequest: true })
  await harness.getDownloadUrl(downloadItem)
  assert.deepEqual(harness.requestedApiIds, ['a', 'a'])
  assert.equal(harness.downloadPlatformSwitches, 1)
})

test('resolve reason uniquely determines policy and cache mode', () => {
  assert.deepEqual(resolvePolicyForReason('initial'), { policy: 'fallback', cacheMode: 'lookup' })
  assert.deepEqual(resolvePolicyForReason('preload'), { policy: 'fallback', cacheMode: 'lookup' })
  assert.deepEqual(resolvePolicyForReason('forceRefresh'), { policy: 'fallback', cacheMode: 'bypass' })
  assert.deepEqual(resolvePolicyForReason('postCommitError'), { policy: 'primaryOnly', cacheMode: 'bypass' })
})

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
  assert.deepEqual(result, {
    url: 'https://audio/a', resolvedQuality: '320k', reportedQuality: '320k',
  })
})

test('custom source requests preserve the legacy music-info contract', async() => {
  const calls = []
  const musicInfo = {
    ...onlineMusic,
    meta: {
      ...onlineMusic.meta,
      songId: 'provider-song-id',
      albumId: 'provider-album-id',
      picUrl: 'https://img/song.jpg',
      qualitys: [{ type: '320k', size: '7M' }],
    },
  }
  const adapter = createAdapterHarness({
    request: async params => {
      calls.push(params)
      return { ok: true, value: { data: { type: '320k', url: 'https://audio/legacy' } } }
    },
  })

  await adapter.getMusicUrl({
    apiId: 'user_api_a', requestId: 'session:legacy', musicInfo,
    quality: '320k', signal: new AbortController().signal,
  })

  assert.deepEqual(calls[0].data.info.musicInfo, {
    name: 'Song',
    singer: 'Artist',
    source: 'wy',
    songmid: 'provider-song-id',
    interval: '03:00',
    albumName: 'Album',
    img: 'https://img/song.jpg',
    typeUrl: {},
    albumId: 'provider-album-id',
    types: [{ type: '320k', size: '7M' }],
    _types: { '128k': {}, '320k': {}, flac: {} },
  })
})

for (const reportedQuality of ['128k', '192k', '320k', 'flac', 'flac24bit', 'ape', 'wav']) {
  test(`custom source preserves reported quality ${reportedQuality}`, async() => {
    const adapter = createAdapterHarness({
      request: async() => ({
        ok: true,
        value: { data: { type: reportedQuality, url: `https://audio/${reportedQuality}` } },
      }),
    })
    assert.deepEqual(await adapter.getMusicUrl({
      apiId: 'user_api_a', requestId: 'session:1', musicInfo: onlineMusic,
      quality: 'flac', signal: new AbortController().signal,
    }), {
      url: `https://audio/${reportedQuality}`,
      resolvedQuality: reportedQuality,
      reportedQuality,
    })
  })
}

test('missing and invalid custom quality use only the requested resolved quality', async() => {
  for (const data of [
    { url: 'https://audio/missing' },
    { type: 'FLAC', url: 'https://audio/case-changed' },
    { type: 'not-a-quality', url: 'https://audio/invalid' },
  ]) {
    const adapter = createAdapterHarness({ request: async() => ({ ok: true, value: { data } }) })
    assert.deepEqual(await adapter.getMusicUrl({
      apiId: 'user_api_a', requestId: 'session:1', musicInfo: onlineMusic,
      quality: '320k', signal: new AbortController().signal,
    }), { url: data.url, resolvedQuality: '320k' })
  }
})

test('custom local playback keeps the existing 128k cache-bucket convention', async() => {
  const calls = []
  const adapter = createAdapterHarness({
    request: async params => {
      calls.push(params)
      return { ok: true, value: { data: { type: '128k', url: 'https://audio/local' } } }
    },
  })
  const result = await adapter.getLocalMusicUrl({
    apiId: 'user_api_a', requestId: 'session:local', musicInfo: localMusic,
    signal: new AbortController().signal,
  })
  assert.equal(calls[0].data.info.type, null)
  assert.deepEqual(result, {
    url: 'https://audio/local', resolvedQuality: '128k', reportedQuality: '128k',
  })
})

test('custom local playback omits missing and invalid reported quality', async() => {
  for (const data of [
    { url: 'https://audio/local-missing' },
    { type: 'invalid', url: 'https://audio/local-invalid' },
  ]) {
    const adapter = createAdapterHarness({ request: async() => ({ ok: true, value: { data } }) })
    assert.deepEqual(await adapter.getLocalMusicUrl({
      apiId: 'user_api_a', requestId: 'session:local', musicInfo: localMusic,
      signal: new AbortController().signal,
    }), { url: data.url, resolvedQuality: '128k' })
  }
})

test('built-in request selects API implementation by explicit ID', async() => {
  const adapter = createAdapterHarness({ selectedGlobalApiId: 'global-primary' })
  await adapter.getMusicUrl({
    apiId: 'explicit-fallback', requestId: 'r', musicInfo: onlineMusic,
    quality: '128k', signal: new AbortController().signal,
  })
  assert.deepEqual(adapter.builtinLookups, [{ apiId: 'explicit-fallback', platform: 'wy' }])
})

test('built-in source requests preserve the legacy music-info contract', async() => {
  let receivedMusicInfo
  const musicInfo = {
    ...onlineMusic,
    meta: {
      ...onlineMusic.meta,
      songId: 'builtin-song-id',
      albumId: 'builtin-album-id',
      qualitys: [{ type: '128k', size: '3M' }],
    },
  }
  const adapter = createAdapterHarness({
    builtinRequest: async(info, quality) => {
      receivedMusicInfo = info
      return { type: quality, url: 'https://audio/builtin-legacy' }
    },
  })

  await adapter.getMusicUrl({
    apiId: 'explicit-fallback', requestId: 'r', musicInfo,
    quality: '128k', signal: new AbortController().signal,
  })

  assert.equal(receivedMusicInfo.songmid, 'builtin-song-id')
  assert.equal(receivedMusicInfo.albumId, 'builtin-album-id')
  assert.equal(Object.hasOwn(receivedMusicInfo, 'meta'), false)
})

test('built-in source validates reported type instead of casting it', async() => {
  const valid = createAdapterHarness({
    builtinRequest: async() => ({ type: 'ape', url: 'https://audio/valid' }),
  })
  assert.deepEqual(await valid.getMusicUrl({
    apiId: 'builtin', requestId: 'r1', musicInfo: onlineMusic,
    quality: 'flac', signal: new AbortController().signal,
  }), { url: 'https://audio/valid', resolvedQuality: 'ape', reportedQuality: 'ape' })

  const invalid = createAdapterHarness({
    builtinRequest: async() => ({ type: 'hires', url: 'https://audio/invalid' }),
  })
  assert.deepEqual(await invalid.getMusicUrl({
    apiId: 'builtin', requestId: 'r2', musicInfo: onlineMusic,
    quality: 'flac', signal: new AbortController().signal,
  }), { url: 'https://audio/invalid', resolvedQuality: 'flac' })
})

test('source candidate carries reported quality independently from resolved quality', async() => {
  const harness = createSessionHarness({
    request: async() => ({
      url: 'https://audio/source', resolvedQuality: '320k', reportedQuality: '192k',
    }),
  })
  const candidate = await harness.nextCandidate()
  assert.equal(candidate.quality, '320k')
  assert.equal(candidate.reportedQuality, '192k')
})

test('source candidate omits unreported quality while retaining its resolved key quality', async() => {
  const harness = createSessionHarness({
    request: async() => ({ url: 'https://audio/source', resolvedQuality: '320k' }),
  })
  const candidate = await harness.nextCandidate()
  assert.equal(candidate.quality, '320k')
  assert.equal(Object.hasOwn(candidate, 'reportedQuality'), false)
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

test('serial resolution exhausts platforms before advancing API source', async() => {
  const calls = []
  const session = createSessionHarness({
    sourceIds: ['primary', 'fallback'],
    request: async({ apiId, musicInfo }) => {
      calls.push(`${apiId}:${musicInfo.source}`)
      if (apiId == 'fallback' && musicInfo.source == 'tx') return { url: 'https://ok', quality: '128k' }
      throw playbackError('candidate', 'request', apiId)
    },
    matched: [matchedTx, matchedKg],
  })
  const candidate = await session.nextCandidate()
  assert.equal(candidate.url, 'https://ok')
  assert.deepEqual(calls, [
    'primary:wy', 'primary:tx', 'primary:kg',
    'fallback:wy', 'fallback:tx',
  ])
})

test('source failure skips remaining platforms in that source', async() => {
  const calls = []
  const session = createSessionHarness({
    sourceIds: ['primary', 'fallback'],
    request: async({ apiId, musicInfo }) => {
      calls.push(`${apiId}:${musicInfo.source}`)
      if (apiId == 'primary') throw playbackError('source', 'rateLimit', apiId)
      return { url: 'https://ok', quality: '128k' }
    },
    matched: [matchedTx],
  })
  await session.nextCandidate()
  assert.deepEqual(calls, ['primary:wy', 'fallback:wy'])
})

test('empty URL advances to the next candidate inside the same source', async() => {
  const session = createSessionHarness({
    sourceIds: ['primary', 'fallback'],
    request: async({ apiId, musicInfo }) => {
      if (apiId == 'primary' && musicInfo.source == 'wy') throw playbackError('candidate', 'emptyUrl', apiId)
      return { url: 'https://ok', quality: '128k' }
    },
    matched: [matchedTx],
  })
  const candidate = await session.nextCandidate()
  assert.equal(candidate.apiId, 'primary')
  assert.equal(candidate.platform, 'tx')
})

test('media rejection forces bounded candidate validation metadata', async() => {
  const session = createSessionHarness({
    sourceIds: ['primary'],
    urls: { primary: 'https://bad' },
  })
  const candidate = await session.nextCandidate()
  assert.equal(session.rejectMedia(candidate.candidateId, {
    name: 'PlaybackSourceError',
    message: `${'x'.repeat(1100)}\nprivate detail`,
    scope: 'session',
    kind: 'cancelled',
    apiId: 'other-owner',
    platform: 'kg',
    statusCode: 418,
    arbitrary: 'must not survive',
  }), 'resumed')

  let aggregate
  await assert.rejects(session.nextCandidate(), error => {
    aggregate = error
    return error.scope == 'session' && error.kind == 'request'
  })
  const failure = aggregate.cause.find(item => item.message.startsWith('x'))
  assert.equal(failure.name, 'PlaybackSourceError')
  assert.equal(failure.message, 'x'.repeat(1024))
  assert.equal(failure.scope, 'candidate')
  assert.equal(failure.kind, 'mediaValidation')
  assert.equal(failure.apiId, 'primary')
  assert.equal(failure.platform, 'wy')
  assert.equal(failure.statusCode, undefined)
  assert.equal(failure.arbitrary, undefined)
  assert.equal(failure.cause, undefined)
})

test('session cancellation never advances to a fallback', async() => {
  const session = createSessionHarness({ sourceIds: ['primary', 'fallback'] })
  session.cancel('songChanged')
  await assert.rejects(session.nextCandidate(), err => err.kind == 'cancelled' && err.scope == 'session')
  assert.deepEqual(session.requestedSourceIds, [])
})

test('one source receives one cumulative ten-second deadline', async() => {
  const clock = createFakeClock(0)
  const session = createSessionHarness({
    clock,
    sourceIds: ['primary', 'fallback'],
    request: async({ apiId }) => {
      if (apiId == 'primary') {
        clock.advance(6000)
        throw playbackError('candidate', 'request', apiId)
      }
      return { url: 'https://fallback', quality: '128k' }
    },
    matched: [matchedTx],
  })
  const first = session.nextCandidate()
  clock.advance(4000)
  await clock.flush()
  const candidate = await first
  assert.equal(candidate.apiId, 'fallback')
  assert.equal(session.diagnostics[0].elapsedMs, 10000)
})

test('a hanging primary request times out as source failure and starts fallback', async() => {
  const clock = createFakeClock(0)
  const session = createSessionHarness({
    clock,
    useRealAdapter: true,
    sourceIds: ['primary', 'fallback'],
    request: ({ apiId }) => apiId == 'primary'
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, value: { data: { type: '128k', url: 'https://fallback' } } }),
  })
  const resolving = session.nextCandidate()
  clock.advance(9999)
  await clock.flush()
  assert.deepEqual(session.requestedSourceIds, ['primary'])
  clock.advance(1)
  await clock.flush()
  assert.equal((await resolving).apiId, 'fallback')
  assert.equal(session.diagnostics[0].kind, 'timeout')
})

test('an operation rejection observed at the exact deadline is a source timeout', async() => {
  const clock = createFakeClock(0)
  const primary = deferred()
  const session = createSessionHarness({
    clock,
    sourceIds: ['primary', 'fallback'],
    request: ({ apiId }) => apiId == 'primary'
      ? primary.promise
      : Promise.resolve({ url: 'https://fallback', quality: '128k' }),
  })
  const resolving = session.nextCandidate()
  await session.waitForSource('primary')
  clock.setNow(10_000)
  primary.reject(playbackError('candidate', 'request', 'primary'))
  await clock.flush()
  const candidate = await resolving
  assert.equal(candidate.apiId, 'fallback')
  assert.equal(session.diagnostics[0].scope, 'source')
  assert.equal(session.diagnostics[0].kind, 'timeout')
})

test('fallback budget starts only when fallback becomes active', async() => {
  const clock = createFakeClock(0)
  const session = createSessionHarness({ clock, sourceIds: ['primary', 'fallback'] })
  const resolving = session.nextCandidate()
  clock.advance(10000)
  await clock.flush()
  await session.waitForSource('fallback')
  assert.deepEqual(session.sourceStarts[1], { apiId: 'fallback', at: 10000 })
  session.succeed('fallback', 'https://fallback')
  const candidate = await resolving
  assert.equal(candidate.deadlineAt, 20000)
})

test('source order is a creation-time snapshot', async() => {
  const settings = { primary: 'a', fallbacks: ['b'] }
  const session = createSessionHarness({ sourceIds: [settings.primary, ...settings.fallbacks] })
  settings.primary = 'c'
  settings.fallbacks.splice(0, 1, 'd')
  assert.deepEqual(session.sourceIds, ['a', 'b'])
})

test('canplay at the exact source deadline expires instead of committing', async() => {
  const clock = createFakeClock(0)
  const session = createSessionHarness({
    clock,
    sourceIds: ['primary', 'fallback'],
    urls: { primary: 'https://primary', fallback: 'https://fallback' },
  })
  const first = await session.nextCandidate()
  clock.advance(10000)
  assert.equal(await session.accept(first.candidateId), 'expired')
  const second = await session.nextCandidate()
  assert.equal(second.apiId, 'fallback')
  assert.deepEqual(session.cacheCommits, [])
})

test('a retained cache commit is observed without delaying accepted playback', async() => {
  const commitGate = deferred()
  const session = createSessionHarness({
    sourceIds: ['primary'],
    urls: { primary: 'https://valid' },
    cacheCommit: () => commitGate.promise,
  })
  const candidate = await session.nextCandidate()
  assert.equal(session.accept(candidate.candidateId), 'accepted')
  assert.deepEqual(session.leaseEvents, ['retain:primary', 'release:primary'])
  assert.deepEqual(session.persistenceFailures, [])
  const reported = session.waitForPersistenceFailure('commit')
  commitGate.reject(Object.assign(new Error('db down with private details'), { code: 'SQLITE_BUSY' }))
  assert.deepEqual(await reported, {
    operation: 'commit', errorName: 'Error', errorCode: 'SQLITE_BUSY',
  })
  assert.equal(JSON.stringify(session.persistenceFailures).includes('private details'), false)
})

test('playback cache preserves reported metadata without changing lookup order', async() => {
  const reads = []
  const cache = createCacheHarness({
    read: async key => {
      reads.push(key.quality)
      return key.quality == '320k'
        ? { url: 'https://cache/320', reportedQuality: '192k' }
        : null
    },
  })
  const hit = await cache.lookup(musicUrlKey(onlineMusic, 'flac'))
  assert.deepEqual(reads, ['flac', '320k'])
  assert.equal(hit.quality, '320k')
  assert.equal(hit.reportedQuality, '192k')
})

test('accepted source candidate commits its optional reported quality', async() => {
  const harness = createSessionHarness({
    request: async() => ({
      url: 'https://source/value', resolvedQuality: '320k', reportedQuality: '192k',
    }),
  })
  const candidate = await harness.nextCandidate()
  assert.equal(harness.accept(candidate.candidateId), 'accepted')
  await harness.flush()
  assert.deepEqual(harness.cacheCommits[0], [candidate.cacheKey, candidate.url, '192k'])
})

test('legacy cache hit carries no reported quality', async() => {
  const harness = createSessionHarness({
    cachedValue: { url: 'https://cache/legacy', reportedQuality: null },
  })
  const candidate = await harness.nextCandidate()
  assert.equal(candidate.origin, 'cache')
  assert.equal(Object.hasOwn(candidate, 'reportedQuality'), false)
})

test('a throwing persistence reporter cannot escape the retained commit observer', async() => {
  const commitGate = deferred()
  const session = createSessionHarness({
    sourceIds: ['primary'],
    urls: { primary: 'https://valid' },
    cacheCommit: () => commitGate.promise,
    throwPersistenceReporter: true,
  })
  const candidate = await session.nextCandidate()
  assert.equal(session.accept(candidate.candidateId), 'accepted')
  const reported = session.waitForPersistenceFailure('commit')
  commitGate.reject(new Error('db down'))
  await reported
  await session.flush()
  assert.deepEqual(session.leaseEvents, ['retain:primary', 'release:primary'])
})

test('cache media rejection and timeout both observe tombstone persistence failure', async() => {
  for (const settlement of ['rejectMedia', 'expireCandidate']) {
    const clock = createFakeClock(0)
    const deleteGate = deferred()
    const session = createSessionHarness({
      clock,
      sourceIds: ['primary'],
      cachedUrl: 'https://cached',
      cacheDelete: () => deleteGate.promise,
    })
    const candidate = await session.nextCandidate()
    const reported = session.waitForPersistenceFailure('delete')
    if (settlement == 'expireCandidate') clock.advance(10_000)
    session[settlement](candidate.candidateId)
    deleteGate.reject(Object.assign(new Error('delete failed with private details'), {
      code: 'SQLITE_IOERR',
    }))
    assert.deepEqual(await reported, {
      operation: 'delete', errorName: 'Error', errorCode: 'SQLITE_IOERR',
    })
  }
})

test('cancelling a pending cache lookup rejects immediately without starting a source', async() => {
  const lookupStarted = deferred()
  const lookupGate = deferred()
  const session = createSessionHarness({
    cacheMode: 'lookup',
    sourceIds: ['primary', 'fallback'],
    cacheRead: () => {
      lookupStarted.resolve()
      return lookupGate.promise
    },
  })
  const resolving = session.nextCandidate()
  await lookupStarted.promise
  session.cancel('songChanged')
  const observed = await Promise.race([
    resolving.then(
      () => ({ state: 'resolved' }),
      error => ({ state: 'rejected', error }),
    ),
    new Promise(resolve => setImmediate(() => resolve({ state: 'pending' }))),
  ])
  lookupGate.resolve('')
  await session.flush()

  assert.equal(observed.state, 'rejected')
  assert.equal(observed.error.scope, 'session')
  assert.equal(observed.error.kind, 'cancelled')
  assert.deepEqual(session.requestedSourceIds, [])
  assert.deepEqual(session.leaseEvents, [
    'retain:primary', 'retain:fallback',
    'release:primary', 'release:fallback',
  ])
})

test('cancelling pending matching rejects immediately without advancing source', async() => {
  const matchingStarted = deferred()
  const matchingGate = deferred()
  const session = createSessionHarness({
    sourceIds: ['primary', 'fallback'],
    request: async({ apiId, musicInfo }) => {
      if (apiId == 'primary' && musicInfo.source == 'wy') {
        throw playbackError('candidate', 'request', apiId)
      }
      return { url: 'https://unexpected', quality: '128k' }
    },
    findCandidates: () => {
      matchingStarted.resolve()
      return matchingGate.promise
    },
  })
  const resolving = session.nextCandidate()
  await matchingStarted.promise
  session.cancel('songChanged')
  const observed = await Promise.race([
    resolving.then(
      () => ({ state: 'resolved' }),
      error => ({ state: 'rejected', error }),
    ),
    new Promise(resolve => setImmediate(() => resolve({ state: 'pending' }))),
  ])
  matchingGate.resolve([])
  await session.flush()

  assert.equal(observed.state, 'rejected')
  assert.equal(observed.error.scope, 'session')
  assert.equal(observed.error.kind, 'cancelled')
  assert.deepEqual(session.requestedSourceIds, ['primary'])
  assert.deepEqual(session.leaseEvents, [
    'retain:primary', 'retain:fallback',
    'release:primary', 'release:fallback',
  ])
})

test('cancelling a request that ignores AbortSignal rejects immediately', async() => {
  const requestStarted = deferred()
  const requestGate = deferred()
  const session = createSessionHarness({
    sourceIds: ['primary', 'fallback'],
    request: ({ apiId }) => {
      requestStarted.resolve()
      return requestGate.promise.then(() => ({
        url: `https://${apiId}`,
        quality: '128k',
      }))
    },
  })
  const resolving = session.nextCandidate()
  await requestStarted.promise
  session.cancel('songChanged')
  const observed = await Promise.race([
    resolving.then(
      () => ({ state: 'resolved' }),
      error => ({ state: 'rejected', error }),
    ),
    new Promise(resolve => setImmediate(() => resolve({ state: 'pending' }))),
  ])
  requestGate.resolve()
  await session.flush()

  assert.equal(observed.state, 'rejected')
  assert.equal(observed.error.scope, 'session')
  assert.equal(observed.error.kind, 'cancelled')
  assert.deepEqual(session.requestedSourceIds, ['primary'])
  assert.deepEqual(session.leaseEvents, [
    'retain:primary', 'retain:fallback',
    'release:primary', 'release:fallback',
  ])
})

test('cache validation receives a fresh ten-second budget after slow lookup', async() => {
  const clock = createFakeClock(0)
  const session = createSessionHarness({
    clock,
    cacheMode: 'lookup',
    sourceIds: ['primary'],
    cacheRead: async() => {
      clock.advance(6000)
      return 'https://cached'
    },
  })
  const candidate = await session.nextCandidate()
  assert.equal(candidate.origin, 'cache')
  assert.equal(candidate.deadlineAt, 16000)
  clock.advance(10000)
  assert.equal(session.accept(candidate.candidateId), 'expired')
  assert.deepEqual(session.cacheCommits, [])
})

test('cache lookup rejection continues through sources and releases leases on success', async() => {
  const calls = []
  const session = createSessionHarness({
    cacheMode: 'lookup',
    sourceIds: ['primary', 'fallback'],
    cacheRead: async() => {
      throw new Error('database failure with private details')
    },
    request: async({ apiId }) => {
      calls.push(apiId)
      if (apiId == 'primary') throw playbackError('source', 'rateLimit', apiId)
      return { url: 'https://fallback', quality: '128k' }
    },
  })
  const candidate = await session.nextCandidate()
  assert.equal(candidate.apiId, 'fallback')
  assert.deepEqual(calls, ['primary', 'fallback'])
  assert.equal(session.accept(candidate.candidateId), 'accepted')
  assert.deepEqual(session.leaseEvents, [
    'retain:primary', 'retain:fallback',
    'release:primary', 'release:fallback',
  ])
  assert.equal(JSON.stringify(session.diagnostics).includes('private details'), false)
})

test('primary failure followed by first fallback success is silent', async () => {
  const harness = createIntegrationHarness()
  const playback = harness.play()
  const primary = await harness.waitForRequest({ apiId: 'primary', platform: 'wy' })
  harness.fail(primary, new Error('ordinary request'))
  const fallback = await harness.waitForRequest({ apiId: 'fallback', platform: 'wy' })
  harness.succeed(fallback, 'https://valid')
  await harness.waitForBoundForeground('https://valid')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.sourceOrder, ['primary', 'fallback'])
  assert.equal(harness.visibleErrorCount, 0)
  assert.equal(harness.persistedPrimary, 'primary')
})

test('multiple source failures can reach a later fallback', async () => {
  const harness = createIntegrationHarness({ sourceIds: ['primary', 'first', 'second'] })
  const playback = harness.play()
  for (const apiId of ['primary', 'first']) {
    const request = await harness.waitForRequest({ apiId, platform: 'wy' })
    harness.fail(request, new Error(`${apiId} failed`))
  }
  const second = await harness.waitForRequest({ apiId: 'second', platform: 'wy' })
  harness.succeed(second, 'https://valid')
  await harness.waitForBoundForeground('https://valid')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.sourceOrder, ['primary', 'first', 'second'])
})

test('a ten-second source deadline cancels the exact broker request before fallback starts', async () => {
  const harness = createIntegrationHarness({ sourceIds: ['primary', 'fallback'] })
  const playback = harness.play()
  const primary = await harness.waitForRequest({ apiId: 'primary', platform: 'wy' })
  await harness.advance(9_999)
  assert.deepEqual(harness.cancelledRequests, [])
  assert.deepEqual(harness.adapterRequestOrder, ['primary:wy'])
  const fallbackPending = harness.waitForRequest({ apiId: 'fallback', platform: 'wy' })
  await harness.advance(1)
  assert.deepEqual(harness.cancelledRequests, [{
    apiId: 'primary', requestId: primary.requestId, reason: 'timeout',
  }])
  const fallback = await fallbackPending
  harness.succeed(fallback, 'https://fallback')
  await harness.waitForBoundForeground('https://fallback')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.adapterRequestOrder, ['primary:wy', 'fallback:wy'])
})

test('foreground setting edits affect only the next resolution session', async () => {
  const harness = createIntegrationHarness({ sourceIds: ['old-primary', 'old-fallback'] })
  const first = harness.play()
  const oldPrimary = await harness.waitForRequest({ apiId: 'old-primary', platform: 'wy' })
  await harness.changeSettings({ primary: 'new-primary', fallbacks: ['new-fallback'] })
  harness.fail(oldPrimary, new Error('old primary failed'))
  const oldFallback = await harness.waitForRequest({ apiId: 'old-fallback', platform: 'wy' })
  harness.succeed(oldFallback, 'https://old-session')
  await harness.waitForBoundForeground('https://old-session')
  harness.emitForegroundCanplay()
  await first
  const second = harness.playAnother(songB)
  const newPrimary = await harness.waitForRequest({
    apiId: 'new-primary', songIdentity: 'wy:song-b', platform: 'wy',
  })
  harness.succeed(newPrimary, 'https://new-session')
  await harness.waitForBoundForeground('https://new-session')
  harness.emitForegroundCanplay()
  await second
  assert.deepEqual(harness.sessionSourceSnapshots, [
    ['old-primary', 'old-fallback'],
    ['new-primary', 'new-fallback'],
  ])
})

test('custom force refresh keeps one settings snapshot without persistent invalidation', async () => {
  const harness = createIntegrationHarness({
    sourceIds: ['old-primary', 'old-fallback'],
    requestedQuality: 'flac',
  })
  const playback = harness.play(onlineMusic, { reason: 'forceRefresh' })
  const oldPrimary = await harness.waitForRequest({ apiId: 'old-primary', platform: 'wy' })
  await harness.changeSettings({
    primary: 'new-primary', fallbacks: ['new-fallback'], requestedQuality: '128k',
  })
  harness.succeed(oldPrimary, 'https://old-session', 'flac')
  await harness.waitForBoundForeground('https://old-session')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.sessionSourceSnapshots, [['old-primary', 'old-fallback']])
  assert.deepEqual(harness.sessionQualitySnapshots, ['flac'])
  assert.deepEqual(harness.invalidatedQualities, [])
  assert.deepEqual(harness.invalidatedCacheKeys, [])
})

test('session cancellation tries no fallback and emits no visible error', async () => {
  const harness = createIntegrationHarness({ sourceIds: ['primary', 'fallback'] })
  const playback = harness.play()
  await harness.waitForRequest({ apiId: 'primary', platform: 'wy' })
  harness.cancelForeground('songChanged')
  await playback
  assert.deepEqual(harness.sourceOrder, ['primary'])
  assert.equal(harness.visibleErrorCount, 0)
  assert.equal(harness.autoSkipCalls, 0)
})
