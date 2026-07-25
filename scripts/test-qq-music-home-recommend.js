const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const { getCookieValue, getGtk } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)

class QQMusicAuthError extends Error {
  constructor(message = 'QQ Music login expired') {
    super(message)
    this.name = 'QQMusicAuthError'
  }
}

const track = (id, mid, name) => ({
  id,
  mid,
  name,
  singer: [{ name: `${name} Singer` }],
  album: { mid: `${mid}-album`, name: `${name} Album` },
  file: { media_mid: mid },
})

const normalizeQQMusicTracks = tracks => tracks.map(item => ({
  id: `tx_${item.mid}`,
  name: item.name,
  singer: item.singer[0].name,
  source: 'tx',
  interval: null,
  meta: {
    id: item.id,
    songId: item.mid,
    picUrl: `https://img.test/${item.mid}.jpg`,
  },
}))

const playlistCard = (id, title, extra = {}) => ({
  id: String(id),
  type: 500,
  title,
  subtitle: extra.subtitle ?? '',
  cover: extra.cover ?? `https://img.test/playlist-${id}.jpg`,
  scheme: extra.scheme ?? '',
  cnt: extra.cnt ?? 120000,
  miscellany: {
    cnt_content: extra.playCountText ?? '',
    rcmd_reason: extra.reason ?? '',
  },
})

const songCard = (id, title) => ({
  id: String(id),
  type: 200,
  title,
  subtitle: `${title} Singer`,
  cover: `https://img.test/song-${id}.jpg`,
})

const shelf = (id, titleTemplate, titleContent, cards, niches) => ({
  id,
  title_template: titleTemplate,
  title_content: titleContent,
  v_niche: niches ?? [{ id, v_card: cards }],
})

const createFeedPayload = ({ exactGuide = true } = {}) => ({
  code: 0,
  home: {
    code: 0,
    data: {
      retcode: 0,
      v_shelf: [
        shelf(301, 'Hi {String} 今日为你推荐', 'Alice', [
          { id: '99', type: 700, title: '猜你喜欢-沉浸刷歌', cover: '' },
          {
            id: '0',
            type: 500,
            title: '每日30首',
            cover: 'daily.jpg',
            scheme: 'qqmusic://qq.com/ui/gedan?p={"id":"202","type":"3"}',
          },
          playlistCard(211111, '百万收藏'),
          playlistCard('bad-id', '无效歌单'),
        ]),
        shelf(207, '听「{String}」也会喜欢', 'Candy', null, [
          { id: 207, v_card: [songCard(101, 'One'), songCard(102, 'Two'), songCard('bad', 'Bad')] },
          { id: 207, v_card: [songCard(103, 'Three')] },
        ]),
        shelf(271, '你的私荐歌单', '', [
          playlistCard(7001, 'Private One', { playCountText: '12.3万 播放', reason: '因为你喜欢流行' }),
          playlistCard(7002, 'Private Two'),
          playlistCard('opaque-card', 'Private Scheme', {
            scheme: 'qqmusic://qq.com/ui/gedan?p={"id":"7004","type":"3"}',
          }),
          playlistCard(7003, '', { cover: '' }),
        ]),
        shelf(276, '为你精选的AI歌单', '', [playlistCard(8001, 'AI Guide')]),
        ...(exactGuide
          ? [shelf(399, '歌单遨游指南', '', [playlistCard(9001, 'Exact Guide')])]
          : []),
      ],
    },
  },
})

const createGuideFeedPayload = () => ({
  code: 0,
  req_1: {
    code: 0,
    data: {
      retcode: 0,
      load_mark: -1,
      v_shelf: [
        shelf(205, '歌单遨游指南', '', [playlistCard(9001, 'Exact Guide')]),
      ],
    },
  },
})

const createTrackPayload = () => ({
  code: 0,
  req_1: {
    code: 0,
    data: {
      tracks: [
        track(103, 'mid-103', 'Three'),
        track(101, 'mid-101', 'One'),
        track(102, 'mid-102', 'Two'),
      ],
    },
  },
})

const signedBodies = []

const loadService = () => loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/homeRecommend.ts'),
  {
    './auth': { getCookieValue, getGtk },
    './request': {
      createQQMusicRequestSign: body => {
        signedBodies.push(body)
        return 'test-sign'
      },
      createQQMusicFallbackGuid: uin => `fallback-guid-${uin}`,
      createQQMusicFallbackUid: uin => `fallback-uid-${uin}`,
    },
    './song': { normalizeQQMusicTracks, QQMusicAuthError },
  },
)

const testAuthenticatedRequestAndNormalization = async() => {
  signedBodies.length = 0
  const requests = []
  const pageOne = createFeedPayload({ exactGuide: false })
  const responses = [
    { code: 0, req_1: pageOne.home },
    createGuideFeedPayload(),
    createTrackPayload(),
  ]
  let clearCalls = 0
  const { createQQMusicHomeRecommendService } = loadService()
  const service = createQQMusicHomeRecommendService({
    getCookie: () => 'uin=o12345; qqmusic_key=secret-key; qqmusic_guid=guid-123; uid=uid-123',
    fetchImpl: async(url, options) => {
      requests.push({ url, options, rawBody: options.body, body: JSON.parse(options.body) })
      return { ok: true, json: async() => responses.shift() }
    },
    setTimeoutImpl: () => 41,
    clearTimeoutImpl: id => {
      assert.strictEqual(id, 41)
      clearCalls++
    },
  })

  const result = await service.getHomeRecommendation()

  assert.strictEqual(requests.length, 3)
  for (const request of requests) {
    const url = new URL(request.url)
    assert.strictEqual(url.origin + url.pathname, 'https://u6.y.qq.com/cgi-bin/musics.fcg')
    assert.strictEqual(url.searchParams.get('sign'), 'test-sign')
  }
  assert.deepStrictEqual(signedBodies, requests.map(request => request.rawBody))
  assert.strictEqual(requests[0].options.method, 'POST')
  assert.strictEqual(requests[0].options.headers.Cookie, 'uin=o12345; qqmusic_key=secret-key; qqmusic_guid=guid-123; uid=uid-123')
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
    g_tk_new_20200303: getGtk('secret-key'),
    g_tk: getGtk('secret-key'),
  })
  assert.deepStrictEqual(requests[0].body.req_1, {
    module: 'music.recommend.RecommendFeed',
    method: 'get_recommend_feed',
    param: { direction: 0, page: 1, v_cache: [], v_uniq: [], s_num: 0 },
  })
  assert.deepStrictEqual(requests[1].body.req_1, {
    module: 'music.recommend.RecommendFeed',
    method: 'get_recommend_feed',
    param: { direction: 1, page: 2, v_cache: [], v_uniq: [], s_num: 4 },
  })
  assert.deepStrictEqual(requests[2].body.req_1, {
    module: 'music.trackInfo.UniformRuleCtrl',
    method: 'CgiGetTrackInfo',
    param: {
      ids: [101, 102, 103],
      types: [0, 0, 0],
      source: 'AiNoFree',
    },
  })
  assert.strictEqual(clearCalls, 3)

  assert.strictEqual(result.title, 'Hi Alice 今日为你推荐')
  assert.deepStrictEqual(result.brushMode, {
    id: '99',
    title: '刷歌模式',
    description: '猜你喜欢-沉浸刷歌',
  })
  assert.deepStrictEqual(result.featuredPlaylists.map(item => item.id), ['211111'])
  assert(!result.featuredPlaylists.some(item => item.id == '0' || item.name == '每日30首'))
  assert.deepStrictEqual(result.privatePlaylists.map(item => item.id), ['7001', '7002', '7004'])
  assert.strictEqual(result.privatePlaylists[0].playCount, '12.3万 播放')
  assert.strictEqual(result.privatePlaylists[0].description, '因为你喜欢流行')
  assert.strictEqual(result.relatedSongTitle, '听「Candy」也会喜欢')
  assert.deepStrictEqual(
    result.relatedSongGroups.map(group => group.map(item => item.meta.id)),
    [[101, 102], [103]],
  )
  assert.deepStrictEqual(result.guidePlaylists.map(item => item.id), ['9001'])
}

const testGuideFallsBackToAiShelf = () => {
  const { normalizeQQMusicHomeRecommendation } = loadService()
  const result = normalizeQQMusicHomeRecommendation(
    createFeedPayload({ exactGuide: false }),
    normalizeQQMusicTracks(createTrackPayload().req_1.data.tracks),
  )
  assert.deepStrictEqual(result.guidePlaylists.map(item => item.id), ['8001'])
}

const testPrivateShelfUsesStableIdAcrossTitleExperiments = () => {
  const { normalizeQQMusicHomeRecommendation } = loadService()
  const payload = createFeedPayload()
  const privateShelf = payload.home.data.v_shelf.find(item => item.id == 271)
  privateShelf.title_template = '你的歌单补给站'
  const result = normalizeQQMusicHomeRecommendation(payload, [])
  assert.deepStrictEqual(result.privatePlaylists.map(item => item.id), ['7001', '7002', '7004'])
}

const testGuideShelfUsesStableIdAcrossTitleExperiments = () => {
  const { normalizeQQMusicHomeRecommendation } = loadService()
  const payload = createGuideFeedPayload()
  payload.req_1.data.v_shelf[0].title_template = '继续探索歌单'
  const result = normalizeQQMusicHomeRecommendation(payload, [])
  assert.deepStrictEqual(result.guidePlaylists.map(item => item.id), ['9001'])
}

const testBrowserCookieUsesFallbackIdentity = async() => {
  const requests = []
  const responses = [
    { code: 0, req_1: { code: 0, data: { retcode: 0, v_shelf: [] } } },
    { code: 0, req_1: { code: 0, data: { retcode: 0, v_shelf: [] } } },
  ]
  const { createQQMusicHomeRecommendService } = loadService()
  const service = createQQMusicHomeRecommendService({
    getCookie: () => 'uin=o12345; qqmusic_key=secret-key',
    fetchImpl: async(_url, options) => {
      requests.push(JSON.parse(options.body))
      return { ok: true, json: async() => responses.shift() }
    },
  })

  await service.getHomeRecommendation()

  assert.strictEqual(requests.length, 2)
  assert.strictEqual(requests[0].comm.uid, 'fallback-uid-12345')
  assert.strictEqual(requests[0].comm.guid, 'fallback-guid-12345')
}

const testMissingCookieAndAuthExpiry = async() => {
  const { createQQMusicHomeRecommendService } = loadService()
  let fetchCalls = 0
  const signedOut = createQQMusicHomeRecommendService({
    getCookie: () => '',
    fetchImpl: async() => {
      fetchCalls++
      return { ok: true, json: async() => ({}) }
    },
  })
  await assert.rejects(signedOut.getHomeRecommendation(), QQMusicAuthError)
  assert.strictEqual(fetchCalls, 0)

  const expired = createQQMusicHomeRecommendService({
    getCookie: () => 'uin=o12345; qqmusic_key=expired',
    fetchImpl: async() => ({
      ok: true,
      json: async() => ({ code: 0, req_1: { code: 1000 } }),
    }),
  })
  await assert.rejects(expired.getHomeRecommendation(), QQMusicAuthError)
}

const testFailuresAreSanitizedAndTimersCleared = async() => {
  const { createQQMusicHomeRecommendService } = loadService()
  let clearCalls = 0
  const service = createQQMusicHomeRecommendService({
    getCookie: () => 'uin=o12345; qqmusic_key=secret',
    fetchImpl: async() => ({ ok: false, status: 503 }),
    setTimeoutImpl: () => 52,
    clearTimeoutImpl: id => {
      assert.strictEqual(id, 52)
      clearCalls++
    },
  })
  await assert.rejects(service.getHomeRecommendation(), /QQ Music home recommendation request failed/)
  assert.strictEqual(clearCalls, 1)
}

const main = async() => {
  await testAuthenticatedRequestAndNormalization()
  testGuideFallsBackToAiShelf()
  testPrivateShelfUsesStableIdAcrossTitleExperiments()
  testGuideShelfUsesStableIdAcrossTitleExperiments()
  await testBrowserCookieUsesFallbackIdentity()
  await testMissingCookieAndAuthExpiry()
  await testFailuresAreSanitizedAndTimersCleared()
  console.log('QQ Music home recommendation tests passed')
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
