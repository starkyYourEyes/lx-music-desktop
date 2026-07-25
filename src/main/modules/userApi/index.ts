import { log } from '@common/utils'
import { closeWindow } from './main'
import {
  getUserApis,
  importApi as handleImportApi,
  removeApi as handleRemoveApi,
  replaceApisFromGitHub as handleReplaceApisFromGitHub,
  setAllowShowUpdateAlert as saveAllowShowUpdateAlert,
} from './utils'
import { loadApi, setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert, init } from './rendererEvent/rendererEvent'

let userApiId: string | null = null
let lifecycleQueue = Promise.resolve()

const setUserApiId = (id: string | null) => {
  userApiId = id
}

const runLifecycleTask = async<T>(task: () => Promise<T>): Promise<T> => {
  const result = lifecycleQueue.then(task)
  lifecycleQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export const getApiList = getUserApis

export const importApi = async(script: string): Promise<LX.UserApi.ImportUserApi> => {
  return {
    apiInfo: await handleImportApi(script),
    apiList: getUserApis(),
  }
}

export const replaceApisFromGitHub = async(
  items: LX.UserApi.GitHubImportItem[],
): Promise<LX.UserApi.UserApiInfo[]> => {
  return runLifecycleTask(async() => {
    const apiList = await handleReplaceApisFromGitHub(items)
    if (!userApiId) return apiList

    const activeId = userApiId
    try {
      await closeWindow()
    } catch (err) {
      log.error('close active user API after GitHub replacement error:', err)
      throw err
    }
    setUserApiId(null)
    if (apiList.some(api => api.id === activeId)) {
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
        throw err
      }
    }
    return apiList
  })
}

export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  return runLifecycleTask(async() => {
    if (userApiId && ids.includes(userApiId)) {
      await closeWindow()
      setUserApiId(null)
    }
    handleRemoveApi(ids)
    return getUserApis()
  })
}

export const setApi = async(id: string): Promise<void> => {
  return runLifecycleTask(async() => {
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

export const setAllowShowUpdateAlert = (id: string, enable: boolean) => {
  saveAllowShowUpdateAlert(id, enable)
  setRendererEventAllowShowUpdateAlert(id, enable)
}


export * from './rendererEvent/rendererEvent'

export default () => {
  init()

  global.lx.event_app.on('main_window_close', () => {
    void closeWindow()
  })
}
