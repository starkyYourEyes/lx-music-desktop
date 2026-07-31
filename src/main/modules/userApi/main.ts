import { mainSend } from '@common/mainIpc'
import { log } from '@common/utils'
import { openDevTools as handleOpenDevTools } from '@main/utils'
import USER_API_RENDERER_EVENT_NAME from './rendererEvent/name'
import {
  createRuntimeWindow,
  disposeRuntimeWindow,
  initializeRuntimeWindow,
  type UserApiRuntimeWindow,
} from './runtimeWindow'

let activeRuntime: UserApiRuntimeWindow | null = null
let runtimeGeneration = 0

export const getProxy = () => {
  if (global.lx.appSetting['network.proxy.enable'] && global.lx.appSetting['network.proxy.host']) {
    return {
      host: global.lx.appSetting['network.proxy.host'],
      port: global.lx.appSetting['network.proxy.port'],
    }
  }
  const envProxy = envParams.cmdParams['proxy-server']
  if (typeof envProxy == 'string') {
    const [host, port = ''] = envProxy.split(':')
    return { host, port }
  }
  return { host: '', port: '' }
}

export const sendRuntimeEvent = <T>(
  runtime: UserApiRuntimeWindow,
  name: string,
  payload?: T,
) => {
  if (runtime.window.isDestroyed()) return false
  mainSend(runtime.window, name, payload)
  return true
}

const handleUpdateProxy = (keys: Array<keyof LX.AppSetting>) => {
  if (keys.includes('network.proxy.enable') || (global.lx.appSetting['network.proxy.enable'] && keys.some(key => key.startsWith('network.proxy.')))) {
    sendEvent(USER_API_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
  }
}

const releaseActiveRuntime = (identity: LX.UserApi.UserApiRuntimeIdentity) => {
  if (!activeRuntime || activeRuntime.identity.apiId != identity.apiId || activeRuntime.identity.generation != identity.generation) return
  global.lx.event_app.off('updated_config', handleUpdateProxy)
  activeRuntime = null
}

export const createWindow = async(apiInfo: LX.UserApi.UserApiInfo) => {
  await closeWindow()
  const runtime = await createRuntimeWindow({
    apiInfo,
    generation: ++runtimeGeneration,
    hooks: {
      onClosed: releaseActiveRuntime,
      onRenderProcessGone: (identity, details) => {
        log.error(`user API runtime process exited: ${identity.apiId}`, details)
      },
    },
  })
  activeRuntime = runtime
  global.lx.event_app.on('updated_config', handleUpdateProxy)
  await initializeRuntimeWindow(runtime, apiInfo)
}

export const closeWindow = async() => {
  const runtime = activeRuntime
  if (!runtime) return
  await disposeRuntimeWindow(runtime, { clearSession: true })
  releaseActiveRuntime(runtime.identity)
}

export const sendEvent = <T>(name: string, params?: T) => {
  if (!activeRuntime) return false
  return sendRuntimeEvent(activeRuntime, name, params)
}

export const openDevTools = (runtime = activeRuntime) => {
  if (!runtime) return
  if (runtime.window.isDestroyed()) return
  handleOpenDevTools(runtime.window.webContents)
}

export {
  clearRuntimeSession,
  createRuntimeWindow,
  disposeRuntimeWindow,
  getRuntimePartition,
  initializeRuntimeWindow,
} from './runtimeWindow'
export type {
  CreateUserApiRuntimeWindowOptions,
  UserApiRuntimeWindow,
  UserApiRuntimeWindowDependencies,
  UserApiRuntimeWindowHooks,
} from './runtimeWindow'
