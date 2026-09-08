const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const vue = {
  reactive: value => value,
  shallowReactive: value => value,
  ref: value => ({ value }),
  computed: get => ({ get value() { return get() } }),
  nextTick: callback => callback(),
}

test('managed track menus block writes but allow playback and copying into an ordinary list', () => {
  const useMenu = loadModule(path.resolve('src/renderer/views/List/MusicList/useMenu.js'), {
    '@common/utils/vueTools': vue,
    '@renderer/utils/musicSdk': {},
    '@renderer/plugins/i18n': { useI18n: () => value => value },
    '@renderer/core/dislikeList': { hasDislike: () => false },
    '@common/constants': { LIST_IDS: { WEBDAV: 'webdav' } },
  }).default
  const calls = []
  const props = { listId: 'platform:netease:fixture:created:123' }
  const menu = useMenu({
    props, canStartPlayback: () => true, canOpenPrimaryDownload: () => true, emit: () => {},
    handlePlayMusic: () => calls.push('play'),
    handleShowMusicAddModal: () => calls.push('addTo'),
    handleShowMusicMoveModal: () => calls.push('moveTo'),
    handleShowSortModal: () => calls.push('sort'),
    handleShowMusicToggleModal: () => calls.push('toggleSource'),
    handleRemoveMusic: () => calls.push('remove'),
  })
  const event = { pageX: 0, pageY: 0 }
  menu.showMenu(event, { source: 'wy' })
  for (const action of ['moveTo', 'sort', 'toggleSource', 'remove']) {
    assert.equal(menu.menus.value.find(item => item.action == action).disabled, true)
    menu.menuClick({ action }, 0)
  }
  assert.deepEqual(calls, [])
  menu.menuClick({ action: 'play' }, 0)
  menu.menuClick({ action: 'addTo' }, 0)
  assert.deepEqual(calls, ['play', 'addTo'])
  props.listId = 'local'
  menu.showMenu(event, { source: 'wy' })
  assert.equal(menu.menus.value.find(item => item.action == 'remove').disabled, false)
  menu.menuClick({ action: 'remove' }, 0)
  assert.deepEqual(calls, ['play', 'addTo', 'remove'])
})

test('both add-to pickers exclude managed playlists while retaining ordinary imports', () => {
  const userLists = [{ id: 'manual', name: 'Manual import', source: 'wy' }, { id: 'platform:netease:fixture:created:123', name: 'Account list' }]
  for (const name of ['ListAddModal', 'ListAddMultipleModal']) {
    const component = loadVueSfc(path.resolve(`src/renderer/components/common/${name}.vue`), {
      vue: require('vue'),
      '@common/utils/vueTools': { ...vue, onBeforeUnmount: () => {}, watch: (get, callback) => { if (typeof get == 'function') callback(get()); return () => {} } },
      '@renderer/store/list/state': { userLists, defaultList: { id: 'default' }, loveList: { id: 'love' } },
      '@renderer/store/list/action': { getMusicExistListIds: async() => [] },
      '@renderer/utils/compositions/useKeyDown': () => ({ value: false }),
      '@root/lang': { useI18n: () => key => key },
      '@renderer/plugins/Dialog': {},
    }).default
    const state = component.setup({ show: true, musicInfo: { id: 'track' }, excludeListId: ['default'] })
    assert.deepEqual(state.lists.value.map(list => list.id), ['love', 'manual'])
  }
})

test('visible drag indices exclude managed lists and preserve their existing positions', async() => {
  const common = loadModule(path.resolve('src/common/listGroup.ts'))
  const { createMoveUserList } = loadModule(path.resolve('src/renderer/views/List/MyList/groupActions.ts'), {
    '@common/listGroup': common,
    '@common/utils': { log: { error: () => {} } },
    '@renderer/store/list/action': {},
    '@renderer/store/list/state': { userLists: [] },
    '@renderer/store/list/group': {},
  })
  const managedId = 'platform:netease:fixture:created:123'
  const lists = [managedId, 'a', 'b', 'c'].map(id => ({ id, name: id }))
  let actual
  const move = createMoveUserList({
    readLists: () => lists, getGroup: () => 'external', setGroup: async() => {}, reload: async() => {},
    setOrder: async ids => { actual = ids },
  })
  await move({ id: 'c', toGroup: 'external', toIndex: 1 })
  assert.deepEqual(actual, [managedId, 'a', 'c', 'b'])
  actual = null
  await move({ id: managedId, toGroup: 'mine', toIndex: 0 })
  assert.equal(actual, null)
})
