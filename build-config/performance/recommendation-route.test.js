const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const babel = require('@babel/core')
const vue = require('vue')
const vueRouter = require('vue-router')
const load = require('../../scripts/test-utils/load-ts-module')
const policy = load(path.resolve('src/common/performance/featurePolicy.ts'))

const loadAsyncModule = (file, requireMock) => {
  const filename = path.resolve(file)
  const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
    filename,
    babelrc: false,
    configFile: false,
    presets: [[require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }]],
    plugins: [require.resolve('@babel/plugin-transform-dynamic-import'), require.resolve('@babel/plugin-transform-modules-commonjs')],
  })
  const module = { exports: {} }
  // Execute the production module, with module loading as the controlled boundary.
  // eslint-disable-next-line no-new-func
  new Function('require', 'module', 'exports', code)(requireMock, module, module.exports)
  return module.exports
}

const harness = t => {
  const appSetting = vue.reactive(policy.migratePerformanceSettings({}))
  const featureRuntimeStates = vue.reactive(Object.fromEntries(policy.FEATURE_IDS.map(id => [id, { loaded: false, active: false, restartRequired: false }])))
  const recommendationPlaybackActive = vue.reactive({ neteaseRecommend: false, qqRecommend: false, kugouRecommend: false })
  const imports = []
  let pendingImport
  const scope = vue.effectScope()
  t.after(() => scope.stop())
  const mocks = {
    vue,
    'vue-router': { ...vueRouter, createWebHashHistory: vueRouter.createMemoryHistory },
    '@common/utils/vueTools': vue,
    '@common/performance/featurePolicy': policy,
    '@renderer/store/setting': { appSetting },
    './recommendationAccess': { recommendationPlaybackActive },
    './runtime': { featureRuntimeStates, registerFeaturePreparation() {}, reportFeatureState: (id, state) => Object.assign(featureRuntimeStates[id], state) },
  }
  const requireMock = name => {
    if (mocks[name]) return mocks[name]
    if (name.endsWith('.vue')) {
      imports.push(name)
      return pendingImport && name.includes('/Recommend/') ? pendingImport : { __esModule: true, default: { name } }
    }
    return require(name)
  }
  const resources = scope.run(() => loadAsyncModule('src/renderer/core/features/recommendations.ts', requireMock))
  scope.run(resources.initRecommendationPolicies)
  mocks['@renderer/core/features/recommendations'] = resources
  const router = scope.run(() => loadAsyncModule('src/renderer/router.ts', requireMock)).default
  return {
    router,
    resources,
    appSetting,
    imports,
    featureRuntimeStates,
    delayImport() {
      let finish
      pendingImport = new Promise(resolve => { finish = resolve })
      pendingImport.__esModule = true
      return () => finish({ default: { name: 'RealRecommend' } })
    },
  }
}

test('disabled cold routes redirect before loading recommendation code', async t => {
  const { router, appSetting, imports } = harness(t)
  appSetting['performance.features.neteaseRecommend'] = 'off'
  await router.push('/recommend')
  assert.equal(router.currentRoute.value.path, '/feature-disabled')
  assert.equal(imports.some(name => name.includes('/Recommend/')), false)
})

test('disabling an in-flight route does not poison the cached route component after re-enable', async t => {
  const { router, appSetting, imports, delayImport } = harness(t)
  await router.push('/setting')
  const finish = delayImport()
  const navigation = router.push('/recommend')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(imports.some(name => name.includes('/Recommend/')), true)
  appSetting['performance.features.neteaseRecommend'] = 'off'
  finish()
  await navigation
  assert.equal(router.currentRoute.value.path, '/feature-disabled')
  appSetting['performance.features.neteaseRecommend'] = 'onDemand'
  await router.push('/recommend')
  assert.equal(router.currentRoute.value.path, '/recommend')
  assert.match(router.currentRoute.value.matched[0].components.default.name, /Recommend/)
})

test('resident downgrade during import preserves a restart reason; reverted off-only changes clear it', async t => {
  const { appSetting, resources, featureRuntimeStates, delayImport } = harness(t)
  const finish = delayImport()
  appSetting['performance.features.neteaseRecommend'] = 'resident'
  await Promise.resolve()
  appSetting['performance.features.neteaseRecommend'] = 'onDemand'
  finish()
  await resources.loadRecommendationPage('neteaseRecommend')
  assert.equal(featureRuntimeStates.neteaseRecommend.restartRequired, true)
  appSetting['performance.features.neteaseRecommend'] = 'resident'
  assert.equal(featureRuntimeStates.neteaseRecommend.restartRequired, false)
  await resources.loadRecommendationPage('qqRecommend')
  appSetting['performance.features.qqRecommend'] = 'off'
  assert.equal(featureRuntimeStates.qqRecommend.restartRequired, true)
  appSetting['performance.features.qqRecommend'] = 'onDemand'
  assert.equal(featureRuntimeStates.qqRecommend.restartRequired, false)
})

test('canceled navigation leaves feature activity unchanged', async t => {
  const { router, featureRuntimeStates } = harness(t)
  await router.push('/setting')
  router.beforeEach(() => false)
  await router.push('/recommend')
  assert.equal(router.currentRoute.value.path, '/setting')
  assert.equal(featureRuntimeStates.neteaseRecommend.active, false)
})
