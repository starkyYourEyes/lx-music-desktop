import { runCacheImmediate, runCacheRead, type CacheExecutionResult, type CacheReadResult, type CacheWriteResult } from '../../../cacheDb'
import { scheduleCachePruneAfterWrite } from '../../cacheLifecycle/prune'
import { selectRawCounts, selectRawProviderRows, selectRawRows } from './statements'
import { canonicalRawLyricHash } from '../../../../../migration/cache/rawLyrics'

export { canonicalRawLyricHash }

const keys = ['lyric', 'tlyric', 'rlyric', 'lxlyric'] as const
type LyricKey = typeof keys[number]
export interface RawLyricTuple { provider: string, sourceTrackId: string, lyricType: LyricKey, text: string }

const validKey = (value: unknown): value is LyricKey => typeof value == 'string' && (keys as readonly string[]).includes(value)
const validOwner = (provider: unknown, sourceTrackId: unknown): provider is string =>
  typeof provider == 'string' && provider.length > 0 && provider.length <= 1024 &&
  typeof sourceTrackId == 'string' && sourceTrackId.length > 0 && sourceTrackId.length <= 1024
const validNow = (value: unknown): value is number => typeof value == 'number' && Number.isSafeInteger(value) && value >= 0
const plainRecord = (value: unknown): value is Record<string, unknown> => value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype
const exactKeys = (value: Record<string, unknown>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort()
  return actual.length == expected.length && actual.every((key, index) => key == [...expected].sort()[index])
}
const validLyrics = (value: unknown): value is LX.Music.LyricInfo => {
  if (!plainRecord(value) || typeof value.lyric != 'string' || Object.keys(value).some(key => !(keys as readonly string[]).includes(key))) return false
  return keys.slice(1).every(key => value[key] == null || typeof value[key] == 'string')
}
const invalidInput = (): Error & { code: 'raw_lyric_input_invalid' } => Object.assign(new Error('raw_lyric_input_invalid'), { code: 'raw_lyric_input_invalid' as const })

export type RawLyricFallbackState = 'schema6-fallback' | 'cutover-pending-cache-only' | 'schema7-cache-only'
let fallbackState: RawLyricFallbackState = 'schema6-fallback'

export const enterRawLyricCutoverPending = (): void => {
  if (fallbackState == 'schema6-fallback') fallbackState = 'cutover-pending-cache-only'
}

export const restoreRawLyricSchema6Fallback = (): void => {
  if (fallbackState == 'cutover-pending-cache-only') fallbackState = 'schema6-fallback'
}

export const enterRawLyricSchema7CacheOnly = (): void => {
  fallbackState = 'schema7-cache-only'
}

export const getRawLyricFallbackState = (): RawLyricFallbackState => fallbackState

const lyricInfo = (rows: ReadonlyArray<{ lyricType: LyricKey, text: string }>): LX.Music.LyricInfo => {
  const result: LX.Music.LyricInfo = { lyric: '' }
  for (const row of rows) {
    if (row.lyricType == 'lyric') result.lyric = row.text
    else result[row.lyricType] = row.text
  }
  return result
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')

const replaceOwners = (db: Parameters<typeof selectRawRows>[0], provider: string, groups: Map<string, RawLyricTuple[]>, nowMs: number): void => {
  db.prepare(`DELETE FROM raw_lyric_groups WHERE provider = ?`).run(provider)
  const groupInsert = db.prepare(`INSERT INTO raw_lyric_groups(provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms) VALUES (?, ?, ?, ?, ?)`)
  const lyricInsert = db.prepare(`INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size) VALUES (?, ?, ?, ?, ?)`)
  for (const [id, rows] of groups) {
    const total = rows.reduce((sum, row) => sum + bytes(row.text), 0)
    groupInsert.run(provider, id, total, nowMs, nowMs)
    for (const row of rows) lyricInsert.run(provider, id, row.lyricType, row.text, bytes(row.text))
  }
}

export const replaceRawProvider = async(provider: string, tuples: readonly RawLyricTuple[], nowMs: number): Promise<CacheExecutionResult<{ rows: number, ownerGroups: number, sha256: string }>> => {
  if (!validOwner(provider, provider) || !validNow(nowMs) || tuples.some(row => !validOwner(row.provider, row.sourceTrackId) || row.provider != provider || !validKey(row.lyricType) || typeof row.text != 'string')) throw new Error('raw_lyric_input_invalid')
  const groups = new Map<string, RawLyricTuple[]>()
  for (const tuple of tuples) groups.set(tuple.sourceTrackId, [...(groups.get(tuple.sourceTrackId) ?? []), tuple])
  const result = await runCacheImmediate(db => {
    replaceOwners(db, provider, groups, nowMs)
    const counts = selectRawCounts(db, provider)
    const rows = [...groups.values()].flat()
    const target = [...groups.entries()].flatMap(([sourceTrackId, values]) => selectRawRows(db, provider, sourceTrackId).map(value => ({ provider, sourceTrackId, ...value })))
    const sha256 = canonicalRawLyricHash(target)
    if (counts.rows != rows.length || counts.ownerGroups != groups.size || sha256 != canonicalRawLyricHash(rows)) throw new Error('raw_lyric_attestation_failed')
    return { rows: counts.rows, ownerGroups: counts.ownerGroups, sha256 }
  })
  if (result.status == 'completed') scheduleCachePruneAfterWrite('rawLyrics')
  return result
}

export const attestRawProvider = (provider: string): Promise<CacheReadResult<{ rows: number, ownerGroups: number, sha256: string }>> => {
  if (!validOwner(provider, provider)) throw new Error('raw_lyric_input_invalid')
  return runCacheRead(db => {
    const counts = selectRawCounts(db, provider)
    const tuples = selectRawProviderRows(db, provider).map(row => ({ provider, ...row }))
    return { rows: counts.rows, ownerGroups: counts.ownerGroups, sha256: canonicalRawLyricHash(tuples) }
  })
}

type RawLyricGetInput = { provider: string, sourceTrackId: string, nowMs: number }
type RawLyricPutInput = { provider: string, sourceTrackId: string, lyrics: LX.Music.LyricInfo, nowMs: number }

export const rawLyricGetSync = (
  db: Parameters<typeof selectRawRows>[0],
  input: RawLyricGetInput,
): LX.Music.LyricInfo | null => {
  if (!plainRecord(input) || !exactKeys(input, ['provider', 'sourceTrackId', 'nowMs']) || !validOwner(input.provider, input.sourceTrackId) || !validNow(input.nowMs)) throw invalidInput()
  const exact = selectRawRows(db, input.provider, input.sourceTrackId)
  const legacy = exact.length ? exact : input.provider == 'legacy' ? [] : selectRawRows(db, 'legacy', input.sourceTrackId)
  if (!legacy.length) return null
  const provider = exact.length ? input.provider : 'legacy'
  db.prepare(`UPDATE raw_lyric_groups SET last_accessed_at_ms = CASE WHEN last_accessed_at_ms > ? THEN last_accessed_at_ms ELSE ? END WHERE provider = ? AND source_track_id = ?`).run(input.nowMs, input.nowMs, provider, input.sourceTrackId)
  return lyricInfo(legacy)
}

export const rawLyricGet = async(input: RawLyricGetInput): Promise<CacheReadResult<LX.Music.LyricInfo>> => {
  if (!plainRecord(input) || !exactKeys(input, ['provider', 'sourceTrackId', 'nowMs']) || !validOwner(input.provider, input.sourceTrackId) || !validNow(input.nowMs)) throw invalidInput()
  const result = await runCacheRead(db => rawLyricGetSync(db, input))
  if (result.status == 'hit' || fallbackState != 'schema6-fallback') {
    return fallbackState == 'schema6-fallback' || result.status != 'unavailable' ? result : { status: 'miss' }
  }
  // Loaded only on the schema-6 transition path; the migration module is the sole owner of authoritative raw SQL.
  const { readAuthoritativeRawLyric } = require('../../../../../migration/cache/rawLyrics') as typeof import('../../../../../migration/cache/rawLyrics')
  const fallback = readAuthoritativeRawLyric(input.sourceTrackId)
  return fallback == null ? result.status == 'unavailable' ? { status: 'miss' } : result : { status: 'hit', value: fallback }
}

export const rawLyricPutSync = (
  db: Parameters<typeof selectRawRows>[0],
  input: RawLyricPutInput,
): void => {
  if (!plainRecord(input) || !exactKeys(input, ['provider', 'sourceTrackId', 'lyrics', 'nowMs']) || !validOwner(input.provider, input.sourceTrackId) || !validNow(input.nowMs) || !validLyrics(input.lyrics)) throw invalidInput()
  const tuples = keys.filter(key => input.lyrics[key] != null).map(lyricType => ({ provider: input.provider, sourceTrackId: input.sourceTrackId, lyricType, text: input.lyrics[lyricType]! }))
  db.prepare(`DELETE FROM raw_lyric_groups WHERE provider = ? AND source_track_id = ?`).run(input.provider, input.sourceTrackId)
  if (tuples.length) {
    const group = db.prepare(`INSERT INTO raw_lyric_groups(provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms) VALUES (?, ?, ?, ?, ?)`)
    group.run(input.provider, input.sourceTrackId, tuples.reduce((sum, row) => sum + bytes(row.text), 0), input.nowMs, input.nowMs)
    const insert = db.prepare(`INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size) VALUES (?, ?, ?, ?, ?)`)
    for (const row of tuples) insert.run(row.provider, row.sourceTrackId, row.lyricType, row.text, bytes(row.text))
  }
}

export const rawLyricPut = async(input: RawLyricPutInput): Promise<CacheWriteResult> => {
  if (!plainRecord(input) || !exactKeys(input, ['provider', 'sourceTrackId', 'lyrics', 'nowMs']) || !validOwner(input.provider, input.sourceTrackId) || !validNow(input.nowMs) || !validLyrics(input.lyrics)) throw invalidInput()
  const result = await runCacheImmediate(db => rawLyricPutSync(db, input))
  if (result.status == 'completed') scheduleCachePruneAfterWrite('rawLyrics')
  return result.status == 'completed' ? { status: 'stored' } : result
}

export const rawLyricCount = (): Promise<CacheReadResult<{ rows: number, ownerGroups: number, bytes: number }>> => runCacheRead(db => selectRawCounts(db))
export const rawLyricClear = async(): Promise<CacheWriteResult> => {
  const result = await runCacheImmediate(db => { db.prepare(`DELETE FROM raw_lyric_groups`).run() })
  return result.status == 'completed' ? { status: 'stored' } : result
}
