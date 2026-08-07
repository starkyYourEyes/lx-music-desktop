const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { createSSRApp, h } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const artworkPath = path.join(root, 'src/renderer/components/common/TrackArtwork/index.vue')
const artworkSessionPath = path.join(root, 'src/renderer/components/common/TrackArtwork/artworkSession.ts')
const titleCellPath = path.join(root, 'src/renderer/components/material/MusicTitleCell.vue')

const music = (id, picUrl = null, source = 'wy') => ({
  id,
  name: `Song ${id}`,
  singer: 'Artist',
  source,
  interval: '03:20',
  meta: { songId: id, albumName: 'Album', picUrl },
})

const getInitialArtworkUrl = musicInfo => {
  const picUrl = musicInfo?.meta.picUrl
  return picUrl && !picUrl.startsWith('webdav:') ? picUrl : null
}

const SvgIcon = {
  inheritAttrs: false,
  setup(_, { attrs }) {
    return () => h('svg', attrs)
  },
}

const styleProxy = new Proxy({}, { get: (_, property) => String(property) })

const createSessionStub = () => ({
  peek: getInitialArtworkUrl,
  resolve: async musicInfo => getInitialArtworkUrl(musicInfo),
  fail() {},
})

const loadArtwork = (session = createSessionStub(), vueTools = require('vue')) => {
  return loadVueSfc(artworkPath, {
    '@common/utils/vueTools': vueTools,
    './artworkSession': { artworkSession: session, getInitialArtworkUrl },
  }).default
}

const configureApp = (app, Artwork = loadArtwork()) => {
  app.component('SvgIcon', SvgIcon)
  app.component('CommonTrackArtwork', Artwork)
  app.config.globalProperties.$style = styleProxy
  return app
}

const renderArtwork = async props => {
  const Artwork = loadArtwork()
  const app = configureApp(createSSRApp({ render: () => h(Artwork, props) }), Artwork)
  return renderToString(app)
}

const renderTitleCell = async(props, slots = {}) => {
  const Artwork = loadArtwork()
  const TitleCell = loadVueSfc(titleCellPath).default
  const app = configureApp(createSSRApp({ render: () => h(TitleCell, props, slots) }), Artwork)
  app.component('MaterialMusicTitleCell', TitleCell)
  return renderToString(app)
}

const createLifecycleHarness = () => {
  let mounted
  let beforeUnmount
  let propChanged
  const vueTools = {
    ref: value => ({ value }),
    watch: (_, callback) => { propChanged = callback },
    onMounted: callback => { mounted = callback },
    onBeforeUnmount: callback => { beforeUnmount = callback },
  }
  return {
    vueTools,
    mount: () => mounted(),
    unmount: () => beforeUnmount(),
    changeMusic: musicInfo => propChanged(musicInfo),
  }
}

const setupArtwork = (props, session) => {
  const lifecycle = createLifecycleHarness()
  const Artwork = loadArtwork(session, lifecycle.vueTools)
  const bindings = Artwork.setup(props, { expose() {} })
  bindings.root.value = {}
  return { bindings, lifecycle }
}

test('title cell renders artwork, a badge-bearing title line, and a muted artist line', async() => {
  const html = await renderTitleCell({
    musicInfo: music('1', 'cover.jpg'),
    title: 'A very good song',
    artist: 'The Artist',
    artworkSize: 44,
  }, { default: () => h('span', { class: 'badge' }, 'HQ') })

  assert.match(html, /<img[^>]+src="cover\.jpg"/)
  assert.match(html, />A very good song</)
  assert.match(html, />The Artist</)
  assert.match(html, />HQ</)
})

test('artwork renders a stable placeholder when no track is available', async() => {
  const html = await renderArtwork({ musicInfo: null, size: 44 })

  assert.doesNotMatch(html, /<img/)
  assert.match(html, /aria-hidden="true"/)
  assert.match(html, /width:44px;height:44px/)
})

test('intersection gates missing artwork resolution but not a stored cover', async t => {
  const originalIntersectionObserver = global.IntersectionObserver
  let observerCallback
  global.IntersectionObserver = class {
    constructor(callback) { observerCallback = callback }
    observe() {}
    disconnect() {}
  }
  t.after(() => { global.IntersectionObserver = originalIntersectionObserver })

  let missingCalls = 0
  const missing = setupArtwork({ musicInfo: music('2'), size: 44 }, {
    peek: () => null,
    resolve: async() => { missingCalls++; return 'resolved.jpg' },
    fail() {},
  })
  missing.lifecycle.mount()
  assert.equal(missingCalls, 0)
  observerCallback([{ target: missing.bindings.root.value, isIntersecting: true }])
  await Promise.resolve()
  assert.equal(missingCalls, 1)
  assert.equal(missing.bindings.artworkUrl.value, 'resolved.jpg')

  let storedCalls = 0
  const stored = setupArtwork({ musicInfo: music('3', 'stored.jpg'), size: 44 }, {
    peek: () => 'stored.jpg',
    resolve: async() => { storedCalls++; return 'stored.jpg' },
    fail() {},
  })
  stored.lifecycle.mount()
  assert.equal(stored.bindings.artworkUrl.value, 'stored.jpg')
  observerCallback([{ target: stored.bindings.root.value, isIntersecting: true }])
  await Promise.resolve()
  assert.equal(storedCalls, 0)
})

test('late artwork results cannot repaint a reused or unmounted row', async t => {
  const originalIntersectionObserver = global.IntersectionObserver
  let observerCallback
  global.IntersectionObserver = class {
    constructor(callback) { observerCallback = callback }
    observe() {}
    disconnect() {}
  }
  t.after(() => { global.IntersectionObserver = originalIntersectionObserver })

  const releases = new Map()
  const session = {
    peek: () => null,
    resolve: track => new Promise(resolve => { releases.set(track.id, resolve) }),
    fail() {},
  }
  const props = { musicInfo: music('4'), size: 44 }
  const { bindings, lifecycle } = setupArtwork(props, session)
  lifecycle.mount()
  observerCallback([{ target: bindings.root.value, isIntersecting: true }])

  props.musicInfo = music('5')
  lifecycle.changeMusic(props.musicInfo)
  releases.get('5')('new.jpg')
  await Promise.resolve()
  assert.equal(bindings.artworkUrl.value, 'new.jpg')
  releases.get('4')('stale.jpg')
  await Promise.resolve()
  assert.equal(bindings.artworkUrl.value, 'new.jpg')

  props.musicInfo = music('6')
  lifecycle.changeMusic(props.musicInfo)
  lifecycle.unmount()
  releases.get('6')('unmounted.jpg')
  await Promise.resolve()
  assert.equal(bindings.artworkUrl.value, null)
})

test('a queued intersection callback cannot start artwork resolution after unmount', async t => {
  const originalIntersectionObserver = global.IntersectionObserver
  let observerCallback
  global.IntersectionObserver = class {
    constructor(callback) { observerCallback = callback }
    observe() {}
    disconnect() {}
  }
  t.after(() => { global.IntersectionObserver = originalIntersectionObserver })

  let resolveCalls = 0
  const { bindings, lifecycle } = setupArtwork({ musicInfo: music('7'), size: 44 }, {
    peek: () => null,
    resolve: async() => { resolveCalls++; return 'late.jpg' },
    fail() {},
  })
  lifecycle.mount()
  lifecycle.unmount()

  observerCallback([{ target: bindings.root.value, isIntersecting: true }])
  await Promise.resolve()

  assert.equal(resolveCalls, 0)
  assert.equal(bindings.artworkUrl.value, null)
})

test('native failure caches a placeholder for an initially displayed stored URL', async() => {
  const { createArtworkSession } = loadTsModule(artworkSessionPath, {
    '@renderer/core/music': { getPicPath: async() => null },
  })
  const track = music('7', 'broken.jpg')
  const session = createArtworkSession(async() => 'unused.jpg')
  const { bindings } = setupArtwork({ musicInfo: track, size: 44 }, session)

  assert.equal(bindings.artworkUrl.value, 'broken.jpg')
  await bindings.handleArtworkError()
  assert.equal(bindings.artworkUrl.value, null)
  assert.equal(session.peek(track), null)
  assert.equal(await session.resolve(track), null)
})
