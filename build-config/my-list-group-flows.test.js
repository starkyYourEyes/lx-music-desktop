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

const loadShare = ({ targetExists = false, currentGroup = 'mine' } = {}) => {
  const imported = {
    id: 'incoming',
    name: 'Incoming',
    source: 'wy',
    sourceListId: '7',
    locationUpdateTime: null,
    group: 'mine',
    list: [{ id: 'track' }],
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
  const created = await importSingleHarness({ targetExists: false })
  assert.equal(created.created?.group, 'external')
  assert.deepEqual(created.created?.list, [{ id: 'track' }])
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
