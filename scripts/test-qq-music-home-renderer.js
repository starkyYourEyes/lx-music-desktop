const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vue = require('vue')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
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
    id: '7001', source: 'tx', name: 'Private One', img: 'private.jpg',
    description: '', author: 'QQ Music', playCount: '',
  }

  await playback.openPlaylist(playlist)
  assert.strictEqual(calls.routes[0].path, '/songList/detail')
  assert.deepStrictEqual(calls.routes[0].query, {
    source: 'tx', id: '7001', picUrl: 'private.jpg', fromName: 'QQRecommend',
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
}

const testPageAndComponentWiring = () => {
  const componentFiles = [
    'src/renderer/views/QQRecommend/components/QQFeaturedSection.vue',
    'src/renderer/views/QQRecommend/components/QQPlaylistSection.vue',
    'src/renderer/views/QQRecommend/components/QQRelatedSongsSection.vue',
  ]
  for (const file of componentFiles) assert(fs.existsSync(path.join(root, file)), `${file} should exist`)

  const page = read('src/renderer/views/QQRecommend/index.vue')
  const related = read('src/renderer/views/QQRecommend/components/QQRelatedSongsSection.vue')
  assert.match(page, /useQQHomeRecommendData/)
  assert.match(page, /QQFeaturedSection/)
  assert.match(page, /QQPlaylistSection/)
  assert.match(page, /QQRelatedSongsSection/)
  assert.match(page, /你的私荐歌单/)
  assert.match(page, /歌单遨游指南/)
  assert.match(related, /上一组/)
  assert.match(related, /下一组/)
  assert.match(related, /emit\('previous'\)/)
  assert.match(related, /emit\('next'\)/)
}

const main = async() => {
  await testAccountCacheRefreshAndStaleResponses()
  await testPlaylistAndRelatedSongPlayback()
  testPageAndComponentWiring()
  console.log('QQ Music home renderer tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
