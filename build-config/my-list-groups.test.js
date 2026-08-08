const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const modulePath = path.resolve(__dirname, '../src/common/listGroup.ts')
const loadGroups = () => loadTsModule(modulePath)
const list = (id, source, sourceListId) => ({ id, name: id, source, sourceListId, locationUpdateTime: null })

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
