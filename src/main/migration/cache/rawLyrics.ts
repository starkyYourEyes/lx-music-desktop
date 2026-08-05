import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import { getAppDB } from '../../worker/dbService/db'
import { putMigrationMarker } from '../../worker/dbService/migrate'
import type * as RawLyricRepository from '../../worker/dbService/modules/lyric/raw/repository'

type RawLyricTuple = RawLyricRepository.RawLyricTuple

const markerName = 'legacy_cache_v1.raw_lyrics'
const tupleEncoding = 'u32be-length-prefixed-utf8-v1'
const keys = new Set(['lyric', 'tlyric', 'rlyric', 'lxlyric'])

export const canonicalRawLyricHash = (tuples: readonly RawLyricTuple[]): string => {
  const hash = createHash('sha256')
  const sorted = [...tuples].sort((left, right) => {
    for (const field of ['provider', 'sourceTrackId', 'lyricType'] as const) {
      const compared = Buffer.compare(Buffer.from(left[field], 'utf8'), Buffer.from(right[field], 'utf8'))
      if (compared) return compared
    }
    return 0
  })
  for (const tuple of sorted) {
    for (const field of [tuple.provider, tuple.sourceTrackId, tuple.lyricType, tuple.text]) {
      const value = Buffer.from(field, 'utf8')
      const length = Buffer.allocUnsafe(4)
      length.writeUInt32BE(value.length)
      hash.update(length).update(value)
    }
  }
  return hash.digest('hex')
}

export type RawLyricMigrationResult =
  | { status: 'complete' | 'already-complete', sourceRows: number, sourceOwnerGroups: number, skippedInvalidRows: number, sourceSha256: string, targetRows: number, targetOwnerGroups: number, targetSha256: string }
  | { status: 'unavailable', code: LX.DBService.CacheDiagnosticCode }

export interface RawLyricMarkerDetails {
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

export interface RawLyricMarkerRow {
  name: typeof markerName
  sourceSha256: string
  completedAtMs: number
  detailsJson: string
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

export const readAuthoritativeRawLyric = (sourceTrackId: string): LX.Music.LyricInfo | null => {
  if (!validId(sourceTrackId)) throw failure('raw_lyric_input_invalid')
  const rows = getAppDB().prepare(`
    SELECT type, text FROM lyric
    WHERE id = ? AND source = 'raw' AND type IN ('lyric', 'tlyric', 'rlyric', 'lxlyric')
  `).all(sourceTrackId) as Array<{ type: unknown, text: unknown }>
  const result: LX.Music.LyricInfo = { lyric: '' }
  let found = false
  for (const row of rows) {
    const text = decode(row.text)
    if (text == null || typeof row.type != 'string' || !keys.has(row.type)) continue
    found = true
    if (row.type == 'lyric') result.lyric = text
    else result[row.type as Exclude<RawLyricTuple['lyricType'], 'lyric'>] = text
  }
  return found ? result : null
}

export const readAuthoritativeRawInventory = (
  db = getAppDB(),
): { tuples: RawLyricTuple[], skippedInvalidRows: number } => {
  const rows = db.prepare('SELECT id, type, text FROM lyric WHERE source = \'raw\'').all() as Array<{ id: unknown, type: unknown, text: unknown }>
  const tuples: RawLyricTuple[] = []
  const seen = new Map<string, Map<string, string>>()
  let skippedInvalidRows = 0
  for (const row of rows) {
    const text = decode(row.text)
    if (!validId(row.id) || typeof row.type != 'string' || !keys.has(row.type) || text == null) { skippedInvalidRows++; continue }
    const types = seen.get(row.id) ?? new Map<string, string>()
    const previous = types.get(row.type)
    if (previous != null) {
      if (previous != text) throw failure('raw_lyric_attestation_failed')
      skippedInvalidRows++
      continue
    }
    types.set(row.type, text)
    seen.set(row.id, types)
    tuples.push({ provider: 'legacy', sourceTrackId: row.id, lyricType: row.type as RawLyricTuple['lyricType'], text })
  }
  return { tuples, skippedInvalidRows }
}

export const countAuthoritativeRawRows = (db = getAppDB()): number => {
  const count = (db.prepare("SELECT count(*) AS count FROM lyric WHERE source = 'raw'").get() as { count: unknown }).count
  if (!safeNow(count)) throw failure('raw_lyric_attestation_failed')
  return count
}

export const deleteAuthoritativeRawRows = (db = getAppDB()): number => {
  const deleted = db.prepare("DELETE FROM lyric WHERE source = 'raw'").run().changes
  if (!safeNow(deleted)) throw failure('raw_lyric_attestation_failed')
  return deleted
}

const details = (sourceRows: number, sourceOwnerGroups: number, skippedInvalidRows: number, sourceSha256: string, targetRows: number, targetOwnerGroups: number, targetSha256: string): RawLyricMarkerDetails => ({
  version: 1,
  provider: 'legacy',
  tupleEncoding,
  sourceRows,
  sourceOwnerGroups,
  skippedInvalidRows,
  sourceSha256,
  targetRows,
  targetOwnerGroups,
  targetSha256,
})

const completed = (status: 'complete' | 'already-complete', value: RawLyricMarkerDetails): RawLyricMigrationResult => ({
  status,
  sourceRows: value.sourceRows,
  sourceOwnerGroups: value.sourceOwnerGroups,
  skippedInvalidRows: value.skippedInvalidRows,
  sourceSha256: value.sourceSha256,
  targetRows: value.targetRows,
  targetOwnerGroups: value.targetOwnerGroups,
  targetSha256: value.targetSha256,
})

export const parseRawLyricMarkerDetails = (value: string): RawLyricMarkerDetails => {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw failure('raw_lyric_marker_invalid') }
  if (parsed == null || Array.isArray(parsed) || Object.getPrototypeOf(parsed) != Object.prototype) throw failure('raw_lyric_marker_invalid')
  const row = parsed as Record<string, unknown>
  const expected = ['provider', 'skippedInvalidRows', 'sourceOwnerGroups', 'sourceRows', 'sourceSha256', 'targetOwnerGroups', 'targetRows', 'targetSha256', 'tupleEncoding', 'version']
  const counts = [row.sourceRows, row.sourceOwnerGroups, row.skippedInvalidRows, row.targetRows, row.targetOwnerGroups]
  if (Object.keys(row).sort().join(',') != expected.join(',') || row.version != 1 || row.provider != 'legacy' || row.tupleEncoding != tupleEncoding ||
    !counts.every(value => typeof value == 'number' && Number.isSafeInteger(value) && value >= 0) ||
    ![row.sourceSha256, row.targetSha256].every(value => typeof value == 'string' && /^[a-f0-9]{64}$/.test(value)) ||
    row.sourceRows != row.targetRows || row.sourceOwnerGroups != row.targetOwnerGroups ||
    row.sourceSha256 != row.targetSha256) throw failure('raw_lyric_marker_invalid')
  return row as unknown as RawLyricMarkerDetails
}

export const readRawLyricMarker = (db = getAppDB()): RawLyricMarkerRow | null => {
  const stored = db.prepare(`
    SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs,
      details_json AS detailsJson
    FROM migration_markers WHERE name = ?
  `).get(markerName) as Record<string, unknown> | undefined
  if (stored == null) return null
  if (stored.name != markerName || typeof stored.sourceSha256 != 'string' || !/^[a-f0-9]{64}$/.test(stored.sourceSha256) ||
    typeof stored.completedAtMs != 'number' || !Number.isSafeInteger(stored.completedAtMs) || stored.completedAtMs < 0 ||
    typeof stored.detailsJson != 'string') throw failure('raw_lyric_marker_invalid')
  const parsed = parseRawLyricMarkerDetails(stored.detailsJson)
  if (stored.detailsJson != canonicalJson(parsed as unknown as JsonValue)) throw failure('raw_lyric_marker_invalid')
  if (stored.sourceSha256 != parsed.sourceSha256) throw failure('raw_lyric_marker_invalid')
  return stored as unknown as RawLyricMarkerRow
}

export const migrateRawLyrics = async(input: { nowMs: number }): Promise<RawLyricMigrationResult> => {
  if (input == null || Object.keys(input).length != 1 || !safeNow(input.nowMs)) throw failure('raw_lyric_migration_invalid')
  const inventory = readAuthoritativeRawInventory()
  const sourceGroups = new Set(inventory.tuples.map(row => row.sourceTrackId)).size
  const sourceSha256 = canonicalRawLyricHash(inventory.tuples)
  // eslint-disable-next-line @typescript-eslint/no-var-requires -- Preserve the schema-transition cache-module cycle boundary.
  const { attestRawProvider, replaceRawProvider } = require('../../worker/dbService/modules/lyric/raw/repository') as typeof RawLyricRepository
  const existing = readRawLyricMarker()
  if (existing != null) {
    const current = parseRawLyricMarkerDetails(existing.detailsJson)
    if (existing.sourceSha256 != sourceSha256 || current.sourceSha256 != sourceSha256 || current.sourceRows != inventory.tuples.length || current.sourceOwnerGroups != sourceGroups || current.skippedInvalidRows != inventory.skippedInvalidRows) throw failure('raw_lyric_marker_conflict')
    const expected = details(inventory.tuples.length, sourceGroups, inventory.skippedInvalidRows, sourceSha256, inventory.tuples.length, sourceGroups, sourceSha256)
    if (canonicalJson(current as unknown as JsonValue) != canonicalJson(expected as unknown as JsonValue)) throw failure('raw_lyric_marker_conflict')
    const target = await attestRawProvider('legacy')
    if (target.status == 'unavailable') return target
    if (target.status == 'hit' && target.value.rows == inventory.tuples.length && target.value.ownerGroups == sourceGroups && target.value.sha256 == sourceSha256) {
      return completed('already-complete', expected)
    }
  }
  const copied = await replaceRawProvider('legacy', inventory.tuples, input.nowMs)
  if (copied.status == 'unavailable') return copied
  if (copied.value.rows != inventory.tuples.length || copied.value.ownerGroups != sourceGroups || copied.value.sha256 != sourceSha256) throw failure('raw_lyric_attestation_failed')
  const value = details(inventory.tuples.length, sourceGroups, inventory.skippedInvalidRows, sourceSha256, copied.value.rows, copied.value.ownerGroups, copied.value.sha256)
  if (existing != null) {
    return completed('already-complete', value)
  }
  const marker = { name: markerName, sourceSha256, completedAtMs: input.nowMs, detailsJson: canonicalJson(value as unknown as JsonValue) }
  putMigrationMarker(getAppDB(), marker)
  const stored = readRawLyricMarker()
  if (stored == null || stored.name != marker.name || stored.sourceSha256 != marker.sourceSha256 ||
    stored.completedAtMs != marker.completedAtMs || stored.detailsJson != marker.detailsJson) {
    throw failure('raw_lyric_marker_invalid')
  }
  return completed('complete', value)
}
