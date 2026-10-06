import { getPicPath } from '@renderer/core/music'
import { BoundedCache } from '@common/performance/boundedCache'
import { CACHE_IDLE_TTL, getCacheProfile, registerCacheProfile } from '@common/performance/cacheProfile'

export interface ArtworkSession {
  peek: (musicInfo: LX.Music.MusicInfo | null | undefined) => string | null | undefined
  resolve: (musicInfo: LX.Music.MusicInfo | null | undefined) => Promise<string | null>
  fail: (musicInfo: LX.Music.MusicInfo | null | undefined, failedUrl: string) => void
  clear: () => void
  configure: (maxEntries: number) => void
}

type ArtworkLoader = (musicInfo: LX.Music.MusicInfo) => Promise<string | null | undefined>

export const getArtworkIdentity = (musicInfo: LX.Music.MusicInfo | null | undefined): string => {
  return musicInfo ? `${musicInfo.source}:${musicInfo.id}` : ''
}

export const getInitialArtworkUrl = (musicInfo: LX.Music.MusicInfo | null | undefined): string | null => {
  const picUrl = musicInfo?.meta.picUrl
  return picUrl && !picUrl.startsWith('webdav:') ? picUrl : null
}

export const createArtworkSession = (loadArtwork: ArtworkLoader): ArtworkSession => {
  const resolved = new BoundedCache<string, string | null>({ maxEntries: getCacheProfile().artworkEntries, ttl: CACHE_IDLE_TTL })
  const inFlight = new Map<string, Promise<string | null>>()

  const peek = (musicInfo: LX.Music.MusicInfo | null | undefined): string | null | undefined => {
    const identity = getArtworkIdentity(musicInfo)
    if (!identity) return null
    if (resolved.has(identity)) return resolved.get(identity)
    return getInitialArtworkUrl(musicInfo) ?? undefined
  }

  const resolve = async(musicInfo: LX.Music.MusicInfo | null | undefined): Promise<string | null> => {
    const identity = getArtworkIdentity(musicInfo)
    if (!identity || !musicInfo) return null
    if (resolved.has(identity)) return resolved.get(identity) ?? null

    const initialUrl = getInitialArtworkUrl(musicInfo)
    if (initialUrl) {
      resolved.set(identity, initialUrl)
      return initialUrl
    }

    const currentRequest = inFlight.get(identity)
    if (currentRequest) return currentRequest

    const generation = resolved.generation
    const request = loadArtwork(musicInfo)
      .then(url => url && !url.startsWith('webdav:') ? url : null)
      .catch(() => null)
      .then(url => {
        if (generation == resolved.generation) resolved.set(identity, url)
        if (inFlight.get(identity) == request) inFlight.delete(identity)
        return url
      })
    inFlight.set(identity, request)
    return request
  }

  const fail = (musicInfo: LX.Music.MusicInfo | null | undefined, failedUrl: string): void => {
    const identity = getArtworkIdentity(musicInfo)
    if (identity && resolved.get(identity) == failedUrl) resolved.set(identity, null)
  }

  return { peek, resolve, fail, clear() { resolved.clear(); inFlight.clear() }, configure(maxEntries) { resolved.configure({ maxEntries }) } }
}

export const artworkSession = createArtworkSession(musicInfo => getPicPath({ musicInfo }))
registerCacheProfile(profile => { artworkSession.configure(profile.artworkEntries) })
