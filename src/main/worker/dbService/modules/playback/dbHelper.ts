import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { canonicalJson, type JsonValue } from '../../../../../common/storage/canonicalJson'
import type {
  PlaybackCheckpointAckV1,
  PlaybackResumeAckV1,
  PlaybackTrackV1,
} from '../../../../../common/storage/playback'
import { getDB } from '../../db'
import {
  SELECT_RESUME_ROW,
  SELECT_SESSION_ACK,
  UPSERT_RESUME,
  UPSERT_TRACK,
} from './statements'

export interface SessionAckRow {
  sessionId: number
  sessionUuid: string
  playbackGroupUuid: string
  segmentNo: number
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
}

export interface ResumeRow {
  playbackGroupUuid: string
  checkpointSeq: number
  source: string
  sourceTrackId: string
  listId: string | null
  indexHint: number | null
  positionMs: number
  durationMs: number | null
  updatedAtMs: number
}

export const immediate = <T>(callback: (db: Database.Database) => T): T => {
  const db = getDB()
  return db.transaction(() => callback(db)).immediate()
}

export const localClockAt = (occurredAtMs: number): { localDay: string, utcOffsetMinutes: number } => {
  const date = new Date(occurredAtMs)
  const localDay = [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-')
  return { localDay, utcOffsetMinutes: -date.getTimezoneOffset() }
}

export const newSessionUuid = (): string => randomUUID()

export const sessionAck = (row: SessionAckRow): PlaybackCheckpointAckV1 => ({
  playbackGroupUuid: row.playbackGroupUuid,
  sessionUuid: row.sessionUuid,
  segmentNo: row.segmentNo,
  checkpointSeq: row.checkpointSeq,
  cumulativePlayedMs: row.cumulativePlayedMs,
  cumulativeActiveMs: row.cumulativeActiveMs,
})

export const resumeAck = (row: Pick<ResumeRow, 'playbackGroupUuid' | 'checkpointSeq' | 'positionMs'>): PlaybackResumeAckV1 => ({
  playbackGroupUuid: row.playbackGroupUuid,
  checkpointSeq: row.checkpointSeq,
  positionMs: row.positionMs,
})

export const getSessionAck = (
  db: Database.Database,
  playbackGroupUuid: string,
): SessionAckRow | null => (db.prepare(SELECT_SESSION_ACK).get(playbackGroupUuid) as SessionAckRow | undefined) ?? null

export const getResumeRow = (db: Database.Database): ResumeRow | null =>
  (db.prepare(SELECT_RESUME_ROW).get() as ResumeRow | undefined) ?? null

export const upsertTrack = (
  db: Database.Database,
  track: PlaybackTrackV1,
  updatedAtMs: number,
): number => {
  db.prepare(UPSERT_TRACK).run(
    track.source,
    track.sourceTrackId,
    track.name,
    track.singer,
    track.durationMs,
    track.playablePayload == null
      ? null
      : canonicalJson(track.playablePayload as unknown as JsonValue),
    updatedAtMs,
  )
  const row = db.prepare(`
    SELECT track_id AS trackId
    FROM track_snapshots
    WHERE source = ? AND source_track_id = ?
  `).get(track.source, track.sourceTrackId) as { trackId?: unknown } | undefined
  if (row == null || !Number.isSafeInteger(row.trackId)) throw new Error('playback_track_write_failed')
  return row.trackId as number
}

export interface ResumeWrite {
  playbackGroupUuid: string
  checkpointSeq: number
  source: string
  sourceTrackId: string
  listId: string | null
  indexHint: number | null
  positionMs: number
  durationMs: number | null
  updatedAtMs: number
}

export const putResume = (db: Database.Database, value: ResumeWrite): ResumeRow => {
  db.prepare(UPSERT_RESUME).run(
    value.playbackGroupUuid,
    value.checkpointSeq,
    value.source,
    value.sourceTrackId,
    value.listId,
    value.indexHint,
    value.positionMs,
    value.durationMs,
    value.updatedAtMs,
  )
  const stored = getResumeRow(db)
  if (stored == null) throw new Error('playback_resume_write_failed')
  return stored
}

export const exactRecord = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> => {
  try {
    if (value == null || typeof value != 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) != Object.prototype) return false
    const actual = Object.keys(value)
    return actual.length == keys.length && actual.every(key => keys.includes(key))
  } catch {
    return false
  }
}

export const safeInteger = (value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
