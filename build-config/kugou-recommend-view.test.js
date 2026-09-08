const assert = require('node:assert/strict')
const path = require('node:path')
const { test } = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const dataPath = path.join(root, 'src/renderer/views/KugouRecommend/useKugouRecommendData.ts')
const playbackPath = path.join(root, 'src/renderer/views/KugouRecommend/useKugouRecommendPlayback.ts')
const kugouCommonPath = path.join(root, 'src/common/kugouMusic.ts')

const readSource = relativePath => require('node:fs').readFileSync(path.join(root, relativePath), 'utf8')

const deferred = () => {
  let resolvePromise
  let rejectPromise
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

const createVueTools = (cleanups = []) => ({
  computed: getter => ({ get value() { return getter() } }),
  onBeforeUnmount: callback => cleanups.push(callback),
  ref: value => ({ value }),
  shallowRef: value => ({ value }),
  toRaw: value => value,
})

const translate = (key, values = {}) => Object.entries(values)
  .reduce((message, [name, value]) => message.replace(`{${name}}`, String(value)), key)
const i18nMock = { useI18n: () => translate }

const publicRecommendation = () => ({
  playlists: [{ id: 'playlist-1', source: 'kg', name: 'Playlist', img: 'cover.jpg', description: '', author: '', playCount: '' }],
  ranks: [],
})
const rankRecommendation = () => ({ rank: null, songs: [{ id: 'kg_rank', source: 'kg', meta: { hash: 'rank' } }] })
const song = id => ({ id: `kg_${id}`, source: 'kg', meta: { hash: id } })

const createDataHarness = (overrides = {}) => {
  const cleanups = []
  const calls = { public: 0, rank: 0, daily: 0, style: 0, fm: 0, accountSync: 0 }
  const ipc = {
    getKugouPublicRecommendation: async() => {
      calls.public++
      return overrides.public ? overrides.public() : publicRecommendation()
    },
    getKugouRankRecommendation: async() => {
      calls.rank++
      return overrides.rank ? overrides.rank() : rankRecommendation()
    },
    getKugouDailyRecommendSongs: async() => {
      calls.daily++
      return overrides.daily ? overrides.daily() : [song('daily')]
    },
    getKugouStyleRecommendation: async() => {
      calls.style++
      return overrides.style ? overrides.style() : [song('style')]
    },
    getKugouPrivateFmSongs: async() => {
      calls.fm++
      return overrides.fm ? overrides.fm() : [song('fm')]
    },
  }
  const kugouCommon = require('node:fs').existsSync(kugouCommonPath)
    ? loadTsModule(kugouCommonPath)
    : { isKugouAuthError: () => false }
  const data = loadTsModule(dataPath, {
    '@common/utils/vueTools': createVueTools(cleanups),
    '@common/kugouMusic': kugouCommon,
    '@renderer/store/kugouMusic': {
      initKugouMusicAccount: async force => {
        calls.accountSync++
        assert.equal(force, true)
        return overrides.syncAccount ? overrides.syncAccount() : { isLoggedIn: false, profile: null }
      },
    },
    '@renderer/utils/ipc': ipc,
  })
  return { calls, cleanups, data }
}

test('Kugou public recommendation loads for guests while private loaders wait for an account', async() => {
  const { calls, data } = createDataHarness()
  const accountKey = { value: null }
  const state = data.useKugouRecommendData({ accountKey })

  await state.loadAll()

  assert.deepEqual(calls, { public: 1, rank: 1, daily: 0, style: 0, fm: 0, accountSync: 0 })
  assert.equal(state.playlists.value[0].id, 'playlist-1')
  assert.equal(state.publicSongs.value[0].id, 'kg_rank')
})

test('a failed private request does not replace loaded public recommendation data', async() => {
  const { calls, data } = createDataHarness({ daily: async() => { throw new Error('daily unavailable') } })
  const accountKey = { value: '42:1' }
  const state = data.useKugouRecommendData({ accountKey })

  await state.loadAll()

  assert.equal(state.playlists.value[0].id, 'playlist-1')
  assert.equal(state.dailySongs.value.length, 0)
  assert.equal(state.dailySongsLoadError.value, 'daily unavailable')
  assert.equal(state.styleSongs.value[0].id, 'kg_style')
  assert.equal(calls.accountSync, 0)
})

test('focused reloads call only their endpoint and preserve other sections', async() => {
  let dailyCalls = 0
  const { calls, data } = createDataHarness({
    daily: async() => {
      if (++dailyCalls == 1) return [song('daily')]
      throw new Error('daily unavailable')
    },
  })
  const state = data.useKugouRecommendData({ accountKey: { value: '42:1' } })
  await state.loadAll()
  const styleBefore = state.styleSongs.value
  const fmBefore = state.fmSongs.value
  Object.keys(calls).forEach(key => { calls[key] = 0 })

  await state.loadDailySongs(true)

  assert.deepEqual(calls, { public: 0, rank: 0, daily: 1, style: 0, fm: 0, accountSync: 0 })
  assert.equal(state.dailySongsLoadError.value, 'daily unavailable')
  assert.equal(state.styleSongs.value, styleBefore)
  assert.equal(state.fmSongs.value, fmBefore)
})

test('each focused loader calls only its matching recommendation endpoint', async() => {
  const { calls, data } = createDataHarness()
  const state = data.useKugouRecommendData({ accountKey: { value: '42:1' } })
  const cases = [
    ['loadPublicRecommendation', 'public'],
    ['loadRankRecommendation', 'rank'],
    ['loadDailySongs', 'daily'],
    ['loadStyleSongs', 'style'],
    ['loadFmSongs', 'fm'],
  ]

  for (const [method, endpoint] of cases) {
    Object.keys(calls).forEach(key => { calls[key] = 0 })
    await state[method](true)
    assert.deepEqual(calls, {
      public: endpoint == 'public' ? 1 : 0,
      rank: endpoint == 'rank' ? 1 : 0,
      daily: endpoint == 'daily' ? 1 : 0,
      style: endpoint == 'style' ? 1 : 0,
      fm: endpoint == 'fm' ? 1 : 0,
      accountSync: 0,
    })
  }
})

test('private-only account loading does not start public endpoints', async() => {
  const { calls, data } = createDataHarness()
  const accountKey = { value: null }
  const state = data.useKugouRecommendData({ accountKey })
  await state.loadPublic()
  accountKey.value = '42:1'
  state.clearPrivate()
  Object.keys(calls).forEach(key => { calls[key] = 0 })

  await state.loadPrivate(true)

  assert.deepEqual(calls, { public: 0, rank: 0, daily: 1, style: 1, fm: 1, accountSync: 0 })
})

test('a classified private auth failure refreshes renderer account state once', async() => {
  const accountKey = { value: '42:1' }
  const authFailure = async() => { throw new Error('Error invoking remote method: KUGOU_AUTH_REQUIRED') }
  const { calls, data } = createDataHarness({
    daily: authFailure,
    style: authFailure,
    fm: authFailure,
    syncAccount: async() => {
      accountKey.value = null
      return { isLoggedIn: false, profile: null }
    },
  })
  const state = data.useKugouRecommendData({ accountKey })

  await state.loadPrivate(true)

  assert.equal(calls.accountSync, 1)
  assert.equal(accountKey.value, null)
  assert.equal(state.isLoadingPrivate.value, false)
})

test('an account change discards stale private responses', async() => {
  const firstDaily = deferred()
  let dailyCalls = 0
  const { data } = createDataHarness({ daily: () => ++dailyCalls == 1 ? firstDaily.promise : Promise.resolve([song('new')]) })
  const accountKey = { value: 'first:1' }
  const state = data.useKugouRecommendData({ accountKey })
  const firstLoad = state.loadAll()

  accountKey.value = 'second:2'
  const secondLoad = state.loadAll()
  firstDaily.resolve([song('old')])
  await Promise.all([firstLoad, secondLoad])

  assert.notEqual(state.dailySongs.value[0]?.id, 'kg_old')
  assert.equal(state.dailySongs.value[0]?.id, 'kg_new')
})

test('unmount discards late public recommendation responses', async() => {
  const publicLoad = deferred()
  const rankLoad = deferred()
  const { cleanups, data } = createDataHarness({
    public: () => publicLoad.promise,
    rank: () => rankLoad.promise,
  })
  const state = data.useKugouRecommendData({ accountKey: { value: null } })
  const loading = state.loadAll()

  cleanups.forEach(callback => callback())
  publicLoad.resolve(publicRecommendation())
  rankLoad.resolve(rankRecommendation())
  await loading

  assert.equal(state.playlists.value.length, 0)
  assert.equal(state.publicSongs.value.length, 0)
  assert.equal(state.isLoadingPublic.value, false)
})

test('clearing private data does not invalidate an in-flight guest public load', async() => {
  const publicLoad = deferred()
  const rankLoad = deferred()
  const { data } = createDataHarness({
    public: () => publicLoad.promise,
    rank: () => rankLoad.promise,
  })
  const state = data.useKugouRecommendData({ accountKey: { value: null } })
  const loading = state.loadAll()

  state.clearPrivate()
  publicLoad.resolve(publicRecommendation())
  rankLoad.resolve(rankRecommendation())
  await loading

  assert.equal(state.playlists.value[0].id, 'playlist-1')
  assert.equal(state.publicSongs.value[0].id, 'kg_rank')
  assert.equal(state.isLoadingPublic.value, false)
})

test('Kugou playback routes playlists and installs a MusicInfo_kg temporary list', async() => {
  const calls = { push: [], setTempList: [], playList: [], playSongListDetail: [] }
  const router = { push: async location => calls.push.push(location) }
  const playback = loadTsModule(playbackPath, {
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@common/utils/vueRouter': { useRoute: () => ({ name: 'KugouRecommend' }), useRouter: () => router },
    '@renderer/core/player': { pause: () => {}, play: () => {}, playList: (...args) => calls.playList.push(args) },
    '@renderer/store/list/action': { setTempList: async(...args) => calls.setTempList.push(args) },
    '@renderer/store/list/state': { tempListMeta: { id: '' } },
    '@renderer/store/player/state': {
      isPlay: { value: false },
      playInfo: { playerListId: null },
      playMusicInfo: { musicInfo: null },
    },
    '@renderer/views/Recommend/utils': { toCloneable: value => value },
    '@renderer/views/songList/Detail/action': { playSongListDetail: async(...args) => calls.playSongListDetail.push(args) },
    '@root/lang': i18nMock,
  })
  const publicSongs = { value: [song('rank')] }
  const usePlayback = playback.useKugouRecommendPlayback({
    publicSongs,
    dailySongs: { value: [] },
    styleSongs: { value: [] },
    fmSongs: { value: [] },
    setError: message => { throw new Error(message) },
  })
  const playlist = publicRecommendation().playlists[0]

  await usePlayback.openPlaylist(playlist)
  await usePlayback.playSection('public')

  assert.deepEqual(calls.push[0], {
    path: '/songList/detail',
    query: { source: 'kg', id: 'playlist-1', picUrl: 'cover.jpg', fromName: 'KugouRecommend' },
  })
  assert.equal(calls.setTempList[0][0], 'kg__recommend_rank')
  assert.equal(calls.setTempList[0][1][0].source, 'kg')
  assert.deepEqual(calls.playList[0], ['temp', 0])
})

test('Kugou playback retries a failed temporary-list installation', async() => {
  const calls = { errors: [], setTempList: 0, playList: [] }
  const tempListMeta = { id: '' }
  const playerState = { playerListId: null }
  const playback = loadTsModule(playbackPath, {
    '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
    '@common/utils/vueRouter': { useRoute: () => ({ name: 'KugouRecommend' }), useRouter: () => ({ push: async() => {} }) },
    '@renderer/core/player': { pause: () => {}, play: () => {}, playList: (...args) => calls.playList.push(args) },
    '@renderer/store/list/action': {
      setTempList: async() => {
        calls.setTempList++
        if (calls.setTempList == 1) {
          tempListMeta.id = 'kg__recommend_rank'
          playerState.playerListId = 'temp'
          throw new Error('disk write failed')
        }
      },
    },
    '@renderer/store/list/state': { tempListMeta },
    '@renderer/store/player/state': {
      isPlay: { value: false },
      playInfo: playerState,
      playMusicInfo: { musicInfo: null },
    },
    '@renderer/views/Recommend/utils': { toCloneable: value => value },
    '@renderer/views/songList/Detail/action': { playSongListDetail: async() => {} },
    '@root/lang': i18nMock,
  })
  const usePlayback = playback.useKugouRecommendPlayback({
    publicSongs: { value: [song('rank')] },
    dailySongs: { value: [] },
    styleSongs: { value: [] },
    fmSongs: { value: [] },
    setError: message => calls.errors.push(message),
  })

  await usePlayback.playSection('public')
  await usePlayback.playSection('public')

  assert.equal(calls.setTempList, 2)
  assert.deepEqual(calls.playList, [['temp', 0]])
})

test('Kugou recommendation page is registered in the router and sidebar', () => {
  const router = readSource('src/renderer/router.ts')
  const nav = readSource('src/renderer/components/layout/Aside/NavBar.vue')

  assert.match(router, /path:\s*['"]\/kg-recommend['"]/)
  assert.match(router, /name:\s*['"]KugouRecommend['"]/)
  assert.match(router, /views\/KugouRecommend\/index\.vue/)
  assert.match(nav, /kugou-music\.svg/)
  assert.match(nav, /to:\s*['"]\/kg-recommend['"]/)
  assert.match(nav, /tips:\s*['"]kugou_recommend['"]/)
  assert.match(nav, /\$style\.separator\]: index == 3/)
})

test('Kugou account action initializes the provider and routes login requests', () => {
  const aside = readSource('src/renderer/components/layout/Aside/index.vue')

  assert.match(aside, /profile\s+as\s+kugouProfile/)
  assert.match(aside, /isLoggedIn\s+as\s+kugouIsLoggedIn/)
  assert.match(aside, /logoutKugouMusicAccount/)
  assert.match(aside, /initKugouMusicAccount/)
  assert.match(aside, /show-kugou-music-login/)
  assert.match(aside, /path:\s*['"]\/kg-recommend['"]/)
  assert.match(aside, /login:\s*['"]kugou['"]/)
  assert.match(aside, /if \(route\.path == ['"]\/kg-recommend['"]\) \{\s*window\.dispatchEvent\(new Event\(['"]show-kugou-music-login['"]\)\)\s*return\s*\}/)
})

test('Kugou page keeps public content outside the account guard and private content inside it', () => {
  const page = readSource('src/renderer/views/KugouRecommend/index.vue')
  const publicSection = page.indexOf('<kugou-playlist-section')
  const loginGuard = page.indexOf('<template v-if="accountKey">')
  const privateSection = page.indexOf('<kugou-songs-section', loginGuard)

  assert.ok(publicSection >= 0, 'expected a public playlist section')
  assert.ok(loginGuard > publicSection, 'expected public content before the account guard')
  assert.ok(privateSection > loginGuard, 'expected private song sections inside the account guard')
  assert.match(page, /route\.query\.login/)
  assert.match(page, /login\s*==\s*['"]kugou['"]/)
  assert.match(page, /addEventListener\(['"]show-kugou-music-login['"]/)
  assert.match(page, /removeEventListener\(['"]show-kugou-music-login['"]/)
  assert.match(page, /watch\(accountKey/)
  assert.match(page, /clearPrivate\(\)/)
})

test('Kugou page starts public loading before account initialization and uses focused reloads', () => {
  const page = readSource('src/renderer/views/KugouRecommend/index.vue')
  const mounted = page.slice(page.indexOf('onMounted(() => {'))

  assert.ok(mounted.indexOf('void data.loadPublic()') < mounted.indexOf('void initializeAccount()'))
  assert.match(page, /await data\.loadPrivate\(\)/)
  assert.match(page, /if \(!isInitializingAccount\) void data\.loadPrivate\(\)/)
  assert.match(page, /@retry="data\.loadPublicRecommendation\(true\)"/)
  assert.match(page, /@retry="data\.loadRankRecommendation\(true\)"/)
  assert.match(page, /@retry="data\.loadDailySongs\(true\)"/)
  assert.match(page, /@retry="data\.loadStyleSongs\(true\)"/)
  assert.match(page, /@retry="data\.loadFmSongs\(true\)"/)
  assert.match(page, /SectionRefreshButton/)
  assert.match(page, /const handleRefresh = data\.handleRefresh/)
  assert.match(page, /@click="handleRefresh"/)
})

test('Kugou section templates render loading, error, empty, and content exclusively', () => {
  for (const name of ['KugouPlaylistSection', 'KugouSongsSection', 'KugouFeaturedSection']) {
    const source = readSource(`src/renderer/views/KugouRecommend/components/${name}.vue`)
    assert.match(source, /v-if="loading[^"]*"/)
    assert.match(source, /v-else-if="error"/)
    assert.match(source, /v-else-if="![a-zA-Z]+\.length"/)
    assert.doesNotMatch(source, /v-if="error"[\s\S]*v-if="loading/)
  }
})

test('Kugou login and playback composables contain no hardcoded Chinese UI text', () => {
  const login = readSource('src/renderer/views/KugouRecommend/useKugouMusicLoginQr.ts')
  const playback = readSource('src/renderer/views/KugouRecommend/useKugouRecommendPlayback.ts')

  assert.doesNotMatch(login, /[\u3400-\u9fff]/)
  assert.doesNotMatch(playback, /[\u3400-\u9fff]/)
  assert.match(login, /useI18n/)
  assert.match(playback, /useI18n/)
})
