import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import { canonicalJson, sha256Canonical, type JsonValue } from '../../../common/storage/canonicalJson'
import type { AtomicJsonFile } from '../../storage/atomicJsonFile'
import {
  parseSettingsDocument,
  replaceCatalogPreferences,
  type SettingsDocumentV1,
} from '../../storage/settings/document'
import type {
  LegacyNonActivityImportV1,
  LegacyNonActivityImportResultV1,
  MigrationMarker,
  NonActivityMarkerCommandV1,
  NonActivityMarkerNameV1,
} from '../../worker/dbService/modules/app_state'
import {
  normalizeNonActivitySource,
  type LegacyDataSnapshotV1,
  type NormalizedNonActivitySourceV1,
} from './source'

type Awaitable<T> = T | Promise<T>

export type NonActivityMigrationFailPoint =
  | 'before-database-import'
  | 'after-database-import'
  | 'before-config-replace'
  | 'after-config-replace'
  | 'before-catalog-marker'
  | 'after-catalog-marker'
  | 'before-smoke-check'
  | 'after-smoke-check'
  | 'before-phase2-marker'
  | 'after-phase2-marker'

export interface NonActivityMigrationDeps {
  source: LegacyDataSnapshotV1 | null
  settingsPath: string
  settingsDocument: SettingsDocumentV1
  settingsFile: Pick<AtomicJsonFile<SettingsDocumentV1>, 'read' | 'stage' | 'commit' | 'flush'>
  repository: {
    importLegacyNonActivity: (input: LegacyNonActivityImportV1) => Awaitable<LegacyNonActivityImportResultV1>
    getLocalState: () => Awaitable<LegacyNonActivityImportResultV1['localState']>
    getPlaylistMetadata: () => Awaitable<LegacyNonActivityImportResultV1['playlistMetadata']>
    getSearchHistory: () => Awaitable<LegacyNonActivityImportResultV1['searchHistory']>
    getNonActivityMigrationMarker: (name: NonActivityMarkerNameV1) => Awaitable<MigrationMarker | null>
    completeNonActivityMigrationMarker: (input: NonActivityMarkerCommandV1) => Awaitable<void>
  }
  now?: () => number
  failAt?: NonActivityMigrationFailPoint
}

export interface NonActivityMigrationResult {
  status: 'complete' | 'already-complete' | 'no-source'
  databaseCounts: { localState: number, playlistMetadata: number, searchHistory: number }
  catalogPreferencesSha256: string
}

const phase2MarkerName = 'legacy_data_v1.phase2_complete' as const
const catalogMarkerName = 'legacy_data_v1.catalog_preferences' as const

const assertSame = (expected: unknown, actual: unknown, description: string): void => {
  if (canonicalJson(expected as JsonValue) != canonicalJson(actual as JsonValue)) {
    throw new Error(`${description} migration readback failed`)
  }
}

const assertTimestamp = (value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid migration completion timestamp')
  return value
}

const failIfRequested = (deps: NonActivityMigrationDeps, point: NonActivityMigrationFailPoint): void => {
  if (deps.failAt == point) throw new Error('injected failure')
}

const marker = (
  name: NonActivityMarkerNameV1,
  sourceSha256: string,
  completedAtMs: number,
  details: Record<string, JsonValue>,
): NonActivityMarkerCommandV1 => ({
  name,
  sourceSha256,
  completedAtMs,
  detailsJson: canonicalJson({ version: 1, ...details }),
})

const assertCompatibleMarker = (existing: MigrationMarker | null, sourceSha256: string, name: string): boolean => {
  if (existing == null) return false
  if (existing.sourceSha256 != sourceSha256) throw new Error(`Migration marker ${name} source conflict`)
  return true
}

const databaseCounts = (result: LegacyNonActivityImportResultV1): NonActivityMigrationResult['databaseCounts'] => ({
  localState: 3,
  playlistMetadata: Object.keys(result.playlistMetadata).length,
  searchHistory: result.searchHistory.length,
})

const smokeRead = async(
  deps: NonActivityMigrationDeps,
  normalized: NormalizedNonActivitySourceV1,
): Promise<{ result: LegacyNonActivityImportResultV1, settings: SettingsDocumentV1 }> => {
  const result = {
    localState: await deps.repository.getLocalState(),
    playlistMetadata: await deps.repository.getPlaylistMetadata(),
    searchHistory: await deps.repository.getSearchHistory(),
  }
  assertSame(normalized.localState, result.localState, 'Local state')
  assertSame(normalized.playlistMetadata, result.playlistMetadata, 'Playlist metadata')
  assertSame(normalized.searchHistory, result.searchHistory, 'Search history')
  const active = await deps.settingsFile.read()
  if (active == null) throw new Error('Settings migration readback failed')
  const settings = parseSettingsDocument(active)
  assertSame(normalized.catalogPreferences, settings.catalogPreferences, 'Catalog preferences')
  return { result, settings }
}

const currentSettingsFileSha256 = async(settingsPath: string): Promise<string> =>
  createHash('sha256').update(await fs.readFile(settingsPath)).digest('hex')

export const migrateLegacyNonActivity = async(
  deps: NonActivityMigrationDeps,
): Promise<NonActivityMigrationResult> => {
  if (deps.source == null) {
    const current = parseSettingsDocument(deps.settingsDocument)
    return {
      status: 'no-source',
      databaseCounts: { localState: 0, playlistMetadata: 0, searchHistory: 0 },
      catalogPreferencesSha256: createHash('sha256')
        .update(canonicalJson(current.catalogPreferences as unknown as JsonValue))
        .digest('hex'),
    }
  }

  const normalized = normalizeNonActivitySource(deps.source.parsed)
  const phase2SourceSha256 = sha256Canonical({ version: 1, ...normalized.hashes })
  const existingPhase2 = await deps.repository.getNonActivityMigrationMarker(phase2MarkerName)
  if (assertCompatibleMarker(existingPhase2, phase2SourceSha256, phase2MarkerName)) {
    const smoke = await smokeRead(deps, normalized)
    return {
      status: 'already-complete',
      databaseCounts: databaseCounts(smoke.result),
      catalogPreferencesSha256: normalized.hashes.catalogPreferences,
    }
  }
  const completedAtMs = assertTimestamp((deps.now ?? Date.now)())

  failIfRequested(deps, 'before-database-import')
  await deps.repository.importLegacyNonActivity({
    localState: normalized.localState,
    playlistMetadata: normalized.playlistMetadata,
    searchHistory: normalized.searchHistory,
    markers: {
      localState: marker('legacy_data_v1.local_state', normalized.hashes.localState, completedAtMs, { domain: 'local_state' }) as LegacyNonActivityImportV1['markers']['localState'],
      playlistMetadata: marker('legacy_data_v1.playlist_metadata', normalized.hashes.playlistMetadata, completedAtMs, { domain: 'playlist_metadata' }) as LegacyNonActivityImportV1['markers']['playlistMetadata'],
      searchHistory: marker('legacy_data_v1.search_history', normalized.hashes.searchHistory, completedAtMs, { domain: 'search_history' }) as LegacyNonActivityImportV1['markers']['searchHistory'],
    },
  })
  failIfRequested(deps, 'after-database-import')

  const existingCatalog = await deps.repository.getNonActivityMigrationMarker(catalogMarkerName)
  let settingsFileSha256: string
  if (!assertCompatibleMarker(existingCatalog, normalized.hashes.catalogPreferences, catalogMarkerName)) {
    const current = parseSettingsDocument(deps.settingsDocument)
    if (canonicalJson(current.catalogPreferences as unknown as JsonValue) !=
        canonicalJson(normalized.catalogPreferences as unknown as JsonValue)) {
      failIfRequested(deps, 'before-config-replace')
      const next = replaceCatalogPreferences(current, normalized.catalogPreferences)
      const stage = await deps.settingsFile.stage(next, 'next')
      await deps.settingsFile.flush()
      const staged = parseSettingsDocument(JSON.parse(await fs.readFile(stage.filePath, 'utf8')))
      assertSame(normalized.catalogPreferences, staged.catalogPreferences, 'Staged catalog preferences')
      settingsFileSha256 = (await deps.settingsFile.commit(stage)).fileSha256
      failIfRequested(deps, 'after-config-replace')
    } else {
      settingsFileSha256 = await currentSettingsFileSha256(deps.settingsPath)
    }
    failIfRequested(deps, 'before-catalog-marker')
    await deps.repository.completeNonActivityMigrationMarker(marker(
      catalogMarkerName,
      normalized.hashes.catalogPreferences,
      completedAtMs,
      { destinationFileSha256: settingsFileSha256 },
    ))
    failIfRequested(deps, 'after-catalog-marker')
  }

  failIfRequested(deps, 'before-smoke-check')
  const smoke = await smokeRead(deps, normalized)
  failIfRequested(deps, 'after-smoke-check')
  const counts = databaseCounts(smoke.result)

  failIfRequested(deps, 'before-phase2-marker')
  await deps.repository.completeNonActivityMigrationMarker(marker(
    phase2MarkerName,
    phase2SourceSha256,
    completedAtMs,
    {
      catalogPreferencesSha256: normalized.hashes.catalogPreferences,
      localStateCount: counts.localState,
      playlistMetadataCount: counts.playlistMetadata,
      searchHistoryCount: counts.searchHistory,
    },
  ))
  failIfRequested(deps, 'after-phase2-marker')

  return {
    status: 'complete',
    databaseCounts: counts,
    catalogPreferencesSha256: normalized.hashes.catalogPreferences,
  }
}
