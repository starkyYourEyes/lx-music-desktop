import { createPlaybackSourceError, isPlaybackSourceError } from '@common/utils/playbackSourceError'
import type { PlaybackSourceAdapter } from './sourceAdapter'
import {
  observePlaybackCachePersistence,
  type PlaybackCachePersistenceFailure,
  type PlaybackUrlCache,
} from './cache'
import {
  selectPlaybackQuality,
  type LocalCandidateProvider,
  type OnlineCandidateProvider,
} from './candidates'

export type PlaybackUrlCandidate = LX.Playback.PlaybackUrlCandidate
export type PlaybackClock = LX.Playback.PlaybackClock
export type CandidateSettlement = LX.Playback.CandidateSettlement
export type PlaybackCancelReason = LX.Playback.PlaybackCancelReason
export type ForegroundCancelReason = LX.Playback.ForegroundCancelReason
export type PreloadCancelReason = LX.Playback.PreloadCancelReason
export type PlaybackResolveSession = LX.Playback.PlaybackResolveSession
export type SourceAttemptDiagnostic = LX.Playback.SourceAttemptDiagnostic

export interface CreatePlaybackResolveSessionOptions {
  musicInfo: LX.Music.MusicInfoOnline | LX.Music.MusicInfoLocal
  sourceIds: readonly string[]
  requestedQuality: LX.Quality
  cacheMode: 'lookup' | 'bypass'
  adapter: PlaybackSourceAdapter
  cache: PlaybackUrlCache
  candidateProvider: OnlineCandidateProvider | LocalCandidateProvider
  clock: PlaybackClock
  createId: () => string
  diagnostics: { record: (value: SourceAttemptDiagnostic) => void }
  reportPersistenceFailure: (value: PlaybackCachePersistenceFailure) => void
}

export type CreatePlaybackResolveSession = (
  options: CreatePlaybackResolveSessionOptions,
) => PlaybackResolveSession

const SOURCE_TIMEOUT = 10_000

class SourceAttempt {
  readonly startedAt: number
  readonly deadlineAt: number
  readonly controller = new AbortController()
  state: 'active' | 'expired' | 'completed' = 'active'
  candidateCursor = 0
  failures: LX.Playback.SourceFailureData[] = []
  matchedCandidates: LX.Music.MusicInfoOnline[] | null = null
  localBatchIndex = 0
  localBatchCursor = 0
  localBatchCandidates: LX.Music.MusicInfoOnline[] | null = null
  capabilities: LX.Playback.SourceCapabilities | null = null
  activeMusicInfo: LX.Music.MusicInfoOnline | null = null
  resolvedQuality: LX.Quality | undefined
  diagnosticRecorded = false

  constructor(
    readonly apiId: string,
    readonly sourceRank: number,
    clock: PlaybackClock,
  ) {
    this.startedAt = clock.now()
    this.deadlineAt = this.startedAt + SOURCE_TIMEOUT
  }

  remaining(clock: PlaybackClock) {
    return Math.max(0, this.deadlineAt - clock.now())
  }

  expire(): LX.Playback.SourceError | null {
    if (this.state != 'active') return null
    this.state = 'expired'
    return createPlaybackSourceError({
      message: 'Playback source attempt timed out',
      scope: 'source',
      kind: 'timeout',
      apiId: this.apiId,
    })
  }
}

const getSessionAbortFailure = (signal: AbortSignal): LX.Playback.SourceError => {
  if (isPlaybackSourceError(signal.reason) && signal.reason.scope == 'session') {
    return signal.reason
  }
  return createPlaybackSourceError({
    message: 'Playback resolution cancelled',
    scope: 'session',
    kind: 'cancelled',
  })
}

const throwIfSessionCancelled = (signal: AbortSignal) => {
  if (signal.aborted) throw getSessionAbortFailure(signal)
}

const createSessionCancellationWait = (signal: AbortSignal) => {
  let onAbort: (() => void) | null = null
  const promise = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(getSessionAbortFailure(signal))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose() {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    },
  }
}

const awaitWithinAttempt = async<T>(
  attempt: SourceAttempt,
  operation: (signal: AbortSignal) => Promise<T>,
  clock: PlaybackClock,
  sessionSignal: AbortSignal,
): Promise<T> => {
  throwIfSessionCancelled(sessionSignal)
  const remaining = attempt.remaining(clock)
  if (remaining <= 0) {
    const failure = attempt.expire() ?? createPlaybackSourceError({
      message: 'Playback source attempt timed out',
      scope: 'source',
      kind: 'timeout',
      apiId: attempt.apiId,
    })
    attempt.controller.abort(failure)
    throw failure
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const cancellation = createSessionCancellationWait(sessionSignal)
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = clock.setTimeout(() => {
        const failure = attempt.expire()
        if (!failure) return
        reject(failure)
        attempt.controller.abort(failure)
      }, remaining)
    })
    const getTimeoutFailure = () => attempt.expire() ?? createPlaybackSourceError({
      message: 'Playback source attempt timed out',
      scope: 'source',
      kind: 'timeout',
      apiId: attempt.apiId,
    })
    const throwTimeout = (): never => {
      const failure = getTimeoutFailure()
      if (!attempt.controller.signal.aborted) attempt.controller.abort(failure)
      throw failure
    }
    const running = Promise.resolve()
      .then(async() => operation(attempt.controller.signal))
      .then(
        value => {
          throwIfSessionCancelled(sessionSignal)
          if (attempt.state == 'active' && clock.now() < attempt.deadlineAt) return value
          return throwTimeout()
        },
        error => {
          throwIfSessionCancelled(sessionSignal)
          if (isPlaybackSourceError(error) && error.scope == 'session') throw error
          if (attempt.state == 'active' && clock.now() < attempt.deadlineAt) throw error
          return throwTimeout()
        },
      )
    return await Promise.race([running, deadline, cancellation.promise])
  } finally {
    if (timer) clock.clearTimeout(timer)
    cancellation.dispose()
  }
}

const isOnlineProvider = (
  provider: OnlineCandidateProvider | LocalCandidateProvider,
): provider is OnlineCandidateProvider => 'getOriginal' in provider

const normalizeFailure = (
  error: unknown,
  apiId: string,
  platform?: LX.OnlineSource,
): LX.Playback.SourceError => {
  if (isPlaybackSourceError(error)) return error
  const message = error instanceof Error ? error.message : 'Playback source request failed'
  return createPlaybackSourceError({
    message,
    scope: 'candidate',
    kind: 'request',
    apiId,
    platform,
    cause: error,
  })
}

const createSessionCancellation = (
  reason: PlaybackCancelReason,
): LX.Playback.SourceError => createPlaybackSourceError({
  message: `Playback resolution cancelled: ${reason}`,
  scope: 'session',
  kind: 'cancelled',
})

export const createPlaybackResolveSession: CreatePlaybackResolveSession = options => {
  const id = options.createId()
  const songIdentity = `${options.musicInfo.source}:${options.musicInfo.id}`
  const sourceIds = Object.freeze([...options.sourceIds])
  const attempts: SourceAttempt[] = []
  let sourceRank = 0
  let activeAttempt: SourceAttempt | null = null
  let activeCandidate: PlaybackUrlCandidate | null = null
  let resolving: Promise<PlaybackUrlCandidate> | null = null
  let cacheChecked = options.cacheMode == 'bypass'
  let state: 'active' | 'accepted' | 'cancelled' | 'failed' = 'active'
  let terminalFailure: LX.Playback.SourceError | null = null
  let released = false
  let pendingCommit: Promise<void> | null = null
  const sessionController = new AbortController()

  options.adapter.retainSources(sourceIds, id)

  const release = () => {
    if (released) return
    released = true
    options.adapter.releaseSources(sourceIds, id)
  }
  const abortAttempts = (reason: LX.Playback.SourceError) => {
    for (const attempt of attempts) {
      if (!attempt.controller.signal.aborted) attempt.controller.abort(reason)
    }
  }
  const finalize = (
    nextState: Exclude<typeof state, 'active'>,
    failure?: LX.Playback.SourceError,
  ) => {
    if (state != 'active') return false
    state = nextState
    if (failure) terminalFailure = failure
    if (failure?.scope == 'session' && !sessionController.signal.aborted) {
      sessionController.abort(failure)
    }
    release()
    if (failure) abortAttempts(failure)
    return true
  }
  const recordDiagnostic = (attempt: SourceAttempt, failure: LX.Playback.SourceFailureData) => {
    if (attempt.diagnosticRecorded || failure.scope == 'session') return
    attempt.diagnosticRecorded = true
    options.diagnostics.record({
      sessionId: id,
      songIdentity,
      apiId: attempt.apiId,
      sourceRank: attempt.sourceRank,
      ...(attempt.activeMusicInfo ? { platform: attempt.activeMusicInfo.source } : {}),
      requestedQuality: options.requestedQuality,
      ...(attempt.resolvedQuality ? { resolvedQuality: attempt.resolvedQuality } : {}),
      elapsedMs: options.clock.now() - attempt.startedAt,
      scope: failure.scope,
      kind: failure.kind,
    })
  }
  const observeDelete = (promiseFactory: () => Promise<void>) => {
    let deletion: Promise<void>
    try {
      deletion = promiseFactory()
    } catch (error) {
      deletion = Promise.reject(error)
    }
    void observePlaybackCachePersistence(
      deletion,
      'delete',
      value => {
        options.reportPersistenceFailure(value)
      },
    )
  }
  const expireActiveCandidate = (candidate: PlaybackUrlCandidate): CandidateSettlement => {
    activeCandidate = null
    if (candidate.origin == 'cache') {
      observeDelete(async() => options.cache.tombstoneKey(candidate.cacheKey))
      return 'expired'
    }
    const attempt = activeAttempt
    if (attempt) {
      const failure = attempt.expire() ?? createPlaybackSourceError({
        message: 'Playback source attempt timed out',
        scope: 'source',
        kind: 'timeout',
        apiId: attempt.apiId,
      })
      if (!attempt.controller.signal.aborted) attempt.controller.abort(failure)
      attempt.failures.push(failure)
      recordDiagnostic(attempt, failure)
      sourceRank = Math.max(sourceRank, attempt.sourceRank + 1)
      activeAttempt = null
    }
    return 'expired'
  }
  const getActiveCandidate = (candidateId: string) => {
    if (state != 'active' || activeCandidate?.candidateId != candidateId) return null
    return activeCandidate
  }
  const makeCandidate = (
    value: Omit<PlaybackUrlCandidate, 'sessionId' | 'candidateId' | 'songIdentity'>,
  ): PlaybackUrlCandidate => ({
    sessionId: id,
    candidateId: options.createId(),
    songIdentity,
    ...value,
  })

  const offerCache = async(): Promise<PlaybackUrlCandidate | null> => {
    if (cacheChecked) return null
    cacheChecked = true
    const lookupDeadlineAt = options.clock.now() + SOURCE_TIMEOUT
    let timer: ReturnType<typeof setTimeout> | null = null
    const cancellation = createSessionCancellationWait(sessionController.signal)
    try {
      const timeout = new Promise<null>(resolve => {
        timer = options.clock.setTimeout(() => {
          resolve(null)
        }, SOURCE_TIMEOUT)
      })
      const lookup = Promise.resolve()
        .then(async() => options.cache.lookup(options.musicInfo, options.requestedQuality))
        .then(
          hit => options.clock.now() < lookupDeadlineAt ? hit : null,
          () => null,
        )
      const hit = await Promise.race([lookup, timeout, cancellation.promise])
      throwIfSessionCancelled(sessionController.signal)
      if (!hit) return null
      return makeCandidate({
        origin: 'cache',
        quality: hit.quality,
        url: hit.url,
        cacheKey: hit.key,
        deadlineAt: options.clock.now() + SOURCE_TIMEOUT,
      })
    } finally {
      if (timer) options.clock.clearTimeout(timer)
      cancellation.dispose()
    }
  }

  const getSupportedPlatforms = (attempt: SourceAttempt) => {
    const supported = new Set<LX.OnlineSource>()
    for (const [platform, capability] of Object.entries(attempt.capabilities?.sources ?? {})) {
      if (platform != 'local' && capability?.actions.includes('musicUrl')) {
        supported.add(platform as LX.OnlineSource)
      }
    }
    return supported
  }

  const getNextOnlineCandidate = async(
    attempt: SourceAttempt,
    provider: OnlineCandidateProvider,
  ): Promise<LX.Music.MusicInfoOnline | null> => {
    if (attempt.candidateCursor == 0) {
      attempt.candidateCursor++
      return provider.getOriginal()
    }
    if (!attempt.matchedCandidates) {
      const supported = getSupportedPlatforms(attempt)
      attempt.matchedCandidates = await awaitWithinAttempt(
        attempt,
        async() => provider.getMatched(supported),
        options.clock,
        sessionController.signal,
      )
    }
    const candidate = attempt.matchedCandidates[attempt.candidateCursor - 1]
    if (!candidate) return null
    attempt.candidateCursor++
    return candidate
  }

  const getNextLocalCandidate = async(
    attempt: SourceAttempt,
    provider: LocalCandidateProvider,
  ): Promise<LX.Music.MusicInfoOnline | null> => {
    const supported = getSupportedPlatforms(attempt)
    while (attempt.localBatchIndex < provider.batchCount) {
      if (!attempt.localBatchCandidates) {
        const batch = await awaitWithinAttempt(
          attempt,
          async() => provider.getBatch(attempt.localBatchIndex),
          options.clock,
          sessionController.signal,
        )
        attempt.localBatchCandidates = batch.filter(candidate => supported.has(candidate.source))
        attempt.localBatchCursor = 0
      }
      const candidate = attempt.localBatchCandidates[attempt.localBatchCursor++]
      if (candidate) {
        attempt.candidateCursor++
        return candidate
      }
      attempt.localBatchIndex++
      attempt.localBatchCandidates = null
    }
    return null
  }

  const failAttempt = (attempt: SourceAttempt, failure: LX.Playback.SourceError) => {
    attempt.failures.push(failure)
    if (attempt.state == 'active') attempt.state = 'completed'
    if (!attempt.controller.signal.aborted) attempt.controller.abort(failure)
    recordDiagnostic(attempt, failure)
    sourceRank = attempt.sourceRank + 1
    activeAttempt = null
  }

  const requestFromAttempt = async(
    attempt: SourceAttempt,
  ): Promise<PlaybackUrlCandidate | null> => {
    try {
      if (!attempt.capabilities) {
        attempt.capabilities = await awaitWithinAttempt(
          attempt,
          async signal => options.adapter.getCapabilities(attempt.apiId, signal),
          options.clock,
          sessionController.signal,
        )
      }

      if (!isOnlineProvider(options.candidateProvider) && attempt.candidateCursor == 0) {
        attempt.candidateCursor++
        const localCapability = attempt.capabilities.sources.local
        if (localCapability?.actions.includes('musicUrl')) {
          try {
            const resolved = await awaitWithinAttempt(
              attempt,
              async signal => options.adapter.getLocalMusicUrl({
                apiId: attempt.apiId,
                requestId: `${id}:${attempt.sourceRank}:local`,
                musicInfo: options.musicInfo as LX.Music.MusicInfoLocal,
                signal,
              }),
              options.clock,
              sessionController.signal,
            )
            attempt.resolvedQuality = resolved.quality
            return makeCandidate({
              origin: 'source',
              apiId: attempt.apiId,
              quality: resolved.quality,
              url: resolved.url,
              cacheKey: `${options.musicInfo.id}_${resolved.quality}`,
              deadlineAt: attempt.deadlineAt,
            })
          } catch (error) {
            const failure = normalizeFailure(error, attempt.apiId)
            if (failure.scope != 'candidate') throw failure
            attempt.failures.push(failure)
          }
        }
      }

      const provider = options.candidateProvider
      while (true) {
        const musicInfo = isOnlineProvider(provider)
          ? await getNextOnlineCandidate(attempt, provider)
          : await getNextLocalCandidate(attempt, provider)
        if (!musicInfo) break
        const capability = attempt.capabilities.sources[musicInfo.source]
        if (!capability?.actions.includes('musicUrl')) continue
        const quality = selectPlaybackQuality(
          options.requestedQuality,
          musicInfo,
          capability.qualitys,
        )
        if (!quality) continue
        attempt.activeMusicInfo = musicInfo
        attempt.resolvedQuality = quality
        try {
          const resolved = await awaitWithinAttempt(
            attempt,
            async signal => options.adapter.getMusicUrl({
              apiId: attempt.apiId,
              requestId: `${id}:${attempt.sourceRank}:${attempt.candidateCursor}`,
              musicInfo,
              quality,
              signal,
            }),
            options.clock,
            sessionController.signal,
          )
          attempt.resolvedQuality = resolved.quality
          return makeCandidate({
            origin: 'source',
            apiId: attempt.apiId,
            platform: musicInfo.source,
            quality: resolved.quality,
            url: resolved.url,
            cacheKey: `${options.musicInfo.id}_${resolved.quality}`,
            deadlineAt: attempt.deadlineAt,
          })
        } catch (error) {
          const failure = normalizeFailure(error, attempt.apiId, musicInfo.source)
          if (failure.scope != 'candidate') throw failure
          attempt.failures.push(failure)
        }
      }
      const failure = attempt.failures.at(-1) ?? createPlaybackSourceError({
        message: 'Playback source has no supported candidates',
        scope: 'source',
        kind: 'unsupported',
        apiId: attempt.apiId,
      })
      failAttempt(attempt, failure)
      return null
    } catch (error) {
      const failure = normalizeFailure(error, attempt.apiId, attempt.activeMusicInfo?.source)
      if (failure.scope == 'session') throw failure
      failAttempt(attempt, failure)
      return null
    }
  }

  const resolveNext = async(): Promise<PlaybackUrlCandidate> => {
    if (state != 'active') throw terminalFailure ?? createSessionCancellation('stop')
    if (!cacheChecked) {
      const cached = await offerCache()
      if (state != 'active') throw terminalFailure ?? createSessionCancellation('stop')
      if (cached) {
        activeCandidate = cached
        return cached
      }
    }
    while (sourceRank < sourceIds.length) {
      if (state != 'active') throw terminalFailure ?? createSessionCancellation('stop')
      const attempt = activeAttempt ?? new SourceAttempt(
        sourceIds[sourceRank],
        sourceRank,
        options.clock,
      )
      if (!activeAttempt) {
        activeAttempt = attempt
        attempts.push(attempt)
      }
      const candidate = await requestFromAttempt(attempt)
      if (state != 'active') throw terminalFailure ?? createSessionCancellation('stop')
      if (candidate) {
        activeCandidate = candidate
        return candidate
      }
    }
    const failure = createPlaybackSourceError({
      message: 'Playback resolution exhausted all configured sources',
      scope: 'session',
      kind: 'request',
      cause: attempts.flatMap(attempt => attempt.failures),
    })
    finalize('failed', failure)
    throw failure
  }

  const session: PlaybackResolveSession = {
    id,
    songIdentity,
    sourceIds,
    async nextCandidate() {
      if (activeCandidate) return Promise.resolve(activeCandidate)
      if (resolving) return resolving
      const promise = resolveNext()
      resolving = promise
      void promise.then(
        () => { if (resolving == promise) resolving = null },
        () => { if (resolving == promise) resolving = null },
      )
      return promise
    },
    accept(candidateId) {
      const candidate = getActiveCandidate(candidateId)
      if (!candidate) return 'stale'
      if (options.clock.now() >= candidate.deadlineAt) return expireActiveCandidate(candidate)
      activeCandidate = null
      finalize('accepted')
      const accepted = createPlaybackSourceError({
        message: 'Playback candidate accepted',
        scope: 'session',
        kind: 'cancelled',
      })
      abortAttempts(accepted)
      let committing: Promise<void>
      try {
        committing = options.cache.commit(options.musicInfo, candidate.quality, candidate.url)
      } catch (error) {
        committing = Promise.reject(error)
      }
      const commitPromise = observePlaybackCachePersistence(
        committing,
        'commit',
        value => {
          options.reportPersistenceFailure(value)
        },
      )
      pendingCommit = commitPromise
      void commitPromise.then(() => {
        if (pendingCommit == commitPromise) pendingCommit = null
      })
      return 'accepted'
    },
    rejectMedia(candidateId, failureData) {
      const candidate = getActiveCandidate(candidateId)
      if (!candidate) return 'stale'
      if (options.clock.now() >= candidate.deadlineAt) return expireActiveCandidate(candidate)
      activeCandidate = null
      if (candidate.origin == 'cache') {
        observeDelete(async() => options.cache.tombstoneKey(candidate.cacheKey))
        return 'resumed'
      }
      const attempt = activeAttempt
      if (attempt) {
        const suppliedMessage = typeof failureData?.message == 'string'
          ? failureData.message.split(/\r?\n/, 1)[0].substring(0, 1024)
          : ''
        const failure = createPlaybackSourceError({
          message: suppliedMessage || 'Playback candidate failed media validation',
          scope: 'candidate',
          kind: 'mediaValidation',
          apiId: attempt.apiId,
          platform: candidate.platform,
        })
        attempt.failures.push(failure)
      }
      return 'resumed'
    },
    expireCandidate(candidateId) {
      const candidate = getActiveCandidate(candidateId)
      if (!candidate) return 'stale'
      return expireActiveCandidate(candidate)
    },
    cancel(reason) {
      const failure = createSessionCancellation(reason)
      if (!finalize('cancelled', failure)) return
      activeCandidate = null
    },
  }
  return session
}
