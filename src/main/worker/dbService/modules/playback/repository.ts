import type Database from 'better-sqlite3'
import type {
  PlaybackCheckpointAckV1,
  PlaybackCommitRequestV1,
  PlaybackFactV1,
  PlaybackPreplayFailureV1,
  PlaybackResumeAckV1,
  PlaybackResumeUpdateV1,
  PlaybackResumeV1,
  PlaybackStartCommandV1,
  PlaybackStartResultV1,
  RecentTrackV1,
  ListeningStatsV1,
} from '../../../../../common/storage/playback'
import {
  classifyPlaybackMode,
  parsePlaybackCheckpointAck,
  parsePlaybackCommitRequest,
  parsePlaybackPreplayFailure,
  parsePlaybackResume,
  parsePlaybackResumeAck,
  parsePlaybackResumeUpdate,
  parsePlaybackStartCommand,
  parsePlaybackStartResult,
} from '../../../../../common/storage/playbackValidation'
import { canonicalJson, type JsonValue } from '../../../../../common/storage/canonicalJson'
import { phase3Evidence } from '../../../../../common/storage/phase3'
import { getAppDB } from '../../db'
import {
  exactRecord,
  getResumeRow,
  getSessionAck,
  immediate,
  isImmediateLocalDayBoundary,
  localClockAt,
  newSessionUuid,
  putResume,
  resumeAck,
  safeInteger,
  sessionAck,
  type ResumeRow,
  type SessionAckRow,
  upsertTrack,
} from './dbHelper'
import {
  incrementListeningPlayCount,
  readListeningStats,
  readRecentProjection,
  updateListeningProjections,
  updateRecentProjection,
} from './projections'
import {
  INSERT_EVENT,
  INSERT_SESSION,
  SELECT_OPEN_SESSION,
} from './statements'

export interface OpenSessionRow extends SessionAckRow {
  trackId: number
  localDay: string
  utcOffsetMinutes: number
  contextType: string | null
  contextId: string | null
  startedAtMs: number
  lastPositionMs: number
  durationMs: number | null
  playedMs: number
  activeMs: number
  state: 'playing' | 'paused'
  recentAllowed: 0 | 1
  statsAllowed: 0 | 1
  source: string
  sourceTrackId: string
}

export type PlaybackCommitFailPoint = 'after-daily'

export interface PlaybackCommitOptions {
  failAt?: PlaybackCommitFailPoint
}

export const getOpenSession = (
  db: Database.Database,
  playbackGroupUuid: string,
): OpenSessionRow | null =>
  (db.prepare(SELECT_OPEN_SESSION).get(playbackGroupUuid) as OpenSessionRow | undefined) ?? null

export const insertSession = (
  db: Database.Database,
  value: {
    sessionUuid: string
    playbackGroupUuid: string
    segmentNo: number
    trackId: number
    localDay: string
    utcOffsetMinutes: number
    contextType: string | null
    contextId: string | null
    startReason: PlaybackStartCommandV1['startReason']
    endReason: string | null
    startedAtMs: number
    endedAtMs: number | null
    startPositionMs: number
    lastPositionMs: number
    durationMs: number | null
    playedMs: number
    activeMs: number
    cumulativePlayedMs: number
    cumulativeActiveMs: number
    checkpointSeq: number
    state: 'playing' | 'paused' | 'closed'
    recentAllowed: boolean
    statsAllowed: boolean
  },
): SessionAckRow => {
  const result = db.prepare(INSERT_SESSION).run(
    value.sessionUuid,
    value.playbackGroupUuid,
    value.segmentNo,
    value.trackId,
    value.localDay,
    value.utcOffsetMinutes,
    value.contextType,
    value.contextId,
    value.startReason,
    value.endReason,
    value.startedAtMs,
    value.endedAtMs,
    value.startPositionMs,
    value.lastPositionMs,
    value.durationMs,
    value.playedMs,
    value.activeMs,
    value.cumulativePlayedMs,
    value.cumulativeActiveMs,
    value.checkpointSeq,
    value.state,
    value.recentAllowed ? 1 : 0,
    value.statsAllowed ? 1 : 0,
    value.startedAtMs,
  )
  const sessionId = Number(result.lastInsertRowid)
  return {
    sessionId,
    sessionUuid: value.sessionUuid,
    playbackGroupUuid: value.playbackGroupUuid,
    segmentNo: value.segmentNo,
    checkpointSeq: value.checkpointSeq,
    cumulativePlayedMs: value.cumulativePlayedMs,
    cumulativeActiveMs: value.cumulativeActiveMs,
  }
}

const factColumns = (
  fact: PlaybackFactV1,
): { reason: string | null, detailsJson: string | null } => {
  switch (fact.type) {
    case 'play_start':
    case 'pause':
    case 'resume':
    case 'play_end':
      return { reason: fact.reason, detailsJson: null }
    case 'seek':
      return {
        reason: fact.origin,
        detailsJson: canonicalJson({ fromMs: fact.fromMs, toMs: fact.toMs }),
      }
    case 'skip':
      return {
        reason: fact.reason,
        detailsJson: canonicalJson({ automatic: fact.automatic }),
      }
    case 'error': {
      const details: JsonValue = {
        stage: fact.stage,
        code: fact.code,
        recoverable: fact.recoverable,
        attempt: fact.attempt,
      }
      return {
        reason: null,
        detailsJson: canonicalJson(details),
      }
    }
  }
}

const insertEvent = (
  db: Database.Database,
  sessionId: number,
  sequenceNo: number,
  occurredAtMs: number,
  positionMs: number,
  fact: PlaybackFactV1,
): void => {
  const columns = factColumns(fact)
  db.prepare(INSERT_EVENT).run(
    sessionId,
    sequenceNo,
    fact.type,
    occurredAtMs,
    positionMs,
    columns.reason,
    columns.detailsJson,
  )
}

const terminalReason = (fact: PlaybackFactV1 | undefined): string | null => {
  if (fact?.type == 'skip') return fact.reason
  if (fact?.type == 'play_end') return fact.reason
  if (fact?.type == 'error' && !fact.recoverable) return 'error'
  return null
}

const stateAfter = (
  current: OpenSessionRow['state'],
  fact: PlaybackFactV1 | undefined,
): OpenSessionRow['state'] | 'closed' => {
  if (terminalReason(fact) != null) return 'closed'
  if (fact?.type == 'pause') return 'paused'
  if (fact?.type == 'resume') return 'playing'
  return current
}

const writeStartResume = (
  db: Database.Database,
  input: PlaybackStartCommandV1,
  checkpointSeq: number,
): ResumeRow => putResume(db, {
  playbackGroupUuid: input.playbackGroupUuid,
  checkpointSeq,
  source: input.track.source,
  sourceTrackId: input.track.sourceTrackId,
  listId: input.resume.listId,
  indexHint: input.resume.indexHint,
  positionMs: input.startPositionMs,
  durationMs: input.track.durationMs,
  updatedAtMs: input.occurredAtMs,
})

export const startInTransaction = (
  db: Database.Database,
  input: PlaybackStartCommandV1,
): PlaybackStartResultV1 => {
  const existingSession = getSessionAck(db, input.playbackGroupUuid)
  if (existingSession != null) return { mode: 'activity', ack: sessionAck(existingSession) }
  const existingResume = getResumeRow(db)
  if (existingResume?.playbackGroupUuid == input.playbackGroupUuid) {
    return { mode: 'resume-only', ack: resumeAck(existingResume) }
  }

  const mode = classifyPlaybackMode(input.consent)
  if (mode == 'private') {
    return { mode: 'private', playbackGroupUuid: input.playbackGroupUuid, checkpointSeq: 0 }
  }
  if (mode == 'resume-only') {
    return { mode: 'resume-only', ack: resumeAck(writeStartResume(db, input, 1)) }
  }

  const clock = localClockAt(input.occurredAtMs)
  const trackId = upsertTrack(db, input.track, input.occurredAtMs)
  const row = insertSession(db, {
    sessionUuid: newSessionUuid(),
    playbackGroupUuid: input.playbackGroupUuid,
    segmentNo: 0,
    trackId,
    localDay: clock.localDay,
    utcOffsetMinutes: clock.utcOffsetMinutes,
    contextType: input.context.type,
    contextId: input.context.id,
    startReason: input.startReason,
    endReason: null,
    startedAtMs: input.occurredAtMs,
    endedAtMs: null,
    startPositionMs: input.startPositionMs,
    lastPositionMs: input.startPositionMs,
    durationMs: input.track.durationMs,
    playedMs: 0,
    activeMs: 0,
    cumulativePlayedMs: 0,
    cumulativeActiveMs: 0,
    checkpointSeq: 1,
    state: 'playing',
    recentAllowed: input.consent.recentAllowed,
    statsAllowed: input.consent.statsAllowed,
  })
  insertEvent(db, row.sessionId, 1, input.occurredAtMs, input.startPositionMs, {
    version: 1,
    type: 'play_start',
    reason: input.startReason,
  })
  if (input.consent.statsAllowed) {
    incrementListeningPlayCount(db, trackId, row.sessionId, input.occurredAtMs)
  }
  if (input.consent.recentAllowed) {
    updateRecentProjection(db, trackId, row.sessionId, input.occurredAtMs)
  }
  writeStartResume(db, input, 1)
  return { mode: 'activity', ack: sessionAck(row) }
}

export const playbackStart = (value: PlaybackStartCommandV1): PlaybackStartResultV1 => {
  const input = parsePlaybackStartCommand(value)
  return immediate(db => startInTransaction(db, input))
}

const updateResumeForCommit = (
  db: Database.Database,
  session: OpenSessionRow,
  input: PlaybackCommitRequestV1,
): void => {
  const stored = getResumeRow(db)
  if (stored != null && stored.playbackGroupUuid != session.playbackGroupUuid &&
    input.checkpoint.occurredAtMs < stored.updatedAtMs) return
  putResume(db, {
    playbackGroupUuid: session.playbackGroupUuid,
    checkpointSeq: input.checkpoint.checkpointSeq,
    source: session.source,
    sourceTrackId: session.sourceTrackId,
    listId: stored?.playbackGroupUuid == session.playbackGroupUuid ? stored.listId : null,
    indexHint: stored?.playbackGroupUuid == session.playbackGroupUuid ? stored.indexHint : null,
    positionMs: input.checkpoint.positionMs,
    durationMs: input.checkpoint.durationMs,
    updatedAtMs: input.checkpoint.occurredAtMs,
  })
}

const validateCommit = (
  value: unknown,
  options: PlaybackCommitOptions = {},
): { input: PlaybackCommitRequestV1, failAt?: PlaybackCommitFailPoint } => {
  const input = parsePlaybackCommitRequest(value)
  if ('fact' in input && input.fact?.type == 'play_start') {
    throw new Error('playback_commit_play_start_forbidden')
  }
  const parsedOptions = exactRecord(options, [], ['failAt'])
  if (parsedOptions == null ||
    (parsedOptions.failAt != null && parsedOptions.failAt != 'after-daily')) {
    throw new Error('Invalid playback commit options')
  }
  const failAt = parsedOptions.failAt as PlaybackCommitFailPoint | undefined
  return { input, failAt }
}

export const commitInTransaction = (
  db: Database.Database,
  input: PlaybackCommitRequestV1,
  failAt?: PlaybackCommitFailPoint,
): PlaybackCheckpointAckV1 => {
  const current = getOpenSession(db, input.checkpoint.playbackGroupUuid)
  if (current == null) {
    const terminal = getSessionAck(db, input.checkpoint.playbackGroupUuid)
    if (terminal == null) throw new Error('playback_group_not_found')
    if (input.checkpoint.checkpointSeq <= terminal.checkpointSeq) return sessionAck(terminal)
    throw new Error('playback_group_closed')
  }
  if (current.statsAllowed == 0 &&
    (input.checkpoint.cumulativePlayedMs != 0 || input.checkpoint.cumulativeActiveMs != 0)) {
    throw new Error('playback_statistics_disabled_cumulative_nonzero')
  }
  if (input.checkpoint.checkpointSeq <= current.checkpointSeq) return sessionAck(current)
  if (input.checkpoint.cumulativePlayedMs < current.cumulativePlayedMs) {
    throw new Error('Invalid cumulativePlayedMs')
  }
  if (input.checkpoint.cumulativeActiveMs < current.cumulativeActiveMs) {
    throw new Error('Invalid cumulativeActiveMs')
  }
  if (input.checkpoint.occurredAtMs < current.startedAtMs) throw new Error('Invalid occurredAtMs')

  const cumulativePlayedMs = current.statsAllowed
    ? input.checkpoint.cumulativePlayedMs
    : 0
  const cumulativeActiveMs = current.statsAllowed
    ? input.checkpoint.cumulativeActiveMs
    : 0
  const playedDelta = cumulativePlayedMs - current.cumulativePlayedMs
  const activeDelta = cumulativeActiveMs - current.cumulativeActiveMs
  const isBoundary = 'boundary' in input
  if (isBoundary) {
    if (!isImmediateLocalDayBoundary(
      current.localDay,
      input.checkpoint.occurredAtMs,
      input.boundary.nextLocalDay,
      input.boundary.utcOffsetMinutes,
    )) {
      throw new Error('playback_boundary_mismatch')
    }
  }
  const reason = isBoundary ? 'day_boundary' : terminalReason(input.fact)
  const nextState = isBoundary ? 'closed' : stateAfter(current.state, input.fact)
  db.prepare(`
      UPDATE playback_sessions
      SET last_position_ms = ?, duration_ms = ?,
        played_ms = played_ms + ?, active_ms = active_ms + ?,
        cumulative_played_ms = ?, cumulative_active_ms = ?,
        checkpoint_seq = ?, state = ?, end_reason = ?, ended_at_ms = ?
      WHERE session_id = ?
    `).run(
    input.checkpoint.positionMs,
    input.checkpoint.durationMs,
    playedDelta,
    activeDelta,
    cumulativePlayedMs,
    cumulativeActiveMs,
    input.checkpoint.checkpointSeq,
    nextState,
    reason,
    nextState == 'closed' ? input.checkpoint.occurredAtMs : null,
    current.sessionId,
  )
  updateResumeForCommit(db, current, input)
  if (current.statsAllowed) {
    updateListeningProjections(db, {
      trackId: current.trackId,
      sessionId: current.sessionId,
      localDay: current.localDay,
      startedAtMs: current.startedAtMs,
      playedMs: playedDelta,
      activeMs: activeDelta,
      occurredAtMs: input.checkpoint.occurredAtMs,
    }, failAt == 'after-daily'
      ? () => { throw new Error('injected failure') }
      : undefined)
  } else if (failAt == 'after-daily') {
    throw new Error('injected failure')
  }
  if (!isBoundary && input.fact != null) {
    insertEvent(
      db,
      current.sessionId,
      input.checkpoint.checkpointSeq,
      input.checkpoint.occurredAtMs,
      input.checkpoint.positionMs,
      input.fact,
    )
  }
  if (!isBoundary) {
    return sessionAck({
      ...current,
      checkpointSeq: input.checkpoint.checkpointSeq,
      cumulativePlayedMs,
      cumulativeActiveMs,
    })
  }

  const boundary = input.boundary
  const next = insertSession(db, {
    sessionUuid: newSessionUuid(),
    playbackGroupUuid: current.playbackGroupUuid,
    segmentNo: current.segmentNo + 1,
    trackId: current.trackId,
    localDay: boundary.nextLocalDay,
    utcOffsetMinutes: boundary.utcOffsetMinutes,
    contextType: current.contextType,
    contextId: current.contextId,
    startReason: 'day_boundary',
    endReason: null,
    startedAtMs: input.checkpoint.occurredAtMs,
    endedAtMs: null,
    startPositionMs: input.checkpoint.positionMs,
    lastPositionMs: input.checkpoint.positionMs,
    durationMs: input.checkpoint.durationMs,
    playedMs: 0,
    activeMs: 0,
    cumulativePlayedMs,
    cumulativeActiveMs,
    checkpointSeq: input.checkpoint.checkpointSeq,
    state: current.state,
    recentAllowed: current.recentAllowed == 1,
    statsAllowed: current.statsAllowed == 1,
  })
  return sessionAck(next)
}

export const playbackCommit = (
  value: PlaybackCommitRequestV1,
  options: PlaybackCommitOptions = {},
): PlaybackCheckpointAckV1 => {
  const commit = validateCommit(value, options)
  return immediate(db => commitInTransaction(db, commit.input, commit.failAt))
}

export const updateResumeInTransaction = (
  db: Database.Database,
  input: PlaybackResumeUpdateV1,
): PlaybackResumeAckV1 => {
  const stored = getResumeRow(db)
  if (stored != null) {
    if (stored.playbackGroupUuid == input.playbackGroupUuid &&
        input.checkpointSeq <= stored.checkpointSeq) return resumeAck(stored)
    if (stored.playbackGroupUuid != input.playbackGroupUuid &&
        input.updatedAtMs < stored.updatedAtMs) return resumeAck(stored)
  }
  return resumeAck(putResume(db, {
    playbackGroupUuid: input.playbackGroupUuid,
    checkpointSeq: input.checkpointSeq,
    source: input.track.source,
    sourceTrackId: input.track.sourceTrackId,
    listId: input.listId,
    indexHint: input.indexHint,
    positionMs: input.positionMs,
    durationMs: input.durationMs,
    updatedAtMs: input.updatedAtMs,
  }))
}

export const playbackUpdateResume = (value: PlaybackResumeUpdateV1): PlaybackResumeAckV1 => {
  const input = parsePlaybackResumeUpdate(value)
  return immediate(db => updateResumeInTransaction(db, input))
}

export const recordPreplayFailureInTransaction = (
  db: Database.Database,
  input: PlaybackPreplayFailureV1,
): PlaybackCheckpointAckV1 => {
  if (input.consent.privateMode) throw new Error('playback_private_mode')
  if (!input.consent.recentAllowed && !input.consent.statsAllowed) {
    throw new Error('playback_activity_disabled')
  }
  if (input.error.recoverable) throw new Error('playback_preplay_failure_recoverable')
  const existing = getSessionAck(db, input.playbackGroupUuid)
  if (existing != null) return sessionAck(existing)
  const trackId = upsertTrack(db, input.track, input.occurredAtMs)
  const clock = localClockAt(input.occurredAtMs)
  const row = insertSession(db, {
    sessionUuid: newSessionUuid(),
    playbackGroupUuid: input.playbackGroupUuid,
    segmentNo: 0,
    trackId,
    localDay: clock.localDay,
    utcOffsetMinutes: clock.utcOffsetMinutes,
    contextType: input.context.type,
    contextId: input.context.id,
    startReason: input.startReason,
    endReason: 'error',
    startedAtMs: input.occurredAtMs,
    endedAtMs: input.occurredAtMs,
    startPositionMs: input.startPositionMs,
    lastPositionMs: input.startPositionMs,
    durationMs: input.track.durationMs,
    playedMs: 0,
    activeMs: 0,
    cumulativePlayedMs: 0,
    cumulativeActiveMs: 0,
    checkpointSeq: 1,
    state: 'closed',
    recentAllowed: false,
    statsAllowed: false,
  })
  insertEvent(db, row.sessionId, 1, input.occurredAtMs, input.startPositionMs, input.error)
  return sessionAck(row)
}

export const playbackRecordPreplayFailure = (
  value: PlaybackPreplayFailureV1,
): PlaybackCheckpointAckV1 => {
  const input = parsePlaybackPreplayFailure(value)
  return immediate(db => recordPreplayFailureInTransaction(db, input))
}

const recentInTransaction = (
  db: Database.Database,
  value: { version: 1, limit: number },
): RecentTrackV1[] => {
  const input = exactRecord(value, ['version', 'limit'])
  if (input == null || input.version !== 1 ||
    !safeInteger(input.limit, 1, 520)) throw new Error('Invalid playback recent query')
  return readRecentProjection(db, input.limit)
}

export const playbackGetRecent = (value: { version: 1, limit: number }): RecentTrackV1[] => {
  return recentInTransaction(getAppDB(), value)
}

export const playbackGetListeningStats = (value?: unknown): ListeningStatsV1 => {
  if (value !== undefined) throw new Error('Invalid playback listening query')
  return readListeningStats(getAppDB())
}

export const playbackGetResume = (value?: unknown): PlaybackResumeV1 | null => {
  if (value !== undefined) throw new Error('Invalid playback resume query')
  const row = getResumeRow(getAppDB())
  if (row == null) return null
  return parsePlaybackResume({
    version: 1,
    source: row.source,
    sourceTrackId: row.sourceTrackId,
    listId: row.listId,
    indexHint: row.indexHint,
    positionMs: row.positionMs,
    durationMs: row.durationMs,
    updatedAtMs: row.updatedAtMs,
  })
}

export const playbackMarkStaleSessionsInterrupted = (value: { nowMs: number }): number => {
  const input = exactRecord(value, ['nowMs'])
  if (input == null || !safeInteger(input.nowMs)) {
    throw new Error('Invalid stale playback request')
  }
  return immediate(db => db.prepare(`
    UPDATE playback_sessions
    SET state = 'interrupted', ended_at_ms = ?, end_reason = NULL
    WHERE state IN ('playing', 'paused') AND started_at_ms <= ?
  `).run(input.nowMs, input.nowMs).changes)
}

const smokeTables = [
  'track_snapshots',
  'playback_sessions',
  'playback_events',
  'recent_tracks',
  'listening_daily',
  'listening_tracks',
  'activity_totals',
  'projection_state',
  'playback_resume_state',
] as const

const smokeSnapshot = (db: Database.Database): string => canonicalJson(Object.fromEntries(
  smokeTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
) as unknown as JsonValue)

const rollbackSentinel = new Error('playback_typed_smoke_rollback')

export interface PlaybackTypedSmokeV1 {
  version: 1
  writerEvidenceSha256: string
  readerEvidenceSha256: string
}

type PlaybackTypedSmokeFailPoint = 'parser' | 'result' | 'rollback'

export const runPlaybackTypedSmokeForTest = (
  options: { failAt?: PlaybackTypedSmokeFailPoint } = {},
): PlaybackTypedSmokeV1 => {
  const db = getAppDB()
  const before = smokeSnapshot(db)
  if (options.failAt == 'parser') {
    try {
      parsePlaybackStartCommand({ version: 1 })
    } catch {
      throw new Error('playback_typed_smoke_parser_failure')
    }
  }
  const playbackGroupUuid = newSessionUuid()
  const preplayGroupUuid = newSessionUuid()
  const occurredAtMs = 1_700_000_000_000
  const track = {
    source: 'phase3-smoke',
    sourceTrackId: 'phase3-smoke-track',
    name: 'Phase 3 smoke',
    singer: 'Phase 3 smoke',
    durationMs: 60_000,
    playablePayload: null,
  }
  try {
    db.transaction(() => {
      const start = parsePlaybackStartCommand({
        version: 1,
        playbackGroupUuid,
        track,
        context: { type: 'unknown', id: null },
        resume: { listId: null, indexHint: null },
        startReason: 'auto',
        startPositionMs: 0,
        occurredAtMs,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
      })
      const startResult = parsePlaybackStartResult(startInTransaction(db, start))
      if (startResult.mode != 'activity') throw new Error('playback_typed_smoke_result_failure')

      const commit = parsePlaybackCommitRequest({
        version: 1,
        checkpoint: {
          playbackGroupUuid,
          checkpointSeq: 2,
          cumulativePlayedMs: 1_000,
          cumulativeActiveMs: 1_000,
          positionMs: 1_000,
          durationMs: 60_000,
          occurredAtMs: occurredAtMs + 1_000,
        },
        fact: { version: 1, type: 'pause', reason: 'device' },
      })
      parsePlaybackCheckpointAck(commitInTransaction(db, commit))

      const resume = parsePlaybackResumeUpdate({
        version: 1,
        playbackGroupUuid,
        checkpointSeq: 3,
        track: { source: track.source, sourceTrackId: track.sourceTrackId },
        listId: null,
        indexHint: null,
        positionMs: 1_000,
        durationMs: 60_000,
        updatedAtMs: occurredAtMs + 2_000,
      })
      parsePlaybackResumeAck(updateResumeInTransaction(db, resume))

      const preplay = parsePlaybackPreplayFailure({
        version: 1,
        playbackGroupUuid: preplayGroupUuid,
        track: { ...track, sourceTrackId: 'phase3-smoke-failed-track' },
        context: { type: 'unknown', id: null },
        resume: { listId: null, indexHint: null },
        startReason: 'auto',
        startPositionMs: 0,
        occurredAtMs: occurredAtMs + 3_000,
        consent: { recentAllowed: true, statsAllowed: true, privateMode: false },
        error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: false, attempt: 0 },
      })
      parsePlaybackCheckpointAck(recordPreplayFailureInTransaction(db, preplay))

      recentInTransaction(db, { version: 1, limit: 10 })
      readListeningStats(db)
      const resumeRow = getResumeRow(db)
      if (resumeRow == null) throw new Error('playback_typed_smoke_result_failure')
      parsePlaybackResume({
        version: 1,
        source: resumeRow.source,
        sourceTrackId: resumeRow.sourceTrackId,
        listId: resumeRow.listId,
        indexHint: resumeRow.indexHint,
        positionMs: resumeRow.positionMs,
        durationMs: resumeRow.durationMs,
        updatedAtMs: resumeRow.updatedAtMs,
      })
      if (options.failAt == 'result') throw new Error('playback_typed_smoke_result_failure')
      throw rollbackSentinel
    }).immediate()
  } catch (error) {
    if (error !== rollbackSentinel) throw error
  }
  const after = smokeSnapshot(db)
  if (options.failAt == 'rollback' || after != before) {
    throw new Error('playback_typed_smoke_rollback_failure')
  }
  return {
    version: 1,
    writerEvidenceSha256: phase3Evidence('playback-writer', {
      state: 'complete',
      writers: ['start', 'commit', 'resume-update', 'preplay-failure'],
      rolledBack: true,
    }),
    readerEvidenceSha256: phase3Evidence('playback-reader', {
      state: 'complete',
      readers: ['recent', 'listening', 'resume'],
      rolledBack: true,
    }),
  }
}

export const playbackRunTypedSmoke = (value?: unknown): PlaybackTypedSmokeV1 => {
  if (value !== undefined) throw new Error('Invalid playback typed smoke request')
  return runPlaybackTypedSmokeForTest()
}
