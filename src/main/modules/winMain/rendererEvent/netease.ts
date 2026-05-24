import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import {
  checkLoginQr,
  createLoginQr,
  getAccountStatus,
  getMusicUrl,
  getRecommendPlaylists,
  getRecommendSongs,
  likeMusic,
  logout,
} from '@main/modules/netease'

export default () => {
  mainHandle<LX.Netease.AccountStatus>(WIN_MAIN_RENDERER_EVENT_NAME.netease_get_account_status, async() => {
    return getAccountStatus()
  })

  mainHandle<LX.Netease.LoginQr>(WIN_MAIN_RENDERER_EVENT_NAME.netease_login_qr_create, async() => {
    return createLoginQr()
  })

  mainHandle<string, LX.Netease.LoginQrCheck>(WIN_MAIN_RENDERER_EVENT_NAME.netease_login_qr_check, async({ params: key }) => {
    return checkLoginQr(key)
  })

  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.netease_logout, async() => {
    await logout()
  })

  mainHandle<LX.Music.MusicInfoOnline[]>(WIN_MAIN_RENDERER_EVENT_NAME.netease_get_recommend_songs, async() => {
    return getRecommendSongs()
  })

  mainHandle<{ limit?: number, removePrivateRecommend?: boolean }, LX.Netease.Playlist[]>(WIN_MAIN_RENDERER_EVENT_NAME.netease_get_recommend_playlists, async({ params }) => {
    return getRecommendPlaylists(params?.limit, params?.removePrivateRecommend)
  })

  mainHandle<LX.Netease.MusicUrlParams, string>(WIN_MAIN_RENDERER_EVENT_NAME.netease_get_music_url, async({ params }) => {
    return getMusicUrl(params.musicInfo, params.quality)
  })

  mainHandle<LX.Music.MusicInfo>(WIN_MAIN_RENDERER_EVENT_NAME.netease_like_music, async({ params: musicInfo }) => {
    await likeMusic(musicInfo)
  })
}
