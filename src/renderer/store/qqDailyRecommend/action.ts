import { LIST_IDS } from '@common/constants'
import { markRawList, toRaw } from '@common/utils/vueTools'
import { playList } from '@renderer/core/player'
import { getListMusicsFromCache, setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { clearPlayedList } from '@renderer/store/player/action'
import { playInfo } from '@renderer/store/player/state'
import { getQQMusicDailyRecommendSongs } from '@renderer/utils/ipc'
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

let request: DailyRecommendRequest | null = null
let playbackGeneration: number | null = null
let tempListInstallRevision = 0

const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))

const isOnlineMusicInfo = (musicInfo: LX.Music.MusicInfo): musicInfo is LX.Music.MusicInfoOnline => {
  return musicInfo.source != 'local' && musicInfo.source != 'webdav'
}

const isCurrentSnapshot = (accountKey: string, generation: number) => {
  return qqDailyRecommendOwnerAccountKey.value == accountKey &&
    qqDailyRecommendGeneration.value == generation
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
      if (!isCurrentSnapshot(accountKey, generation)) return []
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

export const syncQQDailyRecommendTempList = async() => {
  if (!qqDailyRecommendSongs.length) return
  const currentTempList = getListMusicsFromCache(LIST_IDS.TEMP)
  if (!currentTempList.every(isOnlineMusicInfo)) {
    throw new Error('Temporary playlist contains unsupported music entries')
  }
  const previousTempList: TempListInstall = {
    id: tempListMeta.id,
    list: toCloneable(currentTempList),
    revision: ++tempListInstallRevision,
  }
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

export const playQQDailyRecommend = async(accountKey: string, startIndex = 0) => {
  beginAccountSession(accountKey)
  const generation = qqDailyRecommendGeneration.value
  if (!qqDailyRecommendSongs.length) {
    await prepareQQDailyRecommend(accountKey)
  } else if (request?.accountKey == accountKey && request.generation == generation) {
    await request.task
  }
  if (!isCurrentSnapshot(accountKey, generation)) return
  if (!qqDailyRecommendSongs.length) throw new Error('QQ Daily 30 has no songs')

  const previousTempList = await syncQQDailyRecommendTempList()
  if (!isCurrentSnapshot(accountKey, generation)) {
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
