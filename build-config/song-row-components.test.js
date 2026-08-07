const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { compileStyleAsync, parse } = require('@vue/compiler-sfc')
const { createSSRApp, defineComponent, h, ref } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const less = require('less')
const postcss = require('postcss')
const loadTsModule = require('../scripts/test-utils/load-ts-module')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const root = path.resolve(__dirname, '..')
const artworkPath = path.join(root, 'src/renderer/components/common/TrackArtwork/index.vue')
const artworkSessionPath = path.join(root, 'src/renderer/components/common/TrackArtwork/artworkSession.ts')
const titleCellPath = path.join(root, 'src/renderer/components/material/MusicTitleCell.vue')
const onlineListPath = path.join(root, 'src/renderer/components/material/OnlineList/index.vue')
const musicListPath = path.join(root, 'src/renderer/views/List/MusicList/index.vue')
const recentPlayPath = path.join(root, 'src/renderer/views/RecentPlay/index.vue')
const playQueuePath = path.join(root, 'src/renderer/components/layout/PlayQueue.vue')

const compileOnlineListStyle = async() => {
  class RendererAliasFileManager extends less.FileManager {
    supports(filename) {
      return filename.startsWith('@renderer/')
    }

    loadFile(filename, currentDirectory, options, environment) {
      const resolvedPath = path.join(root, 'src/renderer', filename.slice('@renderer/'.length))
      return super.loadFile(resolvedPath, '', options, environment)
    }
  }

  const aliasPlugin = {
    install(_, pluginManager) {
      pluginManager.addFileManager(new RendererAliasFileManager())
    },
  }
  const source = fs.readFileSync(onlineListPath, 'utf8')
  const { descriptor, errors: parseErrors } = parse(source, { filename: onlineListPath })
  assert.deepEqual(parseErrors, [])
  const style = descriptor.styles.find(styleBlock => styleBlock.module)
  assert.ok(style, 'OnlineList must expose a CSS Modules style block')

  const result = await compileStyleAsync({
    filename: onlineListPath,
    source: style.content,
    id: 'data-v-online-list-contract',
    modules: true,
    preprocessLang: style.lang,
    preprocessOptions: { plugins: [aliasPlugin] },
  })
  assert.deepEqual(result.errors, [])

  return {
    modules: result.modules,
    stylesheet: postcss.parse(result.code),
  }
}

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

const createRecentPlayHarness = async() => {
  const playablePayload = {
    ...music('history-playable', 'history.jpg', 'tx'),
    name: 'Resolved Song Name',
    singer: 'Resolved Artist',
    interval: '04:32',
    meta: {
      songId: 'history-playable',
      albumName: 'History Album',
      picUrl: 'history.jpg',
      _qualitys: { flac24bit: true },
    },
  }
  const playableRecord = {
    id: 'history-record',
    source: 'tx',
    sourceTrackId: 'history-playable',
    name: 'Recorded Song Name',
    singer: 'Recorded Artist',
    durationMs: 272000,
    playablePayload,
  }
  const unavailableRecord = {
    id: 'history-unavailable',
    source: 'wy',
    sourceTrackId: 'history-unavailable',
    name: 'Unavailable Song Name',
    singer: '',
    durationMs: 125000,
    playablePayload: null,
  }
  const observed = {
    buttons: [],
    playCalls: [],
    rows: [],
    titleCellSlots: [],
    titleCells: [],
    virtualListAttrs: [],
  }
  let performanceTime = 900
  const originalWindow = global.window
  global.window = { performance: { now: () => performanceTime += 100 } }

  try {
    const vueTools = {
      ...require('vue'),
      ref: initialValue => ref(initialValue === -1 ? 0 : initialValue),
    }
    const RecentPlay = loadVueSfc(recentPlayPath, {
      '@common/utils/vueTools': vueTools,
      '@common/utils/common': { formatPlayTime2: seconds => `formatted-${seconds}` },
      '@root/lang': { useI18n: () => key => key },
      '@renderer/core/player': {
        playMusicByInfo: (...args) => observed.playCalls.push(args),
      },
      '@renderer/store/player/state': {
        playMusicInfo: { musicInfo: playablePayload },
      },
      '@renderer/store/recentPlay/action': { RECENT_PLAY_LIMIT: 500 },
      '@renderer/store/recentPlay/state': {
        recentPlayList: [playableRecord, unavailableRecord],
      },
      '@renderer/store/setting': {
        appSetting: { 'common.sourceNameType': 'name' },
      },
      '@renderer/components/material/useMusicRowMetrics': {
        useMusicRowMetrics: () => ({
          listItemHeight: ref(60),
          artworkSize: ref(44),
        }),
      },
    }).default

    const VirtualizedList = defineComponent({
      inheritAttrs: false,
      props: {
        list: { type: Array, required: true },
        itemHeight: { type: Number, required: true },
      },
      setup(props, { attrs, slots }) {
        return () => {
          observed.virtualListAttrs.push({ ...attrs, itemHeight: props.itemHeight })
          const rows = props.list.map((item, index) => {
            const renderedRow = slots.default?.({ item, index })
            const row = Array.isArray(renderedRow) ? renderedRow[0] : renderedRow
            if (row) observed.rows.push(row)
            return row
          })
          return h('div', { class: 'virtualized-list' }, rows)
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
      props: {
        index: { type: Number, required: true },
        downloadBtn: { type: Boolean, default: true },
        playBtn: { type: Boolean, default: true },
        listAddBtn: { type: Boolean, default: true },
      },
      setup(props) {
        observed.buttons.push(props)
        return () => h('button', { class: 'actions' }, `actions-${props.index}`)
      },
    })
    const EmptyStub = defineComponent({ setup: () => () => h('div') })
    const app = createSSRApp({ render: () => h(RecentPlay) })
    app.config.globalProperties.$style = new Proxy({}, { get: (_, property) => `recent-${String(property)}` })
    app.config.globalProperties.$t = key => key
    app.component('BaseVirtualizedList', VirtualizedList)
    app.component('MaterialMusicTitleCell', TitleCell)
    app.component('MaterialListButtons', ListButtons)
    app.component('CommonListAddModal', EmptyStub)

    const html = await renderToString(app)
    observed.rows[0].props.onClick()
    observed.rows[0].props.onClick()
    observed.rows[1].props.onClick()
    observed.rows[1].props.onClick()
    return { html, observed, playablePayload, playableRecord, unavailableRecord }
  } finally {
    global.window = originalWindow
  }
}

const createPlayQueueHarness = async() => {
  const current = { ...music('queue-current', 'current.jpg'), name: 'Current Queue Song', singer: 'Current Artist' }
  const later = { ...music('queue-later', 'later.jpg'), name: 'Play Later Song', singer: 'Later Artist' }
  const pending = { ...music('queue-pending', 'pending.jpg'), name: 'Pending Queue Song', singer: 'Pending Artist' }
  const observed = { artwork: [], emits: [], playListCalls: [], playMusicCalls: [] }
  const originalWindow = global.window
  global.window = { i18n: { t: (key, params) => params ? `${key}:${params.num}` : key } }

  try {
    const PlayQueue = loadVueSfc(playQueuePath, {
      '@common/utils/vueTools': require('vue'),
      '@common/constants': { LIST_IDS: { PLAY_LATER: 'play_later' } },
      '@renderer/core/player': {
        playList: (...args) => observed.playListCalls.push(args),
        playMusicByInfo: (...args) => observed.playMusicCalls.push(args),
      },
      '@renderer/store/player/action': { getList: () => [current, pending] },
      '@renderer/store/player/state': {
        playInfo: { playerListId: 'queue-list', playIndex: 0, playerPlayIndex: 0 },
        playMusicInfo: { musicInfo: current, listId: 'queue-list', isTempPlay: false },
        tempPlayList: [{ musicInfo: later, listId: 'later-origin', isTempPlay: true }],
      },
    }).default

    const Artwork = defineComponent({
      props: {
        musicInfo: { type: Object, required: true },
        size: { type: Number, required: true },
      },
      setup(props) {
        observed.artwork.push({ musicInfo: props.musicInfo, size: props.size })
        return () => h('span', { class: 'queue-artwork' }, `artwork-${props.musicInfo.id}`)
      },
    })
    const app = createSSRApp({ render: () => h(PlayQueue, { show: true }) })
    app.config.globalProperties.$style = styleProxy
    app.config.globalProperties.$t = key => key
    app.component('CommonTrackArtwork', Artwork)
    const context = {}
    const shellHtml = await renderToString(app, context)
    const html = context.teleports?.['#root'] ?? shellHtml

    const bindings = PlayQueue.setup({ show: true }, {
      emit: (...args) => observed.emits.push(args),
      expose() {},
    })
    bindings.handlePlayQueueItem(bindings.currentQueueItems.value[0])
    bindings.handlePlayQueueItem(bindings.tempQueueItems.value[0])
    bindings.handlePlayQueueItem(bindings.pendingQueueItems.value[0])

    return { current, html, later, observed, pending }
  } finally {
    global.window = originalWindow
  }
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

test('OnlineList exposes a local hook for narrow action button spacing', async() => {
  const { html } = await createOnlineListHarness(true)

  assert.match(html, /class="actions actionButtons"/)
})

test('OnlineList compiles compact action spacing through the measured unsafe width', async() => {
  const { modules, stylesheet } = await compileOnlineListStyle()
  const expectedSelector = `.${modules.actionButtons} button`
  const matchingRules = []

  stylesheet.walkAtRules('media', mediaRule => {
    mediaRule.walkRules(rule => {
      if (rule.selector == expectedSelector) matchingRules.push({ mediaRule, rule })
    })
  })

  assert.equal(matchingRules.length, 1)
  const [{ mediaRule, rule }] = matchingRules
  const maxWidth = mediaRule.params.match(/^\(max-width:\s*(\d+)px\)$/)?.[1]
  assert.equal(Number(maxWidth), 900)
  assert.deepEqual(
    Object.fromEntries(rule.nodes.map(declaration => [declaration.prop, declaration.value])),
    {
      'margin-right': '1px',
      'padding-left': '3px',
      'padding-right': '3px',
    },
  )
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

test('Recent Play renders history records through artwork title cells and preserves row behavior', async() => {
  const { html, observed, playablePayload } = await createRecentPlayHarness()
  const header = html.match(/<thead>[\s\S]*?<\/thead>/)?.[0] ?? ''

  assert.match(header, />music_title</)
  assert.doesNotMatch(header, />music_singer</)
  assert.deepEqual(observed.titleCells, [
    {
      musicInfo: playablePayload,
      title: 'Recorded Song Name',
      artist: 'Recorded Artist',
      artworkSize: 44,
    },
    {
      musicInfo: null,
      title: 'Unavailable Song Name',
      artist: '--/--',
      artworkSize: 44,
    },
  ])
  assert.deepEqual(observed.titleCellSlots.map(slot => slot
    .filter(vnode => typeof vnode.type == 'string')
    .map(vnode => vnode.children)), [
    ['tag__lossless_24bit'],
    [],
  ])
  assert.equal(countRenderedText(html, 'History Album'), 1)
  assert.equal(countRenderedText(html, '--/--'), 2)
  assert.equal(countRenderedText(html, '04:32'), 1)
  assert.equal(countRenderedText(html, 'formatted-125'), 1)
  assert.equal(countRenderedText(html, 'source_tx'), 1)
  assert.equal(countRenderedText(html, 'source_wy'), 1)
  assert.equal(countRenderedText(html, 'actions-0'), 1)
  assert.equal(countRenderedText(html, 'actions-1'), 1)
  assert.equal(observed.virtualListAttrs.at(-1).itemHeight, 60)

  const firstRow = observed.rows[0]
  assert.match(firstRow.props.class, /recent-playing/)
  assert.match(firstRow.props.class, /\bactive\b/)
  assert.deepEqual(observed.playCalls, [[playablePayload, {
    listId: null,
    isTempPlay: true,
    clearTempList: false,
  }]])

  assert.deepEqual(observed.buttons.map(button => ({
    downloadBtn: button.downloadBtn,
    playBtn: button.playBtn,
    listAddBtn: button.listAddBtn,
  })), [
    { downloadBtn: false, playBtn: true, listAddBtn: true },
    { downloadBtn: false, playBtn: false, listAddBtn: false },
  ])
  const columnStyles = firstRow.children
    .filter(child => child && typeof child == 'object')
    .map(child => child.props?.style)
    .filter(Boolean)
  assert.deepEqual(columnStyles, [
    { flex: '0 0 5%' },
    { flex: '0 0 22%' },
    { flex: '0 0 9%' },
    { flex: '0 0 8%' },
    { flex: '0 0 16%', 'padding-left': '0', 'padding-right': '0' },
  ])
})

test('Play Queue renders 44px artwork for every group and preserves click routing', async() => {
  const { current, html, later, observed, pending } = await createPlayQueueHarness()

  assert.match(html, />player__play_queue</)
  assert.match(html, />player__play_queue_current</)
  assert.match(html, />player__play_queue_later</)
  assert.match(html, />player__play_queue_pending</)
  assert.deepEqual(observed.artwork, [
    { musicInfo: current, size: 44 },
    { musicInfo: later, size: 44 },
    { musicInfo: pending, size: 44 },
  ])
  const rows = html.match(/<button[\s\S]*?<\/button>/g) ?? []
  assert.equal(rows.length, 3)
  assert.match(rows[0], /player__play_queue_current[\s\S]*artwork-queue-current[\s\S]*Current Queue Song[\s\S]*Current Artist/)
  assert.match(rows[1], />1<[\s\S]*artwork-queue-later[\s\S]*Play Later Song[\s\S]*Later Artist/)
  assert.match(rows[2], />1<[\s\S]*artwork-queue-pending[\s\S]*Pending Queue Song[\s\S]*Pending Artist/)
  assert.doesNotMatch(html, /music_album|music_time|favorite|action/)
  assert.deepEqual(observed.playMusicCalls, [[later, {
    listId: 'later-origin',
    isTempPlay: true,
    clearTempList: false,
  }]])
  assert.deepEqual(observed.playListCalls, [['queue-list', 1]])
  assert.deepEqual(observed.emits, [
    ['update:show', false],
    ['update:show', false],
  ])
})
