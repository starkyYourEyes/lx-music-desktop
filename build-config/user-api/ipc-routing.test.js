const assert = require('node:assert/strict')
const test = require('node:test')
const { createPoolHarness } = require('../test-utils/playback-fallback-harness')

test('payload API identity cannot impersonate the bound sender', async() => {
  const harness = createPoolHarness()
  await harness.bind('a', 101, 1)
  const before = structuredClone(harness.pool.getStatus('a'))
  const accepted = harness.pool.acceptInit(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: { sources: {} },
  })
  assert.equal(accepted, false)
  assert.deepEqual(harness.pool.getStatus('a'), before)
})

test('cancel requires API ID request ID and owner webContents ID', async() => {
  const harness = createPoolHarness({ autoInit: true })
  const pending = harness.pool.request({ apiId: 'a', requestId: 'r', data: {} }, 11)
  await harness.waitForPending('a', 'r')
  harness.pool.cancel({ apiId: 'a', requestId: 'r', reason: 'cancelled' }, 12)
  assert.equal(await Promise.race([pending.then(() => 'settled'), Promise.resolve('pending')]), 'pending')
  harness.pool.cancel({ apiId: 'a', requestId: 'r', reason: 'cancelled' }, 11)
  assert.equal((await pending).ok, false)
})

test('update alerts and developer tools use the trusted sender binding', async() => {
  const harness = createPoolHarness()
  await harness.bind('a', 101, 1, { name: 'Trusted A', allowShowUpdateAlert: true })
  harness.sendUpdateAlert(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: { log: 'release' },
  })
  harness.openDevTools(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: undefined,
  })
  harness.getProxy(101, {
    identity: { apiId: 'b', generation: 1 }, status: true, data: undefined,
  })
  assert.deepEqual(harness.alerts, [])
  assert.deepEqual(harness.devToolsIds, [])
  assert.deepEqual(harness.proxyRecipients, [])
  harness.sendUpdateAlert(101, {
    identity: { apiId: 'a', generation: 1 }, status: true, data: { log: 'release' },
  })
  harness.openDevTools(101, {
    identity: { apiId: 'a', generation: 1 }, status: true, data: undefined,
  })
  harness.getProxy(101, {
    identity: { apiId: 'a', generation: 1 }, status: true, data: undefined,
  })
  assert.equal(harness.alerts[0].name, 'Trusted A')
  assert.deepEqual(harness.devToolsIds, ['a'])
  assert.deepEqual(harness.proxyRecipients, ['a'])
})
