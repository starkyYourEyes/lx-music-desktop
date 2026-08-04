import CryptoJS from 'crypto-js'
import {
  addListeningTime,
  createDefaultListeningTimeStats,
  getLocalDateKey,
  type ListeningTimeStats,
} from '../../../common/utils/listeningTime'

export interface PlaybackComparisonTrack {
  source: string
  sourceTrackId: string
}

export interface PlaybackComparisonDelta {
  playedMs: number
  localDay: string
  track: PlaybackComparisonTrack
}

export interface PlaybackAcceptedComparisonDelta extends PlaybackComparisonDelta {
  occurredAtMs: number
}

export interface PlaybackComparisonDiagnosticV1 {
  version: 1
  playedDifferenceMs: number
  dailyDifferencesMs: number[]
  trackDifferences: Array<{ trackHash: string, playedDifferenceMs: number }>
}

export interface PlaybackComparison {
  recordNewDelta: (delta: PlaybackComparisonDelta) => void
  recordLegacyDelta: (
    delta: Omit<PlaybackComparisonDelta, 'playedMs'> & { seconds: number, occurredAtMs: number },
  ) => void
  recordAcceptedDelta: (delta: PlaybackAcceptedComparisonDelta) => void
  flush: () => PlaybackComparisonDiagnosticV1
}

export interface PlaybackComparisonOptions {
  isEnabled?: () => boolean
  salt?: Uint8Array
  maxEntries?: number
  log?: (diagnostic: PlaybackComparisonDiagnosticV1) => void
}

const DEFAULT_MAX_ENTRIES = 256
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export const playbackComparisonEnabled = (): boolean =>
  process.env.NODE_ENV != 'production' && process.env.LX_STORAGE_COMPARE_PLAYBACK === '1'

const randomSalt = (): Uint8Array => {
  const salt = new Uint8Array(32)
  globalThis.crypto.getRandomValues(salt)
  return salt
}

const bytesToHex = (value: Uint8Array): string =>
  Array.from(value, byte => byte.toString(16).padStart(2, '0')).join('')

const safePlayedMs = (value: unknown, field: string): number => {
  if (typeof value != 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid playback comparison ${field}`)
  }
  return value
}

const safeSeconds = (value: unknown): number => {
  if (typeof value != 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error('Invalid playback comparison seconds')
  }
  return value
}

const safeTrack = (value: PlaybackComparisonTrack): PlaybackComparisonTrack => {
  if (value == null || typeof value != 'object' || Array.isArray(value) ||
    typeof value.source != 'string' || value.source.length == 0 ||
    typeof value.sourceTrackId != 'string' || value.sourceTrackId.length == 0) {
    throw new Error('Invalid playback comparison track')
  }
  return { source: value.source, sourceTrackId: value.sourceTrackId }
}

const safeLocalDay = (value: unknown): string => {
  if (typeof value != 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Invalid playback comparison local day')
  }
  return value
}

const addBounded = (map: Map<string, number>, key: string, value: number, limit: number): void => {
  const next = (map.get(key) ?? 0) + value
  if (!Number.isSafeInteger(next)) throw new Error('Playback comparison overflow')
  if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value!)
  map.set(key, next)
}

const boundRecord = <T>(value: Record<string, T>, limit: number): void => {
  while (Object.keys(value).length > limit) Reflect.deleteProperty(value, Object.keys(value)[0])
}

const emptyDiagnostic = (): PlaybackComparisonDiagnosticV1 => ({
  version: 1,
  playedDifferenceMs: 0,
  dailyDifferencesMs: [],
  trackDifferences: [],
})

export const createPlaybackComparison = (options: PlaybackComparisonOptions = {}): PlaybackComparison => {
  const isEnabled = options.isEnabled ?? playbackComparisonEnabled
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 10_000) {
    throw new Error('Invalid playback comparison entry limit')
  }
  const salt = options.salt == null ? randomSalt() : new Uint8Array(options.salt)
  if (salt.length < 16 || salt.length > 128) throw new Error('Invalid playback comparison salt')
  const saltHex = bytesToHex(salt)
  const log = options.log ?? (diagnostic => { console.debug('playback-comparison', diagnostic) })

  let newTotal = 0
  let legacyShadow: ListeningTimeStats = createDefaultListeningTimeStats()
  const newDays = new Map<string, number>()
  const newTracks = new Map<string, number>()

  const hash = (kind: 'day' | 'track', value: string): string => {
    const result = CryptoJS.SHA256(`${saltHex}/${kind}/${value}`).toString()
    if (!SHA256_PATTERN.test(result)) throw new Error('Playback comparison hash failed')
    return result
  }

  const keys = (delta: Pick<PlaybackComparisonDelta, 'localDay' | 'track'>): { day: string, track: string } => {
    const track = safeTrack(delta.track)
    return {
      day: hash('day', safeLocalDay(delta.localDay)),
      track: hash('track', JSON.stringify([track.source, track.sourceTrackId])),
    }
  }

  const clear = (): void => {
    newTotal = 0
    legacyShadow = createDefaultListeningTimeStats()
    newDays.clear()
    newTracks.clear()
  }

  const recordNewDelta = (delta: PlaybackComparisonDelta): void => {
    if (!isEnabled()) return
    const playedMs = safePlayedMs(delta.playedMs, 'played milliseconds')
    const identity = keys(delta)
    newTotal += playedMs
    if (!Number.isSafeInteger(newTotal)) throw new Error('Playback comparison overflow')
    addBounded(newDays, identity.day, playedMs, maxEntries)
    addBounded(newTracks, identity.track, playedMs, maxEntries)
  }

  const recordLegacyDelta = (
    delta: Omit<PlaybackComparisonDelta, 'playedMs'> & { seconds: number, occurredAtMs: number },
  ): void => {
    if (!isEnabled()) return
    const identity = keys(delta)
    const occurredAtMs = safePlayedMs(delta.occurredAtMs, 'timestamp')
    const occurredAt = new Date(occurredAtMs)
    const legacyDay = getLocalDateKey(occurredAt)
    addListeningTime(legacyShadow, safeSeconds(delta.seconds), {
      source: 'comparison',
      id: identity.track,
      name: '',
      singer: '',
    }, occurredAt)
    legacyShadow.updatedAt = occurredAtMs
    if (!Object.prototype.hasOwnProperty.call(legacyShadow.daily, legacyDay)) {
      throw new Error('Playback comparison legacy day missing')
    }
    boundRecord(legacyShadow.daily, maxEntries)
    boundRecord(legacyShadow.songs, maxEntries)
  }

  const recordAcceptedDelta = (delta: PlaybackAcceptedComparisonDelta): void => {
    if (!isEnabled()) return
    safePlayedMs(delta.occurredAtMs, 'timestamp')
    recordNewDelta(delta)
    recordLegacyDelta({
      seconds: delta.playedMs / 1000,
      occurredAtMs: delta.occurredAtMs,
      localDay: delta.localDay,
      track: delta.track,
    })
  }

  const flush = (): PlaybackComparisonDiagnosticV1 => {
    if (!isEnabled()) {
      clear()
      return emptyDiagnostic()
    }
    const legacyTotal = safePlayedMs(Math.round(legacyShadow.totalSeconds * 1000), 'legacy total milliseconds')
    const legacyDays = new Map(Object.entries(legacyShadow.daily).map(([day, seconds]) => [
      hash('day', safeLocalDay(day)),
      safePlayedMs(Math.round(safeSeconds(seconds) * 1000), 'legacy day milliseconds'),
    ]))
    const legacyTracks = new Map(Object.values(legacyShadow.songs).map(song => {
      if (song.source != 'comparison' || !SHA256_PATTERN.test(song.id)) {
        throw new Error('Playback comparison legacy track invalid')
      }
      return [
        song.id,
        safePlayedMs(Math.round(safeSeconds(song.seconds) * 1000), 'legacy track milliseconds'),
      ]
    }))
    const dailyDifferencesMs = Array.from(new Set([...newDays.keys(), ...legacyDays.keys()]))
      .sort()
      .map(key => (newDays.get(key) ?? 0) - (legacyDays.get(key) ?? 0))
      .filter(value => value != 0)
    const trackDifferences = Array.from(new Set([...newTracks.keys(), ...legacyTracks.keys()]))
      .sort()
      .map(trackHash => ({
        trackHash,
        playedDifferenceMs: (newTracks.get(trackHash) ?? 0) - (legacyTracks.get(trackHash) ?? 0),
      }))
      .filter(value => value.playedDifferenceMs != 0)
    const diagnostic: PlaybackComparisonDiagnosticV1 = {
      version: 1,
      playedDifferenceMs: newTotal - legacyTotal,
      dailyDifferencesMs,
      trackDifferences,
    }
    clear()
    if (diagnostic.playedDifferenceMs != 0 || dailyDifferencesMs.length > 0 || trackDifferences.length > 0) log(diagnostic)
    return diagnostic
  }

  return { recordNewDelta, recordLegacyDelta, recordAcceptedDelta, flush }
}
