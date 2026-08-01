import fs from 'node:fs'
import path from 'node:path'
import type Database from 'better-sqlite3'
import type {
  PlaybackCompactCommandV1,
  PlaybackCompactResultV1,
  PlaybackVacuumEligibilityCommandV1,
  PlaybackVacuumEligibilityReasonV1,
  PlaybackVacuumEligibilityResultV1,
} from '../../../../../common/storage/playback'
import {
  parsePlaybackCompactCommand,
  parsePlaybackCompactResult,
  parsePlaybackVacuumEligibilityCommand,
  parsePlaybackVacuumEligibilityResult,
} from '../../../../../common/storage/playbackValidation'
import { getDB } from '../../db'
import { immediate } from './dbHelper'

const RETENTION_AGE_MS = 365 * 24 * 60 * 60 * 1000
const RETAINED_TERMINAL_SESSIONS = 100_000
const VACUUM_FREE_RATIO = 0.25
const VACUUM_DISK_MARGIN_BYTES = 64 * 1024 * 1024

interface RetentionRow {
  sessionId: number
  trackId: number
  localDay: string
  startedAtMs: number
  playedMs: number
  activeMs: number
  statsAllowed: 0 | 1
}

interface StoredProjectionBucket {
  livePlayedMs: number
  liveActiveMs: number
}

const ELIGIBLE_CTE = `
  WITH ranked_terminal AS (
    SELECT session_id, track_id, local_day, started_at_ms, ended_at_ms,
      played_ms, active_ms, stats_allowed,
      ROW_NUMBER() OVER (ORDER BY ended_at_ms DESC, session_id DESC) AS retention_rank
    FROM playback_sessions
    WHERE state IN ('closed', 'interrupted')
  )
`

const assertTransferBucket = (
  row: StoredProjectionBucket | undefined,
  playedMs: number,
  activeMs: number,
): void => {
  if (row == null || row.livePlayedMs < playedMs || row.liveActiveMs < activeMs) {
    throw new Error('playback_retention_projection_invariant')
  }
}

const transferContribution = (
  db: Database.Database,
  row: RetentionRow,
): void => {
  if (row.playedMs == 0 && row.activeMs == 0) return
  const columns = `
    live_played_ms AS livePlayedMs, live_active_ms AS liveActiveMs
  `
  assertTransferBucket(
    db.prepare(`SELECT ${columns} FROM activity_totals WHERE id = 1`)
      .get() as StoredProjectionBucket | undefined,
    row.playedMs,
    row.activeMs,
  )
  assertTransferBucket(
    db.prepare(`SELECT ${columns} FROM listening_daily WHERE local_day = ?`)
      .get(row.localDay) as StoredProjectionBucket | undefined,
    row.playedMs,
    row.activeMs,
  )
  assertTransferBucket(
    db.prepare(`SELECT ${columns} FROM listening_tracks WHERE track_id = ?`)
      .get(row.trackId) as StoredProjectionBucket | undefined,
    row.playedMs,
    row.activeMs,
  )

  const values = [row.playedMs, row.playedMs, row.activeMs, row.activeMs]
  const update = `
    SET baseline_played_ms = baseline_played_ms + ?, live_played_ms = live_played_ms - ?,
      baseline_active_ms = baseline_active_ms + ?, live_active_ms = live_active_ms - ?
  `
  const daily = db.prepare(`UPDATE listening_daily ${update} WHERE local_day = ?`)
    .run(...values, row.localDay)
  const track = db.prepare(`UPDATE listening_tracks ${update} WHERE track_id = ?`)
    .run(...values, row.trackId)
  const total = db.prepare(`UPDATE activity_totals ${update} WHERE id = 1`).run(...values)
  if (daily.changes != 1 || track.changes != 1 || total.changes != 1) {
    throw new Error('playback_retention_projection_invariant')
  }
}

export const playbackCompact = (value: PlaybackCompactCommandV1): PlaybackCompactResultV1 => {
  const input = parsePlaybackCompactCommand(value)
  return immediate(db => {
    const thresholdMs = input.nowMs - RETENTION_AGE_MS
    const rows = db.prepare(`${ELIGIBLE_CTE}
      SELECT session_id AS sessionId, track_id AS trackId, local_day AS localDay,
        started_at_ms AS startedAtMs, played_ms AS playedMs, active_ms AS activeMs,
        stats_allowed AS statsAllowed
      FROM ranked_terminal
      WHERE ended_at_ms < ? OR retention_rank > ?
      ORDER BY ended_at_ms, session_id
      LIMIT ?
    `).all(thresholdMs, RETAINED_TERMINAL_SESSIONS, input.batchSize) as RetentionRow[]
    const state = db.prepare(`
      SELECT visible_after_ms AS visibleAfterMs
      FROM projection_state WHERE name = 'statistics'
    `).get() as { visibleAfterMs: number | null } | undefined
    if (state == null) throw new Error('playback_projection_state_missing')

    for (const row of rows) {
      if (row.statsAllowed == 1 &&
        (state.visibleAfterMs == null || row.startedAtMs >= state.visibleAfterMs)) {
        transferContribution(db, row)
      }
      if (db.prepare('DELETE FROM playback_sessions WHERE session_id = ?').run(row.sessionId).changes != 1) {
        throw new Error('playback_retention_delete_failed')
      }
    }

    const remaining = db.prepare(`${ELIGIBLE_CTE}
      SELECT COUNT(*) AS count
      FROM ranked_terminal
      WHERE ended_at_ms < ? OR retention_rank > ?
    `).get(thresholdMs, RETAINED_TERMINAL_SESSIONS) as { count: number }
    return parsePlaybackCompactResult({
      version: 1,
      deleted: rows.length,
      remainingEligible: remaining.count,
    })
  })
}

interface VacuumMetrics {
  pageCount: number
  freelistCount: number
  pageSize: number
  databaseFileBytes: number
  availableFreeBytes: number
}

interface VacuumDecision {
  eligible: boolean
  reason: PlaybackVacuumEligibilityReasonV1
  freePageRatio: number
  requiredFreeBytes: number
}

export const evaluateVacuumEligibility = (metrics: VacuumMetrics): VacuumDecision => {
  const freePageRatio = metrics.pageCount == 0 ? 0 : metrics.freelistCount / metrics.pageCount
  const requiredFreeBytes = 2 * metrics.databaseFileBytes + VACUUM_DISK_MARGIN_BYTES
  if (freePageRatio <= VACUUM_FREE_RATIO) {
    return { eligible: false, reason: 'insufficient_free_pages', freePageRatio, requiredFreeBytes }
  }
  if (metrics.availableFreeBytes < requiredFreeBytes) {
    return { eligible: false, reason: 'insufficient_disk_space', freePageRatio, requiredFreeBytes }
  }
  return { eligible: true, reason: 'eligible', freePageRatio, requiredFreeBytes }
}

const safeFilesystemBytes = (value: number): number =>
  Math.min(Math.max(Math.floor(value), 0), Number.MAX_SAFE_INTEGER)

export const playbackGetVacuumEligibility = (
  value: PlaybackVacuumEligibilityCommandV1,
): PlaybackVacuumEligibilityResultV1 => {
  parsePlaybackVacuumEligibilityCommand(value)
  const db = getDB()
  const pageCount = db.pragma('page_count', { simple: true }) as number
  const freelistCount = db.pragma('freelist_count', { simple: true }) as number
  const pageSize = db.pragma('page_size', { simple: true }) as number
  const databaseFileBytes = safeFilesystemBytes(fs.statSync(db.name).size)
  const filesystem = fs.statfsSync(path.dirname(db.name))
  const availableFreeBytes = safeFilesystemBytes(filesystem.bavail * filesystem.bsize)
  const decision = evaluateVacuumEligibility({
    pageCount,
    freelistCount,
    pageSize,
    databaseFileBytes,
    availableFreeBytes,
  })
  return parsePlaybackVacuumEligibilityResult({
    version: 1,
    ...decision,
    pageCount,
    freelistCount,
    pageSize,
    databaseFileBytes,
    availableFreeBytes,
  })
}
