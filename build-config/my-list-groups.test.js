const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const modulePath = path.resolve(__dirname, '../src/common/listGroup.ts')
const groupStorePath = path.resolve(__dirname, '../src/renderer/store/list/group.ts')
const actionPath = path.resolve(__dirname, '../src/renderer/store/list/action.ts')
const loadGroups = () => loadTsModule(modulePath)
const list = (id, source, sourceListId) => ({ id, name: id, source, sourceListId, locationUpdateTime: null })
const commonGroups = loadGroups()

const loadGroupStore = ({ metadata = {}, setProfile = async() => {}, errors = [] } = {}) => loadTsModule(groupStorePath, {
  '@common/utils/vueTools': { reactive: value => value, ref: value => ({ value }) },
  '@common/listGroup': commonGroups,
  '@common/utils': { log: { error: error => errors.push(error) } },
  '@renderer/utils/data': {
    getListUpdateInfo: async() => metadata,
    setUserListProfile: setProfile,
  },
})

const loadListAction = ({ metadata = {}, setProfile = async() => {}, errors = [], addMusic = async() => {} } = {}) => {
  const groupStore = loadGroupStore({ metadata, setProfile, errors })
  const lowLevelCreates = []
  const userLists = []
  const action = loadTsModule(actionPath, {
    '@renderer/store/setting': { appSetting: { 'list.addMusicLocationType': 'append' } },
    './state': { fetchingListStatus: {}, listUpdateTimes: {}, allMusicList: new Map(), userLists, tempListMeta: {} },
    '@renderer/store/list/listManage': {
      registerListAction: () => () => {},
      createUserList: async payload => { lowLevelCreates.push(payload) },
      addListMusics: addMusic,
      moveListMusics: async() => {},
      overwriteListMusics: async() => {},
    },
    '@renderer/store/list/listManage/action': { setMusicList: () => [] },
    '@common/utils/vueTools': { toRaw: value => value },
    '@common/constants': { LIST_IDS: { DEFAULT: 'default', LOVE: 'love', WEBDAV: 'webdav', TEMP: 'temp' } },
    '@renderer/utils/ipc': {
      likeNeteaseMusic: async() => {},
      likeQQMusic: async() => {},
      listWebDAVMusics: async() => [],
      uploadLocalMusicToWebDAV: async music => music,
    },
    '@common/listGroup': commonGroups,
    '@common/utils': { log: { error: error => errors.push(error) } },
    './group': groupStore,
  })
  return { action, groupStore, lowLevelCreates, userLists, addMusic }
}

test('explicit groups win and missing groups derive from source metadata', () => {
  const { resolveUserListGroup } = loadGroups()
  assert.equal(resolveUserListGroup(list('local'), 'external'), 'external')
  assert.equal(resolveUserListGroup(list('online', 'wy', '42'), undefined), 'external')
  assert.equal(resolveUserListGroup(list('partial', undefined, '42'), undefined), 'external')
  assert.equal(resolveUserListGroup(list('local'), undefined), 'mine')
  assert.equal(resolveUserListGroup(list('local'), 'unknown'), 'mine')
})

test('partitioning keeps source position order inside each group', () => {
  const { partitionUserLists } = loadGroups()
  const lists = [list('mine-a'), list('ext-a'), list('mine-b'), list('ext-b')]
  const groups = { 'mine-a': 'mine', 'ext-a': 'external', 'mine-b': 'mine', 'ext-b': 'external' }
  const result = partitionUserLists(lists, item => groups[item.id])
  assert.deepEqual(result.mine.map(item => item.id), ['mine-a', 'mine-b'])
  assert.deepEqual(result.external.map(item => item.id), ['ext-a', 'ext-b'])
})

test('moving across groups returns one normalized exact order', () => {
  const { buildMovedUserListOrder } = loadGroups()
  const lists = [list('mine-a'), list('ext-a'), list('mine-b'), list('ext-b')]
  const groups = { 'mine-a': 'mine', 'ext-a': 'external', 'mine-b': 'mine', 'ext-b': 'external' }
  assert.deepEqual(
    buildMovedUserListOrder(lists, groups, 'ext-a', 'mine', 1),
    ['mine-a', 'ext-a', 'mine-b', 'ext-b'],
  )
  assert.deepEqual(
    buildMovedUserListOrder(lists, groups, 'mine-b', 'external', 1),
    ['mine-a', 'ext-a', 'mine-b', 'ext-b'],
  )
})

test('target indexes are clamped and an unknown ID is a no-op', () => {
  const { buildMovedUserListOrder } = loadGroups()
  const lists = [list('mine-a'), list('ext-a')]
  const groups = { 'mine-a': 'mine', 'ext-a': 'external' }
  assert.deepEqual(buildMovedUserListOrder(lists, groups, 'ext-a', 'mine', -9), ['ext-a', 'mine-a'])
  assert.deepEqual(buildMovedUserListOrder(lists, groups, 'mine-a', 'external', 99), ['ext-a', 'mine-a'])
  assert.deepEqual(buildMovedUserListOrder(lists, groups, 'missing', 'mine', 0), ['mine-a', 'ext-a'])
})

test('initialization honors stored groups without persisting inferred display groups', async() => {
  const writes = []
  const module = loadGroupStore({
    metadata: { stored: { updateTime: 0, isAutoUpdate: false, profile: { group: 'external' } } },
    setProfile: async(id, profile) => writes.push({ id, profile }),
  })
  await module.initializeUserListGroups([list('stored'), list('online', 'wy', '42'), list('local')])
  assert.deepEqual(module.userListGroups, { stored: 'external', online: 'external', local: 'mine' })
  assert.deepEqual(writes, [])
})

test('a newly synced playlist cannot manufacture a conflicting group before its profile arrives', async() => {
  const metadata = {}
  const writes = []
  const module = loadGroupStore({ metadata, setProfile: async(id, profile) => writes.push({ id, profile }) })
  await module.ensureUserListGroups([list('phone-list')])
  assert.equal(module.getUserListGroup(list('phone-list')), 'mine')
  metadata['phone-list'] = { updateTime: 0, isAutoUpdate: false, profile: { group: 'external' } }
  await module.ensureUserListGroups([list('phone-list')])
  assert.equal(module.getUserListGroup(list('phone-list')), 'external')
  assert.deepEqual(writes, [])
})

test('reveal request consumption clears only the token it was given', () => {
  const module = loadGroupStore()
  module.requestUserListReveal('first')
  const first = module.userListRevealRequest.value
  module.requestUserListReveal('second')
  const second = module.userListRevealRequest.value

  assert.equal(module.consumeUserListRevealRequest?.(first), false)
  assert.deepEqual(module.userListRevealRequest.value, second)
  assert.equal(module.consumeUserListRevealRequest?.(second), true)
  assert.equal(module.userListRevealRequest.value, null)
})

test('creation persists derived and explicit groups without adding group to list payloads', async() => {
  const writes = []
  const { action, groupStore, lowLevelCreates } = loadListAction({
    setProfile: async(id, profile) => writes.push({ id, profile }),
  })

  assert.equal(await action.createUserList({ id: 'local', name: 'Local' }), 'local')
  assert.equal(await action.createUserList({ id: 'remote', name: 'Remote', source: 'wy', sourceListId: '42' }), 'remote')
  assert.equal(await action.createUserList({ id: 'single-import', name: 'Import', source: 'wy', sourceListId: '7', group: 'mine' }), 'single-import')

  assert.deepEqual(writes, [
    { id: 'local', profile: { group: 'mine' } },
    { id: 'remote', profile: { group: 'external' } },
    { id: 'single-import', profile: { group: 'mine' } },
  ])
  assert.deepEqual(groupStore.userListGroups, { local: 'mine', remote: 'external', 'single-import': 'mine' })
  assert.deepEqual(lowLevelCreates.map(({ listInfos }) => listInfos[0]), [
    { id: 'local', name: 'Local', source: undefined, sourceListId: undefined, locationUpdateTime: null },
    { id: 'remote', name: 'Remote', source: 'wy', sourceListId: '42', locationUpdateTime: null },
    { id: 'single-import', name: 'Import', source: 'wy', sourceListId: '7', locationUpdateTime: null },
  ])
  assert.deepEqual(groupStore.userListRevealRequest.value, { id: 'single-import', token: 3 })
})

test('ordinary creation survives profile persistence failure and reveals after music writes', async() => {
  const errors = []
  const sequence = []
  const { action, groupStore } = loadListAction({
    errors,
    setProfile: async() => { throw new Error('profile write failed') },
    addMusic: async() => { sequence.push('music') },
  })
  const originalRequestReveal = groupStore.requestUserListReveal
  groupStore.requestUserListReveal = id => {
    sequence.push(`reveal:${id}`)
    originalRequestReveal(id)
  }
  const createdId = await action.createUserList({ id: 'with-music', list: [{ id: 'track' }] })

  assert.equal(createdId, 'with-music')
  assert.equal(groupStore.userListGroups['with-music'], 'mine')
  assert.equal(errors.length, 1)
  assert.deepEqual(groupStore.userListRevealRequest.value, { id: 'with-music', token: 1 })
  groupStore.requestUserListReveal('with-music')
  assert.deepEqual(groupStore.userListRevealRequest.value, { id: 'with-music', token: 2 })
  assert.deepEqual(sequence.slice(0, 2), ['music', 'reveal:with-music'])
  groupStore.requestUserListReveal = originalRequestReveal
})

test('strict source-less import rejects a group write failure before music and reveal', async() => {
  const profileError = new Error('profile write failed')
  const sequence = []
  const { action, groupStore, lowLevelCreates } = loadListAction({
    setProfile: async() => { throw profileError },
    addMusic: async() => { sequence.push('music') },
  })

  await assert.rejects(() => action.createUserList({
    id: 'source-less-import',
    group: 'external',
    strictGroupPersistence: true,
    list: [{ id: 'track' }],
  }), error => error === profileError)

  assert.equal(lowLevelCreates.length, 1)
  assert.deepEqual(sequence, [])
  assert.equal(groupStore.userListRevealRequest.value, null)
})

test('ensure derives newly synced groups, retains manual assignments, removes stale cache, and never requests reveal', async() => {
  const writes = []
  const module = loadGroupStore({
    metadata: { retained: { updateTime: 0, isAutoUpdate: false, profile: { group: 'mine' } } },
    setProfile: async(id, profile) => writes.push({ id, profile }),
  })
  module.cacheUserListGroup('removed', 'external')
  await module.ensureUserListGroups([list('retained', 'wy', '42'), list('observed', 'wy', '7')])

  assert.deepEqual(module.userListGroups, { retained: 'mine', observed: 'external' })
  assert.deepEqual(writes, [])
  assert.equal(module.userListRevealRequest.value, null)
})
