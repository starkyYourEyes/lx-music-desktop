import { getMusicUrlByKey, removeMusicUrlByKey, saveMusicUrl } from '@renderer/utils/ipc'

export interface PlaybackCacheHit {
  key: string
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
  lookup: (musicInfo: LX.Music.MusicInfo, requested: LX.Quality) => Promise<PlaybackCacheHit | null>
  tombstone: (musicInfo: LX.Music.MusicInfo, quality: LX.Quality) => Promise<void>
  tombstoneKey: (key: string) => Promise<void>
  commit: (musicInfo: LX.Music.MusicInfo, quality: LX.Quality, url: string) => Promise<void>
  invalidateQualityRange: (musicInfo: LX.Music.MusicInfo, requested: LX.Quality) => Promise<void>
  getPlaybackQualityOrder: (requested: LX.Quality) => LX.Quality[]
}

interface PlaybackUrlCacheDependencies {
  read: (key: string) => Promise<string | null | undefined>
  save: (musicInfo: LX.Music.MusicInfo, quality: LX.Quality, url: string) => Promise<void>
  remove: (key: string) => Promise<void>
  memory?: Map<string, string>
}

const ORDERED_PLAYBACK_QUALITIES: LX.Quality[] = ['flac24bit', 'flac', '320k', '128k']

export const getPlaybackQualityOrder = (requested: LX.Quality): LX.Quality[] => {
  const index = ORDERED_PLAYBACK_QUALITIES.indexOf(requested)
  if (index >= 0) return ORDERED_PLAYBACK_QUALITIES.slice(index)
  return requested == '128k' ? ['128k'] : [requested, '128k']
}

const getKey = (musicInfo: LX.Music.MusicInfo, quality: LX.Quality) => `${musicInfo.id}_${quality}`

export const createPlaybackUrlCache = (deps: PlaybackUrlCacheDependencies): PlaybackUrlCache => {
  const validatedMemory = deps.memory ?? new Map<string, string>()
  const tombstones = new Set<string>()
  const revisions = new Map<string, number>()
  const persistenceTails = new Map<string, Promise<void>>()

  const incrementRevision = (key: string) => {
    revisions.set(key, (revisions.get(key) ?? 0) + 1)
  }
  const enqueuePersistence = async(key: string, operation: () => Promise<void>): Promise<void> => {
    const previous = persistenceTails.get(key) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    const tail = current.catch(() => {})
    persistenceTails.set(key, tail)
    void tail.then(() => {
      if (persistenceTails.get(key) == tail) persistenceTails.delete(key)
    })
    return current
  }
  const hit = (key: string, quality: LX.Quality, url: string, provisional: boolean): PlaybackCacheHit => ({
    key, quality, url, provisional,
  })

  const lookup = async(musicInfo: LX.Music.MusicInfo, requested: LX.Quality): Promise<PlaybackCacheHit | null> => {
    for (const quality of getPlaybackQualityOrder(requested)) {
      const key = getKey(musicInfo, quality)
      if (tombstones.has(key)) continue
      const memoryUrl = validatedMemory.get(key)
      if (memoryUrl != null) return hit(key, quality, memoryUrl, false)

      const revision = revisions.get(key) ?? 0
      const url = await deps.read(key)
      if (tombstones.has(key)) continue
      if ((revisions.get(key) ?? 0) != revision) {
        const currentMemoryUrl = validatedMemory.get(key)
        if (currentMemoryUrl != null) return hit(key, quality, currentMemoryUrl, false)
        continue
      }
      if (url) return hit(key, quality, url, true)
    }
    return null
  }
  const tombstoneKey = async(key: string): Promise<void> => {
    incrementRevision(key)
    tombstones.add(key)
    validatedMemory.delete(key)
    await enqueuePersistence(key, async() => deps.remove(key))
  }
  const tombstone = async(musicInfo: LX.Music.MusicInfo, quality: LX.Quality): Promise<void> => {
    await tombstoneKey(getKey(musicInfo, quality))
  }
  const commit = async(musicInfo: LX.Music.MusicInfo, quality: LX.Quality, url: string): Promise<void> => {
    const key = getKey(musicInfo, quality)
    incrementRevision(key)
    tombstones.delete(key)
    validatedMemory.set(key, url)
    await enqueuePersistence(key, async() => deps.save(musicInfo, quality, url))
  }
  const invalidateQualityRange = async(musicInfo: LX.Music.MusicInfo, requested: LX.Quality): Promise<void> => {
    await Promise.all(getPlaybackQualityOrder(requested).map(async quality => tombstone(musicInfo, quality)))
  }

  return { lookup, tombstone, tombstoneKey, commit, invalidateQualityRange, getPlaybackQualityOrder }
}

export const playbackUrlCache = createPlaybackUrlCache({
  read: getMusicUrlByKey,
  save: saveMusicUrl,
  remove: removeMusicUrlByKey,
})
