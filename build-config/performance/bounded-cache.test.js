const assert = require('node:assert/strict')
const test = require('node:test')
const load = require('../../scripts/test-utils/load-ts-module')

test('LRU cache bounds count and weight, rejects oversized entries, and shrinks immediately', () => {
  const { BoundedCache } = load('src/common/performance/boundedCache.ts')
  const cache = new BoundedCache({ maxEntries: 3, maxWeight: 5, weight: list => list.length })
  cache.set('a', [1, 2]).set('b', [1]).set('c', [1])
  cache.get('a')
  cache.set('d', [1, 2])
  assert.equal(cache.has('b'), false)
  assert.equal(cache.weight, 5)
  cache.set('large', Array(6))
  assert.equal(cache.has('large'), false)
  cache.configure({ maxEntries: 1 })
  assert.deepEqual([...cache.keys()], ['d'])
})

test('idle expiry follows access time and pinned entries remain outside disposable limits', () => {
  const { BoundedCache } = load('src/common/performance/boundedCache.ts')
  let now = 0
  const pins = new Set(['active'])
  const cache = new BoundedCache({ maxEntries: 1, maxWeight: 2, ttl: 100, now: () => now, weight: value => value.length, isPinned: key => pins.has(key) })
  const active = Array(50)
  cache.set('active', active).set('a', [1])
  now = 99
  cache.get('a')
  now = 150
  assert.equal(cache.has('a'), true)
  now = 199
  cache.prune()
  assert.equal(cache.has('a'), false)
  assert.equal(cache.get('active'), active)
  pins.clear()
  cache.prune()
  assert.equal(cache.size, 0)
  cache.clear()
})
