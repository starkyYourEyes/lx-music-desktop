const test = require('node:test')
const assert = require('node:assert/strict')
const {
  createCacheHarness,
  deferred,
  onlineMusic,
  toPlaybackCachePersistenceFailure,
  observePlaybackCachePersistence,
} = require('./test-utils/playback-fallback-harness')

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
