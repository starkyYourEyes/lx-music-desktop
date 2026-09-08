const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const md5 = value => crypto.createHash('md5').update(value).digest('hex')
const deferred = () => {
  let resolveDeferred
  const promise = new Promise(resolve => { resolveDeferred = resolve })
  return { promise, resolve: resolveDeferred }
}
const harness = ({ existing = [], fetch = async() => [{ id: 'song' }], overwrite, saveTime } = {}) => {
  const calls = []
  const { importSourceList } = loadTsModule(path.join(root, 'src/renderer/store/list/importSourceList.ts'), {
    './state': { userLists: existing },
    '@renderer/store/songList/action': { getListDetailAll: async(...args) => { calls.push(['fetch', ...args]); return fetch() } },
    './action': {
      createUserList: async data => { calls.push(['create', data]); return data.id },
      overwriteListMusics: async data => { calls.push(['overwrite', data]); if (overwrite) await overwrite() },
      setUpdateTime: (...args) => calls.push(['displayTime', ...args]),
    },
    '@renderer/utils/data': { setListUpdateTime: async(...args) => { calls.push(['saveTime', ...args]); if (saveTime) await saveTime() } },
    '@common/utils/common': { dateFormat: value => String(value) },
    '@renderer/utils': { toMD5: md5 },
  })
  return { importSourceList, calls }
}

test('online import resolves songs by the platform ID and uses the existing stable local ID', async() => {
  const { importSourceList, calls } = harness()
  const expectedId = `wy_${md5('wy__42')}`
  assert.equal(await importSourceList({ sourceListId: '42', source: 'wy', name: 'My playlist' }), expectedId)
  assert.deepEqual(calls[0], ['fetch', '42', 'wy', false])
  assert.deepEqual(calls[1], ['create', { id: expectedId, name: 'My playlist', list: [{ id: 'song' }], source: 'wy', sourceListId: '42', reveal: true }])
  assert.deepEqual(calls.slice(2).map(call => call[0]), ['saveTime', 'displayTime'])
})

test('background platform imports update their existing managed list and preserve its ID', async() => {
  const id = 'platform:netease:1:created:42'
  const { importSourceList, calls } = harness({ existing: [{ id }], fetch: async() => [] })
  assert.equal(await importSourceList({ id, sourceListId: '42', source: 'wy', reveal: false }), id)
  assert.deepEqual(calls[0], ['fetch', '42', 'wy', true])
  assert.deepEqual(calls[1], ['overwrite', { listId: id, musicInfos: [] }])
  assert.deepEqual(calls.slice(2).map(call => call[0]), ['saveTime', 'displayTime'])
})

test('new background imports suppress automatic list reveal', async() => {
  const { importSourceList, calls } = harness()
  await importSourceList({ id: 'managed', sourceListId: '42', source: 'wy', reveal: false })
  assert.equal(calls.find(call => call[0] == 'create')[1].reveal, false)
})

test('an expired account request does not import songs or update completion time', async() => {
  const response = deferred()
  let current = true
  const { importSourceList, calls } = harness({ fetch: () => response.promise })
  const importing = importSourceList({ sourceListId: '42', source: 'wy', canCommit: () => current })
  current = false
  response.resolve([{ id: 'private-song' }])
  assert.equal(await importing, undefined)
  assert.deepEqual(calls.map(call => call[0]), ['fetch'])
})

test('a fetch failure leaves existing songs and completion time untouched', async() => {
  const { importSourceList, calls } = harness({ existing: [{ id: 'managed' }], fetch: async() => { throw new Error('unavailable') } })
  await assert.rejects(importSourceList({ id: 'managed', sourceListId: '42', source: 'wy' }), /unavailable/)
  assert.deepEqual(calls.map(call => call[0]), ['fetch'])
})

test('import completion waits for song persistence and timestamp persistence', async() => {
  const write = deferred()
  const saveTime = deferred()
  const { importSourceList, calls } = harness({ existing: [{ id: 'managed' }], overwrite: () => write.promise, saveTime: () => saveTime.promise })
  let done = false
  const importing = importSourceList({ id: 'managed', sourceListId: '42', source: 'wy' }).then(() => { done = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  assert.equal(calls.some(call => call[0] == 'saveTime'), false)
  write.resolve()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(done, false)
  saveTime.resolve()
  await importing
  assert.equal(done, true)
})

test('manual online import confirms only an existing ordinary playlist from the same platform', async() => {
  const calls = []
  const userLists = [
    { id: 'platform:netease:1:created:42', source: 'wy', sourceListId: '42' },
    { id: 'other-platform', source: 'tx', sourceListId: '42' },
    { id: 'ordinary', name: 'Existing', source: 'wy', sourceListId: '42' },
  ]
  global.window = { i18n: { t: key => key } }
  const { addSongListDetail } = loadTsModule(path.join(root, 'src/renderer/views/songList/Detail/action.ts'), {
    '@renderer/store/list/state': { tempListMeta: {}, userLists },
    '@renderer/plugins/Dialog': { dialog: { confirm: async() => { calls.push(['confirm']); return true } } },
    '@renderer/store/list/importSourceList': { importSourceList: async args => calls.push(['import', args]) },
    '@renderer/store/list/syncSourceList': { __esModule: true, default: async() => calls.push(['legacySync']) },
    '@renderer/store/songList/action': {},
    '@renderer/store/list/action': {},
    '@renderer/core/player/action': {},
    '@common/constants': { LIST_IDS: {} },
    '@renderer/utils': { toMD5: md5 },
    '@renderer/store/dailyRecommend/state': {},
    '@renderer/store/qqMusic': {},
    '@renderer/store/qqDailyRecommend/action': {},
    '@renderer/store/qqDailyRecommend/state': {},
  })
  await addSongListDetail('42', 'wy', 'Remote name')
  assert.deepEqual(calls, [['confirm'], ['import', { id: 'ordinary', sourceListId: '42', source: 'wy', name: 'Existing' }]])
})
