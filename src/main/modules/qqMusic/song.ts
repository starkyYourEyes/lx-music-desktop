import { formatPlayTime, sizeFormate } from '@common/utils/common'
import { getCookieValue } from './auth'

export class QQMusicAuthError extends Error {
  constructor(message = 'QQ Music login expired') {
    super(message)
    this.name = 'QQMusicAuthError'
  }
}

export const isQQMusicAuthError = (error: unknown) => {
  return error instanceof QQMusicAuthError || (error as Error | null)?.name == 'QQMusicAuthError'
}

const getTracks = (payload: any): any[] | null => {
  const tracks = payload?.songlist?.data?.tracks ?? payload?.songlist?.data?.track_list
  return Array.isArray(tracks) ? tracks : null
}

const getSinger = (singers: any) => {
  if (!Array.isArray(singers)) return ''
  return singers.map(singer => singer?.name).filter(Boolean).join('、')
}

const getArtwork = (song: any) => {
  const albumMid = song?.album?.mid ?? ''
  if (albumMid) return `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg`
  const singerMid = song?.singer?.[0]?.mid ?? ''
  return singerMid ? `https://y.gtimg.cn/music/photo_new/T001R500x500M000${singerMid}.jpg` : ''
}

const createQualityInfo = (file: any) => {
  const qualitys: LX.Music.MusicQualityType[] = []
  const _qualitys: LX.Music._MusicQualityType = {}
  const add = (type: LX.Quality, size: number) => {
    if (!(size > 0)) return
    const value = sizeFormate(size)
    qualitys.push({ type, size: value })
    _qualitys[type] = { size: value }
  }
  add('flac24bit', file?.size_hires)
  add('flac', file?.size_flac)
  add('320k', file?.size_320mp3)
  add('128k', file?.size_128mp3)
  return { qualitys, _qualitys }
}

export const normalizeGuessLikeSongs = (payload: any): LX.Music.MusicInfo_tx[] => {
  const tracks = getTracks(payload)
  if (!tracks) throw new Error('Invalid QQ Music guess-like response')
  const ids = new Set<string>()
  const songs: LX.Music.MusicInfo_tx[] = []
  for (const song of tracks) {
    const mid = String(song?.mid ?? '')
    const name = song?.name ?? song?.title ?? ''
    if (!mid || !name || ids.has(mid)) continue
    ids.add(mid)
    const albumMid = song?.album?.mid ?? ''
    const { qualitys, _qualitys } = createQualityInfo(song?.file)
    songs.push({
      id: `tx_${mid}`,
      name,
      singer: getSinger(song?.singer),
      source: 'tx',
      interval: typeof song?.interval == 'number' ? formatPlayTime(song.interval) : null,
      meta: {
        songId: mid,
        albumName: song?.album?.name ?? '',
        albumId: albumMid,
        picUrl: getArtwork(song),
        qualitys,
        _qualitys,
        strMediaMid: song?.file?.media_mid ?? mid,
        id: song?.id,
        albumMid,
      },
    })
  }
  return songs
}

export const createQQMusicSongService = ({
  fetchImpl = fetch,
  getCookie,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
}) => {
  const getGuessLikeSongs = async(): Promise<LX.Music.MusicInfo_tx[]> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, 10_000)
    try {
      const loginUin = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')
      const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg')
      url.searchParams.set('format', 'json')
      url.searchParams.set('platform', 'yqq.json')
      url.searchParams.set('loginUin', loginUin.replace(/^o/, ''))
      const response = await fetchImpl(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body: JSON.stringify({
          comm: { ct: 24, cv: 0 },
          songlist: {
            module: 'mb_track_radio_svr',
            method: 'get_radio_track',
            param: { id: 99, firstplay: 1, num: 15 },
          },
        }),
      })
      if (!response.ok) throw new Error(`QQ Music request failed: ${response.status}`)
      const payload = await response.json()
      if (payload?.songlist?.code == 1000) throw new QQMusicAuthError()
      if (payload?.code != 0 || payload?.songlist?.code != 0) throw new Error('QQ Music guess-like request failed')
      return normalizeGuessLikeSongs(payload)
    } finally {
      clearTimeout(timer)
    }
  }
  return { getGuessLikeSongs }
}
