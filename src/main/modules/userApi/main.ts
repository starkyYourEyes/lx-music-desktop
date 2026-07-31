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

const sourceRuntimes = new Map<string, UserApiRuntimeWindow>()
const sourceRuntimeCreations = new Map<string, Promise<UserApiRuntimeWindow>>()
const sourceRuntimeDisposals = new Map<string, Promise<void>>()
let legacyActiveApiId: string | null = null
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
    for (const apiId of sourceRuntimes.keys()) {
      sendSourceEvent(apiId, USER_API_RENDERER_EVENT_NAME.proxyUpdate, getProxy())
    }
  }
}

const releaseSourceRuntime = (identity: LX.UserApi.UserApiRuntimeIdentity) => {
  const runtime = sourceRuntimes.get(identity.apiId)
  if (!runtime || runtime.identity.generation != identity.generation) return
  sourceRuntimes.delete(identity.apiId)
  if (legacyActiveApiId == identity.apiId) legacyActiveApiId = null
  if (!sourceRuntimes.size) global.lx.event_app.off('updated_config', handleUpdateProxy)
}

export const getSourceRuntime = (apiId: string) => sourceRuntimes.get(apiId) ?? null

export const getSourceRuntimeByWebContentsId = (webContentsId: number) => {
  for (const runtime of sourceRuntimes.values()) {
    if (runtime.webContentsId == webContentsId) return runtime
  }
  return null
}

export const createSourceRuntime = async(apiInfo: LX.UserApi.UserApiInfo): Promise<UserApiRuntimeWindow> => {
  const pendingDisposal = sourceRuntimeDisposals.get(apiInfo.id)
  if (pendingDisposal) {
    await pendingDisposal
    return createSourceRuntime(apiInfo)
  }
  const existing = sourceRuntimes.get(apiInfo.id)
  if (existing) return existing
  const pendingCreation = sourceRuntimeCreations.get(apiInfo.id)
  if (pendingCreation) return pendingCreation

  const creation = Promise.resolve().then(async() => {
    let runtime: UserApiRuntimeWindow | null = null
    try {
      runtime = await createRuntimeWindow({
        apiInfo,
        generation: ++runtimeGeneration,
        hooks: {
          onClosed: releaseSourceRuntime,
          onRenderProcessGone: (identity, details) => {
            log.error(`user API runtime process exited: ${identity.apiId}`, details)
          },
        },
      })
      await initializeRuntimeWindow(runtime, apiInfo)
      sourceRuntimes.set(apiInfo.id, runtime)
      if (sourceRuntimes.size == 1) global.lx.event_app.on('updated_config', handleUpdateProxy)
      return runtime
    } catch (err) {
      if (runtime) {
        try {
          await disposeRuntimeWindow(runtime, { clearSession: true })
        } catch (disposeErr) {
          log.error(`failed to dispose user API runtime after initialization error: ${apiInfo.id}`, disposeErr)
        }
      }
      throw err
    }
  })
  sourceRuntimeCreations.set(apiInfo.id, creation)
  void creation.finally(() => {
    if (sourceRuntimeCreations.get(apiInfo.id) == creation) sourceRuntimeCreations.delete(apiInfo.id)
  }).catch(() => {})
  return creation
}

export const disposeSourceRuntime = async(apiId: string) => {
  const pendingDisposal = sourceRuntimeDisposals.get(apiId)
  if (pendingDisposal) return pendingDisposal
  const disposal = Promise.resolve().then(async() => {
    const pendingCreation = sourceRuntimeCreations.get(apiId)
    if (pendingCreation) {
      try {
        await pendingCreation
      } catch {
        return
      }
    }
    const runtime = sourceRuntimes.get(apiId)
    if (!runtime) return
    await disposeRuntimeWindow(runtime, { clearSession: true })
    releaseSourceRuntime(runtime.identity)
  })
  sourceRuntimeDisposals.set(apiId, disposal)
  try {
    await disposal
  } finally {
    if (sourceRuntimeDisposals.get(apiId) == disposal) sourceRuntimeDisposals.delete(apiId)
  }
}

export const sendSourceEvent = <T>(apiId: string, name: string, params?: T) => {
  const runtime = sourceRuntimes.get(apiId)
  if (!runtime) return false
  return sendRuntimeEvent(runtime, name, params)
}

export const createWindow = async(apiInfo: LX.UserApi.UserApiInfo) => {
  if (legacyActiveApiId && legacyActiveApiId != apiInfo.id) await closeWindow()
  const runtime = await createSourceRuntime(apiInfo)
  // Legacy lifecycle calls are serialized through runUserApiTask.
  // eslint-disable-next-line require-atomic-updates
  legacyActiveApiId = runtime.identity.apiId
  return runtime
}

export const closeWindow = async() => {
  const apiId = legacyActiveApiId
  if (!apiId) return
  await disposeSourceRuntime(apiId)
}

export const sendEvent = <T>(name: string, params?: T) => {
  return legacyActiveApiId == null ? false : sendSourceEvent(legacyActiveApiId, name, params)
}

export const openDevTools = (runtime = legacyActiveApiId == null ? null : sourceRuntimes.get(legacyActiveApiId)) => {
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
