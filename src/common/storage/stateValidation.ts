import {
  assertBoundedString,
  assertFiniteInteger,
  assertJsonByteSize,
  assertRecord,
} from './validation'
import {
  type CatalogPreferencesV1,
  type LocalStateSnapshotV1,
  type LocalStateUpdateV1,
  type PlaylistMetadataCommandV1,
  type SearchHistoryCommandV1,
} from './stateContracts'

const MAX_ID_LENGTH = 256
const MAX_URL_LENGTH = 4096
const MAX_JSON_BYTES = 32 * 1024
const MAX_MAP_ENTRIES = 10_000
const MAX_SEARCH_TERM_LENGTH = 200
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const ONLINE_SOURCES = new Set(['kw', 'kg', 'tx', 'wy', 'mg'])
const assertStorageRecord: (value: unknown, field: string) => asserts value is Record<string, unknown> = assertRecord
const assertStorageString: (value: unknown, field: string, minimum: number, maximum: number) => asserts value is string = assertBoundedString
const assertStorageInteger: (value: unknown, field: string, minimum: number, maximum: number) => asserts value is number = assertFiniteInteger

const invalidField: (field: string) => never = field => {
  throw new Error(`Invalid ${field}`)
}

const asValidated = <T>(value: unknown): T => value as T

const assertExactKeys = (value: Record<string, unknown>, field: string, keys: readonly string[]): void => {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) invalidField(field)
}

const assertVersion: (value: unknown) => asserts value is 1 = value => {
  if (value !== 1) invalidField('version')
}

const assertSafeTimestamp: (value: unknown, field: string) => asserts value is number = (value, field) => {
  assertStorageInteger(value, field, 0, MAX_SAFE_INTEGER)
}

const assertId: (value: unknown, field: string, minimum?: number) => asserts value is string = (value, field, minimum = 1) => {
  assertStorageString(value, field, minimum, MAX_ID_LENGTH)
}

const assertOnlineSource: (value: unknown, field: string) => asserts value is LX.OnlineSource = (value, field) => {
  if (typeof value != 'string' || !ONLINE_SOURCES.has(value)) invalidField(field)
}

const assertViewPrevState: (value: unknown) => asserts value is LocalStateSnapshotV1['viewPrevState'] = value => {
  assertStorageRecord(value, 'viewPrevState')
  assertExactKeys(value, 'viewPrevState', ['url', 'query'])
  assertStorageString(value.url, 'url', 1, MAX_URL_LENGTH)
  assertStorageRecord(value.query, 'query')
  assertJsonByteSize(value.query, 'query', MAX_JSON_BYTES)
}

const assertListScrollPosition: (value: unknown) => asserts value is LX.List.ListPositionInfo = value => {
  assertStorageRecord(value, 'listScrollPosition')
  const entries = Object.entries(value)
  if (entries.length > MAX_MAP_ENTRIES) invalidField('listScrollPosition')
  for (const [id, position] of entries) {
    assertId(id, 'listScrollPosition')
    if (typeof position != 'number' || !Number.isFinite(position) || position < 0) invalidField('listScrollPosition')
  }
}

const assertPlaylistProfile: (value: unknown) => asserts value is LX.List.UserListProfile = value => {
  assertStorageRecord(value, 'profile')
  assertExactKeys(value, 'profile', ['description', 'coverUrl', 'createdAt'])
  if (Object.hasOwn(value, 'description') && typeof value.description != 'string') invalidField('description')
  if (Object.hasOwn(value, 'coverUrl')) assertStorageString(value.coverUrl, 'coverUrl', 1, MAX_URL_LENGTH)
  if (Object.hasOwn(value, 'createdAt')) assertSafeTimestamp(value.createdAt, 'createdAt')
  assertJsonByteSize(value, 'profile', MAX_JSON_BYTES)
}

const assertPlaylistUpdateInfo: (value: unknown) => asserts value is LX.List.ListUpdateInfo[string] = value => {
  assertStorageRecord(value, 'value')
  assertExactKeys(value, 'value', ['updateTime', 'isAutoUpdate', 'profile'])
  assertSafeTimestamp(value.updateTime, 'updateTime')
  if (typeof value.isAutoUpdate != 'boolean') invalidField('isAutoUpdate')
  if (Object.hasOwn(value, 'profile')) assertPlaylistProfile(value.profile)
}

export const parseCatalogPreferences = (value: unknown): CatalogPreferencesV1 => {
  assertStorageRecord(value, 'preferences')
  assertExactKeys(value, 'preferences', ['version', 'leaderboard', 'songList', 'search'])
  assertVersion(value.version)

  assertStorageRecord(value.leaderboard, 'leaderboard')
  assertExactKeys(value.leaderboard, 'leaderboard', ['source', 'boardId'])
  assertOnlineSource(value.leaderboard.source, 'source')
  assertId(value.leaderboard.boardId, 'boardId')

  assertStorageRecord(value.songList, 'songList')
  assertExactKeys(value.songList, 'songList', ['source', 'sortId', 'tagId'])
  assertOnlineSource(value.songList.source, 'source')
  assertId(value.songList.sortId, 'sortId')
  assertId(value.songList.tagId, 'tagId', 0)

  assertStorageRecord(value.search, 'search')
  assertExactKeys(value.search, 'search', ['temp_source', 'source', 'type'])
  assertOnlineSource(value.search.temp_source, 'temp_source')
  if (value.search.source != 'all') assertOnlineSource(value.search.source, 'source')
  if (value.search.type != 'music' && value.search.type != 'songlist') invalidField('type')
  return asValidated<CatalogPreferencesV1>(value)
}

export const parseLocalStateSnapshot = (value: unknown): LocalStateSnapshotV1 => {
  assertStorageRecord(value, 'snapshot')
  assertExactKeys(value, 'snapshot', ['version', 'viewPrevState', 'listScrollPosition', 'listPrevSelectId'])
  assertVersion(value.version)
  assertViewPrevState(value.viewPrevState)
  assertListScrollPosition(value.listScrollPosition)
  assertId(value.listPrevSelectId, 'listPrevSelectId')
  return asValidated<LocalStateSnapshotV1>(value)
}

export const parseLocalStateUpdate = (value: unknown): LocalStateUpdateV1 => {
  assertStorageRecord(value, 'update')
  assertExactKeys(value, 'update', ['version', 'key', 'value', 'updatedAtMs'])
  assertVersion(value.version)
  assertSafeTimestamp(value.updatedAtMs, 'updatedAtMs')
  switch (value.key) {
    case 'view_prev_state':
      assertViewPrevState(value.value)
      break
    case 'list_scroll_positions':
      assertListScrollPosition(value.value)
      break
    case 'list_prev_select_id':
      assertId(value.value, 'value')
      break
    default:
      invalidField('key')
  }
  return asValidated<LocalStateUpdateV1>(value)
}

export const parsePlaylistMetadataCommand = (value: unknown): PlaylistMetadataCommandV1 => {
  assertStorageRecord(value, 'command')
  assertVersion(value.version)
  switch (value.action) {
    case 'upsert':
      assertExactKeys(value, 'command', ['version', 'action', 'playlistId', 'value', 'updatedAtMs'])
      assertId(value.playlistId, 'playlistId')
      assertPlaylistUpdateInfo(value.value)
      assertSafeTimestamp(value.updatedAtMs, 'updatedAtMs')
      break
    case 'remove':
      assertExactKeys(value, 'command', ['version', 'action', 'playlistId'])
      assertId(value.playlistId, 'playlistId')
      break
    case 'retain':
      assertExactKeys(value, 'command', ['version', 'action', 'playlistIds'])
      {
        const playlistIds = value.playlistIds
        if (!Array.isArray(playlistIds)) invalidField('playlistIds')
        if (playlistIds.length > MAX_MAP_ENTRIES) invalidField('playlistIds')
        for (const id of playlistIds) assertId(id, 'playlistIds')
      }
      break
    default:
      invalidField('action')
  }
  return asValidated<PlaylistMetadataCommandV1>(value)
}

export const parseSearchHistoryCommand = (value: unknown): SearchHistoryCommandV1 => {
  assertStorageRecord(value, 'command')
  assertVersion(value.version)
  switch (value.action) {
    case 'record':
      assertExactKeys(value, 'command', ['version', 'action', 'term', 'usedAtMs'])
      assertStorageString(value.term, 'term', 1, MAX_SEARCH_TERM_LENGTH)
      assertSafeTimestamp(value.usedAtMs, 'usedAtMs')
      break
    case 'remove':
      assertExactKeys(value, 'command', ['version', 'action', 'term'])
      assertStorageString(value.term, 'term', 1, MAX_SEARCH_TERM_LENGTH)
      break
    case 'clear':
      assertExactKeys(value, 'command', ['version', 'action'])
      break
    default:
      invalidField('action')
  }
  return asValidated<SearchHistoryCommandV1>(value)
}
