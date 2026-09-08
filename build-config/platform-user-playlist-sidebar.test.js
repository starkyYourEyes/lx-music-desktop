const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')
const { compile } = require('@vue/compiler-dom')
const { compileStyleAsync, parse } = require('@vue/compiler-sfc')
const { createSSRApp } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const postcss = require('postcss')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const compileSidebar = async() => {
  const filename = path.join(root, 'src/renderer/views/List/MyList/index.vue')
  const { descriptor } = parse(fs.readFileSync(filename, 'utf8'), { filename })
  const style = await compileStyleAsync({
    source: descriptor.styles[0].content.replace('@renderer/', `${path.join(root, 'src/renderer').replaceAll('\\', '/')}/`),
    filename,
    id: 'platform-sidebar-test',
    modules: true,
    preprocessLang: 'less',
  })
  assert.deepEqual(style.errors, [])
  const template = compile(descriptor.template.content, { mode: 'function' }).code
  const render = vm.runInNewContext(`(function(Vue) { ${template} })`)(require('vue'))
  return { render, modules: style.modules, stylesheet: postcss.parse(style.code) }
}

const walkNodes = (node, predicate, matches = []) => {
  if (Array.isArray(node)) node.forEach(item => walkNodes(item, predicate, matches))
  else if (node && typeof node == 'object') {
    if (predicate(node)) matches.push(node)
    if (Array.isArray(node.children)) walkNodes(node.children, predicate, matches)
  }
  return matches
}

const renderSidebar = async(compiled, groups) => {
  const retries = []
  const context = {
    $style: compiled.modules,
    $t: (key, values = {}) => (JSON.parse(read('src/lang/en-us.json'))[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => values[name] ?? `{${name}}`),
    $refs: {},
    appSetting: {},
    isMounted: false,
    listSidebarStyle: {},
    isModDown: false,
    listId: '',
    rightClickItemId: null,
    fetchingListStatus: {},
    loveList: { id: 'love', name: 'Love' },
    groups: { mine: { lists: [], count: 0 }, external: { lists: [], count: 0 } },
    collapsed: { mine: true, external: true },
    getListCover: () => '',
    handleListsItemRigthClick: () => {},
    handleFavoritesRightClick: () => {},
    handleListToggle: () => {},
    handleSaveListName: () => {},
    isShowNewList: false,
    isNewListLeave: false,
    handleCreateList: () => {},
    handleShowNewList: () => {},
    isShowListUpdateModal: false,
    isShowListSortModal: false,
    sortListInfo: null,
    isShowDuplicateMusicModal: false,
    duplicateListInfo: null,
    isShowMenu: false,
    menus: [],
    menuLocation: { x: 0, y: 0 },
    handleMenuClick: () => {},
    toggle: () => {},
    platformProviders: ['netease'],
    platformKinds: ['created', 'collected'],
    platformCollapsed: { netease: false },
    platformKindCollapsed: {},
    platformProviderVisible: () => true,
    platformProviderCount: () => groups.reduce((sum, group) => sum + group.lists.length, 0),
    togglePlatform: () => {},
    togglePlatformKind: () => {},
    platformGroup: (provider, kind) => groups.find(group => group.provider == provider && group.kind == kind),
    getPlatformPlaylistFailure: id => groups.flatMap(group => group.failures ?? []).find(failure => failure.listId == id),
    retryPlatformGroup: (provider, kind) => retries.push([provider, kind]),
  }
  let tree
  const app = createSSRApp({ render: () => { tree = compiled.render.call(context, context, []); return tree } })
  for (const name of ['base-input', 'base-menu', 'DuplicateMusicModal', 'ListSortModal', 'ListUpdateModal']) app.component(name, { render: () => null })
  const html = await renderToString(app)
  return { tree, html, retries }
}

test('compiled platform status binds its layout, preserves error details and retries the selected section', async() => {
  const compiled = await compileSidebar()
  const group = { provider: 'netease', kind: 'created', accountKey: '1', status: 'error', lists: [], errorMessage: 'User playlist request failed: upstream response 503' }
  const { tree, retries } = await renderSidebar(compiled, [group])
  assert.ok(compiled.modules.platformSection, 'platform subsection needs an applied CSS Module layout')
  const section = walkNodes(tree, node => node.props?.class == compiled.modules.platformSection)[0]
  assert.ok(section, 'platform subsection must bind the compiled CSS Module class')
  const row = walkNodes(section, node => node.props?.class == compiled.modules.platformStatusRow)[0]
  assert.ok(row, 'status must occupy its own row below the section heading')
  const status = walkNodes(row, node => node.props?.class == compiled.modules.platformStatus)[0]
  assert.equal(status.props.title, group.errorMessage)
  const button = walkNodes(row, node => node.type == 'button')[0]
  assert.equal(button.props['aria-label'], 'Retry')
  assert.equal(walkNodes(button, node => node.type == 'use')[0].props['xlink:href'], '#icon-refresh')
  button.props.onClick()
  assert.deepEqual(retries, [['netease', 'created']])
  const rules = {}
  compiled.stylesheet.walkRules(rule => {
    rules[rule.selector] = Object.fromEntries(rule.nodes.filter(node => node.type == 'decl').map(node => [node.prop, node.value]))
  })
  assert.equal(rules[`.${compiled.modules.platformStatusRow}`].display, 'flex')
  assert.equal(rules[`.${compiled.modules.platformStatus}`]['min-width'], '0')
  assert.equal(rules[`.${compiled.modules.platformStatus}`]['text-overflow'], 'ellipsis')
  assert.equal(rules[`.${compiled.modules.platformRetry}`].flex, 'none')
})

test('empty ready sections are visible and disabled groups omitted by the store stay hidden', async() => {
  const compiled = await compileSidebar()
  const { tree, html } = await renderSidebar(compiled, [{ provider: 'netease', kind: 'created', accountKey: '1', status: 'ready', lists: [] }])
  assert.match(html, /No playlists/)
  assert.match(html, /Created by me/)
  assert.doesNotMatch(html, /Collected by me/)
  assert.equal(walkNodes(tree, node => node.props?.class == compiled.modules.platformRetry).length, 0)
})

test('partial song sync keeps the directory count, marks only failed playlists and preserves the failure reason', async() => {
  const compiled = await compileSidebar()
  const lists = [{ id: 'platform:netease:1:collected:1', sourceListId: '1', name: 'Working' }, { id: 'platform:netease:1:collected:2', sourceListId: '2', name: 'Private' }]
  const failures = [{ listId: lists[1].id, sourceListId: '2', name: 'Private', kind: 'collected', message: 'Access denied (401)', hasCache: false }]
  const { tree, html, retries } = await renderSidebar(compiled, [{ provider: 'netease', kind: 'collected', accountKey: '1', status: 'partial', lists, failures }])
  assert.match(html, /Song sync failed for 1 playlist/)
  assert.doesNotMatch(html, /Playlist directory refresh failed/)
  assert.match(html, /Songs unavailable/)
  const heading = walkNodes(tree, node => node.props?.['data-platform-kind'] == 'netease:collected')[0]
  assert.equal(walkNodes(heading, node => node.props?.class == compiled.modules.groupCount)[0].children, '2')
  const warnings = walkNodes(tree, node => node.props?.['data-playlist-sync-error'])
  assert.equal(warnings.length, 1)
  assert.equal(warnings[0].props['data-playlist-sync-error'], lists[1].id)
  assert.match(warnings[0].props.title, /Private.*Access denied \(401\)/s)
  assert.match(warnings[0].props.title, /Playlist ID: 2/)
  const retry = walkNodes(tree, node => node.type == 'button' && node.props?.['aria-label'] == 'Retry failed playlists')[0]
  assert.ok(retry)
  retry.props.onClick()
  assert.deepEqual(retries, [['netease', 'collected']])
})

test('a failed song refresh with cached songs does not mark the playlist unavailable', async() => {
  const compiled = await compileSidebar()
  const list = { id: 'platform:netease:1:created:1', sourceListId: '1', name: 'Cached' }
  const { html } = await renderSidebar(compiled, [{ provider: 'netease', kind: 'created', accountKey: '1', status: 'partial', lists: [list], failures: [{ listId: list.id, message: 'Offline', hasCache: true }] }])
  assert.match(html, /Song sync failed for 1 playlist/)
  assert.doesNotMatch(html, /Songs unavailable/)
})

test('sidebar renders provider groups and both playlist kinds', () => {
  const source = read('src/renderer/views/List/MyList/index.vue')
  assert.match(source, /v-for="provider in platformProviders"/)
  assert.match(source, /v-for="kind in platformKinds"/)
  assert.match(source, /platform_playlist__import_\$\{provider\}/)
  assert.match(source, /platform_playlist__kind_\$\{kind\}/)
  assert.match(source, /platform_playlist__retry/)
})

test('managed list menu disables local mutations while keeping source actions', () => {
  const source = read('src/renderer/views/List/MyList/useMenu.js')
  assert.match(source, /menuControl\.rename = !isManaged/)
  assert.match(source, /menuControl\.remove = !isManaged/)
  assert.match(source, /menuControl\.sync = !!source/)
  assert.match(source, /menuControl\.sourceDetail = assertSupportDetail/)
})
