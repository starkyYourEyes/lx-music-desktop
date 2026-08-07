const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { createSSRApp, defineComponent, h, ref } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const artworkPath = path.join(root, 'src/renderer/components/common/TrackArtwork/index.vue')
const artworkSessionPath = path.join(root, 'src/renderer/components/common/TrackArtwork/artworkSession.ts')
const titleCellPath = path.join(root, 'src/renderer/components/material/MusicTitleCell.vue')
const onlineListPath = path.join(root, 'src/renderer/components/material/OnlineList/index.vue')

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

const createOnlineListHarness = async(actionButtonsVisible) => {
  const item = {
    ...music('online'),
    name: 'Online Song',
    singer: 'Online Artist',
    interval: '04:05',
    meta: {
      songId: 'online',
      albumName: 'Online Album',
      picUrl: 'online.jpg',
      _qualitys: { flac24bit: true },
    },
  }
  const observed = {
    actionButtons: 0,
    clickIndexes: [],
    contextMenus: [],
    rows: [],
    titleCellSlots: [],
    titleCells: [],
  }
  const value = initialValue => ref(initialValue)
  const noop = () => {}
  const OnlineList = loadVueSfc(onlineListPath, {
    '@common/utils/electron': { clipboardWriteText: noop },
    '@renderer/store/utils': {
      canOpenPrimaryDownload: () => true,
      canStartPlayback: () => true,
    },
    '@common/utils/vueTools': require('vue'),
    './useList': () => ({
      selectedList: value([]),
      listItemHeight: value(52),
      artworkSize: value(36),
      handleSelectData: index => observed.clickIndexes.push(index),
      removeAllSelect: noop,
    }),
    './useMenu': () => ({
      menus: value([]),
      menuLocation: value({ x: 0, y: 0 }),
      isShowItemMenu: value(false),
      showMenu: (event, musicInfo, index) => observed.contextMenus.push({ event, musicInfo, index }),
      menuClick: noop,
    }),
    './usePlay': () => ({
      handlePlayMusic: noop,
      handlePlayMusicLater: noop,
      doubleClickPlay: noop,
    }),
    './useMusicDownload': () => ({
      isShowDownload: value(false),
      isShowDownloadMultiple: value(false),
      selectedDownloadMusicInfo: value(null),
      handleShowDownloadModal: noop,
    }),
    './useMusicAdd': () => ({
      isShowListAdd: value(false),
      isShowListAddMultiple: value(false),
      selectedAddMusicInfo: value(null),
      handleShowMusicAddModal: noop,
    }),
    './useMusicActions': () => ({
      handleSearch: noop,
      handleOpenMusicDetail: noop,
      handleDislikeMusic: noop,
    }),
    '@renderer/store/setting': {
      appSetting: {
        'list.actionButtonsVisible': actionButtonsVisible,
      },
    },
    '@renderer/store/player/state': {
      playInfo: { playerListId: '', playerPlayIndex: -1 },
      playMusicInfo: { musicInfo: null },
    },
    '@renderer/store/list/state': { tempListMeta: { id: '' } },
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
  }).default

  const VirtualizedList = defineComponent({
    props: { list: { type: Array, required: true } },
    setup(props, { slots }) {
      return () => {
        const renderedRow = slots.default?.({ item: props.list[0], index: 0 })
        const row = Array.isArray(renderedRow) ? renderedRow[0] : renderedRow
        if (row) observed.rows.push(row)
        return h('div', { class: 'virtualized-list' }, [row, slots.footer?.()])
      }
    },
  })
  const TitleCell = defineComponent({
    props: {
      musicInfo: { type: Object, default: null },
      title: { type: String, required: true },
      artist: { type: String, required: true },
      artworkSize: { type: Number, required: true },
    },
    setup(props, { slots }) {
      return () => {
        const slotContent = slots.default?.() ?? []
        observed.titleCellSlots.push(slotContent)
        observed.titleCells.push({
          musicInfo: props.musicInfo,
          title: props.title,
          artist: props.artist,
          artworkSize: props.artworkSize,
        })
        return h('div', { class: 'title-cell' }, [
          h('span', { class: 'title' }, props.title),
          h('span', { class: 'artist' }, props.artist),
          slotContent,
        ])
      }
    },
  })
  const ListButtons = defineComponent({
    setup() {
      observed.actionButtons++
      return () => h('button', { class: 'actions' }, 'actions')
    },
  })
  const EmptyStub = defineComponent({ setup: () => () => h('div') })
  const app = createSSRApp({
    render: () => h(OnlineList, {
      list: [item],
      page: 1,
      limit: 30,
      total: 1,
      sourceTag: true,
    }),
  })
  app.config.globalProperties.$style = styleProxy
  app.config.globalProperties.$t = key => key
  app.component('BaseVirtualizedList', VirtualizedList)
  app.component('MaterialMusicTitleCell', TitleCell)
  app.component('MaterialListButtons', ListButtons)
  app.component('MaterialPagination', EmptyStub)
  app.component('CommonListAddModal', EmptyStub)
  app.component('CommonListAddMultipleModal', EmptyStub)
  app.component('CommonDownloadModal', EmptyStub)
  app.component('CommonDownloadMultipleModal', EmptyStub)
  app.component('BaseMenu', EmptyStub)
  app.component('SvgIcon', SvgIcon)

  const html = await renderToString(app)
  return { html, item, observed }
}

const countRenderedText = (html, expected) => {
  const renderedText = html.replace(/<[^>]+>/g, '')
  return renderedText.split(expected).length - 1
}

const assertOnlineListMode = async(actionButtonsVisible) => {
  const { html, item, observed } = await createOnlineListHarness(actionButtonsVisible)
  const header = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''

  assert.match(header, />music_title</)
  assert.doesNotMatch(header, />music_singer</)
  assert.equal(observed.titleCells.length, 1)
  assert.equal(observed.titleCells[0].musicInfo, item)
  assert.deepEqual(observed.titleCells[0], {
    musicInfo: item,
    title: 'Online Song',
    artist: 'Online Artist',
    artworkSize: 36,
  })
  assert.match(html, /class="title"[^>]*>Online Song</)
  assert.match(html, /class="artist"[^>]*>Online Artist</)
  assert.match(html, />tag__lossless_24bit</)
  assert.match(html, />wy</)
  assert.deepEqual(observed.titleCellSlots[0].map(vnode => vnode.children), ['tag__lossless_24bit', 'wy'])
  assert.equal(countRenderedText(html, 'Online Album'), 1)
  assert.equal(countRenderedText(html, '04:05'), 1)
  assert.equal(observed.actionButtons, actionButtonsVisible ? 1 : 0)

  const row = observed.rows.at(-1)
  assert.equal(typeof row.props.onClick, 'function')
  assert.equal(typeof row.props.onContextmenu, 'function')
  const clickEvent = {}
  const contextMenuEvent = {}
  row.props.onClick(clickEvent)
  row.props.onContextmenu(contextMenuEvent)
  assert.deepEqual(observed.clickIndexes, [0])
  assert.deepEqual(observed.contextMenus, [{ event: contextMenuEvent, musicInfo: item, index: 0 }])

  const columnStyles = row.children
    .filter(child => child && typeof child == 'object')
    .map(child => child.props?.style)
    .filter(Boolean)
  assert.deepEqual(columnStyles, actionButtonsVisible
    ? [
        { flex: '0 0 5%' },
        { flex: '0 0 22%' },
        { flex: '0 0 9%' },
        { flex: '0 0 16%', 'padding-left': '0', 'padding-right': '0' },
      ]
    : [{ flex: '0 0 5%' }, { flex: '0 0 27%' }, { flex: '0 0 10%' }])
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

test('OnlineList renders artwork title cells and preserves interactive rows with action buttons', async() => {
  await assertOnlineListMode(true)
})

test('OnlineList renders artwork title cells and preserves interactive rows without action buttons', async() => {
  await assertOnlineListMode(false)
})
