import type Database from 'better-sqlite3'
import type {
  PlaybackCheckpointAckV1,
  PlaybackClearRecentCommandV1,
  PlaybackClearStatisticsCommandV1,
  PlaybackDeleteAllActivityCommandV1,
  PlaybackResetDeviceStateCommandV1,
} from '../../../../../common/storage/playback'
import {
  parsePlaybackClearRecentCommand,
  parsePlaybackClearStatisticsCommand,
  parsePlaybackCommitRequest,
  parsePlaybackDeleteAllActivityCommand,
  parsePlaybackResetDeviceStateCommand,
} from '../../../../../common/storage/playbackValidation'
import { clearLocalStateInTransaction } from '../app_state/dbHelper'
import {
  exactRecord,
  immediate,
  localClockAt,
  newSessionUuid,
  sessionAck,
} from './dbHelper'
import {
  commitInTransaction,
  getOpenSession,
  insertSession,
  type OpenSessionRow,
} from './repository'

export type PlaybackClearStatisticsFailPoint =
  | 'after-checkpoint'
  | 'after-close'
  | 'after-rotate'
  | 'after-reset'
  | 'after-cutoff'

export interface PlaybackClearStatisticsOptions {
  failAt?: PlaybackClearStatisticsFailPoint
}

const parseClearOptions = (
  value: PlaybackClearStatisticsOptions,
): PlaybackClearStatisticsOptions => {
  const input = exactRecord(value, [], ['failAt'])
  const allowed: PlaybackClearStatisticsFailPoint[] = [
    'after-checkpoint', 'after-close', 'after-rotate', 'after-reset', 'after-cutoff',
  ]
  if (input == null || (input.failAt != null &&
    (typeof input.failAt != 'string' || !allowed.includes(input.failAt as PlaybackClearStatisticsFailPoint)))) {
    throw new Error('Invalid playback statistics clear options')
  }
  return input as PlaybackClearStatisticsOptions
}

const failAt = (
  options: PlaybackClearStatisticsOptions,
  point: PlaybackClearStatisticsFailPoint,
): void => {
  if (options.failAt == point) throw new Error('injected failure')
}

export const playbackClearRecent = (value: PlaybackClearRecentCommandV1): void => {
  const input = parsePlaybackClearRecentCommand(value)
  immediate(db => {
    db.prepare('DELETE FROM recent_tracks').run()
    const result = db.prepare(`
      UPDATE projection_state
      SET version = 1, last_session_id = NULL, visible_after_ms = ?, updated_at_ms = ?
      WHERE name = 'recent'
    `).run(input.occurredAtMs, input.occurredAtMs)
    if (result.changes != 1) throw new Error('playback_projection_state_missing')
  })
}

const validateActiveCheckpoint = (
  current: OpenSessionRow,
  input: PlaybackClearStatisticsCommandV1,
): void => {
  const checkpoint = input.activeCheckpoint
  if (checkpoint == null) throw new Error('playback_statistics_clear_checkpoint_required')
  if (checkpoint.playbackGroupUuid != current.playbackGroupUuid) {
    throw new Error('playback_statistics_clear_group_mismatch')
  }
  if (checkpoint.checkpointSeq < current.checkpointSeq) {
    throw new Error('playback_statistics_clear_checkpoint_stale')
  }
  if (checkpoint.occurredAtMs > input.occurredAtMs) {
    throw new Error('playback_statistics_clear_time_mismatch')
  }
  if (checkpoint.checkpointSeq == current.checkpointSeq &&
    (checkpoint.cumulativePlayedMs != current.cumulativePlayedMs ||
      checkpoint.cumulativeActiveMs != current.cumulativeActiveMs ||
      checkpoint.positionMs != current.lastPositionMs ||
      checkpoint.durationMs != current.durationMs)) {
    throw new Error('playback_statistics_clear_checkpoint_stale')
  }
}

const resetStatistics = (db: Database.Database, occurredAtMs: number): void => {
  db.prepare('DELETE FROM listening_daily').run()
  db.prepare('DELETE FROM listening_tracks').run()
  const result = db.prepare(`
    UPDATE activity_totals
    SET baseline_played_ms = 0, live_played_ms = 0,
      baseline_active_ms = 0, live_active_ms = 0, updated_at_ms = ?
    WHERE id = 1
  `).run(occurredAtMs)
  if (result.changes != 1) throw new Error('playback_activity_totals_missing')
}

export const playbackClearStatistics = (
  value: PlaybackClearStatisticsCommandV1,
  options: PlaybackClearStatisticsOptions = {},
): PlaybackCheckpointAckV1 | null => {
  const input = parsePlaybackClearStatisticsCommand(value)
  const parsedOptions = parseClearOptions(options)
  const activeCommit = input.activeCheckpoint == null
    ? null
    : parsePlaybackCommitRequest({ version: 1, checkpoint: input.activeCheckpoint })
  return immediate(db => {
    const openGroups = db.prepare(`
      SELECT playback_group_uuid AS playbackGroupUuid
      FROM playback_sessions
      WHERE state IN ('playing', 'paused')
      ORDER BY session_id
    `).all() as Array<{ playbackGroupUuid: string }>
    if (openGroups.length == 0 && input.activeCheckpoint != null) {
      throw new Error('playback_statistics_clear_no_active_group')
    }
    if (openGroups.length > 0 && input.activeCheckpoint == null) {
      throw new Error('playback_statistics_clear_checkpoint_required')
    }
    if (openGroups.some(row => row.playbackGroupUuid != input.activeCheckpoint?.playbackGroupUuid)) {
      throw new Error('playback_statistics_clear_checkpoint_required')
    }

    let nextAck: PlaybackCheckpointAckV1 | null = null
    if (input.activeCheckpoint != null) {
      const current = getOpenSession(db, input.activeCheckpoint.playbackGroupUuid)
      if (current == null) throw new Error('playback_statistics_clear_no_active_group')
      validateActiveCheckpoint(current, input)
      if (activeCommit == null) throw new Error('playback_statistics_clear_checkpoint_required')
      commitInTransaction(db, activeCommit)
      failAt(parsedOptions, 'after-checkpoint')

      const checkpointed = getOpenSession(db, current.playbackGroupUuid)
      if (checkpointed == null || input.occurredAtMs < checkpointed.startedAtMs) {
        throw new Error('playback_statistics_clear_time_mismatch')
      }
      const activeState = checkpointed.state
      const closed = db.prepare(`
        UPDATE playback_sessions
        SET state = 'closed', end_reason = 'statistics_clear', ended_at_ms = ?
        WHERE session_id = ? AND state IN ('playing', 'paused')
      `).run(input.occurredAtMs, checkpointed.sessionId)
      if (closed.changes != 1) throw new Error('playback_statistics_clear_rotation_failed')
      failAt(parsedOptions, 'after-close')

      const clock = localClockAt(input.occurredAtMs)
      const next = insertSession(db, {
        sessionUuid: newSessionUuid(),
        playbackGroupUuid: checkpointed.playbackGroupUuid,
        segmentNo: checkpointed.segmentNo + 1,
        trackId: checkpointed.trackId,
        localDay: clock.localDay,
        utcOffsetMinutes: clock.utcOffsetMinutes,
        contextType: checkpointed.contextType,
        contextId: checkpointed.contextId,
        startReason: 'statistics_clear',
        endReason: null,
        startedAtMs: input.occurredAtMs,
        endedAtMs: null,
        startPositionMs: checkpointed.lastPositionMs,
        lastPositionMs: checkpointed.lastPositionMs,
        durationMs: checkpointed.durationMs,
        playedMs: 0,
        activeMs: 0,
        cumulativePlayedMs: checkpointed.cumulativePlayedMs,
        cumulativeActiveMs: checkpointed.cumulativeActiveMs,
        checkpointSeq: checkpointed.checkpointSeq,
        state: activeState,
        recentAllowed: checkpointed.recentAllowed == 1,
        statsAllowed: checkpointed.statsAllowed == 1,
      })
      nextAck = sessionAck(next)
      failAt(parsedOptions, 'after-rotate')
    }

    resetStatistics(db, input.occurredAtMs)
    failAt(parsedOptions, 'after-reset')
    const cutoff = db.prepare(`
      UPDATE projection_state
      SET version = 1, last_session_id = NULL, visible_after_ms = ?, updated_at_ms = ?
      WHERE name = 'statistics'
    `).run(input.occurredAtMs, input.occurredAtMs)
    if (cutoff.changes != 1) throw new Error('playback_projection_state_missing')
    failAt(parsedOptions, 'after-cutoff')
    return nextAck
  })
}

export const playbackDeleteAllActivity = (value: PlaybackDeleteAllActivityCommandV1): void => {
  const input = parsePlaybackDeleteAllActivityCommand(value)
  immediate(db => {
    db.prepare('DELETE FROM playback_resume_state').run()
    db.prepare('DELETE FROM recent_tracks').run()
    db.prepare('DELETE FROM listening_daily').run()
    db.prepare('DELETE FROM listening_tracks').run()
    db.prepare('DELETE FROM playback_sessions').run()
    resetStatistics(db, input.occurredAtMs)
    const state = db.prepare(`
      UPDATE projection_state
      SET version = 1, last_session_id = NULL, visible_after_ms = NULL, updated_at_ms = ?
    `).run(input.occurredAtMs)
    if (state.changes != 2) throw new Error('playback_projection_state_missing')
    db.prepare(`
      DELETE FROM track_snapshots
      WHERE NOT EXISTS (
        SELECT 1 FROM playback_sessions WHERE playback_sessions.track_id = track_snapshots.track_id
      ) AND NOT EXISTS (
        SELECT 1 FROM recent_tracks WHERE recent_tracks.track_id = track_snapshots.track_id
      ) AND NOT EXISTS (
        SELECT 1 FROM listening_tracks WHERE listening_tracks.track_id = track_snapshots.track_id
      )
    `).run()
  })
}

export const playbackResetDeviceState = (value: PlaybackResetDeviceStateCommandV1): void => {
  parsePlaybackResetDeviceStateCommand(value)
  immediate(db => {
    clearLocalStateInTransaction(db)
    db.prepare('DELETE FROM playback_resume_state').run()
  })
}
