import { STORE_NAMES } from '@common/constants'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import type {
  CatalogPreferencesV1,
  LocalStateSnapshotV1,
  LocalStateUpdateV1,
  PlaylistMetadataCommandV1,
  SearchHistoryCommandV1,
  StorageCatalogPreferenceSetRequest,
  StorageStateRequest,
  StorageStateResponse,
} from '@common/storage/stateContracts'
import {
  parseCatalogPreferences,
  parseLocalStateUpdate,
  parsePlaylistMetadataCommand,
  parseSearchHistoryCommand,
} from '@common/storage/stateValidation'
import { assertRecord } from '@common/storage/validation'
import { updateCatalogPreferences } from '@main/utils'
import getStore from '@main/utils/store'
import { parseSettingsDocument } from '../../../storage/settings/document'
import { notifyPlaylistMetadataChanged } from '@main/modules/sync/listProfileEvent'

type Awaitable<T> = Promise<T> | T

export interface StorageStateHandlerDependencies {
  getCatalogPreferences: () => Awaitable<CatalogPreferencesV1>
  updateCatalogPreferences: (preferences: CatalogPreferencesV1) => Awaitable<{ catalogPreferences: CatalogPreferencesV1 }>
  getLocalState: () => Awaitable<LocalStateSnapshotV1>
  setLocalState: (update: LocalStateUpdateV1) => Awaitable<LocalStateSnapshotV1>
  getPlaylistMetadata: () => Awaitable<LX.List.ListUpdateInfo>
  applyPlaylistMetadata: (command: PlaylistMetadataCommandV1) => Awaitable<LX.List.ListUpdateInfo>
  getSearchHistory: () => Awaitable<string[]>
  applySearchHistory: (command: SearchHistoryCommandV1) => Awaitable<string[]>
}

const requestTypes = new Set<StorageStateRequest['type']>([
  'catalog_preferences.get',
  'catalog_preference.set',
  'local_state.get',
  'local_state.set',
  'playlist_metadata.get',
  'playlist_metadata.mutate',
  'search_history.get',
  'search_history.mutate',
])

const invalidRequest = (): never => {
  throw new Error('Invalid storage state request')
}

const assertStorageRecord: (value: unknown, field: string) => asserts value is Record<string, unknown> = assertRecord

const parseRequestRecord = (request: unknown): Record<string, unknown> => {
  assertStorageRecord(request, 'storage state request')
  if (typeof request.type != 'string' || !requestTypes.has(request.type as StorageStateRequest['type'])) invalidRequest()
  return request
}

const assertExactKeys = (request: Record<string, unknown>, keys: string[]): void => {
  if (Object.keys(request).length != keys.length || keys.some(key => !Object.hasOwn(request, key))) invalidRequest()
}

const catalogValidationBase: CatalogPreferencesV1 = {
  version: 1,
  leaderboard: { source: 'kw', boardId: 'kw__16' },
  songList: { source: 'kw', sortId: 'new', tagId: '' },
  search: { temp_source: 'kw', source: 'all', type: 'music' },
}

const parseCatalogPreferenceSetRequest = (request: Record<string, unknown>): StorageCatalogPreferenceSetRequest => {
  assertExactKeys(request, ['type', 'section', 'value'])
  if (request.type != 'catalog_preference.set') invalidRequest()
  switch (request.section) {
    case 'leaderboard':
      parseCatalogPreferences({ ...catalogValidationBase, leaderboard: request.value })
      break
    case 'songList':
      parseCatalogPreferences({ ...catalogValidationBase, songList: request.value })
      break
    case 'search':
      parseCatalogPreferences({ ...catalogValidationBase, search: request.value })
      break
    default:
      invalidRequest()
  }
  return request as StorageCatalogPreferenceSetRequest
}

export const createStorageStateDispatcher = (deps: StorageStateHandlerDependencies) => {
  let catalogWriteQueue = Promise.resolve()
  const setCatalogPreference = async(parsed: StorageCatalogPreferenceSetRequest): Promise<CatalogPreferencesV1> => {
    const write = catalogWriteQueue.then(async() => {
      const current = parseCatalogPreferences(await deps.getCatalogPreferences())
      const next = parseCatalogPreferences({ ...current, [parsed.section]: parsed.value })
      const result = await deps.updateCatalogPreferences(next)
      return parseCatalogPreferences(result.catalogPreferences)
    })
    catalogWriteQueue = write.then(() => {}, () => {})
    return write
  }

  return async(
    input: unknown,
    expectedType?: StorageStateRequest['type'],
  ): Promise<StorageStateResponse> => {
    const request = parseRequestRecord(input)
    if (expectedType != null && request.type != expectedType) invalidRequest()

    switch (request.type) {
      case 'catalog_preferences.get':
        assertExactKeys(request, ['type'])
        return parseCatalogPreferences(await deps.getCatalogPreferences())
      case 'catalog_preference.set':
        return setCatalogPreference(parseCatalogPreferenceSetRequest(request))
      case 'local_state.get':
        assertExactKeys(request, ['type'])
        return await deps.getLocalState()
      case 'local_state.set':
        assertExactKeys(request, ['type', 'update'])
        return await deps.setLocalState(parseLocalStateUpdate(request.update))
      case 'playlist_metadata.get':
        assertExactKeys(request, ['type'])
        return await deps.getPlaylistMetadata()
      case 'playlist_metadata.mutate':
        assertExactKeys(request, ['type', 'command'])
        return await deps.applyPlaylistMetadata(parsePlaylistMetadataCommand(request.command))
      case 'search_history.get':
        assertExactKeys(request, ['type'])
        return await deps.getSearchHistory()
      case 'search_history.mutate':
        assertExactKeys(request, ['type', 'command'])
        return await deps.applySearchHistory(parseSearchHistoryCommand(request.command))
      default:
        return invalidRequest()
    }
  }
}

const getCatalogPreferences = (): CatalogPreferencesV1 => {
  const store = getStore(STORE_NAMES.APP_SETTINGS)
  const value: Record<string, unknown> = {
    version: store.get('version'),
    setting: store.get('setting'),
  }
  if (store.has('storageSchemaVersion')) value.storageSchemaVersion = store.get('storageSchemaVersion')
  if (store.has('catalogPreferences')) value.catalogPreferences = store.get('catalogPreferences')
  return parseSettingsDocument(value).catalogPreferences
}

export default () => {
  const dispatch = createStorageStateDispatcher({
    getCatalogPreferences,
    updateCatalogPreferences,
    getLocalState: () => global.lx.worker.dbService.getLocalState(),
    setLocalState: update => global.lx.worker.dbService.setLocalState(update),
    getPlaylistMetadata: () => global.lx.worker.dbService.getPlaylistMetadata(),
    applyPlaylistMetadata: async command => {
      const metadata = await global.lx.worker.dbService.applyPlaylistMetadata(command)
      notifyPlaylistMetadataChanged(metadata)
      return metadata
    },
    getSearchHistory: () => global.lx.worker.dbService.getSearchHistory(),
    applySearchHistory: command => global.lx.worker.dbService.applySearchHistory(command),
  })
  const register = (channel: string, type: StorageStateRequest['type']) => {
    mainHandle<unknown, StorageStateResponse>(channel, async({ params }) => dispatch(params, type))
  }

  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_catalog_preferences_get, 'catalog_preferences.get')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_catalog_preference_set, 'catalog_preference.set')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_local_state_get, 'local_state.get')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_local_state_set, 'local_state.set')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_playlist_metadata_get, 'playlist_metadata.get')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_playlist_metadata_mutate, 'playlist_metadata.mutate')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_search_history_get, 'search_history.get')
  register(WIN_MAIN_RENDERER_EVENT_NAME.storage_search_history_mutate, 'search_history.mutate')
}
