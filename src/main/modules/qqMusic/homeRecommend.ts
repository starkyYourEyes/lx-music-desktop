import { getCookieValue } from './auth'
import { normalizeQQMusicTracks, QQMusicAuthError } from './song'

const HOME_RECOMMEND_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const HOME_RECOMMEND_ERROR = 'QQ Music home recommendation request failed'

type RawCard = {
  id?: string | number
  type?: number
  title?: string
  subtitle?: string
  cover?: string
  cnt?: number
  miscellany?: {
    cnt_content?: string
    rcmd_reason?: string
  }
}

type RawNiche = {
  v_card?: RawCard[]
}

type RawShelf = {
  id?: number
  title_template?: string
  title_content?: string
  v_niche?: RawNiche[]
}

const getLoginType = (cookie: string): number => {
  const rawValue = getCookieValue(cookie, 'tmeLoginType')
  if (!rawValue) return 2
  const value = Number(rawValue)
  return Number.isInteger(value) && value > 0 ? value : 2
}

const getHomeShelves = (payload: any): RawShelf[] => {
  const shelves = payload?.home?.data?.v_shelf
  return Array.isArray(shelves) ? shelves : []
}

const getShelfCards = (shelf: RawShelf | undefined): RawCard[] => {
  if (!shelf || !Array.isArray(shelf.v_niche)) return []
  return shelf.v_niche.flatMap(niche => Array.isArray(niche.v_card) ? niche.v_card : [])
}

const getShelfTitle = (shelf: RawShelf | undefined, fallback: string): string => {
  if (!shelf) return fallback
  const template = typeof shelf.title_template == 'string' ? shelf.title_template.trim() : ''
  const content = typeof shelf.title_content == 'string' ? shelf.title_content.trim() : ''
  if (!template) return content || fallback
  const title = template.replace(/\{[^}]+\}/g, content).replace(/\s+/g, ' ').trim()
  return title || content || fallback
}

const formatPlayCount = (card: RawCard): string => {
  const text = card.miscellany?.cnt_content?.trim()
  if (text) return text
  const count = card.cnt ?? 0
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(count >= 1_000_000_000 ? 0 : 1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 100_000 ? 0 : 1)}万`
  return count > 0 ? String(count) : ''
}

const normalizePlaylist = (card: RawCard): LX.QQMusic.RecommendPlaylist | null => {
  const id = String(card.id ?? '')
  const name = card.title?.trim() ?? ''
  const img = card.cover?.trim() ?? ''
  if (card.type != 500 || !/^\d+$/.test(id) || id == '0' || !name || !img) return null
  return {
    id,
    source: 'tx',
    name,
    img,
    description: card.miscellany?.rcmd_reason?.trim() || card.subtitle?.trim() || '',
    author: card.subtitle?.trim() || 'QQ Music',
    playCount: formatPlayCount(card),
  }
}

const normalizePlaylists = (shelf: RawShelf | undefined): LX.QQMusic.RecommendPlaylist[] => {
  return getShelfCards(shelf)
    .map(normalizePlaylist)
    .filter((playlist): playlist is LX.QQMusic.RecommendPlaylist => playlist != null)
}

const getRelatedSongIds = (shelf: RawShelf | undefined): number[] => {
  if (!shelf || !Array.isArray(shelf.v_niche)) return []
  const ids = new Set<number>()
  for (const niche of shelf.v_niche) {
    if (!Array.isArray(niche.v_card)) continue
    for (const card of niche.v_card) {
      if (card.type != 200) continue
      const id = Number(card.id)
      if (Number.isSafeInteger(id) && id > 0) ids.add(id)
    }
  }
  return [...ids]
}

export const normalizeQQMusicHomeRecommendation = (
  payload: any,
  tracks: LX.Music.MusicInfo_tx[],
): LX.QQMusic.HomeRecommendation => {
  const shelves = getHomeShelves(payload)
  const featuredShelf = shelves.find(shelf => shelf.id == 301)
  const privateShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('私荐歌单'))
  const relatedShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('也会喜欢')) ??
    shelves.find(shelf => shelf.id == 207)
  const guideShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('歌单遨游指南')) ??
    shelves.find(shelf => shelf.id == 276)

  const trackById = new Map<string, LX.Music.MusicInfo_tx>()
  for (const track of tracks) {
    const id = track.meta.id
    if (id != null) trackById.set(String(id), track)
  }
  const relatedSongGroups = (relatedShelf?.v_niche ?? [])
    .map(niche => (niche.v_card ?? [])
      .filter(card => card.type == 200)
      .map(card => trackById.get(String(card.id ?? '')))
      .filter((track): track is LX.Music.MusicInfo_tx => track != null))
    .filter(group => group.length > 0)

  return {
    title: getShelfTitle(featuredShelf, 'Hi 今日为你推荐'),
    featuredPlaylists: normalizePlaylists(featuredShelf),
    privatePlaylists: normalizePlaylists(privateShelf),
    relatedSongTitle: getShelfTitle(relatedShelf, '为你推荐的歌曲'),
    relatedSongGroups,
    guidePlaylists: normalizePlaylists(guideShelf),
  }
}

export const createQQMusicHomeRecommendService = ({
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
  const post = async(cookie: string, body: Record<string, unknown>) => {
    const controller = new AbortController()
    const timer = setTimeoutImpl(() => controller.abort(), 10_000)
    try {
      const response = await fetchImpl(HOME_RECOMMEND_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`${HOME_RECOMMEND_ERROR}: ${response.status}`)
      return response.json()
    } finally {
      clearTimeoutImpl(timer)
    }
  }

  const getHomeRecommendation = async(): Promise<LX.QQMusic.HomeRecommendation> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const qq = (getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')).replace(/^o/, '')
    const authst = getCookieValue(cookie, 'qqmusic_key')
    try {
      const comm = {
        ct: 11,
        cv: 14090008,
        v: 14090008,
        qq,
        authst,
        tmeAppID: 'qqmusic',
        tmeLoginType: getLoginType(cookie),
      }
      const homePayload = await post(cookie, {
        comm,
        home: {
          module: 'music.recommend.RecommendFeed',
          method: 'get_recommend_feed',
          param: { direction: 0, page: 1, s_num: 0 },
        },
      })
      if (homePayload?.code == 1000 || homePayload?.home?.code == 1000) throw new QQMusicAuthError()
      if (homePayload?.code != 0 || homePayload?.home?.code != 0 || homePayload?.home?.data?.retcode != 0) {
        throw new Error(HOME_RECOMMEND_ERROR)
      }

      const shelves = getHomeShelves(homePayload)
      const relatedShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('也会喜欢')) ??
        shelves.find(shelf => shelf.id == 207)
      const ids = getRelatedSongIds(relatedShelf)
      let tracks: LX.Music.MusicInfo_tx[] = []
      if (ids.length) {
        const tracksPayload = await post(cookie, {
          comm,
          tracks: {
            module: 'music.trackInfo.UniformRuleCtrl',
            method: 'CgiGetTrackInfo',
            param: {
              ctx: 0,
              client: 1,
              ids,
              types: ids.map(() => 0),
              modify_stamp: ids.map(() => 0),
            },
          },
        })
        if (tracksPayload?.code == 1000 || tracksPayload?.tracks?.code == 1000) throw new QQMusicAuthError()
        if (tracksPayload?.code != 0 || tracksPayload?.tracks?.code != 0) throw new Error(HOME_RECOMMEND_ERROR)
        tracks = normalizeQQMusicTracks(tracksPayload?.tracks?.data?.tracks)
      }
      return normalizeQQMusicHomeRecommendation(homePayload, tracks)
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error(HOME_RECOMMEND_ERROR)
    }
  }

  return { getHomeRecommendation }
}
