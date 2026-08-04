import { QUALITYS } from '@common/constants'
import type { AuthorizedMusicUrlKeyV1 } from '@common/storage/cache'
import { createPlaybackSourceError, isPlaybackSourceError, toPlaybackSourceError } from '@common/utils/playbackSourceError'
import {
  acquireUserApiRuntime,
  ensureUserApi,
  releaseUserApiRuntime,
  sendUserApiRequest,
  userApiRequestCancel,
} from '@renderer/utils/ipc'
import { requestMsg } from '@renderer/utils/message'
import { getApiById, supportQuality } from '@renderer/utils/musicSdk/api-source'
import { getMusicUrlCacheKey } from '../utils'

export interface PlaybackSourceAdapter {
  retainSources: (apiIds: readonly string[], sessionId: string) => void
  releaseSources: (apiIds: readonly string[], sessionId: string) => void
  getCapabilities: (apiId: string, signal: AbortSignal) => Promise<LX.Playback.SourceCapabilities>
  authorizeMusicUrl: (request: {
    apiId: string
    musicInfo: LX.Music.MusicInfoOnline
    quality: LX.Quality
    signal: AbortSignal
  }) => Promise<AuthorizedMusicUrlKeyV1 | null>
  getMusicUrl: (request: {
    apiId: string
    requestId: string
    musicInfo: LX.Music.MusicInfoOnline
    quality: LX.Quality
    signal: AbortSignal
  }) => Promise<{ url: string, quality: LX.Quality }>
  getLocalMusicUrl: (request: {
    apiId: string
    requestId: string
    musicInfo: LX.Music.MusicInfoLocal
    signal: AbortSignal
  }) => Promise<{ url: string, quality: LX.Quality }>
}

export interface PlaybackSourceAdapterDependencies {
  isCustomApi: (apiId: string) => boolean
  ensureUserApi: (apiId: string) => Promise<LX.UserApi.UserApiEnsureResult>
  requestUserApi: (params: LX.UserApi.UserApiRequestParams) => Promise<LX.UserApi.UserApiRequestResult>
  cancelUserApi: (params: LX.UserApi.UserApiRequestCancelParams) => void
  acquireRuntime: (params: LX.UserApi.UserApiRuntimeLeaseParams) => void
  releaseRuntime: (params: LX.UserApi.UserApiRuntimeLeaseParams) => void
  getBuiltinCapabilities: (apiId: string) => LX.Playback.SourceCapabilities | undefined
  getBuiltinApi: (apiId: string, platform: LX.OnlineSource) => {
    getMusicUrl: (info: LX.Music.MusicInfo, quality: LX.Quality | null) => unknown
  }
  getMusicUrlCacheKey: (
    musicInfo: LX.Music.MusicInfo,
    quality: LX.Quality,
    persistentCache: boolean,
  ) => Promise<AuthorizedMusicUrlKeyV1 | null>
  tooManyRequestsMessage?: string
  serverBusyMessages: ReadonlySet<string>
}

const failureFromAbort = (apiId: string, signal: AbortSignal): LX.Playback.SourceError => {
  const reason = signal.reason as Partial<LX.Playback.SourceFailureData> | undefined
  if (reason?.scope == 'source' && reason.kind == 'timeout') {
    return createPlaybackSourceError({
      message: reason.message ?? 'Playback source request timed out',
      scope: 'source',
      kind: 'timeout',
      apiId,
    })
  }
  return createPlaybackSourceError({
    message: 'Playback source request cancelled',
    scope: 'session',
    kind: 'cancelled',
    apiId,
  })
}

const validateUrl = (apiId: string, platform: LX.OnlineSource | undefined, result: unknown) => {
  const value = result as { url?: unknown }
  if (typeof value?.url != 'string' || !/^https?:\/\//.test(value.url)) {
    throw createPlaybackSourceError({
      message: 'Playback source returned an empty or invalid URL',
      scope: 'candidate',
      kind: 'emptyUrl',
      apiId,
      platform,
    })
  }
  return value.url
}

const isPlaybackQuality = (value: unknown): value is LX.Quality => (
  typeof value == 'string' && (QUALITYS as readonly string[]).includes(value)
)

export const createPlaybackSourceAdapter = (
  deps: PlaybackSourceAdapterDependencies,
): PlaybackSourceAdapter => {
  const normalize = (
    error: unknown,
    apiId: string,
    platform?: LX.OnlineSource,
  ): LX.Playback.SourceError => {
    if (isPlaybackSourceError(error)) return error
    const candidate = error as { message?: string, statusCode?: number, code?: number | string }
    const statusCode = typeof candidate?.statusCode == 'number'
      ? candidate.statusCode
      : Number(candidate?.code) || undefined
    const kind: LX.Playback.SourceFailureKind = statusCode == 429 ||
      candidate?.message == deps.tooManyRequestsMessage
      ? 'rateLimit'
      : deps.serverBusyMessages.has(candidate?.message ?? '')
        ? 'serverBusy'
        : 'request'
    return createPlaybackSourceError({
      message: candidate?.message ?? 'Playback source request failed',
      scope: kind == 'request' ? 'candidate' : 'source',
      kind,
      apiId,
      platform,
      statusCode,
      cause: error,
    })
  }

  const customRequest = async(
    request: {
      apiId: string
      requestId: string
      musicInfo: LX.Music.MusicInfoOnline | LX.Music.MusicInfoLocal
      signal: AbortSignal
    },
    quality: LX.Quality | null,
  ) => {
    if (request.signal.aborted) throw failureFromAbort(request.apiId, request.signal)
    let abort: (() => void) | undefined
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => {
        const failure = failureFromAbort(request.apiId, request.signal)
        deps.cancelUserApi({
          apiId: request.apiId,
          requestId: request.requestId,
          reason: failure.kind == 'timeout' ? 'timeout' : 'cancelled',
        })
        reject(failure)
      }
      if (request.signal.aborted) abort()
      else request.signal.addEventListener('abort', abort, { once: true })
    })
    const invoking = (async() => {
      const result = await deps.requestUserApi({
        apiId: request.apiId,
        requestId: request.requestId,
        data: {
          source: request.musicInfo.source,
          action: 'musicUrl',
          info: { type: quality, musicInfo: request.musicInfo },
        },
      })
      if (!result.ok) throw toPlaybackSourceError(result.error)
      return result.value as { data?: unknown }
    })()
    try {
      const result = await Promise.race([invoking, aborted])
      const data = result.data as { type?: unknown }
      return {
        url: validateUrl(request.apiId, request.musicInfo.source == 'local' ? undefined : request.musicInfo.source, data),
        quality: isPlaybackQuality(data.type) ? data.type : quality,
      }
    } catch (error) {
      if (isPlaybackSourceError(error)) throw error
      throw normalize(error, request.apiId, request.musicInfo.source == 'local' ? undefined : request.musicInfo.source)
    } finally {
      if (abort) request.signal.removeEventListener('abort', abort)
    }
  }

  const builtInRequest = async(request: {
    apiId: string
    musicInfo: LX.Music.MusicInfoOnline
    quality: LX.Quality
    signal: AbortSignal
  }) => {
    if (request.signal.aborted) throw failureFromAbort(request.apiId, request.signal)
    try {
      const returned = deps.getBuiltinApi(request.apiId, request.musicInfo.source)
        .getMusicUrl(request.musicInfo, request.quality) as Promise<unknown> | { promise: Promise<unknown> }
      const result = await ('promise' in Object(returned) ? (returned as { promise: Promise<unknown> }).promise : returned)
      const url = validateUrl(request.apiId, request.musicInfo.source, result)
      return { url, quality: ((result as { type?: LX.Quality }).type ?? request.quality) }
    } catch (error) {
      throw normalize(error, request.apiId, request.musicInfo.source)
    }
  }

  return {
    retainSources(apiIds, sessionId) {
      const customIds = apiIds.filter(deps.isCustomApi)
      if (customIds.length) deps.acquireRuntime({ apiIds: customIds, leaseId: sessionId })
    },
    releaseSources(apiIds, sessionId) {
      const customIds = apiIds.filter(deps.isCustomApi)
      if (customIds.length) deps.releaseRuntime({ apiIds: customIds, leaseId: sessionId })
    },
    async getCapabilities(apiId, signal) {
      if (signal.aborted) throw failureFromAbort(apiId, signal)
      const builtin = deps.getBuiltinCapabilities(apiId)
      if (builtin) return builtin
      if (!deps.isCustomApi(apiId)) {
        throw createPlaybackSourceError({
          message: 'Playback source is not installed',
          scope: 'source',
          kind: 'initialization',
          apiId,
        })
      }
      const result = await deps.ensureUserApi(apiId)
      if (!result.ok) {
        throw createPlaybackSourceError({
          message: result.error.message,
          scope: 'source',
          kind: 'initialization',
          apiId,
        })
      }
      const status = result.value
      const sources = status.apiInfo?.sources
      if (!status.status || status.apiId != apiId) {
        throw createPlaybackSourceError({
          message: status.message ?? 'Playback source initialization failed',
          scope: 'source',
          kind: 'initialization',
          apiId,
        })
      }
      if (!sources) {
        throw createPlaybackSourceError({
          message: status.message ?? 'Playback source initialization failed',
          scope: 'source',
          kind: 'initialization',
          apiId,
        })
      }
      return { sources }
    },
    async authorizeMusicUrl(request) {
      if (request.signal.aborted) throw failureFromAbort(request.apiId, request.signal)
      if (deps.isCustomApi(request.apiId)) return null
      return deps.getMusicUrlCacheKey(request.musicInfo, request.quality, true)
    },
    async getMusicUrl(request) {
      if (!deps.isCustomApi(request.apiId)) return builtInRequest(request)
      const result = await customRequest(request, request.quality)
      return { url: result.url, quality: result.quality ?? request.quality }
    },
    async getLocalMusicUrl(request) {
      const result = await customRequest(request, null)
      return { url: result.url, quality: '128k' }
    },
  }
}

const getBuiltinCapabilities = (apiId: string): LX.Playback.SourceCapabilities | undefined => {
  const qualityList = (supportQuality as Record<string, LX.QualityList>)[apiId]
  if (!qualityList) return undefined
  const sources: LX.Playback.SourceCapabilities['sources'] = {}
  for (const [platform, qualitys] of Object.entries(qualityList)) {
    sources[platform as LX.OnlineSource] = { actions: ['musicUrl'], qualitys: [...qualitys] }
  }
  return { sources }
}

export const playbackSourceAdapter = createPlaybackSourceAdapter({
  isCustomApi: apiId => /^user_api/.test(apiId),
  ensureUserApi,
  requestUserApi: sendUserApiRequest,
  cancelUserApi: userApiRequestCancel,
  acquireRuntime: acquireUserApiRuntime,
  releaseRuntime: releaseUserApiRuntime,
  getBuiltinCapabilities,
  getBuiltinApi: getApiById,
  getMusicUrlCacheKey,
  tooManyRequestsMessage: requestMsg.tooManyRequests,
  serverBusyMessages: new Set(['Server busy', '服务器繁忙']),
})
