const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')

const settingIndex = read('src/renderer/views/Setting/index.vue')
const localMusicPage = read('src/renderer/views/LocalMusic/index.vue')
const localMusicAction = read('src/renderer/store/localMusic/action.ts')

assert(
  settingIndex.includes("import SettingLocalMusic from './components/SettingLocalMusic.vue'"),
  'Setting page should import SettingLocalMusic component',
)

assert(
  /SettingLocalMusic,\s*[\r\n]/.test(settingIndex),
  'SettingLocalMusic should be registered as a setting component',
)

assert(
  /id:\s*'SettingLocalMusic'/.test(settingIndex),
  'Setting navigation should expose a top-level Local Music section',
)

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
