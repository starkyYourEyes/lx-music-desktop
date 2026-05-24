import { clipboardWriteText } from '@common/utils/electron'
import { canControlPartyPlayback, getPartySelfMember, party, setPartyState } from '@renderer/store/party'
import { sendPartyAction } from '@renderer/utils/ipc'

const errorMessageMap: Record<string, string> = {
  'room not found': '房间不存在',
  'invalid room password': '房间密码错误',
  'room is full': '房间已满',
  'member is not in any room': '你当前不在任何房间内',
  'only host can do this operation': '仅房主可执行此操作',
  'target member not found': '目标成员不存在',
  'host can not remove itself': '房主不能移除自己',
  'currentIndex out of range': '当前播放索引超出范围',
  'queue item not found': '播放队列项不存在',
  'maxMembers can not be smaller than current member count': '最大成员数不能小于当前成员数',
  'roomCode must be 4-12 chars of A-Z or 0-9': '房间号需为 4 到 12 位大写字母或数字',
  'roomCode already exists': '该房间号已被使用',
  'Sync service is not connected': '同步服务未连接',
}

export const getPartyErrorMessage = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  return errorMessageMap[message] ?? message
}

export const loadPartyState = async() => {
  const state = await sendPartyAction<LX.Party.StatePayload>({ action: 'get_state' })
  setPartyState(state)
  return state
}

export const createPartyRoom = async(input: LX.Party.RoomCreateInput) => {
  const state = await sendPartyAction<LX.Party.StatePayload>({
    action: 'create_room',
    data: input,
  })
  setPartyState(state)
  return state
}

export const joinPartyRoom = async(input: LX.Party.RoomJoinInput) => {
  const state = await sendPartyAction<LX.Party.StatePayload>({
    action: 'join_room',
    data: input,
  })
  setPartyState(state)
  return state
}

export const leavePartyRoom = async() => {
  const state = await sendPartyAction<LX.Party.StatePayload>({ action: 'leave_room' })
  setPartyState(state)
  return state
}

export const dismissPartyRoom = async() => {
  const state = await sendPartyAction<LX.Party.StatePayload>({ action: 'dismiss_room' })
  setPartyState(state)
  return state
}

export const pingPartyRoom = async(input?: LX.Party.MemberUpdateInput) => {
  const state = await sendPartyAction<LX.Party.StatePayload>({
    action: 'ping',
    data: input,
  })
  setPartyState(state)
  return state
}

export const syncPartyPlayback = async(input: LX.Party.PlaybackUpdateInput) => {
  const state = await sendPartyAction<LX.Party.StatePayload>({
    action: 'sync_playback',
    data: input,
  })
  setPartyState(state)
  return state
}

export const getPartyQueue = (room = party.room) => room?.playback.queue ?? []

export const appendPartyQueue = async(queue: LX.Party.QueueItemInput[]) => {
  const state = await sendPartyAction<LX.Party.StatePayload>({
    action: 'queue_append',
    data: queue,
  })
  setPartyState(state)
  return state
}

export const removePartyQueueItems = async(ids: string[]) => {
  const state = await sendPartyAction<LX.Party.StatePayload>({
    action: 'queue_remove',
    data: ids,
  })
  setPartyState(state)
  return state
}

export const copyPartyRoomCode = () => {
  if (!party.room) return
  clipboardWriteText(party.room.roomCode)
}

export {
  canControlPartyPlayback,
  getPartySelfMember,
}
