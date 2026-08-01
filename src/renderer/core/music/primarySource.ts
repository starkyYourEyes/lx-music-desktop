import { createPlaybackSourceError, toPlaybackSourceError } from '@common/utils/playbackSourceError'
import { qualityList, userApi } from '@renderer/store'
import { appSetting } from '@renderer/store/setting'
import { ensureUserApi, sendUserApiRequest, userApiRequestCancel } from '@renderer/utils/ipc'
import { supportQuality } from '@renderer/utils/musicSdk/api-source'
import { deriveQualityListFromCapabilities } from './playback/sourceSelectors'

export interface PrimarySourceCapabilityControllerDependencies {
  getPrimaryId(): string
  isInstalledCustom(apiId: string): boolean
  isCustomRegistryLoaded(): boolean
  getBuiltinCapabilities(apiId: string): LX.Playback.SourceCapabilities | undefined
  getRuntimeStatus(apiId: string): LX.UserApi.UserApiStatus | undefined
  getKnownCapabilities(apiId: string): LX.Playback.SourceCapabilities | undefined
  ensureUserApi(apiId: string): Promise<LX.UserApi.UserApiEnsureResult>
  requestUserApi(params: LX.UserApi.UserApiRequestParams): Promise<LX.UserApi.UserApiRequestResult>
  cancelUserApi(params: LX.UserApi.UserApiRequestCancelParams): void
  publishCapabilities(apiId: string, value: LX.Playback.SourceCapabilities): void
  createRequestId(): string
}

export interface PrimarySourceActionInput {
  source: LX.OnlineSource | 'local'
  action: 'musicUrl' | 'lyric' | 'pic'
  info: LX.Music.MusicInfo
  quality?: LX.Quality | null
}

export interface PrimarySourceCapabilityController {
  ensurePrimaryCapabilities(): Promise<LX.Playback.SourceCapabilities>
  requestPrimaryAction<T>(input: PrimarySourceActionInput): {
    canceleFn(): void
    promise: Promise<T>
  }
  invalidate(apiId: string): void
}

export const createPrimarySourceCapabilityController = (
  deps: PrimarySourceCapabilityControllerDependencies,
): PrimarySourceCapabilityController => {
  const inflightByApiId = new Map<string, Promise<LX.Playback.SourceCapabilities>>()
  const invalidationTokenByApiId = new Map<string, number>()
  const tokenFor = (apiId: string) => invalidationTokenByApiId.get(apiId) ?? 0
  const fail = (apiId: string, kind: LX.Playback.SourceFailureKind, message: string): never => {
    throw createPlaybackSourceError({ message, scope: 'source', kind, apiId })
  }
  const cloneCapabilities = (value: LX.Playback.SourceCapabilities): LX.Playback.SourceCapabilities => {
    const sources: LX.Playback.SourceCapabilities['sources'] = {}
    for (const [source, info] of Object.entries(value.sources)) {
      if (!info) continue
      sources[source as LX.OnlineSource | 'local'] = { actions: [...info.actions], qualitys: [...info.qualitys] }
    }
    return { sources }
  }
  const ensureFor = (apiId: string): Promise<LX.Playback.SourceCapabilities> => {
    const builtin = deps.getBuiltinCapabilities(apiId)
    if (builtin) return Promise.resolve(cloneCapabilities(builtin))
    if (deps.isCustomRegistryLoaded() && !deps.isInstalledCustom(apiId)) {
      return Promise.reject(createPlaybackSourceError({
        message: 'Primary playback source is not installed',
        scope: 'source', kind: 'initialization', apiId,
      }))
    }
    const known = deps.getKnownCapabilities(apiId)
    if (deps.getRuntimeStatus(apiId)?.status && known) return Promise.resolve(known)
    const existing = inflightByApiId.get(apiId)
    if (existing) return existing
    const token = tokenFor(apiId)
    let created!: Promise<LX.Playback.SourceCapabilities>
    created = (async() => {
      const result = await deps.ensureUserApi(apiId)
      if (tokenFor(apiId) != token) fail(apiId, 'sourceChanged', 'Playback source changed')
      if (!result.ok) throw toPlaybackSourceError(result.error)
      const status = result.value
      const sources = status.apiInfo?.sources
      if (!status.status || status.apiId != apiId) {
        fail(apiId, 'initialization', status.message ?? 'Playback source initialization failed')
      }
      if (!sources) {
        throw createPlaybackSourceError({
          message: status.message ?? 'Playback source initialization failed',
          scope: 'source', kind: 'initialization', apiId,
        })
      }
      const capabilities = { sources }
      deps.publishCapabilities(apiId, capabilities)
      return capabilities
    })().finally(() => {
      if (inflightByApiId.get(apiId) === created) inflightByApiId.delete(apiId)
    })
    inflightByApiId.set(apiId, created)
    return created
  }
  const requestPrimaryAction = <T>(input: PrimarySourceActionInput) => {
    const apiId = deps.getPrimaryId()
    const requestId = deps.createRequestId()
    let isCancelled = false
    const canceleFn = () => {
      if (isCancelled) return
      isCancelled = true
      deps.cancelUserApi({ apiId, requestId, reason: 'cancelled' })
    }
    const promise = (async(): Promise<T> => {
      if (deps.isCustomRegistryLoaded() && !deps.isInstalledCustom(apiId)) {
        throw createPlaybackSourceError({
          message: 'Primary compatibility action requires a custom source',
          scope: 'candidate', kind: 'unsupported', apiId,
        })
      }
      const capabilities = await ensureFor(apiId)
      if (isCancelled) {
        throw createPlaybackSourceError({
          message: 'Playback source request cancelled',
          scope: 'session', kind: 'cancelled', apiId,
        })
      }
      const sourceInfo = capabilities.sources[input.source]
      if (!sourceInfo?.actions.includes(input.action) ||
        (input.action == 'musicUrl' && input.source != 'local' &&
          (input.quality == null || !sourceInfo.qualitys.includes(input.quality)))) {
        throw createPlaybackSourceError({
          message: 'Playback source action is not supported',
          scope: 'candidate', kind: 'unsupported', apiId,
        })
      }
      const result = await deps.requestUserApi({
        apiId,
        requestId,
        data: {
          source: input.source,
          action: input.action,
          info: { type: input.action == 'musicUrl' ? input.quality ?? null : 'music', musicInfo: input.info },
        },
      })
      if (isCancelled) {
        throw createPlaybackSourceError({
          message: 'Playback source request cancelled',
          scope: 'session', kind: 'cancelled', apiId,
        })
      }
      if (!result.ok) throw toPlaybackSourceError(result.error)
      const response = result.value as { source?: LX.Source, action?: LX.UserApi.UserApiSourceInfoActions, data?: T }
      if (response.source != input.source || response.action != input.action ||
        !Object.prototype.hasOwnProperty.call(response, 'data')) {
        throw createPlaybackSourceError({
          message: 'Playback source returned an invalid response',
          scope: 'candidate', kind: 'request', apiId,
        })
      }
      return response.data as T
    })()
    return { canceleFn, promise }
  }
  return {
    ensurePrimaryCapabilities: () => ensureFor(deps.getPrimaryId()),
    requestPrimaryAction,
    invalidate(apiId) {
      invalidationTokenByApiId.set(apiId, tokenFor(apiId) + 1)
      inflightByApiId.delete(apiId)
    },
  }
}

const builtinCapabilities = (apiId: string): LX.Playback.SourceCapabilities | undefined => {
  const qualityList = (supportQuality as Record<string, LX.QualityList>)[apiId]
  if (!qualityList) return undefined
  const sources: LX.Playback.SourceCapabilities['sources'] = {}
  for (const [source, qualitys] of Object.entries(qualityList)) {
    sources[source as LX.OnlineSource] = { actions: ['musicUrl'], qualitys: [...qualitys] }
  }
  return { sources }
}

let requestSequence = 0
export const primarySourceCapabilityController = createPrimarySourceCapabilityController({
  getPrimaryId: () => appSetting['common.apiSource'],
  isInstalledCustom: apiId => userApi.list.some(api => api.id == apiId),
  isCustomRegistryLoaded: () => userApi.listLoaded,
  getBuiltinCapabilities: builtinCapabilities,
  getRuntimeStatus: apiId => userApi.runtimeStates[apiId],
  getKnownCapabilities: apiId => userApi.capabilities[apiId],
  ensureUserApi,
  requestUserApi: sendUserApiRequest,
  cancelUserApi: userApiRequestCancel,
  publishCapabilities(apiId, value) {
    userApi.capabilities[apiId] = value
    if (apiId == appSetting['common.apiSource']) {
      qualityList.value = deriveQualityListFromCapabilities(value)
    }
  },
  createRequestId: () => `primary__${Date.now()}_${++requestSequence}`,
})

export const ensurePrimarySourceCapabilities = () => primarySourceCapabilityController.ensurePrimaryCapabilities()
export const requestPrimarySourceAction = <T>(input: PrimarySourceActionInput) => primarySourceCapabilityController.requestPrimaryAction<T>(input)
