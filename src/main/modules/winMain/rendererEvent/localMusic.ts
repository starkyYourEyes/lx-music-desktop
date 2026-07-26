import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import { scanLocalMusicFolders } from '@main/modules/localMusic'
import { uploadLocalMusicToWebDAV } from '@main/modules/webdav'

const getErrorDetail = (err: unknown) => err instanceof Error
  ? (err.stack ? err.stack : err.message)
  : String(err)

export default () => {
  mainHandle<LX.Music.LocalMusicScanParams | undefined, LX.Music.MusicInfoLocal[]>(WIN_MAIN_RENDERER_EVENT_NAME.local_music_scan, async({ params }) => {
    try {
      return await scanLocalMusicFolders(params)
    } catch (err) {
      const detail = getErrorDetail(err)
      console.error('[localMusic] scan failed:', detail)
      throw new Error(`本地音乐扫描失败：${detail}`)
    }
  })
  mainHandle<LX.Music.LocalMusicUploadParams, LX.Music.MusicInfoWebDAV>(WIN_MAIN_RENDERER_EVENT_NAME.local_music_upload_to_webdav, async({ params }) => {
    return uploadLocalMusicToWebDAV(params)
  })
}
