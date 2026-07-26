const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const deferred = () => {
  let deferredResolve
  let deferredReject
  const promise = new Promise((resolve, reject) => {
    deferredResolve = resolve
    deferredReject = reject
  })
  return { promise, resolve: deferredResolve, reject: deferredReject }
}

const home = title => ({
  title,
  featuredPlaylists: [],
  privatePlaylists: [],
  relatedSongTitle: `${title} songs`,
  relatedSongGroups: [],
  guidePlaylists: [],
})

const testAccountCacheRefreshAndStaleResponses = async() => {
  const accountKey = vue.ref('A')
  const responses = []
  let requestCalls = 0
  let accountRefreshCalls = 0
  const { useQQHomeRecommendData } = loadTsModule(
    path.join(root, 'src/renderer/views/QQRecommend/useQQHomeRecommendData.ts'),
    {
      '@common/utils/vueTools': {
        computed: vue.computed,
        ref: vue.ref,
        shallowRef: vue.shallowRef,
      },
      '@renderer/utils/ipc': {
        getQQMusicHomeRecommendation: async() => {
          requestCalls++
          const response = responses.shift()
          if (response instanceof Error) throw response
          if (response && typeof response.then == 'function') return response
          return response
        },
      },
      '@renderer/store/qqMusic': {
        initQQMusicAccount: async() => { accountRefreshCalls++ },
      },
    },
  )
  const state = useQQHomeRecommendData({ accountKey })

  responses.push(home('A first'))
  await state.load()
  assert.strictEqual(state.data.value.title, 'A first')
  assert.strictEqual(requestCalls, 1)

  await state.load()
  assert.strictEqual(requestCalls, 1, 'same-account cache should avoid duplicate requests')

  responses.push(home('A refreshed'))
  await state.load(true)
  assert.strictEqual(state.data.value.title, 'A refreshed')
  assert.strictEqual(requestCalls, 2)

  const remountedState = useQQHomeRecommendData({ accountKey })
  await remountedState.load()
  assert.strictEqual(requestCalls, 2, 're-entering the page should reuse the account cache')
  assert.strictEqual(remountedState.data.value.title, 'A refreshed')

  const staleA = deferred()
  responses.push(staleA.promise)
  const staleRequest = state.load(true)
  accountKey.value = 'B'
  state.clear()
  responses.push(home('B current'))
  await state.load(true)
  staleA.resolve(home('A stale'))
  await staleRequest
  assert.strictEqual(state.data.value.title, 'B current')

  responses.push(new Error('offline'))
  await state.load(true)
  assert.strictEqual(state.data.value.title, 'B current', 'refresh failure should retain current-account content')
  assert.match(state.loadError.value, /加载失败/)
  assert.strictEqual(accountRefreshCalls, 1)
}

const song = id => ({
  id: `tx_${id}`,
  name: id,
  singer: `${id} Singer`,
  source: 'tx',
  interval: null,
  meta: { id, songId: id, picUrl: `${id}.jpg` },
})

const testRadioCardsFollowCurrentSong = () => {
  const vueTools = { computed: vue.computed }
  const constants = {
    QQ_GUESS_LIKE_CARD_ID: 'qq_guess_like',
    QQ_BRUSH_MODE_CARD_ID: 'qq_brush_mode',
  }
  const songs = vue.ref([song('preview')])
  const currentSong = vue.ref(song('current'))

  const { useQQGuessLikeCard } = loadTsModule(
    path.join(root, 'src/renderer/views/QQRecommend/useQQGuessLikeCard.ts'),
    {
      '@common/utils/vueTools': vueTools,
      '@renderer/views/Recommend/constants': constants,
    },
  )
  const guessLike = useQQGuessLikeCard({
    songs,
    currentSong,
    isLoading: vue.ref(false),
    loadError: vue.ref(''),
    isLoggedIn: vue.ref(true),
  })
  assert.strictEqual(guessLike.card.value.img, 'current.jpg')
  assert.strictEqual(guessLike.card.value.author, 'current Singer')
  assert.strictEqual(guessLike.card.value.desc, 'current · current Singer')

  const { useQQBrushModeCard } = loadTsModule(
    path.join(root, 'src/renderer/views/QQRecommend/useQQBrushModeCard.ts'),
    {
      '@common/utils/vueTools': vueTools,
      '@renderer/views/Recommend/constants': constants,
    },
  )
  const brushMode = useQQBrushModeCard({
    descriptor: vue.ref({ id: '99', title: '刷歌模式', description: '沉浸刷歌' }),
    songs,
    currentSong,
    isLoading: vue.ref(false),
    loadError: vue.ref(''),
    fallbackImg: vue.ref('fallback.jpg'),
  })
  assert.strictEqual(brushMode.card.value.img, 'current.jpg')
  assert.strictEqual(brushMode.card.value.author, 'current Singer')
  assert.strictEqual(brushMode.card.value.desc, 'current · current Singer')

  currentSong.value = null
  assert.strictEqual(guessLike.card.value.img, 'preview.jpg')
  assert.strictEqual(guessLike.card.value.desc, 'preview · preview Singer')
  assert.strictEqual(brushMode.card.value.img, 'preview.jpg')
  assert.strictEqual(brushMode.card.value.desc, 'preview · preview Singer')
}

const testRadioCardsKeepTheirLastPlayedSong = () => {
  const { useQQRadioCardSong } = loadTsModule(
    path.join(root, 'src/renderer/views/QQRecommend/useQQRadioCardSong.ts'),
    {
      '@common/utils/vueTools': {
        computed: vue.computed,
        shallowRef: vue.shallowRef,
        watch: vue.watch,
      },
    },
  )
  const guessLikeCurrentSong = vue.ref(null)
  const brushModeCurrentSong = vue.ref(null)
  const accountKey = vue.ref('account-a')
  const guessLike = useQQRadioCardSong('guessLike', {
    accountKey,
    currentSong: guessLikeCurrentSong,
  })
  const brushMode = useQQRadioCardSong('brushMode', {
    accountKey,
    currentSong: brushModeCurrentSong,
  })

  guessLikeCurrentSong.value = song('guess-first')
  guessLikeCurrentSong.value = song('guess-third')
  guessLikeCurrentSong.value = null
  assert.strictEqual(
    guessLike.song.value.meta.songId,
    'guess-third',
    'leaving the guess-like queue should keep its last played song',
  )
  assert.strictEqual(brushMode.song.value, null, 'radio-card histories should not leak into each other')

  brushModeCurrentSong.value = song('brush-third')
  brushModeCurrentSong.value = null
  assert.strictEqual(brushMode.song.value.meta.songId, 'brush-third')
  assert.strictEqual(guessLike.song.value.meta.songId, 'guess-third')

  const remountedGuessLike = useQQRadioCardSong('guessLike', {
    accountKey,
    currentSong: vue.ref(null),
  })
  assert.strictEqual(
    remountedGuessLike.song.value.meta.songId,
    'guess-third',
    'returning from another route should keep the last played song',
  )

  accountKey.value = 'account-b'
  assert.strictEqual(guessLike.song.value, null, 'switching accounts should clear guess-like history')
  assert.strictEqual(brushMode.song.value, null, 'switching accounts should clear brush-mode history')

  brushModeCurrentSong.value = song('account-b-brush')
  brushModeCurrentSong.value = null
  guessLike.clear()
  assert.strictEqual(guessLike.song.value, null, 'explicit cleanup should clear the saved song')
  assert.strictEqual(brushMode.song.value.meta.songId, 'account-b-brush')
}

const testPlaylistAndRelatedSongPlayback = async() => {
  const relatedSongs = vue.ref([song('one'), song('two')])
  const isPlay = vue.ref(true)
  const playInfo = { playerListId: null }
  const playMusicInfo = { musicInfo: null }
  const tempListMeta = { id: '' }
  const calls = { routes: [], details: [], tempLists: [], playLists: [], pause: 0, play: 0, errors: [] }
  const { useQQHomeRecommendPlayback, QQ_HOME_RELATED_TEMP_LIST_ID } = loadTsModule(
    path.join(root, 'src/renderer/views/QQRecommend/useQQHomeRecommendPlayback.ts'),
    {
      '@common/constants': { LIST_IDS: { TEMP: 'temp' } },
      '@common/utils/vueRouter': {
        useRoute: () => ({ name: 'QQRecommend' }),
        useRouter: () => ({ push: async route => { calls.routes.push(route) } }),
      },
      '@renderer/core/player': {
        pause: () => { calls.pause++ },
        play: () => { calls.play++ },
        playList: (id, index) => { calls.playLists.push({ id, index }) },
      },
      '@renderer/store/list/action': {
        setTempList: async(id, list) => {
          tempListMeta.id = id
          calls.tempLists.push({ id, list })
        },
      },
      '@renderer/store/list/state': { tempListMeta },
      '@renderer/store/player/state': { isPlay, playInfo, playMusicInfo },
      '@renderer/views/Recommend/utils': { toCloneable: value => JSON.parse(JSON.stringify(value)) },
      '@renderer/views/songList/Detail/action': {
        playSongListDetail: async(id, source) => { calls.details.push({ id, source }) },
      },
    },
  )
  const playback = useQQHomeRecommendPlayback({
    relatedSongs,
    setError: message => calls.errors.push(message),
  })
  const playlist = {
    id: '7001',
    source: 'tx',
    name: 'Private One',
    img: 'private.jpg',
    description: '',
    author: 'QQ Music',
    playCount: '',
  }

  await playback.openPlaylist(playlist)
  assert.strictEqual(calls.routes[0].path, '/songList/detail')
  assert.deepStrictEqual(calls.routes[0].query, {
    source: 'tx',
    id: '7001',
    picUrl: 'private.jpg',
    fromName: 'QQRecommend',
  })

  await playback.togglePlaylist(playlist)
  assert.deepStrictEqual(calls.details, [{ id: '7001', source: 'tx' }])

  playInfo.playerListId = 'temp'
  tempListMeta.id = 'tx__7001'
  await playback.togglePlaylist(playlist)
  assert.strictEqual(calls.pause, 1)

  playInfo.playerListId = null
  tempListMeta.id = ''
  await playback.playRelatedSong(1)
  assert.strictEqual(calls.tempLists[0].id, QQ_HOME_RELATED_TEMP_LIST_ID)
  assert.deepStrictEqual(calls.tempLists[0].list.map(item => item.id), ['tx_one', 'tx_two'])
  assert.deepStrictEqual(calls.playLists[0], { id: 'temp', index: 1 })

  playInfo.playerListId = 'temp'
  playMusicInfo.musicInfo = relatedSongs.value[1]
  await playback.playRelatedSong(1)
  assert.strictEqual(calls.pause, 2)

  assert.strictEqual(playback.isRelatedSongsPlaying(), true)
  relatedSongs.value = [song('three'), song('four')]
  assert.strictEqual(
    playback.isRelatedSongsPlaying(),
    false,
    'switching the visible related-song page should clear the section playing state',
  )
}

const testPageAndComponentWiring = () => {
  const componentFiles = [
    'src/renderer/views/QQRecommend/components/QQFeaturedSection.vue',
    'src/renderer/views/QQRecommend/components/QQPlaylistSection.vue',
    'src/renderer/views/QQRecommend/components/QQRelatedSongsSection.vue',
  ]
  for (const file of componentFiles) assert(fs.existsSync(path.join(root, file)), `${file} should exist`)

  const page = read('src/renderer/views/QQRecommend/index.vue')
  const featured = read('src/renderer/views/QQRecommend/components/QQFeaturedSection.vue')
  const playlists = read('src/renderer/views/QQRecommend/components/QQPlaylistSection.vue')
  const related = read('src/renderer/views/QQRecommend/components/QQRelatedSongsSection.vue')
  assert.match(page, /useQQHomeRecommendData/)
  assert.match(page, /QQFeaturedSection/)
  assert.match(page, /QQPlaylistSection/)
  assert.match(page, /QQRelatedSongsSection/)
  assert.match(page, /loadQQBrushModeSongs\(force\)/)
  assert.match(page, /useQQRadioCardSong/)
  assert.match(page, /clearGuessLikeCardSong\(\)/)
  assert.match(page, /clearBrushModeCardSong\(\)/)
  assert.match(page, /你的私荐歌单/)
  assert.match(page, /歌单遨游指南/)
  assert.match(related, /上一组/)
  assert.match(related, /下一组/)
  assert.match(related, /emit\('previous'\)/)
  assert.match(related, /emit\('next'\)/)
  for (const source of [featured, playlists]) {
    assert.match(source, /@keydown\.enter\.self=/)
    assert.match(source, /@keydown\.space\.self\.prevent=/)
  }
}

const main = async() => {
  await testAccountCacheRefreshAndStaleResponses()
  testRadioCardsFollowCurrentSong()
  testRadioCardsKeepTheirLastPlayedSong()
  await testPlaylistAndRelatedSongPlayback()
  testPageAndComponentWiring()
  console.log('QQ Music home renderer tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
