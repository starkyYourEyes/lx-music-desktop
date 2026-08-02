import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import { getAppDB } from '../../worker/dbService/db'
import { getMigrationMarker, putMigrationMarker } from '../../worker/dbService/migrate'
import { canonicalRawLyricHash, replaceRawProvider, type RawLyricTuple } from '../../worker/dbService/modules/lyric/raw/repository'

const markerName = 'legacy_cache_v1.raw_lyrics'
const tupleEncoding = 'u32be-length-prefixed-utf8-v1'
const keys = new Set(['lyric', 'tlyric', 'rlyric', 'lxlyric'])

export type RawLyricMigrationResult =
  | { status: 'complete' | 'already-complete', sourceRows: number, sourceOwnerGroups: number, skippedInvalidRows: number, sourceSha256: string, targetRows: number, targetOwnerGroups: number, targetSha256: string }
  | { status: 'unavailable', code: LX.DBService.CacheDiagnosticCode }

interface Details {
  version: 1
  provider: 'legacy'
  tupleEncoding: typeof tupleEncoding
  sourceRows: number
  sourceOwnerGroups: number
  skippedInvalidRows: number
  sourceSha256: string
  targetRows: number
  targetOwnerGroups: number
  targetSha256: string
}

const failure = (code: string): Error & { code: string } => Object.assign(new Error(code), { code })
const safeNow = (value: unknown): value is number => typeof value == 'number' && Number.isSafeInteger(value) && value >= 0
const validId = (value: unknown): value is string => typeof value == 'string' && value.length > 0 && value.length <= 1024
const decode = (value: unknown): string | null => {
  if (typeof value != 'string' || value.length % 4 != 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') != value) return null
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

const source = (): { tuples: RawLyricTuple[], skippedInvalidRows: number } => {
  const rows = getAppDB().prepare(`SELECT id, type, text FROM lyric WHERE source = 'raw' AND type IN ('lyric', 'tlyric', 'rlyric', 'lxlyric')`).all() as Array<{ id: unknown, type: unknown, text: unknown }>
  const tuples: RawLyricTuple[] = []
  let skippedInvalidRows = 0
  for (const row of rows) {
    const text = decode(row.text)
    if (!validId(row.id) || typeof row.type != 'string' || !keys.has(row.type) || text == null) { skippedInvalidRows++; continue }
    tuples.push({ provider: 'legacy', sourceTrackId: row.id, lyricType: row.type as RawLyricTuple['lyricType'], text })
  }
  return { tuples, skippedInvalidRows }
}

const details = (sourceRows: number, sourceOwnerGroups: number, skippedInvalidRows: number, sourceSha256: string, targetRows: number, targetOwnerGroups: number, targetSha256: string): Details => ({
  version: 1, provider: 'legacy', tupleEncoding, sourceRows, sourceOwnerGroups, skippedInvalidRows,
  sourceSha256, targetRows, targetOwnerGroups, targetSha256,
})

const parseDetails = (value: string): Details => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw failure('raw_lyric_marker_invalid') }
  if (parsed == null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) != Object.prototype) throw failure('raw_lyric_marker_invalid')
  const row = parsed as Record<string, unknown>
  const expected = ['provider', 'skippedInvalidRows', 'sourceOwnerGroups', 'sourceRows', 'sourceSha256', 'targetOwnerGroups', 'targetRows', 'targetSha256', 'tupleEncoding', 'version']
  const counts = [row.sourceRows, row.sourceOwnerGroups, row.skippedInvalidRows, row.targetRows, row.targetOwnerGroups]
  if (Object.keys(row).sort().join(',') != expected.join(',') || row.version != 1 || row.provider != 'legacy' || row.tupleEncoding != tupleEncoding ||
    !counts.every(value => typeof value == 'number' && Number.isSafeInteger(value) && value >= 0) ||
    ![row.sourceSha256, row.targetSha256].every(value => typeof value == 'string' && /^[a-f0-9]{64}$/.test(value)) || row.sourceSha256 != row.targetSha256) throw failure('raw_lyric_marker_invalid')
  return row as unknown as Details
}

export const migrateRawLyrics = async(input: { nowMs: number }): Promise<RawLyricMigrationResult> => {
  if (input == null || Object.keys(input).length != 1 || !safeNow(input.nowMs)) throw failure('raw_lyric_migration_invalid')
  const inventory = source()
  const sourceGroups = new Set(inventory.tuples.map(row => row.sourceTrackId)).size
  const sourceSha256 = canonicalRawLyricHash(inventory.tuples)
  let existing
  try { existing = getMigrationMarker(getAppDB(), markerName) } catch { throw failure('raw_lyric_marker_invalid') }
  if (existing != null) {
    const current = parseDetails(existing.detailsJson)
    if (existing.sourceSha256 != sourceSha256 || current.sourceSha256 != sourceSha256 || current.sourceRows != inventory.tuples.length || current.sourceOwnerGroups != sourceGroups || current.skippedInvalidRows != inventory.skippedInvalidRows) throw failure('raw_lyric_marker_conflict')
  }
  const copied = await replaceRawProvider('legacy', inventory.tuples, input.nowMs)
  if (copied.status == 'unavailable') return copied
  if (copied.value.rows != inventory.tuples.length || copied.value.ownerGroups != sourceGroups || copied.value.sha256 != sourceSha256) throw failure('raw_lyric_attestation_failed')
  const value = details(inventory.tuples.length, sourceGroups, inventory.skippedInvalidRows, sourceSha256, copied.value.rows, copied.value.ownerGroups, copied.value.sha256)
  if (existing != null) {
    const exact = parseDetails(existing.detailsJson)
    if (canonicalJson(exact as unknown as JsonValue) != canonicalJson(value as unknown as JsonValue)) throw failure('raw_lyric_marker_conflict')
    return { status: 'already-complete', ...value }
  }
  const marker = { name: markerName, sourceSha256, completedAtMs: input.nowMs, detailsJson: canonicalJson(value as unknown as JsonValue) }
  putMigrationMarker(getAppDB(), marker)
  let stored
  try { stored = getMigrationMarker(getAppDB(), markerName) } catch { throw failure('raw_lyric_marker_invalid') }
  if (stored == null || stored.name != marker.name || stored.sourceSha256 != marker.sourceSha256 ||
    stored.completedAtMs != marker.completedAtMs || stored.detailsJson != marker.detailsJson) {
    throw failure('raw_lyric_marker_invalid')
  }
  return { status: 'complete', ...value }
}
