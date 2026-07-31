import { mainSend } from '@common/mainIpc'
import { openDevTools as handleOpenDevTools } from '@main/utils'
import type { UserApiRuntimeWindow } from './runtimeWindow'

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

export const openDevTools = (runtime: UserApiRuntimeWindow) => {
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
