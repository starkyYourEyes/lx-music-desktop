import { LIST_IDS } from '@common/constants'
import { markRawList, toRaw } from '@common/utils/vueTools'
import { playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { clearPlayedList } from '@renderer/store/player/action'
import { playInfo, playMusicInfo } from '@renderer/store/player/state'
import { getQQMusicGuessLikeSongs } from '@renderer/utils/ipc'
import { QQ_GUESS_LIKE_TEMP_LIST_ID } from '@renderer/views/Recommend/constants'
import {
  isLoadingQQGuessLike,
  isQQGuessLikeMode,
  qqGuessLikeGeneration,
  qqGuessLikeOwnerAccountKey,
  qqGuessLikeQueue,
} from './state'

const MIN_QUEUE_REMAINING = 2

interface QueueRequest {
  accountKey: string
  generation: number
  continuation: boolean
  task: Promise<LX.Music.MusicInfo_tx[]>
}

let request: QueueRequest | null = null

const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))

const isCurrentSnapshot = (accountKey: string, generation: number) => {
  return qqGuessLikeOwnerAccountKey.value == accountKey &&
    qqGuessLikeGeneration.value == generation
}

const isActiveSnapshot = (accountKey: string, generation: number) => {
  return isCurrentSnapshot(accountKey, generation) &&
    isQQGuessLikeMode.value &&
    playInfo.playerListId == LIST_IDS.TEMP &&
    tempListMeta.id == QQ_GUESS_LIKE_TEMP_LIST_ID
}

const getMusicId = (musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | null) => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo.id : musicInfo.id
}

export const resetQQGuessLikeQueue = () => {
  qqGuessLikeGeneration.value++
  isQQGuessLikeMode.value = false
  qqGuessLikeOwnerAccountKey.value = null
  qqGuessLikeQueue.splice(0, qqGuessLikeQueue.length)
  isLoadingQQGuessLike.value = false
  request = null
}

const beginAccountSession = (accountKey: string) => {
  if (qqGuessLikeOwnerAccountKey.value == accountKey) return
  resetQQGuessLikeQueue()
  qqGuessLikeOwnerAccountKey.value = accountKey
}

export const prepareQQGuessLikeQueue = async(accountKey: string, force = false) => {
  beginAccountSession(accountKey)
  if (qqGuessLikeQueue.length && (!force || isQQGuessLikeMode.value)) return qqGuessLikeQueue

  const generation = qqGuessLikeGeneration.value
  if (request?.accountKey == accountKey &&
    request.generation == generation &&
    !request.continuation) return request.task

  isLoadingQQGuessLike.value = true
  const task = getQQMusicGuessLikeSongs(false)
    .then(songs => {
      if (!isCurrentSnapshot(accountKey, generation)) return []
      qqGuessLikeQueue.splice(0, qqGuessLikeQueue.length, ...markRawList(songs))
      return songs
    })
    .finally(() => {
      if (request?.task == task) request = null
      if (isCurrentSnapshot(accountKey, generation)) isLoadingQQGuessLike.value = false
    })
  request = { accountKey, generation, continuation: false, task }
  return task
}

export const syncQQGuessLikeTempList = async() => {
  if (!qqGuessLikeQueue.length) return
  await setTempList(QQ_GUESS_LIKE_TEMP_LIST_ID, toCloneable(qqGuessLikeQueue))
}

export const enterQQGuessLikeMode = async(accountKey: string) => {
  beginAccountSession(accountKey)
  if (!qqGuessLikeQueue.length) await prepareQQGuessLikeQueue(accountKey)
  if (!qqGuessLikeQueue.length) throw new Error('QQ Guess You Like has no songs')

  const generation = ++qqGuessLikeGeneration.value
  request = null
  await syncQQGuessLikeTempList()
  if (!isCurrentSnapshot(accountKey, generation)) return

  isQQGuessLikeMode.value = true
  clearPlayedList()
  playList(LIST_IDS.TEMP, 0)
}

const exitQQGuessLikeMode = () => {
  if (!isQQGuessLikeMode.value) return
  isQQGuessLikeMode.value = false
  qqGuessLikeGeneration.value++
  request = null
}

export const syncQQGuessLikeModeWithPlayer = (accountKey: string | null) => {
  if (!isQQGuessLikeMode.value) return
  if (accountKey != qqGuessLikeOwnerAccountKey.value ||
    playInfo.playerListId != LIST_IDS.TEMP ||
    tempListMeta.id != QQ_GUESS_LIKE_TEMP_LIST_ID) {
    exitQQGuessLikeMode()
  }
}

export const isQQGuessLikeListActive = (accountKey: string | null) => {
  return accountKey != null &&
    accountKey == qqGuessLikeOwnerAccountKey.value &&
    isQQGuessLikeMode.value &&
    playInfo.playerListId == LIST_IDS.TEMP &&
    tempListMeta.id == QQ_GUESS_LIKE_TEMP_LIST_ID
}

// Keep this non-async so concurrent guards receive the same in-flight promise.
/* eslint-disable @typescript-eslint/promise-function-async */
export const ensureQQGuessLikeNextSongs = (
  accountKey: string | null,
): Promise<LX.Music.MusicInfo_tx[]> => {
  syncQQGuessLikeModeWithPlayer(accountKey)
  if (!accountKey || !isQQGuessLikeMode.value) return Promise.resolve([])

  const currentId = getMusicId(playMusicInfo.musicInfo)
  const currentIndex = qqGuessLikeQueue.findIndex(song => song.id == currentId)
  const remaining = qqGuessLikeQueue.length - currentIndex - 1
  if (currentIndex < 0 || remaining > MIN_QUEUE_REMAINING) return Promise.resolve([])

  const generation = qqGuessLikeGeneration.value
  if (request?.accountKey == accountKey &&
    request.generation == generation &&
    request.continuation) return request.task

  const task = getQQMusicGuessLikeSongs(true)
    .then(async songs => {
      if (!isActiveSnapshot(accountKey, generation)) return []
      const ids = new Set(qqGuessLikeQueue.map(song => song.id))
      const nextSongs = markRawList(songs.filter(song => {
        if (ids.has(song.id)) return false
        ids.add(song.id)
        return true
      }))
      if (!nextSongs.length) return []
      qqGuessLikeQueue.push(...nextSongs)
      await syncQQGuessLikeTempList()
      return nextSongs
    })
    .finally(() => {
      if (request?.task == task) request = null
    })
  request = { accountKey, generation, continuation: true, task }
  return task
}
/* eslint-enable @typescript-eslint/promise-function-async */
