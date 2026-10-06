const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { app, BrowserWindow } = require('electron')
const { compileStyleAsync, parse } = require('@vue/compiler-sfc')
const { compile } = require('@vue/compiler-dom')

const root = path.resolve(__dirname, '../..')
const outputPath = process.argv[2]
app.setPath('userData', path.join(outputPath, 'profile'))

const compileComponent = async file => {
  const filename = path.join(root, file)
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const block = descriptor.styles[0]
  const result = await compileStyleAsync({
    filename,
    source: block.content.replaceAll('@renderer/', path.join(root, 'src/renderer').replaceAll('\\', '/') + '/'),
    id: 'sidebar-render-test',
    modules: !!block.module,
    preprocessLang: 'less',
  })
  if (result.errors.length) throw result.errors[0]
  return { ...result, template: descriptor.template.content }
}

// Mount the production sidebar template and styles with deterministic playlist data.
// Account/network services are unnecessary for testing Chromium's compositor.
const mountSidebar = (renderCode, styles) => {
  const { reactive, toRefs, createApp, h } = window.Vue
  const rows = (prefix, count) => Array.from({ length: count }, (_, i) => ({ id: prefix + i, name: `${prefix} ${i}` }))
  const state = reactive({
    collapsed: { mine: false, external: false },
    platformCollapsed: { netease: false, qq_music: false, kugou: false },
    platformKindCollapsed: {},
    appSetting: { 'common.isShowSidebarScrollbar': true },
  })
  const providers = ['netease', 'qq_music', 'kugou']
  const kinds = ['created', 'collected']
  const platformGroups = Object.fromEntries(providers.flatMap(provider => kinds.map(kind => [
    `${provider}:${kind}`, { accountKey: 'test', status: 'ready', lists: rows(`${provider}:${kind}`, 4) },
  ])))
  const noop = () => {}
  const context = {
    ...toRefs(state),
    isModDown: false,
    listId: 'external0',
    rightClickItemId: null,
    fetchingListStatus: {},
    loveList: { id: 'love', name: 'Favorites' },
    groups: { mine: { lists: rows('mine', 4), count: 4 }, external: { lists: rows('external', 8), count: 8 } },
    getListCover: () => '',
    handleListToggle: noop,
    handleFavoritesRightClick: noop,
    handleListsItemRigthClick: noop,
    handleSaveListName: noop,
    handleCreateList: noop,
    handleShowNewList: noop,
    isShowNewList: false,
    isNewListLeave: false,
    isShowListUpdateModal: false,
    isShowMenu: false,
    menus: [],
    menuLocation: { x: 0, y: 0 },
    handleMenuClick: noop,
    isMounted: false,
    platformProviders: providers,
    platformKinds: kinds,
    platformProviderVisible: () => true,
    platformProviderCount: () => 8,
    platformGroup: (p, k) => platformGroups[`${p}:${k}`],
    getPlatformPlaylistFailure: () => null,
    retryPlatformGroup: noop,
    toggle: group => { state.collapsed[group] = !state.collapsed[group] },
    togglePlatform: provider => { state.platformCollapsed[provider] = !state.platformCollapsed[provider] },
    togglePlatformKind: (p, k) => { state.platformKindCollapsed[`${p}:${k}`] = !state.platformKindCollapsed[`${p}:${k}`] },
  }
  // eslint-disable-next-line no-new-func
  const render = new Function('Vue', renderCode)(window.Vue)
  const instance = createApp({ setup: () => context, render })
  Object.assign(instance.config.globalProperties, { $style: styles, $t: key => key })
  instance.component('base-input', { render: () => h('input') })
  for (const name of ['base-menu', 'DuplicateMusicModal', 'ListSortModal', 'ListUpdateModal']) {
    instance.component(name, { render: () => null })
  }
  instance.mount('#sidebar')
  // Match MyList's position as a direct flex child of NavBar.
  const mount = document.querySelector('#sidebar')
  mount.replaceWith(mount.firstElementChild)
  window.setScrollbar = visible => { state.appSetting['common.isShowSidebarScrollbar'] = visible }
  window.measure = () => Object.fromEntries(['container', 'left', 'right', 'toolbar', 'view', 'player'].map(id => {
    const { x, y, width, height } = document.getElementById(id).getBoundingClientRect()
    return [id, { x, y, width, height }]
  }))
}

app.whenReady().then(async() => {
  const [layout, aside, nav, lists] = await Promise.all([
    'src/renderer/App.vue', 'src/renderer/components/layout/Aside/index.vue',
    'src/renderer/components/layout/Aside/NavBar.vue', 'src/renderer/views/List/MyList/index.vue',
  ].map(compileComponent))
  const renderCode = compile(lists.template, { mode: 'function', prefixIdentifiers: true }).code
  const htmlPath = path.join(outputPath, 'sidebar.html')
  fs.writeFileSync(htmlPath, `<!doctype html><html class="windows"><head><meta charset="utf-8">
    <style>${layout.code}\n${aside.code}\n${nav.code}\n${lists.code}
    :root { --sidebar-scale:1; --sidebar-gap:10px; --sidebar-title-font-size:14px; --sidebar-playlist-font-size:13px; --sidebar-tool-size:28px; --layout-background-opacity:.6; }
    #root { background-image:repeating-linear-gradient(45deg,#acdcbd 0 20px,#c1d9ef 20px 40px); }
    </style></head><body><div id="root"><div id="container">
    <div id="left" class="${aside.modules.aside}"><div class="${aside.modules.account}"><button class="${aside.modules.logo}">LX</button></div>
    <div class="${nav.modules.menu}"><div class="${nav.modules.mainMenus}" style="height:270px;flex:none">Navigation</div>
    <div id="sidebar"></div><div class="${nav.modules.bottomMenus}">Settings</div></div></div>
    <div id="right"><div id="toolbar" style="height:60px">Toolbar</div><div id="view" style="flex:1">Main content</div><div id="player" style="height:74px">Player</div></div>
    </div></div><script src="${pathToFileURL(require.resolve('vue/dist/vue.global.js')).href}"></script></body></html>`)
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { backgroundThrottling: false, offscreen: true },
  })
  await win.loadFile(htmlPath)
  await win.webContents.executeJavaScript(`(${mountSidebar.toString()})(${JSON.stringify(renderCode)}, ${JSON.stringify(lists.modules)})`)
  const debug = win.webContents.debugger
  debug.attach('1.3')
  let layers = []
  let paints = []
  debug.on('message', (_, method, params) => {
    if (method == 'LayerTree.layerTreeDidChange') layers = params.layers ?? []
    if (method == 'LayerTree.layerPainted') paints.push(params)
  })
  await debug.sendCommand('LayerTree.enable')
  const settle = async() => {
    await win.webContents.executeJavaScript(`(async() => {
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      await frame();
      await Promise.all(document.getAnimations()
        .filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime))
        .map(animation => animation.finished.catch(() => {})));
      await frame();
      await frame();
    })()`)
    await win.webContents.capturePage()
  }
  await settle()
  const { root: documentNode } = await debug.sendCommand('DOM.getDocument')
  const { nodeId } = await debug.sendCommand('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '#right' })
  const { node: rightNode } = await debug.sendCommand('DOM.describeNode', { nodeId })
  const groups = ['mine', 'external', ...['netease', 'qq_music', 'kugou'].flatMap(p => [`platform-${p}`, `${p}:created`, `${p}:collected`])]
  const results = []
  for (const scrollbar of [true, false]) {
    await win.webContents.executeJavaScript(`setScrollbar(${scrollbar})`)
    await settle()
    for (const group of groups) {
      const selector = group.includes(':') ? `[data-platform-kind="${group}"]` : `[data-group="${group}"] > li > button`
      await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`)
      await settle()
      for (let i = 0; i < 2; i++) {
        const mainLayer = layers.find(layer => layer.backendNodeId == rightNode.backendNodeId && layer.drawsContent)
        if (!mainLayer) throw new Error('Main page compositor layer was not observed')
        const before = await win.webContents.executeJavaScript('measure()')
        paints = []
        const [expandedBefore, expandedAfter] = await win.webContents.executeJavaScript(`(async() => {
          const heading=document.querySelector(${JSON.stringify(selector)});
          const before=heading.getAttribute('aria-expanded');heading.click();await Vue.nextTick();
          return [before,heading.getAttribute('aria-expanded')];
        })()`)
        await settle()
        results.push({
          group,
          scrollbar,
          expandedBefore,
          expandedAfter,
          before,
          after: await win.webContents.executeJavaScript('measure()'),
          sharedLayerPaints: paints.filter(paint => paint.layerId == mainLayer.layerId),
          paintCount: paints.length,
        })
      }
    }
  }
  fs.writeFileSync(path.join(outputPath, 'results.json'), JSON.stringify(results))
  win.destroy()
  app.quit()
}).catch(error => {
  console.error(error)
  app.exit(1)
})
