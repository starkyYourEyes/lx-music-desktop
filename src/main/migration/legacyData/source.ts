import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DEFAULT_SETTING } from '../../../common/constants'
import { sha256Canonical, type JsonValue } from '../../../common/storage/canonicalJson'
import type { CatalogPreferencesV1, LocalStateSnapshotV1 } from '../../../common/storage/stateContracts'
import {
  parseCatalogPreferences,
  parseLocalStateSnapshot,
  parsePlaylistMetadataCommand,
  parseSearchHistoryCommand,
} from '../../../common/storage/stateValidation'

export interface LegacyDataSnapshotV1 {
  sourcePath: string
  parsed: Record<string, unknown>
  fileSha256: string
}

export type LegacyDataSourceResult =
  | { status: 'available', snapshot: LegacyDataSnapshotV1 }
  | { status: 'absent' }
  | {
    status: 'recovery'
    reason: 'legacy_data_invalid_json' | 'legacy_data_invalid_root'
    sourcePath: string
    fileSha256: string
    candidatePreviousPath: string | null
  }

export interface NormalizedNonActivitySourceV1 {
  localState: LocalStateSnapshotV1
  playlistMetadata: LX.List.ListUpdateInfo
  searchHistory: string[]
  catalogPreferences: CatalogPreferencesV1
  hashes: {
    localState: string
    playlistMetadata: string
    searchHistory: string
    catalogPreferences: string
  }
}

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code == 'ENOENT'

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const sha256Bytes = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')

const deepFreeze = <T>(value: T): T => {
  if (value != null && typeof value == 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

const validatedPreviousPath = async(sourcePath: string): Promise<string | null> => {
  const candidate = `${sourcePath}.previous`
  let bytes: Buffer
  try {
    bytes = await fs.readFile(candidate)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  try {
    return isPlainRecord(JSON.parse(bytes.toString('utf8'))) ? candidate : null
  } catch {
    return null
  }
}

const readSelectedSource = async(sourcePath: string): Promise<LegacyDataSourceResult> => {
  const bytes = await fs.readFile(sourcePath)
  const fileSha256 = sha256Bytes(bytes)
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    return {
      status: 'recovery',
      reason: 'legacy_data_invalid_json',
      sourcePath,
      fileSha256,
      candidatePreviousPath: await validatedPreviousPath(sourcePath),
    }
  }
  if (!isPlainRecord(parsed)) {
    return {
      status: 'recovery',
      reason: 'legacy_data_invalid_root',
      sourcePath,
      fileSha256,
      candidatePreviousPath: await validatedPreviousPath(sourcePath),
    }
  }
  return {
    status: 'available',
    snapshot: Object.freeze({
      sourcePath,
      parsed: deepFreeze(parsed),
      fileSha256,
    }),
  }
}

export const readLegacyDataSource = async(input: {
  profileRoot: string
  legacyRoot: string
}): Promise<LegacyDataSourceResult> => {
  const profilePath = path.join(input.profileRoot, 'data.json')
  try {
    return await readSelectedSource(profilePath)
  } catch (error) {
    if (!isMissing(error)) throw error
  }

  const legacyPath = path.join(input.legacyRoot, 'data.json')
  try {
    return await readSelectedSource(legacyPath)
  } catch (error) {
    if (isMissing(error)) return { status: 'absent' }
    throw error
  }
}

const normalizePlaylistMetadata = (value: unknown): LX.List.ListUpdateInfo => {
  if (value == null) return {}
  if (!isPlainRecord(value)) throw new Error('Invalid legacy playlist metadata')
  return Object.fromEntries(Object.entries(value).map(([playlistId, item]) => {
    if (!isPlainRecord(item)) throw new Error('Invalid legacy playlist metadata')
    const command = parsePlaylistMetadataCommand({
      version: 1,
      action: 'upsert',
      playlistId,
      value: {
        ...item,
        updateTime: item.updateTime ?? 0,
      },
      updatedAtMs: 0,
    })
    if (command.action != 'upsert') throw new Error('Invalid legacy playlist metadata')
    return [command.playlistId, command.value]
  }))
}

const normalizeSearchHistory = (value: unknown): string[] => {
  if (value == null) return []
  if (!Array.isArray(value)) throw new Error('Invalid legacy search history')
  const seen = new Set<string>()
  const result: string[] = []
  for (const term of value) {
    const command = parseSearchHistoryCommand({ version: 1, action: 'remove', term })
    if (command.action != 'remove') throw new Error('Invalid legacy search history')
    if (seen.has(command.term)) continue
    seen.add(command.term)
    if (result.length < 15) result.push(command.term)
  }
  return result
}

export const normalizeNonActivitySource = (source: Record<string, unknown>): NormalizedNonActivitySourceV1 => {
  const localState = parseLocalStateSnapshot({
    version: 1,
    viewPrevState: source.viewPrevState ?? DEFAULT_SETTING.viewPrevState,
    listScrollPosition: source.listScrollPosition ?? source.listPosition ?? {},
    listPrevSelectId: source.listPrevSelectId ?? 'default',
  })
  const playlistMetadata = normalizePlaylistMetadata(source.listUpdateInfo)
  const searchHistory = normalizeSearchHistory(source.searchHistoryList)
  const catalogPreferences = parseCatalogPreferences({
    version: 1,
    leaderboard: source.leaderboardSetting ?? DEFAULT_SETTING.leaderboard,
    songList: source.songListSetting ?? DEFAULT_SETTING.songList,
    search: source.searchSetting ?? DEFAULT_SETTING.search,
  })
  return {
    localState,
    playlistMetadata,
    searchHistory,
    catalogPreferences,
    hashes: {
      localState: sha256Canonical(localState as unknown as JsonValue),
      playlistMetadata: sha256Canonical(playlistMetadata as unknown as JsonValue),
      searchHistory: sha256Canonical(searchHistory),
      catalogPreferences: sha256Canonical(catalogPreferences as unknown as JsonValue),
    },
  }
}
