const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const load = require('../../scripts/test-utils/load-ts-module')

test('restart waits for persistence and deduplicates concurrent requests', async() => {
  const { createAppRestart } = load(path.resolve('src/main/services/appRestart.ts'))
  const events = []
  let release
  const restart = createAppRestart({
    flush: async() => { events.push('flush'); await new Promise(resolve => { release = resolve }) },
    relaunch: () => events.push('relaunch'),
    quit: () => events.push('quit'),
  })
  const a = restart()
  const b = restart()
  await Promise.resolve()
  assert.deepEqual(events, ['flush'])
  release()
  await Promise.all([a, b])
  await restart()
  assert.deepEqual(events, ['flush', 'relaunch', 'quit'])
})

test('failed flush preserves the running app and permits retry', async() => {
  const { createAppRestart } = load(path.resolve('src/main/services/appRestart.ts'))
  let failing = true
  const events = []
  const restart = createAppRestart({
    flush: async() => { if (failing) throw new Error('save failed') },
    relaunch: () => events.push('relaunch'), quit: () => events.push('quit'),
  })
  await assert.rejects(restart(), /save failed/)
  assert.deepEqual(events, [])
  failing = false
  await restart()
  assert.deepEqual(events, ['relaunch', 'quit'])
})
