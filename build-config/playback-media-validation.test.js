const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createCacheHarness,
  createCoordinatorHarness,
  createPlayerHarness,
  createPreloadSchedulingHarness,
  createFakeClock,
  cancelReasonForResolveReason,
  deferred,
  playbackError,
  onlineMusic,
  localMusic,
  song,
  songA,
  songB,
  toPlaybackCachePersistenceFailure,
  observePlaybackCachePersistence,
} = require('./test-utils/playback-fallback-harness')

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

test('matched fallback commit and post-commit error use the literal original-song actual-quality key', async() => {
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
  assert.equal(bound.cacheKey, 'song_128k')
  harness.emitCanplay(bound)
  assert.equal(harness.cacheCommitCount, 1)
  assert.deepEqual(harness.committedCacheKeys, ['song_128k'])
  assert.equal(harness.isValidating(), false)
  await harness.emitError(bound, 3)
  assert.deepEqual(harness.dispatchedResourceKinds, ['candidate', 'validated'])
  assert.deepEqual(harness.tombstonedKeys, ['song_128k'])
  assert.deepEqual(harness.refreshRequests, [{ reason: 'postCommitError' }])
  assert.deepEqual(harness.refreshedApiIds, ['primary'])
  assert.deepEqual(harness.postCommitCacheHits, [])
})

test('explicit force refresh clears lower cache and starts full fallback from primary', async() => {
  const harness = createPlayerHarness()
  await harness.forceRefresh()
  assert.deepEqual(harness.invalidatedQualities, ['flac', '320k', '128k'])
  assert.deepEqual(harness.invalidatedCacheKeys, [
    'song_flac', 'song_320k', 'song_128k',
  ])
  assert.deepEqual(harness.refreshRequests[0], { reason: 'forceRefresh' })
  assert.equal(harness.refreshedApiIds[0], 'primary')
})

test('direct local WebDAV and downloaded resources commit identity on canplay', async() => {
  const harness = createPlayerHarness()
  const resources = [
    { kind: 'direct', songIdentity: 'local:local-song', url: 'file:///local.mp3' },
    { kind: 'direct', songIdentity: 'webdav:webdav-song', url: 'https://webdav/song.mp3' },
    { kind: 'direct', songIdentity: 'wy:song', url: 'file:///downloaded.mp3' },
  ]
  for (const resource of resources) {
    const event = harness.bindResource(resource)
    assert.notEqual(harness.loadedMusicIdentity, resource.songIdentity)
    harness.emitCanplay(event)
    assert.equal(harness.loadedMusicIdentity, resource.songIdentity)
  }
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
  const oldEvent = await harness.bindCandidate('https://old')
  harness.cancelPlayback('stop')
  assert.equal(harness.currentResource(), null)
  harness.emitCanplay(oldEvent)
  await harness.emitError(oldEvent, 4)
  assert.equal(harness.playerCanplayEvents, 0)
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
    kind: 'direct', songIdentity: 'local:old', url: 'file:///old',
  })
  harness.disposePlayback()
  assert.equal(harness.currentResource(), null)
  harness.emitCanplay(oldEvent)
  assert.equal(harness.playerCanplayEvents, 0)
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
  const harness = createPlayerHarness({ sourceUrls: ['https://bad'], exhaustAfterMediaError: true, autoSkip: true })
  const bound = await harness.bindCandidate('https://bad')
  harness.emitError(bound, 4)
  await harness.flush()
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
    rows: new Map([['song_flac', 'https://cached/flac']]),
  })
  assert.deepEqual(cache.getPlaybackQualityOrder('flac24bit'), ['flac24bit', 'flac', '320k', '128k'])
  assert.deepEqual(await cache.lookup(onlineMusic, 'flac24bit'), {
    key: 'song_flac', quality: 'flac', url: 'https://cached/flac', provisional: true,
  })
})

test('bad provisional cache is tombstoned before asynchronous deletion', async () => {
  const gate = deferred()
  const cache = createCacheHarness({ rows: new Map([['song_320k', 'https://bad']]), remove: () => gate.promise })
  const hit = await cache.lookup(onlineMusic, '320k')
  const deleting = cache.tombstone(onlineMusic, hit.quality)
  assert.equal(await cache.lookup(onlineMusic, '320k'), null)
  gate.resolve()
  await deleting
})

test('an exact committed key can be tombstoned before post-commit recovery', async () => {
  const gate = deferred()
  const cache = createCacheHarness({ rows: new Map([['song_320k', 'https://fallback']]), remove: () => gate.promise })
  const deleting = cache.tombstoneKey('song_320k')
  assert.equal(await cache.lookup(onlineMusic, '320k'), null)
  gate.resolve()
  await deleting
})

test('a tombstone created while an exact database read is pending suppresses the stale row', async () => {
  const readStarted = deferred()
  const readGate = deferred()
  const cache = createCacheHarness({
    read: async key => {
      readStarted.resolve(key)
      await readGate.promise
      return key == 'song_320k' ? 'https://stale' : null
    },
  })
  const lookup = cache.lookup(onlineMusic, '320k')
  assert.equal(await readStarted.promise, 'song_320k')
  const deleting = cache.tombstoneKey('song_320k')
  readGate.resolve()
  assert.equal(await lookup, null)
  await deleting
})

test('commit publishes memory before database persistence settles', async () => {
  const gate = deferred()
  const cache = createCacheHarness({ save: () => gate.promise })
  const writing = cache.commit(onlineMusic, '320k', 'https://valid')
  assert.deepEqual(await cache.lookup(onlineMusic, '320k'), {
    key: 'song_320k', quality: '320k', url: 'https://valid', provisional: false,
  })
  gate.resolve()
  await writing
})

test('persistence failure does not revoke an already published commit', async () => {
  const cache = createCacheHarness({ save: async() => { throw new Error('db down') } })
  await assert.rejects(cache.commit(onlineMusic, '320k', 'https://valid'), /db down/)
  assert.equal((await cache.lookup(onlineMusic, '320k')).url, 'https://valid')
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
    save: async(musicInfo, quality, url) => {
      saveCount++
      if (saveCount == 1) await firstSave.promise
      durableRows.set(`${musicInfo.id}_${quality}`, url)
    },
    remove: async key => { durableRows.delete(key) },
  })
  const oldWrite = cache.commit(onlineMusic, '320k', 'https://fallback')
  await Promise.resolve()
  const deleting = cache.tombstoneKey('song_320k')
  const newWrite = cache.commit(onlineMusic, '320k', 'https://primary')
  assert.equal((await cache.lookup(onlineMusic, '320k')).url, 'https://primary')
  assert.equal(saveCount, 1)
  firstSave.resolve()
  await Promise.all([oldWrite, deleting, newWrite])
  assert.equal(durableRows.get('song_320k'), 'https://primary')
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
  await cache.invalidateQualityRange(onlineMusic, 'flac')
  assert.deepEqual(cache.removed, ['song_flac', 'song_320k', 'song_128k'])
})
