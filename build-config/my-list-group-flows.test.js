const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
// Reserved for source contracts added alongside later list-group flows.
// eslint-disable-next-line no-unused-vars
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')
const settingBackupPath = path.join(root, 'src/renderer/views/Setting/components/SettingBackup.vue')
const myListPath = path.join(root, 'src/renderer/views/List/MyList/index.vue')
const useEditListPath = path.join(root, 'src/renderer/views/List/MyList/useEditList.ts')
const useMenuPath = path.join(root, 'src/renderer/views/List/MyList/useMenu.js')
const useSharePath = path.join(root, 'src/renderer/views/List/MyList/useShare.ts')
const listEventPath = path.join(root, 'src/main/modules/sync/listEvent.ts')

const defaultList = { id: 'default', name: 'Default' }
const loveList = { id: 'love', name: 'Love' }
const vueRuntime = {
  createElementBlock: () => {},
  createElementVNode: () => {},
  createVNode: () => {},
  openBlock: () => {},
  resolveComponent: () => {},
  toDisplayString: value => String(value),
}
const identityMusicUtils = {
  filterMusicList: value => value,
  fixNewMusicInfoQuality: value => value,
  toNewMusicInfo: value => value,
}

const createListRow = (id, name) => {
  const classes = new Set()
  const input = { value: name, focus: () => {} }
  return {
    dataset: { listId: id },
    input,
    classList: {
      add: className => classes.add(className),
      remove: className => classes.delete(className),
      contains: className => classes.has(className),
    },
    querySelector: selector => selector == 'input' || selector == '.listsInput' ? input : null,
  }
}

const loadEditList = () => {
  const userLists = [
    { id: 'first', name: 'First' },
    { id: 'second', name: 'Second' },
  ]
  const renderedRows = [
    createListRow('second', 'Second'),
    createListRow('first', 'First'),
  ]
  const updates = []
  const useEditList = loadTsModule(useEditListPath, {
    '@common/utils/vueTools': {
      ref: value => ({ value }),
      nextTick: callback => callback(),
      useCssModule: () => ({ editing: 'editing', listsInput: 'listsInput' }),
    },
    '@renderer/store/list/state': { userLists },
    '@renderer/store/list/action': {
      updateUserList: async lists => updates.push(lists),
      createUserList: async() => {},
    },
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => true } },
  }).default
  const dom_lists_list = {
    value: {
      querySelectorAll: selector => selector == '.user-list' ? renderedRows : [],
      querySelector: selector => selector == '.editing'
        ? renderedRows.find(row => row.classList.contains('editing')) ?? null
        : null,
    },
  }
  return { handlers: useEditList({ dom_lists_list }), renderedRows, updates }
}

const loadMenu = ({ groups = { local: 'mine', collected: 'external' }, moveUserList = async() => {}, dialog = () => {} } = {}) => {
  const local = { id: 'local', name: 'Local' }
  const collected = { id: 'collected', name: 'Collected', source: 'wy', sourceListId: '42' }
  const calls = {
    rename: [],
    sourceDetail: [],
    import: [],
    export: [],
    sync: [],
    reveals: [],
  }
  const useMenu = loadTsModule(useMenuPath, {
    '@common/utils/vueTools': {
      computed: getter => ({ get value() { return getter() } }),
      ref: value => ({ value }),
      reactive: value => value,
      nextTick: callback => callback(),
    },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/store/list/state': {
      userLists: [local, collected],
      defaultList,
      loveList,
      webDAVList: { id: 'webdav', name: 'WebDAV' },
    },
    '@renderer/store/list/group': {
      getUserListGroup: list => groups[list.id],
      requestUserListReveal: id => calls.reveals.push(id),
    },
    './groupActions': { moveUserList },
    '@renderer/plugins/Dialog': { dialog },
    '@renderer/utils/musicSdk': {
      wy: { songList: { getDetailPageUrl: () => 'https://example.test/playlist/42' } },
    },
    './actions': {
      addLocalFile: () => {},
      addWebDAVMusics: () => {},
      refreshWebDAVMusics: () => {},
    },
  }).default
  const menu = useMenu({
    emit: () => {},
    handleRename: id => calls.rename.push(id),
    handleDuplicateList: () => {},
    handleSortList: () => {},
    handleOpenSourceDetailPage: listInfo => calls.sourceDetail.push(listInfo),
    handleImportList: (...args) => calls.import.push(args),
    handleExportList: listInfo => calls.export.push(listInfo),
    handleUpdateSourceList: listInfo => calls.sync.push(listInfo),
    handleRemove: () => {},
  })
  return { menu, local, collected, calls }
}

const normalizeClass = value => {
  if (Array.isArray(value)) return value.map(normalizeClass).filter(Boolean).join(' ')
  if (value && typeof value == 'object') return Object.entries(value).filter(([, enabled]) => enabled).map(([name]) => name).join(' ')
  return value || ''
}

const renderVueRuntime = {
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

const loadMyListRender = () => loadVueSfc(myListPath, {
  vue: renderVueRuntime,
  '@common/utils/electron': { openUrl: () => {} },
  '@common/utils/common': { encodePath: value => value },
  '@renderer/utils/musicSdk': {},
  './components/DuplicateMusicModal.vue': {},
  './components/ListSortModal.vue': {},
  './components/ListUpdateModal.vue': {},
  '@renderer/store/list/state': {
    allMusicList: new Map(),
    loveList,
    userLists: [],
    fetchingListStatus: {},
  },
  '@renderer/store/list/action': { getListMusics: async() => [], removeUserList: async() => {} },
  '@renderer/store/setting': { appSetting: {} },
  '@common/utils/vueTools': {
    computed: () => ({ value: {} }),
    onBeforeUnmount: () => {},
    ref: value => ({ value }),
    watch: () => {},
  },
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
  './useListScroll': () => {},
  './useGroups': () => ({}),
  './useDuplicate': () => ({}),
}).default

const renderUserListRows = (userLists, handleListsItemRigthClick = () => {}) => {
  const component = loadMyListRender()
  const style = new Proxy({}, { get: (_, key) => String(key) })
  const context = {
    $style: style,
    $t: key => key,
    $refs: {},
    listSidebarStyle: {},
    isModDown: false,
    loveList,
    listId: '',
    rightClickItemId: null,
    fetchingListStatus: {},
    getListCover: () => '',
    userLists,
    groups: {
      mine: { lists: userLists, count: userLists.length + 1 },
      external: { lists: [], count: 0 },
    },
    collapsed: { mine: false, external: false },
    toggle: () => {},
    handleListsItemRigthClick,
    handleListToggle: () => {},
    handleSaveListName: () => {},
    isShowNewList: false,
    isNewListLeave: false,
    handleCreateList: () => {},
    isShowListUpdateModal: false,
    isShowListSortModal: false,
    sortListInfo: null,
    isShowDuplicateMusicModal: false,
    duplicateListInfo: null,
    isShowMenu: false,
    menus: [],
    menuLocation: { x: 0, y: 0 },
    handleMenuClick: () => {},
  }
  const rows = []
  const visit = node => {
    if (Array.isArray(node)) {
      node.forEach(visit)
      return
    }
    if (!node || typeof node != 'object') return
    if (node.type == 'li' && String(node.props?.class).split(' ').includes('user-list')) rows.push(node)
    visit(node.children)
  }
  visit(component.render(context, [], {}, context, {}, {}))
  return rows
}

const loadSettingBackup = ({ backupData, groups = {}, importedData, setGroup = async() => {} } = {}) => {
  const userLists = [
    { id: 'local', name: 'Local', locationUpdateTime: null },
    { id: 'collected', name: 'Collected', source: 'wy', sourceListId: '42', locationUpdateTime: null },
  ]
  let captured
  global.window = {
    lx: {
      worker: {
        main: {
          readLxConfigFile: async() => importedData,
          exportPlayListToText: async() => {},
          exportPlayListToCSV: async() => {},
        },
      },
    },
  }
  const component = loadVueSfc(settingBackupPath, {
    vue: vueRuntime,
    '@common/utils/vueTools': { toRaw: value => value },
    '@renderer/utils': identityMusicUtils,
    '@renderer/utils/ipc': {
      showSelectDialog: async() => ({ canceled: false, filePaths: ['backup.lxmc'] }),
      openSaveDir: async() => ({ canceled: true }),
    },
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => true } },
    '@renderer/utils/compositions/useImportTip': () => () => {},
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/store/list/action': {
      getListMusics: async id => [{ id: `music-${id}` }],
      overwriteListFull: async data => {
        assert.equal(data.userList.some(list => Object.hasOwn(list, 'group')), false)
      },
      overwriteListMusics: async() => {},
    },
    '@common/constants': { LIST_IDS: { DEFAULT: 'default', LOVE: 'love' } },
    '@renderer/store/list/state': { defaultList, loveList, userLists },
    '@renderer/store/setting': { appSetting: {}, updateSetting: () => {} },
    '@common/utils/migrateSetting': value => value,
    '@common/backupFormats': {
      BACKUP_IMPORT_EXTENSIONS: ['lxmc'],
      BACKUP_NAMES: { allData: 'all.lxmc', playlist: 'playlist.lxmc', setting: 'setting.lxmc' },
    },
    '@renderer/utils/compositions/useBackupExport': () => async(options, createData) => {
      captured = await createData()
      if (backupData) backupData.push(captured)
    },
    '@renderer/store/list/group': {
      getUserListGroup: list => groups[list.id],
      setUserListGroup: setGroup,
    },
    '@common/listGroup': {
      resolveUserListGroup: (list, group) => group == 'mine' || group == 'external'
        ? group
        : list.source != null || list.sourceListId != null ? 'external' : 'mine',
    },
  }).default
  return { handlers: component.setup(), getCaptured: () => captured }
}

const exportAllListsHarness = async groups => {
  const loaded = loadSettingBackup({ groups })
  await loaded.handlers.handleExportPlayList()
  return loaded.getCaptured().data
}

const restoreHarness = async(lists, type) => {
  const writes = []
  const importedData = type == 'playList_v2'
    ? { type, data: lists }
    : { type, playList: lists, setting: {} }
  const loaded = loadSettingBackup({
    importedData,
    setGroup: async(id, group) => {
      await new Promise(resolve => setImmediate(resolve))
      writes.push([id, group])
    },
  })
  if (type == 'playList_v2') await loaded.handlers.handleImportPlayList()
  else await loaded.handlers.handleImportAllData()
  return writes
}

const loadShare = ({ targetExists = false, currentGroup = 'mine', sourceLess = false } = {}) => {
  const imported = {
    id: 'incoming',
    name: 'Incoming',
    locationUpdateTime: null,
    group: 'mine',
    list: [{ id: 'track' }],
    ...(sourceLess ? {} : { source: 'wy', sourceListId: '7' }),
  }
  const target = { ...imported, name: 'Current' }
  delete target.group
  delete target.list
  const created = []
  const groupWrites = []
  const exported = []
  const sequence = []
  const groups = { incoming: currentGroup }
  global.window = {
    lx: { worker: { main: { readLxConfigFile: async() => ({ type: 'playListPart_v2', data: imported }) } } },
  }
  const useShare = loadTsModule(useSharePath, {
    '@common/utils/vueTools': { toRaw: value => value },
    '@renderer/utils/ipc': { showSelectDialog: async() => ({ canceled: false, filePaths: ['part.lxmc'] }) },
    '@renderer/plugins/i18n': { useI18n: () => key => key },
    '@renderer/utils': { ...identityMusicUtils, filterFileName: value => value },
    '@renderer/store/list/action': {
      addListMusics: async() => {},
      createUserList: async payload => {
        await new Promise(resolve => setImmediate(resolve))
        created.push(payload)
        groups[payload.id] = payload.group
      },
      getListMusics: async() => [{ id: 'track' }],
      overwriteListMusics: async() => {
        await new Promise(resolve => setImmediate(resolve))
        sequence.push('music')
      },
      updateUserList: async() => {
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
        sequence.push('metadata')
      },
    },
    '@renderer/store/list/state': {
      defaultList,
      loveList,
      userLists: targetExists ? [target] : [],
    },
    '@renderer/utils/compositions/useImportTip': () => () => {},
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => true } },
    '@common/backupFormats': {
      BACKUP_IMPORT_EXTENSIONS: ['lxmc'],
      createPlaylistPartBackupName: value => value,
    },
    '@renderer/utils/compositions/useBackupExport': () => async(options, createData) => {
      exported.push(await createData())
    },
    '@renderer/store/list/group': {
      getUserListGroup: list => groups[list.id],
      requestUserListReveal: id => sequence.push(`reveal:${id}`),
      setUserListGroup: async(id, group) => {
        groupWrites.push([id, group])
        groups[id] = group
      },
    },
  }).default()
  return { useShare, target, created, exported, groupWrites, groups, sequence }
}

const importSingleHarness = async options => {
  const loaded = loadShare(options)
  await loaded.useShare.handleImportList(loaded.target)
  return {
    created: loaded.created[0] ?? null,
    currentGroup: loaded.groups.incoming,
    groupWrites: loaded.groupWrites,
    sequence: loaded.sequence,
  }
}

test('playlist backup records carry the resolved group', async() => {
  const backup = await exportAllListsHarness({ local: 'mine', collected: 'external' })
  assert.equal(backup.find(item => item.id == 'local').group, 'mine')
  assert.equal(backup.find(item => item.id == 'collected').group, 'external')
})

test('restore applies saved groups and derives groups for old records', async() => {
  const lists = [
    { id: 'saved', name: 'Saved', list: [], group: 'mine', source: 'wy', sourceListId: '1' },
    { id: 'legacy-online', name: 'Online', list: [], source: 'wy', sourceListId: '2' },
    { id: 'legacy-local', name: 'Local', list: [] },
    { id: 'invalid-online', name: 'Invalid', list: [], group: 'other', source: 'wy' },
  ]
  const expected = [
    ['saved', 'mine'],
    ['legacy-online', 'external'],
    ['legacy-local', 'mine'],
    ['invalid-online', 'external'],
  ]
  assert.deepEqual(await restoreHarness(lists, 'playList_v2'), expected)
  assert.deepEqual(await restoreHarness(lists, 'allData_v2'), expected)
})

test('single-list import assigns external only for a new target', async() => {
  const created = await importSingleHarness({ targetExists: false, sourceLess: true })
  assert.equal(created.created?.group, 'external')
  assert.equal(created.created?.strictGroupPersistence, true)
  assert.deepEqual(created.created?.list, [{ id: 'track' }])
  assert.equal(Object.hasOwn(created.created, 'position'), false)
  assert.deepEqual(created.sequence, [])
  const overwrite = await importSingleHarness({ targetExists: true, currentGroup: 'mine' })
  assert.equal(overwrite.created, null)
  assert.equal(overwrite.groupWrites.length, 0)
  assert.equal(overwrite.currentGroup, 'mine')
  assert.deepEqual(overwrite.sequence, ['metadata', 'music', 'reveal:incoming'])
})

test('single-list exports include user groups but exclude groups from favorites', async() => {
  const loaded = loadShare({ currentGroup: 'external' })
  await loaded.useShare.handleExportList({ id: 'incoming', name: 'Incoming' })
  await loaded.useShare.handleExportList(loveList)
  assert.equal(loaded.exported[0].data.group, 'external')
  assert.equal(Object.hasOwn(loaded.exported[1].data, 'group'), false)
})

test('rendered playlist rows expose and emit their stable playlist identity', () => {
  const renderedLists = [
    { id: 'second', name: 'Second' },
    { id: 'first', name: 'First' },
  ]
  const contextMenuTargets = []
  const rows = renderUserListRows(renderedLists, (event, listInfo) => contextMenuTargets.push(listInfo))

  assert.deepEqual(rows.map(row => row.props['data-list-id']), ['second', 'first'])
  rows[0].props.onContextmenu({ pageX: 10, pageY: 20 })
  assert.strictEqual(contextMenuTargets[0], renderedLists[0])
})

test('rename saves the playlist selected by stable id when DOM order differs', async() => {
  const loaded = loadEditList()

  loaded.handlers.handleRename('first')
  assert.equal(loaded.renderedRows[0].classList.contains('editing'), false)
  assert.equal(loaded.renderedRows[1].classList.contains('editing'), true)
  loaded.renderedRows[1].input.value = 'Renamed First'
  await loaded.handlers.handleSaveListName()

  assert.deepEqual(loaded.updates, [[{ id: 'first', name: 'Renamed First' }]])
})

test('menu source capabilities derive from the passed playlist', () => {
  const loaded = loadMenu()

  assert.doesNotThrow(() => loaded.menu.showMenu({ pageX: 10, pageY: 20 }, loaded.collected))
  const disabledByAction = Object.fromEntries(loaded.menu.menus.value.map(item => [item.action, item.disabled]))
  assert.equal(disabledByAction.sync, false)
  assert.equal(disabledByAction.sourceDetail, false)
})

test('normal playlist menus offer the other group while fixed lists offer none', () => {
  const loaded = loadMenu()

  loaded.menu.showMenu({ pageX: 10, pageY: 20 }, loaded.collected)
  const moveItems = loaded.menu.menus.value.filter(item => item.action == 'move_group')
  assert.deepEqual(moveItems, [{
    name: 'lists__move_to_group',
    action: 'move_group',
    group: 'mine',
    disabled: false,
  }])
  const actions = new Set(loaded.menu.menus.value.map(item => item.action))
  assert.equal(actions.has('sync'), true)
  assert.equal(actions.has('sourceDetail'), true)

  for (const fixed of [loveList, defaultList, { id: 'webdav', name: 'WebDAV' }]) {
    loaded.menu.showMenu({ pageX: 10, pageY: 20 }, fixed)
    assert.equal(loaded.menu.menus.value.some(item => item.action == 'move_group'), false)
  }
})

test('menu movement persists to the target group and reveals only after success', async() => {
  const moves = []
  const loaded = loadMenu({ moveUserList: async request => moves.push(request) })

  loaded.menu.menuClick({ action: 'move_group', group: 'mine' }, loaded.collected)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(moves, [{ id: 'collected', toGroup: 'mine', toIndex: 1 }])
  assert.deepEqual(loaded.calls.reveals, ['collected'])
})

test('failed menu movement reports the localized movement error without revealing', async() => {
  const errors = []
  const loaded = loadMenu({
    moveUserList: async() => { throw new Error('write failed') },
    dialog: message => errors.push(message),
  })

  loaded.menu.menuClick({ action: 'move_group', group: 'mine' }, loaded.collected)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, ['lists__move_group_failed'])
  assert.deepEqual(loaded.calls.reveals, [])
})

test('menu actions keep the passed playlist as their target', () => {
  const loaded = loadMenu()

  loaded.menu.menuClick({ action: 'sourceDetail' }, loaded.collected)
  loaded.menu.menuClick({ action: 'sync' }, loaded.collected)
  loaded.menu.menuClick({ action: 'export' }, loaded.collected)
  loaded.menu.menuClick({ action: 'import' }, loaded.collected)
  loaded.menu.menuClick({ action: 'rename' }, loaded.collected)

  assert.strictEqual(loaded.calls.sourceDetail[0], loaded.collected)
  assert.strictEqual(loaded.calls.sync[0], loaded.collected)
  assert.strictEqual(loaded.calls.export[0], loaded.collected)
  assert.deepEqual(loaded.calls.import[0], [loaded.collected])
  assert.deepEqual(loaded.calls.rename, ['collected'])
})

test('sync list snapshots omit config-only group metadata', () => {
  const { buildUserListInfoFull } = loadTsModule(listEventPath, {
    '@common/constants': { LIST_IDS: { DEFAULT: 'default', LOVE: 'love', TEMP: 'temp' } },
  })
  const result = buildUserListInfoFull({
    id: 'online',
    name: 'Online',
    source: 'wy',
    sourceListId: '42',
    locationUpdateTime: null,
    list: [],
    group: 'external',
  })
  assert.equal(Object.hasOwn(result, 'group'), false)
})
