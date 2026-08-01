const assert = require('node:assert/strict')
const test = require('node:test')
const {
  createFakeClock,
  createPoolHarness,
  createRuntimeWindowHarness,
  deferred,
} = require('../test-utils/playback-fallback-harness')

test('different source IDs receive different in-memory partitions', async() => {
  const harness = createRuntimeWindowHarness()
  const first = await harness.create({ id: 'user_api/a' }, 1)
  const second = await harness.create({ id: 'user_api/b' }, 1)

  assert.notEqual(first.partition, second.partition)
  assert.match(first.partition, /^starky-lx-user-api-[0-9a-f]{32}$/)
  assert.equal(first.partition.startsWith('persist:'), false)
})

test('disposing one runtime clears only its own session', async() => {
  const harness = createRuntimeWindowHarness()
  const first = await harness.create({ id: 'user_api/a' }, 1)
  const second = await harness.create({ id: 'user_api/b' }, 1)

  await harness.dispose(first, { clearSession: true })

  assert.deepEqual(first.session.cleanupCalls, ['auth', 'storage', 'cache'])
  assert.deepEqual(second.session.cleanupCalls, [])
  assert.equal(second.window.destroyed, false)
})

test('creating a runtime never sends init before the owner explicitly starts it', async() => {
  const harness = createRuntimeWindowHarness()
  const apiInfo = { id: 'user_api/a', name: 'A', description: '', sources: {} }
  const runtime = await harness.create(apiInfo, 1)

  assert.deepEqual(harness.initEnvelopes, [])
  await harness.initialize(runtime, apiInfo)
  assert.equal(harness.initEnvelopes.length, 1)
  assert.deepEqual(harness.initEnvelopes[0].identity, { apiId: 'user_api/a', generation: 1 })
})

test('a destroy failure leaves the runtime owned and retryable', async() => {
  const harness = createRuntimeWindowHarness({ destroyFailures: 1 })
  const runtime = await harness.create({ id: 'user_api/a' }, 1)

  await assert.rejects(harness.dispose(runtime, { clearSession: true }), /simulated destroy failure/)
  assert.equal(runtime.window.destroyed, false)
  assert.equal(runtime.window.listenerCount('closed'), 1)
  assert.deepEqual(runtime.session.cleanupCalls, [])

  await harness.dispose(runtime, { clearSession: true })
  assert.equal(runtime.window.destroyed, true)
  assert.deepEqual(runtime.session.cleanupCalls, ['auth', 'storage', 'cache'])
})

test('a failed destroy is retried before a same-source runtime is replaced', async() => {
  const harness = createRuntimeWindowHarness({ destroyFailures: 1 })
  const original = await harness.create({ id: 'user_api/a' }, 1)

  await assert.rejects(harness.dispose(original, { clearSession: true }), /simulated destroy failure/)
  const replacement = await harness.create({ id: 'user_api/a' }, 2)

  assert.equal(original.window.destroyed, true)
  assert.equal(harness.windows.length, 2)
  assert.equal(replacement.window.destroyed, false)
})

test('an HTML read failure constructs no window and permits retry', async() => {
  const harness = createRuntimeWindowHarness({
    readFailures: 1,
    useDefaultReadRuntimeHtml: true,
  })

  await assert.rejects(harness.create({ id: 'user_api/a' }, 1), /simulated HTML read failure/)
  assert.equal(harness.windows.length, 0)

  const retry = await harness.create({ id: 'user_api/a' }, 2)
  assert.equal(retry.window.destroyed, false)
})

test('a page load failure tears down its partial window and permits retry', async() => {
  const harness = createRuntimeWindowHarness({ loadFailures: 1 })

  await assert.rejects(harness.create({ id: 'user_api/a' }, 1), /simulated load failure/)
  assert.equal(harness.windows[0].destroyed, true)
  assert.equal(harness.windows[0].listenerCount('closed'), 0)

  const retry = await harness.create({ id: 'user_api/a' }, 2)
  assert.equal(retry.window.destroyed, false)
})

test('a load teardown failure remains owned until a retry destroys it', async() => {
  const harness = createRuntimeWindowHarness({ loadFailures: 1, destroyFailures: 1 })

  await assert.rejects(harness.create({ id: 'user_api/a' }, 1), /simulated load failure/)
  const partialWindow = harness.windows[0]
  assert.equal(partialWindow.destroyed, false)
  assert.equal(partialWindow.listenerCount('closed'), 1)

  const retry = await harness.create({ id: 'user_api/a' }, 2)
  assert.equal(partialWindow.destroyed, true)
  assert.equal(harness.windows.length, 2)
  assert.equal(retry.window.destroyed, false)
})

test('ensure is lazy and deduplicates initialization per source', async() => {
  const harness = createPoolHarness({ autoInit: false })
  assert.equal(harness.created.length, 0)
  const first = harness.pool.ensure('a')
  const second = harness.pool.ensure('a')
  await harness.waitForRuntimeCreated('a')
  assert.equal(harness.created.length, 1)
  await harness.init('a', { sources: {} })
  assert.equal((await first).id, 'a')
  assert.equal((await second).id, 'a')
})

test('a failed initialization retires only that generation and a later ensure can recover', async() => {
  const harness = createPoolHarness({ autoInit: false, initialConfiguredIds: ['a'] })
  const first = harness.pool.ensure('a')
  await harness.waitForRuntimeCreated('a', 1)
  await harness.failInit('a', 'temporary initialization failure')
  await assert.rejects(first, error => error.scope == 'source' && error.kind == 'initialization')
  await harness.waitForDisposed('a', 1)
  const second = harness.pool.ensure('a')
  await harness.waitForRuntimeCreated('a', 2)
  await harness.init('a', { sources: {} })
  assert.equal((await second).id, 'a')
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
  assert.deepEqual(harness.clearedSessionIds, [])
})

test('invalidation after initialize starts cannot publish the old generation', async() => {
  const harness = createPoolHarness({ autoInit: false, initialConfiguredIds: ['a'] })
  const oldEnsure = harness.pool.ensure('a')
  await harness.waitForInitializeCall('a', 1)
  const old = harness.binding('a')
  const invalidating = harness.pool.invalidate('a', 'sourceChanged')
  const freshEnsure = harness.pool.ensure('a')
  await assert.rejects(oldEnsure, error => error.kind == 'sourceChanged')
  await invalidating
  await harness.waitForInitializeCall('a', 2)
  assert.equal(harness.pool.acceptInit(old.webContentsId, {
    identity: { apiId: old.apiId, generation: old.generation }, status: true, data: { sources: {} },
  }), false)
  await harness.init('a', { sources: {} })
  assert.equal((await freshEnsure).id, 'a')
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
})

test('importing the runtime-pool module before global setup has no side effects', () => {
  const harness = createPoolHarness({ loadOnly: true, globalLx: undefined })
  assert.equal(typeof harness.module.createUserApiRuntimePool, 'function')
  assert.equal(typeof harness.module.initializeUserApiRuntimePool, 'function')
  assert.equal(harness.created.length, 0)
})

test('user API entry modules do not access globals or the pool during evaluation', () => {
  const harness = createPoolHarness({ loadOnly: true, loadEntries: true, globalLx: undefined })
  assert.equal(harness.poolLookupCalls, 0)
  assert.equal(harness.created.length, 0)
})

test('the earliest synchronous init reply is accepted only after trusted binding', async() => {
  const harness = createPoolHarness({ autoInit: 'synchronous' })
  const info = await harness.pool.ensure('a')
  assert.equal(info.id, 'a')
  assert.deepEqual(harness.lifecycle.slice(0, 3), [
    'create:a:1', 'send-init:a:1', 'accept-init:a:1:true',
  ])
  assert.equal(harness.initAcceptCount, 1)
})

test('same request ID in different sources cannot cross-settle', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const a = harness.pool.request({ apiId: 'a', requestId: 'same', data: {} }, 11)
  const b = harness.pool.request({ apiId: 'b', requestId: 'same', data: {} }, 11)
  await Promise.all([harness.waitForPending('a', 'same'), harness.waitForPending('b', 'same')])
  harness.respond('a', 'same', { source: 'a' })
  assert.deepEqual(await a, { ok: true, value: { source: 'a' } })
  assert.equal(await Promise.race([b.then(() => 'settled'), Promise.resolve('pending')]), 'pending')
  harness.respond('b', 'same', { source: 'b' })
  assert.deepEqual(await b, { ok: true, value: { source: 'b' } })
})

test('duplicate request IDs reject the newcomer without replacing the original owner', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const original = harness.pool.request({ apiId: 'a', requestId: 'same', data: { owner: 'original' } }, 11)
  await harness.waitForPending('a', 'same')
  const duplicate = harness.pool.request({ apiId: 'a', requestId: 'same', data: { owner: 'duplicate' } }, 12)

  harness.respond('a', 'same', 'original-result')

  assert.deepEqual(await original, { ok: true, value: 'original-result' })
  const duplicateResult = await duplicate
  assert.equal(duplicateResult.ok, false)
  assert.equal(duplicateResult.error.kind, 'cancelled')
})

test('invalidating one source rejects only that source', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const a = harness.pool.request({ apiId: 'a', requestId: '1', data: {} }, 11)
  const b = harness.pool.request({ apiId: 'b', requestId: '1', data: {} }, 11)
  await Promise.all([harness.waitForPending('a', '1'), harness.waitForPending('b', '1')])
  await harness.pool.invalidate('a', 'sourceChanged')
  assert.equal((await a).ok, false)
  harness.respond('b', '1', 'ok')
  assert.deepEqual(await b, { ok: true, value: 'ok' })
})

test('deleting one source rejects only its pending request and clears only its partition', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const a = harness.pool.request({ apiId: 'a', requestId: '1', data: {} }, 11)
  const b = harness.pool.request({ apiId: 'b', requestId: '1', data: {} }, 11)
  await Promise.all([harness.waitForPending('a', '1'), harness.waitForPending('b', '1')])
  const deleting = harness.pool.dispose('a', { clearSession: true })
  const failed = await a
  assert.equal(failed.ok, false)
  assert.equal(failed.error.kind, 'sourceChanged')
  harness.respond('b', '1', 'ok')
  assert.deepEqual(await b, { ok: true, value: 'ok' })
  await deleting
  assert.deepEqual(harness.clearedSessionIds, ['a'])
  assert.equal(harness.disposedIds.includes('b'), false)
})

test('a runtime crash rejects only that source while another source continues', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const a = harness.pool.request({ apiId: 'a', requestId: '1', data: {} }, 11)
  const b = harness.pool.request({ apiId: 'b', requestId: '1', data: {} }, 11)
  await Promise.all([harness.waitForPending('a', '1'), harness.waitForPending('b', '1')])
  harness.crash('a')
  const failed = await a
  assert.equal(failed.ok, false)
  assert.equal(failed.error.kind, 'runtimeCrash')
  harness.respond('b', '1', 'ok')
  assert.deepEqual(await b, { ok: true, value: 'ok' })
})

test('a late response from an old generation is ignored', async() => {
  const harness = createPoolHarness({ autoInit: true })
  await harness.pool.ensure('a')
  const old = harness.binding('a')
  await harness.pool.invalidate('a', 'sourceChanged')
  const pending = harness.pool.request({ apiId: 'a', requestId: 'new', data: {} }, 11)
  await harness.waitForPending('a', 'new')
  const current = harness.binding('a')
  assert.notEqual(current.generation, old.generation)
  assert.equal(harness.pool.acceptResponse(old.webContentsId, {
    identity: old, status: true, data: { requestId: 'new', result: 'stale' },
  }), false)
  harness.respond('a', 'new', 'fresh')
  assert.deepEqual(await pending, { ok: true, value: 'fresh' })
})

test('a late crash callback from an old generation cannot retire its replacement', async() => {
  const harness = createPoolHarness({ autoInit: true })
  await harness.pool.ensure('a')
  const old = harness.binding('a')
  await harness.pool.invalidate('a', 'sourceChanged')
  await harness.pool.ensure('a')

  harness.crash('a', old.generation)
  await Promise.resolve()

  assert.equal(harness.pool.getStatus('a').status, true)
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
})

test('a late response for a timed-out request in the current generation is ignored', async() => {
  const clock = createFakeClock(0)
  const harness = createPoolHarness({ autoInit: true, clock })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'expired', data: {} }, 11)
  await harness.waitForPending('a', 'expired')
  const binding = harness.binding('a')
  clock.advance(20_000)
  await clock.flush()
  const result = await pending
  assert.equal(result.ok, false)
  assert.equal(result.error.kind, 'timeout')
  assert.equal(harness.pool.acceptResponse(binding.webContentsId, {
    identity: binding, status: true, data: { requestId: 'expired', result: 'late' },
  }), false)
})

test('invalidation during async window creation cannot install a stale record', async() => {
  const gate = deferred()
  const harness = createPoolHarness({ autoInit: false, createGate: gate.promise })
  const oldEnsure = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')
  const invalidating = harness.pool.invalidate('a', 'sourceChanged')
  gate.resolve()
  await assert.rejects(oldEnsure, error => error.kind == 'sourceChanged')
  await assert.doesNotReject(invalidating)
  assert.deepEqual(harness.statusEvents, [])
  const currentEnsure = harness.pool.ensure('a')
  await harness.waitForRuntimeCreated('a', 2)
  await harness.init('a', { sources: {} })
  await currentEnsure
  assert.equal(harness.binding('a').generation, 2)
  assert.equal(harness.disposedGenerations.includes(1), true)
})

test('releasing the last owner during creation disposes the unconfigured runtime on arrival', async() => {
  const gate = deferred()
  const harness = createPoolHarness({ autoInit: false, createGate: gate.promise })
  harness.pool.acquireLease({ apiIds: ['a'], leaseId: 'session-1' }, 11)
  const ensuring = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')
  await harness.pool.markConfigured(new Set())
  await harness.pool.releaseOwner(11)
  gate.resolve()
  await assert.rejects(ensuring)
  await harness.waitForDisposed('a')
})

test('idle disposal after record installation cannot await its own creation promise', { timeout: 1000 }, async() => {
  const gate = deferred()
  const harness = createPoolHarness({ autoInit: false, createGate: gate.promise, initialConfiguredIds: [] })
  const ensuring = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')
  gate.resolve()
  await harness.waitForRuntimeCreated('a', 1)
  await harness.waitForDisposed('a', 1)
  await assert.rejects(ensuring, error => error.kind == 'sourceChanged')
})

test('deletion during creation destroys the late window before clearing its partition', async() => {
  const gate = deferred()
  const harness = createPoolHarness({ autoInit: false, createGate: gate.promise })
  const ensuring = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')
  const deleting = harness.pool.dispose('a', { clearSession: true })
  gate.resolve()
  await assert.rejects(ensuring)
  await deleting
  assert.deepEqual(harness.lifecycle, ['create:a:1', 'dispose:a:1', 'clearSession:a'])
})

test('configuration removal waits for snapshotted session leases', async() => {
  const harness = createPoolHarness({ autoInit: true })
  harness.pool.acquireLease({ apiIds: ['a'], leaseId: 'session-1' }, 11)
  await harness.pool.markConfigured(new Set())
  assert.equal(harness.created.length, 0)
  await harness.pool.ensure('a')
  assert.equal(harness.created.length, 1)
  await harness.pool.releaseLease({ apiIds: ['a'], leaseId: 'session-1' }, 11)
  await harness.waitForDisposed('a')
  assert.equal(harness.disposedIds.includes('a'), true)
})

test('re-adding a configured source clears deferred idle disposal', async() => {
  const harness = createPoolHarness({ autoInit: true })
  await harness.pool.ensure('a')
  harness.pool.acquireLease({ apiIds: ['a'], leaseId: 'session-1' }, 11)
  await harness.pool.markConfigured(new Set())
  await harness.pool.markConfigured(new Set(['a']))
  await harness.pool.releaseLease({ apiIds: ['a'], leaseId: 'session-1' }, 11)
  assert.equal(harness.disposedIds.includes('a'), false)
})

test('re-adding a source during window creation cancels only idle disposal', async() => {
  const gate = deferred()
  const harness = createPoolHarness({ autoInit: false, createGate: gate.promise })
  const ensuring = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')
  await harness.pool.markConfigured(new Set())
  await harness.pool.markConfigured(new Set(['a']))
  gate.resolve()
  await harness.waitForRuntimeCreated('a')
  await harness.init('a', { sources: {} })
  await ensuring
  assert.equal(harness.createdGenerations('a').length, 1)
  assert.equal(harness.disposedIds.includes('a'), false)
})

test('source invalidation during idle creation cannot be cancelled by reconfiguration', async() => {
  const gate = deferred()
  const harness = createPoolHarness({ autoInit: true, createGate: gate.promise })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')
  await harness.pool.markConfigured(new Set())
  const invalidating = harness.pool.invalidate('a', 'sourceChanged')
  await harness.pool.markConfigured(new Set(['a']))
  gate.resolve()

  await assert.rejects(first, error => error.kind == 'sourceChanged')
  await invalidating
  await harness.waitForDisposed('a', 1)
  assert.deepEqual(harness.statusEvents, [])

  const second = harness.pool.ensure('a')
  await harness.waitForRuntimeCreated('a', 2)
  assert.equal((await second).id, 'a')
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
})

test('script update releases only the invalidated source lease ownership', async() => {
  const harness = createPoolHarness({ autoInit: true })
  await Promise.all([harness.pool.ensure('a'), harness.pool.ensure('b')])
  harness.pool.acquireLease({ apiIds: ['a', 'b'], leaseId: 'session-1' }, 11)
  await harness.pool.markConfigured(new Set())
  await harness.pool.invalidate('a', 'sourceChanged')
  await harness.waitForDisposed('a')
  assert.equal(harness.disposedIds.includes('a'), true)
  assert.equal(harness.disposedIds.includes('b'), false)
  await harness.pool.releaseLease({ apiIds: ['a', 'b'], leaseId: 'session-1' }, 11)
  await harness.waitForDisposed('b')
})

test('destroying an owner releases all of its runtime leases', async() => {
  const harness = createPoolHarness({ autoInit: true })
  harness.pool.acquireLease({ apiIds: ['a'], leaseId: 'session-1' }, 11)
  await harness.pool.markConfigured(new Set())
  await harness.pool.ensure('a')
  await harness.pool.releaseOwner(11)
  await harness.waitForDisposed('a')
  assert.equal(harness.disposedIds.includes('a'), true)
})

test('settling the last non-playback request triggers deferred idle disposal', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'metadata', data: {} }, 11)
  await harness.waitForPending('a', 'metadata')
  await harness.pool.markConfigured(new Set())
  assert.equal(harness.disposedIds.includes('a'), false)
  harness.respond('a', 'metadata', { url: 'https://cover' })
  assert.deepEqual(await pending, { ok: true, value: { url: 'https://cover' } })
  await harness.waitForDisposed('a')
  assert.equal(harness.disposedIds.includes('a'), true)
})

test('fire-and-observe idle disposal logs a rejection without unhandled lifecycle work', async() => {
  const harness = createPoolHarness({ autoInit: true, disposeRejectIds: ['a'] })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'metadata', data: {} }, 11)
  await harness.waitForPending('a', 'metadata')
  await harness.pool.markConfigured(new Set())
  harness.respond('a', 'metadata', 'ok')
  assert.deepEqual(await pending, { ok: true, value: 'ok' })
  await harness.waitForLog('dispose idle user API runtime a failed')
  assert.equal(harness.loggedErrors.length, 1)
})

test('a source configured at cold start survives settlement and reuses its runtime', async() => {
  const harness = createPoolHarness({ autoInit: true, initialConfiguredIds: ['a'] })
  const first = harness.pool.request({ apiId: 'a', requestId: 'first', data: {} }, 11)
  await harness.waitForPending('a', 'first')
  harness.respond('a', 'first', 'one')
  assert.deepEqual(await first, { ok: true, value: 'one' })
  assert.equal(harness.disposedIds.includes('a'), false)
  const createdCount = harness.created.length
  const second = harness.pool.request({ apiId: 'a', requestId: 'second', data: {} }, 11)
  await harness.waitForPending('a', 'second')
  harness.respond('a', 'second', 'two')
  assert.deepEqual(await second, { ok: true, value: 'two' })
  assert.equal(harness.created.length, createdCount)
})

test('deleting a never-opened source clears its isolated partition', async() => {
  const harness = createPoolHarness({ autoInit: true })
  await harness.pool.dispose('a', { clearSession: true })
  assert.deepEqual(harness.clearedSessionIds, ['a'])
  assert.equal(harness.created.length, 0)
})

test('cancellation during lazy initialization prevents the script request', async() => {
  const harness = createPoolHarness({ autoInit: false })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'r', data: {} }, 11)
  await harness.waitForRuntimeCreated('a')
  harness.pool.cancel({ apiId: 'a', requestId: 'r', reason: 'cancelled' }, 11)
  await harness.init('a', { sources: {} })
  assert.equal((await pending).ok, false)
  assert.deepEqual(harness.sentRequests, [])
})

test('different sources initialize independently and proxy updates broadcast once', async() => {
  const harness = createPoolHarness({ autoInit: false })
  const a = harness.pool.ensure('a')
  const b = harness.pool.ensure('b')
  await Promise.all([harness.waitForRuntimeCreated('a'), harness.waitForRuntimeCreated('b')])
  await harness.init('b', { sources: {} })
  assert.equal((await b).id, 'b')
  assert.equal(await Promise.race([a.then(() => 'settled'), Promise.resolve('pending')]), 'pending')
  await harness.init('a', { sources: {} })
  await a
  harness.emitProxyUpdate({ host: '127.0.0.1', port: '1080' })
  assert.deepEqual(harness.proxyRecipients, ['a', 'b'])
  assert.equal(harness.proxyListenerCount, 1)
})

test('disposeAll destroys every live runtime', async() => {
  const harness = createPoolHarness()
  await Promise.all([harness.ensureAndInit('a'), harness.ensureAndInit('b')])
  await harness.pool.disposeAll()
  assert.deepEqual(harness.disposedIds.sort(), ['a', 'b'])
  assert.equal(harness.proxyUnsubscribeCount, 1)
})
