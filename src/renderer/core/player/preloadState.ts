import { getPlaybackSongIdentity } from '@renderer/core/music/playback/coordinator'

// Failures belong to the current listening run, never to the saved playlist.
export const createPreloadFailureState = () => {
  const failed = new Set<string>()
  return {
    failed,
    get stopped() { return failed.size >= 5 },
    add(info: LX.Player.PlayMusicInfo['musicInfo']) {
      const identity = getPlaybackSongIdentity(info)
      if (failed.has(identity)) return false
      failed.add(identity)
      return true
    },
    reset() { failed.clear() },
  }
}

export const preloadFailureState = createPreloadFailureState()
