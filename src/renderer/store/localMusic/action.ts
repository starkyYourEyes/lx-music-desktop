import { toRaw } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { normalizeLocalMusicDirs } from '@common/utils/localMusicSettings'
import {
  scanLocalMusicFolders,
  uploadLocalMusicToWebDAV as uploadLocalMusicToWebDAVIpc,
} from '@renderer/utils/ipc'
import { addListMusics } from '@renderer/store/list/action'
import { appSetting } from '@renderer/store/setting'
import {
  isScanningLocalMusic,
  localMusicList,
  localMusicScanError,
  uploadingLocalMusicIds,
} from './state'

let scanPromise: Promise<LX.Music.MusicInfoLocal[]> | null = null

const getErrorMessage = (err: unknown) => err instanceof Error ? err.message : String(err)

export const loadLocalMusicList = async(force = false) => {
  if (scanPromise) return scanPromise
  if (!force && localMusicList.length) return [...localMusicList]

  const dirs = normalizeLocalMusicDirs(appSetting['localMusic.dirs'])
  if (!dirs.length) {
    localMusicList.splice(0, localMusicList.length)
    localMusicScanError.value = ''
    isScanningLocalMusic.value = false
    return []
  }

  isScanningLocalMusic.value = true
  localMusicScanError.value = ''
  scanPromise = scanLocalMusicFolders({ dirs })
    .then((list) => {
      localMusicList.splice(0, localMusicList.length, ...list)
      return list
    })
    .catch((err) => {
      localMusicScanError.value = getErrorMessage(err)
      throw err
    })
    .finally(() => {
      isScanningLocalMusic.value = false
      scanPromise = null
    })

  return scanPromise
}

export const uploadLocalMusicToWebDAV = async(musicInfo: LX.Music.MusicInfoLocal) => {
  const id = musicInfo.id
  uploadingLocalMusicIds[id] = true
  try {
    const webDAVMusicInfo = await uploadLocalMusicToWebDAVIpc(toRaw(musicInfo))
    await addListMusics(LIST_IDS.WEBDAV, [webDAVMusicInfo], undefined, {
      skipLocalWebDAVSync: true,
      skipNeteaseSync: true,
    })
    return webDAVMusicInfo
  } finally {
    Reflect.deleteProperty(uploadingLocalMusicIds, id)
  }
}
