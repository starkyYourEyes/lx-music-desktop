import { getAppDB } from '../../db'
import type { LocalStateRow, PlaylistMetadataRow, SearchHistoryRow } from './index'

export const createGetLocalStateStatement = () => getAppDB().prepare<[], LocalStateRow>(`
  SELECT key, version, value_json AS valueJson, updated_at_ms AS updatedAtMs
  FROM local_state
`)

export const createUpsertLocalStateStatement = () => getAppDB().prepare<[LocalStateRow]>(`
  INSERT INTO local_state (key, version, value_json, updated_at_ms)
  VALUES (@key, @version, @valueJson, @updatedAtMs)
  ON CONFLICT(key) DO UPDATE SET
    version = excluded.version,
    value_json = excluded.value_json,
    updated_at_ms = excluded.updated_at_ms
`)

export const createClearLocalStateStatement = () => getAppDB().prepare('DELETE FROM local_state')

export const createGetPlaylistMetadataStatement = () => getAppDB().prepare<[], PlaylistMetadataRow>(`
  SELECT
    playlist_id AS playlistId,
    is_auto_update AS isAutoUpdate,
    update_time_ms AS updateTimeMs,
    profile_json AS profileJson,
    updated_at_ms AS updatedAtMs
  FROM playlist_metadata
  ORDER BY playlist_id
`)

export const createGetPlaylistMetadataCountStatement = () => getAppDB().prepare<[], { count: number }>(`
  SELECT COUNT(*) AS count FROM playlist_metadata
`)

export const createHasPlaylistMetadataStatement = () => getAppDB().prepare<[string], { present: 1 }>(`
  SELECT 1 AS present FROM playlist_metadata WHERE playlist_id = ?
`)

export const createUpsertPlaylistMetadataStatement = () => getAppDB().prepare<[PlaylistMetadataRow]>(`
  INSERT INTO playlist_metadata (
    playlist_id, is_auto_update, update_time_ms, profile_json, updated_at_ms
  ) VALUES (
    @playlistId, @isAutoUpdate, @updateTimeMs, @profileJson, @updatedAtMs
  )
  ON CONFLICT(playlist_id) DO UPDATE SET
    is_auto_update = excluded.is_auto_update,
    update_time_ms = excluded.update_time_ms,
    profile_json = excluded.profile_json,
    updated_at_ms = excluded.updated_at_ms
`)

export const createDeletePlaylistMetadataStatement = () => getAppDB().prepare<[string]>(`
  DELETE FROM playlist_metadata WHERE playlist_id = ?
`)

export const createClearPlaylistMetadataStatement = () => getAppDB().prepare('DELETE FROM playlist_metadata')

export const createGetSearchHistoryStatement = () => getAppDB().prepare<[], SearchHistoryRow>(`
  SELECT
    term,
    recency_seq AS recencySeq,
    last_used_at_ms AS lastUsedAtMs,
    use_count AS useCount
  FROM search_history
  ORDER BY recency_seq DESC
`)

export const createGetSearchHistoryTermStatement = () => getAppDB().prepare<[string], SearchHistoryRow>(`
  SELECT
    term,
    recency_seq AS recencySeq,
    last_used_at_ms AS lastUsedAtMs,
    use_count AS useCount
  FROM search_history
  WHERE term = ?
`)

export const createGetMaxSearchRecencyStatement = () => getAppDB().prepare<[], { recencySeq: number | null }>(`
  SELECT MAX(recency_seq) AS recencySeq FROM search_history
`)

export const createInsertSearchHistoryStatement = () => getAppDB().prepare<[SearchHistoryRow]>(`
  INSERT INTO search_history (term, recency_seq, last_used_at_ms, use_count)
  VALUES (@term, @recencySeq, @lastUsedAtMs, @useCount)
`)

export const createDeleteSearchHistoryTermStatement = () => getAppDB().prepare<[string]>(`
  DELETE FROM search_history WHERE term = ?
`)

export const createClearSearchHistoryStatement = () => getAppDB().prepare('DELETE FROM search_history')

export const createTrimSearchHistoryStatement = () => getAppDB().prepare(`
  DELETE FROM search_history
  WHERE recency_seq NOT IN (
    SELECT recency_seq FROM search_history ORDER BY recency_seq DESC LIMIT 15
  )
`)
