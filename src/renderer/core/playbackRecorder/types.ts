import type {
  PlaybackCheckpointAckV1,
  PlaybackFactV1,
  PlaybackPauseReason,
  PlaybackPreplayFailureV1,
  PlaybackRecorderCommandV1,
  PlaybackResumeAckV1,
  PlaybackSeekOrigin,
  PlaybackSkipReason,
  PlaybackStartCommandV1,
  PlaybackStartResultV1,
} from '../../../common/storage/playback'

export interface PlaybackSample {
  monotonicMs: number
  positionMs: number
  occurredAtMs: number | null
}

export interface PlaybackSessionState {
  phase: 'idle' | 'pending' | 'playing' | 'buffering' | 'paused' | 'closing'
  pending: PlaybackStartCommandV1 | null
  playbackGroupUuid: string | null
  checkpointSeq: number
  cumulativePlayedMs: number
  cumulativeActiveMs: number
  playbackRate: number
  sample: PlaybackSample | null
  acknowledged: PlaybackCheckpointAckV1 | PlaybackResumeAckV1 | null
  outbox: PlaybackRecorderCommandV1[]
  session: PlaybackStartCommandV1 | null
  deliveryMode: 'activity' | 'resume-only' | 'private' | null
}

interface TimedAction {
  monotonicMs: number
  positionMs: number
  occurredAtMs: number
}

interface SampleAction {
  monotonicMs: number
  positionMs: number
  occurredAtMs: number
}

export type PlaybackRecorderAction =
  | { type: 'start-requested', request: PlaybackStartCommandV1 }
  | ({ type: 'native-playing', playbackRate: number } & TimedAction)
  | ({ type: 'sample' } & SampleAction)
  | ({ type: 'pause', reason: PlaybackPauseReason } & TimedAction)
  | ({ type: 'resume', reason: PlaybackPauseReason, playbackRate: number } & TimedAction)
  | ({ type: 'buffering-start' } & TimedAction)
  | ({ type: 'buffering-end', playbackRate: number } & TimedAction)
  | ({ type: 'rate-changed', playbackRate: number } & TimedAction)
  | {
    type: 'seek-requested'
    origin: PlaybackSeekOrigin
    fromMs: number
    toMs: number
    monotonicMs: number
    occurredAtMs: number
  }
  | ({ type: 'natural-end' } & TimedAction)
  | ({ type: 'skip', reason: PlaybackSkipReason, automatic: boolean } & TimedAction)
  | ({ type: 'teardown' } & TimedAction)
  | ({ type: 'periodic-checkpoint' } & TimedAction)
  | ({
    type: 'error'
    stage: Extract<PlaybackFactV1, { type: 'error' }>['stage']
    code: number | null
    recoverable: boolean
    attempt: number
  } & TimedAction)
  | ({ type: 'repeat', request: PlaybackStartCommandV1 } & TimedAction)
  | ({ type: 'statistics-clear' } & TimedAction)
  | ({
    type: 'day-boundary'
    nextLocalDay: string
    utcOffsetMinutes: number
  } & TimedAction)
  | { type: 'start-result', result: PlaybackStartResultV1 }
  | { type: 'acknowledged', ack: PlaybackCheckpointAckV1 | PlaybackResumeAckV1 }
  | { type: 'send-failed' }

export interface PlaybackDayBoundary {
  occurredAtMs: number
  nextLocalDay: string
  utcOffsetMinutes: number
}

export type PlaybackPreplayError = PlaybackPreplayFailureV1['error']
