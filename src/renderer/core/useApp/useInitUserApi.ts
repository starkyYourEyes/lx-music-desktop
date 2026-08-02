import { onBeforeUnmount, watch } from '@common/utils/vueTools'
import { useI18n } from '@renderer/plugins/i18n'
import { onUserApiStatus, getUserApiList, sendUserApiRequest as sendUserApiRequestRemote, userApiRequestCancel, onShowUserApiUpdateAlert } from '@renderer/utils/ipc'
import { openUrl } from '@common/utils/electron'
import { qualityList, userApi } from '@renderer/store'
import { appSetting, updateSetting } from '@renderer/store/setting'
import { dialog } from '@renderer/plugins/Dialog'
import { setUserApi } from '@renderer/core/apiSource'
import apiSourceInfo from '@renderer/utils/musicSdk/api-source-info'
import { reconcilePlaybackSourceRegistry } from '@common/utils/playbackSourceSetting'

const sendUserApiRequest = async(data: LX.UserApi.SourceUserApiRequestParams): Promise<any> => {
  const result = await sendUserApiRequestRemote(data)
  if (result.ok) return result.value
  throw Object.assign(new Error(result.error.message), result.error)
}

export default () => {
  const t = useI18n()

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

  const rUserApiStatus = onUserApiStatus(({ params: { apiId: statusApiId, status, message, apiInfo } }) => {
    // console.log({ status, message, apiInfo })
    if ((apiInfo?.id ?? statusApiId) !== appSetting['common.apiSource']) return
    userApi.status = status
    userApi.message = message

    if (!apiInfo) return
    if (status) {
      if (apiInfo.sources) {
        let apis: any = {}
        let qualitys: LX.QualityList = {}
        const apiId = apiInfo.id
        for (const [source, { actions, type, qualitys: sourceQualitys }] of Object.entries(apiInfo.sources)) {
          if (type != 'music') continue
          apis[source as LX.Source] = {}
          for (const action of actions) {
            switch (action) {
              case 'musicUrl':
                apis[source].getMusicUrl = (songInfo: LX.Music.MusicInfo, type: LX.Quality) => {
                  const requestId = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      userApiRequestCancel({ apiId, requestId })
                    },
                    promise: sendUserApiRequest({
                      apiId,
                      requestId,
                      data: {
                        source,
                        action: 'musicUrl',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then((res: { data: LX.UserApi.MusicUrlResponseData }) => {
                      if (res.data.source != null && res.data.source != source) {
                        throw new Error('Invalid User API music URL provenance')
                      }
                      return {
                        type: res.data.type ?? type,
                        url: res.data.url,
                        source: res.data.source ?? source,
                        persistentCache: false as const,
                      }
                    }).catch(async err => {
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              case 'lyric':
                apis[source].getLyric = (songInfo: LX.Music.MusicInfo) => {
                  const requestId = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      userApiRequestCancel({ apiId, requestId })
                    },
                    promise: sendUserApiRequest({
                      apiId,
                      requestId,
                      data: {
                        source,
                        action: 'lyric',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return res.data
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              case 'pic':
                apis[source].getPic = (songInfo: LX.Music.MusicInfo) => {
                  const requestId = `request__${Math.random().toString().substring(2)}`
                  return {
                    canceleFn() {
                      userApiRequestCancel({ apiId, requestId })
                    },
                    promise: sendUserApiRequest({
                      apiId,
                      requestId,
                      data: {
                        source,
                        action: 'pic',
                        info: {
                          type,
                          musicInfo: songInfo,
                        },
                      },
                      // eslint-disable-next-line @typescript-eslint/promise-function-async
                    }).then(res => {
                      // console.log(res)
                      return res.data
                    }).catch(async err => {
                      console.log(err.message)
                      return Promise.reject(err)
                    }),
                  }
                }
                break
              default:
                break
            }
          }
          qualitys[source as LX.Source] = sourceQualitys
        }
        qualityList.value = qualitys
        userApi.apis = apis
      }
    } else {
      if (message) {
        void dialog({
          message: `${t('user_api__init_failed_alert', { name: apiInfo.name })}\n${message}`,
          selection: true,
          confirmButtonText: t('ok'),
        })
      }
    }
    if (!window.lx.apiInitPromise[1]) window.lx.apiInitPromise[2](status)
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
        window.setTimeout(() => {
          void openUrl(updateUrl)
        }, 300)
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
    rUserApiStatus()
    rUserApiShowUpdateAlert()
  })

  return async() => {
    await setUserApi(appSetting['common.apiSource'])
    void getUserApiList().then(list => {
      // console.log(list)
      // if (![...apiSourceInfo.map(s => s.id), ...list.map(s => s.id)].includes(appSetting['common.apiSource'])) {
      //   console.warn('reset api')
      //   let api = apiSourceInfo.find(api => !api.disabled)
      //   if (api) apiSource.value = api.id
      // }
      userApi.list = list
      userApi.listLoaded = true
    }).catch(err => {
      console.log(err)
    })
  }
}
