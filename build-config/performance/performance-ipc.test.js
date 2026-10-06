const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const load = require('../../scripts/test-utils/load-ts-module')
const policy = load(path.resolve('src/common/performance/featurePolicy.ts'))
const restart = load(path.resolve('src/main/services/appRestart.ts'))
const names = { performance_apply: 'apply', performance_status: 'status', performance_restart: 'restart', performance_prepare: 'prepare' }

const harness = (t, fail = '') => {
  const original = global.lx
  const events = []
  const saved = { 'performance.simplifyVisuals': false }
  const handlers = {}
  const sender = { mainFrame: {} }
  global.lx = {
    appSetting: saved,
    event_app: {
      async update_config(patch) { if (fail == 'save') throw new Error('save failed'); Object.assign(saved, patch); events.push('saved') },
      async flush_config() { events.push('settings'); if (fail == 'settings') throw new Error('settings failed') },
    },
    storage: { async prepareRestart() { events.push('storage'); if (fail == 'storage') throw new Error('storage failed') } },
  }
  t.after(() => { global.lx = original })
  const initialize = load(path.resolve('src/main/modules/winMain/rendererEvent/performance.ts'), {
    electron: { app: { relaunch() { events.push('relaunch') } } },
    '@common/mainIpc': { mainHandle: (name, handler) => { handlers[name] = handler } },
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: names },
    '@common/performance/featurePolicy': policy,
    '../main': { getWebContents: () => sender, isRendererAlive: () => true },
    '@main/services/optionalResources': { initOptionalResources() {}, getOptionalResourceStatus: () => ({}), async prepareOptionalResource(feature) { events.push(`prepare:${feature}`) } },
    '@main/services/appRestart': restart,
    '@main/utils/store': { async flushStores() { events.push('stores'); if (fail == 'stores') throw new Error('stores failed') } },
    '@main/app': { quitApp() { events.push('quit') } },
  }).default
  initialize(async() => { events.push('renderer'); if (fail == 'renderer') throw new Error('renderer failed') })
  const trusted = { sender, senderFrame: sender.mainFrame }
  return { handlers, trusted, events, saved }
}

test('all feature IPC actions reject foreign windows and child frames before side effects', async t => {
  const { handlers, trusted, events } = harness(t)
  for (const handler of Object.values(handlers)) {
    for (const event of [{ sender: { mainFrame: {} }, senderFrame: {} }, { ...trusted, senderFrame: {} }]) {
      await assert.rejects(handler({ event, params: { 'performance.simplifyVisuals': true } }), /Untrusted/)
    }
  }
  assert.deepEqual(events, [])
})

test('feature apply rejects unrelated keys and propagates failed durable saves', async t => {
  const { handlers, trusted, events, saved } = harness(t, 'save')
  await assert.rejects(handlers.apply({ event: trusted, params: { 'player.volume': 1 } }), /Invalid/)
  await assert.rejects(handlers.apply({ event: trusted, params: { 'performance.simplifyVisuals': true } }), /save failed/)
  assert.equal(saved['performance.simplifyVisuals'], false)
  assert.deepEqual(events, [])
})

test('feature preparation validates the feature identity before dispatch', async t => {
  const { handlers, trusted, events } = harness(t)
  for (const params of ['unknown', {}, null]) await assert.rejects(handlers.prepare({ event: trusted, params }), /Invalid/)
  assert.deepEqual(events, [])
  await handlers.prepare({ event: trusted, params: 'soundEffects' })
  assert.deepEqual(events, ['prepare:soundEffects'])
})

test('restart flushes configuration, renderer and non-destructive storage before relaunch', async t => {
  const { handlers, trusted, events } = harness(t)
  await Promise.all([handlers.restart({ event: trusted }), handlers.restart({ event: trusted })])
  assert.deepEqual(events, ['settings', 'renderer', 'storage', 'relaunch', 'quit'])
})

for (const failure of ['settings', 'renderer', 'storage']) {
  test(`restart stops before relaunch when ${failure} persistence fails`, async t => {
    const { handlers, trusted, events } = harness(t, failure)
    await assert.rejects(handlers.restart({ event: trusted }), new RegExp(`${failure} failed`))
    assert.equal(events.includes('relaunch'), false)
    assert.equal(events.includes('quit'), false)
  })
}
