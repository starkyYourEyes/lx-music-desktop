const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const modulePath = path.join(root, 'src/renderer/components/common/TrackArtwork/artworkSession.ts')
const metricsPath = path.join(root, 'src/renderer/components/material/useMusicRowMetrics.ts')

const music = (id, picUrl = null, source = 'wy') => ({
  id,
  name: `Song ${id}`,
  singer: 'Artist',
  source,
  interval: '03:20',
  meta: { songId: id, albumName: 'Album', picUrl },
})

const loadArtworkModule = getPicPath => loadTsModule(modulePath, {
  '@renderer/core/music': { getPicPath },
})

test('stored artwork is returned without invoking the fallback resolver', async() => {
  let calls = 0
  const { createArtworkSession } = loadArtworkModule(async() => { calls++; return 'resolved.jpg' })
  const session = createArtworkSession(async() => { calls++; return 'resolved.jpg' })

  assert.equal(await session.resolve(music('1', 'stored.jpg')), 'stored.jpg')
  assert.equal(calls, 0)
})

test('concurrent missing-artwork lookups share one request and cache its result', async() => {
  let calls = 0
  let release
  const pending = new Promise(resolve => { release = resolve })
  const { createArtworkSession } = loadArtworkModule(async() => '')
  const track = music('2')
  const session = createArtworkSession(async() => { calls++; return pending })

  assert.equal(session.peek(track), undefined)
  const first = session.resolve(track)
  const second = session.resolve(track)
  assert.equal(calls, 1)
  release('resolved.jpg')
  assert.deepEqual(await Promise.all([first, second]), ['resolved.jpg', 'resolved.jpg'])
  assert.equal(await session.resolve(track), 'resolved.jpg')
  assert.equal(calls, 1)
})

test('failed artwork is cached as a placeholder outcome', async() => {
  let calls = 0
  const { createArtworkSession } = loadArtworkModule(async() => '')
  const track = music('3')
  const session = createArtworkSession(async() => { calls++; throw new Error('missing') })

  assert.equal(await session.resolve(track), null)
  assert.equal(await session.resolve(track), null)
  assert.equal(calls, 1)
})

test('webdav sentinel URLs resolve through the artwork loader', async() => {
  let calls = 0
  const { createArtworkSession } = loadArtworkModule(async() => '')
  const session = createArtworkSession(async() => { calls++; return 'data:image/png;base64,AA==' })

  assert.equal(await session.resolve(music('4', 'webdav:#embedded-cover', 'webdav')), 'data:image/png;base64,AA==')
  assert.equal(calls, 1)
})

test('native image failures replace a cached URL with a failed outcome', async() => {
  const { createArtworkSession } = loadArtworkModule(async() => '')
  const track = music('5', 'broken.jpg')
  const session = createArtworkSession(async() => 'unused.jpg')

  assert.equal(await session.resolve(track), 'broken.jpg')
  session.fail(track, 'broken.jpg')
  assert.equal(session.peek(track), null)
  assert.equal(await session.resolve(track), null)
})

test('music row metrics use 60/44 defaults and bounded accessibility scaling', () => {
  const { calculateMusicRowMetrics } = loadTsModule(metricsPath, {
    '@common/utils/vueTools': { computed: getter => ({ get value() { return getter() } }) },
    '@renderer/store': { isFullscreen: { value: false } },
    '@renderer/store/setting': { appSetting: { 'common.fontSize': 16 } },
    '@renderer/utils': { getFontSizeWithScreen: () => 16 },
  })

  assert.deepEqual(calculateMusicRowMetrics(16), { rowHeight: 60, artworkSize: 44 })
  assert.deepEqual(calculateMusicRowMetrics(12), { rowHeight: 52, artworkSize: 36 })
  assert.deepEqual(calculateMusicRowMetrics(24), { rowHeight: 72, artworkSize: 56 })
})
