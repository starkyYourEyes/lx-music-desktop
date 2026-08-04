declare namespace LX {
  namespace Playback {
    type SourceFailureScope = 'candidate' | 'source' | 'session'
    type SourceFailureKind =
      | 'unsupported' | 'emptyUrl' | 'request' | 'initialization'
      | 'runtimeCrash' | 'rateLimit' | 'serverBusy' | 'sourceChanged'
      | 'timeout' | 'cancelled' | 'mediaValidation'
    type ResolvePolicy = 'fallback' | 'primaryOnly'
    type ResolveReason = 'initial' | 'forceRefresh' | 'postCommitError' | 'preload'

    interface SourceFailureData {
      name: 'PlaybackSourceError'
      message: string
      scope: SourceFailureScope
      kind: SourceFailureKind
      apiId?: string
      platform?: LX.OnlineSource
      statusCode?: number
    }

    type SourceError = Error & SourceFailureData & { cause?: unknown }

    interface SourceCapabilities {
      sources: Partial<Record<LX.OnlineSource | 'local', {
        actions: LX.UserApi.UserApiSourceInfoActions[]
        qualitys: LX.Quality[]
      }>>
    }

    interface PlaybackUrlCandidate {
      sessionId: string
      candidateId: string
      songIdentity: string
      origin: 'cache' | 'source'
      apiId?: string
      platform?: LX.OnlineSource
      quality: LX.Quality
      url: string
      cacheKey?: LX.Music.AuthorizedMusicUrlKeyV1
      deadlineAt: number
    }

    interface PlaybackClock {
      now: () => number
      setTimeout: (handler: () => void, delay: number) => ReturnType<typeof setTimeout>
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => void
    }

    type CandidateSettlement = 'accepted' | 'resumed' | 'expired' | 'stale'
    type PlaybackCancelReason =
      | 'songChanged' | 'stop' | 'forceRefresh' | 'preloadReplaced' | 'shutdown'
    type ForegroundCancelReason = Exclude<PlaybackCancelReason, 'preloadReplaced' | 'shutdown'>
    type PreloadCancelReason = Exclude<PlaybackCancelReason, 'shutdown'>

    interface PlaybackResolveSession {
      readonly id: string
      readonly songIdentity: string
      readonly sourceIds: readonly string[]
      nextCandidate: () => Promise<PlaybackUrlCandidate>
      accept: (candidateId: string) => CandidateSettlement
      rejectMedia: (candidateId: string, failure?: SourceFailureData) => CandidateSettlement
      expireCandidate: (candidateId: string) => CandidateSettlement
      cancel: (reason: PlaybackCancelReason) => void
    }

    interface SourceAttemptDiagnostic {
      sessionId: string
      songIdentity: string
      apiId: string
      sourceRank: number
      platform?: LX.OnlineSource
      requestedQuality: LX.Quality
      resolvedQuality?: LX.Quality
      elapsedMs: number
      scope: SourceFailureScope
      kind: SourceFailureKind
    }

    interface MusicUrlResult {
      type: LX.Quality
      url: string
      source: LX.Source
      persistentCache: boolean
    }
  }
}
