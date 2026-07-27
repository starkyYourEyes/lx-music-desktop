import { getCookieValue, getGtk } from './auth'
import {
  createQQMusicFallbackGuid,
  createQQMusicFallbackUid,
  createQQMusicRequestSign,
} from './request'
import { normalizeQQMusicTracks, QQMusicAuthError } from './song'

const PLAYLIST_DETAIL_URL = 'https://u6.y.qq.com/cgi-bin/musics.fcg'
const PLAYLIST_DETAIL_ERROR = 'QQ Music playlist detail request failed'

const formatPlayCount = (count: unknown): string => {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(value >= 1_000_000_000 ? 0 : 1)}亿`
  if (value >= 10_000) return `${(value / 10_000).toFixed(value >= 100_000 ? 0 : 1)}万`
  return String(value)
}

export const createQQMusicPlaylistDetailService = ({
  fetchImpl = fetch,
  getCookie,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}) => {
  const getPlaylistDetail = async(id: string, page = 1): Promise<LX.QQMusic.PlaylistDetailInfo> => {
    if (!/^\d+$/.test(id) || id == '0') throw new Error(PLAYLIST_DETAIL_ERROR)
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const uin = (getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')).replace(/^o/, '')
    const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
    if (!uin || !key) throw new QQMusicAuthError('QQ Music account is not logged in')
    const guid = getCookieValue(cookie, 'qqmusic_guid') ||
      getCookieValue(cookie, 'guid') ||
      createQQMusicFallbackGuid(uin)
    const uid = getCookieValue(cookie, 'uid') || createQQMusicFallbackUid(uin)
    const gtk = getGtk(key)
    const body = JSON.stringify({
      comm: {
        format: 'json',
        ct: 20,
        cv: 2116,
        platform: 'wk_v17',
        uid,
        guid,
        inCharset: 'utf-8',
        outCharset: 'utf-8',
        notice: 0,
        needNewCode: 1,
        uin,
        g_tk_new_20200303: gtk,
        g_tk: gtk,
      },
      req_1: {
        module: 'music.srfDissInfo.aiDissInfo',
        method: 'uniform_get_Dissinfo',
        param: {
          disstid: Number(id),
          userinfo: 1,
          tag: 1,
          is_pc: 1,
          guid,
          enc_host_uin: uin,
          dirid: 0,
        },
      },
    })
    const url = new URL(PLAYLIST_DETAIL_URL)
    url.searchParams.set('sign', createQQMusicRequestSign(body))
    const controller = new AbortController()
    const timer = setTimeoutImpl(() => {
      controller.abort()
    }, 10_000)
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body,
      })
      if (!response.ok) throw new Error(PLAYLIST_DETAIL_ERROR)
      const payload = await response.json()
      if (payload?.code == 1000 || payload?.req_1?.code == 1000) throw new QQMusicAuthError()
      const data = payload?.req_1?.data
      if (payload?.code != 0 || payload?.req_1?.code != 0 || data?.code != 0) {
        throw new Error(PLAYLIST_DETAIL_ERROR)
      }
      const list = normalizeQQMusicTracks(data?.songlist)
      const info = data?.dirinfo ?? {}
      const desc = typeof info.desc == 'string' ? info.desc : ''
      return {
        list,
        source: 'tx',
        desc,
        total: list.length,
        page,
        limit: list.length,
        key: null,
        id,
        info: {
          name: typeof info.title == 'string' ? info.title : '',
          img: typeof info.picurl2 == 'string' && info.picurl2
            ? info.picurl2
            : typeof info.picurl == 'string' ? info.picurl : '',
          desc,
          author: typeof info.host_nick == 'string' ? info.host_nick : '',
          play_count: formatPlayCount(info.listennum),
        },
        noItemLabel: '',
      }
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error(PLAYLIST_DETAIL_ERROR)
    } finally {
      clearTimeoutImpl(timer)
    }
  }

  return { getPlaylistDetail }
}
