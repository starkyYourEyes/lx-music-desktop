import type Database from 'better-sqlite3'
import { canonicalJson, type JsonValue } from '../../../../../common/storage/canonicalJson'
import { DEFAULT_SETTING } from '../../../../../common/constants'
import type { LocalStateSnapshotV1 } from '../../../../../common/storage/stateContracts'
import {
  parseLocalStateSnapshot,
  parseLocalStateUpdate,
  parsePlaylistMetadataCommand,
  parseSearchHistoryCommand,
} from '../../../../../common/storage/stateValidation'
import { getAppDB } from '../../db'
import { mergeMetadataUpdate } from '../../../../../common/utils/playlistMetadataMerge'
import { getMigrationMarker, putMigrationMarker } from '../../migrate'
import type { MigrationMarker } from '../../migrations/types'
import type {
  LegacyNonActivityImportResultV1,
  LegacyNonActivityImportV1,
  LocalStateKey,
  LocalStateRow,
  NonActivityMarkerCommandV1,
  NonActivityMarkerNameV1,
  PlaylistMetadataRow,
  SearchHistoryRow,
} from './index'
import {
  createClearLocalStateStatement,
  createClearPlaylistMetadataStatement,
  createClearSearchHistoryStatement,
  createDeletePlaylistMetadataStatement,
  createDeleteSearchHistoryTermStatement,
  createGetLocalStateStatement,
  createGetMaxSearchRecencyStatement,
  createGetPlaylistMetadataCountStatement,
  createGetPlaylistMetadataStatement,
  createGetSearchHistoryStatement,
  createGetSearchHistoryTermStatement,
  createInsertSearchHistoryStatement,
  createHasPlaylistMetadataStatement,
  createTrimSearchHistoryStatement,
  createUpsertLocalStateStatement,
  createUpsertPlaylistMetadataStatement,
} from './statements'

const SEARCH_HISTORY_LIMIT = 15
const MAX_PLAYLIST_METADATA_ENTRIES = 10_000
const markerHashPattern = /^[0-9a-f]{64}$/

const markerNames: readonly NonActivityMarkerNameV1[] = [
  'legacy_data_v1.local_state',
  'legacy_data_v1.playlist_metadata',
  'legacy_data_v1.search_history',
  'legacy_data_v1.catalog_preferences',
  'legacy_data_v1.phase2_complete',
]

const localStateProperties: Record<LocalStateKey, keyof Omit<LocalStateSnapshotV1, 'version'>> = {
  view_prev_state: 'viewPrevState',
  list_scroll_positions: 'listScrollPosition',
  list_prev_select_id: 'listPrevSelectId',
}

const defaultLocalState = parseLocalStateSnapshot({
  version: 1,
  viewPrevState: DEFAULT_SETTING.viewPrevState,
  listScrollPosition: {},
  listPrevSelectId: 'default',
})

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && !Array.isArray(value) && typeof value == 'object' && Object.getPrototypeOf(value) == Object.prototype

const assertMarkerName: (name: unknown) => asserts name is NonActivityMarkerNameV1 = name => {
  if (typeof name != 'string' || !markerNames.includes(name as NonActivityMarkerNameV1)) {
    throw new Error('Invalid non-activity migration marker name')
  }
}

const validateMarker = (marker: unknown): NonActivityMarkerCommandV1 => {
  if (!isPlainRecord(marker)) throw new Error('Invalid non-activity migration marker')
  const keys = Object.keys(marker)
  if (keys.length != 4 || keys.some(key => !['name', 'sourceSha256', 'completedAtMs', 'detailsJson'].includes(key))) {
    throw new Error('Invalid non-activity migration marker')
  }
  assertMarkerName(marker.name)
  if (typeof marker.sourceSha256 != 'string' || !markerHashPattern.test(marker.sourceSha256)) {
    throw new Error('Invalid non-activity migration marker source SHA-256')
  }
  if (!Number.isSafeInteger(marker.completedAtMs) || (marker.completedAtMs as number) < 0) {
    throw new Error('Invalid non-activity migration marker completion timestamp')
  }
  if (typeof marker.detailsJson != 'string') throw new Error('Invalid non-activity migration marker details JSON')
  let details: unknown
  try {
    details = JSON.parse(marker.detailsJson)
  } catch {
    throw new Error('Invalid non-activity migration marker details JSON')
  }
  if (!isPlainRecord(details) || details.version !== 1) {
    throw new Error('Invalid non-activity migration marker details envelope')
  }
  return {
    name: marker.name,
    sourceSha256: marker.sourceSha256,
    completedAtMs: marker.completedAtMs as number,
    detailsJson: marker.detailsJson,
  }
}

const jsonStringify = (value: unknown): string => canonicalJson(value as JsonValue)

const parseJson = (value: string, field: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error(`Invalid ${field} JSON`)
  }
}

const isSafeNonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

const assertLocalStateRow = (row: LocalStateRow): void => {
  if (!Object.hasOwn(localStateProperties, row.key) || row.version !== 1 ||
    typeof row.valueJson != 'string' || !isSafeNonNegativeInteger(row.updatedAtMs)) {
    throw new Error('Invalid authoritative local state row')
  }
}

const assertSearchHistoryRow = (row: SearchHistoryRow): void => {
  try {
    parseSearchHistoryCommand({ version: 1, action: 'remove', term: row.term })
  } catch {
    throw new Error('Invalid authoritative search history row')
  }
  if (!Number.isSafeInteger(row.recencySeq) || row.recencySeq < 1 ||
    (row.lastUsedAtMs != null && !isSafeNonNegativeInteger(row.lastUsedAtMs)) ||
    !Number.isSafeInteger(row.useCount) || row.useCount < 1) {
    throw new Error('Invalid authoritative search history row')
  }
}

const normalizeLocalState = (value: unknown): LocalStateSnapshotV1 => parseLocalStateSnapshot(value)

const localStateRows = (snapshot: LocalStateSnapshotV1, updatedAtMs: number): LocalStateRow[] =>
  (Object.entries(localStateProperties) as Array<[LocalStateKey, keyof Omit<LocalStateSnapshotV1, 'version'>]>).map(([key, property]) => ({
    key,
    version: 1,
    valueJson: jsonStringify(snapshot[property]),
    updatedAtMs,
  }))

const readLocalState = (): LocalStateSnapshotV1 => {
  const rows = createGetLocalStateStatement().all()
  if (rows.length > 3) throw new Error('Authoritative local state has unexpected rows')
  for (const row of rows) assertLocalStateRow(row)
  const values = new Map(rows.map(row => [row.key, parseJson(row.valueJson, `local state ${row.key}`)]))
  const valueOrDefault = (key: LocalStateKey): unknown => values.has(key)
    ? values.get(key)
    : defaultLocalState[localStateProperties[key]]
  return parseLocalStateSnapshot({
    version: 1,
    viewPrevState: valueOrDefault('view_prev_state'),
    listScrollPosition: valueOrDefault('list_scroll_positions'),
    listPrevSelectId: valueOrDefault('list_prev_select_id'),
  })
}

const normalizePlaylistMetadata = (value: unknown): LX.List.ListUpdateInfo => {
  if (!isPlainRecord(value)) throw new Error('Invalid playlist metadata')
  const entries = Object.entries(value)
  if (entries.length > MAX_PLAYLIST_METADATA_ENTRIES) throw new Error('Invalid playlist metadata')
  return Object.fromEntries(entries.map(([playlistId, item]) => {
    const command = parsePlaylistMetadataCommand({
      version: 1,
      action: 'upsert',
      playlistId,
      value: item,
      updatedAtMs: 0,
    })
    if (command.action != 'upsert') throw new Error('Invalid playlist metadata')
    return [command.playlistId, command.value]
  }))
}

const playlistMetadataRow = (
  playlistId: string,
  value: LX.List.ListUpdateInfo[string],
  updatedAtMs: number,
): PlaylistMetadataRow => ({
  playlistId,
  isAutoUpdate: value.isAutoUpdate ? 1 : 0,
  updateTimeMs: value.updateTime,
  profileJson: value.profile == null ? null : jsonStringify(value.profile),
  updatedAtMs,
})

const readPlaylistMetadata = (): LX.List.ListUpdateInfo => {
  const rows = createGetPlaylistMetadataStatement().all()
  if (rows.length > MAX_PLAYLIST_METADATA_ENTRIES) throw new Error('Playlist metadata limit exceeded')
  return Object.fromEntries(rows.map(row => {
    const value: LX.List.ListUpdateInfo[string] = {
      updateTime: row.updateTimeMs,
      isAutoUpdate: row.isAutoUpdate == 1,
    }
    if (row.profileJson != null) value.profile = parseJson(row.profileJson, `playlist metadata ${row.playlistId}`) as LX.List.UserListProfile
    const command = parsePlaylistMetadataCommand({
      version: 1,
      action: 'upsert',
      playlistId: row.playlistId,
      value,
      updatedAtMs: row.updatedAtMs,
    })
    if (command.action != 'upsert') throw new Error('Invalid playlist metadata row')
    return [command.playlistId, command.value]
  }))
}

const normalizeSearchHistory = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('Invalid search history')
  const seen = new Set<string>()
  const result: string[] = []
  for (const term of value) {
    const command = parseSearchHistoryCommand({ version: 1, action: 'remove', term })
    if (command.action != 'remove') throw new Error('Invalid search history')
    if (seen.has(command.term)) continue
    seen.add(command.term)
    if (result.length < SEARCH_HISTORY_LIMIT) result.push(command.term)
  }
  return result
}

const readSearchHistory = (): string[] => createGetSearchHistoryStatement().all().map(row => {
  assertSearchHistoryRow(row)
  return row.term
})

const validateImport = (input: unknown): {
  localState: LocalStateSnapshotV1
  playlistMetadata: LX.List.ListUpdateInfo
  searchHistory: string[]
  markers: LegacyNonActivityImportV1['markers']
} => {
  if (!isPlainRecord(input)) throw new Error('Invalid legacy non-activity import')
  const keys = Object.keys(input)
  if (keys.length != 4 || keys.some(key => !['localState', 'playlistMetadata', 'searchHistory', 'markers'].includes(key))) {
    throw new Error('Invalid legacy non-activity import')
  }
  if (!isPlainRecord(input.markers)) throw new Error('Invalid legacy non-activity import markers')
  const markerKeys = Object.keys(input.markers)
  if (markerKeys.length != 3 || markerKeys.some(key => !['localState', 'playlistMetadata', 'searchHistory'].includes(key))) {
    throw new Error('Invalid legacy non-activity import markers')
  }
  const markers = {
    localState: validateMarker(input.markers.localState),
    playlistMetadata: validateMarker(input.markers.playlistMetadata),
    searchHistory: validateMarker(input.markers.searchHistory),
  }
  if (markers.localState.name != 'legacy_data_v1.local_state') throw new Error('Invalid local state marker')
  if (markers.playlistMetadata.name != 'legacy_data_v1.playlist_metadata') throw new Error('Invalid playlist metadata marker')
  if (markers.searchHistory.name != 'legacy_data_v1.search_history') throw new Error('Invalid search history marker')
  return {
    localState: normalizeLocalState(input.localState),
    playlistMetadata: normalizePlaylistMetadata(input.playlistMetadata),
    searchHistory: normalizeSearchHistory(input.searchHistory),
    markers: markers as LegacyNonActivityImportV1['markers'],
  }
}

const markerNeedsImport = (marker: NonActivityMarkerCommandV1): boolean => {
  const existing = getMigrationMarker(getAppDB(), marker.name)
  if (existing == null) return true
  if (existing.sourceSha256 != marker.sourceSha256) {
    throw new Error(`Migration marker ${marker.name} source conflict`)
  }
  return false
}

const assertSame = (expected: unknown, actual: unknown, field: string): void => {
  if (canonicalJson(expected as JsonValue) != canonicalJson(actual as JsonValue)) {
    throw new Error(`${field} import readback failed`)
  }
}

export const queryLocalState = (): LocalStateSnapshotV1 => readLocalState()

export const updateLocalState = (input: unknown): LocalStateSnapshotV1 => {
  const update = parseLocalStateUpdate(input)
  return getAppDB().transaction(() => {
    createUpsertLocalStateStatement().run({
      key: update.key,
      version: 1,
      valueJson: jsonStringify(update.value),
      updatedAtMs: update.updatedAtMs,
    })
    return readLocalState()
  })()
}

export const deleteAllLocalState = (): void => {
  getAppDB().transaction(() => {
    createClearLocalStateStatement().run()
    readLocalState()
  })()
}

export const clearLocalStateInTransaction = (db: Database.Database): void => {
  db.prepare('DELETE FROM local_state').run()
}

export const queryPlaylistMetadata = (): LX.List.ListUpdateInfo => readPlaylistMetadata()

export const mutatePlaylistMetadata = (input: unknown): LX.List.ListUpdateInfo => {
  const command = parsePlaylistMetadataCommand(input)
  return getAppDB().transaction(() => {
    switch (command.action) {
      case 'upsert': {
        const exists = createHasPlaylistMetadataStatement().get(command.playlistId) != null
        const countRow = createGetPlaylistMetadataCountStatement().get()
        if (countRow == null || !Number.isSafeInteger(countRow.count) || countRow.count < 0) {
          throw new Error('Invalid playlist metadata count')
        }
        if (!exists && countRow.count >= MAX_PLAYLIST_METADATA_ENTRIES) {
          throw new Error('Playlist metadata limit exceeded')
        }
        createUpsertPlaylistMetadataStatement().run(playlistMetadataRow(
          command.playlistId,
          mergeMetadataUpdate(readPlaylistMetadata()[command.playlistId], command.value, command.base),
          command.updatedAtMs,
        ))
        break
      }
      case 'remove':
        createDeletePlaylistMetadataStatement().run(command.playlistId)
        break
      case 'retain': {
        const ids = Array.from(new Set(command.playlistIds))
        if (ids.length == 0) createClearPlaylistMetadataStatement().run()
        else getAppDB().prepare(`DELETE FROM playlist_metadata WHERE playlist_id NOT IN (${ids.map(() => '?').join(', ')})`).run(...ids)
        break
      }
    }
    return readPlaylistMetadata()
  })()
}

export const querySearchHistory = (): string[] => readSearchHistory()

export const mutateSearchHistory = (input: unknown): string[] => {
  const command = parseSearchHistoryCommand(input)
  return getAppDB().transaction(() => {
    switch (command.action) {
      case 'record': {
        const existing = createGetSearchHistoryTermStatement().get(command.term)
        if (existing != null) assertSearchHistoryRow(existing)
        const maxRecency = createGetMaxSearchRecencyStatement().get()?.recencySeq ?? 0
        if (!Number.isSafeInteger(maxRecency) || maxRecency < 0 || maxRecency >= Number.MAX_SAFE_INTEGER) {
          throw new Error('Invalid search history recency sequence')
        }
        createDeleteSearchHistoryTermStatement().run(command.term)
        createInsertSearchHistoryStatement().run({
          term: command.term,
          recencySeq: maxRecency + 1,
          lastUsedAtMs: command.usedAtMs,
          useCount: (existing?.useCount ?? 0) + 1,
        })
        createTrimSearchHistoryStatement().run()
        break
      }
      case 'remove':
        createDeleteSearchHistoryTermStatement().run(command.term)
        break
      case 'clear':
        createClearSearchHistoryStatement().run()
        break
    }
    return readSearchHistory()
  })()
}

export const importLegacyState = (input: unknown): LegacyNonActivityImportResultV1 => getAppDB().transaction(() => {
  const normalized = validateImport(input)
  const importLocalState = markerNeedsImport(normalized.markers.localState)
  const importPlaylistMetadata = markerNeedsImport(normalized.markers.playlistMetadata)
  const importSearchHistory = markerNeedsImport(normalized.markers.searchHistory)

  if (importLocalState) {
    for (const row of localStateRows(normalized.localState, 0)) createUpsertLocalStateStatement().run(row)
    assertSame(normalized.localState, readLocalState(), 'Local state')
  }
  if (importPlaylistMetadata) {
    createClearPlaylistMetadataStatement().run()
    for (const [playlistId, value] of Object.entries(normalized.playlistMetadata)) {
      createUpsertPlaylistMetadataStatement().run(playlistMetadataRow(playlistId, value, 0))
    }
    assertSame(normalized.playlistMetadata, readPlaylistMetadata(), 'Playlist metadata')
  }
  if (importSearchHistory) {
    createClearSearchHistoryStatement().run()
    for (let index = 0; index < normalized.searchHistory.length; index++) {
      createInsertSearchHistoryStatement().run({
        term: normalized.searchHistory[index],
        recencySeq: normalized.searchHistory.length - index,
        lastUsedAtMs: null,
        useCount: 1,
      })
    }
    assertSame(normalized.searchHistory, readSearchHistory(), 'Search history')
  }

  if (importLocalState) putMigrationMarker(getAppDB(), normalized.markers.localState)
  if (importPlaylistMetadata) putMigrationMarker(getAppDB(), normalized.markers.playlistMetadata)
  if (importSearchHistory) putMigrationMarker(getAppDB(), normalized.markers.searchHistory)
  return {
    localState: readLocalState(),
    playlistMetadata: readPlaylistMetadata(),
    searchHistory: readSearchHistory(),
  }
})()

export const queryNonActivityMarker = (name: unknown): MigrationMarker | null => {
  assertMarkerName(name)
  return getMigrationMarker(getAppDB(), name)
}

export const completeNonActivityMarker = (input: unknown): void => {
  const marker = validateMarker(input)
  getAppDB().transaction(() => {
    putMigrationMarker(getAppDB(), marker)
  })()
}
