import { throttle } from '@common/utils'
import {
  addListeningTime,
  normalizeListeningTimeStats,
  type ListeningTimeSong,
} from '@common/utils/listeningTime'
import { getListeningTimeStats, saveListeningTimeStats } from '@renderer/utils/ipc'
import { playMusicInfo } from '@renderer/store/player/state'
import { listeningTimeStats } from './state'

const saveListeningTimeStatsThrottle = throttle(() => {
  saveListeningTimeStats(listeningTimeStats)
}, 5000)

const getCurrentSong = (): ListeningTimeSong | null => {
  const currentMusic = playMusicInfo.musicInfo
  if (!currentMusic) return null
  const musicInfo = 'progress' in currentMusic ? currentMusic.metadata.musicInfo : currentMusic

  return {
    id: musicInfo.id,
    name: musicInfo.name,
    singer: musicInfo.singer,
    source: musicInfo.source,
  }
}

export const initListeningTimeStats = async() => {
  const stats = normalizeListeningTimeStats(await getListeningTimeStats())
  listeningTimeStats.totalSeconds = stats.totalSeconds
  listeningTimeStats.updatedAt = stats.updatedAt
  Object.assign(listeningTimeStats.daily, stats.daily)
  Object.assign(listeningTimeStats.songs, stats.songs)
}

export const saveListeningTimeStatsNow = () => {
  saveListeningTimeStats(listeningTimeStats)
}

export const addCurrentListeningTime = (seconds: number) => {
  addListeningTime(listeningTimeStats, seconds, getCurrentSong())
  saveListeningTimeStatsThrottle()
}
