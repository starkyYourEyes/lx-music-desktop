import { canonicalJson, type JsonValue } from '../../../../../common/storage/canonicalJson'
import {
  compareCanonicalText,
  compareLegacyPlaybackTrack,
  legacyPlaybackActivitySha256,
  legacyPlaybackTrackKey,
} from '../../../../../common/storage/legacyPlaybackActivity'
import type { LegacyListeningImportV1 } from '../../../../../common/storage/legacyListening'
import type { PlaybackTrackV1 } from '../../../../../common/storage/playback'
import { parsePlaybackTrack } from '../../../../../common/storage/playbackValidation'
import { getDB } from '../../db'
import { getMigrationMarker, putMigrationMarker } from '../../migrate'
import type { MigrationMarker } from '../../migrations/types'

const ACTIVITY_MARKER_NAME = 'legacy_data_v1.playback_activity' as const
const MAX_RECENT_TRACKS = 520
const MAX_TRACK_STRING_LENGTH = 256
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export type PlaybackActivityImportFailPoint = 'inside-transaction' | 'before-marker'

export interface LegacyPlaybackResumeHintV1 {
  listId: string
  indexHint: number
  positionMs: number
  durationMs: number
}

export interface LegacyPlaybackActivityImportV1 {
  sourceSha256: string
  completedAtMs: number
  recent: Array<{ track: PlaybackTrackV1, legacyRank: number }>
  listening: LegacyListeningImportV1
  resume: LegacyPlaybackResumeHintV1 | null
  failAt?: PlaybackActivityImportFailPoint
}

export interface LegacyPlaybackActivityImportResultV1 {
  status: 'complete' | 'already-complete'
  sourceSha256: string
  recentCount: number
  dailyCount: number
  listeningTrackCount: number
  resumeImported: boolean
  mismatch: LegacyListeningImportV1['mismatch']
}

interface ResolvedResume {
  source: string
  sourceTrackId: string
  listId: string
  indexHint: number
  positionMs: number
  durationMs: number
}

interface NormalizedImport extends Omit<LegacyPlaybackActivityImportV1, 'resume'> {
  resume: LegacyPlaybackResumeHintV1 | null
}

interface ActivityMarkerDetailsV1 {
  version: 1
  baselineActiveTimeKnown: false
  dailyCount: number
  listeningTrackCount: number
  mismatch: LegacyListeningImportV1['mismatch']
  recentCount: number
  resumeImported: boolean
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value)
  return actual.length == keys.length && actual.every(key => keys.includes(key))
}

const isSafeInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum

const isTrackString = (value: unknown): value is string =>
  typeof value == 'string' && value.length > 0 && value.length <= MAX_TRACK_STRING_LENGTH

const isCalendarDay = (value: unknown): value is string => {
  if (typeof value != 'string') return false
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match == null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

const saturatedMismatch = (total: number, values: readonly number[]): number => {
  const limit = BigInt(Number.MAX_SAFE_INTEGER)
  let result = BigInt(total)
  for (const value of values) {
    result -= BigInt(value)
    if (result <= -limit) return -Number.MAX_SAFE_INTEGER
  }
  return Number(result)
}

const normalizeListening = (value: unknown): LegacyListeningImportV1 => {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'totalPlayedMs', 'daily', 'tracks', 'mismatch', 'baselineActiveTimeKnown',
  ]) || !isSafeInteger(value.totalPlayedMs) || value.baselineActiveTimeKnown !== false ||
    !Array.isArray(value.daily) || !Array.isArray(value.tracks) || !isPlainRecord(value.mismatch) ||
    !hasExactKeys(value.mismatch, ['totalVsDailyMs', 'totalVsTracksMs'])) {
    throw new Error('Invalid legacy playback listening import')
  }

  const daily = value.daily.map(entry => {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ['localDay', 'baselinePlayedMs']) ||
      !isCalendarDay(entry.localDay) || !isSafeInteger(entry.baselinePlayedMs)) {
      throw new Error('Invalid legacy playback daily import')
    }
    return { localDay: entry.localDay, baselinePlayedMs: entry.baselinePlayedMs }
  }).sort((left, right) => compareCanonicalText(left.localDay, right.localDay))
  if (new Set(daily.map(entry => entry.localDay)).size != daily.length) {
    throw new Error('Invalid legacy playback daily import')
  }

  const tracks = value.tracks.map(entry => {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, [
      'source', 'sourceTrackId', 'name', 'singer', 'baselinePlayedMs',
    ]) || !isTrackString(entry.source) || !isTrackString(entry.sourceTrackId) ||
      !isTrackString(entry.name) || !isTrackString(entry.singer) || !isSafeInteger(entry.baselinePlayedMs)) {
      throw new Error('Invalid legacy playback track baseline import')
    }
    return {
      source: entry.source,
      sourceTrackId: entry.sourceTrackId,
      name: entry.name,
      singer: entry.singer,
      baselinePlayedMs: entry.baselinePlayedMs,
    }
  }).sort(compareLegacyPlaybackTrack)
  if (new Set(tracks.map(track => legacyPlaybackTrackKey(track.source, track.sourceTrackId))).size != tracks.length) {
    throw new Error('Invalid legacy playback track baseline import')
  }

  const expectedMismatch = {
    totalVsDailyMs: saturatedMismatch(value.totalPlayedMs, daily.map(entry => entry.baselinePlayedMs)),
    totalVsTracksMs: saturatedMismatch(value.totalPlayedMs, tracks.map(entry => entry.baselinePlayedMs)),
  }
  if (value.mismatch.totalVsDailyMs != expectedMismatch.totalVsDailyMs ||
    value.mismatch.totalVsTracksMs != expectedMismatch.totalVsTracksMs) {
    throw new Error('Invalid legacy playback listening mismatch')
  }
  return {
    totalPlayedMs: value.totalPlayedMs,
    daily,
    tracks,
    mismatch: expectedMismatch,
    baselineActiveTimeKnown: false,
  }
}

const normalizeResume = (value: unknown): LegacyPlaybackResumeHintV1 | null => {
  if (value === null) return null
  if (!isPlainRecord(value) || !hasExactKeys(value, ['listId', 'indexHint', 'positionMs', 'durationMs']) ||
    !isTrackString(value.listId) || !isSafeInteger(value.indexHint, 0, 1_000_000) ||
    !isSafeInteger(value.positionMs, 0, MAX_DURATION_MS) || !isSafeInteger(value.durationMs, 0, MAX_DURATION_MS) ||
    value.positionMs > value.durationMs) {
    throw new Error('Invalid legacy playback resume import')
  }
  return {
    listId: value.listId,
    indexHint: value.indexHint,
    positionMs: value.positionMs,
    durationMs: value.durationMs,
  }
}

const normalizeImport = (value: unknown): NormalizedImport => {
  if (!isPlainRecord(value)) throw new Error('Invalid legacy playback import')
  const allowedKeys = ['sourceSha256', 'completedAtMs', 'recent', 'listening', 'resume', 'failAt']
  const requiredKeys = allowedKeys.filter(key => key != 'failAt')
  if (Object.keys(value).some(key => !allowedKeys.includes(key)) || requiredKeys.some(key => !Object.hasOwn(value, key)) ||
    typeof value.sourceSha256 != 'string' || !SHA256_PATTERN.test(value.sourceSha256) ||
    !isSafeInteger(value.completedAtMs) || !Array.isArray(value.recent) || value.recent.length > MAX_RECENT_TRACKS ||
    (value.failAt != null && !['inside-transaction', 'before-marker'].includes(value.failAt as string))) {
    throw new Error('Invalid legacy playback import')
  }
  const identities = new Set<string>()
  const recent = value.recent.map((entry, index) => {
    if (!isPlainRecord(entry) || !hasExactKeys(entry, ['track', 'legacyRank']) || entry.legacyRank !== index + 1) {
      throw new Error('Invalid legacy recent import')
    }
    const track = parsePlaybackTrack(entry.track)
    const identity = legacyPlaybackTrackKey(track.source, track.sourceTrackId)
    if (identities.has(identity)) throw new Error('Invalid duplicate legacy recent identity')
    identities.add(identity)
    return { track, legacyRank: entry.legacyRank }
  })
  return {
    sourceSha256: value.sourceSha256,
    completedAtMs: value.completedAtMs,
    recent,
    listening: normalizeListening(value.listening),
    resume: normalizeResume(value.resume),
    failAt: value.failAt as PlaybackActivityImportFailPoint | undefined,
  }
}

const resolveResume = (resume: LegacyPlaybackResumeHintV1 | null): ResolvedResume | null => {
  if (resume == null) return null
  const rows = getDB().prepare(`
    SELECT music.source, music.id AS sourceTrackId
    FROM my_list_music_info_order ordering
    JOIN my_list_music_info music
      ON music.listId = ordering.listId AND music.id = ordering.musicInfoId
    WHERE ordering.listId = ? AND ordering."order" = ?
    LIMIT 2
  `).all(resume.listId, resume.indexHint) as Array<{ source: unknown, sourceTrackId: unknown }>
  if (rows.length != 1 || !isTrackString(rows[0].source) || !isTrackString(rows[0].sourceTrackId)) return null
  return { ...resume, source: rows[0].source, sourceTrackId: rows[0].sourceTrackId }
}

const markerDetails = (
  input: NormalizedImport,
  resumeImported: boolean,
): ActivityMarkerDetailsV1 => ({
  version: 1,
  baselineActiveTimeKnown: false,
  dailyCount: input.listening.daily.length,
  listeningTrackCount: input.listening.tracks.length,
  mismatch: input.listening.mismatch,
  recentCount: input.recent.length,
  resumeImported,
})

const parseMarkerDetails = (input: NormalizedImport, detailsJson: string): ActivityMarkerDetailsV1 => {
  let value: unknown
  try {
    value = JSON.parse(detailsJson)
  } catch {
    throw new Error('Legacy playback marker attestation verification failed')
  }
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'version', 'baselineActiveTimeKnown', 'dailyCount', 'listeningTrackCount',
    'mismatch', 'recentCount', 'resumeImported',
  ]) || typeof value.resumeImported != 'boolean' || (input.resume == null && value.resumeImported)) {
    throw new Error('Legacy playback marker attestation verification failed')
  }
  const expected = markerDetails(input, value.resumeImported)
  if (canonicalJson(expected as unknown as JsonValue) != canonicalJson(value as JsonValue)) {
    throw new Error('Legacy playback marker attestation verification failed')
  }
  return expected
}

const resultFor = (
  status: LegacyPlaybackActivityImportResultV1['status'],
  input: NormalizedImport,
  resumeImported: boolean,
): LegacyPlaybackActivityImportResultV1 => ({
  status,
  sourceSha256: input.sourceSha256,
  recentCount: input.recent.length,
  dailyCount: input.listening.daily.length,
  listeningTrackCount: input.listening.tracks.length,
  resumeImported,
  mismatch: { ...input.listening.mismatch },
})

const assertSame = (expected: unknown, actual: unknown, field: string): void => {
  if (canonicalJson(expected as JsonValue) != canonicalJson(actual as JsonValue)) {
    throw new Error(`Legacy playback ${field} target readback failed`)
  }
}

const trackId = (source: string, sourceTrackId: string): number => {
  const row = getDB().prepare(`
    SELECT track_id AS trackId FROM track_snapshots WHERE source = ? AND source_track_id = ?
  `).get(source, sourceTrackId) as { trackId?: unknown } | undefined
  if (row == null || !isSafeInteger(row.trackId, -Number.MAX_SAFE_INTEGER)) {
    throw new Error('Legacy playback track target readback failed')
  }
  return row.trackId
}

const verifyTarget = (input: NormalizedImport, resume: ResolvedResume | null): void => {
  const recent = getDB().prepare(`
    SELECT track.source, track.source_track_id AS sourceTrackId, track.name, track.singer,
      track.duration_ms AS durationMs, track.playable_payload_json AS playablePayloadJson,
      track.updated_at_ms AS trackUpdatedAtMs, recent.recency_seq AS recencySeq,
      recent.last_session_id AS lastSessionId, recent.last_played_at_ms AS lastPlayedAtMs,
      recent.legacy_rank AS legacyRank, recent.updated_at_ms AS recentUpdatedAtMs
    FROM recent_tracks recent JOIN track_snapshots track ON track.track_id = recent.track_id
    ORDER BY recent.legacy_rank
  `).all().map(row => {
    const value = row as Record<string, unknown>
    return {
      source: value.source,
      sourceTrackId: value.sourceTrackId,
      name: value.name,
      singer: value.singer,
      durationMs: value.durationMs,
      playablePayload: typeof value.playablePayloadJson == 'string' ? JSON.parse(value.playablePayloadJson) : null,
      trackUpdatedAtMs: value.trackUpdatedAtMs,
      recencySeq: value.recencySeq,
      lastSessionId: value.lastSessionId,
      lastPlayedAtMs: value.lastPlayedAtMs,
      legacyRank: value.legacyRank,
      recentUpdatedAtMs: value.recentUpdatedAtMs,
    }
  })
  assertSame(input.recent.map(entry => ({
    ...entry.track,
    trackUpdatedAtMs: 0,
    recencySeq: -entry.legacyRank,
    lastSessionId: null,
    lastPlayedAtMs: null,
    legacyRank: entry.legacyRank,
    recentUpdatedAtMs: 0,
  })), recent, 'recent')

  const daily = getDB().prepare(`
    SELECT local_day AS localDay, baseline_played_ms AS baselinePlayedMs,
      live_played_ms AS livePlayedMs, baseline_active_ms AS baselineActiveMs,
      live_active_ms AS liveActiveMs, updated_at_ms AS updatedAtMs
    FROM listening_daily ORDER BY local_day
  `).all()
  assertSame(input.listening.daily.map(entry => ({
    ...entry,
    livePlayedMs: 0,
    baselineActiveMs: 0,
    liveActiveMs: 0,
    updatedAtMs: 0,
  })), daily, 'daily')

  const listeningTracks = (getDB().prepare(`
    SELECT track.source, track.source_track_id AS sourceTrackId, track.name, track.singer,
      track.duration_ms AS durationMs, track.playable_payload_json AS playablePayloadJson,
      track.updated_at_ms AS trackUpdatedAtMs,
      listening.baseline_played_ms AS baselinePlayedMs,
      listening.live_played_ms AS livePlayedMs,
      listening.baseline_active_ms AS baselineActiveMs,
      listening.live_active_ms AS liveActiveMs,
      listening.last_played_at_ms AS lastPlayedAtMs,
      listening.updated_at_ms AS updatedAtMs
    FROM listening_tracks listening JOIN track_snapshots track ON track.track_id = listening.track_id
  `).all() as Array<{
    source: string
    sourceTrackId: string
    name: unknown
    singer: unknown
    durationMs: unknown
    playablePayloadJson: unknown
    trackUpdatedAtMs: unknown
    baselinePlayedMs: unknown
    livePlayedMs: unknown
    baselineActiveMs: unknown
    liveActiveMs: unknown
    lastPlayedAtMs: unknown
    updatedAtMs: unknown
  }>).map(row => ({
    source: row.source,
    sourceTrackId: row.sourceTrackId,
    name: row.name,
    singer: row.singer,
    durationMs: row.durationMs,
    playablePayload: typeof row.playablePayloadJson == 'string' ? JSON.parse(row.playablePayloadJson) : null,
    trackUpdatedAtMs: row.trackUpdatedAtMs,
    baselinePlayedMs: row.baselinePlayedMs,
    livePlayedMs: row.livePlayedMs,
    baselineActiveMs: row.baselineActiveMs,
    liveActiveMs: row.liveActiveMs,
    lastPlayedAtMs: row.lastPlayedAtMs,
    updatedAtMs: row.updatedAtMs,
  })).sort(compareLegacyPlaybackTrack)
  const recentSnapshots = new Map(input.recent.map(entry => [
    legacyPlaybackTrackKey(entry.track.source, entry.track.sourceTrackId),
    entry.track,
  ]))
  assertSame(input.listening.tracks.map(track => {
    const recentSnapshot = recentSnapshots.get(legacyPlaybackTrackKey(track.source, track.sourceTrackId))
    return {
      source: track.source,
      sourceTrackId: track.sourceTrackId,
      name: recentSnapshot?.name ?? track.name,
      singer: recentSnapshot?.singer ?? track.singer,
      durationMs: recentSnapshot?.durationMs ?? null,
      playablePayload: recentSnapshot?.playablePayload ?? null,
      trackUpdatedAtMs: 0,
      baselinePlayedMs: track.baselinePlayedMs,
      livePlayedMs: 0,
      baselineActiveMs: 0,
      liveActiveMs: 0,
      lastPlayedAtMs: null,
      updatedAtMs: 0,
    }
  }).sort(compareLegacyPlaybackTrack), listeningTracks, 'tracks')

  const totals = getDB().prepare(`
    SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
      baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs,
      updated_at_ms AS updatedAtMs FROM activity_totals WHERE id = 1
  `).get()
  assertSame({
    baselinePlayedMs: input.listening.totalPlayedMs,
    livePlayedMs: 0,
    baselineActiveMs: 0,
    liveActiveMs: 0,
    updatedAtMs: 0,
  }, totals, 'totals')

  const storedResume = getDB().prepare(`
    SELECT source, source_track_id AS sourceTrackId, list_id AS listId, index_hint AS indexHint,
      position_ms AS positionMs, duration_ms AS durationMs, checkpoint_seq AS checkpointSeq,
      updated_at_ms AS updatedAtMs FROM playback_resume_state WHERE id = 1
  `).get() ?? null
  assertSame(resume == null ? null : {
    source: resume.source,
    sourceTrackId: resume.sourceTrackId,
    listId: resume.listId,
    indexHint: resume.indexHint,
    positionMs: resume.positionMs,
    durationMs: resume.durationMs,
    checkpointSeq: 0,
    updatedAtMs: 0,
  }, storedResume, 'resume')
}

const replaceTarget = (input: NormalizedImport, resume: ResolvedResume | null): void => {
  const db = getDB()
  db.prepare('DELETE FROM recent_tracks').run()
  db.prepare('DELETE FROM listening_daily').run()
  db.prepare('DELETE FROM listening_tracks').run()
  db.prepare('DELETE FROM playback_resume_state').run()
  db.prepare(`
    UPDATE activity_totals SET baseline_played_ms = ?, live_played_ms = 0,
      baseline_active_ms = 0, live_active_ms = 0, updated_at_ms = 0 WHERE id = 1
  `).run(input.listening.totalPlayedMs)

  const upsertRecentTrack = db.prepare(`
    INSERT INTO track_snapshots(
      source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
    ) VALUES(?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(source, source_track_id) DO UPDATE SET
      name = excluded.name, singer = excluded.singer, duration_ms = excluded.duration_ms,
      playable_payload_json = excluded.playable_payload_json, updated_at_ms = 0
  `)
  const insertRecent = db.prepare(`
    INSERT INTO recent_tracks(
      track_id, recency_seq, last_session_id, last_played_at_ms, legacy_rank, updated_at_ms
    ) VALUES(?, ?, NULL, NULL, ?, 0)
  `)
  const recentTrackKeys = new Set<string>()
  for (const entry of input.recent) {
    recentTrackKeys.add(legacyPlaybackTrackKey(entry.track.source, entry.track.sourceTrackId))
    upsertRecentTrack.run(
      entry.track.source,
      entry.track.sourceTrackId,
      entry.track.name,
      entry.track.singer,
      entry.track.durationMs,
      entry.track.playablePayload == null ? null : canonicalJson(entry.track.playablePayload as unknown as JsonValue),
    )
    insertRecent.run(trackId(entry.track.source, entry.track.sourceTrackId), -entry.legacyRank, entry.legacyRank)
  }

  const insertDaily = db.prepare(`
    INSERT INTO listening_daily(
      local_day, baseline_played_ms, live_played_ms, baseline_active_ms, live_active_ms, updated_at_ms
    ) VALUES(?, ?, 0, 0, 0, 0)
  `)
  for (const entry of input.listening.daily) insertDaily.run(entry.localDay, entry.baselinePlayedMs)

  const insertStatsTrack = db.prepare(`
    INSERT INTO track_snapshots(
      source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
    ) VALUES(?, ?, ?, ?, NULL, NULL, 0)
    ON CONFLICT(source, source_track_id) DO UPDATE SET
      name = excluded.name, singer = excluded.singer, duration_ms = NULL,
      playable_payload_json = NULL, updated_at_ms = 0
  `)
  const insertListeningTrack = db.prepare(`
    INSERT INTO listening_tracks(
      track_id, baseline_played_ms, live_played_ms, baseline_active_ms,
      live_active_ms, last_played_at_ms, updated_at_ms
    ) VALUES(?, ?, 0, 0, 0, NULL, 0)
  `)
  for (const entry of input.listening.tracks) {
    if (!recentTrackKeys.has(legacyPlaybackTrackKey(entry.source, entry.sourceTrackId))) {
      insertStatsTrack.run(entry.source, entry.sourceTrackId, entry.name, entry.singer)
    }
    insertListeningTrack.run(trackId(entry.source, entry.sourceTrackId), entry.baselinePlayedMs)
  }

  if (resume != null) {
    db.prepare(`
      INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id,
        list_id, index_hint, position_ms, duration_ms, updated_at_ms
      ) VALUES(1, ?, 0, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      `legacy_data_v1.playback_activity:${input.sourceSha256}`,
      resume.source,
      resume.sourceTrackId,
      resume.listId,
      resume.indexHint,
      resume.positionMs,
      resume.durationMs,
    )
  }
}

export const importLegacyPlaybackActivity = (value: unknown): LegacyPlaybackActivityImportResultV1 => {
  const input = normalizeImport(value)
  if (legacyPlaybackActivitySha256(input) != input.sourceSha256) {
    throw new Error('Legacy playback activity hash mismatch')
  }
  const transaction = getDB().transaction((): LegacyPlaybackActivityImportResultV1 => {
    const existing = getMigrationMarker(getDB(), ACTIVITY_MARKER_NAME)
    if (existing != null && existing.sourceSha256 != input.sourceSha256) {
      throw new Error(`Migration marker ${ACTIVITY_MARKER_NAME} source conflict`)
    }
    if (existing != null) {
      const details = parseMarkerDetails(input, existing.detailsJson)
      return resultFor('already-complete', input, details.resumeImported)
    }

    const resume = resolveResume(input.resume)
    const details = markerDetails(input, resume != null)
    replaceTarget(input, resume)
    if (input.failAt == 'inside-transaction') throw new Error('injected failure')
    verifyTarget(input, resume)
    if (input.failAt == 'before-marker') throw new Error('injected failure')
    putMigrationMarker(getDB(), {
      name: ACTIVITY_MARKER_NAME,
      sourceSha256: input.sourceSha256,
      completedAtMs: input.completedAtMs,
      detailsJson: canonicalJson(details as unknown as JsonValue),
    })
    return resultFor('complete', input, resume != null)
  })
  return transaction.immediate()
}

export const getPlaybackActivityMigrationMarker = (): MigrationMarker | null =>
  getMigrationMarker(getDB(), ACTIVITY_MARKER_NAME)

export {
  playbackCommit,
  playbackGetListeningStats,
  playbackGetRecent,
  playbackGetResume,
  playbackMarkStaleSessionsInterrupted,
  playbackRecordPreplayFailure,
  playbackRunTypedSmoke,
  playbackStart,
  playbackUpdateResume,
} from './repository'

export {
  playbackClearRecent,
  playbackClearStatistics,
  playbackDeleteAllActivity,
  playbackResetDeviceState,
} from './clear'

export {
  playbackCompact,
  playbackGetVacuumEligibility,
} from './retention'
