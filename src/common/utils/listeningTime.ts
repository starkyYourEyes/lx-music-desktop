export interface ListeningTimeSong {
  id: string
  name: string
  singer: string
  source?: string
}

export interface ListeningTimeSongStat extends ListeningTimeSong {
  seconds: number
}

export interface ListeningTimeStats {
  totalSeconds: number
  daily: Record<string, number>
  songs: Record<string, ListeningTimeSongStat>
  updatedAt: number
}

export const createDefaultListeningTimeStats = (): ListeningTimeStats => ({
  totalSeconds: 0,
  daily: {},
  songs: {},
  updatedAt: Date.now(),
})

export const getLocalDateKey = (date = new Date()): string => {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export const normalizeListeningTimeStats = (stats?: Partial<ListeningTimeStats> | null): ListeningTimeStats => {
  const nextStats = createDefaultListeningTimeStats()
  if (!stats) return nextStats

  nextStats.totalSeconds = Math.max(0, Math.floor(Number(stats.totalSeconds) || 0))
  nextStats.daily = { ...(stats.daily ?? {}) }
  nextStats.songs = { ...(stats.songs ?? {}) }
  nextStats.updatedAt = Number(stats.updatedAt) || Date.now()

  return nextStats
}

export const addListeningTime = (
  stats: ListeningTimeStats,
  seconds: number,
  song: ListeningTimeSong | null,
  date = new Date(),
): ListeningTimeStats => {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  if (!safeSeconds) return stats

  const dayKey = getLocalDateKey(date)
  stats.totalSeconds += safeSeconds
  stats.daily[dayKey] = (stats.daily[dayKey] ?? 0) + safeSeconds
  stats.updatedAt = Date.now()

  if (song?.id) {
    const songKey = `${song.source ?? 'unknown'}:${song.id}`
    const songStat = stats.songs[songKey] ?? {
      id: song.id,
      name: song.name,
      singer: song.singer,
      source: song.source,
      seconds: 0,
    }
    songStat.name = song.name
    songStat.singer = song.singer
    songStat.source = song.source
    songStat.seconds += safeSeconds
    stats.songs[songKey] = songStat
  }

  return stats
}

export const formatListeningTime = (seconds: number): string => {
  const safeSeconds = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(safeSeconds / 3600)
  const minutes = Math.floor((safeSeconds % 3600) / 60)
  const restSeconds = safeSeconds % 60

  if (hours) return `${hours}小时${minutes}分钟`
  if (minutes) return `${minutes}分钟${restSeconds}秒`
  return `${restSeconds}秒`
}
