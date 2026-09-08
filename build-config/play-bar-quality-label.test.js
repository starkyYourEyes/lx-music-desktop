const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { compileStyleAsync, parse } = require('@vue/compiler-sfc')
const { createRenderer, createSSRApp, h, ref } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const less = require('less')
const postcss = require('postcss')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const modernBarPath = path.join(root, 'src/renderer/components/layout/PlayBar/ModernBar.vue')
const globalStylePath = path.join(root, 'src/renderer/assets/styles/index.less')
const styleProxy = new Proxy({}, { get: (_, property) => String(property) })
const emptyComponent = { render: () => null }
const loadPlayBarLayout = () => loadTsModule(path.join(root, 'src/common/utils/playBarLayout.ts'))

const createState = ({ quality = null } = {}) => ({
  musicInfo: ref({ name: 'Copyable Song', singer: 'Copyable Singer', pic: null }),
  currentPlaybackQuality: ref(quality),
  isShowPlayerDetail: ref(false),
  isPlay: ref(false),
  playInfo: { playIndex: -1 },
  playMusicInfo: { listId: null, musicInfo: null },
  statusText: ref(''),
})

const loadModernBar = (state, clipboardCalls) => loadVueSfc(modernBarPath, {
  '@common/utils/vueTools': require('vue'),
  '@common/utils/vueRouter': { useRouter: () => ({ push() {} }) },
  '@common/utils/electron': { clipboardWriteText: value => clipboardCalls.push(value) },
  './ControlBtns.vue': emptyComponent,
  './PlayProgress.vue': emptyComponent,
  '../PlayQueue.vue': emptyComponent,
  '@renderer/utils/compositions/usePlayProgress': () => ({
    nowPlayTimeStr: ref('00:00'),
    maxPlayTimeStr: ref('00:00'),
    progress: ref(0),
    isActiveTransition: ref(false),
    handleTransitionEnd() {},
  }),
  '@renderer/store/player/state': state,
  '@renderer/store/setting': { appSetting: { 'common.playBarHeight': 74 } },
  '@renderer/store/player/action': { setMusicInfo() {}, setShowPlayerDetail() {} },
  '@renderer/core/player': { togglePlay() {}, playNext() {}, playPrev() {} },
  '@common/constants': { LIST_IDS: { DOWNLOAD: 'download' } },
  '@renderer/store/party': { party: { room: null, isShowModal: false } },
  '@renderer/store/privateFm/state': { isPrivateFmMode: ref(false) },
  '@renderer/utils/ipc': { trashNeteasePrivateFmMusic: async() => {} },
  '@common/utils/playBarLayout': loadPlayBarLayout(),
}).default

const configureApp = app => {
  app.config.globalProperties.$style = styleProxy
  app.config.globalProperties.$t = key => key
  app.component('CommonProgressBar', emptyComponent)
  app.component('ControlBtns', emptyComponent)
  app.component('PlayProgress', emptyComponent)
  app.component('PlayQueue', emptyComponent)
  return app
}

const renderPlayBar = async({ quality, progressStyle }) => {
  const clipboardCalls = []
  const state = createState({ quality })
  const ModernBar = loadModernBar(state, clipboardCalls)
  const app = configureApp(createSSRApp({ render: () => h(ModernBar, { progressStyle }) }))
  return { html: await renderToString(app), clipboardCalls, ModernBar, state }
}

const createNode = type => ({ type, props: {}, children: [], parent: null })
const createPlayBarMount = ({ quality = 'flac', progressStyle = 'full' } = {}) => {
  const clipboardCalls = []
  const state = createState({ quality })
  const ModernBar = loadModernBar(state, clipboardCalls)
  const renderer = createRenderer({
    createElement: createNode,
    createText: text => ({ type: '#text', text, parent: null }),
    createComment: text => ({ type: '#comment', text, parent: null }),
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.children = [{ type: '#text', text, parent: node }] },
    patchProp: (node, key, _, value) => { node.props[key] = value },
    insert: (node, parent, anchor) => {
      node.parent = parent
      if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, node)
      else parent.children.push(node)
    },
    remove: node => node.parent?.children.splice(node.parent.children.indexOf(node), 1),
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
  })
  const app = configureApp(renderer.createApp({ render: () => h(ModernBar, { progressStyle }) }))
  const container = createNode('#root')
  app.mount(container)
  return { app, clipboardCalls, container }
}

const findNode = (node, predicate) => {
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, predicate)
    if (found) return found
  }
  return null
}

const compilePlayBarStyle = async() => {
  class RendererAliasFileManager extends less.FileManager {
    supports(filename) { return filename.startsWith('@renderer/') }

    loadFile(filename, currentDirectory, options, environment) {
      return super.loadFile(path.join(root, 'src/renderer', filename.slice('@renderer/'.length)), '', options, environment)
    }
  }
  const source = fs.readFileSync(modernBarPath, 'utf8')
  const { descriptor, errors } = parse(source, { filename: modernBarPath })
  assert.deepEqual(errors, [])
  const style = descriptor.styles.find(styleBlock => styleBlock.module)
  assert.ok(style, 'ModernBar must expose a CSS Modules style block')
  const result = await compileStyleAsync({
    filename: modernBarPath,
    source: style.content,
    id: 'data-v-play-bar-quality-contract',
    modules: true,
    preprocessLang: style.lang,
    preprocessOptions: {
      plugins: [{ install(_, manager) { manager.addFileManager(new RendererAliasFileManager()) } }],
    },
  })
  assert.deepEqual(result.errors, [])
  return { modules: result.modules, stylesheet: postcss.parse(result.code) }
}

const compileGlobalStyles = async() => {
  const source = fs.readFileSync(globalStylePath, 'utf8')
  const result = await less.render(source, { filename: globalStylePath })
  return postcss.parse(result.css)
}

const assertDeclarations = (stylesheet, selector, expected) => {
  const rule = stylesheet.nodes.find(node => node.type == 'rule' && node.selector == selector)
  assert.ok(rule, `missing ${selector} rule`)
  const declarations = Object.fromEntries(rule.nodes.map(node => [node.prop, node.value]))
  for (const [property, value] of Object.entries(expected)) assert.equal(declarations[property], value, `${selector} ${property}`)
  return declarations
}

const qualities = ['128k', '192k', '320k', 'flac', 'flac24bit', 'ape', 'wav']

for (const quality of qualities) {
  test(`play bar renders raw quality ${quality}`, async() => {
    const { html } = await renderPlayBar({ quality, progressStyle: 'full' })
    assert.match(html, new RegExp(`class="badge badge-theme-primary quality"[^>]*>${quality}</span>`))
  })
}

test('play bar hides an empty quality and all progress styles share ModernBar markup', async() => {
  const empty = await renderPlayBar({ quality: null, progressStyle: 'full' })
  assert.doesNotMatch(empty.html, /class="quality"/)
  for (const progressStyle of ['full', 'middle', 'mini']) {
    const { html } = await renderPlayBar({ quality: 'flac', progressStyle })
    assert.match(html, /class="titleRow"/)
    assert.match(html, /class="badge badge-theme-primary quality"[^>]*>flac</)
  }
})

test('only the title copies the song name while the quality remains passive metadata', () => {
  const mounted = createPlayBarMount()
  const title = findNode(mounted.container, node => node.props?.class == 'title')
  const quality = findNode(mounted.container, node => node.props?.class?.split(/\s+/).includes('quality'))
  assert.ok(title)
  assert.ok(quality)
  assert.equal(title.parent, quality.parent)
  assert.equal(typeof title.props.onClick, 'function')
  assert.equal(quality.props.onClick, undefined)
  title.props.onClick()
  assert.deepEqual(mounted.clipboardCalls, ['Copyable Song'])
  assert.equal(quality.props.onClick, undefined)
  mounted.app.unmount()
})

test('play bar compiles flex title and passive quality label styling', async() => {
  const { modules, stylesheet } = await compilePlayBarStyle()
  assertDeclarations(stylesheet, `.${modules.titleRow}`, {
    display: 'flex',
    'align-items': 'baseline',
    width: '100%',
    'min-width': '0',
  })
  assertDeclarations(stylesheet, `.${modules.title}`, {
    flex: '1 1 auto',
    'min-width': '0',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
  })
  const quality = assertDeclarations(stylesheet, `.${modules.quality}`, {
    flex: 'none',
    'font-size': '0.8em',
    opacity: '0.75',
  })
  for (const property of ['padding', 'color', 'white-space', 'background', 'background-color', 'border', 'border-radius']) {
    assert.equal(quality[property], undefined)
  }

  const globalStylesheet = await compileGlobalStyles()
  assertDeclarations(globalStylesheet, '.badge', {
    display: 'inline-block',
    padding: '0.05em 0.25em',
    'line-height': '1.05',
    'white-space': 'nowrap',
    'background-color': 'transparent',
    border: '1Px solid currentColor',
    'border-radius': '3px',
  })

  stylesheet.walkAtRules('media', mediaRule => {
    mediaRule.walkRules(rule => assert.equal(rule.selector.includes(`.${modules.quality}`), false, 'media queries must not hide quality'))
  })
  const player = assertDeclarations(stylesheet, `.${modules.player}`, { height: 'var(--play-bar-height)' })
  assert.equal(player.height, 'var(--play-bar-height)', 'quality styling must preserve configurable player height')
})
