export const CACHE_PROFILES = {
  compact: { onlineEntries: 20, onlineSongs: 2000, localEntries: 3, localSongs: 2000, artworkEntries: 256, playbackEntries: 128 },
  balanced: { onlineEntries: 60, onlineSongs: 6000, localEntries: 8, localSongs: 6000, artworkEntries: 1024, playbackEntries: 512 },
  generous: { onlineEntries: 150, onlineSongs: 15000, localEntries: 20, localSongs: 15000, artworkEntries: 4096, playbackEntries: 1024 },
} as const
export const CACHE_IDLE_TTL = 15 * 60_000
export type CacheProfileId = keyof typeof CACHE_PROFILES
export type CacheProfile = typeof CACHE_PROFILES[CacheProfileId]
let current: CacheProfileId = 'compact'
const consumers = new Set<(profile: CacheProfile) => void>()
export const getCacheProfile = (profile: unknown = current): CacheProfile => CACHE_PROFILES[profile as CacheProfileId] ?? CACHE_PROFILES.compact
export const applyCacheProfile = (profile: unknown) => {
  current = typeof profile == 'string' && Object.hasOwn(CACHE_PROFILES, profile) ? profile as CacheProfileId : 'compact'
  for (const consumer of consumers) consumer(getCacheProfile())
}
export const registerCacheProfile = (consumer: (profile: CacheProfile) => void) => {
  consumers.add(consumer)
  consumer(getCacheProfile())
  return () => { consumers.delete(consumer) }
}
