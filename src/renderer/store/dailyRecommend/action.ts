import { markRawList, toRaw } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { clearPlayedList } from '@renderer/store/player/action'
import { playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { getNeteaseRecommendSongs } from '@renderer/utils/ipc'
import {
  DAILY_RECOMMEND_TEMP_LIST_ID,
  dailyRecommendSongs,
  isLoadingDailyRecommend,
} from './state'

const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))

export const loadDailyRecommendSongs = async(forceRefresh = false) => {
  if (!forceRefresh && dailyRecommendSongs.length) return dailyRecommendSongs

  isLoadingDailyRecommend.value = true
  try {
    const songs = markRawList(await getNeteaseRecommendSongs())
    dailyRecommendSongs.splice(0, dailyRecommendSongs.length, ...songs)
    return dailyRecommendSongs
  } finally {
    isLoadingDailyRecommend.value = false
  }
}

export const getDailyRecommendPlaylistDetail = async(forceRefresh = false): Promise<LX.Netease.PlaylistDetailInfo> => {
  const songs = await loadDailyRecommendSongs(forceRefresh)
  const firstSong = songs[0]
  return {
    list: [...songs],
    source: 'wy',
    desc: firstSong ? '根据你的听歌偏好生成，每天更新' : null,
    total: songs.length,
    page: 1,
    limit: Math.max(songs.length, 1),
    key: null,
    id: DAILY_RECOMMEND_TEMP_LIST_ID,
    info: {
      name: '每日推荐',
      img: firstSong?.meta.picUrl ?? '',
      desc: firstSong ? `从《${firstSong.name}》开始` : null,
      author: firstSong?.singer ?? '',
      play_count: '',
    },
    noItemLabel: songs.length ? '' : '暂无每日推荐歌曲',
  }
}

export const syncDailyRecommendTempList = async() => {
  if (!dailyRecommendSongs.length) await loadDailyRecommendSongs()
  if (!dailyRecommendSongs.length) return
  await setTempList(DAILY_RECOMMEND_TEMP_LIST_ID, toCloneable(dailyRecommendSongs))
}

export const playDailyRecommend = async(startIndex = 0) => {
  if (!dailyRecommendSongs.length) await loadDailyRecommendSongs()
  if (!dailyRecommendSongs.length) throw new Error('每日推荐暂无歌曲')

  await syncDailyRecommendTempList()
  clearPlayedList()
  playList(LIST_IDS.TEMP, Math.min(startIndex, dailyRecommendSongs.length - 1))
}
