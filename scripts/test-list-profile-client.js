const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const load = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const modulePath = path.join(root, 'src/main/modules/sync/client/modules/listProfile/index.ts')

const tick = () => new Promise(resolve => setImmediate(resolve))

const createProfileHarness = () => {
  let snapshot = { version: 1, listIds: ['one'], profiles: { one: { description: 'local' } } }
  const listeners = new Set()
  const listEvents = new EventEmitter()
  const calls = { apply: [], close: [] }
  global.lx = { event_list: listEvents }
  const profileModule = load(modulePath, {
    '@main/modules/sync/listProfileEvent': {
      getProfileSnapshot: async() => structuredClone(snapshot),
      applyProfileSnapshot: async(base, next, origin) => {
        calls.apply.push({ base: structuredClone(base), next: structuredClone(next) })
        snapshot = structuredClone(next)
        for (const listener of listeners) listener(origin)
        return structuredClone(snapshot)
      },
      onPlaylistMetadataChanged: listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    },
    '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4000 } },
  })
  const createSocket = request => {
    const closeHandlers = []
    return {
      moduleReadys: { list: true, listProfile: false },
      remoteQueueListProfile: { profile_sync_request: request ?? (async() => {}) },
      onClose(handler) { closeHandlers.push(handler); return () => {} },
      close(code) { calls.close.push(code) },
      closeHandlers,
    }
  }
  return {
    ...profileModule,
    calls,
    listeners,
    listEvents,
    createSocket,
    emitMetadata() { for (const listener of listeners) listener() },
    setSnapshot(value) { snapshot = structuredClone(value) },
  }
}

test('capability negotiation enables listProfile only beside compatible list:1', async() => {
  const handler = load(path.join(root, 'src/main/modules/sync/client/sync/handler.ts'), {
    '../modules': { featureVersion: { list: 1, dislike: 1, party: 1, userApi: 2, listProfile: 1 } },
  }).default
  const socket = {}
  assert.deepEqual(await handler.getEnabledFeatures(socket, 'server', { list: 1, listProfile: 1 }), {
    list: { skipSnapshot: false },
    listProfile: {},
  })
  assert.deepEqual(await handler.getEnabledFeatures(socket, 'server', { list: 2, listProfile: 1 }), {})
  assert.deepEqual(await handler.getEnabledFeatures(socket, 'server', { listProfile: 1 }), {})
})

test('profile handlers require list readiness and apply through the metadata adapter', async() => {
  const harness = createProfileHarness()
  const socket = harness.createSocket()
  socket.moduleReadys.list = false
  await assert.rejects(harness.handler.profile_sync_get(socket), /Playlist sync is not ready/)
  await assert.rejects(harness.handler.profile_sync_apply(socket, {}, {}), /Playlist sync is not ready/)
  socket.moduleReadys.list = true
  const base = { version: 1, listIds: ['one'], profiles: { one: { description: 'old' } } }
  const next = { version: 1, listIds: ['one'], profiles: { one: { description: 'remote', group: 'external' } } }
  assert.deepEqual(await harness.handler.profile_sync_get(socket), {
    version: 1, listIds: ['one'], profiles: { one: { description: 'local' } },
  })
  assert.deepEqual(await harness.handler.profile_sync_apply(socket, base, next), next)
  assert.deepEqual(harness.calls.apply, [{ base, next }])
})

test('remote apply does not request recursively, while a later local edit does', async() => {
  let requests = 0
  const harness = createProfileHarness()
  const socket = harness.createSocket(async() => { requests++ })
  await harness.handler.profile_sync_finished(socket)
  const base = { version: 1, listIds: ['one'], profiles: {} }
  const next = { version: 1, listIds: ['one'], profiles: { one: { coverUrl: 'https://example.com/cover' } } }
  await harness.handler.profile_sync_apply(socket, base, next)
  await tick()
  assert.equal(requests, 0)
  harness.emitMetadata()
  await tick()
  assert.equal(requests, 1)
})

test('notifications coalesce and retain an edit made during an RPC', async() => {
  let requests = 0
  let release
  const firstRequest = new Promise(resolve => { release = resolve })
  const harness = createProfileHarness()
  const socket = harness.createSocket(async() => {
    requests++
    if (requests === 1) await firstRequest
  })
  await harness.handler.profile_sync_finished(socket)
  harness.emitMetadata()
  harness.emitMetadata()
  await tick()
  assert.equal(requests, 1)
  harness.emitMetadata()
  release()
  await tick()
  await tick()
  assert.equal(requests, 2)
})

test('repeated finish keeps one listener and stale disconnect cleanup preserves the new socket', async() => {
  let oldRequests = 0
  let newRequests = 0
  const harness = createProfileHarness()
  const oldSocket = harness.createSocket(async() => { oldRequests++ })
  await harness.handler.profile_sync_finished(oldSocket)
  await harness.handler.profile_sync_finished(oldSocket)
  assert.equal(harness.listeners.size, 1)
  const newSocket = harness.createSocket(async() => { newRequests++ })
  await harness.handler.profile_sync_finished(newSocket)
  oldSocket.closeHandlers.forEach(handler => handler(new Error('old closed')))
  harness.emitMetadata()
  await tick()
  assert.equal(oldRequests, 0)
  assert.equal(newRequests, 1)
  assert.equal(harness.listeners.size, 1)
  newSocket.closeHandlers.forEach(handler => handler(new Error('new closed')))
  assert.equal(harness.listeners.size, 0)
})

test('client connection creates a profile queue and initializes profile readiness to false', async() => {
  let socket
  class FakeWebSocket {
    constructor() { socket = this; this.listeners = new Map() }
    on(name, handler) { this.addEventListener(name, handler) }
    addEventListener(name, handler) { this.listeners.set(name, handler) }
    close() {}
    send() {}
  }
  const queues = []
  const client = load(path.join(root, 'src/main/modules/sync/client/client.ts'), {
    ws: FakeWebSocket,
    './utils': { encryptMsg: async value => value, decryptMsg: async value => value },
    './sync': { callObj: {} },
    '../log': { info() {}, error() {} },
    '@common/utils/common': { arrRemove() {}, dateFormat: () => '' },
    '../utils': { aesEncrypt: value => value },
    '@main/modules/winMain': { sendClientStatus() {} },
    '@common/utils/syncRpc': {
      createSyncRpc: () => ({
        remote: {},
        createQueueRemote(name) { queues.push(name); return {} },
        message() {},
        destroy() {},
      }),
    },
    '@common/constants_sync': { SYNC_CLOSE_CODE: { normal: 1000, failed: 4000 } },
    '@common/utils/nodejs': { getAddress: () => [] },
    '@common/syncProtocol': { getSyncProtocol: () => ({ id: 'legacy', syncConnectMessage: 'connect' }) },
  })
  client.connect({ wsProtocol: 'ws:', hostPath: 'sync.test' }, { clientId: 'id', key: 'key', syncProtocol: 'legacy' })
  assert.ok(queues.includes('listProfile'))
  socket.listeners.get('open')()
  assert.equal(socket.moduleReadys.listProfile, false)
  await client.disconnect()
})

test('local edit after acknowledgement metadata is read still requests another sync round', async() => {
  const sync = require('../src/common/utils/listProfileSync')
  const { mergeMetadataUpdate } = require('../src/common/utils/playlistMetadataMerge')
  let metadata = { one: { updateTime: 0, isAutoUpdate: false, profile: { description: 'before', accountKey: 'local-only' } } }
  let listReads = 0
  let release
  let entered
  const barrier = new Promise(resolve => { release = resolve })
  const blocked = new Promise(resolve => { entered = resolve })
  global.lx = {
    event_list: new EventEmitter(),
    worker: {
      dbService: {
        getPlaylistMetadata: async() => structuredClone(metadata),
        getAllUserList: async() => {
          if (++listReads === 2) { entered(); await barrier }
          return [{ id: 'one' }]
        },
        applyPlaylistMetadata: async command => {
          metadata.one = mergeMetadataUpdate(metadata.one, command.value, command.base)
          return structuredClone(metadata)
        },
      },
    },
  }
  const adapter = load(path.join(root, 'src/main/modules/sync/listProfileEvent.ts'), {
    '@common/utils/listProfileSync': sync,
    '@common/utils/listProfile': require('../src/common/utils/listProfile'),
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: { storage_playlist_metadata_changed: 'changed' } },
    '@main/modules/winMain/main': { sendEvent() {} },
  })
  const client = load(modulePath, {
    '@main/modules/sync/listProfileEvent': adapter,
    '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4000 } },
  })
  let requests = 0
  const socket = { moduleReadys: { list: true, listProfile: false }, onClose() {}, close() {}, remoteQueueListProfile: { profile_sync_request: async() => { requests++ } } }
  await client.handler.profile_sync_finished(socket)
  const base = { version: 1, listIds: ['default', 'love', 'one'], profiles: { one: { description: 'before' } } }
  const pending = client.handler.profile_sync_apply(socket, base, { ...base, profiles: { one: { description: 'remote' } } })
  await blocked
  assert.equal(requests, 0, 'the remote apply itself should not echo')
  metadata.one.profile.description = 'new local edit'
  adapter.notifyPlaylistMetadataChanged(structuredClone(metadata))
  release()
  const acknowledged = await pending
  await tick()
  assert.equal(acknowledged.profiles.one.description, 'remote')
  assert.equal(metadata.one.profile.description, 'new local edit')
  assert.equal(metadata.one.profile.accountKey, 'local-only')
  assert.equal(requests, 1)
  client.unregisterEvent()
})
