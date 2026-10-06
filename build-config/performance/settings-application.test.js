const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const load = require('../../scripts/test-utils/load-ts-module')
const policy = load(path.resolve('src/common/performance/featurePolicy.ts'))
const draft = load(path.resolve('src/common/performance/settingsDraft.ts'))
const names = { performance_apply: 'apply', performance_status: 'status', performance_restart: 'restart' }
const deferred = () => { let resolve; let reject; const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject }); return { promise, resolve, reject } }

const harness = (t, handlers = {}) => {
  const appSetting = vue.reactive({ ...policy.migratePerformanceSettings({}), 'player.volume': 0.5 })
  const calls = []
  const featureRuntimeStates = vue.reactive(Object.fromEntries(policy.FEATURE_IDS.map(id => [id, {
    loaded: false, active: false, draining: false, restartRequired: false, error: null, activeCount: 0, pendingCount: 0,
  }])))
  const scope = vue.effectScope()
  t.after(() => scope.stop())
  const store = scope.run(() => load(path.resolve('src/renderer/store/performance.ts'), {
    '@common/utils/vueTools': vue,
    '@common/performance/featurePolicy': policy,
    '@common/performance/settingsDraft': draft,
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: names },
    '@common/rendererIpc': {
      async rendererInvoke(name, params) {
        calls.push({ name, params })
        if (handlers[name]) return handlers[name](params)
        return name == 'apply' ? { ...appSetting, ...params } : {}
      },
    },
    './setting': { appSetting, mergeSetting: saved => Object.assign(appSetting, saved) },
    '@renderer/core/features/runtime': { featureRuntimeStates },
  }))
  return { store, appSetting, calls, featureRuntimeStates }
}

test('failed persistence retains draft edits and does not announce a restart', async t => {
  const { store, appSetting, calls } = harness(t, { apply: async() => { throw new Error('disk full') } })
  store.editPerformanceSetting('performance.simplifyVisuals', true)
  assert.equal(await store.applyPerformanceDraft(), false)
  assert.equal(store.performanceDraft.value['performance.simplifyVisuals'], true)
  assert.equal(appSetting['performance.simplifyVisuals'], false)
  assert.equal(store.performanceDirty.value, true)
  assert.equal(store.performanceSaving.value, false)
  assert.equal(store.showRestartNotice.value, false)
  assert.deepEqual(calls.map(call => call.name), ['apply'])
})

test('a status failure after a durable save reports runtime failure without claiming the save failed', async t => {
  const { store, appSetting } = harness(t, { status: async() => { throw new Error('window closed') } })
  store.editPerformanceSetting('performance.simplifyVisuals', true)
  assert.equal(await store.applyPerformanceDraft(), true)
  assert.equal(appSetting['performance.simplifyVisuals'], true)
  assert.equal(store.performanceDirty.value, false)
  assert.equal(store.performanceError.value, 'performance_runtime_error')
  assert.equal(store.showRestartNotice.value, false)
})

test('a saved response cannot overwrite a more recent unrelated settings update', async t => {
  const response = deferred()
  const { store, appSetting } = harness(t, { apply: () => response.promise })
  const snapshot = { ...appSetting, 'performance.simplifyVisuals': true }
  store.editPerformanceSetting('performance.simplifyVisuals', true)
  const applied = store.applyPerformanceDraft()
  Object.assign(appSetting, { 'player.volume': 0.8, 'performance.cacheProfile': 'generous' })
  await vue.nextTick()
  response.resolve(snapshot)
  assert.equal(await applied, true)
  assert.equal(appSetting['player.volume'], 0.8)
  assert.equal(appSetting['performance.cacheProfile'], 'generous')
  assert.equal(store.performanceDraft.value['performance.cacheProfile'], 'generous')
})

test('late polling results cannot remove a restart reason discovered by the apply operation', async t => {
  const oldStatus = deferred()
  let statusCount = 0
  const { store } = harness(t, { status: () => ++statusCount == 1 ? oldStatus.promise : { soundEffects: { restartRequired: true } } })
  const polling = store.refreshPerformanceStatus()
  store.editPerformanceSetting('performance.simplifyVisuals', true)
  await store.applyPerformanceDraft()
  assert.deepEqual(store.restartFeatures.value, ['soundEffects'])
  assert.equal(store.showRestartNotice.value, true)
  oldStatus.resolve({ soundEffects: { restartRequired: false } })
  await polling
  assert.deepEqual(store.restartFeatures.value, ['soundEffects'])
})

test('confirmed external conflicts submit only the current dirty field and repeated reasons show one modal', async t => {
  const { store, appSetting, calls } = harness(t, { status: () => ({ soundEffects: { restartRequired: true } }) })
  store.editPerformanceSetting('performance.cacheProfile', 'generous')
  appSetting['performance.cacheProfile'] = 'balanced'
  await vue.nextTick()
  assert.deepEqual(store.performanceConflicts.value, ['performance.cacheProfile'])
  assert.equal(await store.applyPerformanceDraft(), false)
  store.confirmPerformanceConflicts()
  assert.equal(await store.applyPerformanceDraft(), true)
  assert.deepEqual(calls.find(call => call.name == 'apply').params, { 'performance.cacheProfile': 'generous' })
  assert.equal(store.showRestartNotice.value, true)
  store.showRestartNotice.value = false
  store.editPerformanceSetting('performance.simplifyVisuals', true)
  await store.applyPerformanceDraft()
  assert.equal(store.showRestartNotice.value, false)
})
