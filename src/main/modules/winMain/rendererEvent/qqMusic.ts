import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import {
  cancelLoginQr,
  checkLoginQr,
  createLoginQr,
  disposeLoginQr,
  getAccountStatus,
  getDailyRecommendSongs,
  getGuessLikeSongs,
  getHomeRecommendation,
  getPlaylistDetail,
  isQQMusicLoginRequestId,
  dislikeMusic,
  likeMusic,
  logout,
} from '@main/modules/qqMusic'

const assertQQMusicInfo = (params: LX.Music.MusicInfo): LX.Music.MusicInfo_tx => {
  if (!params || params.source != 'tx') {
    throw new Error('QQ Music feedback request failed')
  }
  return params
}

export default () => {
  mainHandle<LX.QQMusic.AccountStatus>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_account_status, async() => {
    return getAccountStatus()
  })

  mainHandle<string, LX.QQMusic.LoginQr>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_create,
    async({ params: requestId }) => {
      const startedAt = Date.now()
      if (!isQQMusicLoginRequestId(requestId)) {
        throw new Error('QQ Music login QR creation failed')
      }
      return createLoginQr(requestId, startedAt)
    },
  )

  mainHandle<string, LX.QQMusic.LoginQrCheck>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_check, async({ params: key }) => {
    return checkLoginQr(key)
  })

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  mainHandle<string, void>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_cancel,
    async({ params: requestId }) => {
      if (!isQQMusicLoginRequestId(requestId)) {
        throw new Error('QQ Music login QR creation failed')
      }
      await cancelLoginQr(requestId)
    },
  )

  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_logout, async() => {
    await logout()
  })

  mainHandle<LX.QQMusic.GuessLikeRequest | undefined, LX.Music.MusicInfo_tx[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_guess_like_songs,
    async({ params }) => getGuessLikeSongs(params),
  )

  mainHandle<LX.Music.MusicInfo_tx[]>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_daily_recommend_songs,
    async() => getDailyRecommendSongs(),
  )

  mainHandle<LX.QQMusic.HomeRecommendation>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_home_recommendation,
    async() => getHomeRecommendation(),
  )

  mainHandle<LX.QQMusic.PlaylistDetailParams, LX.QQMusic.PlaylistDetailInfo>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_playlist_detail,
    async({ params }) => getPlaylistDetail(params.id, params.page),
  )

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  mainHandle<LX.Music.MusicInfo_tx, void>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_like_music,
    async({ params }) => {
      params = assertQQMusicInfo(params)
      await likeMusic(params)
    },
  )

  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type
  mainHandle<LX.Music.MusicInfo_tx, void>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_dislike_music,
    async({ params }) => {
      params = assertQQMusicInfo(params)
      await dislikeMusic(params)
    },
  )

  global.lx.event_app.on('main_window_close', () => {
    void disposeLoginQr().catch(() => {})
  })
}
