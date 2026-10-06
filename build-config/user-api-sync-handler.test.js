const assert = require('node:assert/strict')
const path = require('node:path')
const { it } = require('node:test')
const load = require('../scripts/test-utils/load-ts-module')
const utils = require('../src/common/utils/userApiSync')

const api = id => ({ id, name: id, description: '', author: '', homepage: '', version: '1', script: 'fixture script', scriptEncoding: 'plain' })
const harness = (permission, failLog = false) => {
  let data = { source: 'desktop', updatedAt: 1, apis: [] }
  const logs = []
  const accesses = []
  const settings = { 'sync.server.allowUserApiPush': permission }
  const events = {
    getLocalUserApiData: async() => { accesses.push('read'); return structuredClone(data) },
    getLocalUserApiMeta: async() => { accesses.push('meta'); return utils.createUserApiSyncMeta(data) },
    setLocalUserApiData: async(value) => { accesses.push('write'); data = structuredClone(value) },
    handleRemoteUserApiAction: async() => {},
  }
  const handler = load(path.join(__dirname, '../src/main/modules/sync/server/modules/userApi/sync/handler.ts'), {
    '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 1 } },
    '@common/utils/userApiSync': utils,
    '@main/modules/sync/userApiEvent': events,
    '@main/modules/sync/log': { info: (...args) => { if (failLog) throw new Error('fixture log failure'); logs.push(args) } },
  }).default
  const socket = {
    feature: { userApi: { skipSnapshot: true } },
    moduleReadys: { userApi: true },
    userInfo: { name: 'test user' },
    keyInfo: { clientId: 'fixture-client', deviceName: 'fixture device' },
    broadcast: () => {},
    isReady: true,
  }
  return { handler, socket, settings, events, logs, accesses, data: () => data }
}

const withHarness = async(permission, run, failLog = false) => {
  const previous = global.lx
  const h = harness(permission, failLog)
  global.lx = { appSetting: h.settings }
  try { await run(h) } finally { global.lx = previous }
}

it('rejects all entry points before negotiation or readiness without changing data', async() => {
  await withHarness(true, async(h) => {
    for (const state of [{ feature: {} }, { moduleReadys: {} }]) {
      const socket = { ...h.socket, ...state }
      await assert.rejects(h.handler.user_api_get_meta(socket), /userApi sync is not ready/)
      await assert.rejects(h.handler.user_api_pull(socket, 'overwrite'), /userApi sync is not ready/)
      await assert.rejects(h.handler.user_api_push(socket, h.data(), 'overwrite'), /userApi sync is not ready/)
      assert.equal(h.data().updatedAt, 1)
    }
    assert.equal(h.logs.length, 0)
    assert.deepEqual(h.accesses, [])
  })
})

it('fails closed for false or absent permission while pull and meta remain available', async() => {
  for (const permission of [false, undefined, 'true', 1]) {
    await withHarness(permission, async(h) => {
      await assert.rejects(h.handler.user_api_push(h.socket, h.data(), 'overwrite'), /user_api_push_not_allowed/)
      assert.deepEqual(h.accesses, [])
      assert.deepEqual(await h.handler.user_api_pull(h.socket, 'overwrite'), h.data())
      assert.deepEqual(await h.handler.user_api_get_meta(h.socket), utils.createUserApiSyncMeta(h.data()))
      assert.equal(h.data().updatedAt, 1)
      assert.equal(h.logs.length, 0)
    })
  }
})

it('accepts merge and overwrite after opt-in and logs identity, count and md5', async() => {
  await withHarness(true, async(h) => {
    for (const mode of ['merge', 'overwrite']) {
      const incoming = { source: 'desktop', updatedAt: 2, apis: [api(mode)] }
      const meta = await h.handler.user_api_push(h.socket, incoming, mode)
      assert.deepEqual(meta, utils.createUserApiSyncMeta(h.data()))
      assert.ok(h.data().updatedAt > 1)
      assert.deepEqual(h.logs.at(-1), ['user_api_push accepted', { deviceName: 'fixture device', clientId: 'fixture-client', count: meta.count, md5: meta.md5 }])
      assert.deepEqual(h.data().apis.map(item => item.id), [mode])
    }
  })
})

it('preserves merge contents, and a logging failure does not reject an accepted push', async() => {
  await withHarness(true, async(h) => {
    await h.events.setLocalUserApiData({ source: 'desktop', updatedAt: 1, apis: [api('existing')] })
    const incoming = { source: 'desktop', updatedAt: 2, apis: [api('incoming')] }
    const pulled = await h.handler.user_api_pull(h.socket, 'merge', incoming)
    assert.deepEqual(new Set(pulled.apis.map(item => item.id)), new Set(['existing', 'incoming']))
    const meta = await h.handler.user_api_push(h.socket, incoming, 'merge')
    assert.equal(meta.count, 2)
    assert.deepEqual(new Set(h.data().apis.map(item => item.id)), new Set(['existing', 'incoming']))
  }, true)
})

it('propagates receiver refusal through the sender service', async() => {
  await withHarness(false, async(h) => {
    h.socket.remoteQueueUserApi = { user_api_push: (...args) => h.handler.user_api_push(h.socket, ...args) }
    const service = load(path.join(__dirname, '../src/main/modules/sync/client/modules/userApi/service.ts'), {
      '../../client': { getClient: () => h.socket },
      '@main/modules/sync/userApiEvent': h.events,
      '@common/utils/userApiSync': utils,
    })
    await assert.rejects(service.pushUserApiToServer('merge'), /user_api_push_not_allowed/)
    assert.equal(h.data().updatedAt, 1)
  })
})

it('finishes negotiation without calling the guarded data entry points', async() => {
  await withHarness(false, async(h) => {
    h.socket.moduleReadys.userApi = false
    h.socket.remoteQueueUserApi = { user_api_sync_finished: async() => {} }
    const { sync } = load(path.join(__dirname, '../src/main/modules/sync/server/modules/userApi/sync/sync.ts'))
    await sync(h.socket)
    assert.equal(h.socket.moduleReadys.userApi, true)
    assert.deepEqual(h.accesses, [])
    assert.deepEqual(await h.handler.user_api_get_meta(h.socket), utils.createUserApiSyncMeta(h.data()))
  })
})
