import { getCookieValue } from './auth'
import { normalizeQQMusicTracks, QQMusicAuthError } from './song'

const getLoginType = (cookie: string): number => {
  const rawValue = getCookieValue(cookie, 'tmeLoginType')
  if (!rawValue) return 2
  const value = Number(rawValue)
  return Number.isInteger(value) && value > 0 ? value : 2
}

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
    const uin = (getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')).replace(/^o/, '')
    const authst = getCookieValue(cookie, 'qqmusic_key')
    const controller = new AbortController()
    const timer = setTimeoutImpl(() => {
      controller.abort()
    }, 10_000)
    try {
      const response = await fetchImpl('https://u6.y.qq.com/cgi-bin/musicu.fcg', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: JSON.stringify({
          comm: { ct: 20, cv: 2116, uin, authst, tmeLoginType: getLoginType(cookie) },
          daily30: {
            module: 'music.ai_track_daily_svr',
            method: 'get_daily_track',
            param: {},
          },
        }),
      })
      if (!response.ok) throw new Error(`QQ Music daily recommendation request failed: ${response.status}`)
      const payload = await response.json()
      if (payload?.code == 1000 || payload?.daily30?.code == 1000) throw new QQMusicAuthError()
      if (payload?.code != 0 || payload?.daily30?.code != 0) throw new Error('QQ Music daily recommendation request failed')
      return normalizeQQMusicTracks(payload?.daily30?.data?.tracks)
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error('QQ Music daily recommendation request failed')
    } finally {
      clearTimeoutImpl(timer)
    }
  }
  return { getDailyRecommendSongs }
}
