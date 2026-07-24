const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./qq-music-test-loader')

const { getCookieValue } = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/auth.ts'),
)

let request
let fetchCalls = 0
const rawPayload = {
  code: 0,
  category: { code: 0, data: { marker: 'category' } },
  focus: { code: 0, data: { marker: 'focus' } },
}

class QQMusicAuthError extends Error {}

const fetchImpl = async(url, options) => {
  fetchCalls++
  request = { url, options }
  return {
    ok: true,
    json: async() => rawPayload,
  }
}

const {
  createQQMusicRecommendService,
} = loadTsModule(
  path.join(__dirname, '../src/main/modules/qqMusic/recommend.ts'),
  {
    './auth': { getCookieValue },
    './song': { QQMusicAuthError },
  },
)

const createFetchWithPayload = payload => async() => ({
  ok: true,
  json: async() => payload,
})

const main = async() => {
  const service = createQQMusicRecommendService({
    fetchImpl,
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  const result = await service.getHomeRecommend()
  const url = new URL(request.url)
  const data = JSON.parse(url.searchParams.get('data'))

  assert.strictEqual(result, rawPayload)
  assert.strictEqual(url.origin + url.pathname, 'https://u.y.qq.com/cgi-bin/musicu.fcg')
  assert.strictEqual(request.options.method, 'GET')
  assert.strictEqual(Object.hasOwn(request.options, 'body'), false)
  assert.strictEqual(url.searchParams.get('g_tk'), '1124214810')
  assert.strictEqual(url.searchParams.get('loginUin'), '123')
  assert.strictEqual(url.searchParams.get('hostUin'), '0')
  assert.strictEqual(url.searchParams.get('inCharset'), 'utf8')
  assert.strictEqual(url.searchParams.get('outCharset'), 'utf-8')
  assert.strictEqual(url.searchParams.get('notice'), '0')
  assert.strictEqual(url.searchParams.get('platform'), 'yqq.json')
  assert.strictEqual(url.searchParams.get('needNewCode'), '0')
  assert.strictEqual(url.searchParams.get('format'), 'json')
  assert.strictEqual(request.options.headers.Referer, 'https://y.qq.com/portal/player.html')
  assert.strictEqual(request.options.headers.Cookie, 'uin=o123; qqmusic_key=secret')
  assert.deepStrictEqual(data.comm, { ct: 24 })
  assert.deepStrictEqual(data.category, {
    method: 'get_hot_category',
    param: { qq: '' },
    module: 'music.web_category_svr',
  })
  assert.deepStrictEqual(data.recomPlaylist, {
    method: 'get_hot_recommend',
    param: { async: 1, cmd: 2 },
    module: 'playlist.HotRecommendServer',
  })
  assert.deepStrictEqual(data.playlist, {
    method: 'get_playlist_by_category',
    param: { id: 8, curPage: 1, size: 40, order: 5, titleid: 8 },
    module: 'playlist.PlayListPlazaServer',
  })
  assert.deepStrictEqual(data.new_song, {
    module: 'newsong.NewSongServer',
    method: 'get_new_song_info',
    param: { type: 5 },
  })
  assert.deepStrictEqual(data.new_album, {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_info',
    param: { area: 1, sin: 0, num: 10 },
  })
  assert.deepStrictEqual(data.new_album_tag, {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_area',
    param: {},
  })
  assert.deepStrictEqual(data.toplist, {
    module: 'musicToplist.ToplistInfoServer',
    method: 'GetAll',
    param: {},
  })
  assert.deepStrictEqual(data.focus, {
    module: 'QQMusic.MusichallServer',
    method: 'GetFocus',
    param: {},
  })

  const noCookie = createQQMusicRecommendService({ fetchImpl, getCookie: () => '' })
  await assert.rejects(noCookie.getHomeRecommend(), QQMusicAuthError)
  assert.strictEqual(fetchCalls, 1)

  const httpFailure = createQQMusicRecommendService({
    fetchImpl: async() => ({ ok: false, status: 503 }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(httpFailure.getHomeRecommend(), /QQ Music request failed: 503/)

  const expired = createQQMusicRecommendService({
    fetchImpl: createFetchWithPayload({ code: 1000 }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(expired.getHomeRecommend(), QQMusicAuthError)

  const expiredModule = createQQMusicRecommendService({
    fetchImpl: createFetchWithPayload({ code: 0, focus: { code: 1000 } }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(expiredModule.getHomeRecommend(), QQMusicAuthError)

  const failed = createQQMusicRecommendService({
    fetchImpl: createFetchWithPayload({ code: 1 }),
    getCookie: () => 'uin=o123; qqmusic_key=secret',
  })
  await assert.rejects(failed.getHomeRecommend(), /home recommendation request failed/)
}

main().then(() => {
  console.log('QQ Music home recommendation tests passed')
}).catch(error => {
  console.error(error)
  process.exitCode = 1
})
