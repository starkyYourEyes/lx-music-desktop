import { createHash } from 'node:crypto'
import { getAppDB, getDatabaseInitialization } from '../../../db'
import { runCacheImmediate, runCacheRead, type CacheExecutionResult, type CacheReadResult, type CacheWriteResult } from '../../../cacheDb'
import { scheduleCachePruneAfterWrite } from '../../cacheLifecycle/prune'
import { selectRawCounts, selectRawProviderRows, selectRawRows } from './statements'

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

const lyricInfo = (rows: ReadonlyArray<{ lyricType: LyricKey, text: string }>): LX.Music.LyricInfo => {
  const result: LX.Music.LyricInfo = { lyric: '' }
  for (const row of rows) {
    if (row.lyricType == 'lyric') result.lyric = row.text
    else result[row.lyricType] = row.text
  }
  return result
}

const decodeLegacyText = (value: unknown): string | null => {
  if (typeof value != 'string' || value.length % 4 != 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') != value) return null
  const text = bytes.toString('utf8')
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null
}

const appRaw = (id: string): LX.Music.LyricInfo | null => {
  const rows = getAppDB().prepare(`
    SELECT type, text FROM lyric
    WHERE id = ? AND source = 'raw' AND type IN ('lyric', 'tlyric', 'rlyric', 'lxlyric')
  `).all(id) as Array<{ type: unknown, text: unknown }>
  const valid = rows.flatMap(row => {
    const text = decodeLegacyText(row.text)
    return text == null || !validKey(row.type) ? [] : [{ lyricType: row.type, text }]
  })
  return valid.length ? lyricInfo(valid) : null
}

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
export const canonicalRawLyricHash = (tuples: readonly RawLyricTuple[]): string => {
  const hash = createHash('sha256')
  const sorted = [...tuples].sort((left, right) => {
    for (const field of ['provider', 'sourceTrackId', 'lyricType'] as const) {
      const compared = Buffer.compare(Buffer.from(left[field], 'utf8'), Buffer.from(right[field], 'utf8'))
      if (compared) return compared
    }
    return 0
  })
  for (const tuple of sorted) for (const field of [tuple.provider, tuple.sourceTrackId, tuple.lyricType, tuple.text]) {
    const value = Buffer.from(field, 'utf8')
    const length = Buffer.allocUnsafe(4)
    length.writeUInt32BE(value.length)
    hash.update(length).update(value)
  }
  return hash.digest('hex')
}

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

export const rawLyricGet = async(input: { provider: string, sourceTrackId: string, nowMs: number }): Promise<CacheReadResult<LX.Music.LyricInfo>> => {
  if (!plainRecord(input) || !exactKeys(input, ['provider', 'sourceTrackId', 'nowMs']) || !validOwner(input.provider, input.sourceTrackId) || !validNow(input.nowMs)) throw invalidInput()
  const result = await runCacheRead(db => {
    const exact = selectRawRows(db, input.provider, input.sourceTrackId)
    const legacy = exact.length ? exact : input.provider == 'legacy' ? [] : selectRawRows(db, 'legacy', input.sourceTrackId)
    if (!legacy.length) return null
    const provider = exact.length ? input.provider : 'legacy'
    db.prepare(`UPDATE raw_lyric_groups SET last_accessed_at_ms = CASE WHEN last_accessed_at_ms > ? THEN last_accessed_at_ms ELSE ? END WHERE provider = ? AND source_track_id = ?`).run(input.nowMs, input.nowMs, provider, input.sourceTrackId)
    return lyricInfo(legacy)
  })
  if (result.status == 'hit' || getDatabaseInitialization().schemaVersion != 6) return result
  const fallback = appRaw(input.sourceTrackId)
  return fallback == null ? result.status == 'unavailable' ? { status: 'miss' } : result : { status: 'hit', value: fallback }
}

export const rawLyricPut = async(input: { provider: string, sourceTrackId: string, lyrics: LX.Music.LyricInfo, nowMs: number }): Promise<CacheWriteResult> => {
  if (!plainRecord(input) || !exactKeys(input, ['provider', 'sourceTrackId', 'lyrics', 'nowMs']) || !validOwner(input.provider, input.sourceTrackId) || !validNow(input.nowMs) || !validLyrics(input.lyrics)) throw invalidInput()
  const tuples = keys.filter(key => input.lyrics[key] != null).map(lyricType => ({ provider: input.provider, sourceTrackId: input.sourceTrackId, lyricType, text: input.lyrics[lyricType]! }))
  const result = await runCacheImmediate(db => {
    const groups = new Map([[input.sourceTrackId, tuples]])
    db.prepare(`DELETE FROM raw_lyric_groups WHERE provider = ? AND source_track_id = ?`).run(input.provider, input.sourceTrackId)
    if (tuples.length) {
      const group = db.prepare(`INSERT INTO raw_lyric_groups(provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms) VALUES (?, ?, ?, ?, ?)`)
      group.run(input.provider, input.sourceTrackId, tuples.reduce((sum, row) => sum + bytes(row.text), 0), input.nowMs, input.nowMs)
      const insert = db.prepare(`INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size) VALUES (?, ?, ?, ?, ?)`)
      for (const row of tuples) insert.run(row.provider, row.sourceTrackId, row.lyricType, row.text, bytes(row.text))
    }
    return groups
  })
  if (result.status == 'completed') scheduleCachePruneAfterWrite('rawLyrics')
  return result.status == 'completed' ? { status: 'stored' } : result
}

export const rawLyricCount = (): Promise<CacheReadResult<{ rows: number, ownerGroups: number, bytes: number }>> => runCacheRead(db => selectRawCounts(db))
export const rawLyricClear = async(): Promise<CacheWriteResult> => {
  const result = await runCacheImmediate(db => { db.prepare(`DELETE FROM raw_lyric_groups`).run() })
  return result.status == 'completed' ? { status: 'stored' } : result
}
