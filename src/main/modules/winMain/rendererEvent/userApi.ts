import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle } from '@common/mainIpc'
import {
  getApiList,
  takeReplacementFailureApiList,
  importApi,
  replaceApisFromGitHub,
  removeApi,
  setApi,
  getStatus,
  request,
  cancelRequest,
  setAllowShowUpdateAlert,
} from '@main/modules/userApi'
import { sendEvent } from '@main/modules/winMain/main'

const REPLACE_ERROR_LIMITS = {
  message: 500,
  code: 100,
  detail: 500,
} as const

const getErrorText = (
  err: unknown,
  key: keyof typeof REPLACE_ERROR_LIMITS,
): string | undefined => {
  if (err == null || typeof err != 'object') return
  const descriptor = Object.getOwnPropertyDescriptor(err, key)
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value != 'string') return
  return descriptor.value
    .split(/\r?\n/, 1)[0]
    .substring(0, REPLACE_ERROR_LIMITS[key])
}

const serializeReplaceError = (err: unknown): LX.UserApi.GitHubReplaceError => {
  const message = getErrorText(err, 'message') ?? 'GitHub user API replacement failed'
  const code = getErrorText(err, 'code')
  const detail = getErrorText(err, 'detail')
  return {
    message,
    ...(code == null ? {} : { code }),
    ...(detail == null ? {} : { detail }),
  }
}

export default () => {
  mainHandle<string, LX.UserApi.ImportUserApi>(WIN_MAIN_RENDERER_EVENT_NAME.import_user_api, async({ params: script }) => {
    return importApi(script)
  })

  mainHandle<LX.UserApi.GitHubImportItem[], LX.UserApi.GitHubReplaceResult>(
    WIN_MAIN_RENDERER_EVENT_NAME.replace_user_api_from_github,
    async({ params: items }) => {
      try {
        return { success: true, apiList: await replaceApisFromGitHub(items) }
      } catch (err) {
        const apiList = takeReplacementFailureApiList(err)
        return {
          success: false,
          ...(apiList == null ? {} : { apiList }),
          error: serializeReplaceError(err),
        }
      }
    },
  )

  mainHandle<string[], LX.UserApi.UserApiInfo[]>(WIN_MAIN_RENDERER_EVENT_NAME.remove_user_api, async({ params: apiIds }) => {
    return removeApi(apiIds)
  })

  mainHandle<LX.UserApi.UserApiSetApiParams>(WIN_MAIN_RENDERER_EVENT_NAME.set_user_api, async({ params: apiId }) => {
    await setApi(apiId)
  })

  mainHandle<LX.UserApi.UserApiInfo[]>(WIN_MAIN_RENDERER_EVENT_NAME.get_user_api_list, async() => {
    return getApiList()
  })

  mainHandle<LX.UserApi.UserApiStatus>(WIN_MAIN_RENDERER_EVENT_NAME.get_user_api_status, async() => {
    return getStatus()
  })

  mainHandle<LX.UserApi.UserApiSetAllowUpdateAlertParams>(WIN_MAIN_RENDERER_EVENT_NAME.user_api_set_allow_update_alert, async({ params: { id, enable } }) => {
    await setAllowShowUpdateAlert(id, enable)
  })

  mainHandle<LX.UserApi.UserApiRequestParams>(WIN_MAIN_RENDERER_EVENT_NAME.request_user_api, async({ params }) => {
    return request(params)
  })
  mainHandle<LX.UserApi.UserApiRequestCancelParams>(WIN_MAIN_RENDERER_EVENT_NAME.request_user_api_cancel, async({ params: requestKey }) => {
    cancelRequest(requestKey)
  })
}

export const sendStatusChange = (status: LX.UserApi.UserApiStatus) => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.user_api_status, status)
}
export const sendShowUpdateAlert = (info: LX.UserApi.UserApiUpdateInfo) => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.user_api_show_update_alert, info)
}

