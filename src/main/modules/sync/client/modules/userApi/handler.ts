import {
  handleRemoteUserApiAction,
} from '@main/modules/sync/userApiEvent'
import log from '@main/modules/sync/log'

const logInfo = (eventName: string, success = false) => {
  log.info(`[${eventName}]${eventName.replace('userApi:sync:user_api_sync_', '').replaceAll('_', ' ')}${success ? ' success' : ''}`)
}

const handler: LX.Sync.ClientSyncHandlerUserApiActions<LX.Sync.Client.Socket> = {
  async onUserApiSyncAction(socket, action) {
    if (!socket.moduleReadys?.userApi) return
    await handleRemoteUserApiAction(action)
  },

  async user_api_sync_finished(socket) {
    logInfo('userApi:sync:finished')
    socket.moduleReadys.userApi = true
  },
}

export default handler
