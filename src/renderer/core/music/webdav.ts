import { getWebDAVMusicLyric, getWebDAVMusicPic, getWebDAVMusicUrl } from '@renderer/utils/ipc'
import { buildLyricInfo } from './utils'

export const getMusicUrl = async({ musicInfo }: {
  musicInfo: LX.Music.MusicInfoWebDAV
  isRefresh: boolean
}): Promise<string> => {
  return getWebDAVMusicUrl(musicInfo)
}

export const getPicUrl = async({ musicInfo }: {
  musicInfo: LX.Music.MusicInfoWebDAV
  listId?: string | null
  isRefresh: boolean
}): Promise<string> => {
  // TODO: WebDAV 歌曲封面与专辑信息在播放栏、播放详情页的展示仍需继续排查。
  const isEmbeddedPic = musicInfo.meta.hasEmbeddedPic == true || musicInfo.meta.picUrl?.endsWith('#embedded-cover') == true
  if (!isEmbeddedPic && !musicInfo.meta.picPath) return musicInfo.meta.picUrl?.startsWith('webdav:') ? '' : musicInfo.meta.picUrl ?? ''
  return getWebDAVMusicPic(musicInfo)
}

export const getLyricInfo = async({ musicInfo }: {
  musicInfo: LX.Music.MusicInfoWebDAV
  isRefresh: boolean
}): Promise<LX.Player.LyricInfo> => {
  const lyricInfo = await getWebDAVMusicLyric(musicInfo)
  return buildLyricInfo(lyricInfo ?? {
    lyric: '',
    tlyric: '',
    rlyric: '',
    lxlyric: '',
  })
}
