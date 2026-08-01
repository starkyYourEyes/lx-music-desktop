import type {
  PlaybackRecorderCommandV1,
  PlaybackStartResultV1,
} from '../../../common/storage/playback'
import {
  classifyPlaybackMode,
  parsePlaybackCheckpointAck,
  parsePlaybackResumeAck,
  parsePlaybackStartResult,
} from '../../../common/storage/playbackValidation'
import { sendPlaybackCommand } from '../../utils/playback'
import { createPlaybackRecorderState, reduce } from './reducer'
import type { PlaybackRecorderAction, PlaybackSessionState } from './types'

type PlaybackMode = 'activity' | 'resume-only' | 'private'
type PlaybackStartCommand = Extract<PlaybackRecorderCommandV1, { kind: 'start' }>

const MAX_TIMER_DELAY_MS = (2 ** 31) - 1

export interface PlaybackDeliveryClock {
  now: () => number
  setTimeout: (callback: () => void, delayMs: number) => unknown
  clearTimeout: (timer: unknown) => void
}

export interface PlaybackRecorderOptions {
  transport?: (command: PlaybackRecorderCommandV1) => Promise<unknown>
  isAlive?: () => boolean
  clock?: PlaybackDeliveryClock
  retry?: { initialMs?: number, maxMs?: number }
}

export interface PlaybackFlushOptions {
  timeoutMs?: number
}

export interface PlaybackRecorder {
  dispatch: (action: PlaybackRecorderAction) => PlaybackSessionState
  getState: () => PlaybackSessionState
  flush: (options?: PlaybackFlushOptions) => Promise<boolean>
}

const defaultClock: PlaybackDeliveryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: timer => {
    globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)
  },
}

const commandGroup = (command: PlaybackRecorderCommandV1): string => {
  switch (command.kind) {
    case 'start': return command.request.playbackGroupUuid
    case 'commit': return command.request.checkpoint.playbackGroupUuid
    case 'resume': return command.request.playbackGroupUuid
    case 'preplay_failure': return command.request.playbackGroupUuid
  }
}

const commandMode = (command: PlaybackRecorderCommandV1): PlaybackMode | null => {
  switch (command.kind) {
    case 'start': return classifyPlaybackMode(command.request.consent)
    case 'commit': return 'activity'
    case 'resume': return 'resume-only'
    case 'preplay_failure': return classifyPlaybackMode(command.request.consent) == 'activity' ? 'activity' : null
  }
}

const startResultGroup = (result: PlaybackStartResultV1): string => result.mode == 'private'
  ? result.playbackGroupUuid
  : result.ack.playbackGroupUuid

export const createPlaybackRecorder = (options: PlaybackRecorderOptions = {}): PlaybackRecorder => {
  const transport = options.transport ?? sendPlaybackCommand
  const isAlive = options.isAlive ?? (() => true)
  const clock = options.clock ?? defaultClock
  const initialRetryMs = options.retry?.initialMs ?? 100
  const maxRetryMs = options.retry?.maxMs ?? Math.max(5_000, initialRetryMs)
  if (!Number.isFinite(initialRetryMs) || initialRetryMs <= 0 ||
    !Number.isFinite(maxRetryMs) || maxRetryMs < initialRetryMs ||
    initialRetryMs > MAX_TIMER_DELAY_MS || maxRetryMs > MAX_TIMER_DELAY_MS) {
    throw new Error('Invalid playback retry options')
  }
  const groupModes = new Map<string, PlaybackMode>()
  const groupStartOwners = new Map<string, PlaybackStartCommand>()
  const waiters = new Set<() => void>()

  let state = createPlaybackRecorderState()
  let inFlight: Promise<void> | null = null
  let retryTimer: unknown | null = null
  let failures = 0

  const releaseDrainedGroups = (): void => {
    if (inFlight != null) return
    const retainedGroups = new Set<string>()
    try {
      for (const command of state.outbox) retainedGroups.add(commandGroup(command))
    } catch {
      return
    }
    if (state.playbackGroupUuid != null && state.deliveryMode != 'private' &&
      (state.phase == 'playing' || state.phase == 'paused' || state.phase == 'buffering')) {
      retainedGroups.add(state.playbackGroupUuid)
    }
    for (const group of groupModes.keys()) {
      if (retainedGroups.has(group)) continue
      groupModes.delete(group)
      groupStartOwners.delete(group)
    }
  }

  const notify = (): void => {
    const pending = [...waiters]
    waiters.clear()
    for (const wake of pending) wake()
  }

  const validateAndLatchOutbox = (): boolean => {
    const modes = new Map(groupModes)
    const startOwners = new Map(groupStartOwners)
    try {
      for (const command of state.outbox) {
        const group = commandGroup(command)
        const mode = commandMode(command)
        if (mode == null) return false
        const known = modes.get(group)
        if (known != null && known != mode) return false
        modes.set(group, mode)
        if (command.kind == 'start') {
          const owner = startOwners.get(group)
          if (owner != null && owner !== command) return false
          startOwners.set(group, command)
        }
      }
    } catch {
      return false
    }
    for (const [group, mode] of modes) groupModes.set(group, mode)
    for (const [group, owner] of startOwners) groupStartOwners.set(group, owner)
    return true
  }

  const applyResponse = (command: PlaybackRecorderCommandV1, value: unknown): boolean => {
    if (state.outbox[0] !== command || !validateAndLatchOutbox()) return false
    const group = commandGroup(command)
    switch (command.kind) {
      case 'start': {
        const result = parsePlaybackStartResult(value)
        if (result.mode != commandMode(command) || startResultGroup(result) != group) return false
        if (result.mode == 'activity' && result.ack.checkpointSeq < 1) return false
        state = reduce(state, { type: 'start-result', result })
        return state.outbox[0] !== command
      }
      case 'commit': {
        const ack = parsePlaybackCheckpointAck(value)
        if (ack.playbackGroupUuid != group || ack.checkpointSeq < command.request.checkpoint.checkpointSeq) return false
        state = reduce(state, { type: 'acknowledged', ack })
        return state.outbox[0] !== command
      }
      case 'resume': {
        const ack = parsePlaybackResumeAck(value)
        if (ack.playbackGroupUuid != group || ack.checkpointSeq < command.request.checkpointSeq) return false
        state = reduce(state, { type: 'acknowledged', ack })
        return state.outbox[0] !== command
      }
      case 'preplay_failure': {
        const ack = parsePlaybackCheckpointAck(value)
        if (ack.playbackGroupUuid != group || ack.checkpointSeq < 1) return false
        state = reduce(state, { type: 'acknowledged', ack })
        if (state.outbox[0] === command) state = { ...state, outbox: state.outbox.slice(1) }
        return state.outbox[0] !== command
      }
    }
  }

  const scheduleRetry = (): void => {
    if (retryTimer != null || state.outbox.length == 0 || !isAlive()) return
    const multiplier = 2 ** Math.min(failures, 30)
    const delayMs = multiplier >= maxRetryMs / initialRetryMs ? maxRetryMs : initialRetryMs * multiplier
    failures++
    retryTimer = clock.setTimeout(() => {
      retryTimer = null
      kick()
    }, delayMs)
    const retryHandle = retryTimer as { unref?: () => void }
    retryHandle.unref?.()
  }

  const kick = (): void => {
    if (inFlight != null || retryTimer != null || state.outbox.length == 0 || !isAlive()) return
    if (!validateAndLatchOutbox()) {
      scheduleRetry()
      notify()
      return
    }
    const command = state.outbox[0]
    inFlight = Promise.resolve()
      .then(async() => {
        if (state.outbox[0] !== command || !validateAndLatchOutbox() || !isAlive()) return false
        const response = await transport(command)
        if (!isAlive()) return false
        return applyResponse(command, response)
      })
      .catch(() => {
        state = reduce(state, { type: 'send-failed' })
        return false
      })
      .then(delivered => {
        inFlight = null
        releaseDrainedGroups()
        if (delivered) {
          failures = 0
          notify()
          kick()
        } else {
          notify()
          scheduleRetry()
        }
      })
  }

  const kickForFlush = (): void => {
    if (retryTimer != null) {
      clock.clearTimeout(retryTimer)
      retryTimer = null
    }
    kick()
  }

  const waitForChange = async(timeoutMs: number): Promise<boolean> => new Promise(resolve => {
    let timer: unknown
    let done = false
    const finish = (changed: boolean): void => {
      if (done) return
      done = true
      waiters.delete(wake)
      if (changed) clock.clearTimeout(timer)
      resolve(changed)
    }
    const wake = (): void => {
      finish(true)
    }
    waiters.add(wake)
    timer = clock.setTimeout(() => {
      finish(false)
    }, timeoutMs)
  })

  return {
    dispatch(action) {
      state = reduce(state, action)
      releaseDrainedGroups()
      notify()
      kick()
      return state
    },
    getState: () => state,
    async flush({ timeoutMs = 2_000 } = {}) {
      if (typeof timeoutMs != 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error('Invalid playback flush timeout')
      const deadline = clock.now() + timeoutMs
      kickForFlush()
      while (state.outbox.length > 0) {
        if (!isAlive()) return false
        const remainingMs = deadline - clock.now()
        if (remainingMs <= 0) return false
        if (!await waitForChange(remainingMs)) return state.outbox.length == 0
      }
      return true
    },
  }
}

export type { PlaybackRecorderAction, PlaybackSessionState } from './types'
