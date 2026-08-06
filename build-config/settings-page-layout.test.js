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
