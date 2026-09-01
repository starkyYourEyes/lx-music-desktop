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

export interface ListeningWeekDay {
  localDay: string
  playedMs: number
}

export interface ListeningWeekRow {
  key: string
  label: string
  duration: string
  width: number
}

export interface ListeningPlayCountTrack {
  source: string
  sourceTrackId: string
  playCount: number
}

export type RankedListeningTrack<T extends ListeningPlayCountTrack> = T & {
  key: string
  rank: number
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

  nextStats.totalSeconds = Math.max(0, Number(stats.totalSeconds) || 0)
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
  const safeSeconds = Math.max(0, seconds)
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

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

export const buildListeningWeekRows = (
  daily: readonly ListeningWeekDay[],
  now = new Date(),
): ListeningWeekRow[] => {
  const durations = new Map<string, number>()
  for (const entry of daily) {
    const playedMs = Number.isFinite(entry.playedMs) ? Math.max(0, entry.playedMs) : 0
    durations.set(entry.localDay, (durations.get(entry.localDay) ?? 0) + playedMs)
  }
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12)
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (6 - index))
    return date
  })
  const maximum = Math.max(0, ...dates.map(date => durations.get(getLocalDateKey(date)) ?? 0))
  return dates.map((date, index) => {
    const key = getLocalDateKey(date)
    const playedMs = durations.get(key) ?? 0
    const dateLabel = `${date.getMonth() + 1}/${date.getDate()}`
    return {
      key,
      label: `${index == 6 ? '今天' : WEEKDAY_LABELS[date.getDay()]} ${dateLabel}`,
      duration: formatListeningTime(playedMs / 1000),
      width: maximum == 0 ? 0 : playedMs / maximum * 100,
    }
  })
}

const trackIdentity = (track: ListeningPlayCountTrack): string =>
  JSON.stringify([track.source, track.sourceTrackId])

const identityHash = (identity: string): number => {
  let hash = 2166136261
  for (let index = 0; index < identity.length; index++) {
    hash ^= identity.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

export const rankTracksByPlayCount = <T extends ListeningPlayCountTrack>(
  tracks: readonly T[],
  limit = 100,
): Array<RankedListeningTrack<T>> => {
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(100, Math.max(0, Math.floor(limit)))
    : 0
  return tracks
    .filter(track => track.playCount > 0)
    .map(track => ({ track, identity: trackIdentity(track) }))
    .sort((a, b) => {
      const countOrder = b.track.playCount - a.track.playCount
      if (countOrder != 0) return countOrder
      const hashOrder = identityHash(a.identity) - identityHash(b.identity)
      if (hashOrder != 0) return hashOrder
      return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0
    })
    .slice(0, boundedLimit)
    .map(({ track, identity }, index) => ({
      ...track,
      key: identity,
      rank: index + 1,
    }))
}
