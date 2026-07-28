const assert = require('node:assert/strict')
const test = require('node:test')
const { createSyncRpc } = require('../src/common/utils/syncRpc')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const createPair = ({ leftFuncs = {}, rightFuncs = {}, timeout = 100 } = {}) => {
  let left
  let right
  const leftSocket = { side: 'left' }
  const rightSocket = { side: 'right' }
  left = createSyncRpc({
    funcsObj: leftFuncs,
    timeout,
    onCallBeforeParams: args => [leftSocket, ...args],
    sendMessage: data => setImmediate(() => right.message(JSON.parse(JSON.stringify(data)))),
  })
  right = createSyncRpc({
    funcsObj: rightFuncs,
    timeout,
    onCallBeforeParams: args => [rightSocket, ...args],
    sendMessage: data => setImmediate(() => left.message(JSON.parse(JSON.stringify(data)))),
  })
  return { left, right, leftSocket, rightSocket }
}

test('returns sync and async nested values through real JSON round trips', async t => {
  const pair = createPair({
    rightFuncs: {
      math: {
        add(socket, left, right) {
          assert.equal(socket, pair.rightSocket)
          return left + right
        },
        async double(socket, value) {
          assert.equal(socket.side, 'right')
          await delay(2)
          return value * 2
        },
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  assert.equal(await pair.left.remote.math.add(2, 3), 5)
  assert.equal(await pair.left.remote.math.double(4), 8)
})

test('serializes remote errors and rejects unknown or non-function paths', async t => {
  const pair = createPair({
    rightFuncs: {
      value: 1,
      fail() {
        const error = new TypeError('remote failure')
        throw error
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  await assert.rejects(pair.left.remote.fail(), error => error.name == 'TypeError' && error.message == 'remote failure')
  await assert.rejects(pair.left.remote.missing(), /Unknown RPC path/)
  await assert.rejects(pair.left.remote.value(), /not a function/)
})

test('a timed out queued call releases the next call', async t => {
  let callCount = 0
  const pair = createPair({
    timeout: 25,
    rightFuncs: {
      async work(socket) {
        callCount++
        if (callCount == 1) return new Promise(() => {})
        return 'recovered'
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  const queue = pair.left.createQueueRemote('list')
  await assert.rejects(queue.work(), /timeout/)
  assert.equal(await queue.work(), 'recovered')
})

test('same-group calls are FIFO while different groups run concurrently', async t => {
  const events = []
  const pair = createPair({
    rightFuncs: {
      async work(socket, name, ms) {
        events.push(`start:${name}`)
        await delay(ms)
        events.push(`end:${name}`)
        return name
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })
  const list = pair.left.createQueueRemote('list')
  const dislike = pair.left.createQueueRemote('dislike')
  const calls = [list.work('a', 20), list.work('b', 1), dislike.work('c', 1)]
  assert.deepEqual(await Promise.all(calls), ['a', 'b', 'c'])
  assert.ok(events.indexOf('start:c') < events.indexOf('end:a'))
  assert.ok(events.indexOf('start:b') > events.indexOf('end:a'))
})

test('destroy rejects in-flight, queued, and future calls', async() => {
  const pair = createPair({ rightFuncs: { wait: () => new Promise(() => {}) } })
  const queue = pair.left.createQueueRemote('userApi')
  const inFlight = queue.wait()
  const queued = queue.wait()
  await delay(2)
  pair.left.destroy()
  await assert.rejects(inFlight, /destroyed/)
  await assert.rejects(queued, /destroyed/)
  await assert.rejects(pair.left.remote.wait(), /destroyed/)
  pair.right.destroy()
})
