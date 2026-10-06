const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { compileStyleAsync, parse } = require('@vue/compiler-sfc')
const vue = require('vue')
const { createRenderer, createSSRApp, h, nextTick, reactive, ref } = vue
const { renderToString } = require('@vue/server-renderer')
const less = require('less')
const postcss = require('postcss')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const navBarPath = path.join(root, 'src/renderer/components/layout/Aside/NavBar.vue')
const styleProxy = new Proxy({}, { get: (_, property) => String(property) })
const createNode = type => ({ type, props: {}, children: [], parent: null })
const renderer = createRenderer({
  createElement: createNode,
  createText: text => ({ type: '#text', text, parent: null }),
  createComment: text => ({ type: '#comment', text, parent: null }),
  setText: (node, text) => { node.text = text },
  setElementText: (node, text) => { node.children = [{ type: '#text', text, parent: node }] },
  patchProp: (node, key, previous, value) => { node.props[key] = value },
  insert: (node, parent, anchor) => {
    node.parent = parent
    if (anchor) parent.children.splice(parent.children.indexOf(anchor), 0, node)
    else parent.children.push(node)
  },
  remove: node => node.parent?.children.splice(node.parent.children.indexOf(node), 1),
  parentNode: node => node.parent,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1],
})

const findNode = (node, predicate) => {
  if (predicate(node)) return node
  for (const child of node.children ?? []) {
    const match = findNode(child, predicate)
    if (match) return match
  }
  return null
}

class RendererAliasFileManager extends less.FileManager {
  supports(filename) {
    return filename.startsWith('@renderer/')
  }

  loadFile(filename, currentDirectory, options, environment) {
    return super.loadFile(
      path.join(root, 'src/renderer', filename.slice('@renderer/'.length)),
      '',
      options,
      environment,
    )
  }
}

const compileNavBarStyle = async() => {
  const source = fs.readFileSync(navBarPath, 'utf8')
  const { descriptor, errors } = parse(source, { filename: navBarPath })
  assert.deepEqual(errors, [])
  const style = descriptor.styles.find(block => block.module)
  assert.ok(style)
  const result = await compileStyleAsync({
    filename: navBarPath,
    source: style.content,
    id: 'data-v-sidebar-navigation',
    modules: true,
    preprocessLang: style.lang,
    preprocessOptions: {
      plugins: [{ install(_, manager) { manager.addFileManager(new RendererAliasFileManager()) } }],
    },
  })
  assert.deepEqual(result.errors, [])
  return { modules: result.modules, stylesheet: postcss.parse(result.code) }
}

const renderNavBar = async(settingOverrides = {}, route = { path: '/recommend', meta: { name: 'Recommend' }, query: {} }) => {
  const appSetting = reactive({
    'download.enable': true,
    'common.isShowSidebarScrollbar': true,
    'common.sidebarSettingLocation': 'bottom',
    ...settingOverrides,
  })
  const NavBar = loadVueSfc(navBarPath, {
    '@common/performance/featurePolicy': loadTsModule(path.join(root, 'src/common/performance/featurePolicy.ts')),
    '@renderer/store/setting': { appSetting },
    '@root/lang': { useI18n: () => key => key },
    '@common/utils/vueTools': require('vue'),
    '@common/utils/vueRouter': { useRoute: () => route },
    '@common/constants': { LIST_IDS: { LOVE: 'love' } },
    '@renderer/assets/images/providers/netease-music.svg': 'netease.svg',
    '@renderer/assets/images/providers/qq-music.svg': 'qq.svg',
    '@renderer/assets/images/providers/kugou-music.svg': 'kugou.svg',
    '@renderer/views/List/MyList/index.vue': {
      props: ['listId'],
      setup: props => () => h('div', { 'data-active-playlist': props.listId }),
    },
  }).default
  const RouterLink = {
    props: ['to'],
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }
  const app = createSSRApp({ render: () => h(NavBar) })
  app.config.globalProperties.$style = styleProxy
  app.config.globalProperties.$route = route
  app.component('RouterLink', RouterLink)
  return renderToString(app)
}

test('main navigation scrolls while the bottom Settings region stays fixed', async() => {
  const { modules, stylesheet } = await compileNavBarStyle()
  const declarationsFor = className => {
    const declarations = {}
    stylesheet.walkRules(`.${modules[className]}`, rule => {
      rule.walkDecls(declaration => { declarations[declaration.prop] = declaration.value })
    })
    return declarations
  }

  assert.deepEqual(declarationsFor('mainMenus'), {
    flex: '0 1 auto',
    'min-height': '0',
    'overflow-y': 'auto',
  })
  assert.equal(declarationsFor('bottomMenus').flex, 'none')

  const hiddenRule = stylesheet.nodes.find(node =>
    node.type == 'rule' && node.selector.endsWith(`.${modules.scrollbarHidden}::-webkit-scrollbar`))
  assert.ok(hiddenRule)
  assert.equal(
    hiddenRule.selector,
    `.${modules.mainMenus}.${modules.scrollbarHidden}::-webkit-scrollbar`,
    'the hidden rule must outrank the later global .scroll scrollbar rule',
  )
  assert.equal(
    Object.fromEntries(hiddenRule.nodes.map(node => [node.prop, node.value])).width,
    '0',
  )
})

test('navigation renders one Settings entry and toggles only scrollbar visuals', async() => {
  const bottom = await renderNavBar()
  assert.match(bottom, /class="scroll mainMenus"/)
  assert.match(bottom, /href="\/setting"/)

  const accountMenu = await renderNavBar({ 'common.sidebarSettingLocation': 'accountMenu' })
  assert.doesNotMatch(accountMenu, /href="\/setting"/)

  const invalid = await renderNavBar({ 'common.sidebarSettingLocation': 'invalid' })
  assert.match(invalid, /href="\/setting"/)

  const hidden = await renderNavBar({ 'common.isShowSidebarScrollbar': false })
  assert.match(hidden, /class="scroll mainMenus scrollbarHidden"/)
})

test('navigation delegates playlist selection without duplicating the fixed Favorites entry', async() => {
  const favorites = await renderNavBar({}, { path: '/list', meta: { name: 'List' }, query: { id: 'love' } })
  assert.doesNotMatch(favorites, /href="\/list\?id=love"/)
  assert.doesNotMatch(favorites, />sidebar_favorites<\/span>/)
  assert.match(favorites, /data-active-playlist="love"/)
  const custom = await renderNavBar({}, { path: '/list', meta: { name: 'List' }, query: { id: 'custom' } })
  assert.doesNotMatch(custom, /href="\/list\?id=love"[^>]*class="[^"]*active[^"]*"/)
  assert.match(custom, /data-active-playlist="custom"/)
  const otherPage = await renderNavBar({}, { path: '/recommend', meta: { name: 'Recommend' }, query: { id: 'remote-list' } })
  assert.match(otherPage, /data-active-playlist(?:="")?>/)
})

test('left window controls keep the avatar and account-menu Settings action navigates', async() => {
  const asidePath = path.join(root, 'src/renderer/components/layout/Aside/index.vue')
  const pushes = []
  const listeners = new Map()
  global.window = {
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: name => listeners.delete(name),
    dispatchEvent() {},
  }
  const appSetting = reactive({
    'common.controlBtnPosition': 'left',
    'common.sidebarSettingLocation': 'accountMenu',
  })
  const ControlBtns = { render: () => h('div', { 'data-test': 'window-controls' }) }
  const NavBar = { render: () => h('div', { 'data-test': 'navigation' }) }
  const Transition = {
    inheritAttrs: false,
    props: ['enterActiveClass', 'leaveActiveClass'],
    setup: (props, { slots }) => () => slots.default?.(),
  }
  const Aside = loadVueSfc(asidePath, {
    '@common/performance/featurePolicy': loadTsModule(path.join(root, 'src/common/performance/featurePolicy.ts')),
    '@common/utils/sidebarFontSize': loadTsModule(path.join(root, 'src/common/utils/sidebarFontSize.ts')),
    '@renderer/store/platformPlaylists/action': { refreshPlatformUserPlaylists: async() => {} },
    vue: { ...vue, Transition },
    '@common/utils/vueTools': vue,
    '@common/utils/vueRouter': {
      useRoute: () => ({ path: '/recommend' }),
      useRouter: () => ({ push: route => { pushes.push(route); return Promise.resolve() } }),
    },
    '@renderer/store': { isFullscreen: ref(false) },
    '@renderer/store/setting': { appSetting },
    '@renderer/store/netease': {
      initNeteaseAccount: async() => {},
      isLoggedIn: ref(false),
      logoutNeteaseAccount: async() => {},
      profile: ref(null),
    },
    '@renderer/store/qqMusic': {
      initQQMusicAccount: async() => {},
      isLoggedIn: ref(false),
      logoutQQMusicAccount: async() => {},
      profile: ref(null),
    },
    '@renderer/store/kugouMusic': {
      initKugouMusicAccount: async() => {},
      isLoggedIn: ref(false),
      logoutKugouMusicAccount: async() => {},
      profile: ref(null),
    },
    './ControlBtns.vue': ControlBtns,
    './NavBar.vue': NavBar,
  }).default
  const app = renderer.createApp({ render: () => h(Aside) })
  app.config.globalProperties.$style = styleProxy
  app.config.globalProperties.$t = key => key
  const container = createNode('#root')
  app.mount(container)

  const aside = findNode(container, node => node.props?.style?.['--sidebar-scale'])
  assert.equal(aside.props.style['--sidebar-navigation-font-size'], '13px')
  appSetting['common.sidebarNavigationFontSize'] = 18
  appSetting['common.sidebarTitleFontSize'] = 16
  appSetting['common.sidebarPlaylistFontSize'] = 20
  appSetting['list.myListSidebarScale'] = 130
  await nextTick()
  assert.equal(aside.props.style['--sidebar-navigation-font-size'], '18px')
  assert.equal(aside.props.style['--sidebar-title-font-size'], '16px')
  assert.equal(aside.props.style['--sidebar-playlist-font-size'], '20px')

  assert.ok(findNode(container, node => node.props?.['data-test'] == 'window-controls'))
  const avatar = findNode(container, node =>
    node.type == 'button' && node.props?.['aria-label'] == 'LX Music')
  assert.ok(avatar)
  avatar.props.onClick()
  await nextTick()

  let settingsAction = findNode(container, node =>
    String(node.props?.class ?? '').split(' ').includes('settingsAction'))
  assert.ok(settingsAction)
  appSetting['common.sidebarSettingLocation'] = 'bottom'
  await nextTick()
  assert.equal(findNode(container, node =>
    String(node.props?.class ?? '').split(' ').includes('settingsAction')), null)

  appSetting['common.sidebarSettingLocation'] = 'accountMenu'
  await nextTick()
  settingsAction = findNode(container, node =>
    String(node.props?.class ?? '').split(' ').includes('settingsAction'))
  assert.ok(settingsAction)
  settingsAction.props.onClick()
  await nextTick()
  assert.deepEqual(pushes, ['/setting'])
  assert.equal(findNode(container, node =>
    String(node.props?.class ?? '').split(' ').includes('settingsAction')), null)

  app.unmount()
  assert.equal(listeners.size, 0)
})
