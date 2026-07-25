import {
  createUserApiSyncMD5,
  createUserApiSyncMeta,
  mergeUserApiSyncData,
} from '@common/utils/userApiSync'
import {
  getUserApiSyncData,
  overwriteUserApisFromSync,
} from '@main/modules/userApi'
import log from '@main/modules/sync/log'

export const getLocalUserApiData = async(): Promise<LX.Sync.UserApi.Data> => {
  return getUserApiSyncData()
}

export const getLocalUserApiMD5 = async(): Promise<string> => {
  return createUserApiSyncMD5(await getLocalUserApiData())
}

export const getLocalUserApiMeta = async(): Promise<LX.Sync.UserApi.Meta> => {
  return createUserApiSyncMeta(await getLocalUserApiData())
}

export const setLocalUserApiData = async(data: LX.Sync.UserApi.Data) => {
  await overwriteUserApisFromSync(data)
}

export const mergeLocalUserApiData = async(
  incomingData: LX.Sync.UserApi.Data,
  incomingWins: boolean,
): Promise<LX.Sync.UserApi.Data> => {
  const localData = await getLocalUserApiData()
  const mergedData = incomingWins
    ? mergeUserApiSyncData(localData, incomingData)
    : mergeUserApiSyncData(incomingData, localData)
  await setLocalUserApiData(mergedData)
  return mergedData
}

export const registerUserApiActionEvent = (
  sendAction: (action: LX.Sync.UserApi.ActionList) => (void | Promise<void>),
) => {
  const userApiChanged = async() => {
    await sendAction({
      action: 'user_api_data_changed',
      data: await getLocalUserApiMeta(),
    })
  }
  global.lx.event_app.on('user_api_changed', userApiChanged)

  return () => {
    global.lx.event_app.off('user_api_changed', userApiChanged)
  }
}

export const handleRemoteUserApiAction = async({ action, data }: LX.Sync.UserApi.ActionList) => {
  switch (action) {
    case 'user_api_data_changed':
      log.info(`remote userApi changed: count=${data.count}, updatedAt=${data.updatedAt}, md5=${data.md5}`)
      break
    default:
      throw new Error('unknown user api sync action')
  }
}
