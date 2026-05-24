import log from '@main/modules/sync/log'
import { ensurePartyRoomLoaded, handlePartyRoomSnapshot, setPartyModuleReady } from '@main/modules/sync/party'

const logInfo = (eventName: string) => {
  log.info(`[${eventName}] party sync action`)
}

const handler: LX.Sync.ClientSyncHandlerPartyActions<LX.Sync.Client.Socket> = {
  async onPartySyncAction(socket, action) {
    logInfo(`party:${action.data.reason}`)
    handlePartyRoomSnapshot(action.data.room)
  },

  async party_sync_set_room_state(socket, room) {
    logInfo('party:set_room_state')
    handlePartyRoomSnapshot(room)
  },

  async party_sync_finished(socket) {
    logInfo('party:finished')
    socket.moduleReadys.party = true
    setPartyModuleReady(true)
    socket.onClose(() => {
      setPartyModuleReady(false)
    })
    await ensurePartyRoomLoaded()
  },
}

export default handler
