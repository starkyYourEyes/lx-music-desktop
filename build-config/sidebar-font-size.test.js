const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const loadFonts = () => loadTsModule(path.join(root, 'src/common/utils/sidebarFontSize.ts'))
const loadDefaults = () => loadTsModule(path.join(root, 'src/common/defaultSetting.ts'), {
  './constants': { RECOMMEND_HOME_SECTION_IDS: [] },
  './projectIdentity': { PROJECT_IDENTITY: { defaultWebdavUrl: '' } },
  './utils/playBarLayout': { PLAY_BAR_HEIGHT_DEFAULT: 74 },
  './utils/backgroundTransparency': { BACKGROUND_TRANSPARENCY_DEFAULT: 40 },
}).default

test('settings provide three independent sidebar font defaults', () => {
  const defaults = loadDefaults()
  assert.equal(defaults['common.sidebarNavigationFontSize'], 13)
  assert.equal(defaults['common.sidebarTitleFontSize'], 12)
  assert.equal(defaults['common.sidebarPlaylistFontSize'], 13)
})

test('sidebar font input defaults invalid values, rounds, and enforces bounds', () => {
  const { normalizeSidebarFontSize } = loadFonts()
  for (const value of [null, undefined, '', '  ', 'invalid', true, false, [], {}, Infinity, NaN]) {
    assert.equal(normalizeSidebarFontSize(value, 12), 12)
  }
  assert.equal(normalizeSidebarFontSize('16', 12), 16)
  assert.equal(normalizeSidebarFontSize(16.6, 12), 17)
  assert.equal(normalizeSidebarFontSize(0, 12), 10)
  assert.equal(normalizeSidebarFontSize(30, 12), 24)
})

test('sidebar font styles retain exact pixel sizes across all sidebar scales', () => {
  const { getSidebarFontStyles, SIDEBAR_FONT_SETTINGS } = loadFonts()
  const defaults = loadDefaults()
  for (const item of SIDEBAR_FONT_SETTINGS) assert.equal(item.defaultValue, defaults[item.key])
  for (const scale of [70, 90, 130]) {
    assert.deepEqual(getSidebarFontStyles({
      'common.sidebarNavigationFontSize': 16,
      'common.sidebarTitleFontSize': 20,
      'common.sidebarPlaylistFontSize': 24,
      'list.myListSidebarScale': scale,
    }), {
      '--sidebar-navigation-font-size': '16px',
      '--sidebar-title-font-size': '20px',
      '--sidebar-playlist-font-size': '24px',
    })
  }
  assert.deepEqual(getSidebarFontStyles({}), getSidebarFontStyles(defaults))
})

test('controls save only the changed region, normalize drafts, reset independently, and follow restored settings', async() => {
  const fonts = loadFonts()
  const appSetting = vue.reactive(loadDefaults())
  const saved = []
  const component = loadVueSfc(path.join(root, 'src/renderer/views/Setting/components/SidebarFontSettings.vue'), {
    vue,
    '@common/utils/vueTools': vue,
    '@common/utils/sidebarFontSize': fonts,
    '@renderer/store/setting': {
      appSetting,
      mergeSetting: patch => Object.assign(appSetting, patch),
      updateSetting: patch => saved.push(patch),
    },
  }).default
  const scope = vue.effectScope()
  try {
    const controls = scope.run(() => component.setup())
    const [navigation, title, playlists] = fonts.SIDEBAR_FONT_SETTINGS
    controls.setSize(navigation, '18')
    assert.equal(appSetting[navigation.key], 18)
    assert.equal(appSetting[title.key], 12)
    assert.equal(appSetting[playlists.key], 13)
    assert.deepEqual(saved.at(-1), { [navigation.key]: 18 })
    controls.inputs[title.id] = ''
    controls.setSize(title, '')
    assert.equal(controls.inputs[title.id], 12)
    controls.setSize(playlists, 40)
    assert.equal(appSetting[playlists.key], 24)
    controls.resetSize(navigation)
    assert.equal(appSetting[navigation.key], 13)
    assert.equal(appSetting[playlists.key], 24)
    appSetting[title.key] = 21
    await vue.nextTick()
    assert.equal(controls.inputs[title.id], 21)
  } finally {
    scope.stop()
  }
})
