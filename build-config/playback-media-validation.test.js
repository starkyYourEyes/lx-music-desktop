const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createCacheHarness,
  createIntegrationHarness,
  createSessionHarness,
  createCoordinatorHarness,
  createPlaybackPreloadAudioHarness,
  createPlayerHarness,
  createPreloadSchedulingHarness,
  createFakeClock,
  cancelReasonForResolveReason,
  deferred,
  playbackError,
  onlineMusic,
  matchedTx,
  localMusic,
  song,
  songA,
  songB,
  musicUrlAuthorization,
  musicUrlKey,
  toPlaybackCachePersistenceFailure,
  observePlaybackCachePersistence,
} = require('./test-utils/playback-fallback-harness')

test('preload validation audio mirrors the real player CORS mode', () => {
  const audio = createPlaybackPreloadAudioHarness()
  assert.equal(audio.muted, true)
  assert.equal(audio.preload, 'auto')
  assert.equal(audio.crossOrigin, 'anonymous')
})

test('custom URL canplay never authorizes, persists, or reuses account-scoped cache', async() => {
  const harness = createIntegrationHarness({ sourceIds: ['user_api_primary'] })
  const firstPlayback = harness.play()
  const firstRequest = await harness.waitForRequest({ apiId: 'user_api_primary', platform: 'wy' })
  harness.succeed(firstRequest, 'https://custom/no-cache', '128k')
  const firstBinding = await harness.waitForBoundForeground('https://custom/no-cache', 1)
  harness.emitForegroundCanplay()
  await firstPlayback

  const secondPlayback = harness.play()
  await harness.flush()
  const reusedCache = harness.adapterRequestOrder.length == 1
  if (!reusedCache) {
    const secondRequest = await harness.waitForRequest({
      apiId: 'user_api_primary', platform: 'wy', occurrence: 2,
    })
    harness.succeed(secondRequest, 'https://custom/no-cache', '128k')
  }
  const secondBinding = await harness.waitForBoundForeground('https://custom/no-cache', 2)
  harness.emitForegroundCanplay()
  await secondPlayback

  assert.equal(firstBinding.origin, 'source')
  assert.equal(secondBinding.origin, 'source')
  assert.equal(reusedCache, false)
  assert.equal(harness.authorizationCallCount, 0)
  assert.equal(harness.persistentReadCount, 0)
  assert.equal(harness.persistentWriteCount, 0)
})

test('matched tx fallback persists only the matched track captured authorization', async() => {
  const txAuthorization = musicUrlAuthorization('tx', 'profile-v1:uin:10001', 4)
  const session = createSessionHarness({
    sourceIds: ['builtin'],
    requestedQuality: '320k',
    matched: [matchedTx],
    authorizeMusicUrl: async({ musicInfo, quality }) => musicUrlKey(
      musicInfo,
      quality,
      musicInfo.source == 'tx'
        ? txAuthorization
        : musicUrlAuthorization('wy', 'profile-v1:user-id:7', 2),
    ),
    request: async({ musicInfo }) => {
      if (musicInfo.source == 'wy') throw new Error('original unavailable')
      return { url: 'https://matched/tx', quality: '128k' }
    },
  })

  const candidate = await session.nextCandidate()
  assert.equal(candidate.platform, 'tx')
  assert.deepEqual(candidate.cacheKey, musicUrlKey(matchedTx, '128k', txAuthorization))
  assert.equal(session.accept(candidate.candidateId), 'accepted')
  await session.flush()
  assert.deepEqual(session.cacheSaveCalls, [{
    key: musicUrlKey(matchedTx, '128k', txAuthorization),
    value: {
      url: 'https://matched/tx',
      reportedQuality: null,
    },
  }])
})

test('built-in cache and network operations are preceded by authorization and only quality is rewritten', async() => {
  const events = []
  const authorization = musicUrlAuthorization('wy', 'profile-v1:user-id:7', 8)
  const session = createSessionHarness({
    sourceIds: ['builtin'],
    requestedQuality: '320k',
    cacheMode: 'lookup',
    authorizeMusicUrl: async({ musicInfo, quality }) => {
      events.push(`authorize:${musicInfo.source}:${musicInfo.id}:${quality}`)
      return musicUrlKey(musicInfo, quality, authorization)
    },
    cacheRead: async key => {
      events.push(`read:${key.authorization.generation}:${key.sourceTrackId}:${key.quality}`)
      return null
    },
    request: async({ musicInfo, quality }) => {
      events.push(`network:${musicInfo.source}:${musicInfo.id}:${quality}`)
      return { url: 'https://builtin/lower', quality: '128k' }
    },
  })

  const candidate = await session.nextCandidate()
  assert.deepEqual(events, [
    'authorize:wy:song:320k',
    'read:8:song:320k',
    'read:8:song:128k',
    'authorize:wy:song:320k',
    'network:wy:song:320k',
  ])
  assert.deepEqual(candidate.cacheKey, musicUrlKey(onlineMusic, '128k', authorization))
})

test('candidate validation consumes error without legacy refresh skip or duplicate error', async() => {
  const harness = createPlayerHarness()
  const bound = await harness.bindCandidate('https://bad')
  harness.emitError(bound, 4)
  assert.equal(harness.coordinatorMediaErrors, 1)
  assert.equal(harness.legacyRefreshCalls, 0)
  assert.equal(harness.playerErrorEvents, 0)
  assert.equal(harness.autoSkipCalls, 0)
  assert.equal(harness.loadingWatchdogCount, 0)
})

test('matched fallback commit and post-commit error keep the exact matched authorization key', async() => {
  const harness = createPlayerHarness({
    primary: 'primary',
    fallbacks: ['fallback'],
    winner: 'fallback',
    winnerPlatform: 'tx',
    winnerQuality: '128k',
  })
  const bound = await harness.start()
  assert.equal(bound.platform, 'tx')
  assert.equal(bound.quality, '128k')
  const expectedKey = musicUrlKey(matchedTx, '128k')
  assert.deepEqual(bound.cacheKey, expectedKey)
  harness.emitCanplay(bound)
  assert.equal(harness.cacheCommitCount, 1)
  assert.deepEqual(harness.committedCacheKeys, [expectedKey])
  assert.equal(harness.isValidating(), false)
  await harness.emitError(bound, 3)
  assert.deepEqual(harness.dispatchedResourceKinds, ['candidate', 'validated'])
  assert.deepEqual(harness.tombstonedKeys, [expectedKey])
  assert.deepEqual(harness.refreshRequests, [{ reason: 'postCommitError' }])
  assert.deepEqual(harness.refreshedApiIds, ['primary'])
  assert.deepEqual(harness.postCommitCacheHits, [])
})

test('explicit force refresh clears lower cache and starts full fallback from primary', async() => {
  const harness = createPlayerHarness()
  await harness.forceRefresh()
  assert.deepEqual(harness.invalidatedQualities, ['flac', '320k', '128k'])
  assert.deepEqual(harness.invalidatedCacheKeys, [
    musicUrlKey(onlineMusic, 'flac'),
    musicUrlKey(onlineMusic, '320k'),
    musicUrlKey(onlineMusic, '128k'),
  ])
  assert.deepEqual(harness.refreshRequests[0], { reason: 'forceRefresh' })
  assert.equal(harness.refreshedApiIds[0], 'primary')
})

test('player reasons flow through production playback session factories', async() => {
  const harness = createPlayerHarness()
  await harness.setMusicUrl(onlineMusic, { reason: 'initial' })
  await harness.setMusicUrl(onlineMusic, { reason: 'forceRefresh' })
  const postCommitRefresh = harness.setMusicUrl(onlineMusic, { reason: 'postCommitError' })
  await harness.flush()
  await postCommitRefresh
  assert.deepEqual(harness.sessionFactorySnapshots, [
    {
      sourceIds: ['primary', 'fallback'],
      requestedQuality: 'flac',
      cacheMode: 'lookup',
    },
    {
      sourceIds: ['primary', 'fallback'],
      requestedQuality: 'flac',
      cacheMode: 'bypass',
    },
    {
      sourceIds: ['primary'],
      requestedQuality: 'flac',
      cacheMode: 'bypass',
    },
  ])
  assert.deepEqual(harness.invalidatedQualities, ['flac', '320k', '128k'])
  assert.deepEqual(harness.invalidatedCacheKeys, [
    musicUrlKey(onlineMusic, 'flac'),
    musicUrlKey(onlineMusic, '320k'),
    musicUrlKey(onlineMusic, '128k'),
  ])
})

test('direct local WebDAV and downloaded resources publish quality only on canplay', async() => {
  const harness = createPlayerHarness()
  const resources = [
    [{ kind: 'direct', songIdentity: 'local:local-song', url: 'file:///local.mp3' }, null],
    [{ kind: 'direct', songIdentity: 'webdav:webdav-song', url: 'https://webdav/song.mp3' }, null],
    [{ kind: 'direct', songIdentity: 'wy:song', url: 'file:///downloaded.mp3', reportedQuality: '320k' }, '320k'],
  ]
  for (const [resource, expectedQuality] of resources) {
    const event = harness.bindResource(resource)
    assert.notEqual(harness.loadedMusicIdentity, resource.songIdentity)
    assert.equal(harness.currentPlaybackQuality(), null)
    harness.emitCanplay(event)
    assert.equal(harness.loadedMusicIdentity, resource.songIdentity)
    assert.equal(harness.currentPlaybackQuality(), expectedQuality)
  }
})

test('candidate quality stays hidden until current canplay accepts it', async() => {
  const harness = createPlayerHarness({ sourceReportedQualities: ['flac'] })
  const candidate = await harness.bindCandidate('https://audio/current')
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitLoadeddata(candidate)
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(candidate)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
})

test('fallback rejection never publishes failed quality', async() => {
  const harness = createPlayerHarness({
    sourceUrls: ['https://audio/bad', 'https://audio/good'],
    sourceReportedQualities: ['flac24bit', '192k'],
  })
  const failed = await harness.bindCandidate('https://audio/bad')
  harness.emitError(failed)
  assert.equal(harness.currentPlaybackQuality(), null)
  const accepted = await harness.waitForBoundCandidate('https://audio/good')
  harness.emitCanplay(accepted)
  assert.equal(harness.currentPlaybackQuality(), '192k')
})

test('replacement clears quality and stale canplay cannot restore it', async() => {
  const harness = createPlayerHarness({
    deferredForeground: true,
    sourceReportedQualities: ['320k', 'ape'],
  })
  const oldEvent = harness.bindResource({
    kind: 'direct', songIdentity: 'local:old', url: 'file:///old', reportedQuality: '320k',
  })
  harness.emitCanplay(oldEvent)
  assert.equal(harness.currentPlaybackQuality(), '320k')
  const call = harness.deferNextForeground()
  const replacing = harness.setMusicUrl(songB, { reason: 'initial' })
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(oldEvent)
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.resolveForeground(call, {
    kind: 'direct', songIdentity: 'wy:song-b', url: 'https://new', reportedQuality: 'ape',
  })
  await replacing
})

test('stale direct canplay cannot commit an old song identity', () => {
  const harness = createPlayerHarness()
  const oldEvent = harness.bindResource({ kind: 'direct', songIdentity: 'local:old', url: 'file:///old' })
  const currentEvent = harness.bindResource({ kind: 'direct', songIdentity: 'local:new', url: 'file:///new' })
  harness.emitCanplay(oldEvent)
  assert.notEqual(harness.loadedMusicIdentity, 'local:old')
  harness.emitCanplay(currentEvent)
  assert.equal(harness.loadedMusicIdentity, 'local:new')
})

test('accepted candidate replays loadeddata before canplay after media validation', async() => {
  const harness = createPlayerHarness()
  const candidate = await harness.bindCandidate('https://audio')

  harness.emitLoadeddata(candidate)
  assert.equal(harness.playerLoadeddataEvents, 0)
  harness.emitCanplay(candidate)

  assert.equal(harness.playerLoadeddataEvents, 1)
  assert.deepEqual(harness.playerMediaEvents, ['loadeddata', 'canplay'])
  harness.emitCanplay(candidate)
  assert.equal(harness.playerLoadeddataEvents, 1)
})

test('resource binding disables autoplay and pauses when shouldPlay is false', () => {
  const harness = createPlayerHarness()
  harness.bindResource(
    { kind: 'direct', songIdentity: 'local:paused', url: 'file:///paused.mp3' },
    { shouldPlay: false },
  )
  assert.deepEqual(harness.audioOperations.slice(0, 3), [
    'autoplay:false', 'pause', 'src:file:///paused.mp3',
  ])
  assert.equal(harness.audioOperations.includes('play'), false)
})

test('loadedmetadata seek is one-shot and generation guarded across replacement', () => {
  const harness = createPlayerHarness()
  const oldResource = harness.bindResource(
    { kind: 'direct', songIdentity: 'local:old', url: 'file:///old.mp3' },
    { startTime: 42, shouldPlay: false },
  )
  const currentResource = harness.bindResource(
    { kind: 'direct', songIdentity: 'local:new', url: 'file:///new.mp3' },
    { startTime: 7, shouldPlay: false },
  )
  harness.emitLoadedmetadata(oldResource)
  assert.deepEqual(harness.currentTimeWrites, [])
  harness.emitLoadedmetadata(currentResource)
  harness.emitLoadedmetadata(currentResource)
  assert.deepEqual(harness.currentTimeWrites, [7])
})

test('playback cancellation clears the resource context before late media events', async() => {
  const harness = createPlayerHarness()
  const oldEvent = harness.bindResource({
    kind: 'direct', songIdentity: 'local:old', url: 'file:///old', reportedQuality: 'flac',
  })
  harness.emitCanplay(oldEvent)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
  harness.cancelPlayback('stop')
  assert.equal(harness.currentResource(), null)
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(oldEvent)
  await harness.emitError(oldEvent, 4)
  assert.equal(harness.playerCanplayEvents, 1)
  assert.equal(harness.playerErrorEvents, 0)
  assert.equal(harness.coordinatorMediaErrors, 0)
  assert.equal(harness.loadedMusicIdentity, '')
})

test('starting replacement work clears the previous resource before its request settles', async() => {
  const harness = createPlayerHarness({ deferredForeground: true })
  const oldEvent = harness.bindResource({
    kind: 'direct', songIdentity: 'local:old', url: 'file:///old',
  })
  harness.emitCanplay(oldEvent)
  const call = harness.deferNextForeground()
  const replacing = harness.setMusicUrl(songB, { reason: 'initial' })
  assert.equal(harness.currentResource(), null)
  assert.equal(harness.loadedMusicIdentity, '')
  harness.emitCanplay(oldEvent)
  assert.equal(harness.playerCanplayEvents, 1)
  harness.resolveForeground(call, {
    kind: 'direct', songIdentity: 'wy:song-b', url: 'https://new',
  })
  await replacing
  assert.equal(harness.currentResource().url, 'https://new')
})

test('disposing playback clears the resource and shuts the coordinator down once', async() => {
  const harness = createPlayerHarness()
  const oldEvent = harness.bindResource({
    kind: 'direct', songIdentity: 'local:old', url: 'file:///old', reportedQuality: 'flac',
  })
  harness.emitCanplay(oldEvent)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
  harness.disposePlayback()
  assert.equal(harness.currentResource(), null)
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(oldEvent)
  assert.equal(harness.playerCanplayEvents, 1)
  assert.equal(harness.coordinatorDisposeCount, 1)
})

test('stale candidate canplay and error are swallowed after replacement', async() => {
  const harness = createPlayerHarness({ sourceUrls: ['https://old', 'https://current'] })
  const oldEvent = await harness.bindCandidate('https://old')
  harness.rejectCurrentCandidate()
  const currentEvent = await harness.waitForBoundCandidate('https://current')
  harness.emitCanplay(oldEvent)
  harness.emitError(oldEvent, 4)
  assert.equal(harness.playerCanplayEvents, 0)
  assert.equal(harness.playerErrorEvents, 0)
  assert.deepEqual(harness.setResourceUrls, ['https://old', 'https://current'])
  harness.emitCanplay(currentEvent)
  assert.equal(harness.playerCanplayEvents, 1)
})

test('candidate deadline publishes and binds the fallback resource', async() => {
  const clock = createFakeClock(0)
  const harness = createPlayerHarness({ clock, sourceUrls: ['https://timed-out', 'https://fallback'] })
  await harness.bindCandidate('https://timed-out')
  clock.advance(10_000)
  await clock.flush()
  const next = await harness.waitForBoundCandidate('https://fallback')
  assert.equal(next.url, 'https://fallback')
  assert.deepEqual(harness.setResourceUrls, ['https://timed-out', 'https://fallback'])
})

test('post-bind session exhaustion uses the one final failure path once', async() => {
  const harness = createPlayerHarness({
    sourceUrls: ['https://bad'],
    sourceReportedQualities: ['flac'],
    exhaustAfterMediaError: true,
    autoSkip: true,
  })
  const bound = await harness.bindCandidate('https://bad')
  harness.emitError(bound, 4)
  await harness.flush()
  assert.equal(harness.currentPlaybackQuality(), null)
  assert.equal(harness.visibleErrorCount, 1)
  assert.equal(harness.finalResolutionFailureCount, 1)
  assert.equal(harness.playerErrorEvents, 0)
  assert.equal(harness.autoSkipCalls, 1)
  assert.deepEqual(harness.setResourceUrls, ['https://bad'])
})

test('promoted direct preload commits identity only on real-player canplay', async() => {
  const harness = createPlayerHarness({ directPreloadUrl: 'file:///song.mp3' })
  const preloadListener = await harness.startDirectPreload(localMusic)
  const foregroundListener = await harness.promotePreloadToPlayer(localMusic)
  assert.equal(foregroundListener.kind, 'direct')
  assert.notEqual(harness.loadedMusicIdentity, 'local:local-song')
  assert.equal(harness.emitPreloadCanplay(preloadListener), 'stale')
  harness.emitCanplay(foregroundListener)
  assert.equal(harness.loadedMusicIdentity, 'local:local-song')
  assert.equal(harness.createRequestCount, 1)
})

test('promoted validated preload publishes quality only on real-player canplay', async() => {
  const harness = createPlayerHarness({ sourceReportedQualities: ['flac'] })
  const preloadListener = await harness.startPreload(onlineMusic)
  assert.equal(harness.emitPreloadCanplay(preloadListener), 'accepted')
  assert.equal(harness.currentPlaybackQuality(), null)
  const foregroundListener = await harness.promotePreloadToPlayer(onlineMusic)
  assert.equal(foregroundListener.kind, 'validated')
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(foregroundListener)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
})

test('database save failure after canplay is logged without reversing playback success', async() => {
  const harness = createPlayerHarness({ rejectCacheSave: true })
  const bound = await harness.bindCandidate('https://valid')
  harness.emitCanplay(bound)
  await harness.flush()
  assert.equal(harness.loadedMusicIdentity, bound.songIdentity)
  assert.equal(harness.visibleErrorCount, 0)
  assert.equal(harness.persistenceErrorCount, 1)
})

test('post-commit delete and throwing persistence reporter cannot escape observation', async() => {
  const harness = createPlayerHarness({
    rejectCacheDelete: true,
    throwPersistenceReporter: true,
  })
  const bound = await harness.bindCandidate('https://valid')
  harness.emitCanplay(bound)
  await harness.emitError(bound, 3)
  await harness.flush()
  assert.equal(harness.persistenceErrorCount, 1)
  assert.equal(harness.playerErrorEvents, 1)
  assert.deepEqual(harness.refreshRequests, [{ reason: 'postCommitError' }])
})

test('post-commit error clears old quality before retry publishes the replacement', async() => {
  const harness = createPlayerHarness({
    sourceUrls: ['https://initial'], sourceReportedQualities: ['flac', '128k'],
  })
  const initial = await harness.bindCandidate('https://initial')
  harness.emitCanplay(initial)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
  await harness.emitError(initial, 3)
  assert.equal(harness.currentPlaybackQuality(), null)
  await harness.flush()
  const replacement = harness.currentResource()
  harness.emitCanplay(replacement)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
})

test('all-source failure emits once and applies the configured auto-skip policy', async() => {
  for (const autoSkip of [true, false]) {
    const harness = createPlayerHarness({ allSourcesFail: true, autoSkip })
    await harness.start()
    assert.equal(harness.visibleErrorCount, 1)
    assert.equal(harness.playerErrorEvents, 0)
    assert.equal(harness.autoSkipCalls, autoSkip ? 1 : 0)
    assert.equal(harness.sessionCreateCount, 1)
  }
})

test('late success from a replaced same-song request cannot bind over the current resource', async() => {
  const harness = createPlayerHarness({ deferredForeground: true })
  const oldCall = harness.deferNextForeground()
  const oldRun = harness.setMusicUrl(onlineMusic, { reason: 'initial' })
  const currentCall = harness.deferNextForeground()
  const currentRun = harness.setMusicUrl(onlineMusic, { reason: 'forceRefresh' })
  harness.resolveForeground(currentCall, {
    kind: 'direct', songIdentity: 'wy:song', url: 'https://current',
  })
  await currentRun
  harness.resolveForeground(oldCall, {
    kind: 'direct', songIdentity: 'wy:song', url: 'https://old',
  })
  await oldRun
  assert.deepEqual(harness.setResourceUrls, ['https://current'])
})

test('late non-cancellation failure from a replaced same-song request is silent', async() => {
  const harness = createPlayerHarness({ deferredForeground: true, autoSkip: true })
  const oldCall = harness.deferNextForeground()
  const oldRun = harness.setMusicUrl(onlineMusic, { reason: 'initial' })
  const currentCall = harness.deferNextForeground()
  const currentRun = harness.setMusicUrl(onlineMusic, { reason: 'forceRefresh' })
  harness.resolveForeground(currentCall, {
    kind: 'direct', songIdentity: 'wy:song', url: 'https://current',
  })
  await currentRun
  harness.rejectForeground(oldCall, playbackError('source', 'runtimeCrash', 'primary'))
  await oldRun
  assert.equal(harness.visibleErrorCount, 0)
  assert.equal(harness.autoSkipCalls, 0)
  assert.deepEqual(harness.setResourceUrls, ['https://current'])
})

test('next-song preload observes initial exhaustion and always clears loading state', async() => {
  const harness = createPlayerHarness({ allPreloadSourcesFail: true })
  await harness.preloadNext(song)
  assert.deepEqual(harness.preloadLoadingTransitions, [true, false])
  assert.equal(harness.preloadFailureRecords, 1)
  assert.equal(harness.visibleErrorCount, 0)
})

test('preload scheduling allows only one selector and does not restart the same identity', async() => {
  const harness = createPreloadSchedulingHarness()
  harness.tick(91, 100)
  harness.tick(92, 100)
  await harness.waitForSelection(1)
  assert.equal(harness.selectorCallCount, 1)
  harness.resolveSelection(1, songA)
  await harness.flush()
  harness.tick(95, 100)
  await harness.waitForSelection(2)
  harness.resolveSelection(2, songA)
  await harness.flush()
  assert.deepEqual(harness.coordinatorStartIdentities, ['wy:song'])
  assert.deepEqual(harness.coordinatorCancelReasons, [])
})

test('a changed next-song identity replaces the existing preload', async() => {
  const harness = createPreloadSchedulingHarness()
  harness.tick(91, 100)
  await harness.waitForSelection(1)
  harness.resolveSelection(1, songA)
  await harness.flush()
  harness.tick(95, 100)
  await harness.waitForSelection(2)
  harness.resolveSelection(2, songB)
  await harness.flush()
  assert.deepEqual(harness.coordinatorCancelReasons, ['preloadReplaced'])
  assert.deepEqual(harness.coordinatorStartIdentities, ['wy:song', 'wy:song-b'])
})

test('selector rejection is observed and a later tick can retry', async() => {
  const harness = createPreloadSchedulingHarness()
  harness.tick(91, 100)
  await harness.waitForSelection(1)
  harness.rejectSelection(1)
  await harness.flush()
  harness.tick(95, 100)
  await harness.waitForSelection(2)
  assert.equal(harness.selectorCallCount, 2)
  assert.equal(harness.selectionFailureCount, 1)
  assert.equal(harness.unhandledRejectionCount, 0)
})

test('unmount blocks a late selector and future controller starts', async() => {
  const harness = createPreloadSchedulingHarness()
  harness.tick(91, 100)
  await harness.waitForSelection(1)
  harness.dispose()
  harness.resolveSelection(1, songA)
  await harness.flush()
  await harness.startControllerAfterDispose(songB)
  assert.deepEqual(harness.coordinatorStartIdentities, [])
  assert.equal(harness.unhandledRejectionCount, 0)
})

test('a provisional cache timeout uses its own ten seconds then starts primary with a fresh budget', async() => {
  const clock = createFakeClock(0)
  const harness = createCoordinatorHarness({ clock, cachedUrl: 'https://cached', sourceUrl: 'https://primary' })
  const candidate = await harness.startForeground()
  assert.equal(candidate.origin, 'cache')
  clock.advance(10000)
  await clock.flush()
  assert.equal(harness.deletedCacheKeys[0], candidate.cacheKey)
  const next = harness.currentCandidate()
  assert.equal(next.apiId, 'primary')
  assert.equal(next.deadlineAt, 20000)
  assert.deepEqual(harness.publishedForegroundUrls, ['https://primary'])
})

test('a preload cache timeout deletes its exact key and starts primary with a fresh budget', async() => {
  const clock = createFakeClock(0)
  const harness = createCoordinatorHarness({ clock, cachedUrl: 'https://cached', sourceUrl: 'https://primary' })
  const candidate = await harness.startPreload(song)
  assert.equal(candidate.origin, 'cache')
  clock.advance(10_000)
  await clock.flush()
  assert.deepEqual(harness.deletedCacheKeys, [candidate.cacheKey])
  const next = harness.currentPreloadCandidate()
  assert.equal(next.apiId, 'primary')
  assert.equal(next.deadlineAt, 20_000)
})

test('pre-canplay media error resumes the same session cursor', async() => {
  const harness = createCoordinatorHarness({ sourceUrls: ['https://bad', 'https://good'] })
  const first = await harness.startForeground()
  assert.equal(harness.handleForegroundError(first), 'resumed')
  assert.deepEqual(harness.detachedForegroundUrls, ['https://bad'])
  const second = await harness.waitForForegroundCandidate()
  assert.notEqual(second.candidateId, first.candidateId)
  assert.equal(second.apiId, first.apiId)
  assert.equal(harness.sessionCreateCount, 1)
  assert.deepEqual(harness.publishedForegroundUrls, ['https://good'])
})

test('foreground exhaustion publishes one terminal failure after detaching the bad resource', async() => {
  const harness = createCoordinatorHarness({ sourceUrls: ['https://bad'], exhaustAfterMediaError: true })
  const first = await harness.startForeground()
  assert.equal(harness.handleForegroundError(first), 'resumed')
  const failure = await harness.waitForForegroundFailure()
  assert.equal(failure.name, 'PlaybackSourceError')
  assert.equal(harness.foregroundFailures.length, 1)
  assert.deepEqual(harness.foregroundLifecycle, [
    'detach:https://bad',
    'failure',
  ])
})

test('late media events from a replaced candidate are stale and never reach legacy handlers', async() => {
  const harness = createCoordinatorHarness({ sourceUrls: ['https://bad', 'https://good'] })
  const first = await harness.startForeground()
  harness.handleForegroundError(first)
  const second = await harness.waitForForegroundCandidate()
  assert.equal(harness.handleForegroundCanplay(first).status, 'stale')
  assert.equal(harness.handleForegroundError(first), 'stale')
  assert.equal(harness.currentCandidate().candidateId, second.candidateId)
})

test('deadline wins when media error occurs at the exact same clock time', async() => {
  const clock = createFakeClock(0)
  const harness = createCoordinatorHarness({ clock, sourceIds: ['primary', 'fallback'] })
  const first = await harness.startForeground()
  clock.advance(10000)
  assert.equal(harness.handleForegroundError(first), 'stale')
  await clock.flush()
  assert.equal(harness.currentCandidate().apiId, 'fallback')
  assert.deepEqual(harness.publishedForegroundUrls, ['https://fallback'])
})

test('foreground resolve reasons map to valid cancellation reasons', () => {
  assert.equal(cancelReasonForResolveReason('initial'), 'songChanged')
  assert.equal(cancelReasonForResolveReason('forceRefresh'), 'forceRefresh')
  assert.equal(cancelReasonForResolveReason('postCommitError'), 'forceRefresh')
})

test('completed preload is consumed without another source request', async() => {
  const harness = createCoordinatorHarness()
  const preload = await harness.startPreload(song)
  await harness.preloadCanplay(preload)
  const foreground = await harness.startForeground(song)
  assert.equal(foreground.url, preload.url)
  assert.equal(foreground.kind, 'validated')
  assert.equal(harness.createRequestCount, 1)
  assert.equal(harness.cacheCommitCount, 1)
  assert.equal(harness.releaseSourcesCount, 1)
  harness.cancelForeground('stop')
  await harness.startForeground(song)
  assert.equal(harness.createRequestCount, 2)
})

test('foreground adopts the same pending work while a matching preload is resolving', async() => {
  const requestGate = deferred()
  const harness = createCoordinatorHarness({ createRequest: () => requestGate.promise })
  const preloadPromise = harness.startPreload(song)
  await harness.waitForPreloadPhase('resolving')
  const foregroundPromise = harness.startForeground(song)
  assert.equal(harness.createRequestCount, 1)
  requestGate.resolve({ kind: 'session', session: harness.session })
  const [preload, foreground] = await Promise.all([preloadPromise, foregroundPromise])
  assert.equal(foreground.sessionId, preload.sessionId)
  assert.equal(foreground.candidateId, preload.candidateId)
  assert.equal(harness.nextCandidateCount, 1)
  assert.equal(harness.preloadValidator.bound, false)
})

test('different-song foreground replaces the obsolete preload exactly once', async() => {
  const harness = createCoordinatorHarness()
  const preload = await harness.startPreload(songA)

  const foreground = await harness.startForeground(songB)

  assert.notEqual(foreground.songIdentity, preload.songIdentity)
  assert.deepEqual(harness.sessionCancelReasons, ['preloadReplaced'])
  assert.equal(harness.preloadCanplay(preload), 'stale')
  assert.equal(harness.createRequestCount, 2)
})

test('a session returned after its pending preload request was cancelled releases its lease once', async() => {
  const requestGate = deferred()
  const harness = createCoordinatorHarness({ createRequest: () => requestGate.promise })
  const pending = harness.startPreload(song)
  await harness.waitForPreloadPhase('resolving')
  harness.cancelPreload('preloadReplaced')
  requestGate.resolve({ kind: 'session', session: harness.session })
  await assert.rejects(
    pending,
    error => error.scope == 'session' && error.kind == 'cancelled',
  )
  assert.deepEqual(harness.sessionCancelReasons, ['preloadReplaced'])
  assert.equal(harness.releaseSourcesCount, 1)
  assert.equal(harness.nextCandidateCount, 0)
})

test('foreground cancellation normalizes a later factory rejection to session cancellation', async() => {
  const requestGate = deferred()
  const factoryFailure = new Error('private factory failure')
  const harness = createCoordinatorHarness({ createRequest: () => requestGate.promise })
  const pending = harness.startForeground(song)
  await harness.waitForPreloadPhase('resolving')
  harness.cancelForeground('stop')
  requestGate.reject(factoryFailure)
  const rejection = await pending.then(assert.fail, error => error)
  assert.notEqual(rejection, factoryFailure)
  assert.equal(rejection.name, 'PlaybackSourceError')
  assert.equal(rejection.scope, 'session')
  assert.equal(rejection.kind, 'cancelled')
  assert.deepEqual(harness.foregroundFailures, [])
  assert.deepEqual(harness.publishedForegroundUrls, [])
  assert.equal(harness.preloadValidator.bound, false)
})

test('coordinator disposal normalizes a later preload factory rejection to session cancellation', async() => {
  const requestGate = deferred()
  const factoryFailure = new Error('private preload factory failure')
  const harness = createCoordinatorHarness({ createRequest: () => requestGate.promise })
  const pending = harness.startPreload(song)
  await harness.waitForPreloadPhase('resolving')
  harness.dispose()
  requestGate.reject(factoryFailure)
  const rejection = await pending.then(assert.fail, error => error)
  assert.notEqual(rejection, factoryFailure)
  assert.equal(rejection.name, 'PlaybackSourceError')
  assert.equal(rejection.scope, 'session')
  assert.equal(rejection.kind, 'cancelled')
  assert.deepEqual(harness.foregroundFailures, [])
  assert.deepEqual(harness.publishedForegroundUrls, [])
  assert.equal(harness.preloadValidator.bound, false)
})

test('coordinator disposal shuts down live foreground and preload sessions once', async() => {
  const harness = createCoordinatorHarness()
  await harness.startForeground(songA)
  await harness.startPreload(songB)
  harness.dispose()
  harness.dispose()
  assert.deepEqual(harness.sessionCancelReasons, ['shutdown', 'shutdown'])
  assert.equal(harness.releaseSourcesCount, 2)
  assert.equal(harness.preloadValidator.detached, true)
})

test('coordinator shutdown cancels a session returned after its factory record closed', async() => {
  const requestGate = deferred()
  const harness = createCoordinatorHarness({ createRequest: () => requestGate.promise })
  const pending = harness.startPreload(song)
  await harness.waitForPreloadPhase('resolving')
  harness.dispose()
  harness.dispose()
  requestGate.resolve({ kind: 'session', session: harness.session })
  await assert.rejects(
    pending,
    error => error.scope == 'session' && error.kind == 'cancelled',
  )
  assert.deepEqual(harness.sessionCancelReasons, ['shutdown'])
  assert.equal(harness.releaseSourcesCount, 1)
  assert.equal(harness.nextCandidateCount, 0)
  assert.deepEqual(harness.foregroundFailures, [])
})

test('promotion adopts the exact next-candidate promise after a preload media error', async() => {
  const harness = createCoordinatorHarness({
    sourceUrls: ['https://a', 'https://b'],
    blockCandidateNumber: 2,
  })
  const first = await harness.startPreload(song)
  harness.preloadError(first)
  await harness.waitForPreloadPhase('resolving')
  const foreground = harness.startForeground(song)
  harness.releaseCandidate(2)
  const second = await foreground
  assert.equal(second.url, 'https://b')
  assert.equal(second.sessionId, first.sessionId)
  assert.equal(second.deadlineAt, first.deadlineAt)
  assert.equal(harness.nextCandidateCount, 2)
  assert.deepEqual(harness.preloadValidator.boundUrls, ['https://a'])
  assert.equal(harness.createRequestCount, 1)
})

test('queued preload events cannot settle the next candidate binding', async() => {
  const harness = createCoordinatorHarness({
    sourceUrls: ['https://old', 'https://next'],
  })
  const first = await harness.startPreload(song)
  const queuedCanplay = harness.queuePreloadEvent('canplay')

  assert.equal(harness.preloadError(first), 'resumed')
  await harness.flush()
  const next = harness.currentPreloadCandidate()
  assert.equal(next.url, 'https://next')

  assert.equal(queuedCanplay(), 'stale')
  assert.equal(harness.cacheCommitCount, 0)
  assert.equal(harness.preloadCanplay(next), 'accepted')
  assert.equal(harness.cacheCommitCount, 1)
})

test('a promoted validating preload retains its old settings snapshot', async() => {
  const harness = createCoordinatorHarness({
    sourceIds: ['old-primary', 'old-fallback'],
    sourceUrls: ['https://old-primary', 'https://old-fallback'],
  })
  const first = await harness.startPreload(song)
  harness.changeFutureSourceIds(['new-primary', 'new-fallback'])
  const promoted = await harness.startForeground(song)
  assert.equal(promoted.candidateId, first.candidateId)
  harness.handleForegroundError(promoted)
  const second = await harness.waitForForegroundCandidate()
  assert.equal(second.apiId, 'old-fallback')
  assert.equal(second.deadlineAt, first.deadlineAt)
  assert.deepEqual(harness.requestedSourceIds, ['old-primary', 'old-fallback'])
  assert.equal(harness.createRequestCount, 1)
})

test('preload exhaustion after a media error closes silently', async() => {
  const harness = createCoordinatorHarness({ sourceUrls: ['https://bad'], exhaustAfterMediaError: true })
  const first = await harness.startPreload(song)
  harness.preloadError(first)
  await harness.flush()
  assert.deepEqual(harness.foregroundFailures, [])
  assert.equal(harness.visibleErrorCount, 0)
  const fresh = await harness.startForeground(song)
  assert.notEqual(fresh.sessionId, first.sessionId)
  assert.equal(harness.createRequestCount, 2)
})

test('in-flight preload promotion keeps candidate cursor and deadline', async() => {
  const harness = createCoordinatorHarness()
  const preload = await harness.startPreload(song)
  const deadlineAt = preload.deadlineAt
  const promoted = await harness.promote(song)
  assert.equal(promoted.sessionId, preload.sessionId)
  assert.equal(promoted.candidateId, preload.candidateId)
  assert.equal(promoted.deadlineAt, deadlineAt)
  assert.equal(harness.preloadValidator.detached, true)
  assert.equal(harness.sessionCreateCount, 1)
})

test('promotion first detaches preload so a later preload canplay is stale', async() => {
  const harness = createCoordinatorHarness()
  const preload = await harness.startPreload(song)
  const promoted = await harness.startForeground(song)
  assert.equal(promoted.candidateId, preload.candidateId)
  assert.equal(harness.preloadCanplay(preload), 'stale')
  assert.equal(harness.cacheCommitCount, 0)
})

test('an in-flight direct preload promotes to the real player without a second lookup', async() => {
  const harness = createCoordinatorHarness({ directUrl: 'file:///song.mp3' })
  const preload = await harness.startPreload(localMusic)
  assert.equal(preload.kind, 'direct')
  const foreground = await harness.startForeground(localMusic)
  assert.deepEqual(foreground, preload)
  assert.equal(harness.preloadCanplay(preload), 'stale')
  assert.equal(harness.createRequestCount, 1)
  assert.equal(harness.cacheCommitCount, 0)
})

test('preload canplay first linearizes one commit before foreground handoff', async() => {
  const harness = createCoordinatorHarness()
  const preload = await harness.startPreload(song)
  await harness.preloadCanplay(preload)
  const foreground = await harness.startForeground(song)
  assert.equal(foreground.kind, 'validated')
  assert.equal(harness.cacheCommitCount, 1)
  assert.equal(harness.releaseSourcesCount, 1)
  assert.equal(harness.sessionCreateCount, 1)
})

test('completed direct preload hands off as validated without creating a session', async() => {
  const harness = createCoordinatorHarness({ directUrl: 'file:///song.mp3' })
  const preload = await harness.startPreload(localMusic)
  await harness.preloadCanplay(preload)
  const foreground = await harness.startForeground(localMusic)
  assert.equal(foreground.kind, 'validated')
  assert.equal(foreground.origin, 'direct')
  assert.equal(harness.sessionCreateCount, 0)
  assert.equal(harness.cacheCommitCount, 0)
})

test('force refresh cancels a matching validating preload before creating fresh work', async() => {
  const harness = createCoordinatorHarness()
  const preload = await harness.startPreload(song)
  const refreshed = await harness.startForeground(song, 'forceRefresh')
  assert.notEqual(refreshed.sessionId, preload.sessionId)
  assert.equal(harness.preloadCanplay(preload), 'stale')
  assert.deepEqual(harness.sessionCancelReasons, ['forceRefresh'])
  assert.equal(harness.createRequestCount, 2)
})

test('post-commit recovery discards a matching validated preload before fresh primary-only work', async() => {
  const harness = createCoordinatorHarness({
    sourceUrls: ['https://preload', 'https://recovery', 'https://fresh'],
  })
  const preload = await harness.startPreload(song)
  await harness.preloadCanplay(preload)
  const recovered = await harness.startForeground(song, 'postCommitError')
  assert.notEqual(recovered.url, preload.url)
  assert.equal(harness.createRequestCount, 2)
  assert.deepEqual(harness.createdReasons, ['preload', 'postCommitError'])
  harness.cancelForeground('stop')
  const fresh = await harness.startForeground(song)
  assert.equal(fresh.url, 'https://fresh')
  assert.equal(harness.createRequestCount, 3)
  assert.deepEqual(harness.createdReasons, ['preload', 'postCommitError', 'initial'])
})

test('playback cache looks from requested quality downward', async () => {
  const cache = createCacheHarness({
    rows: new Map([['song_flac', { url: 'https://cached/flac', reportedQuality: null }]]),
  })
  assert.deepEqual(cache.getPlaybackQualityOrder('flac24bit'), ['flac24bit', 'flac', '320k', '128k'])
  assert.deepEqual(await cache.lookup(musicUrlKey(onlineMusic, 'flac24bit')), {
    key: musicUrlKey(onlineMusic, 'flac'), quality: 'flac', url: 'https://cached/flac', provisional: true,
  })
})

test('bad provisional cache is tombstoned before asynchronous deletion', async () => {
  const gate = deferred()
  const cache = createCacheHarness({
    rows: new Map([['song_320k', { url: 'https://bad', reportedQuality: null }]]),
    remove: () => gate.promise,
  })
  const key = musicUrlKey(onlineMusic, '320k')
  const hit = await cache.lookup(key)
  const deleting = cache.tombstoneKey(hit.key)
  assert.equal(await cache.lookup(key), null)
  gate.resolve()
  await deleting
})

test('an exact committed key can be tombstoned before post-commit recovery', async () => {
  const gate = deferred()
  const cache = createCacheHarness({ rows: new Map([['song_320k', 'https://fallback']]), remove: () => gate.promise })
  const key = musicUrlKey(onlineMusic, '320k')
  const deleting = cache.tombstoneKey(key)
  assert.equal(await cache.lookup(key), null)
  gate.resolve()
  await deleting
})

test('a tombstone created while an exact database read is pending suppresses the stale row', async () => {
  const readStarted = deferred()
  const readGate = deferred()
  const cache = createCacheHarness({
    read: async key => {
      readStarted.resolve(structuredClone(key))
      await readGate.promise
      return key.quality == '320k' ? 'https://stale' : null
    },
  })
  const key = musicUrlKey(onlineMusic, '320k')
  const lookup = cache.lookup(key)
  assert.deepEqual(await readStarted.promise, key)
  const deleting = cache.tombstoneKey(key)
  readGate.resolve()
  assert.equal(await lookup, null)
  await deleting
})

test('commit publishes memory before database persistence settles', async () => {
  const gate = deferred()
  const cache = createCacheHarness({ save: () => gate.promise })
  const key = musicUrlKey(onlineMusic, '320k')
  const writing = cache.commit(key, 'https://valid')
  assert.deepEqual(await cache.lookup(key), {
    key, quality: '320k', url: 'https://valid', provisional: false,
  })
  gate.resolve()
  await writing
})

test('persistence failure does not revoke an already published commit', async () => {
  const cache = createCacheHarness({ save: async() => { throw new Error('db down') } })
  const key = musicUrlKey(onlineMusic, '320k')
  await assert.rejects(cache.commit(key, 'https://valid'), /db down/)
  assert.equal((await cache.lookup(key)).url, 'https://valid')
})

test('persistence failure diagnostics contain only bounded identifiers', () => {
  const reason = Object.assign(new Error('https://private.example/song?token=secret'), {
    code: 'SQLITE_BUSY', token: 'secret',
  })
  const failure = toPlaybackCachePersistenceFailure('commit', reason)
  assert.deepEqual(failure, {
    operation: 'commit', errorName: 'Error', errorCode: 'SQLITE_BUSY',
  })
  assert.equal(JSON.stringify(failure).includes('private.example'), false)
  assert.equal(JSON.stringify(failure).includes('secret'), false)

  const tokenShapedFields = toPlaybackCachePersistenceFailure('delete', {
    name: 'sk_live_ABC123', code: 'sk_live_DEF456',
  })
  assert.deepEqual(tokenShapedFields, {
    operation: 'delete', errorName: 'UnknownError',
  })
  assert.equal(JSON.stringify(tokenShapedFields).includes('sk_live'), false)

  assert.deepEqual(toPlaybackCachePersistenceFailure('delete', Object.assign(
    new Error('cache_open_failed'),
    { code: 'cache_open_failed' },
  )), {
    operation: 'delete', errorName: 'Error', errorCode: 'cache_open_failed',
  })
})

test('persistence observer absorbs both persistence and reporter rejection', async () => {
  let reportCount = 0
  await assert.doesNotReject(observePlaybackCachePersistence(
    Promise.reject(Object.assign(new Error('db down'), { code: 'SQLITE_IOERR' })),
    'delete',
    () => {
      reportCount++
      throw new Error('logger down')
    },
  ))
  assert.equal(reportCount, 1)
})

test('per-key persistence cannot resurrect an old URL or delete a newer commit', async () => {
  const firstSave = deferred()
  const durableRows = new Map()
  let saveCount = 0
  const cache = createCacheHarness({
    rows: durableRows,
    save: async(key, value) => {
      saveCount++
      if (saveCount == 1) await firstSave.promise
      durableRows.set(`${key.sourceTrackId}_${key.quality}`, value)
    },
    remove: async key => { durableRows.delete(`${key.sourceTrackId}_${key.quality}`) },
  })
  const key = musicUrlKey(onlineMusic, '320k')
  const oldWrite = cache.commit(key, 'https://fallback')
  await Promise.resolve()
  const deleting = cache.tombstoneKey(key)
  const newWrite = cache.commit(key, 'https://primary')
  assert.equal((await cache.lookup(key)).url, 'https://primary')
  assert.equal(saveCount, 1)
  firstSave.resolve()
  await Promise.all([oldWrite, deleting, newWrite])
  assert.deepEqual(durableRows.get('song_320k'), {
    url: 'https://primary',
    reportedQuality: null,
  })
  assert.deepEqual(cache.persistenceMutations, [
    'save:song_320k:https://fallback',
    'remove:song_320k',
    'save:song_320k:https://primary',
  ])
})

test('force refresh invalidates requested and lower qualities only', async () => {
  const cache = createCacheHarness({ rows: new Map([
    ['song_flac24bit', 'a'], ['song_flac', 'b'], ['song_320k', 'c'], ['song_128k', 'd'],
  ]) })
  await cache.invalidateQualityRange(musicUrlKey(onlineMusic, 'flac'))
  assert.deepEqual(cache.removed, [
    musicUrlKey(onlineMusic, 'flac'),
    musicUrlKey(onlineMusic, '320k'),
    musicUrlKey(onlineMusic, '128k'),
  ])
})

test('validated memory cannot replay after account authorization changes generation', async() => {
  const accountA = musicUrlAuthorization('wy', 'profile-v1:user-id:7', 1)
  const accountB = musicUrlAuthorization('wy', 'profile-v1:user-id:8', 2)
  const cache = createCacheHarness({
    read: async() => null,
    save: async() => {},
  })
  await cache.commit(musicUrlKey(onlineMusic, '320k', accountA), 'https://account-a')
  assert.equal(await cache.lookup(musicUrlKey(onlineMusic, '320k', accountB)), null)
})

test('adopting a newer cache generation revokes a validated URL before its lookup is delivered', async() => {
  const cache = createCacheHarness({ read: async() => null })
  const key = musicUrlKey(onlineMusic, '320k')
  await cache.commit(key, 'https://validated/pre-generation')

  const lookup = cache.lookup(key)
  cache.durableRows.clear()
  cache.adoptCacheGeneration?.(1)

  assert.equal(await lookup, null)
  assert.equal(await cache.lookup(key), null)
})

test('adopting a newer cache generation suppresses an already in-flight durable lookup', async() => {
  const readStarted = deferred()
  const readGate = deferred()
  const cache = createCacheHarness({
    read: async() => {
      readStarted.resolve()
      return readGate.promise
    },
  })
  const key = musicUrlKey(onlineMusic, '320k')
  const lookup = cache.lookup(key)
  await readStarted.promise

  cache.adoptCacheGeneration?.(1)
  readGate.resolve('https://durable/pre-generation')

  assert.equal(await lookup, null)
})

test('a post-adoption lookup waits for stale same-key save cleanup before reading durability', async() => {
  const saveVisible = deferred()
  const saveMayReturn = deferred()
  const durableRows = new Map()
  const events = []
  const key = musicUrlKey(onlineMusic, '320k')
  const cache = createCacheHarness({
    rows: durableRows,
    read: async readKey => {
      const value = durableRows.get(`${readKey.sourceTrackId}_${readKey.quality}`) ?? null
      events.push(`read:${value?.url ?? 'miss'}`)
      return value
    },
    save: async(saveKey, value) => {
      durableRows.set(`${saveKey.sourceTrackId}_${saveKey.quality}`, value)
      events.push(`save:${value.url}`)
      saveVisible.resolve()
      await saveMayReturn.promise
    },
    remove: async removeKey => {
      events.push('remove')
      durableRows.delete(`${removeKey.sourceTrackId}_${removeKey.quality}`)
    },
  })
  const staleUrl = 'https://commit/pre-generation'
  const staleCommit = cache.commit(key, staleUrl)
  await saveVisible.promise

  cache.adoptCacheGeneration?.(1)
  const lookup = cache.lookup(key)
  queueMicrotask(() => {
    events.push('release')
    saveMayReturn.resolve()
  })

  const observed = await lookup
  await staleCommit
  assert.equal(observed, null)
  assert.deepEqual(events, [
    `save:${staleUrl}`,
    'release',
    'remove',
    'read:miss',
    'read:miss',
  ])
})

test('stale in-flight commit cleanup cannot delete a newer current-generation commit', async() => {
  const saveStarted = deferred()
  const saveGate = deferred()
  const durableRows = new Map()
  let saveCount = 0
  const cache = createCacheHarness({
    rows: durableRows,
    save: async(key, value) => {
      saveCount++
      if (saveCount == 1) {
        saveStarted.resolve()
        await saveGate.promise
      }
      durableRows.set(`${key.sourceTrackId}_${key.quality}`, value)
    },
  })
  const key = musicUrlKey(onlineMusic, '320k')
  const staleCommit = cache.commit(key, 'https://commit/pre-generation')
  await saveStarted.promise

  cache.adoptCacheGeneration?.(1)
  const currentUrl = 'https://commit/current-generation'
  const currentCommit = cache.commit(key, currentUrl)
  saveGate.resolve()
  await Promise.all([staleCommit, currentCommit])

  assert.deepEqual(await cache.lookup(key), {
    key,
    quality: '320k',
    url: currentUrl,
    provisional: false,
  })
  assert.deepEqual(durableRows.get('song_320k'), {
    url: currentUrl,
    reportedQuality: null,
  })
  assert.deepEqual(cache.persistenceMutations, [
    'save:song_320k:https://commit/pre-generation',
    'remove:song_320k',
    'save:song_320k:https://commit/current-generation',
  ])
})

test('cached media rejection tombstones the exact captured account key', async() => {
  const accountA = musicUrlAuthorization('wy', 'profile-v1:user-id:7', 1)
  const accountB = musicUrlAuthorization('wy', 'profile-v1:user-id:8', 2)
  let currentAuthorization = accountA
  const session = createSessionHarness({
    sourceIds: ['builtin'],
    requestedQuality: '320k',
    cacheMode: 'lookup',
    authorizeMusicUrl: async({ musicInfo, quality }) => (
      musicUrlKey(musicInfo, quality, currentAuthorization)
    ),
    urls: { builtin: 'https://network' },
    cacheRead: async key => typeof key == 'string' || key.authorization.accountScope == accountA.accountScope
      ? 'https://account-a/cached'
      : null,
  })
  const candidate = await session.nextCandidate()
  assert.deepEqual(candidate.cacheKey, musicUrlKey(onlineMusic, '320k', accountA))

  currentAuthorization = accountB
  assert.equal(session.rejectMedia(candidate.candidateId), 'resumed')
  await session.flush()
  assert.deepEqual(session.cacheRemoved, [musicUrlKey(onlineMusic, '320k', accountA)])
})

test('source media rejection tombstones its captured key before resuming under current authorization', async() => {
  const accountA = musicUrlAuthorization('wy', 'profile-v1:user-id:7', 1)
  const accountB = musicUrlAuthorization('wy', 'profile-v1:user-id:8', 2)
  let currentAuthorization = accountA
  const session = createSessionHarness({
    sourceIds: ['builtin'],
    requestedQuality: '320k',
    cacheMode: 'bypass',
    authorizeMusicUrl: async({ musicInfo, quality }) => (
      musicUrlKey(musicInfo, quality, currentAuthorization)
    ),
    urls: { builtin: 'https://network' },
    matched: [matchedTx],
  })
  const rejected = await session.nextCandidate()
  assert.equal(rejected.origin, 'source')
  assert.deepEqual(rejected.cacheKey, musicUrlKey(onlineMusic, '320k', accountA))

  currentAuthorization = accountB
  assert.equal(session.rejectMedia(rejected.candidateId), 'resumed')
  await session.flush()
  assert.deepEqual(session.cacheRemoved, [musicUrlKey(onlineMusic, '320k', accountA)])

  const resumed = await session.nextCandidate()
  assert.equal(resumed.platform, 'tx')
  assert.deepEqual(resumed.cacheKey, musicUrlKey(matchedTx, '320k', accountB))
  assert.deepEqual(session.cacheRemoved, [musicUrlKey(onlineMusic, '320k', accountA)])
})

test('validated lower-quality memory is reused only for the current authorization', async() => {
  const authorization = musicUrlAuthorization('wy', 'profile-v1:user-id:7', 3)
  const cache = createCacheHarness({
    read: async() => null,
    save: async() => {},
  })
  await cache.commit(musicUrlKey(onlineMusic, '128k', authorization), 'https://validated/lower')
  assert.deepEqual(await cache.lookup(musicUrlKey(onlineMusic, 'flac', authorization)), {
    key: musicUrlKey(onlineMusic, '128k', authorization),
    quality: '128k',
    url: 'https://validated/lower',
    provisional: false,
  })
})

test('media rejection advances platform inside the source before fallback source', async () => {
  const harness = createIntegrationHarness({
    sourceIds: ['primary', 'fallback'],
    matchedCandidates: [matchedTx],
  })
  const playback = harness.play()
  const original = await harness.waitForRequest({ apiId: 'primary', platform: 'wy' })
  harness.succeed(original, 'https://bad')
  await harness.waitForBoundForeground('https://bad')
  harness.emitForegroundError(4)
  const matched = await harness.waitForRequest({ apiId: 'primary', platform: 'tx' })
  harness.succeed(matched, 'https://good')
  await harness.waitForBoundForeground('https://good')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.adapterRequestOrder, ['primary:wy', 'primary:tx'])
})

test('all sources fail without rerunning the chain', { timeout: 1000 }, async () => {
  for (const autoSkip of [true, false]) {
    const harness = createIntegrationHarness({
      sourceIds: ['primary', 'fallback'], autoSkip,
    })
    const playback = harness.play()
    for (const apiId of ['primary', 'fallback']) {
      const request = await harness.waitForRequest({ apiId, platform: 'wy' })
      harness.fail(request, new Error(`${apiId} failed`))
    }
    await playback
    assert.deepEqual(harness.sourceOrder, ['primary', 'fallback'])
    assert.deepEqual(harness.adapterRequestOrder, ['primary:wy', 'fallback:wy'])
    assert.equal(harness.sessionCreateCount, 1)
    assert.equal(harness.visibleErrorCount, 1)
    assert.equal(harness.autoSkipCalls, autoSkip ? 1 : 0)
  }
})

test('foreground promotes an in-flight validating preload without a second request', async () => {
  const harness = createIntegrationHarness()
  const preload = harness.preload(songA)
  const request = await harness.waitForRequest({
    apiId: 'primary', songIdentity: 'wy:song', platform: 'wy',
  })
  harness.succeed(request, 'https://preloaded')
  await harness.waitForBoundPreload('wy:song', 'https://preloaded')
  await preload

  const foreground = harness.play(songA)
  await harness.waitForBoundForeground('https://preloaded')
  harness.emitPreloadCanplay('wy:song')
  harness.emitForegroundCanplay()
  await foreground
  assert.deepEqual(harness.adapterRequestOrder, ['primary:wy'])
  assert.deepEqual(harness.foregroundBoundUrls, ['https://preloaded'])
})
