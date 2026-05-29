import { DATA_KEYS, STORE_NAMES } from '@common/constants'
import { formatPlayTime, sizeFormate } from '@common/utils/common'
import getStore from '@main/utils/store'
import { filterPublicRecommendPlaylists, normalizePlaylistList } from './neteasePlaylist'

// @neteasecloudmusicapienhanced/api is CommonJS and dynamically loads module files internally.
// Keep it as a runtime dependency instead of bundling it into the main process.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const neteaseApi = require('@neteasecloudmusicapienhanced/api') as {
  login_qr_key: (params?: Record<string, any>) => Promise<any>
  login_qr_create: (params: Record<string, any>) => Promise<any>
  login_qr_check: (params: Record<string, any>) => Promise<any>
  login_status: (params: Record<string, any>) => Promise<any>
  logout: (params: Record<string, any>) => Promise<any>
  recommend_songs: (params: Record<string, any>) => Promise<any>
  personal_fm: (params: Record<string, any>) => Promise<any>
  personal_fm_mode: (params: Record<string, any>) => Promise<any>
  personalized: (params: Record<string, any>) => Promise<any>
  personalized_newsong: (params: Record<string, any>) => Promise<any>
  recommend_resource: (params: Record<string, any>) => Promise<any>
  homepage_block_page: (params: Record<string, any>) => Promise<any>
  batch: (params: Record<string, any>) => Promise<any>
  toplist_detail: (params: Record<string, any>) => Promise<any>
  album_songsaleboard: (params: Record<string, any>) => Promise<any>
  playlist_detail: (params: Record<string, any>) => Promise<any>
  song_detail: (params: Record<string, any>) => Promise<any>
  like: (params: Record<string, any>) => Promise<any>
  fm_trash: (params: Record<string, any>) => Promise<any>
  song_url_v1: (params: Record<string, any>) => Promise<any>
  api: (params: Record<string, any>) => Promise<any>
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
      picUrl: song.al?.picUrl ?? song.album?.picUrl ?? song.album?.blurPicUrl ?? song.picUrl ?? '',
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

const privateFmSceneModeMap: Partial<Record<LX.Netease.PrivateFmModeId, string>> = {
  EXERCISE: 'EXERCISE',
  FOCUS: 'FOCUS',
  NIGHT_EMO: 'NIGHT_EMO',
}

export const getPrivateFmSongs = async(params: LX.Netease.PrivateFmParams = {}): Promise<LX.Music.MusicInfoOnline[]> => {
  const account = getAccountData()
  if (!account.cookie) throw new Error('Not logged in')

  const mode = params.mode ?? 'DEFAULT'
  const limit = Math.max(1, params.limit ?? 3)
  const result = mode == 'DEFAULT'
    ? await neteaseApi.personal_fm({ cookie: account.cookie })
    : await neteaseApi.personal_fm_mode({
      cookie: account.cookie,
      mode: privateFmSceneModeMap[mode] ? 'SCENE_RCMD' : mode,
      submode: privateFmSceneModeMap[mode],
      limit,
    })

  if (result.body?.code != null && result.body.code != 200) throw new Error(result.body?.message ?? 'Failed to load private FM')

  const songs = result.body?.data ?? result.body?.songs ?? []
  const privileges = result.body?.privileges ?? []
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

const formatPlayCount = (count: unknown): string => {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 100000000) return `${Math.round(value / 10000000) / 10}亿`
  if (value >= 10000) return `${Math.round(value / 1000) / 10}万`
  return String(Math.floor(value))
}

const HOMEPAGE_BATCH_API = '/api/homepage/block/page'
const PC_CUSTOMIZE_BATCH_API = '/api/pc/customize/block/page'
const HOME_BLOCK_CODES = {
  radarPlaylists: 'PC_CUSTOMIZE_PLAYLIST_SLIDE_PAPE',
  similarSongs: 'HOMEPAGE_BLOCK_RED_SIMILAR_SONG',
  recommendPlaylists: 'PC_CUSTOMIZE_PLAYLIST_SELF_PAPE',
  legacyRadarPlaylists: 'HOMEPAGE_BLOCK_MGC_PLAYLIST',
  legacyRecommendPlaylists: 'HOMEPAGE_BLOCK_PLAYLIST_RCMD',
} as const

const getHomeBlockResources = (blocks: any[], blockCode: string): any[] => {
  const block = blocks.find(block => block?.blockCode == blockCode || block?.showType == blockCode)
  if (!block) return []

  const resources: any[] = []
  for (const creative of block.creatives ?? []) {
    if (Array.isArray(creative?.resources)) {
      for (const resource of creative.resources) {
        resources.push({
          ...resource,
          creativeId: resource?.resourceId ?? creative.creativeId,
          uiElement: resource?.uiElement ?? creative.uiElement,
        })
      }
    } else if (creative) resources.push(creative)
  }
  return resources
}

const normalizeHomepagePlaylistResource = (resource: any): LX.Netease.Playlist | null => {
  const id = resource?.resourceId ?? resource?.creativeId ?? resource?.id ?? resource?.playlistId
  if (id == null || Number(id) < 0) return null

  return {
    id: String(id),
    name: resource?.uiElement?.mainTitle?.title ?? resource?.name ?? '',
    img: resource?.uiElement?.image?.imageUrl ?? resource?.picUrl ?? resource?.coverImgUrl ?? resource?.coverUrl ?? '',
    author: resource?.resourceExtInfo?.creator?.nickname ?? resource?.creator?.nickname ?? '',
    play_count: formatPlayCount(resource?.resourceExtInfo?.playCount ?? resource?.playCount),
    desc: resource?.uiElement?.subTitle?.title ?? resource?.copywriter ?? resource?.description ?? null,
    source: 'wy',
    total: resource?.resourceExtInfo?.trackCount == null ? undefined : String(resource.resourceExtInfo.trackCount),
  }
}

const parseHomepagePlaylistBlock = (blocks: any[], blockCode: string, limit: number): LX.Netease.Playlist[] => {
  return mergePlaylists(
    getHomeBlockResources(blocks, blockCode)
      .map(normalizeHomepagePlaylistResource)
      .filter((playlist: LX.Netease.Playlist | null): playlist is LX.Netease.Playlist => !!playlist && !!playlist.name && !!playlist.img),
  ).slice(0, limit)
}

const getHomepageBlocks = async(cookie: string, forceRefresh = false, blockCodes?: string[]) => {
  const cursor = blockCodes?.length
    ? JSON.stringify({ offset: 0, blockCodeOrderList: blockCodes })
    : undefined
  const params = {
    cookie,
    refresh: forceRefresh,
    cursor,
    extInfo: JSON.stringify({ abInfo: { 'hp-new-homepageV3.1': 't3' } }),
    newStyle: 'true',
    timestamp: Date.now(),
  }
  const result = cursor
    ? await neteaseApi.api({
      cookie,
      uri: '/api/homepage/block/page',
      data: {
        refresh: forceRefresh,
        cursor,
        extInfo: params.extInfo,
        newStyle: params.newStyle,
      },
      crypto: 'weapi',
      timestamp: Date.now(),
    })
    : await neteaseApi.homepage_block_page(params)
  if (result.body?.code != 200) throw new Error(result.body?.message ?? 'Failed to load homepage blocks')
  return result.body?.data?.blocks ?? []
}

const getHomepageBatchBlocks = async(cookie: string, forceRefresh = false, blockCodes: string[] = []) => {
  const result = await neteaseApi.batch({
    cookie,
    [HOMEPAGE_BATCH_API]: JSON.stringify({
      refresh: forceRefresh,
      cursor: JSON.stringify({ offset: 0, blockCodeOrderList: blockCodes }),
      extInfo: JSON.stringify({ abInfo: { 'hp-new-homepageV3.1': 't3' } }),
      newStyle: 'true',
    }),
  })
  const body = result.body?.[HOMEPAGE_BATCH_API] ?? result.body
  if (body?.code != 200) throw new Error(body?.message ?? result.body?.message ?? 'Failed to load homepage batch blocks')
  return body?.data?.blocks ?? []
}

const getPcCustomizeBatchBlocks = async(cookie: string, forceRefresh = false, showType: string) => {
  const result = await neteaseApi.batch({
    cookie,
    [PC_CUSTOMIZE_BATCH_API]: JSON.stringify({
      showType,
      refresh: forceRefresh,
      offset: 0,
      limit: 20,
    }),
  })
  const body = result.body?.[PC_CUSTOMIZE_BATCH_API] ?? result.body
  if (body?.code != 200) throw new Error(body?.message ?? result.body?.message ?? 'Failed to load pc customize batch blocks')
  return body?.data?.blocks ?? []
}

const getPlaylistSummary = async(id: string, cookie: string): Promise<LX.Netease.Playlist | null> => {
  const result = await neteaseApi.playlist_detail({
    cookie,
    id,
    timestamp: Date.now(),
  }).catch(() => null)
  return normalizePlaylistList(result?.body?.playlist ? [result.body.playlist] : [])[0] ?? null
}

const hydratePlaylistCovers = async(playlists: LX.Netease.Playlist[], cookie: string): Promise<LX.Netease.Playlist[]> => {
  const details = await Promise.all(playlists.map(async playlist => getPlaylistSummary(playlist.id, cookie)))
  return playlists.map((playlist, index) => {
    const detail = details[index]
    if (!detail) return playlist
    return {
      ...playlist,
      name: playlist.name || detail.name,
      img: playlist.img || detail.img,
      author: playlist.author || detail.author,
      play_count: playlist.play_count || detail.play_count,
      desc: playlist.desc ?? detail.desc,
      total: playlist.total ?? detail.total,
    }
  })
}

const parsePcCustomizePlaylistBlock = async(
  blocks: any[],
  blockCode: string,
  limit: number,
  cookie: string,
): Promise<LX.Netease.Playlist[]> => {
  const playlists = mergePlaylists(
    getHomeBlockResources(blocks, blockCode)
      .map(normalizeHomepagePlaylistResource)
      .filter((playlist: LX.Netease.Playlist | null): playlist is LX.Netease.Playlist => !!playlist && !!playlist.name),
  ).slice(0, limit)
  return hydratePlaylistCovers(playlists, cookie)
}

const getFallbackRadarPlaylists = async(cookie: string): Promise<LX.Netease.Playlist[]> => {
  const ids = ['2829883282', '5320167908', '5362359247', '5327906368', '5300458264']
  const playlists = await Promise.all(ids.map(async id => getPlaylistSummary(id, cookie)))
  return playlists.filter((playlist: LX.Netease.Playlist | null): playlist is LX.Netease.Playlist => !!playlist)
}

const addHomeSong = (
  songs: LX.Music.MusicInfoOnline[],
  ids: Set<string>,
  song: any,
  privilege?: any,
) => {
  if (!song?.id || !song?.name || ids.has(String(song.id))) return
  const musicInfo = normalizeSong(song, privilege)
  ids.add(String(song.id))
  songs.push(musicInfo)
}

const isHomepageSongData = (value: any) => {
  return !!(
    value?.id != null &&
    value.name &&
    !value.resourceId &&
    !value.resourceType &&
    (Array.isArray(value.ar) || Array.isArray(value.artists)) &&
    (value.al || value.album)
  )
}

const collectHomeSongs = (value: any, songs: LX.Music.MusicInfoOnline[], ids: Set<string>) => {
  if (!value || typeof value != 'object') return
  if (Array.isArray(value)) {
    for (const item of value) collectHomeSongs(item, songs, ids)
    return
  }

  const embeddedSong = value.songData ?? value.song ?? value.resourceExtInfo?.songData ?? value.resourceExtInfo?.song
  if (embeddedSong) {
    addHomeSong(songs, ids, embeddedSong, value.privilege ?? value.resourceExtInfo?.songPrivilege ?? value.resourceExtInfo?.privilege)
    return
  }

  if (isHomepageSongData(value)) {
    addHomeSong(songs, ids, value, value.privilege)
    return
  }

  for (const child of Object.values(value)) collectHomeSongs(child, songs, ids)
}

const parseHomepageSongBlock = (blocks: any[], blockCode: string, limit: number): LX.Music.MusicInfoOnline[] => {
  const songs: LX.Music.MusicInfoOnline[] = []
  const ids = new Set<string>()
  for (const resource of getHomeBlockResources(blocks, blockCode)) {
    collectHomeSongs(resource, songs, ids)
    if (songs.length >= limit) break
  }
  return songs.slice(0, limit)
}

const getPersonalizedNewSongs = async(cookie: string, limit: number): Promise<LX.Music.MusicInfoOnline[]> => {
  const result = await neteaseApi.personalized_newsong({ cookie, limit })
  if (result.body?.code != 200) return []
  return (result.body?.result ?? [])
    .map((item: any) => item?.song ?? item)
    .filter(Boolean)
    .slice(0, limit)
    .map((song: any) => normalizeSong(song))
}

const getHomeSimilarSongs = async(blocks: any[], cookie: string, limit: number, forceRefresh = false): Promise<LX.Music.MusicInfoOnline[]> => {
  let blockSongs = parseHomepageSongBlock(blocks, HOME_BLOCK_CODES.similarSongs, limit)
  if (!blockSongs.length) {
    const redSongBlocks = await getHomepageBatchBlocks(cookie, forceRefresh, [HOME_BLOCK_CODES.similarSongs]).catch(() => [])
    blockSongs = parseHomepageSongBlock(redSongBlocks, HOME_BLOCK_CODES.similarSongs, limit)
  }
  if (!blockSongs.length) {
    const redSongBlocks = await getHomepageBlocks(cookie, forceRefresh, [HOME_BLOCK_CODES.similarSongs]).catch(() => [])
    blockSongs = parseHomepageSongBlock(redSongBlocks, HOME_BLOCK_CODES.similarSongs, limit)
  }
  if (blockSongs.length) return blockSongs

  if (cookie) {
    const dailySongs = await getRecommendSongs().catch(() => [])
    if (dailySongs.length) return dailySongs.slice(0, limit)
  }

  return getPersonalizedNewSongs(cookie, limit).catch(() => [])
}

const getHomeRecommendPlaylists = async(
  cookie: string,
  limit: number,
  forceRefresh = false,
): Promise<LX.Netease.Playlist[]> => {
  const recommendBlocks = await getHomepageBatchBlocks(cookie, forceRefresh, [HOME_BLOCK_CODES.legacyRecommendPlaylists]).catch(() => [])
  let recommendPlaylists = parseHomepagePlaylistBlock(recommendBlocks, HOME_BLOCK_CODES.legacyRecommendPlaylists, limit)
  if (!recommendPlaylists.length) {
    const fallbackBlocks = await getHomepageBlocks(cookie, forceRefresh, [HOME_BLOCK_CODES.legacyRecommendPlaylists]).catch(() => [])
    recommendPlaylists = parseHomepagePlaylistBlock(fallbackBlocks, HOME_BLOCK_CODES.legacyRecommendPlaylists, limit)
  }
  if (recommendPlaylists.length) return recommendPlaylists

  return getRecommendPlaylists(limit, true).catch(() => [])
}

const chartConfigs = [
  { id: '19723756', name: '飙升榜' },
  { id: '3778678', name: '热歌榜' },
  { id: '7785066739', name: '黑胶VIP热歌榜' },
  { id: '5453912201', name: '黑胶VIP爱听榜' },
]

const getPlaylistChart = async(
  config: typeof chartConfigs[number],
  cookie: string,
  toplistMap: Map<string, any>,
): Promise<LX.Netease.HomeChart | null> => {
  const meta = toplistMap.get(config.id)
  const result = await neteaseApi.playlist_detail({
    cookie,
    id: config.id,
    timestamp: Date.now(),
  }).catch(() => null)

  const playlist = result?.body?.playlist
  const normalized = normalizePlaylistList(playlist ? [playlist] : [])[0]
  const tracks = (playlist?.tracks ?? [])
    .slice(0, 3)
    .map((song: any, index: number) => normalizeSong(song, result?.body?.privileges?.[index]))

  if (!normalized && !meta) return null

  return {
    id: config.id,
    name: normalized?.name ?? meta?.name ?? config.name,
    img: normalized?.img ?? meta?.coverImgUrl ?? '',
    desc: normalized?.desc ?? meta?.description ?? null,
    play_count: normalized?.play_count ?? formatPlayCount(meta?.playCount),
    updateFrequency: meta?.updateFrequency ?? playlist?.updateFrequency ?? '',
    source: 'wy',
    songs: tracks.length
      ? tracks.map((song: LX.Music.MusicInfoOnline) => ({ name: song.name, singer: song.singer }))
      : (meta?.tracks ?? []).slice(0, 3).map((song: any) => ({
          name: song.first ?? song.name ?? '',
          singer: song.second ?? song.singer ?? '',
        })),
  }
}

const getSalesChart = async(cookie: string): Promise<LX.Netease.HomeChart | null> => {
  const result = await neteaseApi.album_songsaleboard({
    cookie,
    albumType: 1,
    type: 'daily',
  }).catch(() => null)
  const products = result?.body?.products ?? []
  if (!products.length) return null

  return {
    id: 'song_sales_daily',
    name: '歌曲畅销指数榜',
    img: products[0]?.coverUrl ?? '',
    desc: '数字单曲销量趋势',
    play_count: products[0]?.saleNum ? `${products[0].saleNum}` : '',
    updateFrequency: '每日更新',
    source: 'wy',
    isSales: true,
    songs: products.slice(0, 3).map((product: any) => ({
      name: product.albumName ?? '',
      singer: product.artistName ?? '',
    })),
  }
}

const getHomeCharts = async(cookie: string): Promise<LX.Netease.HomeChart[]> => {
  const toplistResult = await neteaseApi.toplist_detail({ cookie }).catch(() => null)
  const toplistMap = new Map<string, any>()
  for (const chart of toplistResult?.body?.list ?? []) {
    if (chart?.id == null) continue
    toplistMap.set(String(chart.id), chart)
  }

  const [playlistCharts, salesChart] = await Promise.all([
    Promise.all(chartConfigs.map(async config => getPlaylistChart(config, cookie, toplistMap))),
    getSalesChart(cookie),
  ])

  return [
    ...playlistCharts,
    salesChart,
  ].filter((chart: LX.Netease.HomeChart | null): chart is LX.Netease.HomeChart => !!chart)
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

export const getHomeRecommendation = async(params: LX.Netease.HomeRecommendationParams = {}): Promise<LX.Netease.HomeRecommendation> => {
  const account = getAccountData()
  const cookie = account.cookie
  const blockCodes = [
    HOME_BLOCK_CODES.similarSongs,
  ]
  const [blocks, pcCustomizeBlocks] = await Promise.all([
    getHomepageBatchBlocks(cookie, !!params.forceRefresh, blockCodes).catch(() => []),
    getPcCustomizeBatchBlocks(cookie, !!params.forceRefresh, HOME_BLOCK_CODES.radarPlaylists).catch(() => []),
  ])
  const playlistLimit = Math.max(6, params.playlistLimit ?? 12)
  const songLimit = Math.max(6, params.songLimit ?? 12)

  let radarPlaylists = await parsePcCustomizePlaylistBlock(pcCustomizeBlocks, HOME_BLOCK_CODES.radarPlaylists, playlistLimit, cookie)
  if (!radarPlaylists.length) {
    const radarBlocks = await getHomepageBlocks(cookie, !!params.forceRefresh, [HOME_BLOCK_CODES.legacyRadarPlaylists]).catch(() => [])
    radarPlaylists = parseHomepagePlaylistBlock(radarBlocks, HOME_BLOCK_CODES.legacyRadarPlaylists, playlistLimit)
  }
  if (!radarPlaylists.length) radarPlaylists = await getFallbackRadarPlaylists(cookie)

  const recommendPlaylists = await getHomeRecommendPlaylists(cookie, playlistLimit, !!params.forceRefresh)
  const similarSongs = await getHomeSimilarSongs(blocks, cookie, songLimit, !!params.forceRefresh)
  const charts = await getHomeCharts(cookie).catch(() => [])

  return {
    radarPlaylists,
    similarSongs,
    recommendPlaylists,
    charts,
  }
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

export const trashPrivateFmMusic = async({ musicInfo, time = 25 }: LX.Netease.PrivateFmTrashParams) => {
  const account = getAccountData()
  if (!account.cookie || musicInfo.source != 'wy') return
  const songId = musicInfo.meta.songId ?? musicInfo.id?.replace(/^wy_/, '')
  if (!songId) throw new Error('Missing NetEase song id')

  const result = await neteaseApi.fm_trash({
    cookie: account.cookie,
    id: songId,
    time,
  })
  if (result.body?.code != null && result.body.code != 200) {
    throw new Error(result.body?.message ?? 'Failed to reduce private FM recommendation')
  }
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
