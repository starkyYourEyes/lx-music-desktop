import { getCookieValue, getGtk } from './auth'
import { normalizeQQMusicTracks, QQMusicAuthError } from './song'
import {
  createQQMusicFallbackGuid,
  createQQMusicFallbackUid,
  createQQMusicRequestSign,
} from './request'

const DAILY_RECOMMEND_URL = 'https://u6.y.qq.com/cgi-bin/musics.fcg'

export const createQQMusicDailyRecommendService = ({
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
  const getDailyRecommendSongs = async(): Promise<LX.Music.MusicInfo_tx[]> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const uin = (getCookieValue(cookie, 'qqmusic_uin') || getCookieValue(cookie, 'uin')).replace(/^o/, '')
    const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
    if (!uin || !key) throw new QQMusicAuthError('QQ Music account is not logged in')
    const guid = getCookieValue(cookie, 'qqmusic_guid') || createQQMusicFallbackGuid(uin)
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
          disstid: 0,
          userinfo: 1,
          tag: 1,
          is_pc: 1,
          guid,
          enc_host_uin: uin,
          dirid: 202,
        },
      },
    })
    const url = new URL(DAILY_RECOMMEND_URL)
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
      if (!response.ok) throw new Error(`QQ Music daily recommendation request failed: ${response.status}`)
      const payload = await response.json()
      if (payload?.code == 1000 || payload?.req_1?.code == 1000) throw new QQMusicAuthError()
      if (payload?.code != 0 || payload?.req_1?.code != 0) throw new Error('QQ Music daily recommendation request failed')
      return normalizeQQMusicTracks(payload?.req_1?.data?.songlist)
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error('QQ Music daily recommendation request failed')
    } finally {
      clearTimeoutImpl(timer)
    }
  }
  return { getDailyRecommendSongs }
}
