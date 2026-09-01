import { createHash } from 'node:crypto'
import type { SchemaMigration } from './types'

export const LISTENING_PLAY_COUNT_SOURCE = `ALTER TABLE listening_tracks
ADD COLUMN play_count INTEGER NOT NULL DEFAULT 0 CHECK(
  typeof(play_count) = 'integer' AND play_count BETWEEN 0 AND 9007199254740991
);

INSERT INTO listening_tracks(track_id, last_played_at_ms, updated_at_ms)
SELECT session.track_id, MAX(session.started_at_ms), MAX(session.started_at_ms)
FROM playback_sessions session
WHERE session.segment_no = 0
  AND session.stats_allowed = 1
  AND (
    (SELECT visible_after_ms FROM projection_state WHERE name = 'statistics') IS NULL
    OR session.started_at_ms >= (
      SELECT visible_after_ms FROM projection_state WHERE name = 'statistics'
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM listening_tracks WHERE listening_tracks.track_id = session.track_id
  )
GROUP BY session.track_id;

UPDATE listening_tracks
SET play_count = (
  SELECT COUNT(*)
  FROM playback_sessions session
  WHERE session.track_id = listening_tracks.track_id
    AND session.segment_no = 0
    AND session.stats_allowed = 1
    AND (
      (SELECT visible_after_ms FROM projection_state WHERE name = 'statistics') IS NULL
      OR session.started_at_ms >= (
        SELECT visible_after_ms FROM projection_state WHERE name = 'statistics'
      )
    )
);`

const verifyPlayCountColumn = (db: Parameters<SchemaMigration['up']>[0]): void => {
  const columns = db.pragma('table_xinfo("listening_tracks")') as Array<{
    name: unknown
    type: unknown
    notnull: unknown
    dflt_value: unknown
    hidden: unknown
  }>
  const column = columns.at(-1)
  if (column?.name != 'play_count' || column.type != 'INTEGER' || column.notnull != 1 ||
    column.dflt_value != '0' || column.hidden != 0) {
    throw new Error('Migration 8 did not create the listening play-count column')
  }
}

export const migration8: SchemaMigration = {
  version: 8,
  name: 'listening_play_count',
  checksum: createHash('sha256').update(LISTENING_PLAY_COUNT_SOURCE).digest('hex'),
  up(db) {
    db.exec(LISTENING_PLAY_COUNT_SOURCE)
  },
  verify(db) {
    verifyPlayCountColumn(db)
  },
}

export default migration8
