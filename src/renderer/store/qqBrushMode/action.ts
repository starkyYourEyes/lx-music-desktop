import { LIST_IDS } from '@common/constants'
import { markRawList, toRaw } from '@common/utils/vueTools'
import { playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { clearPlayedList } from '@renderer/store/player/action'
import { playInfo, playMusicInfo } from '@renderer/store/player/state'
import { getQQMusicBrushSongs } from '@renderer/utils/ipc'
import { QQ_BRUSH_MODE_TEMP_LIST_ID } from '@renderer/views/Recommend/constants'
import { assertRecommendationEnabled, beginRecommendationSession, endRecommendationSession, hasRecommendationSession, isRecommendationEnabled, registerRecommendationCleanup } from '@renderer/core/features/recommendationAccess'
import {
  isLoadingQQBrushMode,
  isQQBrushMode,
  qqBrushModeGeneration,
  qqBrushModeOwnerAccountKey,
  qqBrushModeQueue,
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
  return qqBrushModeOwnerAccountKey.value == accountKey &&
    qqBrushModeGeneration.value == generation
}

const isActiveSnapshot = (accountKey: string, generation: number) => {
  return isCurrentSnapshot(accountKey, generation) &&
    isQQBrushMode.value &&
    playInfo.playerListId == LIST_IDS.TEMP &&
    tempListMeta.id == QQ_BRUSH_MODE_TEMP_LIST_ID
}

const getMusicId = (musicInfo: LX.Player.PlayMusicInfo['musicInfo'] | null) => {
  if (!musicInfo) return null
  return 'progress' in musicInfo ? musicInfo.metadata.musicInfo.id : musicInfo.id
}

export const resetQQBrushModeQueue = () => {
  endRecommendationSession('qqBrush')
  qqBrushModeGeneration.value++
  isQQBrushMode.value = false
  qqBrushModeOwnerAccountKey.value = null
  qqBrushModeQueue.splice(0, qqBrushModeQueue.length)
  isLoadingQQBrushMode.value = false
  request = null
}

const beginSourceSession = (accountKey: string) => {
  if (qqBrushModeOwnerAccountKey.value == accountKey) return
  resetQQBrushModeQueue()
  qqBrushModeOwnerAccountKey.value = accountKey
}

export const prepareQQBrushModeQueue = async(accountKey: string, force = false) => {
  if (!isRecommendationEnabled('qqRecommend')) return isQQBrushMode.value ? qqBrushModeQueue : []
  beginSourceSession(accountKey)
  if (qqBrushModeQueue.length && (!force || isQQBrushMode.value)) return qqBrushModeQueue

  const generation = qqBrushModeGeneration.value
  if (request?.accountKey == accountKey &&
    request.generation == generation &&
    !request.continuation) return request.task

  isLoadingQQBrushMode.value = true
  const task = getQQMusicBrushSongs(false)
    .then(songs => {
      if (!isRecommendationEnabled('qqRecommend') || !isCurrentSnapshot(accountKey, generation)) return []
      qqBrushModeQueue.splice(0, qqBrushModeQueue.length, ...markRawList(songs))
      return songs
    })
    .finally(() => {
      if (request?.task == task) request = null
      if (isCurrentSnapshot(accountKey, generation)) isLoadingQQBrushMode.value = false
    })
  request = { accountKey, generation, continuation: false, task }
  return task
}

export const syncQQBrushModeTempList = async() => {
  if (!qqBrushModeQueue.length) return
  await setTempList(QQ_BRUSH_MODE_TEMP_LIST_ID, toCloneable(qqBrushModeQueue))
}

export const enterQQBrushMode = async(accountKey: string) => {
  assertRecommendationEnabled('qqRecommend')
  beginSourceSession(accountKey)
  if (!qqBrushModeQueue.length) await prepareQQBrushModeQueue(accountKey)
  if (!qqBrushModeQueue.length) throw new Error('QQ Brush Mode has no songs')

  const generation = ++qqBrushModeGeneration.value
  request = null
  const wasActive = isQQBrushMode.value
  await beginRecommendationSession('qqBrush')
  if (!isCurrentSnapshot(accountKey, generation)) return
  isQQBrushMode.value = true
  try {
    await syncQQBrushModeTempList()
  } catch (error) {
    if (!wasActive && isCurrentSnapshot(accountKey, generation)) resetQQBrushModeQueue()
    throw error
  }
  if (!isCurrentSnapshot(accountKey, generation)) return

  clearPlayedList()
  playList(LIST_IDS.TEMP, 0)
}

const exitQQBrushMode = () => {
  if (!isQQBrushMode.value) return
  isQQBrushMode.value = false
  endRecommendationSession('qqBrush')
  qqBrushModeGeneration.value++
  request = null
  if (!isRecommendationEnabled('qqRecommend')) resetQQBrushModeQueue()
}

export const syncQQBrushModeWithPlayer = (accountKey: string | null) => {
  if (!isQQBrushMode.value) return
  if (accountKey != qqBrushModeOwnerAccountKey.value ||
    playInfo.playerListId != LIST_IDS.TEMP ||
    tempListMeta.id != QQ_BRUSH_MODE_TEMP_LIST_ID) {
    exitQQBrushMode()
  }
}

export const isQQBrushModeListActive = (accountKey: string | null) => {
  return accountKey != null &&
    accountKey == qqBrushModeOwnerAccountKey.value &&
    isQQBrushMode.value &&
    playInfo.playerListId == LIST_IDS.TEMP &&
    tempListMeta.id == QQ_BRUSH_MODE_TEMP_LIST_ID
}

// Keep this non-async so concurrent guards receive the same in-flight promise.
/* eslint-disable @typescript-eslint/promise-function-async */
export const ensureQQBrushModeNextSongs = (
  accountKey: string | null,
): Promise<LX.Music.MusicInfo_tx[]> => {
  syncQQBrushModeWithPlayer(accountKey)
  if (!accountKey) return Promise.resolve([])
  beginSourceSession(accountKey)
  if (!isQQBrushMode.value) return Promise.resolve([])

  const currentId = getMusicId(playMusicInfo.musicInfo)
  const currentIndex = qqBrushModeQueue.findIndex(song => song.id == currentId)
  const remaining = qqBrushModeQueue.length - currentIndex - 1
  if (currentIndex < 0 || remaining > MIN_QUEUE_REMAINING) return Promise.resolve([])

  const generation = qqBrushModeGeneration.value
  if (request?.accountKey == accountKey &&
    request.generation == generation &&
    request.continuation) return request.task

  const task = (hasRecommendationSession('qqBrush')
    ? getQQMusicBrushSongs(true)
    : beginRecommendationSession('qqBrush').then(async() => getQQMusicBrushSongs(true)))
    .then(async songs => {
      if (!isActiveSnapshot(accountKey, generation)) return []
      const ids = new Set(qqBrushModeQueue.map(song => song.id))
      const nextSongs = markRawList(songs.filter(song => !ids.has(song.id)))
      if (!nextSongs.length) return []
      qqBrushModeQueue.push(...nextSongs)
      await syncQQBrushModeTempList()
      return nextSongs
    })
    .finally(() => {
      if (request?.task == task) request = null
    })
  request = { accountKey, generation, continuation: true, task }
  return task
}
/* eslint-enable @typescript-eslint/promise-function-async */

registerRecommendationCleanup('qqRecommend', () => {
  if (!isQQBrushMode.value) resetQQBrushModeQueue()
})
