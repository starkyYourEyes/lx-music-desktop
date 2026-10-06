const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('../../scripts/test-utils/load-ts-module')

const loadListCovers = () => load('src/renderer/views/List/MyList/useListCovers.ts', {
  '@common/utils/vueTools': { ref: value => ({ value }) },
  '@renderer/store/list/action': {},
}).useListCovers

for (const operation of ['add', 'clear', 'overwrite', 'remove', 'update', 'update_position']) {
  test(`IPC ${operation} refreshes the cover of an evicted list`, async() => {
    const constants = { LIST_IDS: { DEFAULT: 'default', LOVE: 'love', TEMP: 'temp' } }
    const mocks = { '@common/constants': constants, '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value, toRaw: value => value, reactive: value => value } }
    const state = load('src/renderer/store/list/listManage/state.ts', mocks)
    state.allMusicList.configure({ maxEntries: 3 })
    const action = load('src/renderer/store/list/listManage/action.ts', { ...mocks, './state': state, '@renderer/utils/data': {}, '@common/utils/common': { arrPush: (target, items) => target.push(...items), arrUnshift: (target, items) => target.unshift(...items) } })
    const handlers = {}
    const events = new Proxy({}, { get: (_, key) => key })
    const api = load('src/renderer/store/list/listManage/rendererListManage.ts', { ...mocks, './state': state, './action': action, '@common/ipcNames': { PLAYER_EVENT_NAME: events }, '@common/rendererIpc': { rendererOn: (name, fn) => { handlers[name] = fn }, rendererOff() {} } })
    const disk = new Map('abcdef'.split('').map(id => [id, [{ id: 'first', meta: { picUrl: `old:${id}` } }]]))
    const covers = loadListCovers()({ getListMusics: async id => { const list = disk.get(id); state.allMusicList.set(id, list); return list } })
    await covers.preload([...disk.keys()])
    assert.equal(state.allMusicList.has('a'), false)
    let refresh
    api.registerListAction({}, ids => { refresh = covers.refresh(ids) })
    const musicInfo = { id: 'new', meta: { picUrl: 'new:a' } }
    disk.set('a', operation == 'clear' ? [] : [musicInfo])
    const params = { add: { id: 'a', musicInfos: [musicInfo], addMusicLocationType: 'top' }, clear: ['a'], overwrite: { listId: 'a', musicInfos: [musicInfo] }, remove: { listId: 'a', ids: ['first'] }, update: [{ id: 'a', musicInfo }], update_position: { listId: 'a', position: 0, ids: ['new'] } }[operation]
    handlers[`list_music_${operation}`]({ params })
    await Promise.resolve()
    await refresh
    assert.equal(covers.get('a'), operation == 'clear' ? '' : 'new:a')
  })
}

test('list covers survive compact music cache eviction and retain only cover strings', async() => {
  const state = load('src/renderer/store/list/listManage/state.ts', {
    '@common/constants': { LIST_IDS: {} }, '@common/utils/vueTools': { markRaw: value => value, reactive: value => value },
  })
  state.allMusicList.configure({ maxEntries: 3 })
  const ids = Array.from({ length: 6 }, (_, i) => String(i))
  const covers = loadListCovers()({ getListMusics: async id => {
    const list = [{ meta: { picUrl: `cover:${id}` } }, { meta: {} }]
    state.allMusicList.set(id, list)
    return list
  } })
  await covers.preload(ids)
  assert.equal(state.allMusicList.size, 3)
  for (const id of ids) assert.equal(covers.get(id), `cover:${id}`)
  state.allMusicList.get('5')[0].meta.picUrl = 'changed'
  assert.equal(covers.get('5'), 'cover:5')
  assert.equal(covers.version.value, 6)
})

test('list cover reads publish immediately, isolate failures, refresh and remove safely', async() => {
  const pending = []
  const covers = loadListCovers()({ getListMusics: id => new Promise((resolve, reject) => { pending.push({ id, resolve, reject }) }) })
  const initial = covers.preload(['a', 'b', 'c'])
  pending[0].resolve([{ meta: { picUrl: 'old' } }])
  await Promise.resolve()
  assert.equal(covers.get('a'), 'old')
  const refresh = covers.refresh(['a', 'b'])
  pending[3].resolve([])
  pending[4].resolve([{ meta: { picUrl: 'fresh' } }])
  await refresh
  pending[1].reject(new Error('stale failure'))
  covers.remove(['c'])
  pending[2].resolve([{ meta: { picUrl: 'removed' } }])
  await initial
  assert.equal(covers.get('a'), '')
  assert.equal(covers.get('b'), 'fresh')
  assert.equal(covers.get('c'), '')
  const failed = covers.refresh(['b', 'c'])
  pending[5].reject(new Error('read failed'))
  pending[6].resolve([{ meta: { picUrl: 'restored' } }])
  await failed
  assert.equal(covers.get('b'), '')
  assert.equal(covers.get('c'), 'restored')
  const removed = covers.refresh(['c'])
  covers.remove(['c'])
  pending[7].resolve([{ meta: { picUrl: 'stale' } }])
  await removed
  assert.equal(covers.get('c'), '')
})

test('artwork cache evicts beyond compact capacity and clear blocks stale result refill', async() => {
  const { createArtworkSession } = load('src/renderer/components/common/TrackArtwork/artworkSession.ts', { '@renderer/core/music': {} })
  let calls = 0
  const session = createArtworkSession(async music => { calls++; return `url:${music.id}` })
  const music = id => ({ id, source: 'wy', meta: {} })
  for (let id = 0; id < 257; id++) await session.resolve(music(id))
  assert.equal(session.peek(music(0)), undefined)
  assert.equal(session.peek(music(256)), 'url:256')
  await session.resolve(music(0))
  assert.equal(calls, 258)
  let finish
  const slow = createArtworkSession(async() => new Promise(resolve => { finish = resolve }))
  const request = slow.resolve(music(1))
  slow.clear()
  finish('stale')
  await request
  assert.equal(slow.peek(music(1)), undefined)
  session.clear()
})

test('local list cache preserves leased array identity while bounding inactive lists and songs', () => {
  const state = load('src/renderer/store/list/listManage/state.ts', {
    '@common/constants': { LIST_IDS: {} }, '@common/utils/vueTools': { markRaw: value => value, reactive: value => value },
  })
  const active = Array(5000)
  const release = state.retainMusicList('active')
  state.allMusicList.set('active', active)
  for (let id = 0; id < 8; id++) state.allMusicList.set(String(id), Array(500))
  assert.equal(state.allMusicList.get('active'), active)
  assert.equal(state.allMusicList.size, 4)
  assert.equal(state.allMusicList.has('0'), false)
  state.allMusicList.set('huge', Array(2001))
  assert.equal(state.allMusicList.has('huge'), false)
  release()
  assert.equal(state.allMusicList.has('active'), false)
})

test('playback URLs bound validated memory and preserve tombstones after failed persistent deletion', async() => {
  const { createPlaybackUrlCache } = load('src/renderer/core/music/playback/cache.ts', { '@renderer/utils/ipc': {} })
  const memory = new Map()
  const key = id => ({ authorization: { version: 1, provider: 'wy', accountScope: 'account', generation: 1 }, sourceTrackId: String(id), quality: '128k' })
  const persisted = new Map()
  let failed = false
  const cache = createPlaybackUrlCache({ memory, read: async k => persisted.get(k.sourceTrackId), save: async(k, value) => { persisted.set(k.sourceTrackId, value) }, remove: async k => { if (failed) throw new Error('delete failed'); persisted.delete(k.sourceTrackId) } })
  for (let id = 0; id < 130; id++) await cache.commit(key(id), `url:${id}`)
  assert.equal(memory.size, 128)
  assert.equal((await cache.lookup(key(0))).provisional, true)
  failed = true
  await assert.rejects(cache.tombstoneKey(key(129)))
  cache.configure(1)
  assert.equal(memory.size, 1)
  assert.equal(await cache.lookup(key(129)), null)
  failed = false
  await cache.tombstoneKey(key(129))
  await cache.commit(key(129), 'fresh')
  assert.equal((await cache.lookup(key(129))).url, 'fresh')
})

test('online playlist browsing bounds results, rejects oversized details and blocks refill after clear', async() => {
  let calls = 0
  let finish
  const profile = load('src/common/performance/cacheProfile.ts')
  const dependencies = {
    '@common/performance/cacheProfile': profile,
    '@renderer/utils': { deduplicationList: value => value, toNewMusicInfo: value => value },
    '@renderer/utils/musicSdk': { __esModule: true, default: { kg: { songList: { getListDetail: async id => { calls++; return id == 'pending' ? new Promise(resolve => { finish = resolve }) : { list: Array.from({ length: id == 'huge' ? 2001 : 1 }, () => ({ id })), source: 'kg' } } } } } },
    '@renderer/utils/ipc': {},
    '@renderer/store/qqMusic': {},
    '@renderer/store/dailyRecommend/action': {},
    '@renderer/store/dailyRecommend/state': {},
    '@renderer/store/qqDailyRecommend/action': {},
    '@renderer/store/qqDailyRecommend/state': {},
    '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value },
    './state': {},
  }
  const api = load('src/renderer/store/songList/action.ts', dependencies)
  for (let id = 0; id < 21; id++) await api.getListDetail(String(id), 'kg', 1)
  await api.getListDetail('20', 'kg', 1)
  assert.equal(calls, 21)
  await api.getListDetail('0', 'kg', 1)
  assert.equal(calls, 22)
  await api.getListDetail('huge', 'kg', 1)
  await api.getListDetail('huge', 'kg', 1)
  assert.equal(calls, 24)
  const pending = api.getListDetail('pending', 'kg', 1)
  api.clearSongListCache()
  finish({ list: [], source: 'kg' })
  await pending
  const next = api.getListDetail('pending', 'kg', 1)
  assert.equal(calls, 26)
  finish({ list: [], source: 'kg' })
  await next
  api.clearSongListCache()
})

test('concurrent local reads share array and cannot overwrite an intervening list mutation', async() => {
  const mocks = {
    '@common/constants': { LIST_IDS: {} }, '@common/utils/vueTools': { markRaw: value => value, markRawList: value => value, reactive: value => value },
  }
  const state = load('src/renderer/store/list/listManage/state.ts', mocks)
  let finish
  let calls = 0
  const module = load('src/renderer/store/list/listManage/rendererListManage.ts', {
    ...mocks,
    './state': state,
    '@common/rendererIpc': { rendererInvoke: async() => { calls++; return new Promise(resolve => { finish = resolve }) } },
    '@common/ipcNames': { PLAYER_EVENT_NAME: {} },
    './action': { setMusicList: (id, list) => { state.allMusicList.set(id, list); return list } },
  })
  const a = module.getListMusics('a')
  const b = module.getListMusics('a')
  assert.equal(calls, 1)
  state.invalidateMusicListReads()
  const edited = [{ id: 'edited' }]
  state.allMusicList.set('a', edited)
  finish([{ id: 'stale' }])
  assert.equal(await a, edited)
  assert.equal(await b, edited)
  assert.equal(state.allMusicList.get('a'), edited)
})

test('lowering the saved profile immediately shrinks inactive lists while preserving live WebDAV state', () => {
  const profile = load('src/common/performance/cacheProfile.ts')
  profile.applyCacheProfile('generous')
  const state = load('src/renderer/store/list/listManage/state.ts', {
    '@common/performance/cacheProfile': profile,
    '@common/constants': { LIST_IDS: { WEBDAV: 'webdav' } },
    '@common/utils/vueTools': { markRaw: value => value, reactive: value => value },
  })
  const webdav = Array(3000)
  state.allMusicList.set('webdav', webdav)
  for (let id = 0; id < 15; id++) state.allMusicList.set(String(id), Array(50))
  assert.equal(state.allMusicList.size, 16)
  profile.applyCacheProfile('compact')
  assert.equal(state.allMusicList.size, 4)
  assert.equal(state.allMusicList.get('webdav'), webdav)
  assert.equal(state.allMusicList.has('14'), true)
})
