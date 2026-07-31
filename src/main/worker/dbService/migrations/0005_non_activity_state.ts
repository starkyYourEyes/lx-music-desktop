import { createHash } from 'node:crypto'
import type { SchemaMigration } from './types'

export const NON_ACTIVITY_STATE_SOURCE = `CREATE TABLE local_state (
  key TEXT PRIMARY KEY CHECK(key IN (
    'view_prev_state', 'list_scroll_positions', 'list_prev_select_id'
  )),
  version INTEGER NOT NULL CHECK(version = 1),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE playlist_metadata (
  playlist_id TEXT PRIMARY KEY,
  is_auto_update INTEGER NOT NULL CHECK(is_auto_update IN (0, 1)),
  update_time_ms INTEGER NOT NULL CHECK(update_time_ms >= 0),
  profile_json TEXT CHECK(profile_json IS NULL OR json_valid(profile_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE search_history (
  term TEXT PRIMARY KEY,
  recency_seq INTEGER NOT NULL UNIQUE,
  last_used_at_ms INTEGER,
  use_count INTEGER NOT NULL CHECK(use_count >= 1)
);`

export const migration5: SchemaMigration = {
  version: 5,
  name: 'non_activity_state',
  checksum: createHash('sha256').update(NON_ACTIVITY_STATE_SOURCE).digest('hex'),
  up(db) {
    db.exec(NON_ACTIVITY_STATE_SOURCE)
  },
}

export default migration5
