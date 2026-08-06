const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const babel = require('@babel/core')
const pug = require('pug')
const { parse } = require('@vue/compiler-sfc')

const root = path.resolve(__dirname, '..')

const readVue = relativePath => {
  const filename = path.join(root, relativePath)
  const source = fs.readFileSync(filename, 'utf8')
  const parsed = parse(source, { filename })
  assert.deepEqual(parsed.errors, [])
  return { filename, descriptor: parsed.descriptor }
}

const renderPugTemplate = relativePath => {
  const { filename, descriptor } = readVue(relativePath)
  assert(descriptor.template)
  assert.equal(descriptor.template.lang, 'pug')
  return pug.render(descriptor.template.content, { filename, pretty: true })
}

const loadVueComponent = (relativePath, mocks) => {
  const { filename, descriptor } = readVue(relativePath)
  assert(descriptor.script)
  const { code } = babel.transformSync(descriptor.script.content, {
    babelrc: false,
    configFile: false,
    filename: `${filename}.js`,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  })
  const loadedModule = new Module(filename, module)
  loadedModule.filename = filename
  loadedModule.paths = Module._nodeModulePaths(path.dirname(filename))
  const originalLoad = Module._load
  Module._load = (request, parent, isMain) => {
    if (Object.hasOwn(mocks, request)) return mocks[request]
    if (request.endsWith('.vue')) return {}
    return originalLoad(request, parent, isMain)
  }
  try {
    loadedModule._compile(code, filename)
  } finally {
    Module._load = originalLoad
  }
  return loadedModule.exports.default
}

const createComputed = getter => ({
  get value() { return getter() },
})

const getSettingsToc = () => {
  const component = loadVueComponent('src/renderer/views/Setting/index.vue', {
    '@common/utils/vueTools': {
      computed: createComputed,
      nextTick: callback => callback(),
      ref: value => ({ value }),
      watch() {},
    },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@common/utils/vueRouter': { useRoute: () => ({ query: {} }) },
  })
  return component.setup().tocList.value
}

const positionOf = (html, fragment) => {
  const position = html.indexOf(fragment)
  assert.notEqual(position, -1, `Expected rendered template to contain ${fragment}`)
  return position
}

test('search controls are the final visible card in Basic settings, not a top-level page', () => {
  const toc = getSettingsToc()
  assert.equal(toc.some(item => item.id == 'SettingSearch'), false)

  const searchHtml = renderPugTemplate('src/renderer/views/Setting/components/SettingSearch.vue')
  assert.match(searchHtml, /^\s*<dd>\s*<h3 id="search">/)

  const basicHtml = renderPugTemplate('src/renderer/views/Setting/components/SettingBasic.vue')
  assert(
    positionOf(basicHtml, '<SettingSearch>') > positionOf(basicHtml, 'id="basic_playbar_progress_style"'),
    'Search controls must follow the last existing Basic settings card',
  )
})

const loadSettingOther = () => loadVueComponent(
  'src/renderer/views/Setting/components/SettingOther.vue',
  {
    '@common/utils/vueTools': {
      computed: createComputed,
      ref: value => ({ value }),
    },
    '@renderer/utils/ipc': {
      clearCache() {},
      clearLyricEdited() {},
      clearLyricRaw() {},
      clearMusicUrl() {},
      clearOtherSource() {},
      getCacheSize: async() => 0,
      getLyricEditedCount: async() => 0,
      getLyricRawCount: async() => 0,
      getMusicUrlCount: async() => 0,
      getOtherSourceCount: async() => 0,
      getWebDAVCredentialStatus: async() => ({ configured: false, usernameHint: null, persistence: 'missing' }),
      removeWebDAVCredentials: async() => {},
      setWebDAVCredentials: async() => {},
      testWebDAV: async() => {},
    },
    '@common/utils/common': { sizeFormate: () => '0 B' },
    '@renderer/plugins/Dialog': { dialog: Object.assign(() => {}, { confirm: async() => false }) },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/store/setting': { appSetting: {}, updateSetting() {} },
    '@renderer/store/list/listManage': { overwriteListFull() {} },
    '@renderer/store/dislikeList': { dislikeRuleCount: { value: 0 } },
    '@common/constants': { TRAY_AUTO_ID: 3 },
    '@common/projectIdentity': { PROJECT_IDENTITY: { defaultWebdavUrl: '' } },
  },
)

test('ODC controls are the final Other card and list cleanup is not exposed', () => {
  const toc = getSettingsToc()
  assert.equal(toc.some(item => item.id == 'SettingOdc'), false)

  const odcHtml = renderPugTemplate('src/renderer/views/Setting/components/SettingOdc.vue')
  assert.match(odcHtml, /^\s*<dd>\s*<h3 id="odc">/)

  const otherHtml = renderPugTemplate('src/renderer/views/Setting/components/SettingOther.vue')
  assert(
    positionOf(otherHtml, '<SettingOdc>') > positionOf(otherHtml, 'setting__other_lyric_edited_cache'),
    'ODC controls must follow every remaining Other settings card',
  )
  assert.doesNotMatch(otherHtml, /setting__other_listdata/)
  assert.equal(Object.hasOwn(loadSettingOther().setup(), 'handleClearListData'), false)
})
