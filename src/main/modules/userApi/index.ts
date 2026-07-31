import { log } from '@common/utils'
import { closeWindow } from './main'
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
} from './utils'
import { runUserApiTask } from './queue'
import { loadApi, setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert, init } from './rendererEvent/rendererEvent'

let userApiId: string | null = null
const replacementFailureApiLists = new WeakMap<object, LX.UserApi.UserApiInfo[]>()

export const takeReplacementFailureApiList = (
  err: unknown,
): LX.UserApi.UserApiInfo[] | undefined => {
  if (err == null || (typeof err != 'object' && typeof err != 'function')) return
  const apiList = replacementFailureApiLists.get(err)
  replacementFailureApiLists.delete(err)
  return apiList
}


const setUserApiId = (id: string | null) => {
  userApiId = id
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

const restoreActiveRuntime = async(activeId: string, message: string) => {
  try {
    await loadApi(activeId)
    setUserApiId(activeId)
  } catch (restoreErr) {
    log.error(message, restoreErr)
    try {
      await closeWindow()
    } catch (cleanupErr) {
      log.error('cleanup failed user API runtime restoration error:', cleanupErr)
    }
  }
}

export const getApiList = async(): Promise<LX.UserApi.UserApiInfo[]> => {
  return runUserApiTask(async() => getUserApis())
}

export const getUserApiSyncData = async(): Promise<LX.Sync.UserApi.Data> => {
  return runUserApiTask(handleGetUserApiSyncData)
}

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
    const previousIds = new Set(getUserApis().map(api => api.id))
    const nextState = await prepareApisFromGitHub(items)
    const activeId = userApiId
    const previousState = activeId ? getUserApiState() : null

    if (activeId) {
      try {
        await closeWindow()
      } catch (err) {
        log.error('close active user API before GitHub replacement error:', err)
        throw err
      }
      setUserApiId(null)
    }

    let apiList: LX.UserApi.UserApiInfo[]
    try {
      apiList = commitUserApiState(nextState)
    } catch (err) {
      if (activeId) {
        await restoreActiveRuntime(
          activeId,
          'restore active user API after GitHub replacement commit error:',
        )
      }
      throw err
    }

    if (activeId && apiList.some(api => api.id === activeId)) {
      try {
        await loadApi(activeId)
        setUserApiId(activeId)
      } catch (err) {
        log.error('reload active user API after GitHub replacement error:', err)
        try {
          await closeWindow()
        } catch (cleanupErr) {
          log.error(
            'cleanup active user API after GitHub replacement error:',
            cleanupErr,
          )
        }

        let rollbackSucceeded = false
        try {
          commitUserApiState(previousState!)
          rollbackSucceeded = true
        } catch (rollbackErr) {
          log.error('rollback user APIs after GitHub replacement error:', rollbackErr)
          if (err != null && (typeof err == 'object' || typeof err == 'function')) {
            replacementFailureApiLists.set(err, apiList)
          }
          notifyUserApiChanged()
        }
        if (rollbackSucceeded) {
          await restoreActiveRuntime(
            activeId,
            'restore previous active user API after GitHub replacement error:',
          )
        }
        throw err
      }
    }

    removeUnavailablePlaybackSources(getRemovedUserApiIds(previousIds, apiList))
    notifyUserApiChanged()
    return apiList
  })
}

export const overwriteUserApisFromSync = async(data: LX.Sync.UserApi.Data): Promise<void> => {
  return runUserApiTask(async() => {
    const previousIds = new Set(getUserApis().map(api => api.id))
    const nextState = await prepareUserApisFromSync(data)
    const apiList = commitUserApiState(nextState)
    removeUnavailablePlaybackSources(getRemovedUserApiIds(previousIds, apiList))
  })
}

export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  return runUserApiTask(async() => {
    const previousIds = new Set(getUserApis().map(api => api.id))
    if (userApiId && ids.includes(userApiId)) {
      await closeWindow()
      setUserApiId(null)
    }
    handleRemoveApi(ids)
    const apiList = getUserApis()
    removeUnavailablePlaybackSources(getRemovedUserApiIds(previousIds, apiList))
    return apiList
  })
}

export const setApi = async(id: string): Promise<void> => {
  return runUserApiTask(async() => {
    const apiList = getUserApis()
    const targetExists = apiList.some(api => api.id === id)
    if (!userApiId && !targetExists) return

    if (userApiId) {
      await closeWindow()
      setUserApiId(null)
    }
    if (!targetExists) return

    await loadApi(id)
    setUserApiId(id)
  })
}

export const setAllowShowUpdateAlert = async(
  id: string,
  enable: boolean,
): Promise<void> => {
  return runUserApiTask(async() => {
    saveAllowShowUpdateAlert(id, enable)
    setRendererEventAllowShowUpdateAlert(id, enable)
  })
}

export * from './rendererEvent/rendererEvent'

export default () => {
  init()

  global.lx.event_app.on('main_window_close', () => {
    void runUserApiTask(closeWindow)
  })
}
