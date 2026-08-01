import type {
  ForegroundCancelReason,
  PlaybackCancelReason,
  PlaybackClock,
  PlaybackResolveSession,
  PreloadCancelReason,
} from './session'

export const getPlaybackSongIdentity = (
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem,
): string => {
  const target = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
  return `${target.source}:${target.id}`
}

export interface DirectPlaybackResource {
  kind: 'direct'
  songIdentity: string
  url: string
}

export interface CandidatePlaybackResource {
  kind: 'candidate'
  songIdentity: string
  url: string
  sessionId: string
  candidateId: string
  origin: 'cache' | 'source'
  apiId?: string
  quality: LX.Quality
  cacheKey: string
  deadlineAt: number
}

export interface ValidatedPlaybackResource {
  kind: 'validated'
  songIdentity: string
  url: string
  origin: 'direct' | 'cache' | 'source'
  apiId?: string
  quality?: LX.Quality
  cacheKey?: string
}

export type PlaybackRequestResult =
  | { kind: 'direct', resource: DirectPlaybackResource }
  | { kind: 'session', session: PlaybackResolveSession }

export type CreatePlaybackRequest = (input: {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  reason: LX.Playback.ResolveReason
}) => Promise<PlaybackRequestResult>

// The public contract is intentionally a type alias for Task 11's facade.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type ForegroundPlaybackRequestInput = {
  musicInfo: LX.Music.MusicInfo | LX.Download.ListItem
  reason: Exclude<LX.Playback.ResolveReason, 'preload'>
}

export const cancelReasonForResolveReason = (
  reason: ForegroundPlaybackRequestInput['reason'],
): ForegroundCancelReason => reason == 'initial' ? 'songChanged' : 'forceRefresh'

export interface PlaybackResolutionCoordinatorDependencies {
  createRequest: CreatePlaybackRequest
  createPreloadAudio: () => HTMLAudioElement
  detachForegroundResource: (resource: CandidatePlaybackResource) => void
  clock: PlaybackClock
}

export type PlaybackResource =
  | DirectPlaybackResource
  | CandidatePlaybackResource
  | ValidatedPlaybackResource

export type ForegroundCanplayResult =
  | { status: 'accepted', resource: ValidatedPlaybackResource }
  | { status: 'expired' | 'stale' }

export interface ForegroundResolutionHandlers {
  resource: (resource: CandidatePlaybackResource) => void
  failure: (input: { songIdentity: string, error: LX.Playback.SourceError }) => void
}

export interface PlaybackResolutionCoordinator {
  startForeground: (input: ForegroundPlaybackRequestInput) => Promise<PlaybackResource>
  startPreload: (musicInfo: LX.Music.MusicInfo | LX.Download.ListItem) => Promise<PlaybackResource>
  promotePreload: (songIdentity: string) => Promise<PlaybackResource | null>
  setForegroundHandlers: (handlers: ForegroundResolutionHandlers) => void
  handleForegroundCanplay: (resource: CandidatePlaybackResource) => ForegroundCanplayResult
  handleForegroundError: (resource: CandidatePlaybackResource) => 'resumed' | 'expired' | 'stale'
  isForegroundValidating: () => boolean
  cancelForeground: (reason: ForegroundCancelReason) => void
  cancelPreload: (reason: PreloadCancelReason) => void
  dispose: () => void
}

interface ActiveResolution {
  identity: string
  owner: 'foreground' | 'preload'
  phase: 'resolving' | 'validating' | 'validated' | 'closed'
  session: PlaybackResolveSession | null
  resource: DirectPlaybackResource | CandidatePlaybackResource | null
  pendingResource: Promise<DirectPlaybackResource | CandidatePlaybackResource> | null
  validated: ValidatedPlaybackResource | null
  validationTimer: ReturnType<typeof setTimeout> | null
  preloadAudio: HTMLAudioElement | null
  cancelReason: PlaybackCancelReason | null
}

interface PreloadBinding {
  record: ActiveResolution
  resource: DirectPlaybackResource | CandidatePlaybackResource
  handleError: () => 'resumed' | 'expired' | 'stale'
  handleCanplay: () => 'accepted' | 'expired' | 'stale'
}

interface PendingOptions {
  publishForeground: boolean
}

const createCancellationError = (): LX.Playback.SourceError => Object.assign(
  new Error('Playback resolution cancelled'),
  { name: 'PlaybackSourceError' as const, scope: 'session' as const, kind: 'cancelled' as const },
)

const normalizeSourceError = (error: unknown): LX.Playback.SourceError => {
  if (
    error instanceof Error &&
    error.name == 'PlaybackSourceError' &&
    'scope' in error &&
    'kind' in error
  ) return error as LX.Playback.SourceError
  return Object.assign(
    new Error('Playback resolution failed'),
    { name: 'PlaybackSourceError' as const, scope: 'session' as const, kind: 'request' as const },
  )
}

const isCancellationError = (error: unknown) => (
  error instanceof Error &&
  error.name == 'PlaybackSourceError' &&
  'scope' in error && error.scope == 'session' &&
  'kind' in error && error.kind == 'cancelled'
)

const isResolutionClosed = (record: ActiveResolution) => record.phase == 'closed'

const toCandidateResource = (
  candidate: LX.Playback.PlaybackUrlCandidate,
): CandidatePlaybackResource => ({
  kind: 'candidate',
  songIdentity: candidate.songIdentity,
  url: candidate.url,
  sessionId: candidate.sessionId,
  candidateId: candidate.candidateId,
  origin: candidate.origin,
  ...(candidate.apiId ? { apiId: candidate.apiId } : {}),
  quality: candidate.quality,
  cacheKey: candidate.cacheKey,
  deadlineAt: candidate.deadlineAt,
})

const toValidatedCandidate = (
  resource: CandidatePlaybackResource,
): ValidatedPlaybackResource => ({
  kind: 'validated',
  songIdentity: resource.songIdentity,
  url: resource.url,
  origin: resource.origin,
  ...(resource.apiId ? { apiId: resource.apiId } : {}),
  quality: resource.quality,
  cacheKey: resource.cacheKey,
})

export type CreatePlaybackResolutionCoordinator = (
  deps: PlaybackResolutionCoordinatorDependencies,
) => PlaybackResolutionCoordinator

export const createPlaybackResolutionCoordinator: CreatePlaybackResolutionCoordinator = deps => {
  let foreground: ActiveResolution | null = null
  let preload: ActiveResolution | null = null
  let foregroundHandlers: ForegroundResolutionHandlers | null = null
  let preloadBinding: PreloadBinding | null = null
  let disposed = false
  const preloadAudio = deps.createPreloadAudio()
  preloadAudio.muted = true

  const isCurrent = (record: ActiveResolution) => (
    record.owner == 'foreground' ? foreground == record : preload == record
  )
  const clearValidationTimer = (record: ActiveResolution) => {
    if (!record.validationTimer) return
    deps.clock.clearTimeout(record.validationTimer)
    record.validationTimer = null
  }
  const detachPreloadValidator = (record: ActiveResolution) => {
    const binding = preloadBinding
    clearValidationTimer(record)
    if (!binding || binding.record != record) return
    preloadAudio.removeEventListener('error', binding.handleError)
    preloadAudio.removeEventListener('canplay', binding.handleCanplay)
    preloadAudio.pause()
    preloadAudio.removeAttribute('src')
    preloadAudio.load()
    preloadBinding = null
    record.preloadAudio = null
  }
  const removeFromSlot = (record: ActiveResolution) => {
    if (foreground == record) foreground = null
    if (preload == record) preload = null
  }
  const closeRecord = (
    record: ActiveResolution,
    reason: PlaybackCancelReason | null,
    cancelSession: boolean,
  ) => {
    if (record.phase == 'closed') return
    const foregroundCandidate = record.owner == 'foreground' &&
      record.phase == 'validating' &&
      record.resource?.kind == 'candidate'
      ? record.resource
      : null
    if (reason) record.cancelReason = reason
    record.phase = 'closed'
    record.resource = null
    record.validated = null
    if (record.owner == 'preload') {
      detachPreloadValidator(record)
    } else if (foregroundCandidate) {
      clearValidationTimer(record)
      deps.detachForegroundResource(foregroundCandidate)
    } else {
      clearValidationTimer(record)
    }
    removeFromSlot(record)
    if (cancelSession && reason && record.session) record.session.cancel(reason)
  }
  const closeExhausted = (record: ActiveResolution) => {
    closeRecord(record, null, false)
  }
  const createRecord = (
    identity: string,
    owner: ActiveResolution['owner'],
  ): ActiveResolution => ({
    identity,
    owner,
    phase: 'resolving',
    session: null,
    resource: null,
    pendingResource: null,
    validated: null,
    validationTimer: null,
    preloadAudio: owner == 'preload' ? preloadAudio : null,
    cancelReason: null,
  })
  const matchesCandidate = (
    record: ActiveResolution,
    resource: CandidatePlaybackResource,
  ) => {
    const active = record.resource
    return active?.kind == 'candidate' &&
      record.phase == 'validating' &&
      active.sessionId == resource.sessionId &&
      active.candidateId == resource.candidateId &&
      active.songIdentity == resource.songIdentity &&
      active.url == resource.url
  }

  let advanceForeground: (record: ActiveResolution) => void
  let beginPendingCandidate: (
    record: ActiveResolution,
    operation: () => Promise<DirectPlaybackResource | CandidatePlaybackResource>,
    options: PendingOptions,
  ) => Promise<DirectPlaybackResource | CandidatePlaybackResource>

  const leaveForegroundCandidate = (
    record: ActiveResolution,
    resource: CandidatePlaybackResource,
  ) => {
    record.phase = 'resolving'
    record.resource = null
    clearValidationTimer(record)
    deps.detachForegroundResource(resource)
  }
  const settleForegroundTimeout = (
    record: ActiveResolution,
    resource: CandidatePlaybackResource,
  ): 'expired' | 'stale' => {
    if (foreground != record || !matchesCandidate(record, resource) || !record.session) return 'stale'
    leaveForegroundCandidate(record, resource)
    const settlement = record.session.expireCandidate(resource.candidateId)
    if (settlement == 'expired') advanceForeground(record)
    return settlement == 'expired' ? 'expired' : 'stale'
  }
  const bindForegroundCandidate = (
    record: ActiveResolution,
    resource: CandidatePlaybackResource,
  ) => {
    clearValidationTimer(record)
    const remaining = Math.max(0, resource.deadlineAt - deps.clock.now())
    record.validationTimer = deps.clock.setTimeout(() => {
      settleForegroundTimeout(record, resource)
    }, remaining)
  }

  const preloadCanplay = (
    binding: PreloadBinding,
  ): 'accepted' | 'expired' | 'stale' => {
    const { record, resource } = binding
    if (preloadBinding != binding || preload != record || record.owner != 'preload') return 'stale'
    detachPreloadValidator(record)
    if (resource.kind == 'direct') {
      if (record.phase != 'validating' || record.resource != resource) return 'stale'
      record.validated = {
        kind: 'validated',
        origin: 'direct',
        songIdentity: resource.songIdentity,
        url: resource.url,
      }
      record.phase = 'validated'
      return 'accepted'
    }
    if (!matchesCandidate(record, resource) || !record.session) return 'stale'
    if (deps.clock.now() >= resource.deadlineAt) {
      record.phase = 'resolving'
      record.resource = null
      const settlement = record.session.expireCandidate(resource.candidateId)
      if (settlement == 'expired') {
        void beginPendingCandidate(
          record,
          async() => toCandidateResource(await record.session!.nextCandidate()),
          { publishForeground: false },
        ).catch(() => {})
        return 'expired'
      }
      return 'stale'
    }
    const settlement = record.session.accept(resource.candidateId)
    if (settlement != 'accepted') return settlement == 'expired' ? 'expired' : 'stale'
    record.validated = toValidatedCandidate(resource)
    record.phase = 'validated'
    return 'accepted'
  }
  const preloadError = (
    binding: PreloadBinding,
  ): 'resumed' | 'expired' | 'stale' => {
    const { record, resource } = binding
    if (preloadBinding != binding || preload != record || record.owner != 'preload') return 'stale'
    detachPreloadValidator(record)
    if (record.phase != 'validating' || record.resource != resource) return 'stale'
    record.phase = 'resolving'
    record.resource = null
    if (resource.kind == 'direct') {
      closeExhausted(record)
      return 'resumed'
    }
    if (!record.session) return 'stale'
    const settlement = deps.clock.now() >= resource.deadlineAt
      ? record.session.expireCandidate(resource.candidateId)
      : record.session.rejectMedia(resource.candidateId)
    if (settlement == 'resumed' || settlement == 'expired') {
      void beginPendingCandidate(
        record,
        async() => toCandidateResource(await record.session!.nextCandidate()),
        { publishForeground: false },
      ).catch(() => {})
      return settlement
    }
    return 'stale'
  }
  const bindPreloadResource = (
    record: ActiveResolution,
    resource: DirectPlaybackResource | CandidatePlaybackResource,
  ) => {
    detachPreloadValidator(record)
    record.preloadAudio = preloadAudio
    const binding: PreloadBinding = {
      record,
      resource,
      handleError: () => preloadError(binding),
      handleCanplay: () => preloadCanplay(binding),
    }
    preloadBinding = binding
    preloadAudio.addEventListener('error', binding.handleError)
    preloadAudio.addEventListener('canplay', binding.handleCanplay)
    if (resource.kind == 'candidate') {
      const remaining = Math.max(0, resource.deadlineAt - deps.clock.now())
      record.validationTimer = deps.clock.setTimeout(() => {
        if (preloadBinding != binding) return
        detachPreloadValidator(record)
        if (preload != record || record.phase != 'validating' || record.resource != resource || !record.session) return
        record.phase = 'resolving'
        record.resource = null
        const settlement = record.session.expireCandidate(resource.candidateId)
        if (settlement == 'expired') {
          void beginPendingCandidate(
            record,
            async() => toCandidateResource(await record.session!.nextCandidate()),
            { publishForeground: false },
          ).catch(() => {})
        }
      }, remaining)
    }
    preloadAudio.src = resource.url
    preloadAudio.load()
  }

  const installResolvedResource = (
    record: ActiveResolution,
    resource: DirectPlaybackResource | CandidatePlaybackResource,
  ) => {
    if (record.phase == 'closed' || !isCurrent(record)) return false
    record.pendingResource = null
    record.resource = resource
    record.phase = 'validating'
    if (record.owner == 'preload') bindPreloadResource(record, resource)
    else if (resource.kind == 'candidate') bindForegroundCandidate(record, resource)
    return true
  }
  const handlePendingFailure = (
    record: ActiveResolution,
    error: unknown,
    options: PendingOptions,
  ) => {
    if (record.phase == 'closed' || !isCurrent(record)) return
    const sourceError = normalizeSourceError(error)
    closeExhausted(record)
    if (
      options.publishForeground &&
      record.owner == 'foreground' &&
      !isCancellationError(sourceError)
    ) {
      foregroundHandlers?.failure({ songIdentity: record.identity, error: sourceError })
    }
  }
  // Preserve the exact operation promise so preload promotion cannot fork pending work.
  // eslint-disable-next-line @typescript-eslint/promise-function-async
  beginPendingCandidate = (record, operation, options) => {
    record.phase = 'resolving'
    record.resource = null
    record.validated = null
    const pending = operation()
    record.pendingResource = pending
    void pending.then(
      resource => {
        if (record.pendingResource != pending) return
        if (!installResolvedResource(record, resource)) return
        if (
          options.publishForeground &&
          record.owner == 'foreground' &&
          resource.kind == 'candidate'
        ) foregroundHandlers?.resource(resource)
      },
      error => {
        if (record.pendingResource != pending) return
        record.pendingResource = null
        handlePendingFailure(record, error, options)
      },
    )
    return pending
  }
  advanceForeground = record => {
    if (foreground != record || record.owner != 'foreground' || record.phase == 'closed' || !record.session) return
    void beginPendingCandidate(
      record,
      async() => toCandidateResource(await record.session!.nextCandidate()),
      { publishForeground: true },
    ).catch(() => {})
  }

  const resolveInitial = async(
    record: ActiveResolution,
    input: { musicInfo: LX.Music.MusicInfo | LX.Download.ListItem, reason: LX.Playback.ResolveReason },
  ): Promise<DirectPlaybackResource | CandidatePlaybackResource> => {
    const result = await deps.createRequest(input)
    if (record.phase == 'closed') {
      if (result.kind == 'session') result.session.cancel(record.cancelReason!)
      throw createCancellationError()
    }
    if (result.kind == 'direct') return result.resource
    record.session = result.session
    try {
      return toCandidateResource(await result.session.nextCandidate())
    } catch (error) {
      if (isResolutionClosed(record)) throw createCancellationError()
      throw error
    }
  }

  const promotePreload = async(songIdentity: string): Promise<PlaybackResource | null> => {
    const record = preload
    if (!record || record.identity != songIdentity || record.phase == 'closed') return null
    if (record.phase == 'validated') {
      const validated = record.validated
      if (!validated) return null
      preload = null
      record.owner = 'foreground'
      foreground = record
      return validated
    }
    if (record.phase == 'resolving') {
      const pending = record.pendingResource
      if (!pending) return null
      detachPreloadValidator(record)
      preload = null
      record.owner = 'foreground'
      foreground = record
      return pending
    }
    const resource = record.resource
    if (!resource) return null
    detachPreloadValidator(record)
    preload = null
    if (resource.kind == 'direct') {
      record.phase = 'closed'
      record.resource = null
      return resource
    }
    record.owner = 'foreground'
    foreground = record
    bindForegroundCandidate(record, resource)
    return resource
  }

  const startForeground = async(
    input: ForegroundPlaybackRequestInput,
  ): Promise<PlaybackResource> => {
    if (!foregroundHandlers) throw new Error('Foreground playback handlers must be registered before starting')
    if (disposed) throw createCancellationError()
    const identity = getPlaybackSongIdentity(input.musicInfo)
    const cancelReason = cancelReasonForResolveReason(input.reason)
    if (input.reason != 'initial' && preload?.identity == identity) {
      closeRecord(preload, cancelReason, true)
    }
    if (input.reason == 'initial' && preload?.identity == identity) {
      if (foreground) closeRecord(foreground, cancelReason, true)
      const promoted = await promotePreload(identity)
      if (promoted) return promoted
    }
    if (foreground) closeRecord(foreground, cancelReason, true)
    const record = createRecord(identity, 'foreground')
    foreground = record
    return beginPendingCandidate(
      record,
      async() => resolveInitial(record, input),
      { publishForeground: false },
    )
  }

  const startPreload = async(
    musicInfo: LX.Music.MusicInfo | LX.Download.ListItem,
  ): Promise<PlaybackResource> => {
    if (disposed) throw createCancellationError()
    if (preload) closeRecord(preload, 'preloadReplaced', true)
    const record = createRecord(getPlaybackSongIdentity(musicInfo), 'preload')
    preload = record
    return beginPendingCandidate(
      record,
      async() => resolveInitial(record, { musicInfo, reason: 'preload' }),
      { publishForeground: false },
    )
  }

  return {
    startForeground,
    startPreload,
    promotePreload,
    setForegroundHandlers(handlers) {
      foregroundHandlers = handlers
    },
    handleForegroundCanplay(resource) {
      const record = foreground
      if (!record || !matchesCandidate(record, resource) || !record.session) return { status: 'stale' }
      if (deps.clock.now() >= resource.deadlineAt) {
        settleForegroundTimeout(record, resource)
        return { status: 'expired' }
      }
      clearValidationTimer(record)
      const settlement = record.session.accept(resource.candidateId)
      if (settlement == 'expired') {
        leaveForegroundCandidate(record, resource)
        advanceForeground(record)
        return { status: 'expired' }
      }
      if (settlement != 'accepted') return { status: 'stale' }
      const validated = toValidatedCandidate(resource)
      record.validated = validated
      record.phase = 'validated'
      return { status: 'accepted', resource: validated }
    },
    handleForegroundError(resource) {
      const record = foreground
      if (!record || !matchesCandidate(record, resource) || !record.session) return 'stale'
      if (deps.clock.now() >= resource.deadlineAt) return settleForegroundTimeout(record, resource)
      leaveForegroundCandidate(record, resource)
      const settlement = record.session.rejectMedia(resource.candidateId)
      if (settlement == 'resumed' || settlement == 'expired') {
        advanceForeground(record)
        return settlement
      }
      return 'stale'
    },
    isForegroundValidating() {
      return foreground?.phase == 'validating' && foreground.resource?.kind == 'candidate'
    },
    cancelForeground(reason) {
      if (foreground) closeRecord(foreground, reason, true)
    },
    cancelPreload(reason) {
      if (preload) closeRecord(preload, reason, true)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (foreground) closeRecord(foreground, 'shutdown', true)
      if (preload) closeRecord(preload, 'shutdown', true)
    },
  }
}
