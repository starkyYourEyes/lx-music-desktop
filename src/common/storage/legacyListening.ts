export interface LegacyListeningImportV1 {
  totalPlayedMs: number
  daily: Array<{ localDay: string, baselinePlayedMs: number }>
  tracks: Array<{
    source: string
    sourceTrackId: string
    name: string
    singer: string
    baselinePlayedMs: number
  }>
  mismatch: { totalVsDailyMs: number, totalVsTracksMs: number }
  baselineActiveTimeKnown: false
}

const maxTrackStringLength = 256

const secondsToMs = (seconds: unknown): number => {
  const numericSeconds = Number(seconds)
  if (!Number.isFinite(numericSeconds) || numericSeconds <= 0) return 0
  const roundedMilliseconds = Math.round(numericSeconds * 1000)
  if (!Number.isFinite(roundedMilliseconds) || roundedMilliseconds > Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER
  return roundedMilliseconds
}

const asRecord = (value: unknown): Record<string, unknown> | null => (
  value != null && typeof value == 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
)

const isCalendarDay = (value: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match == null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const isLeapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
  const daysInMonth = [31, isLeapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1]
}

const isTrackString = (value: unknown): value is string => (
  typeof value == 'string' && value.length > 0 && value.length <= maxTrackStringLength
)

const calculateSaturatedMismatch = (
  totalPlayedMs: number,
  entries: ReadonlyArray<{ baselinePlayedMs: number }>,
): number => {
  const maxSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
  let mismatch = BigInt(totalPlayedMs)
  for (const entry of entries) {
    mismatch -= BigInt(entry.baselinePlayedMs)
    if (mismatch <= -maxSafeInteger) return -Number.MAX_SAFE_INTEGER
  }
  return Number(mismatch)
}

export const convertLegacyListeningStats = (value: unknown): LegacyListeningImportV1 => {
  const stats = asRecord(value) ?? {}
  const totalPlayedMs = secondsToMs(stats.totalSeconds)
  const daily: LegacyListeningImportV1['daily'] = []
  const tracks: LegacyListeningImportV1['tracks'] = []

  const legacyDaily = asRecord(stats.daily)
  if (legacyDaily != null) {
    for (const [localDay, seconds] of Object.entries(legacyDaily)) {
      if (isCalendarDay(localDay)) daily.push({ localDay, baselinePlayedMs: secondsToMs(seconds) })
    }
  }

  const legacyTracks = asRecord(stats.songs)
  if (legacyTracks != null) {
    for (const track of Object.values(legacyTracks)) {
      const legacyTrack = asRecord(track)
      if (legacyTrack == null) continue
      const source = legacyTrack.source ?? 'unknown'
      if (!isTrackString(source) || !isTrackString(legacyTrack.id) ||
        !isTrackString(legacyTrack.name) || !isTrackString(legacyTrack.singer)) continue
      tracks.push({
        source,
        sourceTrackId: legacyTrack.id,
        name: legacyTrack.name,
        singer: legacyTrack.singer,
        baselinePlayedMs: secondsToMs(legacyTrack.seconds),
      })
    }
  }

  return {
    totalPlayedMs,
    daily,
    tracks,
    mismatch: {
      totalVsDailyMs: calculateSaturatedMismatch(totalPlayedMs, daily),
      totalVsTracksMs: calculateSaturatedMismatch(totalPlayedMs, tracks),
    },
    baselineActiveTimeKnown: false,
  }
}
