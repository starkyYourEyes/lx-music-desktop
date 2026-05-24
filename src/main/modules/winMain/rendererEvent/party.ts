import { mainHandle } from '@common/mainIpc'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import {
  appendPartyQueue,
  createPartyRoom,
  dismissPartyRoom,
  getPartyState,
  joinPartyRoom,
  leavePartyRoom,
  pingPartyRoom,
  removePartyQueueItems,
  syncPartyPlayback,
} from '@main/modules/sync/party'
import { sendEvent } from '../main'

export default () => {
  mainHandle<LX.Party.ServiceActions, LX.Party.StatePayload>(WIN_MAIN_RENDERER_EVENT_NAME.party_action, async({ params: data }) => {
    switch (data.action) {
      case 'get_state':
        return getPartyState()
      case 'create_room':
        return createPartyRoom(data.data)
      case 'join_room':
        return joinPartyRoom(data.data)
      case 'leave_room':
        return leavePartyRoom()
      case 'dismiss_room':
        return dismissPartyRoom()
      case 'sync_playback':
        return syncPartyPlayback(data.data)
      case 'queue_append':
        return appendPartyQueue(data.data)
      case 'queue_remove':
        return removePartyQueueItems(data.data)
      case 'ping':
        return pingPartyRoom(data.data)
      default:
        return getPartyState()
    }
  })
}

export const sendPartyAction = (data: LX.Party.MainWindowActions) => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.party_action, data)
}
