import { mainOn } from '@common/mainIpc'

import USER_API_RENDERER_EVENT_NAME from './name'
import {
  createSourceRuntime,
  createWindow,
  getProxy,
  getSourceRuntimeByWebContentsId,
  openDevTools,
  sendSourceEvent,
} from '../main'
import { getUserApis } from '../utils'
import { sendShowUpdateAlert, sendStatusChange } from '@main/modules/winMain'

interface RuntimeState {
  apiInfo: LX.UserApi.UserApiInfo
  status: LX.UserApi.UserApiStatus
  requestQueue: Map<string, [(value: any) => void, (reason: Error) => void, any]>
  timeouts: Map<string, NodeJS.Timeout>
}

const runtimeStates = new Map<string, RuntimeState>()
let legacyUserApiId: string | null = null
interface InitParams {
  params: {
    status: boolean
    message: string
    data: LX.UserApi.UserApiInfo
  }
}
interface ResponseParams {
  params: {
    status: boolean
    message: string
    data: {
      requestKey: string
      result: any
    }
  }
}
interface UpdateInfoParams {
  params: {
    data: {
      log: string
      updateUrl: string
    }
  }
}

export const init = () => {
  const handleInit = ({ event, params: { status, message, data: apiInfo } }: InitParams & { event: Electron.IpcMainEvent }) => {
    const state = getRuntimeStateFromWebContents(event.sender.id)
    if (!state) return
    // console.log('inited')
    // if (!status) {
    //   console.log('init failed:', message)
    //   global.lx_event.userApi.status(status = { status: true, apiInfo: { ...userApi, sources: apiInfo.sources } })
    //   return
    // }
    state.status = status
      ? { apiId: state.apiInfo.id, status: true, apiInfo: { ...state.apiInfo, sources: apiInfo.sources } }
      : { apiId: state.apiInfo.id, status: false, apiInfo: state.apiInfo, message }
    sendStatusChange(state.status)
  }
  const handleResponse = ({ event, params: { status, data: { requestKey, result }, message } }: ResponseParams & { event: Electron.IpcMainEvent }) => {
    const state = getRuntimeStateFromWebContents(event.sender.id)
    if (!state) return
    const request = state.requestQueue.get(requestKey)
    if (!request) return
    state.requestQueue.delete(requestKey)
    clearRequestTimeout(state, requestKey)
    if (status) {
      request[0](result)
    } else {
      request[1](new Error(message))
    }
  }
  const handleOpenDevTools = ({ event }: { event: Electron.IpcMainEvent }) => {
    openDevTools(getSourceRuntimeByWebContentsId(event.sender.id))
  }
  const handleShowUpdateAlert = ({ event, params: { data } }: UpdateInfoParams & { event: Electron.IpcMainEvent }) => {
    const state = getRuntimeStateFromWebContents(event.sender.id)
    if (!state || !state.apiInfo.allowShowUpdateAlert) return
    sendShowUpdateAlert({
      name: state.apiInfo.name,
      description: state.apiInfo.description,
      log: data.log,
      updateUrl: data.updateUrl,
    })
  }
  const handleGetProxy = ({ event }: { event: Electron.IpcMainEvent }) => {
    const runtime = getSourceRuntimeByWebContentsId(event.sender.id)
    if (!runtime) return
    sendSourceEvent(runtime.identity.apiId, USER_API_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
  }
  mainOn(USER_API_RENDERER_EVENT_NAME.init, handleInit)
  mainOn(USER_API_RENDERER_EVENT_NAME.response, handleResponse)
  mainOn(USER_API_RENDERER_EVENT_NAME.openDevTools, handleOpenDevTools)
  mainOn(USER_API_RENDERER_EVENT_NAME.showUpdateAlert, handleShowUpdateAlert)
  mainOn(USER_API_RENDERER_EVENT_NAME.getProxy, handleGetProxy)
}

const getRuntimeState = (apiId: string): RuntimeState | null => {
  let state = runtimeStates.get(apiId)
  if (state) return state
  const apiInfo = getUserApis().find(api => api.id == apiId)
  if (!apiInfo) return null
  state = {
    apiInfo,
    status: { apiId, status: true },
    requestQueue: new Map(),
    timeouts: new Map(),
  }
  runtimeStates.set(apiId, state)
  return state
}

const getRuntimeStateFromWebContents = (webContentsId: number) => {
  const runtime = getSourceRuntimeByWebContentsId(webContentsId)
  return runtime ? getRuntimeState(runtime.identity.apiId) : null
}

export const clearRequestTimeout = (state: RuntimeState, requestKey: string) => {
  const timeout = state.timeouts.get(requestKey)
  if (timeout) {
    clearTimeout(timeout)
    state.timeouts.delete(requestKey)
  }
}

export const loadApi = async(apiId: string) => {
  if (!apiId) {
    sendStatusChange({ status: false, message: 'api id is null' })
    return
  }
  const targetApi = getUserApis().find(api => api.id == apiId)
  if (!targetApi) throw new Error('api not found')
  const state = getRuntimeState(apiId)
  if (!state) throw new Error('api not found')
  console.log('load api', state.apiInfo.name)
  await createWindow(state.apiInfo)
  legacyUserApiId = apiId
  // if (!userApi) return global.lx_event.userApi.status(status = { status: false, message: 'api script is not found' })
  // if (!global.modules.userApiWindow) {
  //   global.lx_event.userApi.status(status = { status: false, message: 'user api runtime is not defined' })
  //   throw new Error('user api window is not defined')
  // }

  // // const path = require('path')
  // // // eslint-disable-next-line no-undef
  // // userApi.script = require('fs').readFileSync(join(process.env.NODE_ENV !== 'production' ? __userApi : __dirname, 'renderer/test-api.js')).toString()
  // console.log('load api', userApi.name)
  // mainSend(global.modules.userApiWindow, USER_API_RENDERER_EVENT_NAME.init, { userApi })
}

export const cancelRequest = (params: LX.UserApi.UserApiRequestCancelParams) => {
  const apiId = typeof params == 'string' ? legacyUserApiId : params.apiId
  const requestKey = typeof params == 'string' ? params : params.requestId
  if (!apiId) return
  const state = runtimeStates.get(apiId)
  if (!state || !state.requestQueue.has(requestKey)) return
  const request = state.requestQueue.get(requestKey)!
  request[1](new Error('Cancel request'))
  state.requestQueue.delete(requestKey)
  clearRequestTimeout(state, requestKey)
}

export const request = async(params: LX.UserApi.UserApiRequestParams): Promise<any> => {
  const apiId = 'apiId' in params ? params.apiId : legacyUserApiId
  if (!apiId) throw new Error('user api is not load')
  const state = getRuntimeState(apiId)
  if (!state) throw new Error('api not found')
  await createSourceRuntime(state.apiInfo)
  const requestKey = 'requestKey' in params ? params.requestKey : params.requestId
  const { data } = params
  return await new Promise((resolve, reject) => {
    const timeout = state.timeouts.get(requestKey)
    if (timeout) {
      clearTimeout(timeout)
      state.timeouts.delete(requestKey)
      cancelRequest({ apiId, requestId: requestKey })
    }

    state.timeouts.set(requestKey, setTimeout(() => {
      cancelRequest({ apiId, requestId: requestKey, reason: 'timeout' })
    }, 20000))

    state.requestQueue.set(requestKey, [resolve, reject, data])
    sendSourceEvent(apiId, USER_API_RENDERER_EVENT_NAME.request, { requestKey, data })
  })
}

export const getStatus = (apiId = legacyUserApiId): LX.UserApi.UserApiStatus => (
  apiId == null ? { status: true } : runtimeStates.get(apiId)?.status ?? { apiId, status: true }
)

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  const state = runtimeStates.get(id)
  if (!state) return
  state.apiInfo.allowShowUpdateAlert = enable
}
