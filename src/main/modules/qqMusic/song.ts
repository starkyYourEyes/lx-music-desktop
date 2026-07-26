import { formatPlayTime, sizeFormate } from '@common/utils/common'
import { getCookieValue } from './auth'
import {
  createQQMusicFallbackGuid,
  createQQMusicFallbackUid,
  createQQMusicRequestSign,
} from './request'

const NEW_GUESS_LIKE_URL = 'https://u6.y.qq.com/cgi-bin/musics.fcg'
const LEGACY_GUESS_LIKE_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const NEW_GUESS_LIKE_REQUEST_KEY = 'music.radioProxy.MbTrackRadioSvr.get_radio_track'
const GUESS_LIKE_ERROR = 'QQ Music guess-like request failed'

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
  const tracks = payload?.[NEW_GUESS_LIKE_REQUEST_KEY]?.data?.tracks ??
    payload?.songlist?.data?.tracks ??
    payload?.songlist?.data?.track_list
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

export const normalizeQQMusicTracks = (tracks: unknown): LX.Music.MusicInfo_tx[] => {
  if (!Array.isArray(tracks)) throw new Error('Invalid QQ Music tracks response')
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

export const normalizeGuessLikeSongs = (payload: any): LX.Music.MusicInfo_tx[] => {
  const tracks = getTracks(payload)
  if (!tracks) throw new Error('Invalid QQ Music guess-like response')
  return normalizeQQMusicTracks(tracks)
}

export const createQQMusicSongService = ({
  fetchImpl = fetch,
  getCookie,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
}) => {
  const post = async(url: URL, cookie: string, body: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => {
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
      if (!response.ok) throw new Error(`${GUESS_LIKE_ERROR}: ${response.status}`)
      return response.json()
    } finally {
      clearTimeout(timer)
    }
  }

  let newRequestTail: Promise<unknown> = Promise.resolve()

  const getNewGuessLikeSongs = async(
    cookie: string,
    radioMode: LX.QQMusic.RadioMode,
  ): Promise<LX.Music.MusicInfo_tx[]> => {
    const uin = (getCookieValue(cookie, 'qqmusic_uin') || getCookieValue(cookie, 'uin')).replace(/^o/, '')
    const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
    if (!uin || !key) throw new QQMusicAuthError('QQ Music account is not logged in')
    const guid = getCookieValue(cookie, 'qqmusic_guid') ||
      getCookieValue(cookie, 'guid') ||
      createQQMusicFallbackGuid(uin)
    const uid = getCookieValue(cookie, 'uid') || createQQMusicFallbackUid(uin)
    const body = JSON.stringify({
      comm: {
        _channelid: '19',
        _os_version: '6.2.9200-2',
        authst: key,
        ct: '19',
        cv: '2116',
        guid,
        patch: '118',
        psrf_access_token_expiresAt: Number(getCookieValue(cookie, 'psrf_access_token_expiresAt')) || 0,
        psrf_qqaccess_token: getCookieValue(cookie, 'psrf_qqaccess_token'),
        psrf_qqopenid: getCookieValue(cookie, 'psrf_qqopenid'),
        psrf_qqunionid: getCookieValue(cookie, 'psrf_qqunionid'),
        tmeAppID: 'qqmusic',
        tmeLoginType: Number(getCookieValue(cookie, 'tmeLoginType')) || 2,
        uid,
        uin,
        wid: getCookieValue(cookie, 'wid') || '0',
      },
      [NEW_GUESS_LIKE_REQUEST_KEY]: {
        module: 'music.radioProxy.MbTrackRadioSvr',
        method: 'get_radio_track',
        param: { id: 99, num: radioMode == 'brush' ? 5 : 15 },
      },
    })
    const url = new URL(NEW_GUESS_LIKE_URL)
    url.searchParams.set('pcachetime', String(Date.now()))
    url.searchParams.set('sign', createQQMusicRequestSign(body))
    const task = newRequestTail.then(async() => {
      const payload = await post(url, cookie, body)
      const result = payload?.[NEW_GUESS_LIKE_REQUEST_KEY]
      if (payload?.code == 1000 || result?.code == 1000) throw new QQMusicAuthError()
      if (payload?.code != 0 || result?.code != 0) throw new Error(GUESS_LIKE_ERROR)
      return normalizeGuessLikeSongs(payload)
    })
    newRequestTail = task.then(() => undefined, () => undefined)
    return task
  }

  const getLegacyGuessLikeSongs = async(
    cookie: string,
    continuation: boolean,
    radioMode: LX.QQMusic.RadioMode,
  ): Promise<LX.Music.MusicInfo_tx[]> => {
    const loginUin = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')
    const url = new URL(LEGACY_GUESS_LIKE_URL)
    url.searchParams.set('format', 'json')
    url.searchParams.set('platform', 'yqq.json')
    url.searchParams.set('loginUin', loginUin.replace(/^o/, ''))
    const body = JSON.stringify({
      comm: { ct: 24, cv: 0 },
      songlist: {
        module: 'mb_track_radio_svr',
        method: 'get_radio_track',
        param: { id: 99, firstplay: continuation ? 0 : 1, num: radioMode == 'brush' ? 5 : 15 },
      },
    })
    const payload = await post(url, cookie, body)
    if (payload?.songlist?.code == 1000) throw new QQMusicAuthError()
    if (payload?.code != 0 || payload?.songlist?.code != 0) throw new Error(GUESS_LIKE_ERROR)
    return normalizeGuessLikeSongs(payload)
  }

  const getGuessLikeSongs = async({
    continuation = false,
    apiVersion = 'new',
    radioMode = 'guessLike',
  }: LX.QQMusic.GuessLikeRequest = {}): Promise<LX.Music.MusicInfo_tx[]> => {
    const cookie = getCookie()
    if (!cookie) throw new QQMusicAuthError('QQ Music account is not logged in')
    try {
      return apiVersion == 'legacy'
        ? await getLegacyGuessLikeSongs(cookie, continuation, radioMode)
        : await getNewGuessLikeSongs(cookie, radioMode)
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error(GUESS_LIKE_ERROR)
    }
  }
  return { getGuessLikeSongs }
}
