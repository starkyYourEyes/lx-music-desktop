const assert = require('node:assert/strict')
const test = require('node:test')
const {
  createFakeClock,
  createIntegrationHarness,
  createPoolHarness,
  createRuntimePreloadFailureHarness,
  createRuntimeWindowHarness,
  deferred,
  songA,
  songB,
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

  assert.deepEqual(first.session.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
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
  assert.deepEqual(runtime.session.cleanupCalls, ['cache', 'storage:cachestorage', 'code'])
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

test('initialization times out after ten seconds, retires the generation, and permits retry', async() => {
  const clock = createFakeClock(0)
  const harness = createPoolHarness({ autoInit: false, initialConfiguredIds: ['a'], clock })
  const first = harness.pool.ensure('a')
  const requesting = harness.pool.request({ apiId: 'a', requestId: 'waiting', data: {} }, 11)
  const firstOutcome = first.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForInitializeCall('a', 1)

  clock.advance(9_999)
  await clock.flush()
  assert.equal(await Promise.race([firstOutcome, Promise.resolve('pending')]), 'pending')

  clock.advance(1)
  await clock.flush()
  const timedOut = await firstOutcome
  assert.equal(timedOut.status, 'rejected')
  assert.equal(timedOut.error.kind, 'timeout')
  assert.equal(timedOut.error.scope, 'source')
  assert.match(timedOut.error.message, /initialization timed out/i)
  await harness.waitForDisposed('a', 1)
  assert.deepEqual(harness.statusEvents.at(-1), {
    apiId: 'a',
    status: false,
    message: 'User API initialization timed out',
    apiInfo: { id: 'a', name: 'A', description: '', allowShowUpdateAlert: false, sources: {} },
  })
  const requestResult = await requesting
  assert.equal(requestResult.ok, false)
  assert.equal(requestResult.error.kind, 'timeout')
  assert.equal(requestResult.error.message, 'User API initialization timed out')
  assert.equal(clock.pendingTimerCount, 0)

  const second = harness.pool.ensure('a')
  await harness.waitForInitializeCall('a', 2)
  await harness.init('a', { sources: {} })
  assert.equal((await second).id, 'a')
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
})

test('the ten-second initialization deadline includes runtime window creation', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  const firstOutcome = first.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a', 1)

  clock.advance(10_000)
  await clock.flush()
  const atDeadline = await Promise.race([firstOutcome, Promise.resolve('pending')])
  if (atDeadline == 'pending') firstCreate.resolve()
  assert.notEqual(atDeadline, 'pending')
  assert.equal(atDeadline.status, 'rejected')
  assert.equal(atDeadline.error.kind, 'timeout')

  const second = harness.pool.ensure('a')
  await harness.waitForInitializeCall('a', 2)
  await harness.init('a', { sources: {} })
  assert.equal((await second).id, 'a')

  firstCreate.resolve()
  await harness.waitForDisposed('a', 1)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.createdGenerations('a'), [2, 1])
  assert.equal(harness.disposedGenerations.filter(generation => generation == 1).length, 1)
  assert.equal(harness.lifecycle.includes('send-init:a:1'), false)
  assert.equal(harness.pool.getStatus('a').status, true)
  assert.equal(harness.statusEvents.at(-1).status, true)
})

test('the ten-second initialization deadline includes initialization dispatch', async() => {
  const clock = createFakeClock(0)
  const firstDispatch = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    initializeGate: (_apiId, generation) => generation == 1 ? firstDispatch.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  const firstOutcome = first.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForInitializeCall('a', 1)

  clock.advance(10_000)
  await clock.flush()
  const atDeadline = await Promise.race([firstOutcome, Promise.resolve('pending')])
  if (atDeadline == 'pending') firstDispatch.resolve()
  assert.notEqual(atDeadline, 'pending')
  assert.equal(atDeadline.status, 'rejected')
  assert.equal(atDeadline.error.kind, 'timeout')
  await harness.waitForDisposed('a', 1)
  await new Promise(resolve => setImmediate(resolve))

  const second = harness.pool.ensure('a')
  await harness.waitForInitializeCall('a', 2)
  await harness.init('a', { sources: {} })
  assert.equal((await second).id, 'a')

  firstDispatch.reject(new Error('late initialization dispatch failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
  assert.equal(harness.disposedGenerations.filter(generation => generation == 1).length, 1)
  assert.equal(harness.pool.getStatus('a').status, true)
  assert.equal(harness.statusEvents.at(-1).status, true)
})

test('dispose during blocked creation settles at the original deadline and owns the late window', async() => {
  const clock = createFakeClock(0)
  const createGate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: createGate.promise,
  })
  const ensuring = harness.pool.ensure('a')
  const ensureOutcome = ensuring.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a')
  const deleting = harness.pool.dispose('a', { clearSession: false })
  const deleteOutcome = deleting.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )

  clock.advance(9_999)
  await clock.flush()
  assert.equal(await Promise.race([deleteOutcome, Promise.resolve('pending')]), 'pending')

  clock.advance(1)
  await clock.flush()
  const atDeadline = await Promise.race([deleteOutcome, Promise.resolve('pending')])
  if (atDeadline == 'pending') createGate.resolve()
  assert.deepEqual(atDeadline, { status: 'resolved' })
  const rejectedEnsure = await ensureOutcome
  assert.equal(rejectedEnsure.status, 'rejected')
  assert.equal(rejectedEnsure.error.kind, 'sourceChanged')

  createGate.resolve()
  await harness.waitForDisposed('a', 1)
  await clock.flush()
  assert.equal(harness.disposedGenerations.filter(generation => generation == 1).length, 1)
  assert.equal(harness.lifecycle.includes('send-init:a:1'), false)
})

test('disposeAll during blocked creation settles at the deadline and unsubscribes once', async() => {
  const clock = createFakeClock(0)
  const createGate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: createGate.promise,
  })
  const ensuring = harness.pool.ensure('a')
  const ensureOutcome = ensuring.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a')
  const disposing = harness.pool.disposeAll()
  const disposeOutcome = disposing.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )

  clock.advance(10_000)
  await clock.flush()
  const atDeadline = await Promise.race([disposeOutcome, Promise.resolve('pending')])
  if (atDeadline == 'pending') createGate.resolve()
  assert.deepEqual(atDeadline, { status: 'resolved' })
  assert.equal(harness.proxyUnsubscribeCount, 1)
  assert.equal((await ensureOutcome).status, 'rejected')

  createGate.resolve()
  await harness.waitForDisposed('a', 1)
  await clock.flush()
  assert.equal(harness.disposedGenerations.filter(generation => generation == 1).length, 1)
  assert.equal(harness.lifecycle.includes('send-init:a:1'), false)
  assert.equal(harness.proxyUnsubscribeCount, 1)
})

test('clearSession disposal during blocked creation clears after late destruction', async() => {
  const clock = createFakeClock(0)
  const createGate = deferred()
  const clearSessionGate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: createGate.promise,
    clearSessionGate: clearSessionGate.promise,
  })
  const ensuring = harness.pool.ensure('a')
  const ensureOutcome = ensuring.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a')
  const deleting = harness.pool.dispose('a', { clearSession: true })
  const deleteOutcome = deleting.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )

  clock.advance(10_000)
  await clock.flush()
  const atDeadline = await Promise.race([deleteOutcome, Promise.resolve('pending')])
  if (atDeadline == 'pending') createGate.resolve()
  assert.deepEqual(atDeadline, { status: 'resolved' })
  assert.equal((await ensureOutcome).status, 'rejected')
  assert.deepEqual(harness.lifecycle, ['create:a:1'])

  createGate.resolve()
  await harness.waitForSessionClearCall('a')
  assert.deepEqual(harness.lifecycle, ['create:a:1', 'dispose:a:1', 'clearSession:a'])
  assert.deepEqual(harness.clearedSessionIds, [])
  clearSessionGate.resolve()
  await harness.waitForSessionCleared('a')
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('deletion after the creation deadline still waits to clear until the late window is destroyed', async() => {
  const clock = createFakeClock(0)
  const createGate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: createGate.promise,
  })
  const ensuring = harness.pool.ensure('a')
  await harness.waitForCreateCall('a')

  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(ensuring, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })
  const beforeLateCreation = [...harness.lifecycle]

  createGate.resolve()
  await harness.waitForSessionClearCall('a')
  assert.deepEqual(beforeLateCreation, ['create:a:1'])
  assert.deepEqual(harness.lifecycle, ['create:a:1', 'dispose:a:1', 'clearSession:a'])
  assert.deepEqual(harness.disposedGenerations, [1])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('failed late-window destruction remains owned for a later destroy-and-clear retry', async() => {
  const clock = createFakeClock(0)
  const createGate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: createGate.promise,
    disposeFailures: new Map([['a', 1]]),
  })
  const ensuring = harness.pool.ensure('a')
  const ensureOutcome = ensuring.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a')
  const deleting = harness.pool.dispose('a', { clearSession: true })

  clock.advance(10_000)
  await clock.flush()
  await deleting
  assert.equal((await ensureOutcome).status, 'rejected')

  createGate.resolve()
  await harness.waitForDisposePromiseSettled('a', 1)
  await clock.flush()
  const beforeRetry = [...harness.lifecycle]

  await harness.pool.dispose('a', { clearSession: true })
  assert.deepEqual(beforeRetry, ['create:a:1', 'dispose:a:1'])
  assert.deepEqual(harness.lifecycle, ['create:a:1', 'dispose:a:1', 'dispose:a:1', 'clearSession:a'])
  assert.deepEqual(harness.disposedGenerations, [1, 1])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('deletion retires a replacement record before clearing behind an older late creation', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')

  const second = harness.pool.ensure('a')
  await harness.waitForInitializeCall('a', 2)
  await harness.init('a', { sources: {} })
  await second

  await harness.pool.dispose('a', { clearSession: true })
  const beforeLateCreation = [...harness.lifecycle]
  firstCreate.resolve()
  await harness.waitForSessionClearCall('a')

  assert.equal(beforeLateCreation.includes('dispose:a:2'), true)
  assert.equal(beforeLateCreation.includes('clearSession:a'), false)
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:2', 'dispose:a:1', 'clearSession:a'],
  )
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('late cleanup joins a blocked replacement creation before clearing the partition', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const secondCreate = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : secondCreate.promise,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  const second = harness.pool.ensure('a')
  const secondOutcome = second.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a', 2)
  firstCreate.resolve()
  await harness.waitForDisposePromiseSettled('a', 1)
  await clock.flush()
  const beforeSecondSettles = [...harness.lifecycle]

  secondCreate.resolve()
  await clock.flush()
  const finalSecondOutcome = await Promise.race([secondOutcome, Promise.resolve('pending')])
  assert.equal(beforeSecondSettles.includes('clearSession:a'), false)
  assert.equal(finalSecondOutcome.status, 'rejected')
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:1', 'dispose:a:2', 'clearSession:a'],
  )
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('normal replacement retirement resumes a retained late-creation clear', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  await harness.pool.ensure('a')
  firstCreate.resolve()
  await harness.waitForDisposePromiseSettled('a', 1)
  await clock.flush()
  assert.equal(harness.lifecycle.includes('clearSession:a'), false)

  harness.crash('a', 2)
  await harness.waitForDisposePromiseSettled('a', 2)
  await clock.flush()
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:1', 'dispose:a:2', 'clearSession:a'],
  )
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('replacement creation starting during late destruction joins the closing aggregate', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const secondCreate = deferred()
  const firstDispose = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : secondCreate.promise,
    disposeGate: (_apiId, generation) => generation == 1 ? firstDispose.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  firstCreate.resolve()
  await harness.waitForDisposed('a', 1)
  const second = harness.pool.ensure('a')
  const secondOutcome = second.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a', 2)

  firstDispose.resolve()
  await harness.waitForDisposePromiseSettled('a', 1)
  await clock.flush()
  const beforeSecondSettles = [...harness.lifecycle]
  secondCreate.resolve()
  await clock.flush()
  const finalSecondOutcome = await Promise.race([secondOutcome, Promise.resolve('pending')])

  assert.equal(beforeSecondSettles.includes('clearSession:a'), false)
  assert.equal(finalSecondOutcome.status, 'rejected')
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:1', 'dispose:a:2', 'clearSession:a'],
  )
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('same-turn replacement admission is published before late cleanup closes the barrier', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const secondCreate = deferred()
  const firstDispose = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : secondCreate.promise,
    disposeGate: (_apiId, generation) => generation == 1 ? firstDispose.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  firstCreate.resolve()
  await harness.waitForDisposed('a', 1)
  const firstBoundaryEvent = Promise.race([
    harness.waitForCreateCall('a', 2).then(() => 'create'),
    harness.waitForSessionClearCall('a').then(() => 'clear'),
  ])
  let second
  const startSecond = firstDispose.promise.then(() => {
    second = harness.pool.ensure('a')
  })

  firstDispose.resolve()
  await startSecond
  const boundaryEvent = await firstBoundaryEvent
  secondCreate.resolve()
  const secondOutcome = await second.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await clock.flush()

  assert.equal(boundaryEvent, 'create')
  assert.equal(secondOutcome.status, 'rejected')
  assert.equal(secondOutcome.error.kind, 'sourceChanged')
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('create:') ||
      event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['create:a:1', 'dispose:a:1', 'create:a:2', 'dispose:a:2', 'clearSession:a'],
  )
  assert.deepEqual(harness.disposedGenerations, [1, 2])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('replacement record installed during older destruction is retired before session clear', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const firstDispose = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
    disposeGate: (_apiId, generation) => generation == 1 ? firstDispose.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  firstCreate.resolve()
  await harness.waitForDisposed('a', 1)
  await harness.pool.ensure('a')
  const beforeOlderDestroyCompletes = [...harness.lifecycle]

  firstDispose.resolve()
  await harness.waitForDisposePromiseSettled('a', 1)
  await clock.flush()

  assert.equal(beforeOlderDestroyCompletes.includes('send-init:a:2'), true)
  assert.equal(beforeOlderDestroyCompletes.includes('dispose:a:2'), false)
  assert.equal(beforeOlderDestroyCompletes.includes('clearSession:a'), false)
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:1', 'dispose:a:2', 'clearSession:a'],
  )
  assert.deepEqual(harness.disposedGenerations, [1, 2])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('replacement creation waits behind an in-flight session clear and retries once after success', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const clearSessionGate = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a', 'b'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
    clearSessionGate: clearSessionGate.promise,
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  firstCreate.resolve()
  await harness.waitForSessionClearCall('a')
  const replacements = [harness.pool.ensure('a'), harness.pool.ensure('a')]
  await harness.pool.ensure('b')
  await clock.flush()
  const beforeClearCompletes = [...harness.lifecycle]

  clearSessionGate.resolve()
  const outcomes = await Promise.allSettled(replacements)

  assert.equal(beforeClearCompletes.includes('create:a:2'), false)
  assert.equal(beforeClearCompletes.includes('create:b:1'), true)
  assert.deepEqual(outcomes.map(result => result.status), ['fulfilled', 'fulfilled'])
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') ||
      event.startsWith('clearSession:') || event.startsWith('create:')),
    ['create:a:1', 'dispose:a:1', 'clearSession:a', 'create:b:1', 'create:a:2'],
  )
})

test('failed session clear retains the barrier until explicit cleanup retry succeeds', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const firstClear = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
    clearSessionGate: firstClear.promise,
    clearSessionFailures: new Map([['a', 1]]),
  })
  const first = harness.pool.ensure('a')
  await harness.waitForCreateCall('a', 1)
  clock.advance(10_000)
  await clock.flush()
  await assert.rejects(first, error => error.kind == 'timeout')
  await harness.pool.dispose('a', { clearSession: true })

  firstCreate.resolve()
  await harness.waitForSessionClearCall('a')
  const waitingEnsure = harness.pool.ensure('a')
  await clock.flush()
  const beforeFailure = [...harness.lifecycle]

  firstClear.resolve()
  await assert.rejects(waitingEnsure, /clear session a failed/)
  await clock.flush()
  await assert.rejects(harness.pool.ensure('a'), /clear session a failed/)
  assert.equal(beforeFailure.includes('create:a:2'), false)
  assert.deepEqual(
    harness.lifecycle.filter(event => event == 'clearSession:a'),
    ['clearSession:a'],
  )
  assert.deepEqual(harness.createdGenerations('a'), [1])
  assert.equal(
    harness.loggedErrors.filter(entry =>
      entry.message.includes('retire User API runtime creation a failed')).length,
    1,
  )

  await harness.pool.dispose('a', { clearSession: true })
  await harness.pool.ensure('a')

  assert.deepEqual(
    harness.lifecycle.filter(event => event == 'clearSession:a'),
    ['clearSession:a', 'clearSession:a'],
  )
  assert.deepEqual(harness.clearedSessionIds, ['a'])
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
})

test('successful init and explicit lifecycle exits clear the initialization deadline', async() => {
  let clock = createFakeClock()
  let harness = createPoolHarness({ autoInit: false, clock, initialConfiguredIds: ['a'] })
  let ensuring = harness.pool.ensure('a')
  await harness.waitForInitializeCall('a', 1)
  await harness.init('a', { sources: {} })
  await ensuring
  assert.equal(clock.pendingTimerCount, 0)

  for (const exit of ['invalidate', 'crash', 'dispose']) {
    clock = createFakeClock()
    harness = createPoolHarness({ autoInit: false, clock, initialConfiguredIds: ['a'] })
    ensuring = harness.pool.ensure('a')
    await harness.waitForInitializeCall('a', 1)
    if (exit == 'invalidate') await harness.pool.invalidate('a', 'sourceChanged')
    if (exit == 'crash') harness.crash('a')
    if (exit == 'dispose') await harness.pool.dispose('a', { clearSession: false })
    await assert.rejects(ensuring)
    await clock.flush()
    assert.equal(clock.pendingTimerCount, 0, exit)
  }
})

test('failed retirement blocks recreation until explicit disposal retries cleanup', async() => {
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    disposeFailures: new Map([['a', 1]]),
  })
  await harness.pool.ensure('a')

  await assert.rejects(harness.pool.dispose('a', { clearSession: false }), /dispose a failed/)
  await assert.rejects(harness.pool.ensure('a'), /dispose a failed/)
  assert.deepEqual(harness.createdGenerations('a'), [1])

  await harness.pool.dispose('a', { clearSession: false })
  await harness.pool.ensure('a')
  assert.deepEqual(harness.disposedGenerations, [1, 1])
  assert.deepEqual(harness.createdGenerations('a'), [1, 2])
})

test('disposeAll retries every retained retirement and propagates repeated cleanup failure', async() => {
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    disposeRejectIds: ['a'],
  })
  await harness.pool.ensure('a')

  await assert.rejects(harness.pool.dispose('a', { clearSession: false }), /dispose a failed/)
  await assert.rejects(harness.pool.disposeAll(), /dispose a failed/)
  await assert.rejects(harness.pool.disposeAll(), /dispose a failed/)
  assert.deepEqual(harness.disposedGenerations, [1, 1, 1])
  await assert.rejects(harness.pool.ensure('a'), /dispose a failed/)
  assert.deepEqual(harness.createdGenerations('a'), [1])
})

test('deletion upgrades a blocked crash retirement to post-disposal session cleanup', async() => {
  const disposeGate = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    disposeGate: disposeGate.promise,
  })
  await harness.pool.ensure('a')

  harness.crash('a')
  await harness.waitForDisposed('a', 1)
  const deleting = harness.pool.dispose('a', { clearSession: true })
  const deleteOutcome = deleting.then(
    () => 'resolved',
    () => 'rejected',
  )
  assert.equal(await Promise.race([deleteOutcome, Promise.resolve('pending')]), 'pending')

  disposeGate.resolve()
  await deleting
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:1', 'clearSession:a'],
  )
  assert.deepEqual(harness.disposedGenerations, [1])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
})

test('deletion after the lower disposal promise settles clears the session once', async() => {
  const harness = createPoolHarness({ autoInit: true, initialConfiguredIds: ['a'] })
  await harness.pool.ensure('a')

  harness.crash('a')
  await harness.waitForDisposePromiseSettled('a', 1)
  await harness.pool.dispose('a', { clearSession: true })

  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('dispose:') || event.startsWith('clearSession:')),
    ['dispose:a:1', 'clearSession:a'],
  )
  assert.deepEqual(harness.disposedGenerations, [1])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
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

test('another owner cannot replace or consume a pending request with the same ID', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const first = harness.pool.request({ apiId: 'a', requestId: 'collision', data: {} }, 11)
  await harness.waitForPending('a', 'collision')

  const collision = harness.pool.request({ apiId: 'a', requestId: 'collision', data: {} }, 12)
  assert.equal(harness.respond('a', 'collision', 'first-owner'), true)

  assert.deepEqual(await first, { ok: true, value: 'first-owner' })
  assert.deepEqual(await collision, {
    ok: false,
    error: {
      name: 'PlaybackSourceError',
      message: 'User API request ID is already in use',
      scope: 'candidate',
      kind: 'request',
      apiId: 'a',
    },
  })
  assert.equal(harness.sentRequests.length, 1)
})

test('custom runtime failures cross IPC only as bounded metadata', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'failure', data: {} }, 11)
  await harness.waitForPending('a', 'failure')
  const binding = harness.binding('a')
  const runtime = await createRuntimePreloadFailureHarness({
    apiId: 'a',
    generation: binding.generation,
  })
  const envelope = await runtime.reject('failure', Object.assign(
    new Error(`${'m'.repeat(1100)}\nprivate script`),
    {
      code: `${'c'.repeat(80)}\nprivate code`,
      statusCode: 429,
      arbitrary: { token: 'must not cross IPC' },
    },
  ))

  assert.deepEqual(Object.keys(envelope).sort(), [
    'code', 'data', 'identity', 'message', 'status', 'statusCode',
  ])
  assert.equal(envelope.message, 'm'.repeat(1024))
  assert.equal(envelope.code, 'c'.repeat(64))
  assert.equal(envelope.statusCode, 429)
  assert.equal(harness.pool.acceptResponse(binding.webContentsId, envelope), true)
  assert.deepEqual(await pending, {
    ok: false,
    error: {
      name: 'PlaybackSourceError',
      message: 'm'.repeat(1024),
      scope: 'source',
      kind: 'rateLimit',
      apiId: 'a',
      statusCode: 429,
    },
  })
  assert.deepEqual(harness.loggedErrors, [])

  const invalidStatus = await runtime.reject('invalid-status', {
    message: 'invalid status',
    code: 'RATE_LIMIT',
    statusCode: 999,
    arbitrary: 'must not cross IPC',
  })
  assert.equal(Object.prototype.hasOwnProperty.call(invalidStatus, 'statusCode'), false)
  assert.equal(Object.prototype.hasOwnProperty.call(invalidStatus, 'arbitrary'), false)
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

test('invalidation during blocked creation settles by the original deadline and lets retry proceed', async() => {
  const clock = createFakeClock(0)
  const firstCreate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    initialConfiguredIds: ['a'],
    clock,
    createGate: (_apiId, generation) => generation == 1 ? firstCreate.promise : undefined,
  })
  const first = harness.pool.ensure('a')
  const firstOutcome = first.then(
    () => ({ status: 'resolved' }),
    error => ({ status: 'rejected', error }),
  )
  await harness.waitForCreateCall('a', 1)
  await harness.pool.invalidate('a', 'sourceChanged')
  const retry = harness.pool.ensure('a')

  clock.advance(9_999)
  await clock.flush()
  assert.equal(await Promise.race([firstOutcome, Promise.resolve('pending')]), 'pending')

  clock.advance(1)
  await clock.flush()
  const atDeadline = await Promise.race([firstOutcome, Promise.resolve('pending')])
  if (atDeadline == 'pending') firstCreate.resolve()
  assert.notEqual(atDeadline, 'pending')
  assert.equal(atDeadline.status, 'rejected')
  assert.equal(atDeadline.error.kind, 'sourceChanged')

  await harness.waitForInitializeCall('a', 2)
  await harness.init('a', { sources: {} })
  assert.equal((await retry).id, 'a')

  firstCreate.resolve()
  await harness.waitForDisposed('a', 1)
  assert.equal(harness.lifecycle.includes('send-init:a:1'), false)
  assert.equal(harness.pool.getStatus('a').status, true)
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

test('deletion clears the partition once when runtime creation fails', async() => {
  const gate = deferred()
  const harness = createPoolHarness({
    autoInit: false,
    createGate: gate.promise,
    createRejectIds: ['a'],
  })
  const ensuring = harness.pool.ensure('a')
  const failed = assert.rejects(ensuring, /create a failed/)
  await harness.waitForCreateCall('a')

  const deleting = harness.pool.dispose('a', { clearSession: true })
  gate.resolve()
  await failed
  await deleting

  assert.deepEqual(harness.lifecycle, ['create:a:1', 'clearSession:a'])
  assert.deepEqual(harness.clearedSessionIds, ['a'])
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

test('source replacement publishes its false runtime status before retiring the known API', async() => {
  const harness = createPoolHarness({ autoInit: true })
  await harness.pool.ensure('a')

  const invalidating = harness.pool.invalidate('a', 'sourceChanged')

  assert.deepEqual(harness.statusEvents.at(-1), {
    apiId: 'a',
    status: false,
    message: 'User API source changed',
    apiInfo: { id: 'a', name: 'A', description: '', allowShowUpdateAlert: false, sources: {} },
  })
  assert.equal(harness.lifecycle.includes('dispose:a:1'), false)

  await invalidating
  assert.equal(harness.lifecycle.includes('dispose:a:1'), true)
})

test('never-opened source creation waits behind its in-flight clear while another source remains independent', async() => {
  const clearSessionGate = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a', 'b'],
    clearSessionGate: clearSessionGate.promise,
  })
  const deleting = harness.pool.dispose('a', { clearSession: true })
  await harness.waitForSessionClearCall('a')

  const waitingEnsure = harness.pool.ensure('a')
  await harness.pool.ensure('b')
  const beforeClearCompletes = [...harness.lifecycle]

  clearSessionGate.resolve()
  await Promise.all([deleting, waitingEnsure])

  assert.equal(beforeClearCompletes.includes('create:a:1'), false)
  assert.equal(beforeClearCompletes.includes('create:b:1'), true)
  assert.deepEqual(harness.createdGenerations('a'), [1])
  assert.deepEqual(
    harness.lifecycle.filter(event => event.startsWith('clearSession:') || event.startsWith('create:')),
    ['clearSession:a', 'create:b:1', 'create:a:1'],
  )
})

test('failed never-opened source clear retains creation barrier until explicit retry succeeds', async() => {
  const firstClear = deferred()
  const harness = createPoolHarness({
    autoInit: true,
    initialConfiguredIds: ['a'],
    clearSessionGate: firstClear.promise,
    clearSessionFailures: new Map([['a', 1]]),
  })
  const deleting = harness.pool.dispose('a', { clearSession: true })
  await harness.waitForSessionClearCall('a')
  const waitingEnsure = harness.pool.ensure('a')
  const beforeFailure = [...harness.lifecycle]

  firstClear.resolve()
  const outcomes = await Promise.allSettled([deleting, waitingEnsure])
  await assert.rejects(harness.pool.ensure('a'), /clear session a failed/)

  assert.deepEqual(outcomes.map(result => result.status), ['rejected', 'rejected'])
  assert.equal(beforeFailure.includes('create:a:1'), false)
  assert.deepEqual(harness.createdGenerations('a'), [])
  assert.deepEqual(
    harness.lifecycle.filter(event => event == 'clearSession:a'),
    ['clearSession:a'],
  )
  assert.equal(
    harness.loggedErrors.filter(entry =>
      entry.message.includes('retire User API runtime creation a failed')).length,
    1,
  )

  await harness.pool.dispose('a', { clearSession: true })
  await harness.pool.ensure('a')

  assert.deepEqual(
    harness.lifecycle.filter(event => event == 'clearSession:a'),
    ['clearSession:a', 'clearSession:a'],
  )
  assert.deepEqual(harness.clearedSessionIds, ['a'])
  assert.deepEqual(harness.createdGenerations('a'), [1])
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

test('custom-source initialization failure advances to fallback', async() => {
  const harness = createIntegrationHarness({
    sourceIds: ['primary', 'fallback'],
    autoInitialize: false,
  })
  const playback = harness.play()
  await harness.waitForInitialization('primary')
  await harness.failInitialization('primary', 'temporary initialization failure')
  await harness.waitForInitialization('fallback')
  await harness.acceptInitialization('fallback')
  const fallback = await harness.waitForRequest({ apiId: 'fallback', platform: 'wy' })
  harness.succeed(fallback, 'https://valid')
  await harness.waitForBoundForeground('https://valid')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.sourceOrder, ['primary', 'fallback'])
  assert.equal(harness.visibleErrorCount, 0)
})

test('foreground and preload requests cannot consume each other responses', async() => {
  const harness = createIntegrationHarness()
  const foreground = harness.play(songA)
  const preload = harness.preload(songB)
  const foregroundRequest = await harness.waitForRequest({
    apiId: 'primary', songIdentity: 'wy:song', platform: 'wy',
  })
  const preloadRequest = await harness.waitForRequest({
    apiId: 'primary', songIdentity: 'wy:song-b', platform: 'wy',
  })
  harness.succeed(preloadRequest, 'https://b')
  harness.succeed(foregroundRequest, 'https://a')
  await Promise.all([
    harness.waitForBoundPreload('wy:song-b', 'https://b'),
    harness.waitForBoundForeground('https://a'),
  ])
  harness.emitPreloadCanplay('wy:song-b')
  harness.emitForegroundCanplay()
  await Promise.all([foreground, preload])
  assert.deepEqual(harness.foregroundBoundUrls, ['https://a'])
  assert.deepEqual(harness.preloadBoundUrls, ['https://b'])
})

test('source deletion during resolution advances without mutating session snapshot', async() => {
  const harness = createIntegrationHarness({ sourceIds: ['primary', 'deleted', 'last'] })
  const playback = harness.play()
  const primary = await harness.waitForRequest({ apiId: 'primary', platform: 'wy' })
  harness.fail(primary, new Error('primary failed'))
  await harness.waitForRequest({ apiId: 'deleted', platform: 'wy' })
  await harness.deleteSource('deleted')
  const last = await harness.waitForRequest({ apiId: 'last', platform: 'wy' })
  harness.succeed(last, 'https://valid')
  await harness.waitForBoundForeground('https://valid')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.sessionSourceSnapshots[0], ['primary', 'deleted', 'last'])
  assert.deepEqual(harness.persistedFallbackIds, ['last'])
})

test('runtime crash advances the affected playback session to its next source', async() => {
  const harness = createIntegrationHarness({ sourceIds: ['primary', 'fallback'] })
  const playback = harness.play()
  await harness.waitForRequest({ apiId: 'primary', platform: 'wy' })
  harness.crash('primary')
  const fallback = await harness.waitForRequest({ apiId: 'fallback', platform: 'wy' })
  harness.succeed(fallback, 'https://valid')
  await harness.waitForBoundForeground('https://valid')
  harness.emitForegroundCanplay()
  await playback
  assert.deepEqual(harness.sourceOrder, ['primary', 'fallback'])
  assert.equal(harness.visibleErrorCount, 0)
})
