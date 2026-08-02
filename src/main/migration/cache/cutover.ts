import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import { storageFramedSha256 } from '../../../common/storage/cachePhase'
import { verifyDatabaseAgainstContract } from '../../worker/dbService/verifyDB'
import { databaseSchema6Contract, databaseSchema7Contract, type SchemaContract } from '../../worker/dbService/schemaContract'
import { SCHEMA7_REMOVED_OBJECTS } from '../../worker/dbService/tables'
import migration3 from '../../worker/dbService/migrations/0003_storage_foundation'
import migration4 from '../../worker/dbService/migrations/0004_account_profiles'
import migration5 from '../../worker/dbService/migrations/0005_non_activity_state'
import migration6 from '../../worker/dbService/migrations/0006_playback_activity'
import {
  parseRawLyricMarkerDetails,
  canonicalRawLyricHash,
  countAuthoritativeRawRows,
  deleteAuthoritativeRawRows,
  readAuthoritativeRawInventory,
  readRawLyricMarker,
  type RawLyricMarkerDetails,
  type RawLyricMarkerRow,
} from './rawLyrics'
import type * as CacheDb from '../../worker/dbService/cacheDb'
import type * as RawLyricRepository from '../../worker/dbService/modules/lyric/raw/repository'
import type * as MusicUrlRepository from '../../worker/dbService/modules/music_url'
import type * as OtherSourcesRepository from '../../worker/dbService/modules/music_other_source'

type CacheExecutionResult<T> = CacheDb.CacheExecutionResult<T>

export const READ_WRITE_MARKER_NAME = 'legacy_cache_v1.read_write_verified' as const
export const CUTOVER_MARKER_NAME = 'legacy_cache_v1.cutover' as const
export const CACHE_CLEANUP_MIGRATION_NAME = 'cache_cleanup' as const
export const CACHE_CLEANUP_MIGRATION_SOURCE = 'lx.storage.schema-migration.v7.cache-cleanup.v1' as const
export const CACHE_CLEANUP_MIGRATION_CHECKSUM = createHash('sha256')
  .update(CACHE_CLEANUP_MIGRATION_SOURCE)
  .digest('hex')

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const explicitSchema6Indexes = [
  'index_my_list_music_info',
  'index_my_list_music_info_order',
  'index_music_info_other_source',
  'playback_one_open_group',
  'playback_retention',
  'recent_tracks_order',
] as const
const explicitSchema7Indexes = explicitSchema6Indexes.filter(name => name != 'index_music_info_other_source')

export interface StrictMarkerRow<Name extends string = string> {
  name: Name
  sourceSha256: string
  completedAtMs: number
  detailsJson: string
}

export interface Phase4CheckV1 {
  evidenceSha256: string
  name: 'raw-lyric-write-read' | 'music-url-write-read-expiry' | 'other-sources-atomic-replace-read'
  version: 1
}

export interface ReadWriteDetailsV1 {
  cacheSchemaVersion: 1
  checks: [Phase4CheckV1, Phase4CheckV1, Phase4CheckV1]
  completedAtMs: number
  rawMarkerSha256: string
  version: 1
}

export interface CutoverDetailsV1 {
  completedAtMs: number
  fromSchemaVersion: 6
  rawLyricsDeletedRows: number
  readWriteMarkerSha256: string
  removedObjects: [...typeof SCHEMA7_REMOVED_OBJECTS]
  toSchemaVersion: 7
  version: 1
}

interface TypedSmokeEvidence {
  raw: JsonValue
  url: JsonValue
  other: JsonValue
}

const failure = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype
const hasExactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value)
  return actual.length == expected.length && actual.every(key => typeof key == 'string' && expected.includes(key))
}
const isSafeTimestamp = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= 0

export const framedSha256 = storageFramedSha256

export const markerRowSha256 = (row: StrictMarkerRow): string => framedSha256(
  'lx.storage.marker-row.v1',
  {
    completedAtMs: row.completedAtMs,
    detailsJson: row.detailsJson,
    name: row.name,
    sourceSha256: row.sourceSha256,
  },
)

const readMarkerRow = <Name extends string>(
  db: Database.Database,
  name: Name,
): StrictMarkerRow<Name> | null => {
  const row = db.prepare(`
    SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs,
      details_json AS detailsJson
    FROM migration_markers WHERE name = ?
  `).get(name) as Record<string, unknown> | undefined
  if (row == null) return null
  if (row.name != name || typeof row.sourceSha256 != 'string' || !SHA256_PATTERN.test(row.sourceSha256) ||
    !isSafeTimestamp(row.completedAtMs) || typeof row.detailsJson != 'string') {
    throw failure(`phase4_${name == READ_WRITE_MARKER_NAME ? 'read_write' : 'cutover'}_marker_invalid`)
  }
  return row as unknown as StrictMarkerRow<Name>
}

const rawMarkerDetails = (row: RawLyricMarkerRow): RawLyricMarkerDetails =>
  parseRawLyricMarkerDetails(row.detailsJson)

export const verifyRawMarker = (
  db: Database.Database,
  mode: 'schema6-current' | 'schema7-historical',
): RawLyricMarkerRow => {
  const marker = readRawLyricMarker(db)
  if (marker == null) throw failure('raw_lyric_marker_invalid')
  const details = rawMarkerDetails(marker)
  if (mode == 'schema6-current') {
    const inventory = readAuthoritativeRawInventory(db)
    const sourceRows = inventory.tuples.length
    const sourceOwnerGroups = new Set(inventory.tuples.map(row => row.sourceTrackId)).size
    const sourceSha256 = canonicalRawLyricHash(inventory.tuples)
    if (details.sourceRows != sourceRows || details.sourceOwnerGroups != sourceOwnerGroups ||
      details.skippedInvalidRows != inventory.skippedInvalidRows || details.sourceSha256 != sourceSha256 ||
      details.targetRows != sourceRows || details.targetOwnerGroups != sourceOwnerGroups ||
      details.targetSha256 != sourceSha256 || marker.sourceSha256 != sourceSha256) {
      throw failure('raw_lyric_marker_conflict')
    }
  }
  return marker
}

const rawEvidence: JsonValue = {
  identity: { provider: '__lx_phase4_smoke_v1__', sourceTrackId: 'raw' },
  read: { lyric: 'phase4-raw-lyric-v1', tlyric: 'phase4-raw-tlyric-v1' },
  written: { lyric: 'phase4-raw-lyric-v1', tlyric: 'phase4-raw-tlyric-v1' },
}

const urlEvidence: JsonValue = {
  expiredReadMiss: true,
  expiryGetNowMs: 1,
  freshGetNowMs: 0,
  freshReadMatched: true,
  identity: {
    accountScope: 'profile-v1:user-id:9007199254740991',
    provider: 'wy',
    quality: '128k',
    sourceTrackId: '__lx_phase4_smoke_v1__:url',
  },
  providerExpiresAtMs: 1,
  putNowMs: 0,
}

const firstCandidates = [{
  id: '__lx_phase4_smoke_v1__:old',
  interval: '00:01',
  meta: { albumName: 'phase4-old' },
  name: 'phase4-old',
  singer: 'phase4',
  source: 'wy',
}]

const replacementCandidates = [
  {
    id: '__lx_phase4_smoke_v1__:new-b',
    interval: '00:02',
    meta: { albumName: 'phase4-new-b' },
    name: 'phase4-new-b',
    singer: 'phase4',
    source: 'wy',
  },
  {
    id: '__lx_phase4_smoke_v1__:new-a',
    interval: '00:03',
    meta: { albumName: 'phase4-new-a' },
    name: 'phase4-new-a',
    singer: 'phase4',
    source: 'wy',
  },
]

const otherEvidence: JsonValue = {
  firstCandidates,
  identity: { originalProvider: '__lx_phase4_smoke_v1__', originalTrackId: 'other' },
  readCandidates: replacementCandidates,
  replacementCandidates,
  staleCandidatesAbsent: true,
}

const expectedEvidence: TypedSmokeEvidence = {
  raw: rawEvidence,
  url: urlEvidence,
  other: otherEvidence,
}

const smokeChecks = (evidence: TypedSmokeEvidence): [Phase4CheckV1, Phase4CheckV1, Phase4CheckV1] => [
  {
    evidenceSha256: framedSha256('lx.storage.phase4.smoke-evidence.v1/raw-lyric-write-read', evidence.raw),
    name: 'raw-lyric-write-read',
    version: 1,
  },
  {
    evidenceSha256: framedSha256('lx.storage.phase4.smoke-evidence.v1/music-url-write-read-expiry', evidence.url),
    name: 'music-url-write-read-expiry',
    version: 1,
  },
  {
    evidenceSha256: framedSha256('lx.storage.phase4.smoke-evidence.v1/other-sources-atomic-replace-read', evidence.other),
    name: 'other-sources-atomic-replace-read',
    version: 1,
  },
]

const executeTypedSmoke = (db: Database.Database): TypedSmokeEvidence => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the lazy cache-module cycle boundary.
  const { rawLyricGetSync, rawLyricPutSync } = require('../../worker/dbService/modules/lyric/raw/repository') as typeof RawLyricRepository
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the lazy cache-module cycle boundary.
  const { musicUrlGetSync, musicUrlPutSync } = require('../../worker/dbService/modules/music_url') as typeof MusicUrlRepository
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the lazy cache-module cycle boundary.
  const { otherSourcesGetSync, otherSourcesPutSync } = require('../../worker/dbService/modules/music_other_source') as typeof OtherSourcesRepository
  const rawInput = {
    provider: '__lx_phase4_smoke_v1__',
    sourceTrackId: 'raw',
    lyrics: { lyric: 'phase4-raw-lyric-v1', tlyric: 'phase4-raw-tlyric-v1' },
    nowMs: 0,
  }
  rawLyricPutSync(db, rawInput)
  const rawRead = rawLyricGetSync(db, {
    provider: rawInput.provider,
    sourceTrackId: rawInput.sourceTrackId,
    nowMs: 0,
  })

  const urlInput = {
    provider: 'wy',
    accountScope: 'profile-v1:user-id:9007199254740991',
    sourceTrackId: '__lx_phase4_smoke_v1__:url',
    quality: '128k',
    url: 'https://phase4.invalid/cache-smoke-v1',
    providerExpiresAtMs: 1,
    nowMs: 0,
  }
  musicUrlPutSync(db, urlInput)
  const urlKey = {
    provider: urlInput.provider,
    accountScope: urlInput.accountScope,
    sourceTrackId: urlInput.sourceTrackId,
    quality: urlInput.quality,
  }
  const freshUrl = musicUrlGetSync(db, { ...urlKey, nowMs: 0 })
  const expiredUrl = musicUrlGetSync(db, { ...urlKey, nowMs: 1 })

  const otherIdentity = {
    originalProvider: '__lx_phase4_smoke_v1__',
    originalTrackId: 'other',
  }
  otherSourcesPutSync(db, { ...otherIdentity, candidates: firstCandidates as LX.Music.MusicInfoOnline[], nowMs: 0 })
  otherSourcesPutSync(db, { ...otherIdentity, candidates: replacementCandidates as LX.Music.MusicInfoOnline[], nowMs: 0 })
  let readCandidates: LX.Music.MusicInfoOnline[] | null
  try {
    readCandidates = otherSourcesGetSync(db, { ...otherIdentity, nowMs: 0 })
  } catch (error) {
    if (!(error instanceof Error) || error.message != 'other_sources_cache_invalid') throw error
    readCandidates = null
  }
  const staleCandidatesAbsent = (db.prepare(`
    SELECT count(*) AS count FROM other_sources
    WHERE original_provider = ? AND original_track_id = ? AND candidate_track_id = ?
  `).get(otherIdentity.originalProvider, otherIdentity.originalTrackId, '__lx_phase4_smoke_v1__:old') as { count: number }).count == 0

  const raw: JsonValue = {
    identity: { provider: rawInput.provider, sourceTrackId: rawInput.sourceTrackId },
    read: rawRead as unknown as JsonValue,
    written: rawInput.lyrics,
  }
  const other: JsonValue = {
    firstCandidates,
    identity: otherIdentity,
    readCandidates: readCandidates as unknown as JsonValue,
    replacementCandidates,
    staleCandidatesAbsent,
  }
  return {
    raw,
    url: {
      expiredReadMiss: expiredUrl == null,
      expiryGetNowMs: 1,
      freshGetNowMs: 0,
      freshReadMatched: freshUrl == urlInput.url,
      identity: {
        accountScope: urlInput.accountScope,
        provider: urlInput.provider,
        quality: urlInput.quality,
        sourceTrackId: urlInput.sourceTrackId,
      },
      providerExpiresAtMs: 1,
      putNowMs: 0,
    },
    other,
  }
}

export const runTypedCacheSmoke = async(): Promise<CacheExecutionResult<readonly Phase4CheckV1[]>> => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache lifecycle loading boundary.
  const { runCacheRollbackOnly } = require('../../worker/dbService/cacheDb') as typeof CacheDb
  const result = await runCacheRollbackOnly(executeTypedSmoke)
  if (result.status == 'unavailable') return result
  if (canonicalJson(result.value.raw) != canonicalJson(expectedEvidence.raw) ||
    canonicalJson(result.value.url) != canonicalJson(expectedEvidence.url) ||
    canonicalJson(result.value.other) != canonicalJson(expectedEvidence.other)) {
    throw failure('phase4_cache_smoke_failed')
  }
  return { status: 'completed', value: Object.freeze(smokeChecks(result.value)) }
}

const parseReadWriteDetails = (detailsJson: string): ReadWriteDetailsV1 => {
  let parsed: unknown
  try { parsed = JSON.parse(detailsJson) } catch { throw failure('phase4_read_write_marker_invalid') }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, [
    'cacheSchemaVersion', 'checks', 'completedAtMs', 'rawMarkerSha256', 'version',
  ]) || parsed.cacheSchemaVersion != 1 || parsed.version != 1 || !isSafeTimestamp(parsed.completedAtMs) ||
    typeof parsed.rawMarkerSha256 != 'string' || !SHA256_PATTERN.test(parsed.rawMarkerSha256) ||
    !Array.isArray(parsed.checks) || parsed.checks.length != 3) {
    throw failure('phase4_read_write_marker_invalid')
  }
  const expectedChecks = smokeChecks(expectedEvidence)
  for (let index = 0; index < expectedChecks.length; index++) {
    const check = parsed.checks[index]
    const expected = expectedChecks[index]
    if (!isPlainRecord(check) || !hasExactKeys(check, ['evidenceSha256', 'name', 'version']) ||
      check.version != 1 || check.name != expected.name || check.evidenceSha256 != expected.evidenceSha256) {
      throw failure('phase4_read_write_marker_invalid')
    }
  }
  if (canonicalJson(parsed as JsonValue) != detailsJson) throw failure('phase4_read_write_marker_invalid')
  return parsed as unknown as ReadWriteDetailsV1
}

export const verifyReadWriteMarker = (
  db: Database.Database,
  rawMarker: RawLyricMarkerRow,
): StrictMarkerRow<typeof READ_WRITE_MARKER_NAME> => {
  const marker = readMarkerRow(db, READ_WRITE_MARKER_NAME)
  if (marker == null) throw failure('phase4_read_write_marker_invalid')
  const details = parseReadWriteDetails(marker.detailsJson)
  if (details.completedAtMs != marker.completedAtMs ||
    details.rawMarkerSha256 != markerRowSha256(rawMarker) ||
    marker.sourceSha256 != framedSha256('lx.storage.phase4.read-write-details.v1', details as unknown as JsonValue)) {
    throw failure('phase4_read_write_marker_invalid')
  }
  return marker
}

export const verifyExistingSchema6ReadWriteMarker = (
  db: Database.Database,
): StrictMarkerRow<typeof READ_WRITE_MARKER_NAME> | null => {
  if (readMarkerRow(db, READ_WRITE_MARKER_NAME) == null) return null
  return verifyReadWriteMarker(db, verifyRawMarker(db, 'schema6-current'))
}

export const attestSchema6TypedOwnership = async(
  db: Database.Database,
  completedAtMs: number,
): Promise<CacheExecutionResult<StrictMarkerRow<typeof READ_WRITE_MARKER_NAME>>> => {
  if (!isSafeTimestamp(completedAtMs)) throw failure('phase4_read_write_marker_invalid')
  const rawMarker = verifyRawMarker(db, 'schema6-current')
  const rawDetails = rawMarkerDetails(rawMarker)
  const existing = readMarkerRow(db, READ_WRITE_MARKER_NAME)
  const verifiedExisting = existing == null ? null : verifyReadWriteMarker(db, rawMarker)
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the cache-module cycle boundary.
  const { attestRawProvider } = require('../../worker/dbService/modules/lyric/raw/repository') as typeof RawLyricRepository
  const target = await attestRawProvider('legacy')
  if (target.status == 'unavailable') return target
  if (target.status != 'hit' || target.value.rows != rawDetails.targetRows ||
    target.value.ownerGroups != rawDetails.targetOwnerGroups || target.value.sha256 != rawDetails.targetSha256) {
    throw failure('raw_lyric_marker_conflict')
  }
  const smoke = await runTypedCacheSmoke()
  if (smoke.status == 'unavailable') return smoke

  const effectiveCompletedAtMs = verifiedExisting?.completedAtMs ?? completedAtMs
  const details: ReadWriteDetailsV1 = {
    cacheSchemaVersion: 1,
    checks: [...smoke.value] as ReadWriteDetailsV1['checks'],
    completedAtMs: effectiveCompletedAtMs,
    rawMarkerSha256: markerRowSha256(rawMarker),
    version: 1,
  }
  const marker: StrictMarkerRow<typeof READ_WRITE_MARKER_NAME> = {
    name: READ_WRITE_MARKER_NAME,
    sourceSha256: framedSha256('lx.storage.phase4.read-write-details.v1', details as unknown as JsonValue),
    completedAtMs: effectiveCompletedAtMs,
    detailsJson: canonicalJson(details as unknown as JsonValue),
  }
  if (verifiedExisting != null) {
    if (verifiedExisting.sourceSha256 != marker.sourceSha256 ||
      verifiedExisting.completedAtMs != marker.completedAtMs ||
      verifiedExisting.detailsJson != marker.detailsJson) throw failure('phase4_read_write_marker_invalid')
    return { status: 'completed', value: verifiedExisting }
  }

  db.prepare(`
    INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(marker.name, marker.sourceSha256, marker.completedAtMs, marker.detailsJson)
  const stored = verifyReadWriteMarker(db, rawMarker)
  if (stored.sourceSha256 != marker.sourceSha256 || stored.completedAtMs != marker.completedAtMs ||
    stored.detailsJson != marker.detailsJson) throw failure('phase4_read_write_marker_invalid')
  return { status: 'completed', value: stored }
}

const expectedObjects = (contract: SchemaContract, indexes: readonly string[]): Map<string, string> => new Map([
  ...contract.tables.map(table => [table.name, 'table'] as const),
  ...indexes.map(name => [name, 'index'] as const),
])

const verifyExactStructure = (
  db: Database.Database,
  contract: SchemaContract,
  indexes: readonly string[],
): void => {
  const verification = verifyDatabaseAgainstContract(db, contract, {
    runQuickCheck: false,
    runForeignKeyCheck: false,
  })
  if (!verification.ok) throw failure('phase4_schema_invalid')
  const rows = db.prepare(`
    SELECT name, type FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view') AND name NOT LIKE 'sqlite_%'
  `).all() as Array<{ name: string, type: string }>
  const actual = new Map(rows.map(row => [row.name, row.type]))
  const expected = expectedObjects(contract, indexes)
  if (actual.size != expected.size || [...expected].some(([name, type]) => actual.get(name) != type)) {
    throw failure('phase4_schema_invalid')
  }
}

const expectedMigrations = [
  migration3,
  migration4,
  migration5,
  migration6,
  { version: 7, name: CACHE_CLEANUP_MIGRATION_NAME, checksum: CACHE_CLEANUP_MIGRATION_CHECKSUM },
]

const verifyLedger = (db: Database.Database, schemaVersion: 6 | 7): void => {
  const rows = db.prepare(`
    SELECT version, name, checksum, applied_at_ms AS appliedAtMs
    FROM schema_migrations ORDER BY version
  `).all() as Array<{ version: unknown, name: unknown, checksum: unknown, appliedAtMs: unknown }>
  const expected = expectedMigrations.filter(row => row.version <= schemaVersion)
  if (rows.length != expected.length) throw failure('phase4_schema_invalid')
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const migration = expected[index]
    if (row.version != migration.version || row.name != migration.name || row.checksum != migration.checksum ||
      !isSafeTimestamp(row.appliedAtMs)) throw failure('phase4_schema_invalid')
  }
  const mirror = db.prepare('SELECT field_value AS value FROM db_info WHERE field_name = \'version\'').all() as Array<{ value: unknown }>
  if (mirror.length != 1 || mirror[0].value != String(schemaVersion)) throw failure('phase4_schema_invalid')
}

const parseCutoverDetails = (detailsJson: string): CutoverDetailsV1 => {
  let parsed: unknown
  try { parsed = JSON.parse(detailsJson) } catch { throw failure('phase4_cutover_marker_invalid') }
  if (!isPlainRecord(parsed) || !hasExactKeys(parsed, [
    'completedAtMs', 'fromSchemaVersion', 'rawLyricsDeletedRows', 'readWriteMarkerSha256',
    'removedObjects', 'toSchemaVersion', 'version',
  ]) || !isSafeTimestamp(parsed.completedAtMs) || parsed.fromSchemaVersion != 6 || parsed.toSchemaVersion != 7 ||
    parsed.version != 1 || !isSafeTimestamp(parsed.rawLyricsDeletedRows) ||
    typeof parsed.readWriteMarkerSha256 != 'string' || !SHA256_PATTERN.test(parsed.readWriteMarkerSha256) ||
    !Array.isArray(parsed.removedObjects) || parsed.removedObjects.length != SCHEMA7_REMOVED_OBJECTS.length ||
    parsed.removedObjects.some((name, index) => name != SCHEMA7_REMOVED_OBJECTS[index]) ||
    canonicalJson(parsed as JsonValue) != detailsJson) {
    throw failure('phase4_cutover_marker_invalid')
  }
  return parsed as unknown as CutoverDetailsV1
}

export const readCutoverMarker = (
  db: Database.Database,
  readWriteMarker: StrictMarkerRow<typeof READ_WRITE_MARKER_NAME>,
): { marker: StrictMarkerRow<typeof CUTOVER_MARKER_NAME>, details: CutoverDetailsV1 } => {
  const marker = readMarkerRow(db, CUTOVER_MARKER_NAME)
  if (marker == null) throw failure('phase4_cutover_marker_invalid')
  const details = parseCutoverDetails(marker.detailsJson)
  if (details.completedAtMs != marker.completedAtMs ||
    details.readWriteMarkerSha256 != markerRowSha256(readWriteMarker) ||
    marker.sourceSha256 != framedSha256('lx.storage.phase4.cutover-details.v1', details as unknown as JsonValue)) {
    throw failure('phase4_cutover_marker_invalid')
  }
  return { marker, details }
}

const assertNoRemovedObjectReferences = (db: Database.Database): void => {
  const rows = db.prepare(`
    SELECT name, type, sql FROM sqlite_master
    WHERE type IN ('table', 'index', 'trigger', 'view')
  `).all() as Array<{ name: unknown, type: unknown, sql: unknown }>
  for (const row of rows) {
    const sql = typeof row.sql == 'string' ? row.sql.toLowerCase() : ''
    if (SCHEMA7_REMOVED_OBJECTS.some(name => row.name == name || sql.includes(name))) {
      throw failure('phase4_schema_invalid')
    }
  }
}

export const verifySchema6CutoverPrerequisites = (db: Database.Database): {
  rawMarker: RawLyricMarkerRow
  readWriteMarker: StrictMarkerRow<typeof READ_WRITE_MARKER_NAME>
} => {
  verifyLedger(db, 6)
  verifyExactStructure(db, databaseSchema6Contract, explicitSchema6Indexes)
  const rawMarker = verifyRawMarker(db, 'schema6-current')
  const readWriteMarker = verifyReadWriteMarker(db, rawMarker)
  if (readMarkerRow(db, CUTOVER_MARKER_NAME) != null) throw failure('phase4_cutover_marker_invalid')
  return { rawMarker, readWriteMarker }
}

export const verifySchema6RollbackState = (db: Database.Database): boolean => {
  try {
    verifySchema6CutoverPrerequisites(db)
    return true
  } catch {
    return false
  }
}

export const verifySchema7SteadyState = (db: Database.Database): {
  rawMarker: RawLyricMarkerRow
  readWriteMarker: StrictMarkerRow<typeof READ_WRITE_MARKER_NAME>
  cutoverMarker: StrictMarkerRow<typeof CUTOVER_MARKER_NAME>
} => {
  verifyLedger(db, 7)
  verifyExactStructure(db, databaseSchema7Contract, explicitSchema7Indexes)
  if (countAuthoritativeRawRows(db) != 0) {
    throw failure('phase4_schema_invalid')
  }
  assertNoRemovedObjectReferences(db)
  const rawMarker = verifyRawMarker(db, 'schema7-historical')
  const readWriteMarker = verifyReadWriteMarker(db, rawMarker)
  const cutover = readCutoverMarker(db, readWriteMarker)
  const ledger7 = db.prepare('SELECT applied_at_ms AS appliedAtMs FROM schema_migrations WHERE version = 7').get() as { appliedAtMs: unknown } | undefined
  if (ledger7 == null || ledger7.appliedAtMs != cutover.marker.completedAtMs) {
    throw failure('phase4_cutover_marker_invalid')
  }
  return { rawMarker, readWriteMarker, cutoverMarker: cutover.marker }
}

const editedRows = (db: Database.Database): string[][] => {
  const rows = db.prepare("SELECT id, source, type, text FROM lyric WHERE source = 'edited'").all() as Array<Record<string, unknown>>
  const tuples = rows.map(row => {
    if (typeof row.id != 'string' || typeof row.source != 'string' ||
      typeof row.type != 'string' || typeof row.text != 'string') throw failure('phase4_edited_lyrics_invalid')
    return [row.id, row.source, row.type, row.text]
  })
  return tuples.sort((left, right) => {
    for (let index = 0; index < 4; index++) {
      const compared = Buffer.compare(Buffer.from(left[index], 'utf8'), Buffer.from(right[index], 'utf8'))
      if (compared != 0) return compared
    }
    return 0
  })
}

const editedSnapshot = (db: Database.Database): { count: number, sha256: string } => {
  const rows = editedRows(db)
  return {
    count: rows.length,
    sha256: framedSha256('lx.storage.phase4.edited-lyrics.v1', { rows, version: 1 }),
  }
}

export const applySchema7CacheCleanup = (
  db: Database.Database,
  appliedAtMs: number,
): void => {
  if (!isSafeTimestamp(appliedAtMs)) throw failure('phase4_cutover_marker_invalid')
  const { readWriteMarker } = verifySchema6CutoverPrerequisites(db)
  const editedBefore = editedSnapshot(db)
  const deleted = deleteAuthoritativeRawRows(db)
  if (countAuthoritativeRawRows(db) != 0) {
    throw failure('phase4_cutover_failed')
  }
  const editedAfter = editedSnapshot(db)
  if (editedAfter.count != editedBefore.count || editedAfter.sha256 != editedBefore.sha256) {
    throw failure('phase4_edited_lyrics_invalid')
  }

  db.exec(`
    DROP INDEX index_music_info_other_source;
    DROP TABLE music_info_other_source;
    DROP TABLE music_url;
  `)
  assertNoRemovedObjectReferences(db)
  verifyExactStructure(db, databaseSchema7Contract, explicitSchema7Indexes)

  const details: CutoverDetailsV1 = {
    completedAtMs: appliedAtMs,
    fromSchemaVersion: 6,
    rawLyricsDeletedRows: deleted,
    readWriteMarkerSha256: markerRowSha256(readWriteMarker),
    removedObjects: [...SCHEMA7_REMOVED_OBJECTS],
    toSchemaVersion: 7,
    version: 1,
  }
  const marker: StrictMarkerRow<typeof CUTOVER_MARKER_NAME> = {
    name: CUTOVER_MARKER_NAME,
    sourceSha256: framedSha256('lx.storage.phase4.cutover-details.v1', details as unknown as JsonValue),
    completedAtMs: appliedAtMs,
    detailsJson: canonicalJson(details as unknown as JsonValue),
  }
  db.prepare(`
    INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(marker.name, marker.sourceSha256, marker.completedAtMs, marker.detailsJson)
  const stored = readCutoverMarker(db, readWriteMarker).marker
  if (stored.sourceSha256 != marker.sourceSha256 || stored.completedAtMs != marker.completedAtMs ||
    stored.detailsJson != marker.detailsJson) throw failure('phase4_cutover_marker_invalid')
}

export const verifySchema7AfterMigration = (db: Database.Database): void => {
  verifySchema7SteadyState(db)
}

export const verifyCutoverBackup = (
  db: Database.Database,
  expectedReadWriteMarkerSha256: string,
): void => {
  if (!SHA256_PATTERN.test(expectedReadWriteMarkerSha256)) throw failure('phase4_backup_invalid')
  if (db.pragma('quick_check', { simple: true }) != 'ok' || (db.pragma('foreign_key_check') as unknown[]).length != 0) {
    throw failure('phase4_backup_invalid')
  }
  const { readWriteMarker } = verifySchema6CutoverPrerequisites(db)
  if (markerRowSha256(readWriteMarker) != expectedReadWriteMarkerSha256) throw failure('phase4_backup_invalid')
}

export const verifySchema7MarkersBeforeCache = (db: Database.Database): void => {
  verifySchema7SteadyState(db)
}
