import { createHash } from 'node:crypto'
import type { SchemaMigration } from './types'

export const PLAYBACK_ACTIVITY_SOURCE = `CREATE TABLE track_snapshots (
  track_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  name TEXT NOT NULL,
  singer TEXT NOT NULL,
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  playable_payload_json TEXT CHECK(playable_payload_json IS NULL OR json_valid(playable_payload_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0),
  UNIQUE(source, source_track_id)
);

CREATE TABLE playback_sessions (
  session_id INTEGER PRIMARY KEY,
  session_uuid TEXT NOT NULL UNIQUE,
  playback_group_uuid TEXT NOT NULL,
  segment_no INTEGER NOT NULL CHECK(segment_no >= 0),
  track_id INTEGER NOT NULL REFERENCES track_snapshots(track_id),
  local_day TEXT NOT NULL CHECK(length(local_day) = 10),
  utc_offset_minutes INTEGER NOT NULL CHECK(utc_offset_minutes BETWEEN -840 AND 840),
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
  started_at_ms INTEGER NOT NULL CHECK(started_at_ms >= 0),
  ended_at_ms INTEGER CHECK(ended_at_ms IS NULL OR ended_at_ms >= started_at_ms),
  start_position_ms INTEGER NOT NULL CHECK(start_position_ms >= 0),
  last_position_ms INTEGER NOT NULL CHECK(last_position_ms >= 0),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  played_ms INTEGER NOT NULL DEFAULT 0 CHECK(played_ms >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  cumulative_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(cumulative_played_ms >= 0),
  cumulative_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(cumulative_active_ms >= 0),
  checkpoint_seq INTEGER NOT NULL DEFAULT 0 CHECK(checkpoint_seq >= 0),
  state TEXT NOT NULL CHECK(state IN ('playing','paused','closed','interrupted')),
  recent_allowed INTEGER NOT NULL CHECK(recent_allowed IN (0,1)),
  stats_allowed INTEGER NOT NULL CHECK(stats_allowed IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
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
  event_id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES playback_sessions(session_id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK(sequence_no >= 0),
  event_type TEXT NOT NULL CHECK(event_type IN (
    'play_start','pause','resume','seek','skip','play_end','error'
  )),
  occurred_at_ms INTEGER NOT NULL CHECK(occurred_at_ms >= 0),
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  reason TEXT,
  details_json TEXT CHECK(details_json IS NULL OR json_valid(details_json)),
  CHECK(
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
    OR (event_type = 'error' AND reason IS NULL)
  ),
  UNIQUE(session_id, sequence_no)
);

CREATE TABLE recent_tracks (
  track_id INTEGER PRIMARY KEY REFERENCES track_snapshots(track_id) ON DELETE CASCADE,
  recency_seq INTEGER NOT NULL UNIQUE,
  last_session_id INTEGER REFERENCES playback_sessions(session_id) ON DELETE SET NULL,
  last_played_at_ms INTEGER CHECK(last_played_at_ms IS NULL OR last_played_at_ms >= 0),
  legacy_rank INTEGER CHECK(legacy_rank IS NULL OR legacy_rank BETWEEN 1 AND 520),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE INDEX recent_tracks_order ON recent_tracks(recency_seq DESC);

CREATE TABLE listening_daily (
  local_day TEXT PRIMARY KEY CHECK(length(local_day) = 10),
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_played_ms >= 0),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_played_ms >= 0),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_active_ms >= 0),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_active_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE listening_tracks (
  track_id INTEGER PRIMARY KEY REFERENCES track_snapshots(track_id) ON DELETE CASCADE,
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_played_ms >= 0),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_played_ms >= 0),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_active_ms >= 0),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_active_ms >= 0),
  last_played_at_ms INTEGER CHECK(last_played_at_ms IS NULL OR last_played_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE activity_totals (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_played_ms >= 0),
  live_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_played_ms >= 0),
  baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(baseline_active_ms >= 0),
  live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(live_active_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE projection_state (
  name TEXT PRIMARY KEY CHECK(name IN ('recent','statistics')),
  version INTEGER NOT NULL CHECK(version >= 1),
  last_session_id INTEGER REFERENCES playback_sessions(session_id) ON DELETE SET NULL,
  visible_after_ms INTEGER CHECK(visible_after_ms IS NULL OR visible_after_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE playback_resume_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  playback_group_uuid TEXT NOT NULL,
  checkpoint_seq INTEGER NOT NULL CHECK(checkpoint_seq >= 0),
  source TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  list_id TEXT,
  index_hint INTEGER CHECK(index_hint IS NULL OR index_hint BETWEEN 0 AND 1000000),
  position_ms INTEGER NOT NULL CHECK(position_ms >= 0),
  duration_ms INTEGER CHECK(duration_ms IS NULL OR duration_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
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
