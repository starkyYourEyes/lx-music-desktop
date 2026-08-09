const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const { createSSRApp, defineComponent, h, ref } = require('vue')
const { renderToString } = require('@vue/server-renderer')
const { loadVueSfc } = require('../scripts/test-utils/load-vue-sfc')

const detailPath = path.join(__dirname, '../src/renderer/views/songList/Detail/index.vue')
const styleProxy = new Proxy({}, { get: (_, property) => String(property) })

test('playlist detail renders its metadata inside the online list scroll header', async() => {
  const listDetailInfo = {
    id: 'playlist-id',
    source: 'kw',
    page: 1,
    limit: 30,
    total: 1,
    list: [{ id: 'song-id' }],
    noItemLabel: '',
    info: {
      name: 'My Playlist',
      desc: 'Playlist Description',
      img: 'cover.jpg',
    },
  }
  const Detail = loadVueSfc(detailPath, {
    '@common/utils/vueTools': require('vue'),
    '@renderer/store/songList/state': { listDetailInfo },
    '@renderer/store/songList/action': {
      clearListDetail() {},
      setVisibleListDetail() {},
    },
    '@common/utils/vueRouter': {
      useRouter: () => ({
        back() {},
        replace: async() => {},
      }),
    },
    '@renderer/store/qqMusic': {
      isLoggedIn: ref(false),
      profile: ref(null),
    },
    './action': {
      addSongListDetail: async() => {},
      playSongListDetail: async() => {},
    },
    './useList': () => ({
      listRef: ref(null),
      listDetailInfo,
      getListData: async() => {},
      handlePlayList() {},
    }),
    './useKeyBack': () => {},
    './useQQDailyRecommendAccount': {
      useQQDailyRecommendDetailAccount() {},
      useQQDailyRecommendDetailCover: () => ref('cover.jpg'),
    },
    '@renderer/store/dailyRecommend/state': {
      DAILY_RECOMMEND_TEMP_LIST_ID: 'daily-recommend',
    },
  }).default

  const MaterialOnlineList = defineComponent({
    inheritAttrs: false,
    setup(_, { slots }) {
      return () => h('main', { class: 'online-scroll-root' }, [
        ...(slots.header?.() ?? []),
        h('div', { class: 'song-list-marker' }, 'Song Rows'),
      ])
    },
  })
  const BaseBtn = defineComponent({
    setup(_, { slots }) {
      return () => h('button', slots.default?.())
    },
  })
  const app = createSSRApp({ render: () => h(Detail) })
  app.config.globalProperties.$style = styleProxy
  app.config.globalProperties.$t = key => key
  app.component('MaterialOnlineList', MaterialOnlineList)
  app.component('BaseBtn', BaseBtn)

  const html = await renderToString(app)
  const scrollRoot = html.indexOf('<main class="online-scroll-root">')
  const playlistName = html.indexOf('My Playlist')
  const songRows = html.indexOf('Song Rows')
  const scrollRootEnd = html.indexOf('</main>', scrollRoot)

  assert.ok(scrollRoot > -1)
  assert.ok(scrollRoot < playlistName)
  assert.ok(playlistName < songRows)
  assert.ok(songRows < scrollRootEnd)
  assert.equal((html.match(/class="songListHeader"/g) ?? []).length, 1)
})
