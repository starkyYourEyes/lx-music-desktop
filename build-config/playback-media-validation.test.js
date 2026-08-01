const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createCacheHarness,
  createCoordinatorHarness,
  createFakeClock,
  cancelReasonForResolveReason,
  deferred,
  onlineMusic,
  localMusic,
  song,
  songA,
  songB,
  toPlaybackCachePersistenceFailure,
  observePlaybackCachePersistence,
} = require('./test-utils/playback-fallback-harness')

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
