import type {
  PlaybackCheckpointAckV1,
  PlaybackFactV1,
  PlaybackRecorderCommandV1,
  PlaybackResumeAckV1,
  PlaybackStartCommandV1,
} from '../../../common/storage/playback'
import { samplePlayback } from './sampler'
import type { PlaybackRecorderAction, PlaybackSessionState } from './types'

export const createPlaybackRecorderState = (): PlaybackSessionState => ({
  phase: 'idle',
  pending: null,
  playbackGroupUuid: null,
  checkpointSeq: 0,
  cumulativePlayedMs: 0,
  cumulativeActiveMs: 0,
  playbackRate: 1,
  sample: null,
  acknowledged: null,
  outbox: [],
  session: null,
  deliveryMode: null,
})

const modeFor = (request: PlaybackStartCommandV1): PlaybackSessionState['deliveryMode'] => {
  if (request.consent.privateMode) return 'private'
  return !request.consent.recentAllowed && !request.consent.statsAllowed ? 'resume-only' : 'activity'
}

const occurredAt = (action: { occurredAtMs?: number }): number => {
  if (typeof action.occurredAtMs != 'number' || !Number.isFinite(action.occurredAtMs)) throw new Error('occurredAtMs is required')
  return action.occurredAtMs
}

const checkpointCommand = (
  state: PlaybackSessionState,
  occurredAtMs: number,
  fact?: PlaybackFactV1,
  boundary?: { type: 'day_boundary', nextLocalDay: string, utcOffsetMinutes: number },
): PlaybackSessionState => {
  const session = state.session
  if (session == null || state.playbackGroupUuid == null || state.deliveryMode == 'private') return state
  const checkpointSeq = state.checkpointSeq + 1
  const checkpoint = {
    playbackGroupUuid: state.playbackGroupUuid,
    checkpointSeq,
    cumulativePlayedMs: state.cumulativePlayedMs,
    cumulativeActiveMs: state.cumulativeActiveMs,
    positionMs: state.sample?.positionMs ?? session.startPositionMs,
    durationMs: session.track.durationMs,
    occurredAtMs,
  }
  const command: PlaybackRecorderCommandV1 = state.deliveryMode == 'resume-only'
    ? {
        kind: 'resume',
        request: {
          version: 1,
          playbackGroupUuid: state.playbackGroupUuid,
          checkpointSeq,
          track: { source: session.track.source, sourceTrackId: session.track.sourceTrackId },
          listId: session.resume.listId,
          indexHint: session.resume.indexHint,
          positionMs: checkpoint.positionMs,
          durationMs: checkpoint.durationMs,
          updatedAtMs: occurredAtMs,
        },
      }
    : { kind: 'commit', request: boundary == null ? { version: 1, checkpoint, ...(fact == null ? {} : { fact }) } : { version: 1, checkpoint, boundary } }
  return { ...state, checkpointSeq, outbox: [...state.outbox, command] }
}

const sampleAction = (
  state: PlaybackSessionState,
  action: { monotonicMs: number, positionMs: number, occurredAtMs?: number },
): PlaybackSessionState => samplePlayback(state, action.monotonicMs, action.positionMs, action.occurredAtMs)

const startPending = (state: PlaybackSessionState, request: PlaybackStartCommandV1): PlaybackSessionState => ({
  ...state,
  phase: 'pending',
  pending: request,
  playbackGroupUuid: request.playbackGroupUuid,
  checkpointSeq: 0,
  cumulativePlayedMs: 0,
  cumulativeActiveMs: 0,
  playbackRate: 1,
  sample: null,
  acknowledged: null,
  session: null,
  deliveryMode: modeFor(request),
})

const commandGroup = (command: PlaybackRecorderCommandV1): string => {
  switch (command.kind) {
    case 'start': return command.request.playbackGroupUuid
    case 'commit': return command.request.checkpoint.playbackGroupUuid
    case 'resume': return command.request.playbackGroupUuid
    case 'preplay_failure': return command.request.playbackGroupUuid
  }
}

const commandSequence = (command: PlaybackRecorderCommandV1): number | null => {
  if (command.kind == 'commit') return command.request.checkpoint.checkpointSeq
  if (command.kind == 'resume') return command.request.checkpointSeq
  return null
}

const acknowledge = (
  state: PlaybackSessionState,
  ack: PlaybackCheckpointAckV1 | PlaybackResumeAckV1,
): PlaybackSessionState => {
  if (state.acknowledged?.playbackGroupUuid == ack.playbackGroupUuid && ack.checkpointSeq < state.acknowledged.checkpointSeq) return state
  return {
    ...state,
    acknowledged: ack,
    outbox: state.outbox.filter(command => {
      if (commandGroup(command) != ack.playbackGroupUuid) return true
      const sequence = commandSequence(command)
      return sequence == null || sequence > ack.checkpointSeq
    }),
  }
}

export const reduce = (state: PlaybackSessionState, action: PlaybackRecorderAction): PlaybackSessionState => {
  switch (action.type) {
    case 'start-requested':
      return state.phase == 'pending' || state.phase == 'playing' || state.phase == 'buffering' || state.phase == 'paused'
        ? state
        : startPending(state, action.request)
    case 'native-playing': {
      if (state.phase == 'pending' && state.pending != null) {
        const session = state.pending
        const playing: PlaybackSessionState = {
          ...state,
          phase: 'playing',
          pending: null,
          session,
          checkpointSeq: state.deliveryMode == 'activity' ? Math.max(state.checkpointSeq, 1) : state.checkpointSeq,
          playbackRate: action.playbackRate,
          sample: { monotonicMs: action.monotonicMs, positionMs: action.positionMs, occurredAtMs: action.occurredAtMs },
        }
        if (state.deliveryMode == 'activity') {
          return { ...playing, outbox: [...state.outbox, { kind: 'start', request: session }] }
        }
        if (state.deliveryMode == 'resume-only') return checkpointCommand(playing, occurredAt(action))
        return playing
      }
      if (state.phase != 'paused' && state.phase != 'buffering') return state
      return {
        ...sampleAction(state, action),
        phase: 'playing',
        playbackRate: action.playbackRate,
        sample: { monotonicMs: action.monotonicMs, positionMs: action.positionMs, occurredAtMs: action.occurredAtMs },
      }
    }
    case 'start-result': {
      const playbackGroupUuid = action.result.mode == 'private' ? action.result.playbackGroupUuid : action.result.ack.playbackGroupUuid
      const withoutMatchingStart = {
        ...state,
        outbox: state.outbox.filter(command => command.kind != 'start' || command.request.playbackGroupUuid != playbackGroupUuid),
      }
      if (playbackGroupUuid != state.playbackGroupUuid) return withoutMatchingStart
      if (action.result.mode == 'private') return { ...withoutMatchingStart, checkpointSeq: Math.max(state.checkpointSeq, action.result.checkpointSeq) }
      const acknowledged = acknowledge(withoutMatchingStart, action.result.ack)
      return { ...acknowledged, checkpointSeq: Math.max(state.checkpointSeq, action.result.ack.checkpointSeq) }
    }
    case 'sample':
      return sampleAction(state, action)
    case 'pause': {
      if (state.phase != 'playing') return state
      const sampled = sampleAction(state, action)
      return { ...checkpointCommand(sampled, occurredAt(action), { version: 1, type: 'pause', reason: action.reason }), phase: 'paused' }
    }
    case 'resume': {
      if (state.phase != 'paused') return state
      const sampled = sampleAction(state, action)
      const resumed = {
        ...sampled,
        phase: 'playing' as const,
        playbackRate: action.playbackRate,
        sample: { monotonicMs: action.monotonicMs, positionMs: action.positionMs, occurredAtMs: action.occurredAtMs },
      }
      return checkpointCommand(resumed, occurredAt(action), { version: 1, type: 'resume', reason: action.reason })
    }
    case 'buffering-start': {
      if (state.phase != 'playing') return state
      const sampled = sampleAction(state, action)
      return { ...checkpointCommand(sampled, occurredAt(action)), phase: 'buffering' }
    }
    case 'buffering-end': {
      if (state.phase != 'buffering') return state
      return { ...sampleAction(state, action), phase: 'playing', playbackRate: action.playbackRate }
    }
    case 'rate-changed': {
      if (state.phase != 'playing') return state
      const sampled = sampleAction(state, action)
      return checkpointCommand({ ...sampled, playbackRate: action.playbackRate }, occurredAt(action))
    }
    case 'seek-requested': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, { monotonicMs: action.monotonicMs, positionMs: action.fromMs })
      const checkpointed = checkpointCommand(sampled, occurredAt(action), {
        version: 1,
        type: 'seek',
        origin: action.origin,
        fromMs: action.fromMs,
        toMs: action.toMs,
      })
      return {
        ...checkpointed,
        sample: { monotonicMs: action.monotonicMs, positionMs: action.toMs, occurredAtMs: action.occurredAtMs },
      }
    }
    case 'natural-end': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, action)
      return { ...checkpointCommand(sampled, occurredAt(action), { version: 1, type: 'play_end', reason: 'natural_end' }), phase: 'closing' }
    }
    case 'skip': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, action)
      return { ...checkpointCommand(sampled, occurredAt(action), { version: 1, type: 'skip', reason: action.reason, automatic: action.automatic }), phase: 'closing' }
    }
    case 'teardown': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, action)
      return { ...checkpointCommand(sampled, occurredAt(action)), phase: 'closing' }
    }
    case 'periodic-checkpoint': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      return checkpointCommand(sampleAction(state, action), occurredAt(action))
    }
    case 'error': {
      const fact: PlaybackFactV1 = { version: 1, type: 'error', stage: action.stage, code: action.code, recoverable: action.recoverable, attempt: action.attempt }
      if (state.phase == 'pending' && state.pending != null) {
        if (action.recoverable) return state
        const closed = { ...state, pending: null, phase: 'closing' as const }
        if (state.deliveryMode != 'activity') return closed
        const request = { ...state.pending, error: fact }
        return { ...closed, outbox: [...state.outbox, { kind: 'preplay_failure', request }] }
      }
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, action)
      return { ...checkpointCommand(sampled, occurredAt(action), fact), phase: action.recoverable ? 'buffering' : 'closing' }
    }
    case 'repeat': {
      const closing = reduce(state, { type: 'natural-end', monotonicMs: action.monotonicMs, positionMs: action.positionMs, occurredAtMs: action.occurredAtMs })
      return startPending(closing, action.request)
    }
    case 'statistics-clear': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, action)
      return checkpointCommand(sampled, occurredAt(action))
    }
    case 'day-boundary': {
      if (state.phase != 'playing' && state.phase != 'paused' && state.phase != 'buffering') return state
      const sampled = sampleAction(state, action)
      return checkpointCommand(sampled, occurredAt(action), undefined, {
        type: 'day_boundary',
        nextLocalDay: action.nextLocalDay,
        utcOffsetMinutes: action.utcOffsetMinutes,
      })
    }
    case 'acknowledged':
      return acknowledge(state, action.ack)
    case 'send-failed':
      return state
  }
}
