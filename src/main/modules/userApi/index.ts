import { log } from '@common/utils'
import { sendShowUpdateAlert, sendStatusChange } from '@main/modules/winMain'
import {
  clearRuntimeSession,
  createRuntimeWindow,
  disposeRuntimeWindow,
  getProxy,
  initializeRuntimeWindow,
  openDevTools,
  sendRuntimeEvent,
} from './main'
import { runUserApiTask } from './queue'
import { init as initRendererEvents } from './rendererEvent/rendererEvent'
import {
  getUserApiRuntimePool,
  initializeUserApiRuntimePool,
  type UserApiRuntimePool,
} from './runtimePool'
import {
  commitUserApiState,
  getUserApis,
  getUserApiState,
  getUserApiSyncData as handleGetUserApiSyncData,
  importApi as handleImportApi,
  notifyUserApiChanged,
  prepareApisFromGitHub,
  prepareUserApisFromSync,
  removeApi as handleRemoveApi,
  setAllowShowUpdateAlert as saveAllowShowUpdateAlert,
  type UserApiState,
} from './utils'

const replacementFailureApiLists = new WeakMap<object, LX.UserApi.UserApiInfo[]>()

export const takeReplacementFailureApiList = (
  err: unknown,
): LX.UserApi.UserApiInfo[] | undefined => {
  if (err == null || (typeof err != 'object' && typeof err != 'function')) return
  const apiList = replacementFailureApiLists.get(err)
  replacementFailureApiLists.delete(err)
  return apiList
}

const removeUnavailablePlaybackSources = (removedIds: ReadonlySet<string>) => {
  if (!removedIds.size) return
  const nextFallbacks = global.lx.appSetting['common.apiFallbackSources']
    .filter(id => !removedIds.has(id))
  if (nextFallbacks.length == global.lx.appSetting['common.apiFallbackSources'].length) return
  global.lx.event_app.update_config({ 'common.apiFallbackSources': nextFallbacks })
}

const getRemovedUserApiIds = (
  previousIds: ReadonlySet<string>,
  nextList: readonly LX.UserApi.UserApiInfo[],
) => new Set([...previousIds].filter(id => !nextList.some(api => api.id == id)))

const scriptsEqual = (first: unknown, second: unknown) => {
  if (Buffer.isBuffer(first) && Buffer.isBuffer(second)) return first.equals(second)
  return first === second
}

const getChangedUserApiIds = (previous: UserApiState, next: UserApiState) => {
  const nextIds = new Set(next.apiList.map(api => api.id))
  return new Set(previous.apiList
    .map(api => api.id)
    .filter(id => nextIds.has(id) && !scriptsEqual(previous.scripts.get(id), next.scripts.get(id))))
}

const applyRuntimeChanges = async(
  runtimePool: UserApiRuntimePool,
  changedIds: ReadonlySet<string>,
  removedIds: ReadonlySet<string>,
) => {
  await Promise.all([
    ...[...changedIds].map(async id => runtimePool.invalidate(id, 'sourceChanged')),
    ...[...removedIds].map(async id => runtimePool.dispose(id, { clearSession: true })),
  ])
}

export const getApiList = async(): Promise<LX.UserApi.UserApiInfo[]> => getUserApis()

export const getUserApiSyncData = async(): Promise<LX.Sync.UserApi.Data> => handleGetUserApiSyncData()

export const importApi = async(script: string): Promise<LX.UserApi.ImportUserApi> => {
  return runUserApiTask(async() => ({
    apiInfo: await handleImportApi(script),
    apiList: getUserApis(),
  }))
}

export const replaceApisFromGitHub = async(
  items: LX.UserApi.GitHubImportItem[],
): Promise<LX.UserApi.UserApiInfo[]> => {
  const result = await runUserApiTask(async() => {
    const previousState = getUserApiState()
    const previousIds = new Set(previousState.apiList.map(api => api.id))
    const nextState = await prepareApisFromGitHub(items)
    const apiList = commitUserApiState(nextState)
    const removedIds = getRemovedUserApiIds(previousIds, apiList)
    removeUnavailablePlaybackSources(removedIds)
    notifyUserApiChanged()
    return {
      apiList,
      changedIds: getChangedUserApiIds(previousState, nextState),
      removedIds,
    }
  })
  await applyRuntimeChanges(getUserApiRuntimePool(), result.changedIds, result.removedIds)
  return result.apiList
}

export const overwriteUserApisFromSync = async(data: LX.Sync.UserApi.Data): Promise<void> => {
  const result = await runUserApiTask(async() => {
    const previousState = getUserApiState()
    const previousIds = new Set(previousState.apiList.map(api => api.id))
    const nextState = await prepareUserApisFromSync(data)
    const apiList = commitUserApiState(nextState)
    const removedIds = getRemovedUserApiIds(previousIds, apiList)
    removeUnavailablePlaybackSources(removedIds)
    return {
      changedIds: getChangedUserApiIds(previousState, nextState),
      removedIds,
    }
  })
  await applyRuntimeChanges(getUserApiRuntimePool(), result.changedIds, result.removedIds)
}

export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  const result = await runUserApiTask(async() => {
    const previousIds = new Set(getUserApis().map(api => api.id))
    handleRemoveApi(ids)
    const apiList = getUserApis()
    const removedIds = getRemovedUserApiIds(previousIds, apiList)
    removeUnavailablePlaybackSources(removedIds)
    return { apiList, removedIds }
  })
  await Promise.all([...result.removedIds].map(async id => {
    await getUserApiRuntimePool().dispose(id, { clearSession: true })
  }))
  return result.apiList
}

export const setApi = async(_id: string): Promise<void> => {}

export const setAllowShowUpdateAlert = async(
  id: string,
  enable: boolean,
): Promise<void> => {
  await runUserApiTask(async() => {
    saveAllowShowUpdateAlert(id, enable)
  })
}

export * from './rendererEvent/rendererEvent'

export default () => {
  const runtimePool = initializeUserApiRuntimePool({
    createRuntimeWindow,
    initializeRuntimeWindow,
    disposeRuntimeWindow,
    clearRuntimeSession,
    getApiInfo: apiId => getUserApis().find(api => api.id == apiId),
    send: sendRuntimeEvent,
    onProxyUpdate(handler) {
      const listener = (keys: Array<keyof LX.AppSetting>) => {
        if (keys.some(key => key.startsWith('network.proxy.'))) handler()
      }
      global.lx.event_app.on('updated_config', listener)
      return () => global.lx.event_app.off('updated_config', listener)
    },
    getProxy,
    openDevTools,
    showUpdateAlert: sendShowUpdateAlert,
    publishStatus: sendStatusChange,
    initialConfiguredApiIds: new Set([
      global.lx.appSetting['common.apiSource'],
      ...global.lx.appSetting['common.apiFallbackSources'],
    ].filter(Boolean)),
    logError: (message, reason) => log.error(message, reason),
    setTimeout,
    clearTimeout,
  })

  initRendererEvents(runtimePool)
  global.lx.event_app.on('updated_config', (keys) => {
    if (!keys.includes('common.apiSource') && !keys.includes('common.apiFallbackSources')) return
    const configured = new Set([
      global.lx.appSetting['common.apiSource'],
      ...global.lx.appSetting['common.apiFallbackSources'],
    ].filter(Boolean))
    void runtimePool.markConfigured(configured).catch(error => {
      log.error('mark configured user API runtimes failed', error)
    })
  })
  global.lx.storage?.registerShutdownFlusher('user-api-runtime-pool', async() => {
    await runtimePool.disposeAll()
  })
}
