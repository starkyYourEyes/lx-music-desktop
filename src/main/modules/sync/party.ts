import { clipboardWriteText } from '@common/utils/electron'
import { WIN_MAIN_RENDERER_EVENT_NAME } from '@common/ipcNames'
import { sendEvent } from '@main/modules/winMain/main'
import log from './log'
import { getClient } from './client/client'

const PARTY_PING_INTERVAL = 20_000

let room: LX.Party.RoomSnapshot | null = null
let isPartyModuleReady = false
let heartbeatTimer: NodeJS.Timeout | null = null
let ensureRoomPromise: Promise<LX.Party.RoomSnapshot | null> | null = null

const getSelfClientId = () => getClient()?.data.keyInfo.clientId ?? null

const getState = (): LX.Party.StatePayload => ({
  room,
  selfClientId: getSelfClientId(),
})

const sendPartyState = () => {
  sendEvent(WIN_MAIN_RENDERER_EVENT_NAME.party_action, {
    action: 'state',
    data: getState(),
  } satisfies LX.Party.MainWindowActions)
}

const getRemote = () => {
  const client = getClient()
  if (!client?.isReady || !client.moduleReadys.party) return null
  return client.remoteQueueParty
}

const updateHeartbeat = () => {
  const shouldRun = !!room && isPartyModuleReady
  if (!shouldRun) {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
    return
  }
  if (heartbeatTimer) return
  heartbeatTimer = setInterval(() => {
    void pingPartyRoom().catch(err => {
      log.r_error('party_ping failed:', err)
    })
  }, PARTY_PING_INTERVAL)
}

const updateRoom = (nextRoom: LX.Party.RoomSnapshot | null) => {
  room = nextRoom
  updateHeartbeat()
  sendPartyState()
}

export const getPartyState = () => getState()

export const setPartyModuleReady = (ready: boolean) => {
  isPartyModuleReady = ready
  updateHeartbeat()
  sendPartyState()
  if (ready) void ensurePartyRoomLoaded()
}

export const handlePartyRoomSnapshot = (nextRoom: LX.Party.RoomSnapshot | null) => {
  updateRoom(nextRoom)
}

export const ensurePartyRoomLoaded = async() => {
  if (ensureRoomPromise) return ensureRoomPromise
  const remote = getRemote()
  if (!remote) return null
  ensureRoomPromise = remote.party_room_get_current()
    .then(nextRoom => {
      handlePartyRoomSnapshot(nextRoom)
      return nextRoom
    })
    .finally(() => {
      ensureRoomPromise = null
    })
  return ensureRoomPromise
}

export const createPartyRoom = async(input: LX.Party.RoomCreateInput) => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  const nextRoom = await remote.party_room_create({
    ...input,
    controlMode: 'all',
    maxMembers: 8,
  })
  handlePartyRoomSnapshot(nextRoom)
  return getState()
}

export const joinPartyRoom = async(input: LX.Party.RoomJoinInput) => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  const nextRoom = await remote.party_room_join(input)
  handlePartyRoomSnapshot(nextRoom)
  return getState()
}

export const leavePartyRoom = async() => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  await remote.party_room_leave()
  handlePartyRoomSnapshot(null)
  return getState()
}

export const dismissPartyRoom = async() => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  await remote.party_room_dismiss()
  handlePartyRoomSnapshot(null)
  return getState()
}

export const syncPartyPlayback = async(input: LX.Party.PlaybackUpdateInput) => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  const nextRoom = await remote.party_playback_update(input)
  handlePartyRoomSnapshot(nextRoom)
  return getState()
}

export const appendPartyQueue = async(queue: LX.Party.QueueItemInput[]) => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  const nextRoom = await remote.party_queue_append(queue)
  handlePartyRoomSnapshot(nextRoom)
  return getState()
}

export const removePartyQueueItems = async(ids: string[]) => {
  const remote = getRemote()
  if (!remote) throw new Error('Sync service is not connected')
  const nextRoom = await remote.party_queue_remove(ids)
  handlePartyRoomSnapshot(nextRoom)
  return getState()
}

export const pingPartyRoom = async(input?: LX.Party.MemberUpdateInput) => {
  const remote = getRemote()
  if (!remote) return getState()
  const nextRoom = await remote.party_ping(input)
  handlePartyRoomSnapshot(nextRoom)
  return getState()
}

export const copyPartyRoomCode = () => {
  if (!room) return
  clipboardWriteText(room.roomCode)
}
