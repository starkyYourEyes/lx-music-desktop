import type {
  MusicUrlAccountInvalidationV1,
  MusicUrlGetInputV1,
  MusicUrlPutInputV1,
  MusicUrlSourceInvalidationV1,
} from '../../../../../common/storage/cache'
import {
  parseMusicUrlAccountInvalidation,
  parseMusicUrlGetInput,
  parseMusicUrlPutInput,
  parseMusicUrlSourceInvalidation,
} from '../../../../../common/storage/cacheValidation'
import { runCacheImmediate, runCacheRead, runCacheWrite, type CacheReadResult, type CacheWriteResult } from '../../cacheDb'
import { scheduleCachePruneAfterWrite } from '../cacheLifecycle/prune'

const URL_TTL_MS = 15 * 60 * 1000

const expiryFor = (input: MusicUrlPutInputV1): number => {
  if (input.providerExpiresAtMs != null) return input.providerExpiresAtMs
  const expiry = input.nowMs + URL_TTL_MS
  if (!Number.isSafeInteger(expiry)) {
    const error = new Error('music_url_input_invalid') as Error & { code: 'music_url_input_invalid' }
    error.code = 'music_url_input_invalid'
    throw error
  }
  return expiry
}

export const musicUrlGet = async(input: MusicUrlGetInputV1): Promise<CacheReadResult<string>> => {
  const parsed = parseMusicUrlGetInput(input)
  return runCacheRead(db => {
    const row = db.prepare(`
      SELECT url, expires_at_ms AS expiresAtMs FROM music_urls
      WHERE provider = ? AND account_scope = ? AND source_track_id = ? AND quality = ?
    `).get(parsed.provider, parsed.accountScope, parsed.sourceTrackId, parsed.quality) as { url: string, expiresAtMs: number } | undefined
    if (row == null) return null
    if (typeof row.url != 'string' || row.url.length == 0 ||
      !Number.isSafeInteger(row.expiresAtMs) || row.expiresAtMs < 0) {
      throw new Error('music_url_cache_invalid')
    }
    if (row.expiresAtMs <= parsed.nowMs) return null
    db.prepare(`
      UPDATE music_urls
      SET last_accessed_at_ms = CASE WHEN last_accessed_at_ms > ? THEN last_accessed_at_ms ELSE ? END
      WHERE provider = ? AND account_scope = ? AND source_track_id = ? AND quality = ?
    `).run(parsed.nowMs, parsed.nowMs, parsed.provider, parsed.accountScope, parsed.sourceTrackId, parsed.quality)
    return row.url
  })
}

export const musicUrlPut = async(input: MusicUrlPutInputV1): Promise<CacheWriteResult> => {
  const parsed = parseMusicUrlPutInput(input)
  const expiresAtMs = expiryFor(parsed)
  const result = await runCacheWrite(db => {
    db.prepare(`
      INSERT INTO music_urls(
        provider, account_scope, source_track_id, quality, url,
        expires_at_ms, created_at_ms, last_accessed_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, account_scope, source_track_id, quality) DO UPDATE SET
        url = excluded.url,
        expires_at_ms = excluded.expires_at_ms,
        created_at_ms = excluded.created_at_ms,
        last_accessed_at_ms = excluded.last_accessed_at_ms
    `).run(
      parsed.provider, parsed.accountScope, parsed.sourceTrackId, parsed.quality, parsed.url,
      expiresAtMs, parsed.nowMs, parsed.nowMs,
    )
  })
  if (result.status == 'stored') scheduleCachePruneAfterWrite('musicUrls')
  return result
}

export const musicUrlInvalidateAccount = async(input: MusicUrlAccountInvalidationV1): Promise<number> => {
  const parsed = parseMusicUrlAccountInvalidation(input)
  const result = await runCacheImmediate(db => db.prepare(`
    DELETE FROM music_urls WHERE provider = ? AND account_scope = ?
  `).run(parsed.provider, parsed.accountScope).changes)
  return result.status == 'completed' ? result.value : 0
}

export const musicUrlInvalidateSource = async(input: MusicUrlSourceInvalidationV1): Promise<number> => {
  const parsed = parseMusicUrlSourceInvalidation(input)
  const result = await runCacheImmediate(db => db.prepare(`DELETE FROM music_urls WHERE provider = ?`).run(parsed.provider).changes)
  return result.status == 'completed' ? result.value : 0
}

export const musicUrlClear = async(): Promise<CacheWriteResult> => {
  const result = await runCacheImmediate(db => { db.prepare(`DELETE FROM music_urls`).run() })
  return result.status == 'completed' ? { status: 'stored' } : result
}

export const musicUrlCount = (): Promise<CacheReadResult<number>> => runCacheRead(db =>
  (db.prepare(`SELECT count(*) AS count FROM music_urls`).get() as { count: number }).count,
)
