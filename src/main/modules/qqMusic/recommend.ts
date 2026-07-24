import { getCookieValue } from './auth'
import { QQMusicAuthError } from './song'

const HOME_RECOMMEND_REQUEST = {
  comm: { ct: 24 },
  category: {
    method: 'get_hot_category',
    param: { qq: '' },
    module: 'music.web_category_svr',
  },
  recomPlaylist: {
    method: 'get_hot_recommend',
    param: { async: 1, cmd: 2 },
    module: 'playlist.HotRecommendServer',
  },
  playlist: {
    method: 'get_playlist_by_category',
    param: { id: 8, curPage: 1, size: 40, order: 5, titleid: 8 },
    module: 'playlist.PlayListPlazaServer',
  },
  new_song: {
    module: 'newsong.NewSongServer',
    method: 'get_new_song_info',
    param: { type: 5 },
  },
  new_album: {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_info',
    param: { area: 1, sin: 0, num: 10 },
  },
  new_album_tag: {
    module: 'newalbum.NewAlbumServer',
    method: 'get_new_album_area',
    param: {},
  },
  toplist: {
    module: 'musicToplist.ToplistInfoServer',
    method: 'GetAll',
    param: {},
  },
  focus: {
    module: 'QQMusic.MusichallServer',
    method: 'GetFocus',
    param: {},
  },
}

const HOME_RECOMMEND_MODULES = [
  'category',
  'recomPlaylist',
  'playlist',
  'new_song',
  'new_album',
  'new_album_tag',
  'toplist',
  'focus',
] as const

const isAuthExpired = (payload: LX.QQMusic.HomeRecommendResponse) => {
  if (payload.code == 1000) return true
  return HOME_RECOMMEND_MODULES.some(key => {
    const moduleResponse = payload[key]
    return !!moduleResponse && typeof moduleResponse == 'object' &&
      (moduleResponse as { code?: number }).code == 1000
  })
}

export const createQQMusicRecommendService = ({
  fetchImpl = fetch,
  getCookie,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
}) => {
  const getHomeRecommend = async(): Promise<LX.QQMusic.HomeRecommendResponse> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const loginUin = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')
      const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg')
      const params = {
        g_tk: '1124214810',
        loginUin: loginUin.replace(/^o/, ''),
        hostUin: '0',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
        format: 'json',
        data: JSON.stringify(HOME_RECOMMEND_REQUEST),
      }
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          Referer: 'https://y.qq.com/portal/player.html',
          Cookie: cookie,
        },
      })
      if (!response.ok) throw new Error(`QQ Music request failed: ${response.status}`)
      const payload = await response.json() as LX.QQMusic.HomeRecommendResponse
      if (isAuthExpired(payload)) throw new QQMusicAuthError()
      if (payload.code != 0) throw new Error('QQ Music home recommendation request failed')
      return payload
    } finally {
      clearTimeout(timer)
    }
  }
  return { getHomeRecommend }
}
