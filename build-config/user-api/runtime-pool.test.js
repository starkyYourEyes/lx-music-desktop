const assert = require('node:assert/strict')
const test = require('node:test')
const { createRuntimeWindowHarness } = require('../test-utils/playback-fallback-harness')

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
