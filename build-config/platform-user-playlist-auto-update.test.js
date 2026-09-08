const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const vue = require('vue')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const ordinary = { id: 'imported', name: 'Imported', source: 'wy', sourceListId: '42', locationUpdateTime: null }
const cachedPlatform = { id: 'platform:netease:1:created:42', name: 'Platform', source: 'wy', sourceListId: '42', locationUpdateTime: null }

test('ordinary update settings exclude cached platform playlists while preserving imported lists', async() => {
  const userLists = vue.reactive([ordinary, cachedPlatform])
  const refreshes = []
  const autoUpdates = []
  const component = loadVueSfc(path.join(root, 'src/renderer/views/List/MyList/components/ListUpdateModal.vue'), {
    vue,
    '@common/utils/vueTools': vue,
    '@renderer/store/list/state': { userLists, fetchingListStatus: {}, listUpdateTimes: {} },
    '@renderer/store/list/syncSourceList': async list => { refreshes.push(list.id) },
    '@renderer/utils/musicSdk': { wy: { songList: {} }, tx: { songList: {} }, kg: { songList: {} } },
    '@renderer/utils/data': {
      getListUpdateInfo: async() => ({}),
      setListAutoUpdate: async(id, enabled) => { autoUpdates.push([id, enabled]) },
    },
  }).default
  const state = component.setup()
  assert.deepEqual(state.lists.value.map(list => list.id), ['imported'])
  state.handleUpdate(state.lists.value[0])
  state.handleChangeAutoUpdate(state.lists.value[0], true)
  assert.deepEqual(refreshes, ['imported'])
  assert.deepEqual(autoUpdates, [['imported', true]])
  userLists.push({ ...cachedPlatform, id: 'platform:qq_music:2:collected:43', source: 'tx' })
  await vue.nextTick()
  assert.deepEqual(state.lists.value.map(list => list.id), ['imported'])
  assert.equal(userLists.length, 3)
})

test('ordinary startup auto update ignores platform cache even when its legacy auto-update flag is enabled', async() => {
  const otherImported = { ...ordinary, id: 'second-imported', sourceListId: '43' }
  const userLists = [ordinary, cachedPlatform, otherImported]
  const metadata = Object.fromEntries(userLists.map(list => [list.id, { updateTime: 0, isAutoUpdate: true }]))
  const refreshed = []
  const updateLists = loadTsModule(path.join(root, 'src/renderer/core/useApp/listAutoUpdate.ts'), {
    '@renderer/utils/data': { getListUpdateInfo: async() => metadata },
    '@renderer/store/list/state': { userLists },
    '@renderer/store/list/syncSourceList': async list => { refreshed.push(list.id) },
  }).default
  updateLists()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(refreshed, ['imported', 'second-imported'])
  assert.equal(userLists.length, 3)
  assert.equal(metadata[cachedPlatform.id].isAutoUpdate, true)
})
