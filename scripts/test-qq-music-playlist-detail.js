const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const root = path.resolve(__dirname, '..')
const deferred = () => {
  let resolve
  const promise = new Promise(promiseResolve => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

class QQMusicAuthError extends Error {}

const normalizedSong = id => ({
  id: `tx_${id}`,
  name: `Song ${id}`,
  source: 'tx',
  meta: { id },
})

const signedBodies = []
const loadService = () => loadTsModule(
  path.join(root, 'src/main/modules/qqMusic/playlistDetail.ts'),
  {
    './auth': {
      getCookieValue: (cookie, key) => {
        const match = cookie.match(new RegExp(`(?:^|;\\s*)${key}=([^;]*)`))
        return match?.[1] ?? ''
      },
      getGtk: () => 123456,
    },
    './request': {
      createQQMusicRequestSign: body => {
        signedBodies.push(body)
        return 'test-sign'
      },
      createQQMusicFallbackGuid: uin => `fallback-guid-${uin}`,
      createQQMusicFallbackUid: uin => `fallback-uid-${uin}`,
    },
    './song': {
      normalizeQQMusicTracks: tracks => tracks.map(track => normalizedSong(track.id)),
      QQMusicAuthError,
    },
  },
)

const playlistPayload = () => ({
  code: 0,
  req_1: {
    code: 0,
    data: {
      code: 0,
      total_song_num: 2,
      dirinfo: {
        title: '百万收藏',
        picurl: 'fallback.jpg',
        picurl2: 'cover.jpg',
        desc: '热门歌曲',
        host_nick: 'QQ音乐官方歌单',
        listennum: 123456,
      },
      songlist: [{ id: 101 }, { id: 102 }],
    },
  },
})

const testAuthenticatedPlaylistDetail = async() => {
  signedBodies.length = 0
  const requests = []
  let clearCalls = 0
  const { createQQMusicPlaylistDetailService } = loadService()
  const service = createQQMusicPlaylistDetailService({
    getCookie: () => 'uin=o12345; qqmusic_key=secret-key; qqmusic_guid=guid-123; uid=uid-123',
    fetchImpl: async(url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) })
      return { ok: true, json: async() => playlistPayload() }
    },
    setTimeoutImpl: () => 42,
    clearTimeoutImpl: id => {
      assert.strictEqual(id, 42)
      clearCalls++
    },
  })

  const result = await service.getPlaylistDetail('211111', 1)

  assert.strictEqual(requests.length, 1)
  assert.strictEqual(new URL(requests[0].url).searchParams.get('sign'), 'test-sign')
  assert.strictEqual(requests[0].options.headers.Cookie, 'uin=o12345; qqmusic_key=secret-key; qqmusic_guid=guid-123; uid=uid-123')
  assert.strictEqual(signedBodies[0], requests[0].options.body)
  assert.deepStrictEqual(requests[0].body.comm, {
    format: 'json',
    ct: 20,
    cv: 2116,
    platform: 'wk_v17',
    uid: 'uid-123',
    guid: 'guid-123',
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    notice: 0,
    needNewCode: 1,
    uin: '12345',
    g_tk_new_20200303: 123456,
    g_tk: 123456,
  })
  assert.deepStrictEqual(requests[0].body.req_1, {
    module: 'music.srfDissInfo.aiDissInfo',
    method: 'uniform_get_Dissinfo',
    param: {
      disstid: 211111,
      userinfo: 1,
      tag: 1,
      is_pc: 1,
      guid: 'guid-123',
      enc_host_uin: '12345',
      dirid: 0,
    },
  })
  assert.deepStrictEqual(result, {
    list: [normalizedSong(101), normalizedSong(102)],
    source: 'tx',
    desc: '热门歌曲',
    total: 2,
    page: 1,
    limit: 2,
    key: null,
    id: '211111',
    info: {
      name: '百万收藏',
      img: 'cover.jpg',
      desc: '热门歌曲',
      author: 'QQ音乐官方歌单',
      play_count: '12万',
    },
    noItemLabel: '',
  })
  assert.strictEqual(clearCalls, 1)
}

const testValidationAndFailures = async() => {
  const { createQQMusicPlaylistDetailService } = loadService()
  let fetchCalls = 0
  const invalid = createQQMusicPlaylistDetailService({
    getCookie: () => 'uin=o12345; qqmusic_key=secret',
    fetchImpl: async() => {
      fetchCalls++
      return { ok: true, json: async() => playlistPayload() }
    },
  })
  await assert.rejects(invalid.getPlaylistDetail('not-an-id'), /playlist detail request failed/)
  assert.strictEqual(fetchCalls, 0)

  const signedOut = createQQMusicPlaylistDetailService({
    getCookie: () => '',
    fetchImpl: async() => {
      fetchCalls++
      return { ok: true, json: async() => playlistPayload() }
    },
  })
  await assert.rejects(signedOut.getPlaylistDetail('211111'), QQMusicAuthError)
  assert.strictEqual(fetchCalls, 0)

  const expired = createQQMusicPlaylistDetailService({
    getCookie: () => 'uin=o12345; qqmusic_key=expired',
    fetchImpl: async() => ({
      ok: true,
      json: async() => ({ code: 0, req_1: { code: 1000 } }),
    }),
  })
  await assert.rejects(expired.getPlaylistDetail('211111'), QQMusicAuthError)

  const invalidData = createQQMusicPlaylistDetailService({
    getCookie: () => 'uin=o12345; qqmusic_key=secret',
    fetchImpl: async() => ({
      ok: true,
      json: async() => ({ code: 0, req_1: { code: 0, data: { code: 10 } } }),
    }),
  })
  await assert.rejects(invalidData.getPlaylistDetail('211111'), /playlist detail request failed/)
}

const detail = (id, name) => ({
  id,
  source: 'tx',
  list: [normalizedSong(name)],
  total: 1,
  page: 1,
  limit: 1,
  key: null,
  desc: null,
  info: { name, img: '', desc: null, author: '', play_count: '' },
  noItemLabel: '',
})

const testRendererPrefersAuthenticatedDetailAndFallsBack = async() => {
  const calls = { qq: [], legacy: [] }
  const listState = {
    tags: {},
    listInfo: {},
    listDetailInfo: {},
    selectListInfo: {},
    isVisibleListDetail: { value: false },
    openSongListInputInfo: {},
  }
  const action = loadTsModule(
    path.join(root, 'src/renderer/store/songList/action.ts'),
    {
      '@renderer/utils': {
        deduplicationList: list => list,
        toNewMusicInfo: music => ({ ...music, converted: true }),
      },
      '@renderer/utils/musicSdk': {
        tx: {
          songList: {
            getListDetail: async(id, page) => {
              calls.legacy.push({ id, page })
              return detail(id, 'legacy')
            },
          },
        },
      },
      '@renderer/utils/ipc': {
        getNeteasePlaylistDetail: async() => {
          throw new Error('NetEase should not load')
        },
        getQQMusicPlaylistDetail: async(id, page) => {
          calls.qq.push({ id, page })
          if (id == '211207') throw new Error('temporary QQ failure')
          return detail(id, 'authenticated')
        },
      },
      '@renderer/store/qqMusic': { getQQMusicAccountKey: () => 'account-a' },
      '@renderer/store/dailyRecommend/action': {
        getDailyRecommendPlaylistDetail: async() => detail('daily', 'netease daily'),
        loadDailyRecommendSongs: async() => [],
      },
      '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
      '@renderer/store/qqDailyRecommend/action': {
        getQQDailyRecommendPlaylistDetail: async() => detail('qq_daily_30', 'QQ daily'),
      },
      '@renderer/store/qqDailyRecommend/state': {
        QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30',
        qqDailyRecommendGeneration: { value: 0 },
      },
      '@common/utils/vueTools': {
        markRaw: value => value,
        markRawList: value => value,
      },
      './state': listState,
    },
  )

  const authenticated = await action.getListDetail('211111', 'tx', 1)
  assert.deepStrictEqual(calls.qq, [{ id: '211111', page: 1 }])
  assert.deepStrictEqual(calls.legacy, [])
  assert.strictEqual(authenticated.info.name, 'authenticated')
  assert.strictEqual(authenticated.list[0].id, 'tx_authenticated')

  const originalWarn = console.warn
  console.warn = () => {}
  let fallback
  try {
    fallback = await action.getListDetail('211207', 'tx', 1)
  } finally {
    console.warn = originalWarn
  }
  assert.deepStrictEqual(calls.qq, [
    { id: '211111', page: 1 },
    { id: '211207', page: 1 },
  ])
  assert.deepStrictEqual(calls.legacy, [{ id: '211207', page: 1 }])
  assert.strictEqual(fallback.info.name, 'legacy')
}

const testAccountSwitchDoesNotCacheStalePlaylistDetail = async() => {
  let accountKey = 'account-a'
  let requestCalls = 0
  const accountARequest = deferred()
  const action = loadTsModule(
    path.join(root, 'src/renderer/store/songList/action.ts'),
    {
      '@renderer/utils': { deduplicationList: list => list, toNewMusicInfo: music => music },
      '@renderer/utils/musicSdk': {
        tx: { songList: { getListDetail: async() => detail('legacy', 'legacy') } },
      },
      '@renderer/utils/ipc': {
        getNeteasePlaylistDetail: async() => detail('netease', 'netease'),
        getQQMusicPlaylistDetail: async(id) => {
          requestCalls++
          return requestCalls == 1 ? accountARequest.promise : detail(id, 'account-b')
        },
      },
      '@renderer/store/qqMusic': { getQQMusicAccountKey: () => accountKey },
      '@renderer/store/dailyRecommend/action': {
        getDailyRecommendPlaylistDetail: async() => detail('daily', 'netease daily'),
        loadDailyRecommendSongs: async() => [],
      },
      '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
      '@renderer/store/qqDailyRecommend/action': {
        getQQDailyRecommendPlaylistDetail: async() => detail('qq_daily_30', 'QQ daily'),
      },
      '@renderer/store/qqDailyRecommend/state': {
        QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30',
        qqDailyRecommendGeneration: { value: 0 },
      },
      '@common/utils/vueTools': {
        markRaw: value => value,
        markRawList: value => value,
      },
      './state': {
        tags: {},
        listInfo: {},
        listDetailInfo: {},
        selectListInfo: {},
        isVisibleListDetail: { value: false },
        openSongListInputInfo: {},
      },
    },
  )

  const stale = action.getListDetail('211111', 'tx', 1)
  accountKey = 'account-b'
  accountARequest.resolve(detail('211111', 'account-a'))
  await stale
  const current = await action.getListDetail('211111', 'tx', 1)

  assert.strictEqual(requestCalls, 2)
  assert.strictEqual(current.info.name, 'account-b')
}

const testAccountSwitchDoesNotRenderStalePlaylistDetail = async() => {
  let accountKey = 'account-a'
  const accountARequest = deferred()
  const listDetailInfo = { list: [], key: null, info: {} }
  const action = loadTsModule(
    path.join(root, 'src/renderer/store/songList/action.ts'),
    {
      '@renderer/utils': { deduplicationList: list => list, toNewMusicInfo: music => music },
      '@renderer/utils/musicSdk': {
        tx: { songList: { getListDetail: async() => detail('legacy', 'legacy') } },
      },
      '@renderer/utils/ipc': {
        getNeteasePlaylistDetail: async() => detail('netease', 'netease'),
        getQQMusicPlaylistDetail: async() => accountARequest.promise,
      },
      '@renderer/store/qqMusic': { getQQMusicAccountKey: () => accountKey },
      '@renderer/store/dailyRecommend/action': {
        getDailyRecommendPlaylistDetail: async() => detail('daily', 'netease daily'),
        loadDailyRecommendSongs: async() => [],
      },
      '@renderer/store/dailyRecommend/state': { DAILY_RECOMMEND_TEMP_LIST_ID: 'daily' },
      '@renderer/store/qqDailyRecommend/action': {
        getQQDailyRecommendPlaylistDetail: async() => detail('qq_daily_30', 'QQ daily'),
      },
      '@renderer/store/qqDailyRecommend/state': {
        QQ_DAILY_RECOMMEND_LIST_ID: 'qq_daily_30',
        qqDailyRecommendGeneration: { value: 0 },
      },
      '@common/utils/vueTools': {
        markRaw: value => value,
        markRawList: value => value,
      },
      './state': {
        tags: {},
        listInfo: {},
        listDetailInfo,
        selectListInfo: {},
        isVisibleListDetail: { value: false },
        openSongListInputInfo: {},
      },
    },
  )
  const originalWindow = global.window
  global.window = { i18n: { t: key => key } }
  try {
    const stale = action.getAndSetListDetail('211111', 'tx', 1)
    accountKey = 'account-b'
    accountARequest.resolve(detail('211111', 'account-a'))
    await stale
  } finally {
    global.window = originalWindow
  }

  assert.deepStrictEqual(listDetailInfo.list, [])
  assert.deepStrictEqual(listDetailInfo.info, {})
}

const main = async() => {
  await testAuthenticatedPlaylistDetail()
  await testValidationAndFailures()
  await testRendererPrefersAuthenticatedDetailAndFallsBack()
  await testAccountSwitchDoesNotCacheStalePlaylistDetail()
  await testAccountSwitchDoesNotRenderStalePlaylistDetail()
  console.log('QQ Music playlist detail tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
