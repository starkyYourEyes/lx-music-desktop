import { mainOn } from '@common/mainIpc'
import { getUserApiRuntimePool, type UserApiRuntimePool } from '../runtimePool'
import USER_API_RENDERER_EVENT_NAME from './name'

export const init = (runtimePool?: UserApiRuntimePool) => {
  const pool = runtimePool ?? getUserApiRuntimePool()
  mainOn<LX.UserApi.UserApiRuntimeInitEnvelope>(
    USER_API_RENDERER_EVENT_NAME.init,
    ({ event, params }) => pool.acceptInit(event.sender.id, params),
  )
  mainOn<LX.UserApi.UserApiRuntimeResponseEnvelope>(
    USER_API_RENDERER_EVENT_NAME.response,
    ({ event, params }) => pool.acceptResponse(event.sender.id, params),
  )
  mainOn<LX.UserApi.UserApiRuntimeControlEnvelope>(
    USER_API_RENDERER_EVENT_NAME.openDevTools,
    ({ event, params }) => pool.handleOpenDevTools(event.sender.id, params),
  )
  mainOn<LX.UserApi.UserApiRuntimeUpdateAlertEnvelope>(
    USER_API_RENDERER_EVENT_NAME.showUpdateAlert,
    ({ event, params }) => pool.handleShowUpdateAlert(event.sender.id, params),
  )
  mainOn<LX.UserApi.UserApiRuntimeControlEnvelope>(
    USER_API_RENDERER_EVENT_NAME.getProxy,
    ({ event, params }) => pool.handleGetProxy(event.sender.id, params),
  )
}

export const request = async(
  params: LX.UserApi.UserApiRequestParams,
  ownerWebContentsId: number,
) => getUserApiRuntimePool().request(
  'apiId' in params
    ? params
    : {
        apiId: global.lx.appSetting['common.apiSource'],
        requestId: params.requestKey,
        data: params.data,
      },
  ownerWebContentsId,
)

export const cancelRequest = (
  params: LX.UserApi.UserApiRequestCancelParams,
  ownerWebContentsId: number,
) => {
  getUserApiRuntimePool().cancel(
    typeof params == 'string'
      ? {
          apiId: global.lx.appSetting['common.apiSource'],
          requestId: params,
        }
      : params,
    ownerWebContentsId,
  )
}

export const getStatus = (apiId: string) => getUserApiRuntimePool().getStatus(apiId)

export const setAllowShowUpdateAlert = (_id: string, _enable: boolean) => {}
