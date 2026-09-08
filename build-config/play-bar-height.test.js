const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { compileStyleAsync, parse } = require('@vue/compiler-sfc')
const less = require('less')
const postcss = require('postcss')
const vue = require('vue')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const modernBarPath = path.join(root, 'src/renderer/components/layout/PlayBar/ModernBar.vue')
const loadLayout = () => loadTsModule(path.join(root, 'src/common/utils/playBarLayout.ts'))

const loadModernBar = appSetting => loadVueSfc(modernBarPath, {
  '@common/utils/vueTools': vue,
  '@common/utils/vueRouter': { useRouter: () => ({ push: async() => {} }) },
  '@common/utils/electron': { clipboardWriteText() {} },
  './ControlBtns.vue': {},
  './PlayProgress.vue': {},
  '../PlayQueue.vue': {},
  '@renderer/utils/compositions/usePlayProgress': {
    __esModule: true,
    default: () => ({
      nowPlayTimeStr: vue.ref('00:00'),
      maxPlayTimeStr: vue.ref('00:00'),
      progress: vue.ref(0),
      isActiveTransition: vue.ref(false),
      handleTransitionEnd() {},
    }),
  },
  '@renderer/store/player/state': {
    statusText: vue.ref(''),
    musicInfo: vue.reactive({ pic: null, name: '', singer: '' }),
    isShowPlayerDetail: vue.ref(false),
    isPlay: vue.ref(false),
    playInfo: vue.reactive({ playIndex: -1 }),
    playMusicInfo: vue.reactive({ musicInfo: null, listId: null }),
  },
  '@renderer/store/player/action': { setMusicInfo() {}, setShowPlayerDetail() {} },
  '@renderer/core/player': { togglePlay() {}, playNext: async() => {}, playPrev() {} },
  '@common/constants': { LIST_IDS: { DOWNLOAD: 'download' } },
  '@renderer/store/party': { party: vue.reactive({ room: null, isShowModal: false }) },
  '@renderer/store/privateFm/state': { isPrivateFmMode: vue.ref(false) },
  '@renderer/utils/ipc': { trashNeteasePrivateFmMusic: async() => {} },
  '@renderer/store/setting': { appSetting },
  '@common/utils/playBarLayout': loadLayout(),
}).default

const compileModernBarStyle = async() => {
  class RendererAliasFileManager extends less.FileManager {
    supports(filename) {
      return filename.startsWith('@renderer/')
    }

    loadFile(filename, currentDirectory, options, environment) {
      const resolvedPath = path.join(root, 'src/renderer', filename.slice('@renderer/'.length))
      return super.loadFile(resolvedPath, '', options, environment)
    }
  }

  const source = fs.readFileSync(modernBarPath, 'utf8')
  const { descriptor, errors } = parse(source, { filename: modernBarPath })
  assert.deepEqual(errors, [])
  const style = descriptor.styles.find(styleBlock => styleBlock.module)
  assert.ok(style)
  const result = await compileStyleAsync({
    filename: modernBarPath,
    source: style.content,
    id: 'data-v-play-bar-height',
    modules: true,
    preprocessLang: style.lang,
    preprocessOptions: {
      plugins: [{ install: (_, manager) => manager.addFileManager(new RendererAliasFileManager()) }],
    },
  })
  assert.deepEqual(result.errors, [])
  return { modules: result.modules, stylesheet: postcss.parse(result.code) }
}

test('play bar height normalization defaults, clamps, and rounds user input', () => {
  const { normalizePlayBarHeight } = loadLayout()

  assert.equal(normalizePlayBarHeight(undefined), 74)
  assert.equal(normalizePlayBarHeight(null), 74)
  assert.equal(normalizePlayBarHeight(''), 74)
  assert.equal(normalizePlayBarHeight('invalid'), 74)
  assert.equal(normalizePlayBarHeight(false), 74)
  assert.equal(normalizePlayBarHeight(true), 74)
  assert.equal(normalizePlayBarHeight([]), 74)
  assert.equal(normalizePlayBarHeight(55), 56)
  assert.equal(normalizePlayBarHeight(65.6), 66)
  assert.equal(normalizePlayBarHeight(75), 74)
})

test('play bar layout scales artwork and keeps it vertically centered', () => {
  const { getPlayBarLayout } = loadLayout()

  assert.deepEqual(getPlayBarLayout(56), { height: 56, artworkSize: 42, paddingY: 7 })
  assert.deepEqual(getPlayBarLayout(65), { height: 65, artworkSize: 48, paddingY: 8.5 })
  assert.deepEqual(getPlayBarLayout(74), { height: 74, artworkSize: 54, paddingY: 10 })
})

test('application settings preserve the existing 74px play bar by default', () => {
  const defaults = loadTsModule(path.join(root, 'src/common/defaultSetting.ts'), {
    './constants': { RECOMMEND_HOME_SECTION_IDS: [] },
    './projectIdentity': { PROJECT_IDENTITY: { defaultWebdavUrl: '' } },
    './utils/playBarLayout': loadLayout(),
    './utils/backgroundTransparency': { BACKGROUND_TRANSPARENCY_DEFAULT: 40 },
  }).default

  assert.equal(defaults['common.playBarHeight'], 74)
})

test('ModernBar reacts to the configured height with matching artwork metrics', () => {
  const appSetting = vue.reactive({ 'common.playBarHeight': 74 })
  const { playBarStyle } = loadModernBar(appSetting).setup()

  assert.deepEqual(playBarStyle.value, {
    '--play-bar-height': '74px',
    '--play-bar-artwork-size': '54px',
    '--play-bar-padding-y': '10px',
  })

  appSetting['common.playBarHeight'] = 56
  assert.deepEqual(playBarStyle.value, {
    '--play-bar-height': '56px',
    '--play-bar-artwork-size': '42px',
    '--play-bar-padding-y': '7px',
  })
})

test('ModernBar compiled styles consume the responsive layout variables', async() => {
  const { modules, stylesheet } = await compileModernBarStyle()
  const declarationsFor = className => {
    const declarations = {}
    stylesheet.walkRules(`.${modules[className]}`, rule => {
      rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
    })
    return declarations
  }

  const player = declarationsFor('player')
  assert.equal(player.height, 'var(--play-bar-height)')
  assert.equal(player.padding, 'var(--play-bar-padding-y) 24px')

  const artwork = declarationsFor('picContent')
  assert.equal(artwork.width, 'var(--play-bar-artwork-size)')
  assert.equal(artwork.height, 'var(--play-bar-artwork-size)')
})

test('all progress styles continue to use the shared ModernBar layout', () => {
  const variants = [
    ['MiniWidthProgress.vue', 'mini'],
    ['MiddleWidthProgress.vue', 'middle'],
    ['FullWidthProgress.vue', 'full'],
  ]

  for (const [file, progressStyle] of variants) {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/layout/PlayBar', file),
      'utf8',
    )
    assert.match(source, new RegExp(`<modern-bar progress-style="${progressStyle}"`))
  }
})
