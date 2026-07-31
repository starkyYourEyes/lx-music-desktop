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
