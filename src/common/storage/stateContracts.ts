import { type DEFAULT_SETTING } from '../constants'

export interface CatalogPreferencesV1 {
  version: 1
  leaderboard: { source: LX.OnlineSource, boardId: string }
  songList: { source: LX.OnlineSource, sortId: string, tagId: string }
  search: {
    temp_source: LX.OnlineSource
    source: LX.OnlineSource | 'all'
    type: 'music' | 'songlist'
  }
}

export interface LocalStateSnapshotV1 {
  version: 1
  viewPrevState: typeof DEFAULT_SETTING.viewPrevState
  listScrollPosition: LX.List.ListPositionInfo
  listPrevSelectId: string
}

export type LocalStateUpdateV1 =
  | { version: 1, key: 'view_prev_state', value: typeof DEFAULT_SETTING.viewPrevState, updatedAtMs: number }
  | { version: 1, key: 'list_scroll_positions', value: LX.List.ListPositionInfo, updatedAtMs: number }
  | { version: 1, key: 'list_prev_select_id', value: string, updatedAtMs: number }

export type PlaylistMetadataCommandV1 =
  | { version: 1, action: 'upsert', playlistId: string, value: LX.List.ListUpdateInfo[string], updatedAtMs: number }
  | { version: 1, action: 'remove', playlistId: string }
  | { version: 1, action: 'retain', playlistIds: string[] }

export type SearchHistoryCommandV1 =
  | { version: 1, action: 'record', term: string, usedAtMs: number }
  | { version: 1, action: 'remove', term: string }
  | { version: 1, action: 'clear' }
