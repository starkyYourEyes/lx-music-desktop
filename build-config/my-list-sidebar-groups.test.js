const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const groupStatePath = path.join(root, 'src/renderer/views/List/MyList/groupState.ts')
const groupActionsPath = path.join(root, 'src/renderer/views/List/MyList/groupActions.ts')
const useGroupsPath = path.join(root, 'src/renderer/views/List/MyList/useGroups.ts')

const loadGroupState = value => loadTsModule(groupStatePath, {
  '@common/utils/vueTools': {},
}).loadMyListGroupCollapsed({
  getItem: () => value,
})

test('collapse state accepts only a complete boolean object', () => {
  assert.deepEqual(loadGroupState(null), { mine: false, external: false })
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
    },
    '@renderer/store/list/state': { userLists },
    '@renderer/store/list/group': { userListGroups: { 'local-a': 'mine', 'local-b': 'mine', 'external-a': 'external', 'external-b': 'external' } },
  })

  await reorderUserListWithinGroup({ id: 'local-b', group: 'mine', toIndex: 0 })
  assert.deepEqual(userLists.map(list => list.id), ['local-b', 'local-a', 'external-a', 'external-b'])
  assert.deepEqual(updates, [{ id: 'local-b', position: 0 }])
})

test('revealing an eligible id expands its group then scrolls by stable id', async() => {
  const lists = [{ id: 'local' }, { id: 'external', source: 'wy', sourceListId: '42' }]
  const persisted = []
  const watches = []
  const scrolls = []
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
      userListRevealRequest: { value: null },
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
})
