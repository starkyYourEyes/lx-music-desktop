const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const { loadVueSfc } = require('./test-utils/load-vue-sfc')
const lazyLoaders = []
const settingComponent = loadVueSfc(path.join(root, 'src/renderer/views/Setting/index.vue'), {
  '@common/utils/vueTools': { ...require('vue'), watch() {}, defineAsyncComponent(loader) { lazyLoaders.push(loader); return { loader } } },
  '@renderer/plugins/i18n': { useI18n: () => key => key },
  '@common/utils/vueRouter': { useRoute: () => ({ query: { name: 'SettingLocalMusic' } }), useRouter: () => ({}), onBeforeRouteLeave() {}, onBeforeRouteUpdate() {} },
  '@renderer/store/performance': { requestPerformanceLeave: async() => true },
}).default
const localMusicPage = read('src/renderer/views/LocalMusic/index.vue')
const localMusicAction = read('src/renderer/store/localMusic/action.ts')

assert(lazyLoaders.includes(settingComponent.components.SettingLocalMusic.loader), 'Local Music is registered lazily')
assert.match(String(settingComponent.components.SettingLocalMusic.loader), /components\/SettingLocalMusic\.vue/)
const settings = settingComponent.setup()
assert.equal(settings.avtiveComponentName.value, 'SettingLocalMusic')
assert.equal(settings.tocList.value.filter(item => item.id === 'SettingLocalMusic').length, 1)
assert.equal(settings.tocList.value.some(item => !settingComponent.components[item.id]), false, 'every navigable setting must have a registered component')

assert(
  /query:\s*\{\s*name:\s*'SettingLocalMusic'\s*\}/s.test(localMusicPage),
  'Local Music settings button should jump to the Local Music settings section',
)

assert(
  localMusicPage.includes("import { useRouter } from '@common/utils/vueRouter'"),
  'Local Music settings button should use the app router helper',
)

assert(
  localMusicPage.includes('const t = useI18n()') &&
  !localMusicPage.includes('const { t } = useI18n()'),
  'Local Music should use the translation function returned by useI18n directly',
)

assert(
  localMusicAction.includes('if (!dirs.length) {') &&
  localMusicAction.includes('scanLocalMusicFolders({ dirs })'),
  'Local Music scan should skip IPC without configured dirs and send explicit dirs when configured',
)

console.log('local music settings wiring tests passed')
