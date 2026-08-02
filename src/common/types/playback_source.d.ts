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

    interface MusicUrlResult {
      type: LX.Quality
      url: string
      source: LX.Source
      persistentCache: boolean
    }
  }
}
