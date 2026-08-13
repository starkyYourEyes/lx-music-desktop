import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { mainHandle, mainOn } from '@common/mainIpc'
import { log } from '@common/utils'
import {
  createReplacementFailureApiListCarrier,
  getApiList,
  takeReplacementFailureApiList,
  importApi,
  replaceApisFromGitHub,
  removeApi,
  setApi,
  setAllowShowUpdateAlert,
  request,
  cancelRequest,
} from '@main/modules/userApi'
import { normalizeRuntimeFailure } from '@main/modules/userApi/runtimeError'
import { getUserApiRuntimePool } from '@main/modules/userApi/runtimePool'
import { sendEvent } from '@main/modules/winMain/main'
import {
  parseUserApiCancellationPayload,
  parseUserApiEnsurePayload,
  parseUserApiRequestPayload,
  parseUserApiRuntimeLeasePayload,
} from '@main/modules/userApi/ipcValidation'

const REPLACE_ERROR_LIMITS = {
  message: 500,
  code: 100,
  detail: 500,
} as const

const ENSURE_FAILURE_KINDS = new Set<LX.Playback.SourceFailureKind>([
  'initialization',
  'runtimeCrash',
  'sourceChanged',
  'timeout',
])

const getEnsureFailureKind = (
  error: unknown,
  apiId: string,
): LX.Playback.SourceFailureKind => {
  try {
    if (error == null || typeof error != 'object') return 'initialization'
    const descriptors = Object.getOwnPropertyDescriptors(error)
    const name = descriptors.name?.value
    const failureApiId = descriptors.apiId?.value
    const kind = descriptors.kind?.value
    if (name != 'PlaybackSourceError' ||
      failureApiId != apiId ||
      typeof kind != 'string' ||
      !ENSURE_FAILURE_KINDS.has(kind as LX.Playback.SourceFailureKind)) return 'initialization'
    return kind as LX.Playback.SourceFailureKind
  } catch {
    return 'initialization'
  }
}

const parseFireAndForget = <T>(parser: (value: unknown) => T, value: unknown): T | null => {
  try {
    return parser(value)
  } catch {
    return null
  }
}

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

const serializeReplaceError = (
  err: unknown,
  fallbackMessage = 'GitHub user API replacement failed',
): LX.UserApi.GitHubReplaceError => {
  const message = getErrorText(err, 'message') ?? fallbackMessage
  const code = getErrorText(err, 'code')
  const detail = getErrorText(err, 'detail')
  return {
    message,
    ...(code == null ? {} : { code }),
    ...(detail == null ? {} : { detail }),
  }
}

export default () => {
  const runtimePool = getUserApiRuntimePool()
  const registeredOwners = new Set<number>()
  const registerOwner = (sender: Electron.WebContents) => {
    if (registeredOwners.has(sender.id)) return
    registeredOwners.add(sender.id)
    sender.once('destroyed', () => {
      registeredOwners.delete(sender.id)
      void getUserApiRuntimePool().releaseOwner(sender.id).catch(error => {
        log.error('release user API runtime owner failed', error)
      })
    })
  }
  mainHandle<string, LX.UserApi.ImportUserApi>(WIN_MAIN_RENDERER_EVENT_NAME.import_user_api, async({ params: script }) => {
    return importApi(script)
  })

  mainHandle<LX.UserApi.GitHubImportItem[], LX.UserApi.GitHubReplaceResult>(
    WIN_MAIN_RENDERER_EVENT_NAME.replace_user_api_from_github,
    async({ params: items }) => {
      try {
        return { success: true, ...await replaceApisFromGitHub(items) }
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

  mainHandle<string[], LX.UserApi.UserApiRemoveResult>(
    WIN_MAIN_RENDERER_EVENT_NAME.remove_user_api,
    async({ params: apiIds }) => {
      const failureCarrier = createReplacementFailureApiListCarrier()
      try {
        return { success: true, apiList: await removeApi(apiIds, failureCarrier) }
      } catch (err) {
        const apiList = takeReplacementFailureApiList(failureCarrier)
        if (apiList == null) throw err
        return {
          success: false,
          apiList,
          error: serializeReplaceError(err, 'User API removal failed'),
        }
      }
    },
  )

  mainHandle<LX.UserApi.UserApiSetApiParams>(WIN_MAIN_RENDERER_EVENT_NAME.set_user_api, async({ params: apiId }) => {
    await setApi(apiId)
  })

  mainHandle<LX.UserApi.UserApiInfo[]>(WIN_MAIN_RENDERER_EVENT_NAME.get_user_api_list, async() => {
    return getApiList()
  })

  mainHandle<LX.UserApi.UserApiGetStatusParams, LX.UserApi.UserApiStatus>(WIN_MAIN_RENDERER_EVENT_NAME.get_user_api_status, async({ params: apiId }) => {
    return runtimePool.getStatus(apiId)
  })

  mainHandle<LX.UserApi.UserApiSetAllowUpdateAlertParams>(WIN_MAIN_RENDERER_EVENT_NAME.user_api_set_allow_update_alert, async({ params: { id, enable } }) => {
    await setAllowShowUpdateAlert(id, enable)
  })

  mainHandle<unknown, LX.UserApi.UserApiRequestResult>(WIN_MAIN_RENDERER_EVENT_NAME.request_user_api, async({ event, params }) => {
    registerOwner(event.sender)
    return request(parseUserApiRequestPayload(params), event.sender.id)
  })
  mainHandle<unknown, LX.UserApi.UserApiEnsureResult>(WIN_MAIN_RENDERER_EVENT_NAME.ensure_user_api, async({ params }) => {
    const apiId = parseUserApiEnsurePayload(params)
    try {
      await runtimePool.ensure(apiId)
      return { ok: true, value: runtimePool.getStatus(apiId) }
    } catch (error) {
      return {
        ok: false,
        error: normalizeRuntimeFailure(error, {
          apiId,
          kind: getEnsureFailureKind(error, apiId),
        }),
      }
    }
  })
  mainOn<unknown>(WIN_MAIN_RENDERER_EVENT_NAME.request_user_api_cancel, ({ event, params }) => {
    const cancellation = parseFireAndForget(parseUserApiCancellationPayload, params)
    if (cancellation == null) return
    registerOwner(event.sender)
    cancelRequest(cancellation, event.sender.id)
  })
  mainOn<unknown>(WIN_MAIN_RENDERER_EVENT_NAME.acquire_user_api_runtime, ({ event, params }) => {
    const lease = parseFireAndForget(parseUserApiRuntimeLeasePayload, params)
    if (lease == null) return
    registerOwner(event.sender)
    runtimePool.acquireLease(lease, event.sender.id)
  })
  mainOn<unknown>(WIN_MAIN_RENDERER_EVENT_NAME.release_user_api_runtime, ({ event, params }) => {
    const lease = parseFireAndForget(parseUserApiRuntimeLeasePayload, params)
    if (lease == null) return
    registerOwner(event.sender)
    void getUserApiRuntimePool().releaseLease(lease, event.sender.id).catch(error => {
      log.error('release user API runtime lease failed', error)
    })
  })
}

export const sendStatusChange = (status: LX.UserApi.UserApiStatus) => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.user_api_status, status)
}
export const sendShowUpdateAlert = (info: LX.UserApi.UserApiUpdateInfo) => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.user_api_show_update_alert, info)
}

