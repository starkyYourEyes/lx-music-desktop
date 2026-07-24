import { SYNC_CLOSE_CODE } from '@common/constants_sync'
import { registerUserApiActionEvent, getLocalUserApiMeta } from '@main/modules/sync/userApiEvent'

let unregisterLocalUserApiAction: (() => void) | null

export const sendUserApiAction = async(wss: LX.Sync.Server.SocketServer, action: LX.Sync.UserApi.ActionList) => {
  const tasks: Array<Promise<void>> = []
  for (const client of wss.clients) {
    if (!client.moduleReadys?.userApi) continue
    tasks.push(client.remoteQueueUserApi.onUserApiSyncAction(action).catch(err => {
      client.close(SYNC_CLOSE_CODE.failed)
      console.log(err.message)
    }))
  }
  await Promise.all(tasks)
}

export const broadcastCurrentUserApiMeta = async(wss: LX.Sync.Server.SocketServer) => {
  await sendUserApiAction(wss, {
    action: 'user_api_data_changed',
    data: await getLocalUserApiMeta(),
  })
}

export const registerEvent = (wss: LX.Sync.Server.SocketServer) => {
  unregisterEvent()
  unregisterLocalUserApiAction = registerUserApiActionEvent((action) => {
    void sendUserApiAction(wss, action)
  })
}

export const unregisterEvent = () => {
  unregisterLocalUserApiAction?.()
  unregisterLocalUserApiAction = null
}
