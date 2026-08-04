import type { AuthorizedMusicUrlKeyV1 } from '@common/storage/cache'
import { getMusicUrl, removeMusicUrl, saveMusicUrl } from '@renderer/utils/ipc'

export interface PlaybackCacheHit {
  key: AuthorizedMusicUrlKeyV1
  quality: LX.Quality
  url: string
  provisional: boolean
}

export type PlaybackCachePersistenceOperation = 'commit' | 'delete'

export interface PlaybackCachePersistenceFailure {
  operation: PlaybackCachePersistenceOperation
  errorName: string
  errorCode?: string
}

const SAFE_PERSISTENCE_ERROR_NAMES = new Set([
  'Error', 'TypeError', 'AbortError', 'DOMException',
])
const SAFE_PERSISTENCE_ERROR_CODES = new Set([
  'SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_READONLY', 'SQLITE_IOERR',
  'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_CORRUPT', 'SQLITE_NOTADB',
  'SQLITE_CONSTRAINT', 'ERR_IPC_CHANNEL_CLOSED',
  'cache_phase3_prerequisite_invalid', 'cache_target_invalid', 'cache_open_failed',
  'cache_schema_invalid', 'cache_integrity_failed', 'cache_operation_failed',
  'cache_close_failed', 'cache_delete_failed', 'cache_reopen_failed',
  'cache_capacity_unavailable',
])

export const toPlaybackCachePersistenceFailure = (
  operation: PlaybackCachePersistenceOperation,
  reason: unknown,
): PlaybackCachePersistenceFailure => {
  const record = typeof reason == 'object' && reason != null
    ? reason as { name?: unknown, code?: unknown }
    : {}
  const errorName = typeof record.name == 'string' && SAFE_PERSISTENCE_ERROR_NAMES.has(record.name)
    ? record.name
    : 'UnknownError'
  const errorCode = typeof record.code == 'string' && SAFE_PERSISTENCE_ERROR_CODES.has(record.code)
    ? record.code
    : undefined
  return { operation, errorName, ...(errorCode ? { errorCode } : {}) }
}

export type ReportPlaybackCachePersistenceFailure = (
  value: PlaybackCachePersistenceFailure,
) => void

export const observePlaybackCachePersistence = async(
  promise: Promise<void>,
  operation: PlaybackCachePersistenceOperation,
  report: ReportPlaybackCachePersistenceFailure,
): Promise<void> => {
  await promise.then(
    () => {},
    reason => {
      try {
        report(toPlaybackCachePersistenceFailure(operation, reason))
      } catch {}
    },
  )
}

export interface PlaybackUrlCache {
  adoptCacheGeneration: (generation: number) => void
  lookup: (key: AuthorizedMusicUrlKeyV1) => Promise<PlaybackCacheHit | null>
  tombstoneKey: (key: AuthorizedMusicUrlKeyV1) => Promise<void>
  commit: (key: AuthorizedMusicUrlKeyV1, url: string) => Promise<void>
  invalidateQualityRange: (key: AuthorizedMusicUrlKeyV1) => Promise<void>
  getPlaybackQualityOrder: (requested: LX.Quality) => LX.Quality[]
}

interface PlaybackUrlCacheDependencies {
  read: (key: AuthorizedMusicUrlKeyV1) => Promise<string | null | undefined>
  save: (key: AuthorizedMusicUrlKeyV1, url: string) => Promise<void>
  remove: (key: AuthorizedMusicUrlKeyV1) => Promise<void>
  memory?: Map<string, string>
}

const ORDERED_PLAYBACK_QUALITIES: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

export const getPlaybackQualityOrder = (requested: LX.Quality): LX.Quality[] => {
  const index = ORDERED_PLAYBACK_QUALITIES.indexOf(requested)
  if (index >= 0) return ORDERED_PLAYBACK_QUALITIES.slice(index)
  return requested == '128k' ? ['128k'] : [requested, '128k']
}

const getKeyId = (key: AuthorizedMusicUrlKeyV1) => JSON.stringify([
  key.authorization.version,
  key.authorization.provider,
  key.authorization.accountScope,
  key.authorization.generation,
  key.sourceTrackId,
  key.quality,
])

const withQuality = (key: AuthorizedMusicUrlKeyV1, quality: LX.Quality): AuthorizedMusicUrlKeyV1 => ({
  ...key,
  quality,
})

export const createPlaybackUrlCache = (deps: PlaybackUrlCacheDependencies): PlaybackUrlCache => {
  const validatedMemory = deps.memory ?? new Map<string, string>()
  const tombstones = new Set<string>()
  const revisions = new Map<string, number>()
  const persistenceTails = new Map<string, Promise<void>>()
  let cacheGeneration = 0

  const incrementRevision = (key: string) => {
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }
  const enqueueKeyOperation = async<T>(key: string, operation: () => Promise<T>): Promise<T> => {
    const previous = persistenceTails.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.then(() => {}, () => {})
    persistenceTails.set(key, tail)
    void tail.then(() => {
      if (persistenceTails.get(key) == tail) persistenceTails.delete(key)
    })
    return current
  }
  const hit = (key: AuthorizedMusicUrlKeyV1, quality: LX.Quality, url: string, provisional: boolean): PlaybackCacheHit => ({
    key, quality, url, provisional,
  })

  const adoptCacheGeneration = (generation: number): void => {
    if (!Number.isSafeInteger(generation) || generation <= cacheGeneration) return
    cacheGeneration = generation
    validatedMemory.clear()
    tombstones.clear()
    revisions.clear()
  }

  const lookup = async(key: AuthorizedMusicUrlKeyV1): Promise<PlaybackCacheHit | null> => {
    const startingGeneration = cacheGeneration
    for (const quality of getPlaybackQualityOrder(key.quality as LX.Quality)) {
      if (startingGeneration != cacheGeneration) return null
      const candidateKey = withQuality(key, quality)
      const keyId = getKeyId(candidateKey)
      if (tombstones.has(keyId)) continue
      const revision = revisions.get(keyId) ?? 0
      const memoryUrl = validatedMemory.get(keyId)
      if (memoryUrl != null) {
        await Promise.resolve()
        if (startingGeneration != cacheGeneration) return null
        if (tombstones.has(keyId)) continue
        const currentMemoryUrl = validatedMemory.get(keyId)
        if ((revisions.get(keyId) ?? 0) != revision || currentMemoryUrl != memoryUrl) {
          if (currentMemoryUrl != null) return hit(candidateKey, quality, currentMemoryUrl, false)
          continue
        }
        return hit(candidateKey, quality, memoryUrl, false)
      }

      const url = await enqueueKeyOperation(keyId, async() => deps.read(candidateKey))
      if (startingGeneration != cacheGeneration) return null
      if (tombstones.has(keyId)) continue
      if ((revisions.get(keyId) ?? 0) != revision) {
        const currentMemoryUrl = validatedMemory.get(keyId)
        if (currentMemoryUrl != null) return hit(candidateKey, quality, currentMemoryUrl, false)
        continue
      }
      if (url) return hit(candidateKey, quality, url, true)
    }
    return null
  }
  const tombstoneKey = async(key: AuthorizedMusicUrlKeyV1): Promise<void> => {
    const keyId = getKeyId(key)
    incrementRevision(keyId)
    tombstones.add(keyId)
    validatedMemory.delete(keyId)
    await enqueueKeyOperation(keyId, async() => deps.remove(key))
  }
  const commit = async(key: AuthorizedMusicUrlKeyV1, url: string): Promise<void> => {
    const startingGeneration = cacheGeneration
    const keyId = getKeyId(key)
    incrementRevision(keyId)
    tombstones.delete(keyId)
    validatedMemory.set(keyId, url)
    await enqueueKeyOperation(keyId, async() => {
      if (startingGeneration != cacheGeneration) return
      await deps.save(key, url)
      if (startingGeneration != cacheGeneration) await deps.remove(key)
    })
  }
  const invalidateQualityRange = async(key: AuthorizedMusicUrlKeyV1): Promise<void> => {
    await Promise.all(getPlaybackQualityOrder(key.quality as LX.Quality).map(async quality => (
      tombstoneKey(withQuality(key, quality))
    )))
  }

  return { adoptCacheGeneration, lookup, tombstoneKey, commit, invalidateQualityRange, getPlaybackQualityOrder }
}

export const playbackUrlCache = createPlaybackUrlCache({
  read: getMusicUrl,
  save: saveMusicUrl,
  remove: removeMusicUrl,
})
