import type { OtherSourcesGetInputV1, OtherSourcesPutInputV1 } from '../../../../../common/storage/cache'
import { parseOtherSourcesGetInput, parseOtherSourcesPutInput } from '../../../../../common/storage/cacheValidation'
import { runCacheImmediate, runCacheRead, type CacheReadResult, type CacheWriteResult } from '../../cacheDb'
import { scheduleCachePruneAfterWrite } from '../cacheLifecycle/prune'

const OTHER_SOURCE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const credentialKey = /(?:cookie|token|password|authorization|credential|secret)/i
const streamUrlKey = /^(?:url|playUrl|streamUrl|musicUrl|playbackUrl|audioUrl)$/i
const candidateKeys = new Set(['id', 'name', 'singer', 'source', 'interval', 'meta', 'rank'])
const onlineSources = new Set(['kw', 'kg', 'tx', 'wy', 'mg'])
const unsafeObjectKeys = new Set(['__proto__', 'prototype', 'constructor'])
const controlCharacters = /[\u0000-\u001f\u007f]/

const invalid = (): Error & { code: 'other_sources_input_invalid' } => {
  const error = new Error('other_sources_input_invalid') as Error & { code: 'other_sources_input_invalid' }
  error.code = 'other_sources_input_invalid'
  return error
}

const plainData = (value: unknown): Record<string, unknown> | null => {
  if (value == null || typeof value != 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>
  if (Reflect.ownKeys(descriptors).some(key => typeof key != 'string' || unsafeObjectKeys.has(key))) return null
  const result: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
    result[key] = descriptor.value
  }
  return result
}

const sanitizedJsonValue = (value: unknown, key = '', seen = new Set<object>()): unknown => {
  if (credentialKey.test(key)) throw invalid()
  if (streamUrlKey.test(key)) return undefined
  if (value == null || typeof value == 'string' || typeof value == 'boolean') return value
  if (typeof value == 'number') {
    if (!Number.isFinite(value)) throw invalid()
    return value
  }
  if (typeof value != 'object' || seen.has(value)) throw invalid()
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(Object.getOwnPropertyDescriptors(value)).length != value.length + 1) throw invalid()
      return value.map(item => sanitizedJsonValue(item, '', seen))
    }
    const data = plainData(value)
    if (data == null) throw invalid()
    const result: Record<string, unknown> = {}
    for (const [childKey, childValue] of Object.entries(data)) {
      const sanitized = sanitizedJsonValue(childValue, childKey, seen)
      if (sanitized !== undefined) result[childKey] = sanitized
    }
    return result
  } finally {
    seen.delete(value)
  }
}

interface RankedCandidate {
  rank: number
  provider: string
  trackId: string
  value: LX.Music.MusicInfoOnline
  json: string
  bytes: number
}

const validCandidateIdentity = (value: unknown, maxBytes: number): value is string =>
  typeof value == 'string' && value.length > 0 && value == value.trim() &&
  !controlCharacters.test(value) && Buffer.byteLength(value, 'utf8') <= maxBytes

const sanitizeCandidates = (values: readonly unknown[]): RankedCandidate[] => {
  const hasExplicitRank = values.some(value => {
    const data = plainData(value)
    return data != null && Object.hasOwn(data, 'rank')
  })
  const ranks = new Set<number>()
  const identities = new Set<string>()
  const result = values.map((value, index) => {
    const data = plainData(value)
    if (data == null || Object.keys(data).some(key => !candidateKeys.has(key) && !streamUrlKey.test(key)) ||
      !validCandidateIdentity(data.id, 1024) ||
      !validCandidateIdentity(data.source, 128) || !onlineSources.has(data.source) ||
      typeof data.name != 'string' || typeof data.singer != 'string' ||
      (data.interval != null && typeof data.interval != 'string') || plainData(data.meta) == null) throw invalid()
    const rank = hasExplicitRank ? data.rank : index
    if (!Number.isSafeInteger(rank) || (rank as number) < 0 || ranks.has(rank as number)) throw invalid()
    ranks.add(rank as number)
    const identity = `${Buffer.byteLength(data.source)}:${data.source}${Buffer.byteLength(data.id)}:${data.id}`
    if (identities.has(identity)) throw invalid()
    identities.add(identity)
    const withoutRank = Object.fromEntries(Object.entries(data).filter(([key]) => key != 'rank'))
    const sanitized = sanitizedJsonValue(withoutRank) as LX.Music.MusicInfoOnline
    const json = JSON.stringify(sanitized)
    return {
      rank: rank as number,
      provider: data.source,
      trackId: data.id,
      value: sanitized,
      json,
      bytes: Buffer.byteLength(json, 'utf8'),
    }
  })
  return result.sort((left, right) => left.rank - right.rank)
}

const expiryFor = (nowMs: number): number => {
  const expiry = nowMs + OTHER_SOURCE_TTL_MS
  if (!Number.isSafeInteger(expiry)) throw invalid()
  return expiry
}

export const otherSourcesGet = async(input: OtherSourcesGetInputV1): Promise<CacheReadResult<LX.Music.MusicInfoOnline[]>> => {
  const parsed = parseOtherSourcesGetInput(input)
  return runCacheRead(db => {
    const group = db.prepare(`
      SELECT byte_size AS byteSize, expires_at_ms AS expiresAtMs FROM other_source_groups
      WHERE original_provider = ? AND original_track_id = ?
    `).get(parsed.originalProvider, parsed.originalTrackId) as { byteSize: number, expiresAtMs: number } | undefined
    if (group == null) return null
    if (!Number.isSafeInteger(group.byteSize) || group.byteSize < 0 ||
      !Number.isSafeInteger(group.expiresAtMs) || group.expiresAtMs < 0) {
      throw new Error('other_sources_cache_invalid')
    }
    if (group.expiresAtMs <= parsed.nowMs) return null
    const rows = db.prepare(`
      SELECT rank, candidate_provider AS candidateProvider, candidate_track_id AS candidateTrackId,
        candidate_json AS candidateJson, byte_size AS byteSize
      FROM other_sources
      WHERE original_provider = ? AND original_track_id = ? ORDER BY rank
    `).all(parsed.originalProvider, parsed.originalTrackId) as Array<{
      rank: number
      candidateProvider: string
      candidateTrackId: string
      candidateJson: string
      byteSize: number
    }>
    if (rows.length == 0) throw new Error('other_sources_cache_invalid')
    const candidates = rows.map(row => {
      if (!Number.isSafeInteger(row.rank) || row.rank < 0 || !Number.isSafeInteger(row.byteSize) || row.byteSize < 0 ||
        typeof row.candidateJson != 'string') throw new Error('other_sources_cache_invalid')
      const stored = plainData(JSON.parse(row.candidateJson))
      if (stored == null || Object.hasOwn(stored, 'rank')) throw new Error('other_sources_cache_invalid')
      const candidate = sanitizeCandidates([{ ...stored, rank: row.rank }])[0]
      if (candidate.provider != row.candidateProvider || candidate.trackId != row.candidateTrackId ||
        candidate.json != row.candidateJson || candidate.bytes != row.byteSize) {
        throw new Error('other_sources_cache_invalid')
      }
      return candidate
    })
    if (candidates.reduce((sum, candidate) => sum + candidate.bytes, 0) != group.byteSize) {
      throw new Error('other_sources_cache_invalid')
    }
    db.prepare(`
      UPDATE other_source_groups
      SET last_accessed_at_ms = CASE WHEN last_accessed_at_ms > ? THEN last_accessed_at_ms ELSE ? END
      WHERE original_provider = ? AND original_track_id = ?
    `).run(parsed.nowMs, parsed.nowMs, parsed.originalProvider, parsed.originalTrackId)
    return candidates.map(candidate => candidate.value)
  })
}

export const otherSourcesPut = async(input: OtherSourcesPutInputV1): Promise<CacheWriteResult> => {
  const parsed = parseOtherSourcesPutInput(input)
  const candidates = sanitizeCandidates(parsed.candidates)
  const expiresAtMs = expiryFor(parsed.nowMs)
  const result = await runCacheImmediate(db => {
    db.prepare(`
      DELETE FROM other_source_groups WHERE original_provider = ? AND original_track_id = ?
    `).run(parsed.originalProvider, parsed.originalTrackId)
    if (candidates.length == 0) return
    db.prepare(`
      INSERT INTO other_source_groups(
        original_provider, original_track_id, byte_size, expires_at_ms, created_at_ms, last_accessed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      parsed.originalProvider, parsed.originalTrackId,
      candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
      expiresAtMs, parsed.nowMs, parsed.nowMs,
    )
    const insert = db.prepare(`
      INSERT INTO other_sources(
        original_provider, original_track_id, rank, candidate_provider,
        candidate_track_id, candidate_json, byte_size
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    for (const candidate of candidates) insert.run(
      parsed.originalProvider, parsed.originalTrackId, candidate.rank,
      candidate.provider, candidate.trackId, candidate.json, candidate.bytes,
    )
  })
  if (result.status == 'completed') scheduleCachePruneAfterWrite('otherSources')
  return result.status == 'completed' ? { status: 'stored' } : result
}

export const otherSourcesClear = async(): Promise<CacheWriteResult> => {
  const result = await runCacheImmediate(db => { db.prepare(`DELETE FROM other_source_groups`).run() })
  return result.status == 'completed' ? { status: 'stored' } : result
}

export const otherSourcesCount = (): Promise<CacheReadResult<number>> => runCacheRead(db =>
  (db.prepare(`SELECT count(*) AS count FROM other_source_groups`).get() as { count: number }).count,
)
