import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import { assertRecommendationRequest } from '@main/services/recommendationSessions'
import {
  cancelLoginQr,
  checkLoginQr,
  createLoginQr,
  getAccountStatus,
  getDailyRecommendSongs,
  getPrivateFmSongs,
  getPublicRecommendation,
  getRankRecommendation,
  getStyleRecommendation,
  getKugouUserPlaylists,
  logout,
} from '@main/modules/kugouMusic'

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const isKugouLoginRequestId = (requestId: unknown): requestId is string => {
  return typeof requestId == 'string' && UUID_V4_PATTERN.test(requestId)
}

function assertRequestId(requestId: unknown, operation: string): asserts requestId is string {
  if (!isKugouLoginRequestId(requestId)) throw new Error(`KuGou login QR ${operation} failed`)
}

const sanitizeProfile = (profile: LX.KuGouMusic.Profile | null | undefined): LX.KuGouMusic.Profile | null => {
  if (!profile || typeof profile != 'object') return null
  const userId = typeof profile.userId == 'string' ? profile.userId : String(profile.userId ?? '')
  const nickname = typeof profile.nickname == 'string' ? profile.nickname : String(profile.nickname ?? '')
  const avatarUrl = typeof profile.avatarUrl == 'string' ? profile.avatarUrl : ''
  return { userId, nickname, ...(avatarUrl ? { avatarUrl } : {}) }
}

const sanitizeAccountStatus = (status: LX.KuGouMusic.AccountStatus): LX.KuGouMusic.AccountStatus => ({
  isLoggedIn: !!status?.isLoggedIn,
  profile: sanitizeProfile(status?.profile),
  ...(status?.unavailableReason == 'credential_undecryptable' ? { unavailableReason: status.unavailableReason } : {}),
})

const sanitizeLoginQr = (qr: LX.KuGouMusic.LoginQr): LX.KuGouMusic.LoginQr => ({
  requestId: qr.requestId,
  image: qr.image,
})

const sanitizeLoginQrCheck = (result: LX.KuGouMusic.LoginQrCheck): LX.KuGouMusic.LoginQrCheck => ({
  code: Number.isFinite(result?.code) ? result.code : 0,
  state: result?.state == 'waiting' || result?.state == 'scanned' || result?.state == 'success' ? result.state : 'expired',
  isLoggedIn: !!result?.isLoggedIn,
  profile: sanitizeProfile(result?.profile),
})

const sanitizeMusicInfo = (song: LX.Music.MusicInfo_kg): LX.Music.MusicInfo_kg => {
  const meta = song.meta
  const qualitys = Array.isArray(meta.qualitys)
    ? meta.qualitys.map(quality => ({ type: quality.type, size: quality.size, hash: quality.hash }))
    : []
  const _qualitys: LX.Music._MusicQualityTypeKg = {}
  for (const quality of qualitys) _qualitys[quality.type] = { size: quality.size, hash: quality.hash }
  return {
    id: song.id,
    name: song.name,
    singer: song.singer,
    source: 'kg',
    interval: song.interval,
    meta: {
      songId: meta.songId,
      albumName: meta.albumName,
      ...(meta.picUrl ? { picUrl: meta.picUrl } : {}),
      hash: meta.hash,
      qualitys,
      _qualitys,
    },
  }
}

const sanitizeSongs = (songs: LX.Music.MusicInfo_kg[]): LX.Music.MusicInfo_kg[] => {
  return Array.isArray(songs) ? songs.map(sanitizeMusicInfo) : []
}

const sanitizePlaylist = (playlist: LX.KuGouMusic.RecommendPlaylist): LX.KuGouMusic.RecommendPlaylist => ({
  id: playlist.id,
  source: 'kg',
  name: playlist.name,
  img: playlist.img,
  description: playlist.description,
  author: playlist.author,
  playCount: playlist.playCount,
})

const sanitizeRank = (rank: LX.KuGouMusic.Rank): LX.KuGouMusic.Rank => ({
  id: rank.id,
  source: 'kg',
  name: rank.name,
  img: rank.img,
  description: rank.description,
  songs: sanitizeSongs(rank.songs),
})

export default () => {
  mainHandle<LX.KuGouMusic.AccountStatus>(WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_account_status, async() => {
    return sanitizeAccountStatus(await getAccountStatus())
  })

  mainHandle<string, LX.KuGouMusic.LoginQr>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_login_qr_create,
    async({ params: requestId }) => {
      assertRequestId(requestId, 'creation')
      return sanitizeLoginQr(await createLoginQr(requestId))
    },
  )

  mainHandle<string, LX.KuGouMusic.LoginQrCheck>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_login_qr_check,
    async({ params: requestId }) => {
      assertRequestId(requestId, 'check')
      return sanitizeLoginQrCheck(await checkLoginQr(requestId))
    },
  )

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  mainHandle<string, void>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_login_qr_cancel,
    async({ params: requestId }) => {
      assertRequestId(requestId, 'cancellation')
      await cancelLoginQr(requestId)
    },
  )

  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_logout, async() => {
    await logout()
  })

  mainHandle<undefined, LX.KuGouMusic.PublicRecommendation>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_public_recommendation,
    async({ event }) => {
      assertRecommendationRequest('kugouRecommend', event)
      const result = await getPublicRecommendation()
      return {
        playlists: Array.isArray(result.playlists) ? result.playlists.map(sanitizePlaylist) : [],
        ranks: Array.isArray(result.ranks) ? result.ranks.map(sanitizeRank) : [],
      }
    },
  )

  mainHandle<undefined, LX.Music.MusicInfo_kg[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_daily_recommend_songs,
    async({ event }) => {
      assertRecommendationRequest('kugouRecommend', event)
      return sanitizeSongs(await getDailyRecommendSongs())
    },
  )

  mainHandle<undefined, LX.Music.MusicInfo_kg[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_style_recommendation,
    async({ event }) => {
      assertRecommendationRequest('kugouRecommend', event)
      return sanitizeSongs(await getStyleRecommendation())
    },
  )

  mainHandle<undefined, LX.Music.MusicInfo_kg[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_private_fm,
    async({ event }) => {
      assertRecommendationRequest('kugouRecommend', event)
      return sanitizeSongs(await getPrivateFmSongs())
    },
  )

  mainHandle<undefined, LX.KuGouMusic.RankRecommendation>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_rank_recommendation,
    async({ event }) => {
      assertRecommendationRequest('kugouRecommend', event)
      const result = await getRankRecommendation()
      return { rank: result.rank ? sanitizeRank(result.rank) : null, songs: sanitizeSongs(result.songs) }
    },
  )

  mainHandle<readonly LX.PlatformPlaylistKind[] | undefined, LX.PlatformPlaylistSummary[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.kugou_music_get_user_playlist_summaries,
    async({ params }) => getKugouUserPlaylists(params),
  )
}
