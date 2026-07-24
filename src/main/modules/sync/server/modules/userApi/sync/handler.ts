import { SYNC_CLOSE_CODE } from '@common/constants_sync'
import { assertUserApiSyncData, mergeUserApiSyncData } from '@common/utils/userApiSync'
import {
  getLocalUserApiData,
  getLocalUserApiMeta,
  handleRemoteUserApiAction,
  setLocalUserApiData,
} from '@main/modules/sync/userApiEvent'

const notifyUserApiChanged = async(socket: LX.Sync.Server.Socket, meta: LX.Sync.UserApi.Meta) => {
  const currentUserName = socket.userInfo.name
  const currentId = socket.keyInfo.clientId
  const action: LX.Sync.UserApi.ActionList = {
    action: 'user_api_data_changed',
    data: meta,
  }

  socket.broadcast((client) => {
    if (client.keyInfo.clientId == currentId || !client.moduleReadys?.userApi || client.userInfo.name != currentUserName) return
    void client.remoteQueueUserApi.onUserApiSyncAction(action).catch(err => {
      client.close(SYNC_CLOSE_CODE.failed)
      console.log(err.message)
    })
  })
}

const handler: LX.Sync.ServerSyncHandlerUserApiActions<LX.Sync.Server.Socket> = {
  async user_api_get_meta() {
    return getLocalUserApiMeta()
  },

  async user_api_pull(socket, mode, data) {
    if (mode == 'overwrite') return getLocalUserApiData()
    if (!data) throw new Error('local userApi data is required for merge pull')
    assertUserApiSyncData(data)
    return mergeUserApiSyncData(data, await getLocalUserApiData())
  },

  async user_api_push(socket, data, mode) {
    assertUserApiSyncData(data)
    const updatedAt = Date.now()
    const nextData = mode == 'overwrite'
      ? { ...data, updatedAt }
      : mergeUserApiSyncData(await getLocalUserApiData(), data, { updatedAt })
    await setLocalUserApiData(nextData)
    const meta = await getLocalUserApiMeta()
    await notifyUserApiChanged(socket, meta)
    return meta
  },

  async onUserApiSyncAction(socket, action) {
    if (!socket.moduleReadys.userApi) return
    await handleRemoteUserApiAction(action)
    await notifyUserApiChanged(socket, action.data)
  },
}

export default handler
