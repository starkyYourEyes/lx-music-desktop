import { apiSource, qualityList, userApi } from '@renderer/store'
import { appSetting, setApiSource } from '@renderer/store/setting'
import { deriveQualityListFromCapabilities } from '@renderer/core/music/playback/sourceSelectors'
import { supportQuality } from '@renderer/utils/musicSdk/api-source'

let prevId = ''
export const setUserApi = async(apiId: string) => {
  if (prevId == apiId && apiSource.value == apiId) return
  prevId = apiId
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
  }

  if (prevId == apiId && apiId != appSetting['common.apiSource']) setApiSource(apiId)
}
