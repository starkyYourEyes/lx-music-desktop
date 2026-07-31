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

const reconcileRetainedUserApiState = (
  err: unknown,
  apiList: LX.UserApi.UserApiInfo[],
  removedIds: ReadonlySet<string>,
  configErrorMessage: string,
) => {
  if (err != null && (typeof err == 'object' || typeof err == 'function')) {
    replacementFailureApiLists.set(err, apiList)
  }
  try {
    removeUnavailablePlaybackSources(removedIds)
  } catch (configErr) {
    log.error(configErrorMessage, configErr)
  }
  notifyUserApiChanged()
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

const cloneUserApiList = (
  apiList: readonly LX.UserApi.UserApiInfo[],
): LX.UserApi.UserApiInfo[] => apiList.map(api => api.remote
  ? { ...api, remote: { ...api.remote } }
  : { ...api })

const cloneUserApiState = (state: UserApiState): UserApiState => ({
  apiList: cloneUserApiList(state.apiList),
  scripts: new Map(state.scripts),
})

const applyRuntimeChanges = async(
  runtimePool: UserApiRuntimePool,
  changedIds: ReadonlySet<string>,
  removedIds: ReadonlySet<string>,
) => {
  const results = await Promise.allSettled([
    ...[...changedIds].map(async id => runtimePool.invalidate(id, 'sourceChanged')),
    ...[...removedIds].map(async id => runtimePool.dispose(id, { clearSession: true })),
  ])
  const failure = results.find((result): result is PromiseRejectedResult => {
    return result.status == 'rejected'
  })
  if (failure) throw failure.reason
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
  return runUserApiTask(async() => {
    const previousState = cloneUserApiState(getUserApiState())
    const previousIds = new Set(previousState.apiList.map(api => api.id))
    const nextState = await prepareApisFromGitHub(items)
    const apiList = commitUserApiState(nextState)
    const failureApiList = cloneUserApiList(apiList)
    const removedIds = getRemovedUserApiIds(previousIds, apiList)
    try {
      await applyRuntimeChanges(
        getUserApiRuntimePool(),
        getChangedUserApiIds(previousState, nextState),
        removedIds,
      )
    } catch (err) {
      try {
        commitUserApiState(previousState)
      } catch (rollbackErr) {
        log.error('rollback user APIs after GitHub runtime lifecycle error:', rollbackErr)
        if (err != null && (typeof err == 'object' || typeof err == 'function')) {
          replacementFailureApiLists.set(err, failureApiList)
        }
        notifyUserApiChanged()
      }
      throw err
    }
    removeUnavailablePlaybackSources(removedIds)
    notifyUserApiChanged()
    return apiList
  })
}

export const overwriteUserApisFromSync = async(data: LX.Sync.UserApi.Data): Promise<void> => {
  return runUserApiTask(async() => {
    const previousState = cloneUserApiState(getUserApiState())
    const previousIds = new Set(previousState.apiList.map(api => api.id))
    const nextState = await prepareUserApisFromSync(data)
    const apiList = commitUserApiState(nextState)
    const failureApiList = cloneUserApiList(apiList)
    const removedIds = getRemovedUserApiIds(previousIds, apiList)
    try {
      await applyRuntimeChanges(
        getUserApiRuntimePool(),
        getChangedUserApiIds(previousState, nextState),
        removedIds,
      )
    } catch (err) {
      try {
        commitUserApiState(previousState)
      } catch (rollbackErr) {
        log.error('rollback user APIs after sync runtime lifecycle error:', rollbackErr)
        reconcileRetainedUserApiState(
          err,
          failureApiList,
          removedIds,
          'cleanup playback fallbacks after sync rollback failure:',
        )
      }
      throw err
    }
    removeUnavailablePlaybackSources(removedIds)
  })
}

export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  return runUserApiTask(async() => {
    const currentState = getUserApiState()
    const previousState = cloneUserApiState(currentState)
    const removedIds = new Set(currentState.apiList
      .map(api => api.id)
      .filter(id => ids.includes(id)))
    if (!removedIds.size) return currentState.apiList

    const nextScripts = new Map(currentState.scripts)
    for (const id of removedIds) nextScripts.delete(id)
    const nextState: UserApiState = {
      apiList: currentState.apiList.filter(api => !removedIds.has(api.id)),
      scripts: nextScripts,
    }
    const apiList = commitUserApiState(nextState)
    const failureApiList = cloneUserApiList(apiList)
    try {
      await applyRuntimeChanges(getUserApiRuntimePool(), new Set(), removedIds)
    } catch (err) {
      try {
        commitUserApiState(previousState)
      } catch (rollbackErr) {
        log.error('rollback user APIs after deletion runtime lifecycle error:', rollbackErr)
        reconcileRetainedUserApiState(
          err,
          failureApiList,
          removedIds,
          'cleanup playback fallbacks after deletion rollback failure:',
        )
      }
      throw err
    }
    removeUnavailablePlaybackSources(removedIds)
    notifyUserApiChanged()
    return apiList
  })
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
