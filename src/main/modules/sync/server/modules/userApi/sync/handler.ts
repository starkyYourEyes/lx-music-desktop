import { SYNC_CLOSE_CODE } from '@common/constants_sync'
import { assertUserApiSyncData, mergeUserApiSyncData } from '@common/utils/userApiSync'
import log from '@main/modules/sync/log'
import {
  getLocalUserApiData,
  getLocalUserApiMeta,
  handleRemoteUserApiAction,
  setLocalUserApiData,
} from '@main/modules/sync/userApiEvent'

const assertUserApiReady = (socket: LX.Sync.Server.Socket) => {
  if (!socket.feature?.userApi || !socket.moduleReadys?.userApi) throw new Error('userApi sync is not ready')
}

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
  async user_api_get_meta(socket) {
    assertUserApiReady(socket)
    return getLocalUserApiMeta()
  },

  async user_api_pull(socket, mode, data) {
    assertUserApiReady(socket)
    if (mode == 'overwrite') return getLocalUserApiData()
    if (!data) throw new Error('local userApi data is required for merge pull')
    assertUserApiSyncData(data)
    return mergeUserApiSyncData(data, await getLocalUserApiData())
  },

  async user_api_push(socket, data, mode) {
    assertUserApiReady(socket)
    // Runtime settings may be missing or malformed; only an explicit true grants consent.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-boolean-literal-compare
    if (global.lx.appSetting['sync.server.allowUserApiPush'] !== true) throw new Error('user_api_push_not_allowed')
    assertUserApiSyncData(data)
    const updatedAt = Date.now()
    const nextData = mode == 'overwrite'
      ? { ...data, updatedAt }
      : mergeUserApiSyncData(await getLocalUserApiData(), data, { updatedAt })
    await setLocalUserApiData(nextData)
    const meta = await getLocalUserApiMeta()
    try {
      log.info('user_api_push accepted', { deviceName: socket.keyInfo.deviceName, clientId: socket.keyInfo.clientId, count: meta.count, md5: meta.md5 })
    } catch {
      // Logging must not reject a push that has already been persisted.
    }
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
