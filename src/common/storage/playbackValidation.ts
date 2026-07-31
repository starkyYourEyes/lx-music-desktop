import type {
  ListeningBucketV1,
  ListeningStatsV1,
  PlaybackCheckpointAckV1,
  PlaybackCheckpointV1,
  PlaybackCommitRequestV1,
  PlaybackFactV1,
  PlaybackPreplayFailureV1,
  PlaybackRecorderCommandV1,
  PlaybackResumeAckV1,
  PlaybackResumeUpdateV1,
  PlaybackResumeV1,
  PlaybackStartCommandV1,
  PlaybackStartResultV1,
  PlaybackTrackV1,
  RecentTrackV1,
} from './playback'

const MAX_CONTEXT_LENGTH = 256
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const MAX_EVENT_DETAILS_BYTES = 16 * 1024
const MAX_PLAYABLE_PAYLOAD_BYTES = 128 * 1024
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const MAX_JSON_DEPTH = 64
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type PlaybackStartMode = 'activity' | 'resume-only' | 'private'

const invalidField = (field: string): never => {
  throw new Error(`Invalid ${field}`)
}

const assertRecord = (value: unknown, field: string): asserts value is Record<string, unknown> => {
  try {
    if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalidField(field)
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key != 'string' || descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalidField(field)
    }
  } catch (error) {
    if (error instanceof Error && error.message == `Invalid ${field}`) throw error
    invalidField(field)
  }
}

const assertExactKeys = (value: Record<string, unknown>, field: string, keys: readonly string[]): void => {
  try {
    const actualKeys = Object.keys(value)
    if (actualKeys.length != keys.length || actualKeys.some(key => !keys.includes(key))) invalidField(field)
  } catch (error) {
    if (error instanceof Error && error.message == `Invalid ${field}`) throw error
    invalidField(field)
  }
}

const assertString = (value: unknown, field: string): asserts value is string => {
  if (typeof value != 'string') invalidField(field)
}

const assertNullableString = (value: unknown, field: string): asserts value is string | null => {
  if (value !== null) assertString(value, field)
}

const assertContextString = (value: unknown, field: string): asserts value is string => {
  if (typeof value != 'string' || value.length > MAX_CONTEXT_LENGTH) invalidField(field)
}

const assertInteger = (value: unknown, field: string, minimum: number, maximum = MAX_SAFE_INTEGER): asserts value is number => {
  if (typeof value != 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum || value > maximum) invalidField(field)
}

const assertDuration = (value: unknown, field: string): asserts value is number | null => {
  if (value !== null) assertInteger(value, field, 0, MAX_DURATION_MS)
}

const assertUuid = (value: unknown, field: string): asserts value is string => {
  if (typeof value != 'string' || !UUID_V4.test(value)) invalidField(field)
}

const assertOneOf = (value: unknown, field: string, values: readonly string[]): void => {
  if (typeof value != 'string' || !values.includes(value)) invalidField(field)
}

const assertJsonValue = (value: unknown, field: string, ancestors = new Set<object>(), depth = 0): asserts value is JsonValue => {
  if (value === null || typeof value == 'string' || typeof value == 'boolean') return
  if (typeof value == 'number') {
    if (!Number.isFinite(value)) invalidField(field)
    return
  }
  if (typeof value != 'object' || ancestors.has(value) || depth > MAX_JSON_DEPTH) invalidField(field)
  ancestors.add(value)
  if (Array.isArray(value)) {
    try {
      const length = Object.getOwnPropertyDescriptor(value, 'length')
      if (length == null || !Object.hasOwn(length, 'value') || typeof length.value != 'number' || Reflect.ownKeys(value).length != length.value + 1) invalidField(field)
      for (let index = 0; index < length.value; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
        if (descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalidField(field)
        assertJsonValue(descriptor.value, field, ancestors, depth + 1)
      }
    } catch (error) {
      if (error instanceof Error && error.message == `Invalid ${field}`) throw error
      invalidField(field)
    }
  } else {
    try {
      if (Object.getPrototypeOf(value) !== Object.prototype) invalidField(field)
      for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (typeof key != 'string' || descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalidField(field)
        assertJsonValue(descriptor.value, field, ancestors, depth + 1)
      }
    } catch (error) {
      if (error instanceof Error && error.message == `Invalid ${field}`) throw error
      invalidField(field)
    }
  }
  ancestors.delete(value)
}

const jsonByteLength = (value: JsonValue, field: string, maximum: number): void => {
  const serialized = JSON.stringify(cloneJson(value))
  if (Buffer.byteLength(serialized, 'utf8') > maximum) invalidField(field)
}

const cloneJson = <T extends JsonValue>(value: T): T => {
  if (Array.isArray(value)) return value.map(item => cloneJson(item)) as T
  if (value != null && typeof value == 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T
  return value
}

const assertVersion = (value: unknown): asserts value is 1 => {
  if (value !== 1) invalidField('version')
}

const assertContext = (value: unknown): asserts value is PlaybackStartCommandV1['context'] => {
  assertRecord(value, 'context')
  assertExactKeys(value, 'context', ['type', 'id'])
  if (value.type !== null) assertContextString(value.type, 'context.type')
  if (value.id !== null) assertContextString(value.id, 'context.id')
}

const assertResumeHint = (value: unknown, field = 'resume'): asserts value is PlaybackStartCommandV1['resume'] => {
  assertRecord(value, field)
  assertExactKeys(value, field, ['listId', 'indexHint'])
  assertNullableString(value.listId, `${field}.listId`)
  if (value.indexHint !== null) assertInteger(value.indexHint, `${field}.indexHint`, 0, 1_000_000)
}

const assertConsent = (value: unknown): asserts value is PlaybackStartCommandV1['consent'] => {
  assertRecord(value, 'consent')
  assertExactKeys(value, 'consent', ['recentAllowed', 'statsAllowed', 'privateMode'])
  for (const key of ['recentAllowed', 'statsAllowed', 'privateMode'] as const) {
    if (typeof value[key] != 'boolean') invalidField(`consent.${key}`)
  }
}

const isSensitiveKey = (key: string): boolean => {
  const normalized = key.toLowerCase().replace(/[_-]/g, '')
  return normalized.endsWith('url') || normalized.includes('cookie') || normalized.includes('token') ||
    normalized.includes('credential') || normalized == 'auth' || normalized.includes('authorization') ||
    normalized.includes('password') || normalized == 'username' || normalized.includes('lyric') || normalized.includes('lrc') ||
    normalized.includes('roomid') || normalized == 'room' || normalized.includes('playerstate') ||
    normalized == 'isplaying' || normalized == 'currenttime' || normalized == 'playbackstate' ||
    normalized == 'playinfo' || normalized == 'transient' || normalized.includes('player') || normalized.includes('playback')
}

const sanitizeJson = (value: JsonValue, preserveWebdavRoot = false): JsonValue => {
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item))
  if (value == null || typeof value != 'object') return value
  const source = Object.getOwnPropertyDescriptor(value, 'source')?.value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => (preserveWebdavRoot && key == 'url') || !isSensitiveKey(key))
    .map(([key, item]) => [key, sanitizeJson(item, source == 'webdav' && key == 'meta')]))
}

const normalizeWebdavRoot = (value: unknown, field: string): string => {
  if (typeof value != 'string') invalidField(field)
  try {
    const url = new URL(value)
    if ((url.protocol != 'http:' && url.protocol != 'https:') || url.username || url.password) invalidField(field)
    url.search = ''
    url.hash = ''
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url.toString()
  } catch (error) {
    if (error instanceof Error && error.message == `Invalid ${field}`) throw error
    invalidField(field)
  }
}

const assertWebdavPath = (value: unknown, field: string): void => {
  if (typeof value != 'string' || !value || value.startsWith('/') || value.startsWith('\\')) invalidField(field)
  try {
    if (value.split('/').some(segment => {
      const decoded = decodeURIComponent(segment)
      return !decoded || decoded == '.' || decoded == '..' || decoded.includes('/') || decoded.includes('\\')
    })) invalidField(field)
  } catch (error) {
    if (error instanceof Error && error.message == `Invalid ${field}`) throw error
    invalidField(field)
  }
}

const assertSongId = (value: unknown, field: string): void => {
  if (typeof value != 'string' && (typeof value != 'number' || !Number.isFinite(value))) invalidField(field)
}

const assertQualitys = (value: unknown, field: string, kg = false): void => {
  if (!Array.isArray(value)) invalidField(field)
  for (const quality of value) {
    assertRecord(quality, field)
    assertExactKeys(quality, field, kg ? ['type', 'size', 'hash'] : ['type', 'size'])
    assertString(quality.type, field)
    if (quality.size !== null) assertString(quality.size, field)
    if (kg) assertString(quality.hash, field)
  }
}

const assertQualityMap = (value: unknown, field: string, kg = false): void => {
  assertRecord(value, field)
  for (const entry of Object.values(value)) {
    assertRecord(entry, field)
    assertExactKeys(entry, field, kg ? ['size', 'hash'] : ['size'])
    if (entry.size !== null) assertString(entry.size, field)
    if (kg) assertString(entry.hash, field)
  }
}

const assertOptionalString = (value: Record<string, unknown>, key: string, field: string): void => {
  if (Object.hasOwn(value, key) && value[key] !== null) assertString(value[key], field)
}

const assertMusicInfo = (value: unknown, field: string): asserts value is LX.Music.MusicInfo => {
  assertRecord(value, field)
  for (const key of ['id', 'source', 'name', 'singer', 'interval', 'meta']) if (!Object.hasOwn(value, key)) invalidField(field)
  assertString(value.id, field)
  assertOneOf(value.source, field, ['local', 'webdav', 'kw', 'kg', 'tx', 'wy', 'mg'])
  assertString(value.name, field)
  assertString(value.singer, field)
  if (value.interval !== null) assertString(value.interval, field)
  assertRecord(value.meta, field)
  for (const key of ['songId', 'albumName']) if (!Object.hasOwn(value.meta, key)) invalidField(field)
  assertSongId(value.meta.songId, field)
  assertString(value.meta.albumName, field)
  assertOptionalString(value.meta, 'recommendTag', field)
  if (Object.hasOwn(value.meta, 'toggleMusicInfo') && value.meta.toggleMusicInfo !== null) {
    assertMusicInfo(value.meta.toggleMusicInfo, field)
    if (value.meta.toggleMusicInfo.source == 'local' || value.meta.toggleMusicInfo.source == 'webdav') invalidField(field)
  }

  switch (value.source) {
    case 'local':
      for (const key of ['filePath', 'ext']) if (!Object.hasOwn(value.meta, key)) invalidField(field)
      if (typeof value.meta.filePath != 'string' || !value.meta.filePath) invalidField(field)
      assertString(value.meta.ext, field)
      break
    case 'webdav':
      for (const key of ['url', 'path', 'fileName', 'ext']) if (!Object.hasOwn(value.meta, key)) invalidField(field)
      normalizeWebdavRoot(value.meta.url, field)
      assertWebdavPath(value.meta.path, field)
      assertString(value.meta.fileName, field)
      assertString(value.meta.ext, field)
      break
    case 'kw':
    case 'wy':
      assertQualitys(value.meta.qualitys, field)
      assertQualityMap(value.meta._qualitys, field)
      break
    case 'kg':
      assertQualitys(value.meta.qualitys, field, true)
      assertQualityMap(value.meta._qualitys, field, true)
      assertString(value.meta.hash, field)
      break
    case 'tx':
      assertQualitys(value.meta.qualitys, field)
      assertQualityMap(value.meta._qualitys, field)
      assertString(value.meta.strMediaMid, field)
      if (Object.hasOwn(value.meta, 'id') && (typeof value.meta.id != 'number' || !Number.isFinite(value.meta.id))) invalidField(field)
      assertOptionalString(value.meta, 'albumMid', field)
      if (Object.hasOwn(value.meta, 'songType') && (typeof value.meta.songType != 'number' || !Number.isFinite(value.meta.songType))) invalidField(field)
      break
    case 'mg':
      assertQualitys(value.meta.qualitys, field)
      assertQualityMap(value.meta._qualitys, field)
      assertString(value.meta.copyrightId, field)
      break
  }
}

const assertTrackScalars = (value: Record<string, unknown>, field: string): void => {
  assertString(value.source, `${field}.source`)
  assertString(value.sourceTrackId, `${field}.sourceTrackId`)
  assertString(value.name, `${field}.name`)
  assertString(value.singer, `${field}.singer`)
  assertDuration(value.durationMs, `${field}.durationMs`)
}

export const parsePlaybackEventDetails = (value: unknown): JsonValue => {
  assertJsonValue(value, 'details')
  jsonByteLength(value, 'details', MAX_EVENT_DETAILS_BYTES)
  return cloneJson(value)
}

export const sanitizePlayableTrack = (value: unknown): LX.Music.MusicInfo => {
  assertJsonValue(value, 'playablePayload')
  jsonByteLength(value, 'playablePayload', MAX_PLAYABLE_PAYLOAD_BYTES)
  assertRecord(value, 'playablePayload')
  const sanitized = sanitizeJson(value) as Record<string, unknown>
  if (sanitized.source == 'webdav') {
    assertRecord(sanitized.meta, 'playablePayload')
    sanitized.meta.url = normalizeWebdavRoot(sanitized.meta.url, 'playablePayload')
  }
  assertMusicInfo(sanitized, 'playablePayload')
  jsonByteLength(sanitized as JsonValue, 'playablePayload', MAX_PLAYABLE_PAYLOAD_BYTES)
  return sanitized
}

export const parsePlaybackTrack = (value: unknown): PlaybackTrackV1 => {
  assertRecord(value, 'track')
  assertExactKeys(value, 'track', ['source', 'sourceTrackId', 'name', 'singer', 'durationMs', 'playablePayload'])
  assertTrackScalars(value, 'track')
  return {
    source: value.source,
    sourceTrackId: value.sourceTrackId,
    name: value.name,
    singer: value.singer,
    durationMs: value.durationMs,
    playablePayload: value.playablePayload === null ? null : sanitizePlayableTrack(value.playablePayload),
  }
}

export const parsePlaybackCheckpoint = (value: unknown): PlaybackCheckpointV1 => {
  assertRecord(value, 'checkpoint')
  assertExactKeys(value, 'checkpoint', ['playbackGroupUuid', 'checkpointSeq', 'cumulativePlayedMs', 'cumulativeActiveMs', 'positionMs', 'durationMs', 'occurredAtMs'])
  assertUuid(value.playbackGroupUuid, 'playbackGroupUuid')
  assertInteger(value.checkpointSeq, 'checkpointSeq', 0)
  assertInteger(value.cumulativePlayedMs, 'cumulativePlayedMs', 0)
  assertInteger(value.cumulativeActiveMs, 'cumulativeActiveMs', 0)
  assertInteger(value.positionMs, 'positionMs', 0, MAX_DURATION_MS)
  assertDuration(value.durationMs, 'durationMs')
  assertInteger(value.occurredAtMs, 'occurredAtMs', 0)
  return cloneJson(value as JsonValue) as PlaybackCheckpointV1
}

export const validateCheckpointAfter = (previous: unknown, next: unknown): void => {
  const prior = parsePlaybackCheckpoint(previous)
  const current = parsePlaybackCheckpoint(next)
  if (prior.playbackGroupUuid != current.playbackGroupUuid) invalidField('playbackGroupUuid')
  if (current.checkpointSeq <= prior.checkpointSeq) invalidField('checkpointSeq')
  if (current.cumulativePlayedMs < prior.cumulativePlayedMs) invalidField('cumulativePlayedMs')
  if (current.cumulativeActiveMs < prior.cumulativeActiveMs) invalidField('cumulativeActiveMs')
}

export const parsePlaybackFact = (value: unknown): PlaybackFactV1 => {
  assertRecord(value, 'fact')
  assertVersion(value.version)
  switch (value.type) {
    case 'play_start':
      assertExactKeys(value, 'fact', ['version', 'type', 'reason'])
      assertOneOf(value.reason, 'reason', ['select', 'next', 'previous', 'auto', 'restore', 'remote', 'day_boundary', 'statistics_clear'])
      break
    case 'pause':
    case 'resume':
      assertExactKeys(value, 'fact', ['version', 'type', 'reason'])
      assertOneOf(value.reason, 'reason', ['user', 'device', 'remote', 'recovery'])
      break
    case 'seek':
      assertExactKeys(value, 'fact', ['version', 'type', 'origin', 'fromMs', 'toMs'])
      assertOneOf(value.origin, 'origin', ['bar', 'hotkey', 'media_session', 'lyric', 'party', 'restore', 'buffer_recovery'])
      assertInteger(value.fromMs, 'fromMs', 0, MAX_DURATION_MS)
      assertInteger(value.toMs, 'toMs', 0, MAX_DURATION_MS)
      break
    case 'skip':
      assertExactKeys(value, 'fact', ['version', 'type', 'reason', 'automatic'])
      assertOneOf(value.reason, 'reason', ['next', 'previous', 'select', 'dislike', 'stop', 'error', 'load_timeout', 'buffer_timeout', 'queue_removed'])
      if (typeof value.automatic != 'boolean') invalidField('automatic')
      break
    case 'play_end':
      assertExactKeys(value, 'fact', ['version', 'type', 'reason'])
      if (value.reason != 'natural_end') invalidField('reason')
      break
    case 'error':
      assertExactKeys(value, 'fact', ['version', 'type', 'stage', 'code', 'recoverable', 'attempt'])
      assertOneOf(value.stage, 'stage', ['url', 'load', 'decode', 'buffer', 'output', 'unknown'])
      if (value.code !== null) assertInteger(value.code, 'code', -MAX_SAFE_INTEGER)
      if (typeof value.recoverable != 'boolean') invalidField('recoverable')
      assertInteger(value.attempt, 'attempt', 0)
      break
    default:
      invalidField('type')
  }
  return cloneJson(value as JsonValue) as PlaybackFactV1
}

export const parsePlaybackStartCommand = (value: unknown): PlaybackStartCommandV1 => {
  assertRecord(value, 'start')
  assertExactKeys(value, 'start', ['version', 'playbackGroupUuid', 'track', 'context', 'resume', 'startReason', 'startPositionMs', 'occurredAtMs', 'consent'])
  assertVersion(value.version)
  assertUuid(value.playbackGroupUuid, 'playbackGroupUuid')
  const track = parsePlaybackTrack(value.track)
  assertContext(value.context)
  assertResumeHint(value.resume)
  assertOneOf(value.startReason, 'startReason', ['select', 'next', 'previous', 'auto', 'restore', 'remote', 'day_boundary', 'statistics_clear'])
  assertInteger(value.startPositionMs, 'startPositionMs', 0, MAX_DURATION_MS)
  assertInteger(value.occurredAtMs, 'occurredAtMs', 0)
  assertConsent(value.consent)
  return {
    version: 1,
    playbackGroupUuid: value.playbackGroupUuid,
    track,
    context: cloneJson(value.context as unknown as JsonValue) as PlaybackStartCommandV1['context'],
    resume: cloneJson(value.resume as unknown as JsonValue) as PlaybackStartCommandV1['resume'],
    startReason: value.startReason as PlaybackStartCommandV1['startReason'],
    startPositionMs: value.startPositionMs,
    occurredAtMs: value.occurredAtMs,
    consent: cloneJson(value.consent as unknown as JsonValue) as PlaybackStartCommandV1['consent'],
  }
}

export const classifyPlaybackMode = (consent: unknown): PlaybackStartMode => {
  assertConsent(consent)
  if (consent.privateMode) return 'private'
  if (!consent.recentAllowed && !consent.statsAllowed) return 'resume-only'
  return 'activity'
}

export const getPlaybackStartMode = classifyPlaybackMode

export const parsePlaybackPreplayFailure = (value: unknown): PlaybackPreplayFailureV1 => {
  assertRecord(value, 'preplayFailure')
  assertExactKeys(value, 'preplayFailure', ['version', 'playbackGroupUuid', 'track', 'context', 'resume', 'startReason', 'startPositionMs', 'occurredAtMs', 'error', 'consent'])
  const start = parsePlaybackStartCommand({
    version: value.version,
    playbackGroupUuid: value.playbackGroupUuid,
    track: value.track,
    context: value.context,
    resume: value.resume,
    startReason: value.startReason,
    startPositionMs: value.startPositionMs,
    occurredAtMs: value.occurredAtMs,
    consent: value.consent,
  })
  const error = parsePlaybackFact(value.error)
  if (error.type != 'error') invalidField('error')
  const result: PlaybackPreplayFailureV1 = { ...start, error }
  return result
}

export const parsePlaybackResumeUpdate = (value: unknown): PlaybackResumeUpdateV1 => {
  assertRecord(value, 'resumeUpdate')
  assertExactKeys(value, 'resumeUpdate', ['version', 'playbackGroupUuid', 'checkpointSeq', 'track', 'listId', 'indexHint', 'positionMs', 'durationMs', 'updatedAtMs'])
  assertVersion(value.version)
  assertUuid(value.playbackGroupUuid, 'playbackGroupUuid')
  assertInteger(value.checkpointSeq, 'checkpointSeq', 0)
  assertRecord(value.track, 'track')
  assertExactKeys(value.track, 'track', ['source', 'sourceTrackId'])
  assertString(value.track.source, 'track.source')
  assertString(value.track.sourceTrackId, 'track.sourceTrackId')
  assertNullableString(value.listId, 'listId')
  if (value.indexHint !== null) assertInteger(value.indexHint, 'indexHint', 0, 1_000_000)
  assertInteger(value.positionMs, 'positionMs', 0, MAX_DURATION_MS)
  assertDuration(value.durationMs, 'durationMs')
  assertInteger(value.updatedAtMs, 'updatedAtMs', 0)
  return cloneJson(value as JsonValue) as PlaybackResumeUpdateV1
}

const isCalendarDay = (value: unknown): value is string => {
  if (typeof value != 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const isLeap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

export const parsePlaybackCommitRequest = (value: unknown): PlaybackCommitRequestV1 => {
  assertRecord(value, 'commit')
  assertVersion(value.version)
  const hasFact = Object.hasOwn(value, 'fact')
  const hasBoundary = Object.hasOwn(value, 'boundary')
  if (hasFact && hasBoundary) invalidField('commit')
  if (hasFact) {
    assertExactKeys(value, 'commit', ['version', 'checkpoint', 'fact'])
    return { version: 1, checkpoint: parsePlaybackCheckpoint(value.checkpoint), fact: parsePlaybackFact(value.fact) }
  } else if (hasBoundary) {
    assertExactKeys(value, 'commit', ['version', 'checkpoint', 'boundary'])
    assertRecord(value.boundary, 'boundary')
    assertExactKeys(value.boundary, 'boundary', ['type', 'nextLocalDay', 'utcOffsetMinutes'])
    if (value.boundary.type != 'day_boundary') invalidField('boundary.type')
    if (!isCalendarDay(value.boundary.nextLocalDay)) invalidField('boundary.nextLocalDay')
    assertInteger(value.boundary.utcOffsetMinutes, 'boundary.utcOffsetMinutes', -1440, 1440)
    return {
      version: 1,
      checkpoint: parsePlaybackCheckpoint(value.checkpoint),
      boundary: {
        type: 'day_boundary',
        nextLocalDay: value.boundary.nextLocalDay,
        utcOffsetMinutes: value.boundary.utcOffsetMinutes,
      },
    }
  } else {
    assertExactKeys(value, 'commit', ['version', 'checkpoint'])
    return { version: 1, checkpoint: parsePlaybackCheckpoint(value.checkpoint) }
  }
}

export const parsePlaybackCheckpointAck = (value: unknown): PlaybackCheckpointAckV1 => {
  assertRecord(value, 'checkpointAck')
  assertExactKeys(value, 'checkpointAck', ['playbackGroupUuid', 'sessionUuid', 'segmentNo', 'checkpointSeq', 'cumulativePlayedMs', 'cumulativeActiveMs'])
  assertUuid(value.playbackGroupUuid, 'playbackGroupUuid')
  assertUuid(value.sessionUuid, 'sessionUuid')
  assertInteger(value.segmentNo, 'segmentNo', 0)
  assertInteger(value.checkpointSeq, 'checkpointSeq', 0)
  assertInteger(value.cumulativePlayedMs, 'cumulativePlayedMs', 0)
  assertInteger(value.cumulativeActiveMs, 'cumulativeActiveMs', 0)
  return cloneJson(value as JsonValue) as PlaybackCheckpointAckV1
}

export const parsePlaybackResumeAck = (value: unknown): PlaybackResumeAckV1 => {
  assertRecord(value, 'resumeAck')
  assertExactKeys(value, 'resumeAck', ['playbackGroupUuid', 'checkpointSeq', 'positionMs'])
  assertUuid(value.playbackGroupUuid, 'playbackGroupUuid')
  assertInteger(value.checkpointSeq, 'checkpointSeq', 0)
  assertInteger(value.positionMs, 'positionMs', 0, MAX_DURATION_MS)
  return cloneJson(value as JsonValue) as PlaybackResumeAckV1
}

export const parsePlaybackStartResult = (value: unknown): PlaybackStartResultV1 => {
  assertRecord(value, 'startResult')
  switch (value.mode) {
    case 'activity':
      assertExactKeys(value, 'startResult', ['mode', 'ack'])
      return { mode: 'activity', ack: parsePlaybackCheckpointAck(value.ack) }
    case 'resume-only':
      assertExactKeys(value, 'startResult', ['mode', 'ack'])
      return { mode: 'resume-only', ack: parsePlaybackResumeAck(value.ack) }
    case 'private':
      assertExactKeys(value, 'startResult', ['mode', 'playbackGroupUuid', 'checkpointSeq'])
      assertUuid(value.playbackGroupUuid, 'playbackGroupUuid')
      assertInteger(value.checkpointSeq, 'checkpointSeq', 0)
      return { mode: 'private', playbackGroupUuid: value.playbackGroupUuid, checkpointSeq: value.checkpointSeq }
    default:
      invalidField('mode')
  }
}

export const parsePlaybackRecorderCommand = (value: unknown): PlaybackRecorderCommandV1 => {
  assertRecord(value, 'recorderCommand')
  assertExactKeys(value, 'recorderCommand', ['kind', 'request'])
  switch (value.kind) {
    case 'start': return { kind: 'start', request: parsePlaybackStartCommand(value.request) }
    case 'commit': return { kind: 'commit', request: parsePlaybackCommitRequest(value.request) }
    case 'resume': return { kind: 'resume', request: parsePlaybackResumeUpdate(value.request) }
    case 'preplay_failure': return { kind: 'preplay_failure', request: parsePlaybackPreplayFailure(value.request) }
    default: invalidField('kind')
  }
}

const assertBucket = (value: unknown, field: string): asserts value is ListeningBucketV1 => {
  assertRecord(value, field)
  for (const key of ['baselinePlayedMs', 'livePlayedMs', 'baselineActiveMs', 'liveActiveMs', 'playedMs', 'activeMs'] as const) assertInteger(value[key], `${field}.${key}`, 0)
}

export const parseRecentTrack = (value: unknown): RecentTrackV1 => {
  assertRecord(value, 'recentTrack')
  assertExactKeys(value, 'recentTrack', ['version', 'source', 'sourceTrackId', 'name', 'singer', 'durationMs', 'playablePayload', 'lastPlayedAtMs', 'legacyRank'])
  assertVersion(value.version)
  const track = parsePlaybackTrack({
    source: value.source,
    sourceTrackId: value.sourceTrackId,
    name: value.name,
    singer: value.singer,
    durationMs: value.durationMs,
    playablePayload: value.playablePayload,
  })
  if (value.lastPlayedAtMs !== null) assertInteger(value.lastPlayedAtMs, 'lastPlayedAtMs', 0)
  if (value.legacyRank !== null) assertInteger(value.legacyRank, 'legacyRank', 0)
  return { version: 1, ...track, lastPlayedAtMs: value.lastPlayedAtMs, legacyRank: value.legacyRank }
}

export const parseListeningStats = (value: unknown): ListeningStatsV1 => {
  assertRecord(value, 'listeningStats')
  assertExactKeys(value, 'listeningStats', ['version', 'total', 'daily', 'tracks', 'updatedAtMs'])
  assertVersion(value.version)
  assertRecord(value.total, 'total')
  assertExactKeys(value.total, 'total', ['baselinePlayedMs', 'livePlayedMs', 'baselineActiveMs', 'liveActiveMs', 'playedMs', 'activeMs'])
  assertBucket(value.total, 'total')
  if (!Array.isArray(value.daily) || !Array.isArray(value.tracks)) invalidField('listeningStats')
  assertJsonValue(value.daily, 'daily')
  assertJsonValue(value.tracks, 'tracks')
  for (const entry of value.daily) {
    assertRecord(entry, 'daily')
    assertExactKeys(entry, 'daily', ['baselinePlayedMs', 'livePlayedMs', 'baselineActiveMs', 'liveActiveMs', 'playedMs', 'activeMs', 'localDay'])
    assertBucket(entry, 'daily')
    if (!isCalendarDay(entry.localDay)) invalidField('localDay')
  }
  for (const entry of value.tracks) {
    assertRecord(entry, 'tracks')
    assertExactKeys(entry, 'tracks', ['baselinePlayedMs', 'livePlayedMs', 'baselineActiveMs', 'liveActiveMs', 'playedMs', 'activeMs', 'source', 'sourceTrackId', 'name', 'singer', 'durationMs'])
    assertBucket(entry, 'tracks')
    assertTrackScalars({ ...entry, playablePayload: null }, 'tracks')
  }
  assertInteger(value.updatedAtMs, 'updatedAtMs', 0)
  return cloneJson(value as JsonValue) as ListeningStatsV1
}

export const parsePlaybackResume = (value: unknown): PlaybackResumeV1 => {
  assertRecord(value, 'resume')
  assertExactKeys(value, 'resume', ['version', 'source', 'sourceTrackId', 'listId', 'indexHint', 'positionMs', 'durationMs', 'updatedAtMs'])
  assertVersion(value.version)
  assertString(value.source, 'source')
  assertString(value.sourceTrackId, 'sourceTrackId')
  assertNullableString(value.listId, 'listId')
  if (value.indexHint !== null) assertInteger(value.indexHint, 'indexHint', 0, 1_000_000)
  assertInteger(value.positionMs, 'positionMs', 0, MAX_DURATION_MS)
  assertDuration(value.durationMs, 'durationMs')
  assertInteger(value.updatedAtMs, 'updatedAtMs', 0)
  return cloneJson(value as JsonValue) as PlaybackResumeV1
}
