const assert = require('node:assert/strict')
const test = require('node:test')
const { createSyncRpc } = require('../src/common/utils/syncRpc')

const clone = value => JSON.parse(JSON.stringify(value))

const createLegacyPeer = ({ funcsObj = {}, timeout = 75 } = {}) => {
  let sendMessage = () => {}
  let nextId = 0
  const pending = new Map()

  const resolveFunction = path => {
    let parent = null
    let target = funcsObj
    for (const part of path) {
      parent = target
      target = target?.[part]
    }
    if (typeof target != 'function') throw new Error(`${path.at(-1)} is not defined`)
    return { parent, target }
  }

  const call = (path, ...args) => new Promise((resolve, reject) => {
    const name = `${path.join('.')}__legacy-${++nextId}`
    const timer = setTimeout(() => {
      pending.delete(name)
      reject(new Error('timeout'))
    }, timeout)
    pending.set(name, { resolve, reject, timer })
    sendMessage({ name, path, data: args })
  })

  const message = async data => {
    if (!data || typeof data.name != 'string') return
    if (Array.isArray(data.path) && data.path.length) {
      try {
        const { parent, target } = resolveFunction(data.path)
        const result = await target.apply(parent, data.data)
        sendMessage({ name: data.name, error: null, data: result })
      } catch (error) {
        sendMessage({ name: data.name, error: error.message })
      }
      return
    }
    const entry = pending.get(data.name)
    if (!entry) return
    pending.delete(data.name)
    clearTimeout(entry.timer)
    if (data.error == null) entry.resolve(data.data)
    else entry.reject(new Error(String(data.error)))
  }

  const destroy = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('destroy'))
    }
    pending.clear()
  }

  return {
    call,
    destroy,
    message,
    setSendMessage(handler) {
      sendMessage = handler
    },
  }
}

const createLegacyPair = ({ rpcFuncs = {}, peerFuncs = {}, timeout = 75 } = {}) => {
  const peer = createLegacyPeer({ funcsObj: peerFuncs, timeout })
  let rpc
  const rpcFrames = []
  const peerFrames = []
  peer.setSendMessage(data => {
    peerFrames.push(clone(data))
    setImmediate(() => rpc.message(clone(data)))
  })
  rpc = createSyncRpc({
    funcsObj: rpcFuncs,
    timeout,
    sendMessage(data) {
      rpcFrames.push(clone(data))
      setImmediate(() => peer.message(clone(data)))
    },
  })
  return { peer, peerFrames, rpc, rpcFrames }
}

test('legacy peer calls the local getEnabledFeatures handler', async t => {
  let handlerCalled = false
  const pair = createLegacyPair({
    rpcFuncs: {
      getEnabledFeatures(serverType, supportedFeatures) {
        handlerCalled = true
        assert.equal(serverType, 'server')
        assert.deepEqual(supportedFeatures, { list: 1 })
        return { list: { skipSnapshot: false } }
      },
    },
  })
  t.after(() => { pair.peer.destroy(); pair.rpc.destroy() })

  assert.deepEqual(
    await pair.peer.call(['getEnabledFeatures'], 'server', { list: 1 }),
    { list: { skipSnapshot: false } },
  )
  assert.equal(handlerCalled, true)
  assert.deepEqual(Object.keys(pair.rpcFrames.at(-1)).sort(), ['data', 'error', 'name'])
})

test('local RPC calls and receives a legacy peer response by default', async t => {
  const pair = createLegacyPair({
    peerFuncs: {
      echo(value) {
        return `legacy:${value}`
      },
    },
  })
  t.after(() => { pair.peer.destroy(); pair.rpc.destroy() })

  assert.equal(await pair.rpc.remote.echo('value'), 'legacy:value')
  assert.deepEqual(Object.keys(pair.rpcFrames[0]).sort(), ['data', 'name', 'path'])
  assert.equal(pair.rpcFrames[0].path.join('.'), 'echo')
  assert.deepEqual(pair.rpcFrames[0].data, ['value'])
})

test('legacy peer errors reject the local pending call', async t => {
  const pair = createLegacyPair({
    peerFuncs: {
      fail() {
        throw new Error('legacy failure')
      },
    },
  })
  t.after(() => { pair.peer.destroy(); pair.rpc.destroy() })

  await assert.rejects(pair.rpc.remote.fail(), /legacy failure/)
})
