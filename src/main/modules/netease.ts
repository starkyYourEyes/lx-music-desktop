import { DATA_KEYS, STORE_NAMES } from '@common/constants'
import { formatPlayTime, sizeFormate } from '@common/utils/common'
import getStore from '@main/utils/store'
import { filterPublicRecommendPlaylists, normalizePlaylistList } from './neteasePlaylist'

// NeteaseCloudMusicApi is CommonJS and dynamically loads module files internally.
// Keep it as a runtime dependency instead of bundling it into the main process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const neteaseApi = require('NeteaseCloudMusicApi') as {
  login_qr_key: (params?: Record<string, any>) => Promise<any>
  login_qr_create: (params: Record<string, any>) => Promise<any>
  login_qr_check: (params: Record<string, any>) => Promise<any>
  login_status: (params: Record<string, any>) => Promise<any>
  logout: (params: Record<string, any>) => Promise<any>
  recommend_songs: (params: Record<string, any>) => Promise<any>
  personalized: (params: Record<string, any>) => Promise<any>
  recommend_resource: (params: Record<string, any>) => Promise<any>
  playlist_detail: (params: Record<string, any>) => Promise<any>
  song_detail: (params: Record<string, any>) => Promise<any>
  like: (params: Record<string, any>) => Promise<any>
  song_url_v1: (params: Record<string, any>) => Promise<any>
}

interface NeteaseAccountData {
  cookie: string
  profile: LX.Netease.Profile | null
  updatedAt: number
}

const getAccountStore = () => getStore(STORE_NAMES.DATA)

const getAccountData = (): NeteaseAccountData => {
  return getAccountStore().get<NeteaseAccountData | null>(DATA_KEYS.neteaseAccount) ?? {
    cookie: '',
    profile: null,
    updatedAt: 0,
  }
}

const saveAccountData = (data: NeteaseAccountData) => {
  getAccountStore().set(DATA_KEYS.neteaseAccount, data)
}

const normalizeCookie = (cookie: unknown): string => {
  if (!cookie) return ''
  if (Array.isArray(cookie)) return cookie.join(';')
  return String(cookie)
}

const normalizeProfile = (profile: any): LX.Netease.Profile | null => {
  if (!profile?.userId) return null
  return {
    userId: profile.userId,
    nickname: profile.nickname ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    backgroundUrl: profile.backgroundUrl,
    signature: profile.signature,
  }
}

const refreshLoginStatus = async(cookie: string): Promise<LX.Netease.AccountStatus> => {
  if (!cookie) return { isLoggedIn: false, profile: null }

  const result = await neteaseApi.login_status({ cookie })
  const profile = normalizeProfile(result.body?.data?.profile ?? result.body?.profile)
  const mergedCookie = normalizeCookie(result.body?.cookie || result.cookie) || cookie
  saveAccountData({
    cookie: mergedCookie,
    profile,
    updatedAt: Date.now(),
  })

  return {
    isLoggedIn: !!profile,
    profile,
  }
}

export const getAccountStatus = async(): Promise<LX.Netease.AccountStatus> => {
  const account = getAccountData()
  if (!account.cookie) return { isLoggedIn: false, profile: null }

  // Avoid hitting the login status endpoint on every renderer mount.
  if (account.profile && Date.now() - account.updatedAt < 5 * 60 * 1000) {
    return {
      isLoggedIn: true,
      profile: account.profile,
    }
  }

  return refreshLoginStatus(account.cookie).catch(() => ({
    isLoggedIn: !!account.profile,
    profile: account.profile,
  }))
}

export const createLoginQr = async(): Promise<LX.Netease.LoginQr> => {
  const keyResult = await neteaseApi.login_qr_key()
  const key = keyResult.body?.data?.unikey
  if (!key) throw new Error('Failed to create login QR key')

  const qrResult = await neteaseApi.login_qr_create({ key, qrimg: true })
  const data = qrResult.body?.data
  return {
    key,
    qrurl: data?.qrurl ?? '',
    qrimg: data?.qrimg ?? '',
  }
}

export const checkLoginQr = async(key: string): Promise<LX.Netease.LoginQrCheck> => {
  const result = await neteaseApi.login_qr_check({ key })
  const code = Number(result.body?.code ?? 0)
  const message = result.body?.message ?? ''
  if (code !== 803) {
    return {
      code,
      message,
      isLoggedIn: false,
      profile: null,
    }
  }

  const cookie = normalizeCookie(result.body?.cookie || result.cookie)
  const status = await refreshLoginStatus(cookie)
  return {
    code,
    message,
    ...status,
  }
}

export const logout = async() => {
  const account = getAccountData()
  if (account.cookie) {
    await neteaseApi.logout({ cookie: account.cookie }).catch(() => null)
  }
  saveAccountData({
    cookie: '',
    profile: null,
    updatedAt: Date.now(),
  })
}

const getSinger = (singers: any[] | undefined): string => {
  return singers?.map(s => s.name).filter(Boolean).join('、') ?? ''
}

const pushQuality = (
  qualitys: LX.Music.MusicQualityType[],
  _qualitys: LX.Music._MusicQualityType,
  type: LX.Quality,
  size?: number,
) => {
  const formattedSize = size ? sizeFormate(size) : null
  qualitys.push({ type, size: formattedSize })
  _qualitys[type] = { size: formattedSize }
}

const createQualityInfo = (song: any, privilege: any) => {
  const qualitys: LX.Music.MusicQualityType[] = []
  const _qualitys: LX.Music._MusicQualityType = {}

  if (privilege?.maxBrLevel == 'hires' || song.hr) pushQuality(qualitys, _qualitys, 'flac24bit', song.hr?.size)
  switch (privilege?.maxbr ?? 320000) {
    case 999000:
      pushQuality(qualitys, _qualitys, 'flac', song.sq?.size)
    case 320000:
      pushQuality(qualitys, _qualitys, '320k', song.h?.size)
    case 192000:
    case 128000:
      pushQuality(qualitys, _qualitys, '128k', song.l?.size)
      break
    default:
      pushQuality(qualitys, _qualitys, '128k', song.l?.size)
  }

  return {
    qualitys: qualitys.reverse(),
    _qualitys,
  }
}

const normalizeSong = (song: any, privilege?: any): LX.Music.MusicInfoOnline => {
  const { qualitys, _qualitys } = createQualityInfo(song, privilege)
  return {
    id: `wy_${song.id}`,
    name: song.name ?? '',
    singer: getSinger(song.ar ?? song.artists),
    source: 'wy',
    interval: typeof song.dt == 'number' ? formatPlayTime(song.dt / 1000) : null,
    meta: {
      songId: song.id,
      albumName: song.al?.name ?? song.album?.name ?? '',
      albumId: song.al?.id ?? song.album?.id,
      picUrl: song.al?.picUrl ?? song.album?.picUrl ?? '',
      qualitys,
      _qualitys,
    },
  }
}

export const getRecommendSongs = async(): Promise<LX.Music.MusicInfoOnline[]> => {
  const account = getAccountData()
  if (!account.cookie) throw new Error('Not logged in')

  const result = await neteaseApi.recommend_songs({ cookie: account.cookie })
  if (result.body?.code != 200) throw new Error(result.body?.message ?? 'Failed to load recommendations')

  const songs = result.body?.data?.dailySongs ?? result.body?.recommend ?? []
  const privileges = result.body?.data?.privileges ?? []
  return songs.map((song: any, index: number) => normalizeSong(song, privileges[index]))
}

const playlistDetailLimit = 1000

const getSongDetailList = async(ids: string[], cookie: string) => {
  const songs: any[] = []
  const privileges: any[] = []
  for (let index = 0; index < ids.length; index += playlistDetailLimit) {
    const chunkIds = ids.slice(index, index + playlistDetailLimit)
    const result = await neteaseApi.song_detail({
      cookie,
      ids: chunkIds.join(','),
    })
    if (result.body?.code != 200) throw new Error(result.body?.message ?? 'Failed to load song details')
    songs.push(...(result.body?.songs ?? []))
    privileges.push(...(result.body?.privileges ?? []))
  }
  return { songs, privileges }
}

const normalizePlaylistTracks = async(playlist: any, privileges: any[], cookie: string): Promise<LX.Music.MusicInfoOnline[]> => {
  const trackIds = (playlist.trackIds ?? []).map((track: any) => String(track.id)).filter(Boolean)
  const trackMap = new Map<string, any>()
  const privilegeMap = new Map<string, any>()

  for (const track of playlist.tracks ?? []) {
    if (track?.id == null) continue
    trackMap.set(String(track.id), track)
  }
  for (const privilege of privileges ?? []) {
    if (privilege?.id == null) continue
    privilegeMap.set(String(privilege.id), privilege)
  }

  const missingIds = trackIds.filter((id: string) => !trackMap.has(id))
  if (missingIds.length) {
    const detail = await getSongDetailList(missingIds, cookie)
    for (const track of detail.songs) {
      if (track?.id == null) continue
      trackMap.set(String(track.id), track)
    }
    for (const privilege of detail.privileges) {
      if (privilege?.id == null) continue
      privilegeMap.set(String(privilege.id), privilege)
    }
  }

  const orderedIds = trackIds.length
    ? trackIds
    : [...trackMap.keys()] as string[]

  return orderedIds
    .map((id: string) => {
      const track = trackMap.get(id)
      return track ? normalizeSong(track, privilegeMap.get(id)) : null
    })
    .filter((track: LX.Music.MusicInfoOnline | null): track is LX.Music.MusicInfoOnline => !!track)
}

export const getRecommendPlaylistDetail = async(id: string, page = 1): Promise<LX.Netease.PlaylistDetailInfo> => {
  const account = getAccountData()
  if (!account.cookie) throw new Error('Not logged in')

  const result = await neteaseApi.playlist_detail({
    cookie: account.cookie,
    id,
    timestamp: Date.now(),
  })
  if (result.body?.code != 200) throw new Error(result.body?.message ?? 'Failed to load playlist detail')

  const playlist = result.body?.playlist
  if (!playlist) throw new Error('Playlist not found')

  const list = await normalizePlaylistTracks(playlist, result.body?.privileges ?? [], account.cookie)
  const normalizedPlaylist = normalizePlaylistList([playlist])[0]
  const safePage = Math.max(1, page)
  const rangeStart = (safePage - 1) * playlistDetailLimit

  return {
    list: list.slice(rangeStart, playlistDetailLimit * safePage),
    page: safePage,
    limit: playlistDetailLimit,
    total: list.length,
    source: 'wy',
    desc: playlist.description ?? null,
    key: null,
    id: String(id),
    info: {
      play_count: normalizedPlaylist?.play_count ?? '',
      name: normalizedPlaylist?.name ?? playlist.name ?? '',
      img: normalizedPlaylist?.img ?? playlist.coverImgUrl ?? '',
      desc: normalizedPlaylist?.desc ?? playlist.description ?? null,
      author: normalizedPlaylist?.author ?? playlist.creator?.nickname ?? '',
    },
    noItemLabel: '',
  }
}

const specialPlaylistIds = new Set(['3136952023', '2829883282', '2829816518', '2829896389'])

const replaceSpecialRecommendResult = async(playlists: LX.Netease.Playlist[], cookie: string) => {
  await Promise.all(playlists.map(async(playlist) => {
    if (!specialPlaylistIds.has(playlist.id)) return

    const result = await neteaseApi.playlist_detail({
      cookie,
      id: playlist.id,
      timestamp: Date.now(),
    }).catch(() => null)
    const detail = normalizePlaylistList(result?.body?.playlist ? [result.body.playlist] : [])[0]
    if (!detail) return
    playlist.name = detail.name || playlist.name
    playlist.img = detail.img || playlist.img
  }))
}

const mergePlaylists = (playlists: LX.Netease.Playlist[]): LX.Netease.Playlist[] => {
  const ids = new Set<string>()
  const list: LX.Netease.Playlist[] = []

  for (const playlist of playlists) {
    if (ids.has(playlist.id)) continue
    ids.add(playlist.id)
    list.push(playlist)
  }

  return list
}

export const getRecommendPlaylists = async(limit = 10, removePrivateRecommend = false): Promise<LX.Netease.Playlist[]> => {
  const account = getAccountData()

  if (!account.cookie) {
    const result = await neteaseApi.personalized({ limit })
    if (result.body?.code != 200) throw new Error(result.body?.message ?? 'Failed to load playlists')
    return normalizePlaylistList(result.body?.result ?? []).slice(0, limit)
  }

  const [dailyResult, publicResult] = await Promise.all([
    neteaseApi.recommend_resource({ cookie: account.cookie, timestamp: Date.now() }).catch(() => null),
    neteaseApi.personalized({ cookie: account.cookie, limit }),
  ])

  if (publicResult.body?.code != 200) throw new Error(publicResult.body?.message ?? 'Failed to load playlists')

  let dailyRecommend = normalizePlaylistList(dailyResult?.body?.recommend ?? [])
  if (dailyRecommend.length) {
    if (removePrivateRecommend) dailyRecommend = dailyRecommend.slice(1)
    await replaceSpecialRecommendResult(dailyRecommend, account.cookie)
  }

  return mergePlaylists([
    ...dailyRecommend,
    ...filterPublicRecommendPlaylists(normalizePlaylistList(publicResult.body?.result ?? [])),
  ]).slice(0, limit)
}

export const likeMusic = async(musicInfo: LX.Music.MusicInfo) => {
  const account = getAccountData()
  if (!account.cookie || musicInfo.source != 'wy') return
  const songId = musicInfo.meta.songId ?? musicInfo.id?.replace(/^wy_/, '')
  if (!songId) throw new Error('Missing NetEase song id')

  await neteaseApi.like({
    cookie: account.cookie,
    id: songId,
    like: true,
  })
}

const qualityLevelMap: Partial<Record<LX.Quality, string>> = {
  '128k': 'standard',
  '320k': 'exhigh',
  flac: 'lossless',
  flac24bit: 'hires',
}

export const getMusicUrl = async(musicInfo: LX.Music.MusicInfo, quality: LX.Quality = '320k'): Promise<string> => {
  const account = getAccountData()
  if (!account.cookie || musicInfo.source != 'wy') return ''

  const result = await neteaseApi.song_url_v1({
    cookie: account.cookie,
    id: musicInfo.meta.songId,
    level: qualityLevelMap[quality] ?? 'exhigh',
  })
  return result.body?.data?.[0]?.url ?? ''
}
