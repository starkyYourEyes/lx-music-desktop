import { getProxy as getAppProxy } from '@main/utils'
import {
  createQQMusicBrowserAuthSession,
  type QQMusicBrowserAuthCreateOptions,
  type QQMusicBrowserAuthDiagnostic,
  type QQMusicBrowserAuthSession,
} from './browserAuth'

export interface QQMusicLoginQr {
  key: string
  qrimg: string
}

export type QQMusicInternalLoginCheck =
  | { state: 'waiting' | 'scanned' | 'expired', message: string }
  | { state: 'success', message: string, cookie: string }

const QR_SESSION_TTL_MS = 5 * 60 * 1000
const CREATE_DEADLINE_MS = 15_000
const TOMBSTONE_TTL_MS = 30_000
const MAX_TOMBSTONES = 64
const CREATE_ERROR = 'QQ Music login QR creation failed'
const CREATE_TIMEOUT_ERROR = 'QQ Music login QR creation timed out'
const CHECK_ERROR = 'QQ Music login check failed'
const EXPIRED_RESULT: QQMusicInternalLoginCheck = {
  state: 'expired',
  message: '二维码已失效，请重新获取',
}
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

interface LoginEntryBase {
  requestId: string
  startedAt: number
  abortController: AbortController
  expiresAt: number
  expiryTimer?: ReturnType<typeof setTimeout>
}

interface PendingLoginEntry extends LoginEntryBase {
  state: 'pending'
}

interface ActiveLoginEntry extends LoginEntryBase {
  state: 'active'
  auth: QQMusicBrowserAuthSession
  consecutiveCheckFailures: number
}

type LoginEntry = PendingLoginEntry | ActiveLoginEntry

type QQMusicLoginDiagnostic =
  | {
    stage: 'session-registered' | 'cancelled' | 'timed-out'
    elapsedMs: number
  }
  | {
    stage: 'browser-auth-error'
    reason: 'create-failed' | 'check-failed'
    elapsedMs: number
  }

const defaultDiagnostic = (
  event: QQMusicBrowserAuthDiagnostic | QQMusicLoginDiagnostic,
) => {
  const isWarning = event.stage == 'timed-out' ||
    event.stage == 'terminal-failure' ||
    event.stage == 'partition-cleanup-timed-out' ||
    event.stage == 'browser-auth-error'
  const write = isWarning ? console.warn : console.info
  write('[QQ Music login diagnostic]', event)
}

export const isQQMusicLoginRequestId = (
  requestId: unknown,
): requestId is string => {
  return typeof requestId == 'string' && UUID_V4_PATTERN.test(requestId)
}

const assertRequestId: (
  requestId: unknown,
) => asserts requestId is string = requestId => {
  if (!isQQMusicLoginRequestId(requestId)) throw new Error(CREATE_ERROR)
}

export const createQQMusicLoginService = ({
  createBrowserAuthSession = createQQMusicBrowserAuthSession,
  getProxy = getAppProxy,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  ttlMs = QR_SESSION_TTL_MS,
  createDeadlineMs = CREATE_DEADLINE_MS,
  tombstoneTtlMs = TOMBSTONE_TTL_MS,
  maxTombstones = MAX_TOMBSTONES,
  onDiagnostic = defaultDiagnostic,
}: {
  createBrowserAuthSession?: (
    options: QQMusicBrowserAuthCreateOptions,
  ) => Promise<QQMusicBrowserAuthSession>
  getProxy?: typeof getAppProxy
  now?: () => number
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  ttlMs?: number
  createDeadlineMs?: number
  tombstoneTtlMs?: number
  maxTombstones?: number
  onDiagnostic?: (
    event: QQMusicBrowserAuthDiagnostic | QQMusicLoginDiagnostic,
  ) => void
} = {}) => {
  const entries = new Map<string, LoginEntry>()
  const tombstones = new Map<string, number>()

  const pruneTombstones = () => {
    const currentTime = now()
    for (const [requestId, expiresAt] of tombstones) {
      if (expiresAt <= currentTime) tombstones.delete(requestId)
    }
  }

  const addTombstone = (requestId: string) => {
    pruneTombstones()
    tombstones.set(requestId, now() + tombstoneTtlMs)
    while (tombstones.size > maxTombstones) {
      const oldest = [...tombstones.entries()]
        .sort((left, right) => left[1] - right[1])[0]
      if (!oldest) return
      tombstones.delete(oldest[0])
    }
  }

  const consumeTombstone = (requestId: string): boolean => {
    pruneTombstones()
    if (!tombstones.has(requestId)) return false
    tombstones.delete(requestId)
    return true
  }

  const cleanupTasks = new Set<Promise<void>>()

  const trackCleanup = (task: Promise<void>) => {
    const settledTask = task.catch(() => {})
    cleanupTasks.add(settledTask)
    void settledTask.finally(() => {
      cleanupTasks.delete(settledTask)
    })
  }

  const disposeDetachedEntry = (entry: LoginEntry) => {
    if (entry.expiryTimer) clearTimer(entry.expiryTimer)
    entry.abortController.abort()
    if (entry.state == 'active') trackCleanup(entry.auth.destroy())
  }

  const disposeEntry = (requestId: string) => {
    const entry = entries.get(requestId)
    if (!entry) return false
    entries.delete(requestId)
    disposeDetachedEntry(entry)
    return true
  }

  const createLoginQr = async(
    requestId: string,
    startedAt: number,
  ): Promise<QQMusicLoginQr> => {
    assertRequestId(requestId)
    if (consumeTombstone(requestId)) {
      onDiagnostic({ stage: 'cancelled', elapsedMs: 0 })
      throw new Error(CREATE_ERROR)
    }

    const deadlineAt = startedAt + createDeadlineMs
    const abortController = new AbortController()
    const pendingEntry: PendingLoginEntry = {
      state: 'pending',
      requestId,
      startedAt,
      abortController,
      expiresAt: now() + ttlMs,
    }

    const previousEntries = [...entries.entries()]
    entries.set(requestId, pendingEntry)
    for (const [previousId, previousEntry] of previousEntries) {
      if (entries.get(previousId) === previousEntry) entries.delete(previousId)
      disposeDetachedEntry(previousEntry)
    }
    onDiagnostic({
      stage: 'session-registered',
      elapsedMs: Math.max(0, now() - startedAt),
    })
    if (now() >= deadlineAt) {
      disposeEntry(requestId)
      onDiagnostic({
        stage: 'timed-out',
        elapsedMs: Math.max(0, now() - startedAt),
      })
      throw new Error(CREATE_TIMEOUT_ERROR)
    }

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    let deadlineReached = false
    let rejectAbort: (error: Error) => void = () => {}
    const handleAbort = () => {
      rejectAbort(new Error(CREATE_ERROR))
    }
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject
      if (abortController.signal.aborted) {
        handleAbort()
        return
      }
      abortController.signal.addEventListener('abort', handleAbort, { once: true })
    })
    const deadlinePromise = new Promise<never>((_resolve, reject) => {
      const remainingMs = Math.max(0, deadlineAt - now())
      deadlineTimer = setTimer(() => {
        deadlineReached = true
        if (entries.get(requestId) === pendingEntry) disposeEntry(requestId)
        reject(new Error(CREATE_ERROR))
      }, remainingMs)
    })
    // The extra async adoption turn would expose cancellation before a same-turn late result is destroyed.
    // eslint-disable-next-line @typescript-eslint/promise-function-async
    const browserPromise = Promise.resolve().then(() => {
      if (now() >= deadlineAt) throw new Error(CREATE_TIMEOUT_ERROR)
      return createBrowserAuthSession({
        signal: abortController.signal,
        startedAt,
        deadlineAt,
        proxy: getProxy(),
        onDiagnostic,
      })
    }).then(auth => {
      if (now() >= deadlineAt) {
        trackCleanup(auth.destroy())
        throw new Error(CREATE_TIMEOUT_ERROR)
      }
      if (entries.get(requestId) !== pendingEntry ||
        abortController.signal.aborted) {
        trackCleanup(auth.destroy())
        throw new Error(CREATE_ERROR)
      }
      return auth
    })

    let auth: QQMusicBrowserAuthSession
    try {
      auth = await Promise.race([
        browserPromise,
        abortPromise,
        deadlinePromise,
      ])
    } catch {
      const wasCancelled = abortController.signal.aborted && !deadlineReached
      const timedOut = deadlineReached || now() >= deadlineAt
      if (entries.get(requestId) === pendingEntry) disposeEntry(requestId)
      if (timedOut) {
        onDiagnostic({
          stage: 'timed-out',
          elapsedMs: Math.max(0, now() - startedAt),
        })
      } else if (wasCancelled) {
        onDiagnostic({
          stage: 'cancelled',
          elapsedMs: Math.max(0, now() - startedAt),
        })
      } else {
        onDiagnostic({
          stage: 'browser-auth-error',
          reason: 'create-failed',
          elapsedMs: Math.max(0, now() - startedAt),
        })
      }
      throw new Error(timedOut ? CREATE_TIMEOUT_ERROR : CREATE_ERROR)
    } finally {
      if (deadlineTimer) clearTimer(deadlineTimer)
      abortController.signal.removeEventListener('abort', handleAbort)
    }

    if (now() >= deadlineAt) {
      if (entries.get(requestId) === pendingEntry) disposeEntry(requestId)
      else pendingEntry.abortController.abort()
      trackCleanup(auth.destroy())
      onDiagnostic({
        stage: 'timed-out',
        elapsedMs: Math.max(0, now() - startedAt),
      })
      throw new Error(CREATE_TIMEOUT_ERROR)
    }

    if (!auth.qrimg.startsWith('data:image/png;base64,')) {
      if (entries.get(requestId) === pendingEntry) entries.delete(requestId)
      disposeDetachedEntry({
        ...pendingEntry,
        state: 'active',
        auth,
        consecutiveCheckFailures: 0,
      })
      throw new Error(CREATE_ERROR)
    }

    if (entries.get(requestId) !== pendingEntry ||
      abortController.signal.aborted) {
      trackCleanup(auth.destroy())
      throw new Error(CREATE_ERROR)
    }

    entries.set(requestId, {
      ...pendingEntry,
      state: 'active',
      auth,
      consecutiveCheckFailures: 0,
    })
    return { key: requestId, qrimg: auth.qrimg }
  }

  const checkLoginQr = async(requestId: string): Promise<QQMusicInternalLoginCheck> => {
    const entry = entries.get(requestId)
    if (!entry || entry.state != 'active') return EXPIRED_RESULT
    if (entry.expiresAt <= now()) {
      disposeEntry(requestId)
      return EXPIRED_RESULT
    }

    let result: QQMusicInternalLoginCheck
    try {
      result = await entry.auth.check()
    } catch {
      if (entries.get(requestId) !== entry) return EXPIRED_RESULT
      disposeEntry(requestId)
      onDiagnostic({
        stage: 'browser-auth-error',
        reason: 'check-failed',
        elapsedMs: Math.max(0, now() - entry.startedAt),
      })
      throw new Error(CHECK_ERROR)
    }

    if (entries.get(requestId) !== entry) return EXPIRED_RESULT
    if (result.state == 'expired' || result.state == 'success') {
      disposeEntry(requestId)
    }
    return result
  }

  const cancelLoginQr = async(requestId: string): Promise<void> => {
    assertRequestId(requestId)
    const entry = entries.get(requestId)
    if (entry) {
      disposeEntry(requestId)
      onDiagnostic({
        stage: 'cancelled',
        elapsedMs: Math.max(0, now() - entry.startedAt),
      })
      return
    }
    addTombstone(requestId)
  }

  return {
    createLoginQr,
    checkLoginQr,
    cancelLoginQr,
  }
}
