import type Database from 'better-sqlite3'
import type {
  ListeningBucketV1,
  ListeningStatsV1,
  RecentTrackV1,
} from '../../../../../common/storage/playback'
import {
  parseListeningStats,
  parseRecentTrack,
} from '../../../../../common/storage/playbackValidation'

const MAX_RECENT_TRACKS = 520

const hasListeningPlayCount = (db: Database.Database): boolean =>
  (db.pragma('table_xinfo("listening_tracks")') as Array<{ name: unknown }>)
    .some(column => column.name == 'play_count')

const projectionCutoff = (
  db: Database.Database,
  name: 'recent' | 'statistics',
): number | null => {
  const row = db.prepare(`
    SELECT visible_after_ms AS visibleAfterMs
    FROM projection_state WHERE name = ?
  `).get(name) as { visibleAfterMs: number | null } | undefined
  if (row == null) throw new Error('playback_projection_state_missing')
  return row.visibleAfterMs
}

export const updateRecentProjection = (
  db: Database.Database,
  trackId: number,
  sessionId: number,
  occurredAtMs: number,
): void => {
  const cutoff = projectionCutoff(db, 'recent')
  if (cutoff != null && occurredAtMs < cutoff) return
  const row = db.prepare(`
    SELECT MAX(recency_seq) AS maxSequence
    FROM recent_tracks
  `).get() as { maxSequence: number | null }
  const nextSequence = Math.max(row.maxSequence ?? 0, 0) + 1
  if (!Number.isSafeInteger(nextSequence)) throw new Error('playback_recent_sequence_exhausted')
  db.prepare(`
    INSERT INTO recent_tracks(
      track_id, recency_seq, last_session_id, last_played_at_ms, legacy_rank, updated_at_ms
    ) VALUES(?, ?, ?, ?, NULL, ?)
    ON CONFLICT(track_id) DO UPDATE SET
      recency_seq = excluded.recency_seq,
      last_session_id = excluded.last_session_id,
      last_played_at_ms = excluded.last_played_at_ms,
      legacy_rank = NULL,
      updated_at_ms = excluded.updated_at_ms
  `).run(trackId, nextSequence, sessionId, occurredAtMs, occurredAtMs)
  db.prepare(`
    DELETE FROM recent_tracks
    WHERE track_id IN (
      SELECT track_id FROM recent_tracks
      ORDER BY recency_seq DESC
      LIMIT -1 OFFSET ?
    )
  `).run(MAX_RECENT_TRACKS)
  db.prepare(`
    UPDATE projection_state
    SET last_session_id = ?, updated_at_ms = ?
    WHERE name = 'recent'
  `).run(sessionId, occurredAtMs)
}

export interface ListeningDelta {
  trackId: number
  sessionId: number
  localDay: string
  startedAtMs: number
  playedMs: number
  activeMs: number
  occurredAtMs: number
}

export const incrementListeningPlayCount = (
  db: Database.Database,
  trackId: number,
  sessionId: number,
  startedAtMs: number,
): void => {
  if (!hasListeningPlayCount(db)) return
  const session = db.prepare(`
    SELECT track_id AS trackId
    FROM playback_sessions
    WHERE session_id = ? AND segment_no = 0 AND stats_allowed = 1 AND started_at_ms = ?
  `).get(sessionId, startedAtMs) as { trackId: number } | undefined
  if (session?.trackId != trackId) throw new Error('playback_play_count_session_invalid')
  const cutoff = projectionCutoff(db, 'statistics')
  if (cutoff != null && startedAtMs < cutoff) return
  const current = db.prepare(`
    SELECT play_count AS playCount FROM listening_tracks WHERE track_id = ?
  `).get(trackId) as { playCount: number } | undefined
  if (current?.playCount == Number.MAX_SAFE_INTEGER) {
    throw new Error('playback_play_count_overflow')
  }
  db.prepare(`
    INSERT INTO listening_tracks(track_id, last_played_at_ms, updated_at_ms, play_count)
    VALUES(?, ?, ?, 1)
    ON CONFLICT(track_id) DO UPDATE SET
      play_count = play_count + 1,
      last_played_at_ms = excluded.last_played_at_ms,
      updated_at_ms = excluded.updated_at_ms
  `).run(trackId, startedAtMs, startedAtMs)
}

interface StoredBucket {
  baselinePlayedMs: number
  livePlayedMs: number
  baselineActiveMs: number
  liveActiveMs: number
}

const EMPTY_BUCKET: StoredBucket = {
  baselinePlayedMs: 0,
  livePlayedMs: 0,
  baselineActiveMs: 0,
  liveActiveMs: 0,
}

const assertProjectionCapacity = (
  row: StoredBucket | undefined,
  playedDelta: number,
  activeDelta: number,
): void => {
  const value = row ?? EMPTY_BUCKET
  const limit = BigInt(Number.MAX_SAFE_INTEGER)
  if (BigInt(value.baselinePlayedMs) + BigInt(value.livePlayedMs) + BigInt(playedDelta) > limit ||
    BigInt(value.baselineActiveMs) + BigInt(value.liveActiveMs) + BigInt(activeDelta) > limit) {
    throw new Error('playback_projection_overflow')
  }
}

export const updateListeningProjections = (
  db: Database.Database,
  delta: ListeningDelta,
  afterDaily?: () => void,
): void => {
  const cutoff = projectionCutoff(db, 'statistics')
  if (cutoff != null && delta.startedAtMs < cutoff) return
  if (delta.playedMs == 0 && delta.activeMs == 0) return
  const columns = `
    baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
    baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs
  `
  assertProjectionCapacity(
    db.prepare(`SELECT ${columns} FROM activity_totals WHERE id = 1`).get() as StoredBucket | undefined,
    delta.playedMs,
    delta.activeMs,
  )
  assertProjectionCapacity(
    db.prepare(`SELECT ${columns} FROM listening_daily WHERE local_day = ?`)
      .get(delta.localDay) as StoredBucket | undefined,
    delta.playedMs,
    delta.activeMs,
  )
  assertProjectionCapacity(
    db.prepare(`SELECT ${columns} FROM listening_tracks WHERE track_id = ?`)
      .get(delta.trackId) as StoredBucket | undefined,
    delta.playedMs,
    delta.activeMs,
  )
  db.prepare(`
    INSERT INTO listening_daily(
      local_day, baseline_played_ms, live_played_ms,
      baseline_active_ms, live_active_ms, updated_at_ms
    ) VALUES(?, 0, ?, 0, ?, ?)
    ON CONFLICT(local_day) DO UPDATE SET
      live_played_ms = live_played_ms + excluded.live_played_ms,
      live_active_ms = live_active_ms + excluded.live_active_ms,
      updated_at_ms = excluded.updated_at_ms
  `).run(delta.localDay, delta.playedMs, delta.activeMs, delta.occurredAtMs)
  afterDaily?.()
  db.prepare(`
    INSERT INTO listening_tracks(
      track_id, baseline_played_ms, live_played_ms,
      baseline_active_ms, live_active_ms, last_played_at_ms, updated_at_ms
    ) VALUES(?, 0, ?, 0, ?, ?, ?)
    ON CONFLICT(track_id) DO UPDATE SET
      live_played_ms = live_played_ms + excluded.live_played_ms,
      live_active_ms = live_active_ms + excluded.live_active_ms,
      last_played_at_ms = excluded.last_played_at_ms,
      updated_at_ms = excluded.updated_at_ms
  `).run(
    delta.trackId,
    delta.playedMs,
    delta.activeMs,
    delta.occurredAtMs,
    delta.occurredAtMs,
  )
  db.prepare(`
    UPDATE activity_totals
    SET live_played_ms = live_played_ms + ?,
      live_active_ms = live_active_ms + ?,
      updated_at_ms = ?
    WHERE id = 1
  `).run(delta.playedMs, delta.activeMs, delta.occurredAtMs)
  db.prepare(`
    UPDATE projection_state
    SET last_session_id = ?, updated_at_ms = ?
    WHERE name = 'statistics'
  `).run(delta.sessionId, delta.occurredAtMs)
}

export const readRecentProjection = (
  db: Database.Database,
  limit: number,
): RecentTrackV1[] => (db.prepare(`
  SELECT track.source, track.source_track_id AS sourceTrackId,
    track.name, track.singer, track.duration_ms AS durationMs,
    track.playable_payload_json AS playablePayloadJson,
    recent.last_played_at_ms AS lastPlayedAtMs, recent.legacy_rank AS legacyRank
  FROM recent_tracks recent
  JOIN track_snapshots track ON track.track_id = recent.track_id
  WHERE (SELECT visible_after_ms FROM projection_state WHERE name = 'recent') IS NULL
    OR recent.last_played_at_ms >= (
      SELECT visible_after_ms FROM projection_state WHERE name = 'recent'
    )
  ORDER BY recent.recency_seq DESC
  LIMIT ?
`).all(limit) as Array<Record<string, unknown>>).map(row => parseRecentTrack({
  version: 1,
  source: row.source,
  sourceTrackId: row.sourceTrackId,
  name: row.name,
  singer: row.singer,
  durationMs: row.durationMs,
  playablePayload: typeof row.playablePayloadJson == 'string'
    ? JSON.parse(row.playablePayloadJson)
    : null,
  lastPlayedAtMs: row.lastPlayedAtMs,
  legacyRank: row.legacyRank,
}))

const bucket = (row: Record<string, unknown>): ListeningBucketV1 => {
  const baselinePlayedMs = row.baselinePlayedMs as number
  const livePlayedMs = row.livePlayedMs as number
  const baselineActiveMs = row.baselineActiveMs as number
  const liveActiveMs = row.liveActiveMs as number
  return {
    baselinePlayedMs,
    livePlayedMs,
    baselineActiveMs,
    liveActiveMs,
    playedMs: baselinePlayedMs + livePlayedMs,
    activeMs: baselineActiveMs + liveActiveMs,
  }
}

export const readListeningStats = (db: Database.Database): ListeningStatsV1 => {
  const playCountColumn = hasListeningPlayCount(db)
    ? 'listening.play_count AS playCount'
    : '0 AS playCount'
  const total = db.prepare(`
    SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
      baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs,
      updated_at_ms AS updatedAtMs
    FROM activity_totals WHERE id = 1
  `).get() as Record<string, unknown>
  const daily = (db.prepare(`
    SELECT local_day AS localDay, baseline_played_ms AS baselinePlayedMs,
      live_played_ms AS livePlayedMs, baseline_active_ms AS baselineActiveMs,
      live_active_ms AS liveActiveMs
    FROM listening_daily
    WHERE (SELECT visible_after_ms FROM projection_state WHERE name = 'statistics') IS NULL
      OR updated_at_ms >= (
        SELECT visible_after_ms FROM projection_state WHERE name = 'statistics'
      )
    ORDER BY local_day
  `).all() as Array<Record<string, unknown>>).map(row => ({
    ...bucket(row),
    localDay: row.localDay as string,
  }))
  const tracks = (db.prepare(`
    SELECT track.source, track.source_track_id AS sourceTrackId, track.name, track.singer,
      track.duration_ms AS durationMs, listening.baseline_played_ms AS baselinePlayedMs,
      listening.live_played_ms AS livePlayedMs,
      listening.baseline_active_ms AS baselineActiveMs,
      listening.live_active_ms AS liveActiveMs,
      ${playCountColumn}
    FROM listening_tracks listening
    JOIN track_snapshots track ON track.track_id = listening.track_id
    WHERE (SELECT visible_after_ms FROM projection_state WHERE name = 'statistics') IS NULL
      OR listening.updated_at_ms >= (
        SELECT visible_after_ms FROM projection_state WHERE name = 'statistics'
      )
    ORDER BY
      listening.baseline_played_ms + listening.live_played_ms DESC,
      track.source COLLATE BINARY,
      track.source_track_id COLLATE BINARY
  `).all() as Array<Record<string, unknown>>).map(row => ({
    ...bucket(row),
    source: row.source as string,
    sourceTrackId: row.sourceTrackId as string,
    name: row.name as string,
    singer: row.singer as string,
    durationMs: row.durationMs as number | null,
    playCount: row.playCount as number,
  }))
  return parseListeningStats({
    version: 1,
    total: bucket(total),
    daily,
    tracks,
    updatedAtMs: total.updatedAtMs,
  })
}
