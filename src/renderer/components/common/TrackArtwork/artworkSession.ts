import { getPicPath } from '@renderer/core/music'

export interface ArtworkSession {
  peek: (musicInfo: LX.Music.MusicInfo | null | undefined) => string | null | undefined
  resolve: (musicInfo: LX.Music.MusicInfo | null | undefined) => Promise<string | null>
  fail: (musicInfo: LX.Music.MusicInfo | null | undefined, failedUrl: string) => void
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
  const resolved = new Map<string, string | null>()
  const inFlight = new Map<string, Promise<string | null>>()

  const peek = (musicInfo: LX.Music.MusicInfo | null | undefined): string | null | undefined => {
    const identity = getArtworkIdentity(musicInfo)
    if (!identity) return null
    if (resolved.has(identity)) return resolved.get(identity)
    return getInitialArtworkUrl(musicInfo)
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

    const request = loadArtwork(musicInfo)
      .then(url => url && !url.startsWith('webdav:') ? url : null)
      .catch(() => null)
      .then(url => {
        resolved.set(identity, url)
        inFlight.delete(identity)
        return url
      })
    inFlight.set(identity, request)
    return request
  }

  const fail = (musicInfo: LX.Music.MusicInfo | null | undefined, failedUrl: string): void => {
    const identity = getArtworkIdentity(musicInfo)
    if (identity && resolved.get(identity) == failedUrl) resolved.set(identity, null)
  }

  return { peek, resolve, fail }
}

export const artworkSession = createArtworkSession(musicInfo => getPicPath({ musicInfo }))
