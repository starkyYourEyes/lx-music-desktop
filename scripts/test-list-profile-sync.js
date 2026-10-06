const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const load = require('./test-utils/load-ts-module')
const sync = require('../src/common/utils/listProfileSync')
const { mergeMetadataUpdate } = require('../src/common/utils/playlistMetadataMerge')
const { createSyncRpc } = require('../src/common/utils/syncRpc')
const root = path.resolve(__dirname, '..')
const mobile = process.env.LX_MOBILE_PROJECT || path.resolve(root, '../lx-music-mobile')
const clone = value => JSON.parse(JSON.stringify(value))
const snapshot = (profile = {}, listIds = ['one']) => sync.normalizeSnapshot({ version: 1, listIds, profiles: { one: profile } })

test('profile merge preserves independent edits, explicit clears and omitted old fields', () => {
  const base = snapshot({ description: 'before', group: 'mine', coverUrl: 'https://example.com/old' })
  const desktop = snapshot({ ...base.profiles.one, group: 'external' })
  const phone = snapshot({ ...base.profiles.one, description: '' })
  assert.deepEqual(sync.mergeSnapshots(desktop, phone, base).profiles.one, { description: '', group: 'external', coverUrl: 'https://example.com/old' })
  assert.deepEqual(sync.mergeSnapshots(desktop, snapshot({}), base).profiles.one, desktop.profiles.one)
  assert.equal(sync.mergeSnapshots(snapshot({ description: 'desktop' }), snapshot({ description: 'phone' }), base, 'merge_remote_local').profiles.one.description, 'phone')
  assert.deepEqual(sync.normalizeSnapshot({ version: 1, listIds: [], profiles: { empty: {}, managed: { managed: true, accountKey: 'secret' } } }).profiles, {})
})

test('profile arriving before its list is retained; a confirmed list deletion removes it', () => {
  const incoming = snapshot({ group: 'external' }, [])
  assert.deepEqual(sync.mergeSnapshots(snapshot({}, []), incoming).profiles.one, { group: 'external' })
  assert.deepEqual(sync.mergeSnapshots(incoming, incoming, snapshot({ group: 'external' })).profiles, {})
  assert.throws(() => sync.normalizeSnapshot({ version: 2, listIds: [], profiles: {} }), /Invalid/)
  assert.throws(() => sync.normalizeSnapshot(JSON.parse('{"version":1,"listIds":[],"profiles":{"__proto__":{}}}')), /limits/)
})

test('a stale desktop save keeps remote fields and local account authority', () => {
  const base = { updateTime: 0, isAutoUpdate: false, profile: { description: 'old', group: 'mine', managed: true, provider: 'netease', kind: 'created', accountKey: 'local' } }
  const current = { ...base, profile: { ...base.profile, group: 'external' } }
  const result = mergeMetadataUpdate(current, { ...base, profile: { ...base.profile, description: 'edited' } }, base)
  assert.equal(result.profile.group, 'external')
  assert.equal(result.profile.description, 'edited')
  assert.equal(result.profile.accountKey, 'local')
})

const hasMobile = fs.existsSync(path.join(mobile, 'src/core/listProfile/index.ts'))
test('mobile and desktop share identical snapshot rules', { skip: !hasMobile }, () => {
  const phoneSync = require(path.join(mobile, 'src/core/listProfile/sync'))
  const cases = [snapshot({ description: 'd', group: 'mine' }), snapshot({ description: 'p', group: 'external' }), snapshot({ description: 'base' })]
  for (const mode of ['merge_local_remote', 'merge_remote_local', 'overwrite_local_remote', 'overwrite_remote_local']) {
    assert.deepEqual(phoneSync.mergeSnapshots(...cases, mode), sync.mergeSnapshots(...cases, mode))
  }
})

test('real mobile handlers and message2call exchange profiles with desktop, reconnect and retain edits made during RPC', { skip: !hasMobile }, async() => {
  const shared = new Map()
  const desktopLists = [{ id: 'one', name: 'One' }]
  let metadata = { one: { updateTime: 0, isAutoUpdate: false, profile: { description: 'initial', group: 'mine', managed: true, provider: 'netease', kind: 'created', accountKey: 'desktop-only' } } }
  let mobileDisk = { profiles: { one: { coverUrl: 'https://example.com/cover' } }, collapsed: {} }
  const mobileLists = { userList: [{ id: 'one', name: 'One' }] }
  const eventList = new EventEmitter()
  global.state_event = new EventEmitter()
  global.lx = { event_list: eventList, worker: { dbService: {
    getPlaylistMetadata: async() => clone(metadata),
    getAllUserList: async() => clone(desktopLists),
    applyPlaylistMetadata: async command => {
      metadata[command.playlistId] = mergeMetadataUpdate(metadata[command.playlistId], command.value, command.base)
      return clone(metadata)
    },
  } } }
  const phoneData = load(path.join(mobile, 'src/core/listProfile/index.ts'), {
    '@/utils/atomicSnapshot': { createAtomicSnapshot: () => ({ read: async() => clone(mobileDisk), write: async next => { mobileDisk = clone(next) } }) },
  })
  const profileEvent = load(path.join(root, 'src/main/modules/sync/listProfileEvent.ts'), {
    '@common/utils/listProfileSync': sync,
    '@common/utils/listProfile': require('../src/common/utils/listProfile'),
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: { storage_playlist_metadata_changed: 'changed' } },
    '@main/modules/winMain/main': { sendEvent() {} },
  })
  const server = load(path.join(root, 'src/main/modules/sync/server/modules/listProfile/index.ts'), {
    '@common/utils/listProfileSync': sync,
    '@main/modules/sync/listProfileEvent': profileEvent,
    '@main/utils/store': () => ({ get: key => shared.get(key), setDurable: async(key, value) => { shared.set(key, clone(value)) } }),
    '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4000 } },
  })
  const phoneModule = load(path.join(mobile, 'src/plugins/sync/client/modules/listProfile/index.ts'), {
    '@/core/listProfile': phoneData,
    '@/core/listProfile/sync': require(path.join(mobile, 'src/core/listProfile/sync')),
    '@/store/list/state': mobileLists,
    '@/plugins/sync/constants': { SYNC_CLOSE_CODE: { failed: 4000 } },
  })
  const { createMsg2call } = require(path.join(mobile, 'node_modules/message2call'))
  const settle = async check => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    assert.fail('Profile exchange did not converge')
  }
  let lateEdit
  const connect = async() => {
    const closers = []
    const socket = { readyState: 1, moduleReadys: { list: true, listProfile: false }, feature: { listProfile: {} }, userInfo: { name: 'default' }, keyInfo: { clientId: 'phone' }, close() { this.readyState = 3 } }
    const phoneSocket = { moduleReadys: { list: true, listProfile: false }, onClose: callback => { closers.push(callback) }, close() {} }
    let phoneRpc
    const serverRpc = createSyncRpc({ funcsObj: server.handler, timeout: 2000, wireProtocol: 'legacy', onCallBeforeParams: args => [socket, ...args], sendMessage: value => { phoneRpc.message(clone(value)) } })
    phoneRpc = createMsg2call({ funcsObj: {
      ...phoneModule.handler,
      async profile_sync_apply(...args) {
        if (lateEdit) { const edit = lateEdit; lateEdit = null; await edit() }
        return phoneModule.handler.profile_sync_apply(...args)
      },
    }, timeout: 2000, onCallBeforeParams: args => [phoneSocket, ...args], sendMessage: value => { void serverRpc.message(clone(value)) } })
    socket.remoteQueueListProfile = serverRpc.createQueueRemote('listProfile')
    phoneSocket.remoteQueueListProfile = phoneRpc.createQueueRemote('listProfile')
    server.registerEvent({ clients: new Set([socket]) })
    await server.sync(socket)
    await new Promise(resolve => setImmediate(resolve))
    return async() => {
      socket.readyState = 3
      socket.moduleReadys.listProfile = false
      phoneSocket.moduleReadys.listProfile = false
      server.unregisterEvent()
      closers.forEach(close => close())
      await new Promise(resolve => setTimeout(resolve, 15))
      serverRpc.destroy()
      phoneRpc.destroy()
    }
  }
  let disconnect = await connect()
  assert.equal((await phoneData.getListProfiles()).one.description, 'initial')
  assert.equal(metadata.one.profile.coverUrl, 'https://example.com/cover')
  assert.equal(metadata.one.profile.accountKey, 'desktop-only')
  assert.equal((await phoneData.getListProfiles()).one.managed, undefined)
  await phoneData.applyListProfiles({ one: { ...(await phoneData.getListProfiles()).one, description: 'phone edit' } })
  await settle(() => metadata.one.profile.description == 'phone edit')
  await disconnect()
  metadata.one.profile.group = 'external'
  await phoneData.applyListProfiles({ one: { ...(await phoneData.getListProfiles()).one, description: 'offline phone edit' } })
  lateEdit = async() => phoneData.applyListProfiles({ one: { ...(await phoneData.getListProfiles()).one, description: 'edited during RPC' } })
  disconnect = await connect()
  await settle(async() => metadata.one.profile.description == 'edited during RPC' && (await phoneData.getListProfiles()).one.group == 'external')
  assert.equal(shared.size, 1)
  // Both list modules removed the list while stale metadata still exists.
  desktopLists.splice(0)
  mobileLists.userList.splice(0)
  eventList.emit('list_remove', ['one'])
  await settle(async() => !sync.normalizeSnapshot({ version: 1, listIds: [], profiles: { one: metadata.one.profile } }).profiles.one && !(await phoneData.getListProfiles()).one)
  assert.equal(metadata.one.profile.accountKey, 'desktop-only')
  await disconnect()
})

test('failed peer acknowledgement leaves the last durable shared snapshot unchanged', async() => {
  const base = snapshot({ description: 'base' })
  let shared = { snapshot: base, mode: 'merge_local_remote' }
  let committed = false
  const server = load(path.join(root, 'src/main/modules/sync/server/modules/listProfile/index.ts'), {
    '@common/utils/listProfileSync': sync,
    '@main/modules/sync/listProfileEvent': {
      getProfileSnapshot: async() => snapshot({ description: 'new' }),
      applyProfileSnapshot: async(_base, next) => next,
    },
    '@main/utils/store': () => ({ get: () => shared, setDurable: async(_key, value) => { committed = true; shared = value } }),
    '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4000 } },
  })
  const socket = {
    readyState: 1, moduleReadys: { list: true, listProfile: false }, feature: { listProfile: {} },
    userInfo: { name: 'default' }, keyInfo: { clientId: 'phone' },
    remoteQueueListProfile: { profile_sync_get: async() => base, profile_sync_apply: async() => { throw new Error('disk full') } },
  }
  await assert.rejects(server.sync(socket), /disk full/)
  assert.equal(committed, false)
  assert.deepEqual(shared.snapshot, base)
  assert.equal(socket.moduleReadys.listProfile, false)
})

test('changing both sync capabilities starts list sync before profiles and disables both together', async() => {
  const order = []
  const socket = { feature: {}, moduleReadys: { list: false, listProfile: false } }
  const handler = load(path.join(root, 'src/main/modules/sync/server/server/sync/handler.ts'), {
    '../../modules': { modules: {
      list: { sync: async value => { order.push('list'); value.moduleReadys.list = true } },
      listProfile: { invalidate: value => { value.moduleReadys.listProfile = false; return () => true }, sync: async value => { assert.equal(value.moduleReadys.list, true); order.push('profile'); value.moduleReadys.listProfile = true } },
    } },
  }).default
  await handler.onFeatureChanged(socket, { list: {}, listProfile: {} })
  assert.deepEqual(order, ['list', 'profile'])
  await handler.onFeatureChanged(socket, { list: false, listProfile: false })
  assert.deepEqual(socket.moduleReadys, { list: false, listProfile: false })
  await handler.onFeatureChanged(socket, { list: {} })
  assert.deepEqual(order, ['list', 'profile', 'list'])
})
