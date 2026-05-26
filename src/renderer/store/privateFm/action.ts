import { markRawList, toRaw } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { playInfo, playMusicInfo } from '@renderer/store/player/state'
import { clearPlayedList } from '@renderer/store/player/action'
import { playList, playMusicByInfo } from '@renderer/core/player'
import { getListMusicsFromCache, setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { getNeteasePrivateFm } from '@renderer/utils/ipc'
import {
  currentPrivateFmMode,
  isLoadingPrivateFm,
  isPrivateFmMode,
  PRIVATE_FM_TEMP_LIST_ID,
  privateFmModeId,
  privateFmQueue,
} from './state'

const DEFAULT_FM_LIMIT = 6
const MIN_QUEUE_REMAINING = 2

const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))

export const loadPrivateFmSongs = async(mode = privateFmModeId.value, limit = DEFAULT_FM_LIMIT) => {
  isLoadingPrivateFm.value = true
  try {
    const songs = await getNeteasePrivateFm({ mode, limit })
    return markRawList(songs)
  } finally {
    isLoadingPrivateFm.value = false
  }
}

export const refreshPrivateFmQueue = async(mode = privateFmModeId.value) => {
  const songs = await loadPrivateFmSongs(mode)
  privateFmQueue.splice(0, privateFmQueue.length, ...songs)
  return songs
}

export const preparePrivateFmQueue = async(forceRefresh = false, mode = privateFmModeId.value) => {
  if (!forceRefresh && privateFmQueue.length) return privateFmQueue
  return refreshPrivateFmQueue(mode)
}

export const appendPrivateFmQueue = async() => {
  const songs = await loadPrivateFmSongs(privateFmModeId.value)
  const ids = new Set(privateFmQueue.map(song => song.id))
  const nextSongs = songs.filter(song => !ids.has(song.id))
  if (nextSongs.length) privateFmQueue.push(...nextSongs)
  return nextSongs
}

export const syncPrivateFmTempList = async() => {
  if (!privateFmQueue.length) return
  await setTempList(PRIVATE_FM_TEMP_LIST_ID, toCloneable(privateFmQueue))
}

export const setPrivateFmMode = async(mode: LX.Netease.PrivateFmModeId) => {
  if (mode == privateFmModeId.value) return
  privateFmModeId.value = mode
  if (!isPrivateFmMode.value) {
    await refreshPrivateFmQueue(mode)
    return
  }

  const songs = await refreshPrivateFmQueue(mode)
  if (!songs.length) return
  await syncPrivateFmTempList()
  clearPlayedList()
  playList(LIST_IDS.TEMP, 0)
}

export const enterPrivateFmMode = async(startIndex = 0) => {
  if (!privateFmQueue.length) await refreshPrivateFmQueue()
  if (!privateFmQueue.length) throw new Error('Private FM has no songs')

  isPrivateFmMode.value = true
  await syncPrivateFmTempList()
  clearPlayedList()
  playList(LIST_IDS.TEMP, Math.min(startIndex, privateFmQueue.length - 1))
}

export const playPrivateFmSong = async(musicInfo: LX.Music.MusicInfoOnline) => {
  const index = privateFmQueue.findIndex(song => song.id == musicInfo.id)
  if (index > -1) {
    await enterPrivateFmMode(index)
    return
  }

  isPrivateFmMode.value = true
  privateFmQueue.unshift(musicInfo)
  await syncPrivateFmTempList()
  clearPlayedList()
  playMusicByInfo(musicInfo, {
    listId: LIST_IDS.TEMP,
    isTempPlay: false,
  })
}

export const exitPrivateFmMode = () => {
  if (!isPrivateFmMode.value) return
  isPrivateFmMode.value = false
  void refreshPrivateFmQueue().catch(err => {
    console.warn('Refresh private FM queue after exit failed:', err)
  })
}

export const syncPrivateFmModeWithPlayer = () => {
  if (isPrivateFmMode.value && playInfo.playerListId != LIST_IDS.TEMP) {
    exitPrivateFmMode()
    return
  }

  if (isPrivateFmMode.value && tempListMeta.id != PRIVATE_FM_TEMP_LIST_ID) {
    exitPrivateFmMode()
  }
}

const restorePrivateFmQueueFromTempList = () => {
  if (tempListMeta.id != PRIVATE_FM_TEMP_LIST_ID) return
  const tempList = getListMusicsFromCache(LIST_IDS.TEMP) as LX.Music.MusicInfoOnline[]
  if (!tempList.length) return
  privateFmQueue.splice(0, privateFmQueue.length, ...tempList)
}

export const ensurePrivateFmNextSongs = async() => {
  if (!isPrivateFmMode.value) return
  if (tempListMeta.id != PRIVATE_FM_TEMP_LIST_ID) return
  const currentId = playMusicInfo.musicInfo?.id
  let currentIndex = currentId ? privateFmQueue.findIndex(song => song.id == currentId) : -1
  if (currentIndex < 0) {
    restorePrivateFmQueueFromTempList()
    currentIndex = currentId ? privateFmQueue.findIndex(song => song.id == currentId) : -1
  }
  if (currentIndex < 0 || privateFmQueue.length - currentIndex > MIN_QUEUE_REMAINING) return

  const nextSongs = await appendPrivateFmQueue()
  if (!nextSongs.length || !isPrivateFmMode.value || tempListMeta.id != PRIVATE_FM_TEMP_LIST_ID) return
  await syncPrivateFmTempList()
}

export {
  currentPrivateFmMode,
}
