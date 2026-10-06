const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('../../scripts/test-utils/load-ts-module')
const rules = require('../../src/common/utils/listProfileSync')
const barrier = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

for (const stage of ['get', 'apply', 'ack']) {
  for (const both of [false, true]) {
    test(`profile cancellation at ${stage}, disable ${both ? 'both' : 'profile'}, remains graceful`, async() => {
      const entered = barrier()
      const release = barrier()
      const counts = { get: 0, apply: 0, ack: 0, persist: 0, finished: 0, close: 0 }
      const snapshot = rules.normalizeSnapshot({ version: 1, listIds: ['one'], profiles: {} })
      const step = async name => { counts[name]++; if (name == stage && counts[name] == 1) { entered.resolve(); await release.promise }; return snapshot }
      const profile = load('src/main/modules/sync/server/modules/listProfile/index.ts', {
        '@common/utils/listProfileSync': rules,
        '@main/modules/sync/listProfileEvent': { getProfileSnapshot: async() => snapshot, applyProfileSnapshot: () => step('apply') },
        '@main/utils/store': () => ({ get() {}, setDurable: async() => { counts.persist++ } }),
        '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4000 } },
      })
      const feature = load('src/main/modules/sync/server/server/sync/handler.ts', { '../../modules': { modules: { listProfile: profile, list: { sync: async socket => { socket.moduleReadys.list = true } } } } }).default
      const socket = { readyState: 1, feature: { list: true, listProfile: true }, moduleReadys: { list: true, listProfile: false }, userInfo: { name: 'fixture' }, keyInfo: { clientId: 'fixture' }, remoteQueueListProfile: { profile_sync_get: () => step('get'), profile_sync_apply: () => step('ack'), profile_sync_finished: async() => { counts.finished++ } }, close() { counts.close++ } }
      const pending = profile.sync(socket)
      await entered.promise
      await feature.onFeatureChanged(socket, both ? { list: false, listProfile: false } : { listProfile: false })
      release.resolve()
      await pending
      assert.equal(socket.moduleReadys.listProfile, false)
      assert.equal(counts.finished, 0)
      assert.equal(counts.persist, 0)
      assert.equal(counts.close, 0)
      assert.equal(counts.apply, stage == 'get' ? 0 : 1)
      assert.equal(counts.ack, stage == 'ack' ? 1 : 0)
      await feature.onFeatureChanged(socket, both ? { list: true, listProfile: true } : { listProfile: true })
      assert.equal(socket.moduleReadys.listProfile, true)
      assert.equal(counts.finished, 1)
      assert.equal(counts.close, 0)
    })
  }
}

test('re-enable waits for an obsolete remote read, ignores its failure and completes a fresh round', async() => {
  const entered = barrier()
  const release = barrier()
  let gets = 0
  let applies = 0
  let finishes = 0
  let closes = 0
  const snapshot = rules.normalizeSnapshot({ version: 1, listIds: [], profiles: {} })
  const profile = load('src/main/modules/sync/server/modules/listProfile/index.ts', {
    '@common/utils/listProfileSync': rules,
    '@main/modules/sync/listProfileEvent': { getProfileSnapshot: async() => snapshot, applyProfileSnapshot: async() => { applies++; return snapshot } },
    '@main/utils/store': () => ({ get() {}, setDurable: async() => {} }),
    '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4000 } },
  })
  const feature = load('src/main/modules/sync/server/server/sync/handler.ts', { '../../modules': { modules: { listProfile: profile } } }).default
  const socket = { readyState: 1, feature: { list: true, listProfile: true }, moduleReadys: { list: true, listProfile: false }, userInfo: { name: 'fixture' }, keyInfo: { clientId: 'fixture' }, remoteQueueListProfile: {
    async profile_sync_get() { if (++gets == 1) { entered.resolve(); await release.promise; throw new Error('obsolete request') }; return snapshot },
    profile_sync_apply: async() => snapshot,
    profile_sync_finished: async() => { finishes++ },
  }, close() { closes++ } }
  const old = profile.sync(socket)
  await entered.promise
  await feature.onFeatureChanged(socket, { listProfile: false })
  const current = feature.onFeatureChanged(socket, { listProfile: true })
  assert.equal(gets, 1, 'new work remains serialized behind the old RPC')
  release.resolve()
  await Promise.all([old, current])
  assert.equal(socket.moduleReadys.listProfile, true)
  assert.equal(finishes, 1)
  assert.equal(closes, 0)
  assert.ok(applies > 0)
})
