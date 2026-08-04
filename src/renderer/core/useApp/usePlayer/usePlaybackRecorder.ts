import { onBeforeUnmount } from '@common/utils/vueTools'
import type {
  PlaybackPauseReason,
  PlaybackPreplayFailureV1,
  PlaybackSeekOrigin,
  PlaybackSelectionIntent,
  PlaybackSkipReason,
  PlaybackStartCommandV1,
} from '@common/storage/playback'
import { createPlaybackRecorder } from '@renderer/core/playbackRecorder'
import type { PlaybackRecorder, PlaybackRecorderAction } from '@renderer/core/playbackRecorder'
import { nextLocalDayBoundary } from '../../playbackRecorder/boundary'
import type { PlaybackDayBoundary, PlaybackSample } from '../../playbackRecorder/types'
import { createPlaybackComparison } from '../../playbackRecorder/comparison'
import type { PlaybackComparison } from '../../playbackRecorder/comparison'
import {
  getCurrentTime,
  getDuration,
  getPlaybackRate,
  onTimeupdate,
} from '@renderer/plugins/player'
import { initRecentPlayList } from '@renderer/store/recentPlay/action'
import { initListeningTimeStats } from '@renderer/store/listeningTime/action'
import { registerShutdownFlusher } from '@renderer/utils/ipc'

const CHECKPOINT_INTERVAL_MS = 15_000
const MAX_TIMER_DELAY_MS = (2 ** 31) - 1

export const DEFAULT_PLAYBACK_POLICY: PlaybackStartCommandV1['consent'] = {
  recentAllowed: true,
  statsAllowed: true,
  privateMode: false,
}

export const getPlaybackPolicy = (): PlaybackStartCommandV1['consent'] => DEFAULT_PLAYBACK_POLICY

export type PlaybackSelection = PlaybackSelectionIntent

interface PlaybackTimers {
  setInterval: (callback: () => void, delayMs: number) => unknown
  clearInterval: (timer: unknown) => void
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export interface PlaybackRecorderControllerOptions {
  recorder: PlaybackRecorder
  getPolicy?: () => PlaybackStartCommandV1['consent']
  now?: () => number
  monotonicNow?: () => number
  createUuid?: () => string
  getPositionMs?: () => number
  getDurationMs?: () => number | null
  refreshRecent?: () => Promise<void>
  refreshListening?: () => Promise<void>
  timeZone?: string
  timers?: PlaybackTimers
  comparison?: PlaybackComparison
}

export interface PlaybackRecorderController {
  select: (selection: PlaybackSelection) => void
  nativePlaying: (playbackRate: number, resumeReason?: PlaybackPauseReason) => void
  newAttempt: () => void
  sample: () => void
  pause: (reason: PlaybackPauseReason) => void
  resume: (reason: PlaybackPauseReason, playbackRate: number) => void
  bufferingStart: () => void
  seek: (intent: { origin: PlaybackSeekOrigin, fromMs: number, toMs: number }) => void
  rateChanged: (playbackRate: number) => void
  error: (error: Omit<PlaybackPreplayFailureV1['error'], 'version' | 'type'>) => void
  advance: (options: { automatic: boolean, reason: PlaybackSkipReason | 'natural_end' }) => void
  naturalEnd: () => void
  checkpoint: () => void
  teardown: () => void
  startTimers: () => void
  stopTimers: () => void
}

type TimedPlaybackSample = Omit<PlaybackSample, 'occurredAtMs'> & { occurredAtMs: number }

const defaultTimers: PlaybackTimers = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: timer => { globalThis.clearInterval(timer as ReturnType<typeof setInterval>) },
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => { globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

const finiteNonNegative = (value: number): number => Number.isFinite(value) && value >= 0 ? Math.round(value) : 0
const cloneSelection = <T extends PlaybackSelection>(selection: T): T =>
  JSON.parse(JSON.stringify(selection)) as T

export const createPlaybackRecorderController = (
  options: PlaybackRecorderControllerOptions,
): PlaybackRecorderController => {
  const recorder = options.recorder
  const getPolicy = options.getPolicy ?? getPlaybackPolicy
  const now = options.now ?? (() => Date.now())
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const createUuid = options.createUuid ?? (() => crypto.randomUUID())
  const getPositionMs = options.getPositionMs ?? (() => 0)
  const getDurationMs = options.getDurationMs ?? (() => null)
  const refreshRecent = options.refreshRecent ?? (async() => {})
  const refreshListening = options.refreshListening ?? (async() => {})
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const timers = options.timers ?? defaultTimers
  const comparison = options.comparison ?? createPlaybackComparison()

  let draft: (PlaybackSelection & { playbackGroupUuid: string }) | null = null
  let groupStarted = false
  let activePolicy: PlaybackStartCommandV1['consent'] | null = null
  let checkpointTimer: unknown | null = null
  let dayBoundaryTimer: unknown | null = null
  let nextDayBoundary: PlaybackDayBoundary | null = null

  const positionMs = (): number => finiteNonNegative(getPositionMs())
  const timed = (): TimedPlaybackSample => ({
    monotonicMs: finiteNonNegative(monotonicNow()),
    positionMs: positionMs(),
    occurredAtMs: finiteNonNegative(now()),
  })

  const localDayAt = (occurredAtMs: number): string => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(occurredAtMs))
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${value.year}-${value.month}-${value.day}`
  }

  const dispatch = (action: PlaybackRecorderAction, checkpoint = false): ReturnType<PlaybackRecorder['getState']> => {
    const before = recorder.getState()
    const after = recorder.dispatch(action)
    const session = after.session ?? before.session
    const consent = session?.consent
    if (session != null && consent?.statsAllowed && !consent.privateMode &&
      before.playbackGroupUuid == after.playbackGroupUuid &&
      after.cumulativePlayedMs >= before.cumulativePlayedMs) {
      const playedMs = after.cumulativePlayedMs - before.cumulativePlayedMs
      if (playedMs > 0) {
        const occurredAtMs = 'occurredAtMs' in action ? finiteNonNegative(action.occurredAtMs) : finiteNonNegative(now())
        comparison.recordAcceptedDelta({
          playedMs,
          occurredAtMs,
          localDay: localDayAt(occurredAtMs),
          track: {
            source: session.track.source,
            sourceTrackId: session.track.sourceTrackId,
          },
        })
      }
    }
    if (checkpoint) comparison.flush()
    return after
  }

  const startRequest = (occurredAtMs: number): PlaybackStartCommandV1 | null => {
    if (draft == null) return null
    const durationMs = getDurationMs()
    return {
      version: 1,
      playbackGroupUuid: draft.playbackGroupUuid,
      track: {
        ...draft.track,
        durationMs: durationMs == null ? draft.track.durationMs : finiteNonNegative(durationMs),
      },
      context: draft.context,
      resume: draft.resume,
      startReason: draft.startReason,
      startPositionMs: draft.startPositionMs,
      occurredAtMs,
      consent: { ...getPolicy() },
    }
  }

  const ensureStarted = (occurredAtMs: number): boolean => {
    if (groupStarted) return true
    const request = startRequest(occurredAtMs)
    if (request == null) return false
    dispatch({ type: 'start-requested', request })
    activePolicy = { ...request.consent }
    groupStarted = true
    return true
  }

  const refreshAfterFlush = (recent: boolean): void => {
    const policy = activePolicy
    void recorder.flush().then(async flushed => {
      if (!flushed || policy == null || policy.privateMode) return
      if (recent && policy.recentAllowed) await refreshRecent()
      if (policy.statsAllowed) await refreshListening()
    }).catch(() => {})
  }

  const dispatchBoundary = (action: PlaybackRecorderAction): void => {
    const before = recorder.getState()
    dispatch(action, true)
    const after = recorder.getState()
    if (before === after || before.phase == 'idle' || before.phase == 'closing') return
    refreshAfterFlush(false)
  }

  const followingDayBoundary = (boundary: PlaybackDayBoundary): PlaybackDayBoundary => nextLocalDayBoundary({
    afterMs: boundary.occurredAtMs,
    timeZone,
  })

  const ensureNextDayBoundary = (afterMs: number): PlaybackDayBoundary => {
    nextDayBoundary ??= nextLocalDayBoundary({ afterMs, timeZone })
    return nextDayBoundary
  }

  const isActivePhase = (phase: ReturnType<PlaybackRecorder['getState']>['phase']): boolean =>
    phase == 'playing' || phase == 'paused' || phase == 'buffering'

  const catchUpDayBoundaries = (current: TimedPlaybackSample): void => {
    let boundary = ensureNextDayBoundary(recorder.getState().sample?.occurredAtMs ?? current.occurredAtMs)
    const state = recorder.getState()
    if (!isActivePhase(state.phase)) {
      while (boundary.occurredAtMs <= current.occurredAtMs) {
        boundary = followingDayBoundary(boundary)
      }
      nextDayBoundary = boundary
      return
    }

    const previous = state.sample
    while (previous?.occurredAtMs != null && boundary.occurredAtMs < previous.occurredAtMs) {
      boundary = followingDayBoundary(boundary)
    }
    const wallDeltaMs = previous?.occurredAtMs == null ? 0 : current.occurredAtMs - previous.occurredAtMs
    const monotonicDeltaMs = previous == null ? 0 : current.monotonicMs - previous.monotonicMs
    const mediaDeltaMs = previous == null ? 0 : current.positionMs - previous.positionMs
    const canInterpolate = previous?.occurredAtMs != null && wallDeltaMs > 0 &&
      monotonicDeltaMs >= 0 && mediaDeltaMs >= 0 &&
      mediaDeltaMs <= monotonicDeltaMs * state.playbackRate + 1_000

    while (boundary.occurredAtMs <= current.occurredAtMs) {
      let monotonicMs = previous?.monotonicMs ?? current.monotonicMs
      let positionMs = previous?.positionMs ?? current.positionMs
      if (canInterpolate && previous?.occurredAtMs != null) {
        // Interpolate from the original endpoints so rounded pieces telescope to the exact final totals.
        const ratio = (boundary.occurredAtMs - previous.occurredAtMs) / wallDeltaMs
        monotonicMs = Math.round(previous.monotonicMs + monotonicDeltaMs * ratio)
        positionMs = Math.round(previous.positionMs + mediaDeltaMs * ratio)
      }
      // Unsafe intervals keep the old baseline at every boundary; their delta can only land after rotation.
      dispatchBoundary({
        type: 'day-boundary',
        monotonicMs: finiteNonNegative(monotonicMs),
        positionMs: finiteNonNegative(positionMs),
        occurredAtMs: boundary.occurredAtMs,
        nextLocalDay: boundary.nextLocalDay,
        utcOffsetMinutes: boundary.utcOffsetMinutes,
      })
      boundary = followingDayBoundary(boundary)
    }
    nextDayBoundary = boundary
  }

  const scheduleDayBoundary = (): void => {
    if (dayBoundaryTimer != null) timers.clearTimeout(dayBoundaryTimer)
    const scheduledAtMs = finiteNonNegative(now())
    const boundary = ensureNextDayBoundary(scheduledAtMs)
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, boundary.occurredAtMs - scheduledAtMs))
    dayBoundaryTimer = timers.setTimeout(() => {
      dayBoundaryTimer = null
      const current = timed()
      catchUpDayBoundaries(current)
      if (isActivePhase(recorder.getState().phase)) dispatch({ type: 'sample', ...current })
      scheduleDayBoundary()
    }, delayMs)
  }

  return {
    select(value) {
      draft = { ...cloneSelection(value), playbackGroupUuid: createUuid() }
      groupStarted = false
      activePolicy = null
    },
    newAttempt() {
      if (draft == null || recorder.getState().phase != 'closing') return
      draft = { ...cloneSelection(draft), playbackGroupUuid: createUuid() }
      groupStarted = false
      activePolicy = null
    },
    nativePlaying(playbackRate, resumeReason = 'device') {
      const current = timed()
      if (!ensureStarted(current.occurredAtMs)) return
      catchUpDayBoundaries(current)
      const phase = recorder.getState().phase
      if (phase == 'paused') {
        dispatchBoundary({ type: 'resume', reason: resumeReason, playbackRate, ...current })
        return
      }
      if (phase == 'buffering') {
        dispatch({ type: 'buffering-end', playbackRate, ...current })
        return
      }
      const firstPlaying = phase == 'pending'
      dispatch({ type: 'native-playing', playbackRate, ...current })
      if (firstPlaying) refreshAfterFlush(true)
    },
    sample() {
      if (!groupStarted) return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatch({ type: 'sample', ...current })
    },
    pause(reason) {
      if (recorder.getState().phase != 'playing') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'pause', reason, ...current })
    },
    resume(reason, playbackRate) {
      if (recorder.getState().phase != 'paused') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'resume', reason, playbackRate, ...current })
    },
    bufferingStart() {
      if (recorder.getState().phase != 'playing') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'buffering-start', ...current })
    },
    seek(intent) {
      if (!groupStarted && draft != null) {
        draft.startPositionMs = finiteNonNegative(intent.toMs)
        return
      }
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({
        type: 'seek-requested',
        origin: intent.origin,
        fromMs: finiteNonNegative(intent.fromMs),
        toMs: finiteNonNegative(intent.toMs),
        monotonicMs: current.monotonicMs,
        occurredAtMs: current.occurredAtMs,
      })
    },
    rateChanged(playbackRate) {
      if (recorder.getState().phase != 'playing') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'rate-changed', playbackRate, ...current })
    },
    error(error) {
      let phase = recorder.getState().phase
      const current = timed()
      if (!groupStarted) {
        if (error.recoverable || !ensureStarted(current.occurredAtMs)) return
      } else if (phase == 'idle' || phase == 'closing') {
        return
      }
      catchUpDayBoundaries(current)
      phase = recorder.getState().phase
      if (phase == 'idle' || phase == 'closing') return
      dispatchBoundary({ type: 'error', ...error, ...current })
    },
    advance(advance) {
      if (advance.reason == 'natural_end') return
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'skip', reason: advance.reason, automatic: advance.automatic, ...current })
    },
    naturalEnd() {
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'natural-end', ...current })
    },
    checkpoint() {
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'periodic-checkpoint', ...current })
    },
    teardown() {
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      const current = timed()
      catchUpDayBoundaries(current)
      dispatchBoundary({ type: 'teardown', ...current })
    },
    startTimers() {
      if (checkpointTimer == null) {
        checkpointTimer = timers.setInterval(() => {
          const phase = recorder.getState().phase
          if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
          const current = timed()
          catchUpDayBoundaries(current)
          dispatchBoundary({ type: 'periodic-checkpoint', ...current })
        }, CHECKPOINT_INTERVAL_MS)
      }
      if (dayBoundaryTimer == null) scheduleDayBoundary()
    },
    stopTimers() {
      if (checkpointTimer != null) timers.clearInterval(checkpointTimer)
      if (dayBoundaryTimer != null) timers.clearTimeout(dayBoundaryTimer)
      checkpointTimer = null
      dayBoundaryTimer = null
    },
  }
}

export default () => {
  const recorder = createPlaybackRecorder()
  const controller = createPlaybackRecorderController({
    recorder,
    getPolicy: getPlaybackPolicy,
    getPositionMs: () => getCurrentTime() * 1000,
    getDurationMs: () => {
      const duration = getDuration()
      return Number.isFinite(duration) && duration > 0 ? duration * 1000 : null
    },
    refreshRecent: initRecentPlayList,
    refreshListening: initListeningTimeStats,
  })

  let pendingPauseReason: PlaybackPauseReason | null = null
  let pendingResumeReason: PlaybackPauseReason | null = null
  const handleSelection = (intent: PlaybackSelectionIntent) => {
    pendingPauseReason = null
    pendingResumeReason = null
    controller.select(intent)
  }
  const handleNewAttempt = () => { controller.newAttempt() }
  const handlePauseRequested = (reason: PlaybackPauseReason) => {
    if (recorder.getState().phase == 'playing') pendingPauseReason = reason
  }
  const handleResumeRequested = (reason: PlaybackPauseReason) => {
    if (recorder.getState().phase == 'paused') pendingResumeReason = reason
  }
  const handlePlaying = () => {
    const reason = pendingResumeReason ?? 'device'
    pendingResumeReason = null
    controller.nativePlaying(getPlaybackRate(), reason)
  }
  const handlePause = () => {
    const reason = pendingPauseReason ?? 'device'
    pendingPauseReason = null
    controller.pause(reason)
  }
  const handleWaiting = () => { controller.bufferingStart() }
  const handleSeek = (intent: { origin: PlaybackSeekOrigin, fromMs: number, toMs: number }) => { controller.seek(intent) }
  const handleAdvance = (advance: { automatic: boolean, reason: PlaybackSkipReason | 'natural_end' }) => { controller.advance(advance) }
  const handleError = (error: Omit<PlaybackPreplayFailureV1['error'], 'version' | 'type'>) => { controller.error(error) }
  const handleEnded = () => { controller.naturalEnd() }
  const handleRateChange = () => { controller.rateChanged(getPlaybackRate()) }
  const handleStop = () => { controller.advance({ automatic: false, reason: 'stop' }) }

  window.app_event.on('musicToggled', handleSelection)
  window.app_event.on('playbackNewAttempt', handleNewAttempt)
  window.app_event.on('playbackPauseRequested', handlePauseRequested)
  window.app_event.on('playbackResumeRequested', handleResumeRequested)
  window.app_event.on('playerPlaying', handlePlaying)
  window.app_event.on('playerPause', handlePause)
  window.app_event.on('playerWaiting', handleWaiting)
  window.app_event.on('playbackSeek', handleSeek)
  window.app_event.on('playbackAdvance', handleAdvance)
  window.app_event.on('playbackError', handleError)
  window.app_event.on('playerEnded', handleEnded)
  window.app_event.on('playerRatechange', handleRateChange)
  window.app_event.on('stop', handleStop)

  const removeTimeupdate = onTimeupdate(() => { controller.sample() })
  const unregisterShutdown = registerShutdownFlusher('playback', timeoutMs => {
    controller.teardown()
    return recorder.flush({ timeoutMs })
  })
  controller.startTimers()

  onBeforeUnmount(() => {
    window.app_event.off('musicToggled', handleSelection)
    window.app_event.off('playbackNewAttempt', handleNewAttempt)
    window.app_event.off('playbackPauseRequested', handlePauseRequested)
    window.app_event.off('playbackResumeRequested', handleResumeRequested)
    window.app_event.off('playerPlaying', handlePlaying)
    window.app_event.off('playerPause', handlePause)
    window.app_event.off('playerWaiting', handleWaiting)
    window.app_event.off('playbackSeek', handleSeek)
    window.app_event.off('playbackAdvance', handleAdvance)
    window.app_event.off('playbackError', handleError)
    window.app_event.off('playerEnded', handleEnded)
    window.app_event.off('playerRatechange', handleRateChange)
    window.app_event.off('stop', handleStop)
    removeTimeupdate()
    unregisterShutdown()
    controller.stopTimers()
    controller.teardown()
    void recorder.flush({ timeoutMs: 2_500 })
  })
}
