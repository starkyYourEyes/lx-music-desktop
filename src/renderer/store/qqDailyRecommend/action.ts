import { LIST_IDS } from '@common/constants'
import { markRawList, toRaw } from '@common/utils/vueTools'
import { playList, playNext } from '@renderer/core/player'
import { getListMusicsFromCache, setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { clearPlayedList } from '@renderer/store/player/action'
import { playInfo, playMusicInfo } from '@renderer/store/player/state'
import { getQQMusicAccountKey } from '@renderer/store/qqMusic'
import { dislikeQQMusic, getQQMusicDailyRecommendSongs } from '@renderer/utils/ipc'
import { assertRecommendationEnabled, isRecommendationEnabled, registerRecommendationCleanup } from '@renderer/core/features/recommendationAccess'
import {
  QQ_DAILY_RECOMMEND_LIST_ID,
  QQ_DAILY_RECOMMEND_TEMP_LIST_ID,
  isLoadingQQDailyRecommend,
  qqDailyRecommendGeneration,
  qqDailyRecommendOwnerAccountKey,
  qqDailyRecommendSongs,
} from './state'

interface DailyRecommendRequest {
  accountKey: string
  generation: number
  task: Promise<LX.Music.MusicInfo_tx[]>
}

interface TempListInstall {
  id: string
  list: LX.Music.MusicInfoOnline[]
  revision: number
}

export interface QQDailyRecommendFeedbackSnapshot {
  accountKey: string
  generation: number
  musicId: string
}

let request: DailyRecommendRequest | null = null
let playbackGeneration: number | null = null
let tempListInstallRevision = 0
let feedbackInstallQueue = Promise.resolve()
const dislikeRequests = new Map<string, Promise<boolean>>()

const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))

const isOnlineMusicInfo = (musicInfo: LX.Music.MusicInfo): musicInfo is LX.Music.MusicInfoOnline => {
  return musicInfo.source != 'local' && musicInfo.source != 'webdav'
}

const isCurrentSnapshot = (accountKey: string, generation: number) => {
  return qqDailyRecommendOwnerAccountKey.value == accountKey &&
    qqDailyRecommendGeneration.value == generation
}

const getCurrentMusicInfo = () => {
  const current = playMusicInfo.musicInfo
  if (!current) return null
  return 'progress' in current ? current.metadata.musicInfo : current
}

const getFeedbackKey = (snapshot: QQDailyRecommendFeedbackSnapshot) => {
  return `${snapshot.accountKey}:${snapshot.generation}:${snapshot.musicId}`
}

const isCurrentFeedbackSnapshot = (snapshot: QQDailyRecommendFeedbackSnapshot) => {
  return snapshot.accountKey == getQQMusicAccountKey() &&
    snapshot.accountKey == qqDailyRecommendOwnerAccountKey.value &&
    snapshot.generation == qqDailyRecommendGeneration.value &&
    isQQDailyRecommendListActive(snapshot.accountKey) &&
    getCurrentMusicInfo()?.id == snapshot.musicId
}

const beginAccountSession = (accountKey: string) => {
  if (qqDailyRecommendOwnerAccountKey.value == accountKey) return
  resetQQDailyRecommend()
  qqDailyRecommendOwnerAccountKey.value = accountKey
}

export const resetQQDailyRecommend = () => {
  qqDailyRecommendGeneration.value++
  qqDailyRecommendOwnerAccountKey.value = null
  qqDailyRecommendSongs.splice(0, qqDailyRecommendSongs.length)
  isLoadingQQDailyRecommend.value = false
  request = null
  playbackGeneration = null
}

export const prepareQQDailyRecommend = async(accountKey: string, force = false) => {
  if (!isRecommendationEnabled('qqRecommend')) return isQQDailyRecommendListActive(accountKey) ? qqDailyRecommendSongs : []
  beginAccountSession(accountKey)
  if (!force && qqDailyRecommendSongs.length) return qqDailyRecommendSongs

  if (!force && request?.accountKey == accountKey &&
    request.generation == qqDailyRecommendGeneration.value) return request.task

  if (force) {
    qqDailyRecommendGeneration.value++
    request = null
    playbackGeneration = null
  }

  const generation = qqDailyRecommendGeneration.value
  isLoadingQQDailyRecommend.value = true
  const task = getQQMusicDailyRecommendSongs()
    .then(songs => {
      if (!isRecommendationEnabled('qqRecommend') || !isCurrentSnapshot(accountKey, generation)) return []
      qqDailyRecommendSongs.splice(0, qqDailyRecommendSongs.length, ...markRawList(songs))
      return songs
    })
    .finally(() => {
      if (request?.task == task) request = null
      if (isCurrentSnapshot(accountKey, generation)) isLoadingQQDailyRecommend.value = false
    })
  request = { accountKey, generation, task }
  return task
}

const restorePreviousTempList = async(previousTempList: TempListInstall | undefined) => {
  if (!previousTempList ||
    previousTempList.revision != tempListInstallRevision ||
    tempListMeta.id != QQ_DAILY_RECOMMEND_TEMP_LIST_ID) return
  try {
    await setTempList(previousTempList.id, previousTempList.list)
  } catch {
    // Preserve the original Daily 30 installation error.
  }
}

const beginTempListInstall = () => {
  const currentTempList = getListMusicsFromCache(LIST_IDS.TEMP)
  if (!currentTempList.every(isOnlineMusicInfo)) {
    throw new Error('Temporary playlist contains unsupported music entries')
  }
  return {
    id: tempListMeta.id,
    list: toCloneable(currentTempList),
    revision: ++tempListInstallRevision,
  }
}

const runFeedbackInstall = async<T>(handler: () => Promise<T>) => {
  const previousInstall = feedbackInstallQueue
  let releaseInstall: () => void = () => {}
  feedbackInstallQueue = new Promise<void>(resolve => {
    releaseInstall = resolve
  })
  await previousInstall
  try {
    return await handler()
  } finally {
    releaseInstall()
  }
}

export const syncQQDailyRecommendTempList = async() => {
  if (!qqDailyRecommendSongs.length) return
  const previousTempList = beginTempListInstall()
  try {
    await setTempList(QQ_DAILY_RECOMMEND_TEMP_LIST_ID, toCloneable(qqDailyRecommendSongs))
  } catch (error) {
    await restorePreviousTempList(previousTempList)
    throw error
  }
  return previousTempList
}

export const isQQDailyRecommendListActive = (accountKey: string | null) => {
  return accountKey != null &&
    accountKey == qqDailyRecommendOwnerAccountKey.value &&
    playbackGeneration == qqDailyRecommendGeneration.value &&
    playInfo.playerListId == LIST_IDS.TEMP &&
    tempListMeta.id == QQ_DAILY_RECOMMEND_TEMP_LIST_ID
}

export const getQQDailyRecommendFeedbackSnapshot = (
  musicInfo: LX.Music.MusicInfo,
  accountKey = getQQMusicAccountKey(),
): QQDailyRecommendFeedbackSnapshot | null => {
  if (!accountKey || musicInfo.source != 'tx' ||
    !isQQDailyRecommendListActive(accountKey) ||
    getCurrentMusicInfo()?.id != musicInfo.id) return null
  return {
    accountKey,
    generation: qqDailyRecommendGeneration.value,
    musicId: musicInfo.id,
  }
}

export const dislikeQQDailyRecommendMusic = (
  musicInfo: LX.Music.MusicInfo_tx,
  snapshot: QQDailyRecommendFeedbackSnapshot,
  // eslint-disable-next-line @typescript-eslint/promise-function-async -- Duplicate callers must receive the same promise instance.
): Promise<boolean> => {
  const key = getFeedbackKey(snapshot)
  const existing = dislikeRequests.get(key)
  if (existing) return existing

  const run = async() => {
    if (!isCurrentFeedbackSnapshot(snapshot)) return false
    await dislikeQQMusic(toCloneable(musicInfo))
    if (!isCurrentFeedbackSnapshot(snapshot)) return false
    return runFeedbackInstall(async() => {
      if (!isCurrentFeedbackSnapshot(snapshot)) return false
      const removedIndex = qqDailyRecommendSongs.findIndex(item => item.id == snapshot.musicId)
      if (removedIndex < 0) return false
      const originalSongs = [...qqDailyRecommendSongs]
      const remainingSongs = originalSongs.filter(item => item.id != snapshot.musicId)
      const previousTempList = beginTempListInstall()
      try {
        await setTempList(
          QQ_DAILY_RECOMMEND_TEMP_LIST_ID,
          toCloneable(remainingSongs),
        )
      } catch (error) {
        await restorePreviousTempList(previousTempList)
        throw error
      }

      if (previousTempList.revision != tempListInstallRevision ||
        tempListMeta.id != QQ_DAILY_RECOMMEND_TEMP_LIST_ID) return false
      if (!isCurrentFeedbackSnapshot(snapshot)) {
        await restorePreviousTempList(previousTempList)
        return false
      }
      qqDailyRecommendSongs.splice(
        0,
        qqDailyRecommendSongs.length,
        ...markRawList(remainingSongs),
      )
      clearPlayedList()
      if (remainingSongs.length) {
        playList(LIST_IDS.TEMP, removedIndex % remainingSongs.length, { automatic: true, reason: 'dislike', startReason: 'auto' })
      } else {
        await playNext({ automatic: true, reason: 'dislike', startReason: 'auto' })
      }
      return true
    })
  }

  let task: Promise<boolean>
  task = run().finally(() => {
    if (dislikeRequests.get(key) == task) dislikeRequests.delete(key)
  })
  dislikeRequests.set(key, task)
  return task
}

export const playQQDailyRecommend = async(accountKey: string, startIndex = 0) => {
  assertRecommendationEnabled('qqRecommend')
  beginAccountSession(accountKey)
  const generation = qqDailyRecommendGeneration.value
  if (!qqDailyRecommendSongs.length) {
    await prepareQQDailyRecommend(accountKey)
  } else if (request?.accountKey == accountKey && request.generation == generation) {
    await request.task
  }
  if (!isRecommendationEnabled('qqRecommend') || !isCurrentSnapshot(accountKey, generation)) return
  if (!qqDailyRecommendSongs.length) throw new Error('QQ Daily 30 has no songs')

  const previousTempList = await syncQQDailyRecommendTempList()
  if (!isRecommendationEnabled('qqRecommend') || !isCurrentSnapshot(accountKey, generation)) {
    await restorePreviousTempList(previousTempList)
    return
  }

  playbackGeneration = generation
  clearPlayedList()
  const index = Math.max(0, Math.min(startIndex, qqDailyRecommendSongs.length - 1))
  playList(LIST_IDS.TEMP, index)
}

export const getQQDailyRecommendPlaylistDetail = async(
  forceRefresh = false,
  accountKey = qqDailyRecommendOwnerAccountKey.value,
): Promise<LX.Netease.PlaylistDetailInfo> => {
  const songs = accountKey ? await prepareQQDailyRecommend(accountKey, forceRefresh) : []
  const firstSong = songs[0]
  return {
    list: [...songs],
    source: 'tx',
    desc: firstSong ? '根据你的听歌偏好生成，每天更新' : null,
    total: songs.length,
    page: 1,
    limit: Math.max(songs.length, 1),
    key: null,
    id: QQ_DAILY_RECOMMEND_LIST_ID,
    info: {
      name: '每日30首',
      img: firstSong?.meta.picUrl ?? '',
      desc: firstSong ? `${firstSong.name} · ${firstSong.singer}` : null,
      author: firstSong?.singer ?? '',
      play_count: '',
    },
    noItemLabel: songs.length ? '' : '暂无每日30首推荐',
  } as unknown as LX.Netease.PlaylistDetailInfo
}

registerRecommendationCleanup('qqRecommend', () => {
  if (!isQQDailyRecommendListActive(qqDailyRecommendOwnerAccountKey.value)) resetQQDailyRecommend()
})
