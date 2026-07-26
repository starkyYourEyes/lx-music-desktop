import { getClient } from '../../client'
import {
  getLocalUserApiData,
  setLocalUserApiData,
} from '@main/modules/sync/userApiEvent'
import { createUserApiSyncMeta } from '@common/utils/userApiSync'

const getReadyUserApiClient = () => {
  const socket = getClient()
  if (!socket?.isReady || !socket.moduleReadys?.userApi) {
    throw new Error('userApi sync is not ready')
  }
  return socket
}

export const getRemoteUserApiMeta = async(): Promise<LX.Sync.UserApi.Meta> => {
  return getReadyUserApiClient().remoteQueueUserApi.user_api_get_meta()
}

export const pullUserApiFromServer = async(mode: LX.Sync.UserApi.SyncMode): Promise<LX.Sync.UserApi.Meta> => {
  const socket = getReadyUserApiClient()
  const localData = mode == 'merge' ? await getLocalUserApiData() : undefined
  const data = await socket.remoteQueueUserApi.user_api_pull(mode, localData)
  await setLocalUserApiData(data)
  return createUserApiSyncMeta(data)
}

export const pushUserApiToServer = async(mode: LX.Sync.UserApi.SyncMode): Promise<LX.Sync.UserApi.Meta> => {
  return getReadyUserApiClient().remoteQueueUserApi.user_api_push(await getLocalUserApiData(), mode)
}
