const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
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

const createCurrentPair = ({ leftFuncs = {}, rightFuncs = {}, timeout = 75 } = {}) => {
  let left
  let right
  const leftFrames = []
  const rightFrames = []
  left = createSyncRpc({
    funcsObj: leftFuncs,
    timeout,
    wireProtocol: 'current',
    sendMessage(data) {
      leftFrames.push(clone(data))
      setImmediate(() => right.message(clone(data)))
    },
  })
  right = createSyncRpc({
    funcsObj: rightFuncs,
    timeout,
    wireProtocol: 'current',
    sendMessage(data) {
      rightFrames.push(clone(data))
      setImmediate(() => left.message(clone(data)))
    },
  })
  return { left, leftFrames, right, rightFrames }
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

test('current wire protocol preserves the type and id envelope', async t => {
  const pair = createCurrentPair({
    rightFuncs: {
      echo(value) {
        return `current:${value}`
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })

  assert.equal(await pair.left.remote.echo('value'), 'current:value')
  assert.deepEqual(
    Object.keys(pair.leftFrames[0]).sort(),
    ['args', 'group', 'id', 'path', 'type'],
  )
  assert.equal(pair.leftFrames[0].type, 'call')
  assert.equal(pair.rightFrames[0].type, 'result')
})

test('incoming calls receive responses in their own wire format', async t => {
  const sent = []
  const rpc = createSyncRpc({
    funcsObj: {
      echo(value) {
        return value
      },
    },
    sendMessage(data) {
      sent.push(clone(data))
    },
  })
  t.after(() => rpc.destroy())

  rpc.message({ name: 'legacy-1', path: ['echo'], data: ['legacy'] })
  rpc.message({ type: 'call', id: 'current-1', path: ['echo'], args: ['current'], group: null })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent[0], { name: 'legacy-1', error: null, data: 'legacy' })
  assert.deepEqual(sent[1], { type: 'result', id: 'current-1', data: 'current' })
})

test('wire protocol resolver is evaluated for each outbound call', async t => {
  let selected = 'legacy'
  const sent = []
  const rpc = createSyncRpc({
    funcsObj: {},
    wireProtocol: () => selected,
    sendMessage(data) {
      sent.push(clone(data))
    },
  })
  t.after(() => rpc.destroy())

  const legacyCall = rpc.remote.first()
  const legacyFrame = sent[0]
  assert.equal(typeof legacyFrame.name, 'string')
  rpc.message({ name: legacyFrame.name, error: null, data: 'legacy-result' })
  assert.equal(await legacyCall, 'legacy-result')

  selected = 'current'
  const currentCall = rpc.remote.second()
  const currentFrame = sent[1]
  assert.equal(currentFrame.type, 'call')
  rpc.message({ type: 'result', id: currentFrame.id, data: 'current-result' })
  assert.equal(await currentCall, 'current-result')
})

test('a throwing wire protocol resolver rejects without keeping the process alive', () => {
  const script = `
    const { createSyncRpc } = require(${JSON.stringify(require.resolve('../src/common/utils/syncRpc'))})
    const rpc = createSyncRpc({
      funcsObj: {},
      timeout: 1000,
      wireProtocol() {
        throw new Error('resolver failure')
      },
      sendMessage() {},
    })
    rpc.remote.call().catch(error => process.stdout.write(error.message))
  `
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 500,
  })

  assert.equal(result.status, 0)
  assert.equal(result.stdout, 'resolver failure')
})

test('current wire errors preserve the remote error name', async t => {
  const pair = createCurrentPair({
    rightFuncs: {
      fail() {
        throw new TypeError('current failure')
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })

  await assert.rejects(
    pair.left.remote.fail(),
    error => error.name == 'TypeError' && error.message == 'current failure',
  )
})

test('blocked paths return mirrored errors in both wire formats', async t => {
  const sent = []
  const rpc = createSyncRpc({
    funcsObj: {},
    sendMessage(data) {
      sent.push(clone(data))
    },
  })
  t.after(() => rpc.destroy())

  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    rpc.message({
      name: `legacy-${segment}`,
      path: [segment, 'polluted'],
      data: [],
    })
    rpc.message({
      type: 'call',
      id: `current-${segment}`,
      path: [segment, 'polluted'],
      args: [],
      group: null,
    })
  }
  await new Promise(resolve => setImmediate(resolve))

  for (const segment of ['__proto__', 'prototype', 'constructor']) {
    const legacy = sent.find(frame => frame.name == `legacy-${segment}`)
    const current = sent.find(frame => frame.id == `current-${segment}`)
    assert.deepEqual(legacy, {
      name: `legacy-${segment}`,
      error: 'Unknown RPC path',
    })
    assert.deepEqual(current, {
      type: 'error',
      id: `current-${segment}`,
      error: {
        name: 'Error',
        message: 'Unknown RPC path',
      },
    })
  }
})
