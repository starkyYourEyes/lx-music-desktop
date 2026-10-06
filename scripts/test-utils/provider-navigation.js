const assert = require('node:assert/strict')
const path = require('node:path')
const { loadVueSfc } = require('./load-vue-sfc')
const loadTsModule = require('./load-ts-module')
const root = path.resolve(__dirname, '../..')
const policy = loadTsModule(path.join(root, 'src/common/performance/featurePolicy.ts'))

const assertProviderNavigation = (feature, routePath) => {
  const appSetting = {}
  const loads = []
  const guards = []
  let routes
  loadTsModule(path.join(root, 'src/renderer/router.ts'), {
    'vue-router': {
      createWebHashHistory() {},
      createRouter(options) {
        routes = options.routes
        return { beforeEach: guard => guards.push(guard), beforeResolve: guard => guards.push(guard), afterEach() {}, currentRoute: { value: { path: '/search' } } }
      },
    },
    vue: { watch() {} },
    '@renderer/store/setting': { appSetting },
    '@common/performance/featurePolicy': policy,
    '@renderer/core/features/recommendations': { loadRecommendationPage: id => { loads.push(id); return id }, noteFeaturePageLoaded() {} },
  })
  assert.deepEqual(loads, [], 'route registration must stay lazy')
  const route = routes.find(route => route.path === routePath)
  assert.ok(route, routePath)
  assert.equal(route.component(), feature)
  assert.deepEqual(loads, [feature])
  for (const guard of guards) assert.equal(guard({ path: routePath }), undefined)
  const nav = loadVueSfc(path.join(root, 'src/renderer/components/layout/Aside/NavBar.vue'), {
    '@common/performance/featurePolicy': policy,
    '@renderer/store/setting': { appSetting },
    '@root/lang': { useI18n: () => key => key },
    '@common/utils/vueTools': require('vue'),
    '@common/utils/vueRouter': { useRoute: () => ({ path: routePath, meta: {}, query: {} }) },
    '@common/constants': { LIST_IDS: { LOVE: 'love' } },
    '@renderer/assets/images/providers/netease-music.svg': 'netease.svg',
    '@renderer/assets/images/providers/qq-music.svg': 'qq.svg',
    '@renderer/assets/images/providers/kugou-music.svg': 'kugou.svg',
    '@renderer/views/List/MyList/index.vue': {},
  }).default
  const enabled = nav.setup()
  assert.deepEqual(enabled.providerMenus.value.map(item => item.to), ['/recommend', '/qq-recommend', '/kg-recommend'])
  assert.equal(enabled.mainMenus.value.some(item => item.to === routePath), false, 'providers have a distinct navigation group')
  appSetting[policy.featureSettingKey(feature)] = 'off'
  for (const guard of guards) assert.deepEqual(guard({ path: routePath }), { path: '/feature-disabled', query: { feature } })
  assert.equal(nav.setup().providerMenus.value.some(item => item.to === routePath), false)
}
module.exports = { assertProviderNavigation }
