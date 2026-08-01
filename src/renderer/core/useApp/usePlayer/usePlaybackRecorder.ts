import { onBeforeUnmount, toRaw } from '@common/utils/vueTools'
import type {
  PlaybackPauseReason,
  PlaybackPreplayFailureV1,
  PlaybackSeekOrigin,
  PlaybackSkipReason,
  PlaybackStartCommandV1,
  PlaybackStartReason,
  PlaybackTrackV1,
} from '@common/storage/playback'
import { createPlaybackRecorder } from '@renderer/core/playbackRecorder'
import type { PlaybackRecorder, PlaybackRecorderAction } from '@renderer/core/playbackRecorder'
import { nextLocalDayBoundary } from '../../playbackRecorder/boundary'
import {
  getCurrentTime,
  getDuration,
  getPlaybackRate,
  onTimeupdate,
} from '@renderer/plugins/player'
import { playInfo, playMusicInfo } from '@renderer/store/player/state'
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

export interface PlaybackSelection {
  track: PlaybackTrackV1
  context: PlaybackStartCommandV1['context']
  resume: PlaybackStartCommandV1['resume']
  startReason: PlaybackStartReason
  startPositionMs: number
}

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
}

export interface PlaybackRecorderController {
  select: (selection: PlaybackSelection) => void
  nativePlaying: (playbackRate: number) => void
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

const defaultTimers: PlaybackTimers = {
  setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
  clearInterval: timer => { globalThis.clearInterval(timer as ReturnType<typeof setInterval>) },
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => { globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>) },
}

const finiteNonNegative = (value: number): number => Number.isFinite(value) && value >= 0 ? Math.round(value) : 0

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

  let draft: (PlaybackSelection & { playbackGroupUuid: string }) | null = null
  let groupStarted = false
  let checkpointTimer: unknown | null = null
  let dayBoundaryTimer: unknown | null = null

  const positionMs = (): number => finiteNonNegative(getPositionMs())
  const timed = () => ({
    monotonicMs: finiteNonNegative(monotonicNow()),
    positionMs: positionMs(),
    occurredAtMs: finiteNonNegative(now()),
  })

  const startRequest = (): PlaybackStartCommandV1 | null => {
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
      occurredAtMs: finiteNonNegative(now()),
      consent: { ...getPolicy() },
    }
  }

  const ensureStarted = (): boolean => {
    if (groupStarted) return true
    const request = startRequest()
    if (request == null) return false
    recorder.dispatch({ type: 'start-requested', request })
    groupStarted = true
    return true
  }

  const refreshAfterFlush = (recent: boolean): void => {
    void recorder.flush().then(async flushed => {
      if (!flushed) return
      if (recent) await refreshRecent()
      await refreshListening()
    }).catch(() => {})
  }

  const dispatchBoundary = (action: PlaybackRecorderAction): void => {
    const before = recorder.getState()
    recorder.dispatch(action)
    const after = recorder.getState()
    if (before === after || before.phase == 'idle' || before.phase == 'closing') return
    refreshAfterFlush(false)
  }

  const scheduleDayBoundary = (): void => {
    if (dayBoundaryTimer != null) timers.clearTimeout(dayBoundaryTimer)
    const boundary = nextLocalDayBoundary({ afterMs: now(), timeZone })
    const delayMs = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, boundary.occurredAtMs - now()))
    dayBoundaryTimer = timers.setTimeout(() => {
      dayBoundaryTimer = null
      dispatchBoundary({
        type: 'day-boundary',
        ...timed(),
        nextLocalDay: boundary.nextLocalDay,
        utcOffsetMinutes: boundary.utcOffsetMinutes,
      })
      scheduleDayBoundary()
    }, delayMs)
  }

  return {
    select(value) {
      draft = { ...value, playbackGroupUuid: createUuid() }
      groupStarted = false
    },
    nativePlaying(playbackRate) {
      if (!ensureStarted()) return
      const phase = recorder.getState().phase
      if (phase == 'paused') {
        dispatchBoundary({ type: 'resume', reason: 'user', playbackRate, ...timed() })
        return
      }
      if (phase == 'buffering') {
        recorder.dispatch({ type: 'buffering-end', playbackRate, ...timed() })
        return
      }
      const firstPlaying = phase == 'pending'
      recorder.dispatch({ type: 'native-playing', playbackRate, ...timed() })
      if (firstPlaying) refreshAfterFlush(true)
    },
    sample() {
      if (!groupStarted) return
      recorder.dispatch({ type: 'sample', monotonicMs: monotonicNow(), positionMs: positionMs() })
    },
    pause(reason) {
      if (recorder.getState().phase != 'playing') return
      dispatchBoundary({ type: 'pause', reason, ...timed() })
    },
    resume(reason, playbackRate) {
      if (recorder.getState().phase != 'paused') return
      dispatchBoundary({ type: 'resume', reason, playbackRate, ...timed() })
    },
    bufferingStart() {
      if (recorder.getState().phase != 'playing') return
      dispatchBoundary({ type: 'buffering-start', ...timed() })
    },
    seek(intent) {
      if (!groupStarted && draft != null) {
        draft.startPositionMs = finiteNonNegative(intent.toMs)
        return
      }
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      dispatchBoundary({
        type: 'seek-requested',
        origin: intent.origin,
        fromMs: finiteNonNegative(intent.fromMs),
        toMs: finiteNonNegative(intent.toMs),
        monotonicMs: finiteNonNegative(monotonicNow()),
        occurredAtMs: finiteNonNegative(now()),
      })
    },
    rateChanged(playbackRate) {
      if (recorder.getState().phase != 'playing') return
      dispatchBoundary({ type: 'rate-changed', playbackRate, ...timed() })
    },
    error(error) {
      const phase = recorder.getState().phase
      if (!groupStarted) {
        if (error.recoverable || !ensureStarted()) return
      } else if (phase == 'idle' || phase == 'closing') {
        return
      }
      dispatchBoundary({ type: 'error', ...error, ...timed() })
    },
    advance(advance) {
      if (advance.reason == 'natural_end') return
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      dispatchBoundary({ type: 'skip', reason: advance.reason, automatic: advance.automatic, ...timed() })
    },
    naturalEnd() {
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      dispatchBoundary({ type: 'natural-end', ...timed() })
    },
    checkpoint() {
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      dispatchBoundary({ type: 'periodic-checkpoint', ...timed() })
    },
    teardown() {
      const phase = recorder.getState().phase
      if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
      dispatchBoundary({ type: 'teardown', ...timed() })
    },
    startTimers() {
      if (checkpointTimer == null) {
        checkpointTimer = timers.setInterval(() => {
          const phase = recorder.getState().phase
          if (phase != 'playing' && phase != 'paused' && phase != 'buffering') return
          dispatchBoundary({ type: 'periodic-checkpoint', ...timed() })
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

const clonePlayablePayload = (musicInfo: LX.Music.MusicInfo): LX.Music.MusicInfo =>
  JSON.parse(JSON.stringify(toRaw(musicInfo))) as LX.Music.MusicInfo

const currentTrack = (): PlaybackTrackV1 | null => {
  const current = playMusicInfo.musicInfo
  if (current == null) return null
  const musicInfo = 'progress' in current ? current.metadata.musicInfo : current
  const duration = getDuration()
  return {
    source: musicInfo.source,
    sourceTrackId: musicInfo.id,
    name: musicInfo.name,
    singer: musicInfo.singer,
    durationMs: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
    playablePayload: clonePlayablePayload(musicInfo),
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

  const handleSelection = (intent: { startReason: PlaybackStartReason }) => {
    const track = currentTrack()
    if (track == null) return
    controller.select({
      track,
      context: { type: playMusicInfo.isTempPlay ? 'temporary' : 'playlist', id: playMusicInfo.listId },
      resume: {
        listId: playMusicInfo.isTempPlay ? null : playMusicInfo.listId,
        indexHint: playInfo.playIndex < 0 ? null : playInfo.playIndex,
      },
      startReason: intent.startReason,
      startPositionMs: Math.round(getCurrentTime() * 1000),
    })
  }
  const handlePlaying = () => { controller.nativePlaying(getPlaybackRate()) }
  const handlePause = () => { controller.pause('user') }
  const handleWaiting = () => { controller.bufferingStart() }
  const handleSeek = (intent: { origin: PlaybackSeekOrigin, fromMs: number, toMs: number }) => { controller.seek(intent) }
  const handleAdvance = (advance: { automatic: boolean, reason: PlaybackSkipReason | 'natural_end' }) => { controller.advance(advance) }
  const handleError = (error: Omit<PlaybackPreplayFailureV1['error'], 'version' | 'type'>) => { controller.error(error) }
  const handleEnded = () => { controller.naturalEnd() }
  const handleRateChange = () => { controller.rateChanged(getPlaybackRate()) }
  const handleStop = () => { controller.advance({ automatic: false, reason: 'stop' }) }

  window.app_event.on('musicToggled', handleSelection)
  window.app_event.on('playerPlaying', handlePlaying)
  window.app_event.on('pause', handlePause)
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
    window.app_event.off('playerPlaying', handlePlaying)
    window.app_event.off('pause', handlePause)
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
