import { getDB } from '../../db'
import type { LocalStateRow, PlaylistMetadataRow, SearchHistoryRow } from './index'

export const createGetLocalStateStatement = () => getDB().prepare<[], LocalStateRow>(`
  SELECT key, version, value_json AS valueJson, updated_at_ms AS updatedAtMs
  FROM local_state
`)

export const createUpsertLocalStateStatement = () => getDB().prepare<[LocalStateRow]>(`
  INSERT INTO local_state (key, version, value_json, updated_at_ms)
  VALUES (@key, @version, @valueJson, @updatedAtMs)
  ON CONFLICT(key) DO UPDATE SET
    version = excluded.version,
    value_json = excluded.value_json,
    updated_at_ms = excluded.updated_at_ms
`)

export const createClearLocalStateStatement = () => getDB().prepare('DELETE FROM local_state')

export const createGetPlaylistMetadataStatement = () => getDB().prepare<[], PlaylistMetadataRow>(`
  SELECT
    playlist_id AS playlistId,
    is_auto_update AS isAutoUpdate,
    update_time_ms AS updateTimeMs,
    profile_json AS profileJson,
    updated_at_ms AS updatedAtMs
  FROM playlist_metadata
  ORDER BY playlist_id
`)

export const createUpsertPlaylistMetadataStatement = () => getDB().prepare<[PlaylistMetadataRow]>(`
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

export const createDeletePlaylistMetadataStatement = () => getDB().prepare<[string]>(`
  DELETE FROM playlist_metadata WHERE playlist_id = ?
`)

export const createClearPlaylistMetadataStatement = () => getDB().prepare('DELETE FROM playlist_metadata')

export const createGetSearchHistoryStatement = () => getDB().prepare<[], SearchHistoryRow>(`
  SELECT
    term,
    recency_seq AS recencySeq,
    last_used_at_ms AS lastUsedAtMs,
    use_count AS useCount
  FROM search_history
  ORDER BY recency_seq DESC
`)

export const createGetSearchHistoryTermStatement = () => getDB().prepare<[string], SearchHistoryRow>(`
  SELECT
    term,
    recency_seq AS recencySeq,
    last_used_at_ms AS lastUsedAtMs,
    use_count AS useCount
  FROM search_history
  WHERE term = ?
`)

export const createGetMaxSearchRecencyStatement = () => getDB().prepare<[], { recencySeq: number | null }>(`
  SELECT MAX(recency_seq) AS recencySeq FROM search_history
`)

export const createInsertSearchHistoryStatement = () => getDB().prepare<[SearchHistoryRow]>(`
  INSERT INTO search_history (term, recency_seq, last_used_at_ms, use_count)
  VALUES (@term, @recencySeq, @lastUsedAtMs, @useCount)
`)

export const createDeleteSearchHistoryTermStatement = () => getDB().prepare<[string]>(`
  DELETE FROM search_history WHERE term = ?
`)

export const createClearSearchHistoryStatement = () => getDB().prepare('DELETE FROM search_history')

export const createTrimSearchHistoryStatement = () => getDB().prepare(`
  DELETE FROM search_history
  WHERE recency_seq NOT IN (
    SELECT recency_seq FROM search_history ORDER BY recency_seq DESC LIMIT 15
  )
`)
