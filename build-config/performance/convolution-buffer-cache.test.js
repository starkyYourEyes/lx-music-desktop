const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const { createConvolutionBufferCache } = loadTsModule(path.join(__dirname, '../../src/renderer/core/useApp/usePlayer/convolutionBufferCache.ts'))

test('convolution cache keeps current and recent buffers, evicting older impulses', async() => {
  const loads = []
  const cache = createConvolutionBufferCache(async name => { loads.push(name); return { name } })
  const first = await cache.get('a')
  await cache.get('b')
  assert.equal(await cache.get('a'), first)
  await cache.get('c')
  await cache.get('b')
  assert.deepEqual(loads, ['a', 'b', 'c', 'b'])
})

test('concurrent impulse decoding is shared and clearing prevents stale completion repopulating cache', async() => {
  let finish
  let loads = 0
  const cache = createConvolutionBufferCache(() => { loads++; return new Promise(resolve => { finish = resolve }) })
  const first = cache.get('a')
  const second = cache.get('a')
  assert.equal(loads, 1)
  cache.clear()
  finish({})
  await Promise.all([first, second])
  const third = cache.get('a')
  assert.equal(loads, 2)
  finish({})
  await third
})
