import { createHash } from 'node:crypto'
import type { SchemaMigration } from './types'

export const PLAYBACK_ACTIVITY_SOURCE = `CREATE TABLE track_snapshots (
  track_id INTEGER PRIMARY KEY CHECK(
    typeof(track_id) = 'integer' AND track_id BETWEEN -9007199254740991 AND 9007199254740991
  ),
  source TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR (
    typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 9007199254740991
  )),
  playable_payload_json TEXT CHECK(playable_payload_json IS NULL OR json_valid(playable_payload_json)),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  ),
  UNIQUE(source, source_track_id)
);

CREATE TABLE playback_sessions (
  session_id INTEGER PRIMARY KEY CHECK(
    typeof(session_id) = 'integer' AND session_id BETWEEN -9007199254740991 AND 9007199254740991
  ),
  session_uuid TEXT NOT NULL UNIQUE,
  playback_group_uuid TEXT NOT NULL,
  segment_no INTEGER NOT NULL CHECK(
    typeof(segment_no) = 'integer' AND segment_no BETWEEN 0 AND 9007199254740991
  ),
  track_id INTEGER NOT NULL CHECK(
    typeof(track_id) = 'integer' AND track_id BETWEEN -9007199254740991 AND 9007199254740991
  ) REFERENCES track_snapshots(track_id),
  local_day TEXT NOT NULL CHECK(length(local_day) = 10),
  utc_offset_minutes INTEGER NOT NULL CHECK(
    typeof(utc_offset_minutes) = 'integer' AND utc_offset_minutes BETWEEN -840 AND 840
  ),
  context_type TEXT,
  context_id TEXT,
  start_reason TEXT NOT NULL CHECK(start_reason IN (
    'select','next','previous','auto','restore','remote',
    'day_boundary','statistics_clear'
  )),
  end_reason TEXT CHECK(end_reason IS NULL OR end_reason IN (
    'next','previous','select','dislike','stop','error',
    'load_timeout','buffer_timeout','queue_removed','natural_end',
    'day_boundary','statistics_clear'
  )),
  started_at_ms INTEGER NOT NULL CHECK(
    typeof(started_at_ms) = 'integer' AND started_at_ms BETWEEN 0 AND 9007199254740991
  ),
  ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR (
    typeof(ended_at_ms) = 'integer'
    AND ended_at_ms BETWEEN started_at_ms AND 9007199254740991
  )),
  start_position_ms INTEGER NOT NULL CHECK(
    typeof(start_position_ms) = 'integer' AND start_position_ms BETWEEN 0 AND 9007199254740991
  ),
  last_position_ms INTEGER NOT NULL CHECK(
    typeof(last_position_ms) = 'integer' AND last_position_ms BETWEEN 0 AND 9007199254740991
  ),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR (
    typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 9007199254740991
  )),
  played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(played_ms) = 'integer' AND played_ms BETWEEN 0 AND 9007199254740991
  ),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(active_ms) = 'integer' AND active_ms BETWEEN 0 AND 9007199254740991
  ),
  cumulative_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(cumulative_played_ms) = 'integer'
    AND cumulative_played_ms BETWEEN 0 AND 9007199254740991
  ),
  cumulative_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(cumulative_active_ms) = 'integer'
    AND cumulative_active_ms BETWEEN 0 AND 9007199254740991
  ),
  checkpoint_seq INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(checkpoint_seq) = 'integer' AND checkpoint_seq BETWEEN 0 AND 9007199254740991
  ),
  state TEXT NOT NULL CHECK(state IN ('playing','paused','closed','interrupted')),
  recent_allowed INTEGER NOT NULL CHECK(
    typeof(recent_allowed) = 'integer' AND recent_allowed IN (0,1)
  ),
  stats_allowed INTEGER NOT NULL CHECK(
    typeof(stats_allowed) = 'integer' AND stats_allowed IN (0,1)
  ),
  created_at_ms INTEGER NOT NULL CHECK(
    typeof(created_at_ms) = 'integer' AND created_at_ms BETWEEN 0 AND 9007199254740991
  ),
  CHECK(cumulative_played_ms >= played_ms),
  CHECK(cumulative_active_ms >= active_ms),
  CHECK(
    (state IN ('playing','paused') AND ended_at_ms IS NULL AND end_reason IS NULL)
    OR (state = 'closed' AND ended_at_ms IS NOT NULL AND end_reason IS NOT NULL)
    OR (state = 'interrupted' AND ended_at_ms IS NOT NULL AND end_reason IS NULL)
  ),
  UNIQUE(playback_group_uuid, segment_no)
);

CREATE UNIQUE INDEX playback_one_open_group
ON playback_sessions(playback_group_uuid)
WHERE state IN ('playing','paused');

CREATE INDEX playback_retention
ON playback_sessions(state, ended_at_ms, session_id);

CREATE TABLE playback_events (
  event_id INTEGER PRIMARY KEY CHECK(
    typeof(event_id) = 'integer' AND event_id BETWEEN -9007199254740991 AND 9007199254740991
  ),
  session_id INTEGER NOT NULL CHECK(
    typeof(session_id) = 'integer' AND session_id BETWEEN -9007199254740991 AND 9007199254740991
  ) REFERENCES playback_sessions(session_id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK(
    typeof(sequence_no) = 'integer' AND sequence_no BETWEEN 0 AND 9007199254740991
  ),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'play_start','pause','resume','seek','skip','play_end','error'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK(
    typeof(occurred_at_ms) = 'integer' AND occurred_at_ms BETWEEN 0 AND 9007199254740991
  ),
  position_ms INTEGER NOT NULL CHECK(
    typeof(position_ms) = 'integer' AND position_ms BETWEEN 0 AND 9007199254740991
  ),
  reason TEXT,
  details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
  CHECK(
    (event_type = 'error' AND reason IS NULL)
    OR (reason IS NOT NULL AND (
      (event_type = 'play_start' AND reason IN (
        'select','next','previous','auto','restore','remote',
        'day_boundary','statistics_clear'
      ))
      OR (event_type IN ('pause','resume') AND reason IN ('user','device','remote','recovery'))
      OR (event_type = 'seek' AND reason IN (
        'bar','hotkey','media_session','lyric','party','restore','buffer_recovery'
      ))
      OR (event_type = 'skip' AND reason IN (
        'next','previous','select','dislike','stop','error',
        'load_timeout','buffer_timeout','queue_removed'
      ))
      OR (event_type = 'play_end' AND reason = 'natural_end')
    ))
  ),
  UNIQUE(session_id, sequence_no)
);

CREATE TABLE recent_tracks (
  track_id INTEGER PRIMARY KEY CHECK(
    typeof(track_id) = 'integer' AND track_id BETWEEN -9007199254740991 AND 9007199254740991
  ) REFERENCES track_snapshots(track_id) ON DELETE CASCADE,
  recency_seq INTEGER NOT NULL UNIQUE CHECK(
    typeof(recency_seq) = 'integer' AND recency_seq BETWEEN 0 AND 9007199254740991
  ),
  last_session_id INTEGER CHECK(last_session_id IS NULL OR (
    typeof(last_session_id) = 'integer'
    AND last_session_id BETWEEN -9007199254740991 AND 9007199254740991
  )) REFERENCES playback_sessions(session_id) ON DELETE SET NULL,
  last_played_at_ms INTEGER CHECK(last_played_at_ms IS NULL OR (
    typeof(last_played_at_ms) = 'integer' AND last_played_at_ms BETWEEN 0 AND 9007199254740991
  )),
  legacy_rank INTEGER CHECK(legacy_rank IS NULL OR (
    typeof(legacy_rank) = 'integer' AND legacy_rank BETWEEN 1 AND 520
  )),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

CREATE INDEX recent_tracks_order ON recent_tracks(recency_seq DESC);

CREATE TABLE listening_daily (
  local_day TEXT PRIMARY KEY CHECK(length(local_day) = 10),
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(baseline_played_ms) = 'integer' AND baseline_played_ms BETWEEN 0 AND 9007199254740991
  ),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(live_played_ms) = 'integer' AND live_played_ms BETWEEN 0 AND 9007199254740991
  ),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(baseline_active_ms) = 'integer' AND baseline_active_ms BETWEEN 0 AND 9007199254740991
  ),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(live_active_ms) = 'integer' AND live_active_ms BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE listening_tracks (
  track_id INTEGER PRIMARY KEY CHECK(
    typeof(track_id) = 'integer' AND track_id BETWEEN -9007199254740991 AND 9007199254740991
  ) REFERENCES track_snapshots(track_id) ON DELETE CASCADE,
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(baseline_played_ms) = 'integer' AND baseline_played_ms BETWEEN 0 AND 9007199254740991
  ),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(live_played_ms) = 'integer' AND live_played_ms BETWEEN 0 AND 9007199254740991
  ),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(baseline_active_ms) = 'integer' AND baseline_active_ms BETWEEN 0 AND 9007199254740991
  ),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(live_active_ms) = 'integer' AND live_active_ms BETWEEN 0 AND 9007199254740991
  ),
  last_played_at_ms INTEGER CHECK(last_played_at_ms IS NULL OR (
    typeof(last_played_at_ms) = 'integer' AND last_played_at_ms BETWEEN 0 AND 9007199254740991
  )),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE activity_totals (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(baseline_played_ms) = 'integer' AND baseline_played_ms BETWEEN 0 AND 9007199254740991
  ),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(live_played_ms) = 'integer' AND live_played_ms BETWEEN 0 AND 9007199254740991
  ),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(baseline_active_ms) = 'integer' AND baseline_active_ms BETWEEN 0 AND 9007199254740991
  ),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
    typeof(live_active_ms) = 'integer' AND live_active_ms BETWEEN 0 AND 9007199254740991
  ),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE projection_state (
  name TEXT PRIMARY KEY CHECK(name IN ('recent','statistics')),
  version INTEGER NOT NULL CHECK(
    typeof(version) = 'integer' AND version BETWEEN 1 AND 9007199254740991
  ),
  last_session_id INTEGER CHECK(last_session_id IS NULL OR (
    typeof(last_session_id) = 'integer'
    AND last_session_id BETWEEN -9007199254740991 AND 9007199254740991
  )) REFERENCES playback_sessions(session_id) ON DELETE SET NULL,
  visible_after_ms INTEGER CHECK(visible_after_ms IS NULL OR (
    typeof(visible_after_ms) = 'integer' AND visible_after_ms BETWEEN 0 AND 9007199254740991
  )),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE playback_resume_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  playback_group_uuid TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL CHECK(
    typeof(checkpoint_seq) = 'integer' AND checkpoint_seq BETWEEN 0 AND 9007199254740991
  ),
  source TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  list_id TEXT,
  index_hint INTEGER CHECK(index_hint IS NULL OR (
    typeof(index_hint) = 'integer' AND index_hint BETWEEN 0 AND 1000000
  )),
  position_ms INTEGER NOT NULL CHECK(
    typeof(position_ms) = 'integer' AND position_ms BETWEEN 0 AND 9007199254740991
  ),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR (
    typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 9007199254740991
  )),
  updated_at_ms INTEGER NOT NULL CHECK(
    typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
  )
);

INSERT INTO activity_totals(id, updated_at_ms) VALUES(1, 0);
INSERT INTO projection_state(name, version, updated_at_ms)
VALUES ('recent', 1, 0), ('statistics', 1, 0);`

export const migration6: SchemaMigration = {
  version: 6,
  name: 'playback_activity',
  checksum: createHash('sha256').update(PLAYBACK_ACTIVITY_SOURCE).digest('hex'),
  up(db) {
    db.exec(PLAYBACK_ACTIVITY_SOURCE)
  },
}

export default migration6
