import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { getUserApiList, onShowUserApiUpdateAlert, onUserApiStatus } from '@renderer/utils/ipc'
import { openUrl } from '@common/utils/electron'
import { qualityList, userApi } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { dialog } from '@renderer/plugins/Dialog'
import { setUserApi } from '@renderer/core/apiSource'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { reconcilePlaybackSourceRegistry } from '@common/utils/playbackSourceSetting'
import {
  primarySourceCapabilityController,
  requestPrimarySourceAction,
} from '@renderer/core/music/primarySource'
import { deriveQualityListFromCapabilities } from '@renderer/core/music/playback/sourceSelectors'

const compatibilitySources: Array<LX.OnlineSource | 'local'> = [
  'kw', 'kg', 'tx', 'wy', 'mg', 'local',
]

const buildPrimaryCompatibilityApis = () => {
  const apis: Record<string, unknown> = {}
  for (const source of compatibilitySources) {
    apis[source] = {
      getMusicUrl(info: LX.Music.MusicInfo, quality: LX.Quality | null) {
        return requestPrimarySourceAction<{ type: LX.Quality | null, url: string }>({
          source, action: 'musicUrl', info, quality,
        })
      },
      getLyric(info: LX.Music.MusicInfo) {
        return requestPrimarySourceAction<LX.Music.LyricInfo>({ source, action: 'lyric', info })
      },
      getPic(info: LX.Music.MusicInfo) {
        return requestPrimarySourceAction<string>({ source, action: 'pic', info })
      },
    }
  }
  return apis as Partial<LX.UserApi.UserApiSources>
}

export default () => {
  const t = useI18n()
  userApi.apis = buildPrimaryCompatibilityApis()

  const reconcileInstalledPlaybackSources = (list: LX.UserApi.UserApiInfo[]) => {
    const normalized = reconcilePlaybackSourceRegistry(
      appSetting,
      apiSourceInfo.filter(source => !source.disabled).map(source => source.id),
      list.map(source => source.id),
      userApi.listLoaded,
    )
    if (
      normalized['common.apiFallbackMode'] == appSetting['common.apiFallbackMode'] &&
      normalized['common.apiFallbackSources'].join('\u0000') == appSetting['common.apiFallbackSources'].join('\u0000')
    ) return
    updateSetting(normalized)
  }

  const stopRegistryReconcile = watch(
    () => [
      userApi.listLoaded,
      appSetting['common.apiSource'],
      appSetting['common.apiFallbackMode'],
      appSetting['common.apiFallbackSources'].join('\u0000'),
      userApi.list.map(({ id }) => id).join('\u0000'),
    ] as const,
    () => { reconcileInstalledPlaybackSources(userApi.list) },
    { immediate: true },
  )

  const stopRuntimeInvalidation = watch(
    () => userApi.list.map(api => `${api.id}:${api.version ?? ''}:${api.remote?.blobSha ?? ''}`).join('\u0000'),
    (current, previous) => {
      if (previous == null || !userApi.listLoaded) return
      const parse = (value: string) => new Map(value.split('\u0000').filter(Boolean).map(item => {
        const separator = item.indexOf(':')
        return [item.substring(0, separator), item]
      }))
      const before = parse(previous)
      const after = parse(current)
      for (const [apiId, signature] of before) {
        if (after.get(apiId) == signature) continue
        primarySourceCapabilityController.invalidate(apiId)
        Reflect.deleteProperty(userApi.runtimeStates, apiId)
        Reflect.deleteProperty(userApi.capabilities, apiId)
      }
    },
  )

  const rUserApiStatus = onUserApiStatus(({ params: runtime }) => {
    userApi.runtimeStates[runtime.apiId] = runtime
    if (runtime.status && runtime.apiInfo?.sources) {
      userApi.capabilities[runtime.apiId] = { sources: runtime.apiInfo.sources }
    } else if (!runtime.status) {
      primarySourceCapabilityController.invalidate(runtime.apiId)
      Reflect.deleteProperty(userApi.capabilities, runtime.apiId)
    }
    if (runtime.apiId != appSetting['common.apiSource']) return

    userApi.status = runtime.status
    userApi.message = runtime.message
    if (runtime.status) {
      qualityList.value = deriveQualityListFromCapabilities(userApi.capabilities[runtime.apiId])
    } else if (runtime.message && runtime.apiInfo) {
      void dialog({
        message: `${t('user_api__init_failed_alert', { name: runtime.apiInfo.name })}\n${runtime.message}`,
        selection: true,
        confirmButtonText: t('ok'),
      })
    }
  })

  const rUserApiShowUpdateAlert = onShowUserApiUpdateAlert(({ params: { name, log, updateUrl } }) => {
    if (updateUrl) {
      void dialog({
        message: `${t('user_api__update_alert', { name })}\n${log}`,
        selection: true,
        showCancel: true,
        confirmButtonText: t('user_api__update_alert_open_url'),
        cancelButtonText: t('close'),
      }).then(confirm => {
        if (!confirm) return
        window.setTimeout(() => { void openUrl(updateUrl) }, 300)
      })
    } else {
      void dialog({
        message: `${t('user_api__update_alert', { name })}\n${log}`,
        selection: true,
        confirmButtonText: t('ok'),
      })
    }
  })

  onBeforeUnmount(() => {
    stopRegistryReconcile()
    stopRuntimeInvalidation()
    rUserApiStatus()
    rUserApiShowUpdateAlert()
  })

  return async() => {
    void setUserApi(appSetting['common.apiSource'])
    void getUserApiList().then(list => {
      userApi.list = list
      userApi.listLoaded = true
      void setUserApi(appSetting['common.apiSource'])
    }).catch(err => {
      console.log(err)
    })
  }
}
