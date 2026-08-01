import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { deriveQualityListFromCapabilities } from '@renderer/core/music/playback/sourceSelectors'
import { ensureUserApi } from '@renderer/utils/ipc'
import { supportQuality } from '@renderer/utils/musicSdk/api-source'

let invocationSequence = 0
let activeInvocation: { apiId: string, promise: Promise<void> } | null = null

const applyUserApi = async(apiId: string, invocation: number) => {
  const isCurrent = () => invocationSequence == invocation && apiSource.value == apiId
  apiSource.value = apiId

  const builtin = (supportQuality as Record<string, LX.QualityList>)[apiId]
  if (builtin) {
    qualityList.value = Object.fromEntries(
      Object.entries(builtin).map(([source, qualitys]) => [source, [...qualitys]]),
    )
    userApi.status = true
    userApi.message = undefined
  } else {
    qualityList.value = deriveQualityListFromCapabilities(userApi.capabilities[apiId])
    const runtime = userApi.runtimeStates[apiId]
    userApi.status = runtime?.status ?? false
    userApi.message = runtime?.message ?? 'initing'

    const applyFailure = (message: string) => {
      userApi.runtimeStates[apiId] = {
        ...userApi.runtimeStates[apiId],
        apiId,
        status: false,
        message,
      }
      userApi.status = false
      userApi.message = message
    }
    let result: LX.UserApi.UserApiEnsureResult
    try {
      result = await ensureUserApi(apiId)
    } catch (error) {
      if (!isCurrent()) return
      applyFailure(error instanceof Error ? error.message : String(error))
      return
    }
    if (!isCurrent()) return
    if (!result.ok) {
      applyFailure(result.error.message)
      return
    }

    const status = result.value
    userApi.runtimeStates[apiId] = status
    if (status.status && status.apiInfo?.sources) {
      userApi.capabilities[apiId] = { sources: status.apiInfo.sources }
    }
    userApi.status = status.status
    userApi.message = status.message
    qualityList.value = deriveQualityListFromCapabilities(userApi.capabilities[apiId])
  }

  if (isCurrent() && apiId != appSetting['common.apiSource']) setApiSource(apiId)
}

export const setUserApi = async(apiId: string): Promise<void> => {
  if (activeInvocation?.apiId == apiId && apiSource.value == apiId) return activeInvocation.promise
  const builtin = (supportQuality as Record<string, LX.QualityList>)[apiId]
  if (apiSource.value == apiId && (builtin || userApi.runtimeStates[apiId]?.status)) {
    return Promise.resolve()
  }

  const invocation = ++invocationSequence
  const promise = applyUserApi(apiId, invocation).finally(() => {
    if (activeInvocation?.promise == promise) activeInvocation = null
  })
  activeInvocation = { apiId, promise }
  return promise
}
