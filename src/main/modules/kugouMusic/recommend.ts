import { KUGOU_AUTH_REQUIRED } from '../../../common/kugouMusic'
import { formatPlayTime, sizeFormate } from '../../../common/utils/common'
import { createKugouApiClient, type KugouApi } from './api'

export class KugouAuthError extends Error {
  name = 'KugouAuthError'
  constructor() { super(KUGOU_AUTH_REQUIRED) }
}

const asRecord = (value: unknown): Record<string, any> => value != null && typeof value == 'object' ? value as Record<string, any> : {}
const responseBody = (response: any): Record<string, any> => asRecord(response?.body)
const responseData = (response: any): any => {
  const body = responseBody(response)
  return body.data ?? response?.data ?? body
}
const responseMessage = (response: any): string => {
  const body = responseBody(response)
  return String(body.msg ?? body.message ?? response?.message ?? '')
}
const authCodes = new Set([401, 403, 1001, 2001])
const isAuthMessage = (message: string): boolean => {
  return /\b(?:login|authentication)\s+(?:required|expired|invalid)\b|\b(?:not|please)\s+log(?:ged)?\s+in\b|\btoken\s+(?:expired|invalid)\b|未登录|登录(?:失效|过期|异常)|认证(?:失败|失效|过期)/i.test(message)
}
const isAuthResponse = (response: any): boolean => {
  const body = responseBody(response)
  const codes = [response?.status, body.error_code, body.errcode, body.code, response?.code]
  return codes.some(code => authCodes.has(Number(code))) || isAuthMessage(responseMessage(response))
}
const assertResponse = (response: any) => {
  if (isAuthResponse(response)) throw new KugouAuthError()
  const body = responseBody(response)
  const codes = [body.error_code, body.errcode, body.code, response?.code]
  for (const value of codes) {
    if (value == null || value === '') continue
    const code = Number(value)
    if (Number.isFinite(code) && code != 0 && code != 200) throw new Error('KuGou recommendation request failed')
  }
  if (body.status != null) {
    const status = Number(body.status)
    if (Number.isFinite(status) && status != 1 && status != 200) throw new Error('KuGou recommendation request failed')
  }
  if (response?.status != null && Number(response.status) >= 400) throw new Error('KuGou recommendation request failed')
}
const normalizeFailure = (error: unknown): Error => {
  if (error instanceof KugouAuthError) return error
  const envelope = (error as any)?.response ?? error
  try { assertResponse(envelope) } catch (classified) {
    if (classified instanceof KugouAuthError) return classified
  }
  return new Error('KuGou recommendation request failed')
}
const arrayAt = (value: any, keys: string[]): any[] => {
  for (const key of keys) if (Array.isArray(value?.[key])) return value[key]
  return Array.isArray(value) ? value : []
}
const first = (...values: any[]): any => values.find(value => value != null && value !== '')
const text = (value: any): string => String(value ?? '').trim()
const artwork = (value: any): string => text(value).replace(/\{size\}/g, '240')
const hasSize = (value: any): boolean => {
  if (typeof value == 'number') return value > 0
  const normalized = text(value)
  return normalized != '' && normalized != '0'
}
const formatSize = (value: any): string | null => {
  if (typeof value == 'number') return sizeFormate(value)
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? sizeFormate(number) : (text(value) || null)
}

export const normalizeKugouSong = (song: any): LX.Music.MusicInfo_kg => {
  const audio = asRecord(song?.audio_info)
  const album = asRecord(song?.album_info)
  const hash128 = text(first(audio.hash_128, song?.hash_128, song?.hash, song?.Hash, song?.filehash, song?.audio_hash))
  const hash320 = text(first(audio.hash_320, song?.hash_320, song?.hash320, song?.['320hash']))
  const hashFlac = text(first(audio.hash_flac, song?.hash_flac, song?.flac_hash))
  const hashHigh = text(first(audio.hash_high, song?.hash_high, song?.high_hash))
  const hash = text(first(hash128, hash320, hashFlac, hashHigh))
  const id = text(first(song?.audio_id, song?.songid, song?.song_id, song?.mixsongid, hash)) || hash

  let name = text(first(song?.songname, song?.song_name, song?.name, song?.filename))
  let singer = text(first(song?.author_name, song?.singername, song?.singer, song?.artist, song?.authors))
  if (!singer) {
    const filename = /^(.*?)\s+-\s+(.+)$/.exec(name)
    if (filename) {
      singer = filename[1].trim()
      name = filename[2].trim()
    }
  }

  let duration = 0
  if (audio.duration_128 != null) duration = Number(audio.duration_128) / 1000
  else if (song?.time != null) duration = Number(song.time) / 1000
  else if (song?.time_length != null) duration = Number(song.time_length)
  else if (song?.timelength != null) duration = Number(song.timelength) / 1000
  else {
    duration = Number(first(song?.duration, song?.interval))
    if (duration > 1000) duration /= 1000
  }
  if (!Number.isFinite(duration) || duration < 0) duration = 0

  const qualitys: LX.Music.MusicQualityTypeKg[] = []
  const _qualitys: LX.Music._MusicQualityTypeKg = {}
  const addQuality = (type: LX.Quality, size: any, qualityHash: string) => {
    if (!hasSize(size)) return
    const normalized = { type, size: formatSize(size), hash: qualityHash || hash }
    qualitys.push(normalized)
    _qualitys[type] = { size: normalized.size, hash: normalized.hash }
  }

  const size128 = first(audio.filesize_128, song?.filesize_128, song?.filesize, song?.size)
  const size320 = first(audio.filesize_320, song?.filesize_320, song?.['320size'])
  const sizeFlac = first(audio.filesize_flac, song?.filesize_flac, song?.flac_filesize)
  const sizeHigh = first(audio.filesize_high, song?.filesize_high, song?.high_filesize)
  addQuality('128k', size128, hash128)
  addQuality('320k', size320, hash320)
  addQuality('flac', sizeFlac, hashFlac)
  addQuality('flac24bit', sizeHigh, hashHigh)
  if (!qualitys.length) {
    const normalized = { type: '128k' as const, size: null, hash }
    qualitys.push(normalized)
    _qualitys['128k'] = { size: null, hash }
  }

  return {
    id: `kg_${id}`,
    name,
    singer,
    source: 'kg',
    interval: duration > 0 ? formatPlayTime(duration) : null,
    meta: {
      songId: id,
      albumName: text(first(album.album_name, song?.album_name, song?.albumname, song?.album, '')),
      picUrl: artwork(first(album.sizable_cover, song?.sizable_cover, song?.album_sizable_cover, song?.album_img, song?.imgurl, song?.pic, '')),
      hash,
      qualitys,
      _qualitys,
    },
  }
}

const normalizeSongs = (items: any[]): LX.Music.MusicInfo_kg[] => {
  const seen = new Set<string>()
  const songs: LX.Music.MusicInfo_kg[] = []
  for (const item of items) {
    const song = normalizeKugouSong(item)
    const key = song.meta.hash || song.id
    if (seen.has(key)) continue
    seen.add(key)
    songs.push(song)
  }
  return songs
}

const normalizePlaylist = (item: any): LX.KuGouMusic.RecommendPlaylist => ({
  id: text(first(item?.specialid, item?.global_collection_id, item?.listid, item?.id)),
  source: 'kg',
  name: text(first(item?.name, item?.specialname, item?.title)),
  img: artwork(first(item?.imgurl, item?.cover, item?.pic, '')),
  description: text(first(item?.intro, item?.description, item?.desc, '')),
  author: text(first(item?.username, item?.nickname, item?.author, '')),
  playCount: text(first(item?.play_count, item?.playcount, item?.count, '')),
})
const normalizeRank = (item: any, songs: LX.Music.MusicInfo_kg[] = []): LX.KuGouMusic.Rank => ({
  id: text(first(item?.rankid, item?.rank_id, item?.id)),
  source: 'kg',
  name: text(first(item?.rankname, item?.name, item?.title)),
  img: artwork(first(item?.imgurl, item?.img, item?.cover, '')),
  description: text(first(item?.intro, item?.description, item?.desc, '')),
  songs,
})

const playlistItems = (response: any): any[] => arrayAt(responseData(response), ['special_list', 'list', 'specials', 'playlist', 'playlists'])
const rankItems = (response: any): any[] => arrayAt(responseData(response), ['info', 'list', 'ranks', 'ranklist'])
const songItems = (response: any): any[] => arrayAt(responseData(response), ['songlist', 'song_list', 'songs', 'data', 'list'])

export const createKugouRecommendationService = ({
  api = createKugouApiClient(),
  getCookie,
  onAuthFailure,
}: {
  api?: KugouApi
  getCookie: () => string
  onAuthFailure?: () => Promise<void>
}) => {
  const invalidateAuthentication = async(error: KugouAuthError): Promise<never> => {
    if (onAuthFailure) await onAuthFailure().catch(() => {})
    throw error
  }
  const privateCall = async<T>(fn: (params: Record<string, any>) => Promise<any>, params: Record<string, any> = {}): Promise<T> => {
    const cookie = getCookie()
    if (!cookie) return invalidateAuthentication(new KugouAuthError())
    try {
      const response = await fn({ ...params, cookie })
      assertResponse(response)
      return response as T
    } catch (error) {
      const failure = normalizeFailure(error)
      if (failure instanceof KugouAuthError) return invalidateAuthentication(failure)
      throw failure
    }
  }
  const publicCall = async<T>(fn: (params: Record<string, any>) => Promise<any>, params: Record<string, any> = {}): Promise<T> => {
    try {
      const response = await fn(params)
      assertResponse(response)
      return response as T
    } catch (error) {
      throw normalizeFailure(error)
    }
  }
  const getPublicRecommendation = async(): Promise<LX.KuGouMusic.PublicRecommendation> => {
    const [playlistsResult, ranksResult] = await Promise.allSettled([publicCall(api.topPlaylist), publicCall(api.rankList)])
    if (playlistsResult.status == 'rejected' && ranksResult.status == 'rejected') throw playlistsResult.reason
    return {
      playlists: playlistsResult.status == 'fulfilled' ? playlistItems(playlistsResult.value).map(normalizePlaylist) : [],
      ranks: ranksResult.status == 'fulfilled' ? rankItems(ranksResult.value).map(item => normalizeRank(item)) : [],
    }
  }
  const getDailyRecommendSongs = async() => normalizeSongs(songItems(await privateCall(api.recommendSongs)))
  const getStyleRecommendation = async() => normalizeSongs(songItems(await privateCall(api.everydayStyleRecommend)))
  const getPrivateFmSongs = async() => {
    const recommend = await privateCall(api.fmRecommend)
    const ids = songItems(recommend).map(item => text(first(item?.fmid, item?.fm_id, item?.id))).filter(Boolean)
    if (!ids.length) return []
    const response = await privateCall(api.fmSongs, { fmid: ids.join(',') })
    const groups = songItems(response)
    const items = groups.flatMap(group => Array.isArray(group?.songs) ? group.songs : [group])
    return normalizeSongs(items)
  }
  const getRankRecommendation = async(): Promise<LX.KuGouMusic.RankRecommendation> => {
    const response = await publicCall(api.rankList)
    const item = rankItems(response)[0]
    if (!item) return { rank: null, songs: [] }
    const songsResponse = await publicCall(api.rankAudio, { rankid: first(item.rankid, item.rank_id, item.id) })
    const songs = normalizeSongs(songItems(songsResponse))
    return { rank: normalizeRank(item, songs), songs }
  }
  return { getPublicRecommendation, getDailyRecommendSongs, getStyleRecommendation, getPrivateFmSongs, getRankRecommendation }
}
