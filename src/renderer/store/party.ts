import { computed, reactive } from '@common/utils/vueTools'

export const party = reactive<{
  isShowModal: boolean
  room: LX.Party.RoomSnapshot | null
  selfClientId: string | null
}>({
  isShowModal: false,
  room: null,
  selfClientId: null,
})

export const setPartyState = (state: LX.Party.StatePayload) => {
  party.room = state.room
  party.selfClientId = state.selfClientId
}

export const getPartySelfMember = (room = party.room) => {
  if (!room || !party.selfClientId) return null
  return room.members.find(member => member.clientId === party.selfClientId) ?? null
}

export const partySelfMember = computed(() => getPartySelfMember())

export const canControlPartyPlayback = (room = party.room) => {
  if (!room) return false
  if (room.settings.controlMode === 'all') return true
  return getPartySelfMember(room)?.isHost === true
}
