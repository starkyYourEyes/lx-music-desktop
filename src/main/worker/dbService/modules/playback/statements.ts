export const SELECT_SESSION_ACK = `
  SELECT session_id AS sessionId, session_uuid AS sessionUuid,
    playback_group_uuid AS playbackGroupUuid, segment_no AS segmentNo,
    checkpoint_seq AS checkpointSeq, cumulative_played_ms AS cumulativePlayedMs,
    cumulative_active_ms AS cumulativeActiveMs
  FROM playback_sessions
  WHERE playback_group_uuid = ?
  ORDER BY segment_no DESC
  LIMIT 1
`

export const SELECT_OPEN_SESSION = `
  SELECT session.session_id AS sessionId, session.session_uuid AS sessionUuid,
    session.playback_group_uuid AS playbackGroupUuid, session.segment_no AS segmentNo,
    session.track_id AS trackId, session.local_day AS localDay,
    session.utc_offset_minutes AS utcOffsetMinutes, session.context_type AS contextType,
    session.context_id AS contextId, session.started_at_ms AS startedAtMs,
    session.last_position_ms AS lastPositionMs, session.duration_ms AS durationMs,
    session.played_ms AS playedMs, session.active_ms AS activeMs,
    session.cumulative_played_ms AS cumulativePlayedMs,
    session.cumulative_active_ms AS cumulativeActiveMs,
    session.checkpoint_seq AS checkpointSeq, session.state,
    session.recent_allowed AS recentAllowed, session.stats_allowed AS statsAllowed,
    track.source, track.source_track_id AS sourceTrackId
  FROM playback_sessions session
  JOIN track_snapshots track ON track.track_id = session.track_id
  WHERE session.playback_group_uuid = ? AND session.state IN ('playing', 'paused')
  LIMIT 1
`

export const SELECT_RESUME_ROW = `
  SELECT playback_group_uuid AS playbackGroupUuid, checkpoint_seq AS checkpointSeq,
    source, source_track_id AS sourceTrackId, list_id AS listId, index_hint AS indexHint,
    position_ms AS positionMs, duration_ms AS durationMs, updated_at_ms AS updatedAtMs
  FROM playback_resume_state
  WHERE id = 1
`

export const UPSERT_TRACK = `
  INSERT INTO track_snapshots(
    source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
  ) VALUES(?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(source, source_track_id) DO UPDATE SET
    name = excluded.name,
    singer = excluded.singer,
    duration_ms = excluded.duration_ms,
    playable_payload_json = excluded.playable_payload_json,
    updated_at_ms = excluded.updated_at_ms
`

export const UPSERT_RESUME = `
  INSERT INTO playback_resume_state(
    id, playback_group_uuid, checkpoint_seq, source, source_track_id,
    list_id, index_hint, position_ms, duration_ms, updated_at_ms
  ) VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    playback_group_uuid = excluded.playback_group_uuid,
    checkpoint_seq = excluded.checkpoint_seq,
    source = excluded.source,
    source_track_id = excluded.source_track_id,
    list_id = excluded.list_id,
    index_hint = excluded.index_hint,
    position_ms = excluded.position_ms,
    duration_ms = excluded.duration_ms,
    updated_at_ms = excluded.updated_at_ms
`

export const INSERT_SESSION = `
  INSERT INTO playback_sessions(
    session_uuid, playback_group_uuid, segment_no, track_id, local_day,
    utc_offset_minutes, context_type, context_id, start_reason, end_reason,
    started_at_ms, ended_at_ms, start_position_ms, last_position_ms, duration_ms,
    played_ms, active_ms, cumulative_played_ms, cumulative_active_ms,
    checkpoint_seq, state, recent_allowed, stats_allowed, created_at_ms
  ) VALUES(
    ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  )
`

export const INSERT_EVENT = `
  INSERT INTO playback_events(
    session_id, sequence_no, event_type, occurred_at_ms, position_ms, reason, details_json
  ) VALUES(?, ?, ?, ?, ?, ?, ?)
`
