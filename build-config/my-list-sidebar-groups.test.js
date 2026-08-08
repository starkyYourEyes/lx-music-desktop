const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const groupStatePath = path.join(root, 'src/renderer/views/List/MyList/groupState.ts')
const groupActionsPath = path.join(root, 'src/renderer/views/List/MyList/groupActions.ts')
const useGroupsPath = path.join(root, 'src/renderer/views/List/MyList/useGroups.ts')
const useDargPath = path.join(root, 'src/renderer/views/List/MyList/useDarg.ts')
const useDragPath = path.join(root, 'src/renderer/utils/compositions/useDrag.js')
const myListPath = path.join(root, 'src/renderer/views/List/MyList/index.vue')

const moveList = id => ({ id, name: id })
const buildMoveOrder = (lists, groups, id, toGroup, toIndex) => {
  const moved = lists.find(item => item.id == id)
  const remaining = lists.filter(item => item.id != id)
  const mine = remaining.filter(item => groups[item.id] == 'mine')
  const external = remaining.filter(item => groups[item.id] == 'external')
  const target = toGroup == 'mine' ? mine : external
  target.splice(toIndex, 0, moved)
  return [...mine, ...external].map(item => item.id)
}

const createMoveHarness = overrides => {
  const lists = [moveList('mine'), moveList('external')]
  const groups = { mine: 'mine', external: 'external' }
  const { createMoveUserList } = loadTsModule(groupActionsPath, {
    '@common/listGroup': { buildMovedUserListOrder: buildMoveOrder },
    '@common/utils': { log: { error: () => {} } },
    '@renderer/store/list/action': { updateUserListPosition: async() => {}, getUserLists: async() => [] },
    '@renderer/store/list/state': { userLists: [] },
    '@renderer/store/list/group': { initializeUserListGroups: async() => {}, getUserListGroup: () => 'mine', setUserListGroup: async() => {} },
  })
  return createMoveUserList({
    readLists: () => lists,
    getGroup: item => groups[item.id],
    setGroup: async() => {},
    setOrder: async() => {},
    reload: async() => {},
    ...overrides,
  })
}

const normalizeClass = value => Array.isArray(value)
  ? value.map(normalizeClass).filter(Boolean).join(' ')
  : value && typeof value == 'object'
    ? Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name).join(' ')
    : value || ''
const vueRuntime = {
  Fragment: Symbol('Fragment'),
  Transition: Symbol('Transition'),
  createCommentVNode: () => null,
  createElementBlock: (type, props, children) => ({ type, props, children }),
  createElementVNode: (type, props, children) => ({ type, props, children }),
  createVNode: (type, props, children) => ({ type, props, children }),
  normalizeClass,
  normalizeStyle: value => value,
  openBlock: () => {},
  renderList: (values, render) => values.map(render),
  resolveComponent: name => name,
  toDisplayString: value => String(value),
  withCtx: callback => callback,
  withKeys: callback => callback,
}

const loadSidebarRender = () => loadVueSfc(myListPath, {
  vue: vueRuntime,
  '@common/utils/electron': { openUrl: () => {} },
  '@common/utils/common': { encodePath: value => value },
  '@renderer/utils/musicSdk': {},
  './components/DuplicateMusicModal.vue': {},
  './components/ListSortModal.vue': {},
  './components/ListUpdateModal.vue': {},
  '@renderer/store/list/state': { allMusicList: new Map(), loveList: { id: 'love', name: 'Love' }, userLists: [], fetchingListStatus: {} },
  '@renderer/store/list/action': { getListMusics: async() => [], removeUserList: async() => {} },
  '@renderer/store/setting': { appSetting: {} },
  '@common/utils/vueTools': { computed: () => ({ value: {} }), onBeforeUnmount: () => {}, ref: value => ({ value }), watch: () => {} },
  '@common/utils/vueRouter': { useRouter: () => ({ replace: async() => {} }) },
  '@common/constants': { LIST_IDS: { LOVE: 'love' } },
  '@renderer/plugins/Dialog': { dialog: { confirm: async() => false } },
  '@renderer/utils/data': { getListUpdateInfo: async() => ({}), saveListPrevSelectId: () => {} },
  '@renderer/plugins/i18n': { useI18n: () => key => key },
  './useShare': () => ({}),
  './useMenu': () => ({}),
  './useListUpdate': () => ({}),
  './useSort': () => ({}),
  './useDarg': () => ({}),
  './useEditList': () => ({}),
  './useListScroll': () => ({ scrollToList: () => {} }),
  './useGroups': () => ({}),
  './useDuplicate': () => ({}),
}).default

const walkNodes = (node, predicate, matches = []) => {
  if (Array.isArray(node)) node.forEach(item => walkNodes(item, predicate, matches))
  else if (node && typeof node == 'object') {
    if (predicate(node)) matches.push(node)
    walkNodes(node.children, predicate, matches)
  }
  return matches
}
const textContent = node => Array.isArray(node)
  ? node.map(textContent).join('')
  : node && typeof node == 'object'
    ? textContent(node.children)
    : node ?? ''

test('the real sidebar renders fixed translated group roots with counts, favorites, and collapse state', () => {
  const component = loadSidebarRender()
  const styles = new Proxy({}, { get: (_, key) => String(key) })
  const collapsed = { mine: false, external: false }
  const mine = [{ id: 'local', name: 'Local' }]
  const external = [{ id: 'online', name: 'Online', source: 'wy' }]
  const context = {
    $style: styles,
    $t: key => ({ lists__group_mine: 'My', lists__group_external: 'Imported / Collected', Love: 'Love' }[key] ?? key),
    $refs: {},
    listSidebarStyle: {},
    isModDown: false,
    listId: '',
    rightClickItemId: null,
    fetchingListStatus: {},
    loveList: { id: 'love', name: 'Love' },
    groups: { mine: { lists: mine, count: 2 }, external: { lists: external, count: 1 } },
    collapsed,
    getListCover: () => '',
    handleListsItemRigthClick: () => {},
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
    toggle: group => { collapsed[group] = !collapsed[group] },
  }
  const render = () => component.render(context, [], {}, context, {}, {})
  let tree = render()
  const roots = walkNodes(tree, node => node.props?.['data-group'])
  assert.deepEqual(roots.map(root => root.props['data-group']), ['mine', 'external'])
  const headings = walkNodes(tree, node => node.type == 'button' && Object.hasOwn(node.props ?? {}, 'aria-expanded'))
  assert.deepEqual(headings.map(textContent), ['▾My2', '▾Imported / Collected1'])
  assert.deepEqual(headings.map(heading => heading.props['aria-expanded']), ['true', 'true'])
  assert.deepEqual(walkNodes(roots[0], node => String(node.props?.class).includes('default-list')).map(node => node.props['data-list-id']), ['love'])
  assert.deepEqual(walkNodes(roots[0], node => String(node.props?.class).includes('user-list')).map(node => node.props['data-list-id']), ['local'])
  assert.deepEqual(walkNodes(roots[1], node => String(node.props?.class).includes('user-list')).map(node => node.props['data-list-id']), ['online'])

  headings[1].props.onClick()
  tree = render()
  const collapsedRoots = walkNodes(tree, node => node.props?.['data-group'])
  const collapsedHeadings = walkNodes(tree, node => node.type == 'button' && Object.hasOwn(node.props ?? {}, 'aria-expanded'))
  assert.deepEqual(collapsedHeadings.map(heading => heading.props['aria-expanded']), ['true', 'false'])
  assert.deepEqual(walkNodes(collapsedRoots[0], node => String(node.props?.class).includes('user-list')).map(node => node.props['data-list-id']), ['local'])
  assert.deepEqual(walkNodes(collapsedRoots[1], node => String(node.props?.class).includes('user-list')), [])

  context.groups.external = { lists: [], count: 0 }
  collapsed.external = false
  tree = render()
  const emptyExternalRoot = walkNodes(tree, node => node.props?.['data-group'] == 'external')[0]
  assert.equal(textContent(walkNodes(tree, node => node.type == 'button' && node.props?.['aria-expanded'])[1]), '▾Imported / Collected0')
  assert.deepEqual(walkNodes(emptyExternalRoot, node => String(node.props?.class).includes('user-list')), [])
})

const loadGroupState = value => loadTsModule(groupStatePath, {
  '@common/utils/vueTools': {},
}).loadMyListGroupCollapsed({
  getItem: () => value,
})

test('collapse state accepts only a complete boolean object', () => {
  assert.deepEqual(loadGroupState(null), { mine: false, external: false })
  assert.deepEqual(loadGroupState('{'), { mine: false, external: false })
  assert.deepEqual(loadGroupState('{"mine":true}'), { mine: false, external: false })
  assert.deepEqual(loadGroupState('[]'), { mine: false, external: false })
  assert.deepEqual(loadGroupState('{"mine":true,"external":false}'), { mine: true, external: false })
  assert.deepEqual(loadGroupState('{"mine":"yes"}'), { mine: false, external: false })
})

test('same-group reorder normalizes interleaved global positions', async() => {
  const userLists = [
    { id: 'local-a' },
    { id: 'external-a' },
    { id: 'local-b' },
    { id: 'external-b' },
  ]
  const updates = []
  const { reorderUserListWithinGroup } = loadTsModule(groupActionsPath, {
    '@common/utils': { log: { error: () => {} } },
    '@common/listGroup': {
      buildMovedUserListOrder: (lists, groups, id, group, toIndex) => {
        const moved = lists.find(list => list.id == id)
        const remaining = lists.filter(list => list.id != id)
        const mine = remaining.filter(list => groups[list.id] == 'mine')
        const external = remaining.filter(list => groups[list.id] == 'external')
        const target = group == 'mine' ? mine : external
        target.splice(toIndex, 0, moved)
        return [...mine, ...external].map(list => list.id)
      },
    },
    '@renderer/store/list/action': {
      updateUserListPosition: async({ ids, position }) => {
        updates.push({ id: ids[0], position })
        const oldIndex = userLists.findIndex(list => list.id == ids[0])
        userLists.splice(position, 0, userLists.splice(oldIndex, 1)[0])
      },
      getUserLists: async() => userLists,
    },
    '@renderer/store/list/state': { userLists },
    '@renderer/store/list/group': {
      getUserListGroup: list => ({ 'local-a': 'mine', 'local-b': 'mine', 'external-a': 'external', 'external-b': 'external' }[list.id]),
      initializeUserListGroups: async() => {},
      setUserListGroup: async() => {},
    },
  })

  await reorderUserListWithinGroup({ id: 'local-b', group: 'mine', toIndex: 0 })
  assert.deepEqual(userLists.map(list => list.id), ['local-b', 'local-a', 'external-a', 'external-b'])
  assert.deepEqual(updates, [{ id: 'local-b', position: 0 }])
})

test('move transaction writes a changed group before the exact target order', async() => {
  const calls = []
  const move = createMoveHarness({
    setGroup: async(id, group) => calls.push(['group', id, group]),
    setOrder: async ids => calls.push(['order', ids]),
  })

  await move({ id: 'external', toGroup: 'mine', toIndex: 0 })
  assert.deepEqual(calls, [
    ['group', 'external', 'mine'],
    ['order', ['external', 'mine']],
  ])
})

test('move transaction reorders within a group without rewriting its group metadata', async() => {
  const calls = []
  const move = createMoveHarness({
    readLists: () => [moveList('mine-a'), moveList('mine-b'), moveList('external')],
    getGroup: item => item.id == 'external' ? 'external' : 'mine',
    setGroup: async(...args) => calls.push(['group', ...args]),
    setOrder: async ids => calls.push(['order', ids]),
  })

  await move({ id: 'mine-b', toGroup: 'mine', toIndex: 0 })
  assert.deepEqual(calls, [['order', ['mine-b', 'mine-a', 'external']]])
})

test('first group-write failure does not begin ordering or compensating writes', async() => {
  const calls = []
  const move = createMoveHarness({
    setGroup: async() => {
      calls.push('group')
      throw new Error('profile')
    },
    setOrder: async() => calls.push('order'),
  })

  await assert.rejects(() => move({ id: 'external', toGroup: 'mine', toIndex: 0 }), /profile/)
  assert.deepEqual(calls, ['group'])
})

test('order failure restores the previous group and exact order', async() => {
  const calls = []
  const move = createMoveHarness({
    setGroup: async(id, group) => calls.push(['group', id, group]),
    setOrder: async ids => {
      calls.push(['order', ids])
      if (calls.filter(call => call[0] == 'order').length == 1) throw new Error('position')
    },
  })

  await assert.rejects(() => move({ id: 'external', toGroup: 'mine', toIndex: 0 }), /position/)
  assert.deepEqual(calls.at(-2), ['group', 'external', 'external'])
  assert.deepEqual(calls.at(-1), ['order', ['mine', 'external']])
})

test('a failed same-group ordering rolls back the original exact order', async() => {
  const calls = []
  const move = createMoveHarness({
    readLists: () => [moveList('mine-a'), moveList('mine-b'), moveList('external')],
    getGroup: item => item.id == 'external' ? 'external' : 'mine',
    setOrder: async ids => {
      calls.push(ids)
      if (calls.length == 1) throw new Error('position')
    },
  })

  await assert.rejects(() => move({ id: 'mine-b', toGroup: 'mine', toIndex: 0 }), /position/)
  assert.deepEqual(calls, [
    ['mine-b', 'mine-a', 'external'],
    ['mine-a', 'mine-b', 'external'],
  ])
})

test('a failed rollback reloads lists and reinitializes group metadata', async() => {
  const calls = []
  const move = createMoveHarness({
    setGroup: async(id, group) => {
      calls.push(['group', id, group])
      if (group == 'external') throw new Error('rollback profile')
    },
    setOrder: async ids => {
      calls.push(['order', ids])
      throw new Error('position')
    },
    reload: async() => calls.push(['reload']),
  })

  await assert.rejects(() => move({ id: 'external', toGroup: 'mine', toIndex: 0 }), /position/)
  assert.deepEqual(calls.at(-1), ['reload'])
})

test('revealing an eligible id expands its group then scrolls by stable id', async() => {
  const lists = [{ id: 'local' }, { id: 'external', source: 'wy', sourceListId: '42' }]
  const persisted = []
  const watches = []
  const scrolls = []
  const revealRequest = { value: null }
  const { default: useGroups } = loadTsModule(useGroupsPath, {
    '@common/listGroup': {
      partitionUserLists: (items, getGroup) => ({ mine: items.filter(item => getGroup(item) == 'mine'), external: items.filter(item => getGroup(item) == 'external') }),
    },
    '@common/utils/vueTools': {
      computed: getter => ({ get value() { return getter() } }),
      nextTick: async() => {},
      ref: value => ({ value }),
      watch: (source, callback, options) => {
        watches.push({ source, callback })
        if (options?.immediate) callback(source())
      },
    },
    '@renderer/store/list/group': {
      ensureUserListGroups: async() => {},
      getUserListGroup: list => list.source ? 'external' : 'mine',
      userListRevealRequest: revealRequest,
    },
    './groupState': {
      loadMyListGroupCollapsed: () => ({ mine: false, external: true }),
      saveMyListGroupCollapsed: (_, state) => persisted.push({ ...state }),
    },
  })
  const groups = useGroups({ userLists: lists, activeListId: () => '', scrollToList: id => scrolls.push(id) })

  await groups.reveal('external')
  assert.equal(groups.collapsed.value.external, false)
  assert.deepEqual(scrolls, ['external'])
  groups.toggle('mine')
  assert.deepEqual(persisted, [{ mine: false, external: false }, { mine: true, external: false }])
  await groups.reveal('default')
  await groups.reveal('webdav')
  await groups.reveal('deleted')
  await groups.reveal('')
  assert.deepEqual(scrolls, ['external'])

  groups.collapsed.value.mine = true
  watches[0].callback('local')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(groups.collapsed.value.mine, false)
  assert.deepEqual(scrolls, ['external', 'local'])

  groups.collapsed.value.mine = true
  await groups.reveal('love')
  assert.equal(groups.collapsed.value.mine, false)
  assert.deepEqual(scrolls, ['external', 'local', 'love'])
  for (const ignoredId of ['default', 'webdav', 'deleted', '']) await groups.reveal(ignoredId)
  assert.deepEqual(scrolls, ['external', 'local', 'love'])

  revealRequest.value = { id: 'external', token: 1 }
  watches[1].callback(revealRequest.value)
  await new Promise(resolve => setImmediate(resolve))
  revealRequest.value = { id: 'external', token: 2 }
  watches[1].callback(revealRequest.value)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(scrolls, ['external', 'local', 'love', 'external', 'external'])
})

test('a rejected drag restores C after A and B at its old draggable index', async() => {
  const sortableOptions = []
  const moveCalls = []
  const root = { dataset: { group: 'mine' }, children: [] }
  const createRow = id => ({
    dataset: { listId: id },
    classList: { contains: className => className == 'user-list' },
    remove: () => root.children.splice(root.children.findIndex(item => item.dataset.listId == id), 1),
  })
  const [a, b, c] = ['A', 'B', 'C'].map(createRow)
  root.children = [c, a, b] // Sortable has already moved C from index 2 to index 0.
  root.querySelectorAll = selector => selector == '.user-list'
    ? root.children.filter(item => item.classList.contains('user-list'))
    : []
  root.querySelector = () => null
  root.insertBefore = (item, target) => {
    const itemIndex = root.children.indexOf(item)
    if (itemIndex >= 0) root.children.splice(itemIndex, 1)
    const targetIndex = target ? root.children.indexOf(target) : root.children.length
    root.children.splice(targetIndex < 0 ? root.children.length : targetIndex, 0, item)
  }
  global.window = {
    app_event: { on: () => {}, off: () => {} },
    key_event: { on: () => {}, off: () => {} },
  }
  loadTsModule(useDargPath, {
    '@common/utils/vueTools': { onBeforeUnmount: () => {}, ref: value => ({ value }), useCssModule: () => ({ dragingItem: 'dragging' }) },
    '@renderer/utils/compositions/useDrag': options => {
      sortableOptions.push(options)
      return { setDisabled: () => {} }
    },
    './groupActions': {
      moveUserList: async payload => {
        moveCalls.push(payload)
        throw new Error('write failed')
      },
    },
    '@renderer/store/list/group': { requestUserListReveal: () => {} },
    '@renderer/plugins/Dialog': { dialog: () => {} },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
  }).default({
    dom_mine_list: { value: root },
    dom_external_list: { value: { dataset: { group: 'external' } } },
    handleSaveListName: () => {},
    handleMenuClick: () => {},
    expand: () => {},
    isGroupCollapsed: () => false,
    getGroupListLength: () => 0,
  })

  assert.equal(sortableOptions.length, 2)
  assert.deepEqual(sortableOptions.map(options => options.draggable), ['.user-list', '.user-list'])
  assert.deepEqual(sortableOptions.map(options => options.filter), ['.my-list-group-heading, .default-list', '.my-list-group-heading, .default-list'])
  sortableOptions[0].onUpdate({ item: c, from: root, to: root, newDraggableIndex: 0, oldDraggableIndex: 2 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(moveCalls, [{ id: 'C', toGroup: 'mine', toIndex: 0 }])
  assert.deepEqual(root.children.map(item => item.dataset.listId), ['A', 'B', 'C'])
})

test('a rejected cross-group drag restores the item to its source root', async() => {
  const sortableOptions = []
  const source = { dataset: { group: 'mine' }, children: [] }
  const destination = { dataset: { group: 'external' }, children: [] }
  const createRow = (id, parent) => ({
    dataset: { listId: id },
    classList: { contains: className => className == 'user-list' },
    remove: () => parent.children.splice(parent.children.findIndex(item => item.dataset.listId == id), 1),
  })
  const [a, b] = ['A', 'B'].map(id => createRow(id, source))
  const c = createRow('C', destination)
  source.children = [a, b]
  destination.children = [c] // Sortable has moved C from source index 1 to the other root.
  for (const root of [source, destination]) {
    root.querySelectorAll = selector => selector == '.user-list'
      ? root.children.filter(item => item.classList.contains('user-list'))
      : []
    root.querySelector = () => null
    root.insertBefore = (item, target) => {
      const itemIndex = root.children.indexOf(item)
      if (itemIndex >= 0) root.children.splice(itemIndex, 1)
      const targetIndex = target ? root.children.indexOf(target) : root.children.length
      root.children.splice(targetIndex < 0 ? root.children.length : targetIndex, 0, item)
    }
  }
  global.window = {
    app_event: { on: () => {}, off: () => {} },
    key_event: { on: () => {}, off: () => {} },
  }
  loadTsModule(useDargPath, {
    '@common/utils/vueTools': { onBeforeUnmount: () => {}, ref: value => ({ value }), useCssModule: () => ({ dragingItem: 'dragging' }) },
    '@renderer/utils/compositions/useDrag': options => {
      sortableOptions.push(options)
      return { setDisabled: () => {}, destroy: () => {} }
    },
    './groupActions': { moveUserList: async() => { throw new Error('write failed') } },
    '@renderer/store/list/group': { requestUserListReveal: () => {} },
    '@renderer/plugins/Dialog': { dialog: () => {} },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
  }).default({
    dom_mine_list: { value: source },
    dom_external_list: { value: destination },
    handleSaveListName: () => {},
    handleMenuClick: () => {},
    expand: () => {},
    isGroupCollapsed: () => false,
    getGroupListLength: () => 0,
  })

  sortableOptions[1].onAdd({ item: c, from: source, to: destination, newDraggableIndex: 0, oldDraggableIndex: 1 })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(source.children.map(item => item.dataset.listId), ['A', 'C', 'B'])
  assert.deepEqual(destination.children, [])
})

test('group drag uses shared Sortable roots, stable ids, heading expansion, and cleans up', async() => {
  const sortableOptions = []
  const destroyed = []
  const moveCalls = []
  const reveals = []
  const cleanups = []
  const expanded = []
  let headingTimer
  let headingDelay
  let mineCollapsed = true
  const mineRoot = { dataset: { group: 'mine' } }
  const externalRoot = { dataset: { group: 'external' } }
  const row = { dataset: { listId: 'external' } }
  const heading = { matches: selector => selector == '.my-list-group-heading' }
  global.window = {
    app_event: { on: () => {}, off: () => {} },
    key_event: { on: () => {}, off: () => {} },
  }
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  global.setTimeout = (callback, delay) => {
    headingTimer = callback
    headingDelay = delay
    return 1
  }
  global.clearTimeout = () => { headingTimer = null }
  try {
    loadTsModule(useDargPath, {
      '@common/utils/vueTools': { onBeforeUnmount: callback => cleanups.push(callback), ref: value => ({ value }), useCssModule: () => ({ dragingItem: 'dragging' }) },
      '@renderer/utils/compositions/useDrag': options => {
        sortableOptions.push(options)
        return { setDisabled: () => {}, destroy: () => destroyed.push(options.dom_list) }
      },
      './groupActions': { moveUserList: async payload => moveCalls.push(payload) },
      '@renderer/store/list/group': { requestUserListReveal: id => reveals.push(id) },
      '@renderer/plugins/Dialog': { dialog: () => {} },
      '@renderer/plugins/i18n': { useI18n: () => key => key },
    }).default({
      dom_mine_list: { value: mineRoot },
      dom_external_list: { value: externalRoot },
      handleSaveListName: () => {},
      handleMenuClick: () => {},
      expand: group => {
        expanded.push(group)
        if (group == 'mine') mineCollapsed = false
      },
      isGroupCollapsed: group => group == 'mine' && mineCollapsed,
      getGroupListLength: group => group == 'mine' ? 3 : 1,
    })

    assert.deepEqual(sortableOptions.map(options => options.group), ['my-list-groups', 'my-list-groups'])
    assert.deepEqual(sortableOptions.map(options => options.draggable), ['.user-list', '.user-list'])
    assert.deepEqual(sortableOptions.map(options => options.filter), ['.my-list-group-heading, .default-list', '.my-list-group-heading, .default-list'])
    assert.equal(typeof sortableOptions[0].onAdd, 'function')
    assert.equal(typeof sortableOptions[0].onMove, 'function')

    assert.equal(sortableOptions[0].onMove({ to: mineRoot, related: heading }), true)
    assert.equal(headingDelay, 400)
    sortableOptions[0].onAdd({ item: row, to: mineRoot, from: externalRoot, newDraggableIndex: 0, oldDraggableIndex: 0 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(moveCalls, [{ id: 'external', toGroup: 'mine', toIndex: 3 }])

    mineCollapsed = true
    sortableOptions[0].onMove({ to: mineRoot, related: heading })
    headingTimer()
    assert.deepEqual(expanded, ['mine'])
    sortableOptions[0].onAdd({ item: row, to: mineRoot, from: externalRoot, newDraggableIndex: 0, oldDraggableIndex: 0 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(moveCalls, [
      { id: 'external', toGroup: 'mine', toIndex: 3 },
      { id: 'external', toGroup: 'mine', toIndex: 0 },
    ])
    assert.deepEqual(reveals, ['external', 'external'])

    mineCollapsed = true
    sortableOptions[0].onMove({ to: mineRoot, related: heading })
    assert.equal(typeof headingTimer, 'function')
    sortableOptions[0].onMove({ to: mineRoot, related: { matches: () => false } })
    sortableOptions[0].onAdd({ item: row, to: mineRoot, from: externalRoot, newDraggableIndex: 2, oldDraggableIndex: 0 })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(moveCalls.at(-1), { id: 'external', toGroup: 'mine', toIndex: 2 })
    cleanups.forEach(cleanup => cleanup())
    assert.deepEqual(destroyed.length, 2)
    assert.equal(headingTimer, null)
  } finally {
    global.setTimeout = originalSetTimeout
    global.clearTimeout = originalClearTimeout
  }
})

test('the shared drag composition forwards shared-group events and consumer move results', () => {
  let sortableOptions
  const Sortable = {
    mount: () => {},
    create: (_, options) => {
      sortableOptions = options
      return { option: () => {}, destroy: () => {} }
    },
  }
  Sortable.AutoScroll = class {}
  let receivedEvent
  let receivedAdd
  const useDrag = loadTsModule(useDragPath, {
    'sortablejs/modular/sortable.core.esm': Sortable,
    '@common/utils/vueTools': { onMounted: callback => callback(), onBeforeUnmount: () => {} },
    '@renderer/event': { clearDownKeys: () => {} },
  }).default
  useDrag({
    dom_list: { value: {} },
    draggable: '.user-list',
    group: 'my-list-groups',
    filter: '.my-list-group-heading, .default-list',
    dragingItemClassName: 'dragging',
    onUpdate: event => { receivedEvent = event },
    onAdd: event => { receivedAdd = event },
    onMove: () => false,
  })
  const event = { item: { dataset: { listId: 'local' } }, newDraggableIndex: 3 }
  sortableOptions.onUpdate(event)
  sortableOptions.onAdd(event)
  assert.equal(sortableOptions.draggable, '.user-list')
  assert.equal(sortableOptions.group, 'my-list-groups')
  assert.equal(sortableOptions.filter, '.my-list-group-heading, .default-list')
  assert.strictEqual(receivedEvent, event)
  assert.strictEqual(receivedAdd, event)
  assert.equal(sortableOptions.onMove({ related: null }), false)
})
