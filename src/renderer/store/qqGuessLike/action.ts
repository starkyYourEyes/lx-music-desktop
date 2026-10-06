import { LIST_IDS } from '@common/constants'
import { markRawList, toRaw } from '@common/utils/vueTools'
import { playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { clearPlayedList } from '@renderer/store/player/action'
import { playInfo, playMusicInfo } from '@renderer/store/player/state'
import { appSetting } from '@renderer/store/setting'
import { getQQMusicGuessLikeSongs } from '@renderer/utils/ipc'
import { QQ_GUESS_LIKE_TEMP_LIST_ID } from '@renderer/views/Recommend/constants'
import { assertRecommendationEnabled, beginRecommendationSession, endRecommendationSession, hasRecommendationSession, isRecommendationEnabled, registerRecommendationCleanup } from '@renderer/core/features/recommendationAccess'
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
  apiVersion: LX.QQMusic.GuessLikeApiVersion
  generation: number
  continuation: boolean
  task: Promise<LX.Music.MusicInfo_tx[]>
}

let request: QueueRequest | null = null
let queueApiVersion: LX.QQMusic.GuessLikeApiVersion | null = null

const getApiVersion = () => appSetting['recommend.qqGuessLikeApiVersion']

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
  endRecommendationSession('qqGuessLike')
  qqGuessLikeGeneration.value++
  isQQGuessLikeMode.value = false
  qqGuessLikeOwnerAccountKey.value = null
  qqGuessLikeQueue.splice(0, qqGuessLikeQueue.length)
  isLoadingQQGuessLike.value = false
  request = null
  queueApiVersion = null
}

const beginSourceSession = (accountKey: string, apiVersion: LX.QQMusic.GuessLikeApiVersion) => {
  if (qqGuessLikeOwnerAccountKey.value == accountKey && queueApiVersion == apiVersion) return
  resetQQGuessLikeQueue()
  qqGuessLikeOwnerAccountKey.value = accountKey
  queueApiVersion = apiVersion
}

export const prepareQQGuessLikeQueue = async(accountKey: string, force = false) => {
  if (!isRecommendationEnabled('qqRecommend')) return isQQGuessLikeMode.value ? qqGuessLikeQueue : []
  const apiVersion = getApiVersion()
  beginSourceSession(accountKey, apiVersion)
  if (qqGuessLikeQueue.length && (!force || isQQGuessLikeMode.value)) return qqGuessLikeQueue

  const generation = qqGuessLikeGeneration.value
  if (request?.accountKey == accountKey &&
    request.apiVersion == apiVersion &&
    request.generation == generation &&
    !request.continuation) return request.task

  isLoadingQQGuessLike.value = true
  const task = getQQMusicGuessLikeSongs(false, apiVersion)
    .then(songs => {
      if (!isRecommendationEnabled('qqRecommend') || !isCurrentSnapshot(accountKey, generation)) return []
      qqGuessLikeQueue.splice(0, qqGuessLikeQueue.length, ...markRawList(songs))
      return songs
    })
    .finally(() => {
      if (request?.task == task) request = null
      if (isCurrentSnapshot(accountKey, generation)) isLoadingQQGuessLike.value = false
    })
  request = { accountKey, apiVersion, generation, continuation: false, task }
  return task
}

export const syncQQGuessLikeTempList = async() => {
  if (!qqGuessLikeQueue.length) return
  await setTempList(QQ_GUESS_LIKE_TEMP_LIST_ID, toCloneable(qqGuessLikeQueue))
}

export const enterQQGuessLikeMode = async(accountKey: string) => {
  assertRecommendationEnabled('qqRecommend')
  beginSourceSession(accountKey, getApiVersion())
  if (!qqGuessLikeQueue.length) await prepareQQGuessLikeQueue(accountKey)
  if (!qqGuessLikeQueue.length) throw new Error('QQ Guess You Like has no songs')

  const generation = ++qqGuessLikeGeneration.value
  request = null
  const wasActive = isQQGuessLikeMode.value
  await beginRecommendationSession('qqGuessLike')
  if (!isCurrentSnapshot(accountKey, generation)) return
  isQQGuessLikeMode.value = true
  try {
    await syncQQGuessLikeTempList()
  } catch (error) {
    if (!wasActive && isCurrentSnapshot(accountKey, generation)) resetQQGuessLikeQueue()
    throw error
  }
  if (!isCurrentSnapshot(accountKey, generation)) return

  clearPlayedList()
  playList(LIST_IDS.TEMP, 0)
}

const exitQQGuessLikeMode = () => {
  if (!isQQGuessLikeMode.value) return
  isQQGuessLikeMode.value = false
  endRecommendationSession('qqGuessLike')
  qqGuessLikeGeneration.value++
  request = null
  if (!isRecommendationEnabled('qqRecommend')) resetQQGuessLikeQueue()
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
    queueApiVersion == getApiVersion() &&
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
  if (!accountKey) return Promise.resolve([])
  const apiVersion = getApiVersion()
  beginSourceSession(accountKey, apiVersion)
  if (!isQQGuessLikeMode.value) return Promise.resolve([])

  const currentId = getMusicId(playMusicInfo.musicInfo)
  const currentIndex = qqGuessLikeQueue.findIndex(song => song.id == currentId)
  const remaining = qqGuessLikeQueue.length - currentIndex - 1
  if (currentIndex < 0 || remaining > MIN_QUEUE_REMAINING) return Promise.resolve([])

  const generation = qqGuessLikeGeneration.value
  if (request?.accountKey == accountKey &&
    request.apiVersion == apiVersion &&
    request.generation == generation &&
    request.continuation) return request.task

  const task = (hasRecommendationSession('qqGuessLike')
    ? getQQMusicGuessLikeSongs(true, apiVersion)
    : beginRecommendationSession('qqGuessLike').then(async() => getQQMusicGuessLikeSongs(true, apiVersion)))
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
  request = { accountKey, apiVersion, generation, continuation: true, task }
  return task
}
/* eslint-enable @typescript-eslint/promise-function-async */

registerRecommendationCleanup('qqRecommend', () => {
  if (!isQQGuessLikeMode.value) resetQQGuessLikeQueue()
})
