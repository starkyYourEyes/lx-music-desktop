import type {
  LocalStateSnapshotV1,
  LocalStateUpdateV1,
  PlaylistMetadataCommandV1,
  SearchHistoryCommandV1,
} from '../../../../../common/storage/stateContracts'
import type { MigrationMarker } from '../../migrations/types'
import {
  completeNonActivityMarker,
  deleteAllLocalState,
  importLegacyState,
  mutatePlaylistMetadata,
  mutateSearchHistory,
  queryLocalState,
  queryNonActivityMarker,
  queryPlaylistMetadata,
  querySearchHistory,
  updateLocalState,
} from './dbHelper'

export type LocalStateKey = 'view_prev_state' | 'list_scroll_positions' | 'list_prev_select_id'

export interface LocalStateRow {
  key: LocalStateKey
  version: 1
  valueJson: string
  updatedAtMs: number
}

export interface PlaylistMetadataRow {
  playlistId: string
  isAutoUpdate: 0 | 1
  updateTimeMs: number
  profileJson: string | null
  updatedAtMs: number
}

export interface SearchHistoryRow {
  term: string
  recencySeq: number
  lastUsedAtMs: number | null
  useCount: number
}

export type NonActivityMarkerNameV1 =
  | 'legacy_data_v1.local_state'
  | 'legacy_data_v1.playlist_metadata'
  | 'legacy_data_v1.search_history'
  | 'legacy_data_v1.catalog_preferences'
  | 'legacy_data_v1.phase2_complete'

export type NonActivityMarkerCommandV1 = Omit<MigrationMarker, 'name'> & { name: NonActivityMarkerNameV1 }

export interface LegacyNonActivityImportV1 {
  localState: LocalStateSnapshotV1
  playlistMetadata: LX.List.ListUpdateInfo
  searchHistory: string[]
  markers: {
    localState: NonActivityMarkerCommandV1 & { name: 'legacy_data_v1.local_state' }
    playlistMetadata: NonActivityMarkerCommandV1 & { name: 'legacy_data_v1.playlist_metadata' }
    searchHistory: NonActivityMarkerCommandV1 & { name: 'legacy_data_v1.search_history' }
  }
}

export interface LegacyNonActivityImportResultV1 {
  localState: LocalStateSnapshotV1
  playlistMetadata: LX.List.ListUpdateInfo
  searchHistory: string[]
}

export interface AppStateRepository {
  getLocalState: () => LocalStateSnapshotV1
  setLocalState: (update: LocalStateUpdateV1) => LocalStateSnapshotV1
  clearLocalState: () => void
  getPlaylistMetadata: () => LX.List.ListUpdateInfo
  applyPlaylistMetadata: (command: PlaylistMetadataCommandV1) => LX.List.ListUpdateInfo
  getSearchHistory: () => string[]
  applySearchHistory: (command: SearchHistoryCommandV1) => string[]
  importLegacyNonActivity: (input: LegacyNonActivityImportV1) => LegacyNonActivityImportResultV1
  getNonActivityMigrationMarker: (name: NonActivityMarkerNameV1) => MigrationMarker | null
  completeNonActivityMigrationMarker: (input: NonActivityMarkerCommandV1) => void
}

export type { MigrationMarker }

export const getLocalState = (): LocalStateSnapshotV1 => queryLocalState()

export const setLocalState = (update: LocalStateUpdateV1): LocalStateSnapshotV1 => updateLocalState(update)

export const clearLocalState = (): void => {
  deleteAllLocalState()
}

export const getPlaylistMetadata = (): LX.List.ListUpdateInfo => queryPlaylistMetadata()

export const applyPlaylistMetadata = (command: PlaylistMetadataCommandV1): LX.List.ListUpdateInfo =>
  mutatePlaylistMetadata(command)

export const getSearchHistory = (): string[] => querySearchHistory()

export const applySearchHistory = (command: SearchHistoryCommandV1): string[] => mutateSearchHistory(command)

export const importLegacyNonActivity = (input: LegacyNonActivityImportV1): LegacyNonActivityImportResultV1 =>
  importLegacyState(input)

export const getNonActivityMigrationMarker = (name: NonActivityMarkerNameV1): MigrationMarker | null =>
  queryNonActivityMarker(name)

export const completeNonActivityMigrationMarker = (input: NonActivityMarkerCommandV1): void => {
  completeNonActivityMarker(input)
}
