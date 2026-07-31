import {
  WIN_MAIN_RENDERER_EVENT_NAME,
  type StorageCatalogPreferenceSetRequest,
} from '@common/ipcNames'
import { rendererInvoke } from '@common/rendererIpc'
import type {
  CatalogPreferencesV1,
  LocalStateSnapshotV1,
  LocalStateUpdateV1,
  PlaylistMetadataCommandV1,
  SearchHistoryCommandV1,
} from '@common/storage/stateContracts'
import { toRaw } from '@common/utils/vueTools'

const toCloneable = <T>(value: T): T => JSON.parse(JSON.stringify(toRaw(value)))

export const getCatalogPreferences = () => rendererInvoke<{ type: 'catalog_preferences.get' }, CatalogPreferencesV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_catalog_preferences_get,
  { type: 'catalog_preferences.get' },
)

export const setCatalogPreference = <Section extends StorageCatalogPreferenceSetRequest['section']>(
  section: Section,
  value: Extract<StorageCatalogPreferenceSetRequest, { section: Section }>['value'],
) => rendererInvoke<StorageCatalogPreferenceSetRequest, CatalogPreferencesV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_catalog_preference_set,
  toCloneable({ type: 'catalog_preference.set', section, value } as StorageCatalogPreferenceSetRequest),
)

export const getLocalState = () => rendererInvoke<{ type: 'local_state.get' }, LocalStateSnapshotV1>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_local_state_get,
  { type: 'local_state.get' },
)

export const setLocalState = (update: LocalStateUpdateV1) => rendererInvoke<
{ type: 'local_state.set', update: LocalStateUpdateV1 }, LocalStateSnapshotV1
>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_local_state_set,
  toCloneable({ type: 'local_state.set', update }),
)

export const getPlaylistMetadata = () => rendererInvoke<{ type: 'playlist_metadata.get' }, LX.List.ListUpdateInfo>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_playlist_metadata_get,
  { type: 'playlist_metadata.get' },
)

export const mutatePlaylistMetadata = (command: PlaylistMetadataCommandV1) => rendererInvoke<
{ type: 'playlist_metadata.mutate', command: PlaylistMetadataCommandV1 }, LX.List.ListUpdateInfo
>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_playlist_metadata_mutate,
  toCloneable({ type: 'playlist_metadata.mutate', command }),
)

export const getSearchHistory = () => rendererInvoke<{ type: 'search_history.get' }, string[]>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_search_history_get,
  { type: 'search_history.get' },
)

export const mutateSearchHistory = (command: SearchHistoryCommandV1) => rendererInvoke<
{ type: 'search_history.mutate', command: SearchHistoryCommandV1 }, string[]
>(
  WIN_MAIN_RENDERER_EVENT_NAME.storage_search_history_mutate,
  toCloneable({ type: 'search_history.mutate', command }),
)
