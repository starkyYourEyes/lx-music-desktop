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
const musicListPath = path.join(root, 'src/renderer/views/List/MusicList/index.vue')

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

const createMusicListHarness = async(actionButtonsVisible) => {
  const item = {
    ...music('saved'),
    name: 'Saved Song',
    singer: 'Saved Artist',
    interval: '05:06',
    meta: {
      songId: 'saved',
      albumName: 'Saved Album',
      picUrl: 'saved.jpg',
    },
  }
  const observed = {
    actionButtons: 0,
    clickIndexes: [],
    contextMenus: [],
    doubleClickIndexes: [],
    rows: [],
    titleCellSlots: [],
    titleCells: [],
    virtualListAttrs: [],
  }
  const value = initialValue => ref(initialValue)
  const noop = () => {}
  const EmptyStub = defineComponent({ setup: () => () => h('div') })
  const vueTools = {
    ...require('vue'),
    ref: initialValue => ref(initialValue === -1 ? 0 : initialValue),
  }
  const MusicList = loadVueSfc(musicListPath, {
    '@common/utils/electron': { clipboardWriteText: noop },
    '@common/utils/common': { encodePath: path => path },
    '@common/utils/vueTools': vueTools,
    '@renderer/store/utils': {
      canOpenPrimaryDownload: () => true,
      canStartPlayback: () => false,
    },
    './components/SearchList.vue': EmptyStub,
    './components/MusicSortModal.vue': EmptyStub,
    './components/MusicToggleModal.vue': EmptyStub,
    './components/ListProfileEditModal.vue': EmptyStub,
    './useListInfo': () => ({
      rightClickSelectedIndex: value(-1),
      selectedIndex: value(0),
      dom_listContent: value(null),
      listRef: value(null),
      list: value([item]),
      playerInfo: value({ isPlayList: true, playIndex: 0 }),
      setSelectedIndex: noop,
      isShowSource: value(true),
      excludeListIds: value(['userlist_test']),
    }),
    './useList': () => ({
      selectedList: value([item]),
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
      doubleClickPlay: index => observed.doubleClickIndexes.push(index),
    }),
    './useMusicDownload': () => ({
      isShowDownload: value(false),
      isShowDownloadMultiple: value(false),
      selectedDownloadMusicInfo: value(null),
      handleShowDownloadModal: noop,
    }),
    './useMusicAdd': () => ({
      isShowListAdd: value(false),
      isMove: value(false),
      isShowListAddMultiple: value(false),
      isMoveMultiple: value(false),
      selectedAddMusicInfo: value(null),
      handleShowMusicAddModal: noop,
      handleShowMusicMoveModal: noop,
    }),
    './useSort': () => ({
      isShowMusicSortModal: value(false),
      selectedNum: value(0),
      selectedSortMusicInfo: value(null),
      handleShowSortModal: noop,
      sortMusic: noop,
    }),
    './useMusicToggle': () => ({
      handleShowMusicToggleModal: noop,
      isShowMusicToggleModal: value(false),
      selectedToggleMusicInfo: value(null),
      toggleSource: noop,
    }),
    './useMusicActions': () => ({
      handleSearch: noop,
      handleOpenMusicDetail: noop,
      handleCopyName: noop,
      handleDislikeMusic: noop,
      handleRemoveMusic: noop,
    }),
    './useSearch': () => ({
      isShowSearchBar: value(false),
      searchList: value([]),
      handleMusicSearchAction: noop,
    }),
    './useListScroll': () => ({
      saveListPosition: noop,
      restoreScroll: async() => {},
      scrollToListIndex: async() => {},
    }),
    '@renderer/store/setting': {
      appSetting: {
        'list.actionButtonsVisible': actionButtonsVisible,
        'list.playlistProfileScale': 85,
      },
    },
    '@renderer/store/list/state': {
      userLists: [{ id: 'userlist_test', name: 'Saved Songs' }],
      loveList: { id: 'love', name: 'Love' },
    },
    '@renderer/store/list/action': { updateUserList: async() => {} },
    '@renderer/utils/data': {
      getListUpdateInfo: async() => ({}),
      setUserListProfile: async() => {},
    },
    '@renderer/core/player': { playList: noop },
    '@common/constants': { LIST_IDS: { LOVE: 'love' } },
  }).default

  const VirtualizedList = defineComponent({
    inheritAttrs: false,
    props: { list: { type: Array, required: true } },
    setup(props, { attrs, slots }) {
      return () => {
        observed.virtualListAttrs.push({ ...attrs })
        const renderedRow = slots.default?.({ item: props.list[0], index: 0 })
        const row = Array.isArray(renderedRow) ? renderedRow[0] : renderedRow
        if (row) observed.rows.push(row)
        return h('div', { class: 'virtualized-list' }, row)
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
  const app = createSSRApp({ render: () => h(MusicList, { listId: 'userlist_test' }) })
  app.config.globalProperties.$style = new Proxy({}, { get: (_, property) => `music-list-${String(property)}` })
  app.config.globalProperties.$t = key => key
  app.component('BaseVirtualizedList', VirtualizedList)
  app.component('MaterialMusicTitleCell', TitleCell)
  app.component('MaterialListButtons', ListButtons)
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

const assertMusicListMode = async(actionButtonsVisible) => {
  const { html, item, observed } = await createMusicListHarness(actionButtonsVisible)
  const header = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''

  assert.match(header, />music_title</)
  assert.doesNotMatch(header, />music_singer</)
  assert.equal(observed.titleCells.length, 1)
  assert.deepEqual(observed.titleCells[0], {
    musicInfo: item,
    title: 'Saved Song',
    artist: 'Saved Artist',
    artworkSize: 36,
  })
  assert.match(html, /class="title"[^>]*>Saved Song</)
  assert.match(html, /class="artist"[^>]*>Saved Artist</)
  assert.deepEqual(observed.titleCellSlots[0].map(vnode => ({
    class: vnode.props.class,
    children: vnode.children,
  })), [{ class: 'no-select label-source', children: 'wy' }])
  assert.equal(countRenderedText(html, 'Saved Album'), 1)
  assert.equal(countRenderedText(html, '05:06'), 1)
  assert.equal(observed.actionButtons, actionButtonsVisible ? 1 : 0)

  const row = observed.rows.at(-1)
  assert.equal(typeof row.props.onClick, 'function')
  assert.equal(typeof row.props.onContextmenu, 'function')
  assert.match(row.props.class, /music-list-active/)
  assert.match(row.props.class, /music-list-locatingCurrent/)
  assert.match(row.props.class, /\bselected\b/)
  assert.ok(row.props.class.split(/\s+/).includes('active'))
  assert.match(row.props.class, /\bdisabled\b/)
  const clickEvent = {}
  const contextMenuEvent = {}
  row.props.onClick(clickEvent)
  row.props.onContextmenu(contextMenuEvent)
  assert.deepEqual(observed.clickIndexes, [0])
  assert.deepEqual(observed.doubleClickIndexes, [0])
  assert.deepEqual(observed.contextMenus, [{ event: contextMenuEvent, musicInfo: item, index: 0 }])

  const virtualListAttrs = observed.virtualListAttrs.at(-1)
  assert.equal(typeof virtualListAttrs.onScroll, 'function')
  assert.equal(typeof virtualListAttrs.onContextmenuCapture, 'function')

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
    : [{ flex: '0 0 5%' }, { flex: '0 0 28%' }, { flex: '0 0 10%' }])
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

test('My Lists renders artwork title cells and preserves interactive rows with action buttons', async() => {
  await assertMusicListMode(true)
})

test('My Lists renders artwork title cells and preserves interactive rows without action buttons', async() => {
  await assertMusicListMode(false)
})
