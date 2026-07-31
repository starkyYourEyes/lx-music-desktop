import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import {
  getWebDAVCredentialStatus,
  getWebDAVMusicLyric,
  getWebDAVMusicPic,
  getWebDAVMusicUrl,
  listWebDAVMusics,
  removeWebDAVCredentials,
  setWebDAVCredentials,
  testWebDAV,
} from '@main/modules/webdav'

export default () => {
  mainHandle<LX.Music.WebDAVConfig, boolean>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_test, async({ params }) => {
    return testWebDAV(params)
  })
  mainHandle<LX.Music.WebDAVCredentialStatus>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_get_credential_status, async() => {
    return getWebDAVCredentialStatus()
  })
  mainHandle<LX.Music.WebDAVCredentialInput, LX.Music.WebDAVCredentialSaveResult>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_set_credentials, async({ params }) => {
    return setWebDAVCredentials(params)
  })
  mainHandle(WIN_MAIN_RENDERER_EVENT_NAME.webdav_remove_credentials, async() => {
    await removeWebDAVCredentials()
  })
  mainHandle<LX.Music.WebDAVListMusicParams | undefined, LX.Music.MusicInfoWebDAV[]>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_list_musics, async({ params }) => {
    return listWebDAVMusics(params)
  })
  mainHandle<LX.Music.MusicInfoWebDAV, string>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_get_music_url, async({ params }) => {
    return getWebDAVMusicUrl(params)
  })
  mainHandle<LX.Music.MusicInfoWebDAV, string>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_get_music_pic, async({ params }) => {
    return getWebDAVMusicPic(params)
  })
  mainHandle<LX.Music.MusicInfoWebDAV, LX.Music.LyricInfo | null>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_get_music_lyric, async({ params }) => {
    return getWebDAVMusicLyric(params)
  })
}
