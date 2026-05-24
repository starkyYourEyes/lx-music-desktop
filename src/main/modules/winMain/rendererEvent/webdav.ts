import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import { getWebDAVMusicLyric, getWebDAVMusicPic, getWebDAVMusicUrl, listWebDAVMusics, testWebDAV } from '@main/modules/webdav'

export default () => {
  mainHandle<LX.Music.WebDAVConfig, boolean>(WIN_MAIN_RENDERER_EVENT_NAME.webdav_test, async({ params }) => {
    return testWebDAV(params)
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
