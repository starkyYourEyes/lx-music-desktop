import { getCookieValue, getGtk } from './auth'
import {
  createQQMusicFallbackGuid,
  createQQMusicFallbackUid,
  createQQMusicRequestSign,
} from './request'
import { normalizeQQMusicTracks, QQMusicAuthError } from './song'

const HOME_RECOMMEND_URL = 'https://u6.y.qq.com/cgi-bin/musics.fcg'
const HOME_RECOMMEND_ERROR = 'QQ Music home recommendation request failed'

interface RawCard {
  id?: string | number
  type?: number
  title?: string
  subtitle?: string
  cover?: string
  scheme?: string
  cnt?: number
  miscellany?: {
    cnt_content?: string
    rcmd_reason?: string
  }
}

interface RawNiche {
  v_card?: RawCard[]
}

interface RawShelf {
  id?: number
  title_template?: string
  title_content?: string
  v_niche?: RawNiche[]
}

const getHomeShelves = (payload: any): RawShelf[] => {
  const shelves = payload?.home?.data?.v_shelf ?? payload?.req_1?.data?.v_shelf
  return Array.isArray(shelves) ? shelves : []
}

const assertModuleResponse = (payload: any, checkRetcode = false) => {
  if (payload?.code == 1000 || payload?.req_1?.code == 1000) throw new QQMusicAuthError()
  if (payload?.code != 0 || payload?.req_1?.code != 0 ||
    (checkRetcode && payload?.req_1?.data?.retcode != 0)) {
    throw new Error(HOME_RECOMMEND_ERROR)
  }
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

const getNumericId = (value: unknown): string => {
  const id = String(value ?? '')
  return /^\d+$/.test(id) && id != '0' ? id : ''
}

const getPlaylistId = (card: RawCard): string => {
  const id = getNumericId(card.id)
  if (id) return id
  try {
    const params = new URL(card.scheme ?? '').searchParams.get('p')
    if (!params) return ''
    return getNumericId(JSON.parse(params)?.id)
  } catch {
    return ''
  }
}

const normalizePlaylist = (card: RawCard): LX.QQMusic.RecommendPlaylist | null => {
  const id = getPlaylistId(card)
  const name = card.title?.trim() ?? ''
  const img = card.cover?.trim() ?? ''
  if (card.type != 500 || !id || !name || !img) return null
  return {
    id,
    source: 'tx',
    name,
    img,
    description: [card.miscellany?.rcmd_reason?.trim(), card.subtitle?.trim()].find(Boolean) ?? '',
    author: [card.subtitle?.trim(), 'QQ Music'].find(Boolean) ?? 'QQ Music',
    playCount: formatPlayCount(card),
  }
}

const normalizePlaylists = (shelf: RawShelf | undefined): LX.QQMusic.RecommendPlaylist[] => {
  return getShelfCards(shelf)
    .map(normalizePlaylist)
    .filter((playlist): playlist is LX.QQMusic.RecommendPlaylist => playlist != null)
}

const normalizeFeaturedPlaylists = (shelf: RawShelf | undefined): LX.QQMusic.RecommendPlaylist[] => {
  return getShelfCards(shelf)
    .filter(card => String(card.id ?? '') != '0' && card.title?.replace(/\s/g, '') != '每日30首')
    .map(normalizePlaylist)
    .filter((playlist): playlist is LX.QQMusic.RecommendPlaylist => playlist != null)
}

const normalizeBrushMode = (shelf: RawShelf | undefined): LX.QQMusic.BrushMode | null => {
  const card = getShelfCards(shelf).find(card => card.type == 700 && String(card.id ?? '') == '99')
  if (!card) return null
  return {
    id: '99',
    title: '刷歌模式',
    description: card.title?.trim() ?? '猜你喜欢-沉浸刷歌',
  }
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
  const privateShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('私荐歌单')) ??
    shelves.find(shelf => shelf.id == 271)
  const relatedShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('也会喜欢')) ??
    shelves.find(shelf => shelf.id == 207)
  const guideShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('歌单遨游指南')) ??
    shelves.find(shelf => shelf.id == 205) ??
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
    brushMode: normalizeBrushMode(featuredShelf),
    featuredPlaylists: normalizeFeaturedPlaylists(featuredShelf),
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
    const requestBody = JSON.stringify(body)
    const url = new URL(HOME_RECOMMEND_URL)
    url.searchParams.set('sign', createQQMusicRequestSign(requestBody))
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
        body: requestBody,
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
    const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
    if (!qq || !key) throw new QQMusicAuthError('QQ Music account is not logged in')
    const uid = getCookieValue(cookie, 'uid') || createQQMusicFallbackUid(qq)
    const guid = getCookieValue(cookie, 'qqmusic_guid') ||
      getCookieValue(cookie, 'guid') ||
      createQQMusicFallbackGuid(qq)
    const gtk = getGtk(key)
    try {
      const comm = {
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
        uin: qq,
        g_tk_new_20200303: gtk,
        g_tk: gtk,
      }
      const firstPagePayload = await post(cookie, {
        comm,
        req_1: {
          module: 'music.recommend.RecommendFeed',
          method: 'get_recommend_feed',
          param: { direction: 0, page: 1, v_cache: [], v_uniq: [], s_num: 0 },
        },
      })
      assertModuleResponse(firstPagePayload, true)
      const firstPageShelves = getHomeShelves(firstPagePayload)

      const secondPagePayload = await post(cookie, {
        comm,
        req_1: {
          module: 'music.recommend.RecommendFeed',
          method: 'get_recommend_feed',
          param: {
            direction: 1,
            page: 2,
            v_cache: [],
            v_uniq: [],
            s_num: firstPageShelves.length,
          },
        },
      })
      assertModuleResponse(secondPagePayload, true)
      const homePayload = {
        home: {
          data: {
            v_shelf: [...firstPageShelves, ...getHomeShelves(secondPagePayload)],
          },
        },
      }

      const shelves = getHomeShelves(homePayload)
      const relatedShelf = shelves.find(shelf => getShelfTitle(shelf, '').includes('也会喜欢')) ??
        shelves.find(shelf => shelf.id == 207)
      const ids = getRelatedSongIds(relatedShelf)
      let tracks: LX.Music.MusicInfo_tx[] = []
      if (ids.length) {
        const tracksPayload = await post(cookie, {
          comm,
          req_1: {
            module: 'music.trackInfo.UniformRuleCtrl',
            method: 'CgiGetTrackInfo',
            param: {
              ids,
              types: ids.map(() => 0),
              source: 'AiNoFree',
            },
          },
        })
        assertModuleResponse(tracksPayload)
        tracks = normalizeQQMusicTracks(tracksPayload?.req_1?.data?.tracks)
      }
      return normalizeQQMusicHomeRecommendation(homePayload, tracks)
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error(HOME_RECOMMEND_ERROR)
    }
  }

  return { getHomeRecommendation }
}
