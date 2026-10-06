const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const load = require('../../scripts/test-utils/load-ts-module')
const policy = load(path.resolve('src/common/performance/featurePolicy.ts'))
const deferred = () => { let resolve; let reject; const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject }); return { promise, resolve, reject } }

const createEvents = t => {
  const original = global.lx
  global.lx = { appSetting: { 'performance.simplifyVisuals': false, 'player.volume': 0.5 } }
  t.after(() => { global.lx = original })
  const writes = []
  const published = []
  const persistence = deferred()
  const merge = patch => ({
    setting: { ...global.lx.appSetting, ...patch },
    updatedSettingKeys: Object.keys(patch),
    updatedSetting: patch,
  })
  const { Event } = load(path.resolve('src/main/event/AppEvent.ts'), {
    '@common/performance/featurePolicy': policy,
    '@main/utils': {
      saveAppHotKeyConfig() {},
      updateSetting(patch) { writes.push(patch); return merge(patch) },
      async updateSettingDurable(patch) {
        writes.push(patch)
        await persistence.promise
        return merge(patch)
      },
    },
  })
  const events = new Event()
  events.on('updated_config', (keys, setting) => published.push({ keys, setting }))
  return { events, persistence, published, writes }
}

test('failed durable settings never publish a runtime or configuration change', async t => {
  const { events, persistence, published } = createEvents(t)
  const saved = events.update_config({ 'performance.simplifyVisuals': true })
  assert.equal(published.length, 0)
  persistence.reject(new Error('disk full'))
  await assert.rejects(saved, /disk full/)
  assert.equal(global.lx.appSetting['performance.simplifyVisuals'], false)
  assert.equal(published.length, 0)
})

test('ordinary settings wait behind a pending durable update before reading the runtime snapshot', async t => {
  const { events, persistence, published, writes } = createEvents(t)
  const saved = events.update_config({ 'performance.simplifyVisuals': true })
  const volume = events.update_config({ 'player.volume': 0.8 })
  assert.equal(writes.length, 1)
  assert.equal(published.length, 0)
  persistence.resolve()
  await Promise.all([saved, volume])
  assert.equal(global.lx.appSetting['performance.simplifyVisuals'], true)
  assert.equal(global.lx.appSetting['player.volume'], 0.8)
  assert.deepEqual(published.map(entry => entry.keys), [['performance.simplifyVisuals'], ['player.volume']])
})
