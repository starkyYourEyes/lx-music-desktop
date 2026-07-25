import { closeWindow } from './main'
import {
  getUserApis,
  importApi as handleImportApi,
  removeApi as handleRemoveApi,
  replaceApisFromGitHub as handleReplaceApisFromGitHub,
  setAllowShowUpdateAlert as saveAllowShowUpdateAlert,
} from './utils'
import { loadApi, setAllowShowUpdateAlert as setRendererEventAllowShowUpdateAlert, init } from './rendererEvent/rendererEvent'

let userApiId: string | null

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
  const apiList = await handleReplaceApisFromGitHub(items)
  if (!userApiId) return apiList

  const activeId = userApiId
  userApiId = null
  await closeWindow()
  if (userApiId) return apiList
  if (apiList.some(api => api.id === activeId)) {
    // eslint-disable-next-line require-atomic-updates
    userApiId = activeId
    await loadApi(activeId)
  }
  return apiList
}
export const removeApi = async(ids: string[]): Promise<LX.UserApi.UserApiInfo[]> => {
  if (userApiId && ids.includes(userApiId)) {
    userApiId = null
    await closeWindow()
  }
  handleRemoveApi(ids)
  return getUserApis()
}

export const setApi = async(id: string) => {
  if (userApiId) {
    userApiId = null
    await closeWindow()
  }
  const apiList = getUserApis()
  if (!apiList.some(a => a.id === id)) return
  userApiId ||= id
  await loadApi(id)
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
