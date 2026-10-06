const assert = require('node:assert/strict')
const test = require('node:test')
const { loadTs, deferred, tick } = require('./download-harness')
const harness = (factory) => {
  const { createDownloadWorkerManager } = loadTs('src/renderer/worker/utils/index.ts')
  let created = 0
  let disposed = 0
  const calls = []
  const manager = createDownloadWorkerManager(factory ?? (() => {
    created++
    return {
      remote: { writeMeta: async value => { calls.push(value); return value } },
      dispose: () => { disposed++ },
    }
  }))
  return { manager, calls, get created() { return created }, get disposed() { return disposed } }
}

test('constructing the lazy download facade never spawns a Worker', () => {
  const h = harness()
  assert.equal(h.created, 0)
  assert.equal(h.manager.getStatus().loaded, false)
})

test('concurrent callers share one Worker and on-demand idle releases it', async() => {
  const h = harness()
  h.manager.setMode('onDemand')
  await Promise.all([h.manager.facade.writeMeta('one'), h.manager.facade.writeMeta('two')])
  await tick()
  assert.equal(h.created, 1)
  assert.deepEqual(h.calls, ['one', 'two'])
  assert.equal(h.disposed, 1)
})

test('off refuses new work without spawning', async() => {
  const h = harness()
  await assert.rejects(h.manager.facade.writeMeta('one'), /disabled/)
  assert.throws(() => h.manager.acquire(), /disabled/)
  assert.equal(h.created, 0)
})

test('cleanup without a Worker is idempotent and never initializes one', async() => {
  const h = harness()
  await h.manager.facade.pauseTask('missing')
  await h.manager.facade.removeTask('missing')
  h.manager.setMode('onDemand')
  await h.manager.facade.removeTask('missing')
  assert.equal(h.created, 0)
})

test('an active task keeps its Worker through close and postprocessing', async() => {
  const h = harness()
  h.manager.setMode('onDemand')
  const release = h.manager.acquire()
  await h.manager.facade.writeMeta('transfer')
  h.manager.setMode('off')
  await tick()
  assert.equal(h.manager.getStatus().draining, true)
  assert.equal(h.disposed, 0)
  await assert.rejects(h.manager.facade.startTask('new'), /disabled/)
  await h.manager.facade.writeMeta('postprocessing')
  assert.equal(h.disposed, 0)
  release()
  release()
  await tick()
  assert.equal(h.disposed, 1)
  assert.equal(h.manager.getStatus().draining, false)
})

test('re-enabling resident mode cancels a scheduled idle disposal', async() => {
  const h = harness()
  h.manager.setMode('resident')
  await h.manager.prewarm()
  h.manager.setMode('off')
  h.manager.setMode('resident')
  await tick()
  assert.equal(h.created, 1)
  assert.equal(h.disposed, 0)
  assert.equal(h.calls.length, 0)
})

test('closing during asynchronous initialization rejects new work and cleans up once', async() => {
  const spawn = deferred()
  let disposed = 0
  let called = false
  const h = harness(() => spawn.promise)
  h.manager.setMode('onDemand')
  const work = h.manager.facade.writeMeta('late')
  h.manager.setMode('off')
  spawn.resolve({ remote: { writeMeta: () => { called = true } }, dispose: () => { disposed++ } })
  await assert.rejects(work, /disabled/)
  await tick()
  assert.equal(called, false)
  assert.equal(disposed, 1)
})

test('initialization errors are reported and an explicit retry can recover', async() => {
  let attempts = 0
  const h = harness(() => {
    if (++attempts === 1) throw new Error('worker unavailable')
    return { remote: { writeMeta: () => 'ok' }, dispose: () => {} }
  })
  h.manager.setMode('resident')
  await assert.rejects(h.manager.prewarm(), /worker unavailable/)
  assert.match(h.manager.getStatus().error, /worker unavailable/)
  await h.manager.prewarm()
  assert.equal(h.manager.getStatus().loaded, true)
  assert.equal(h.manager.getStatus().error, null)
})

test('the production owner releases its Comlink proxy and terminates its raw Worker once', async() => {
  let spawned = 0; let released = 0; let terminated = 0
  const releaseProxy = Symbol('release')
  const utils = loadTs('src/renderer/worker/utils/index.ts', {
    comlink: { releaseProxy, wrap: () => ({ writeMeta: async() => {}, [releaseProxy]: () => { released++ } }) },
  }, { URL, Worker: class { constructor() { spawned++ } terminate() { terminated++ } } })
  const facade = utils.createDownloadWorker()
  assert.equal(spawned, 0)
  utils.downloadWorkerManager.setMode('onDemand')
  await facade.writeMeta({})
  await tick()
  assert.equal(spawned, 1)
  assert.equal(released, 1)
  assert.equal(terminated, 1)
})

