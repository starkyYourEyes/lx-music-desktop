import type { PlaybackSessionState } from './types'

export const samplePlayback = (
  state: PlaybackSessionState,
  monotonicMs: number,
  positionMs: number,
): PlaybackSessionState => {
  const sample = { monotonicMs, positionMs }
  if (state.phase != 'playing' || state.sample == null) return { ...state, sample }

  const activeDelta = Math.max(0, monotonicMs - state.sample.monotonicMs)
  const mediaDelta = positionMs - state.sample.positionMs
  const playableDelta = mediaDelta >= 0 && mediaDelta <= activeDelta * state.playbackRate + 1000 ? mediaDelta : 0
  if (state.session == null || !state.session.consent.statsAllowed) return { ...state, sample }
  return {
    ...state,
    sample,
    cumulativeActiveMs: state.cumulativeActiveMs + activeDelta,
    cumulativePlayedMs: state.cumulativePlayedMs + playableDelta,
  }
}
