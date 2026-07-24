import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import {
  checkLoginQr,
  createLoginQr,
  getAccountStatus,
  getDailyRecommendSongs,
  getGuessLikeSongs,
  getHomeRecommendation,
  logout,
} from '@main/modules/qqMusic'

export default () => {
  mainHandle<LX.QQMusic.AccountStatus>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_account_status, async() => {
    return getAccountStatus()
  })

  mainHandle<LX.QQMusic.LoginQr>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_create, async() => {
    return createLoginQr()
  })

  mainHandle<string, LX.QQMusic.LoginQrCheck>(WIN_MAIN_RENDERER_EVENT_NAME.qq_music_login_qr_check, async({ params: key }) => {
    return checkLoginQr(key)
  })

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
}
