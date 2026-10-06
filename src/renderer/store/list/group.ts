/* eslint-disable @typescript-eslint/no-dynamic-delete */
import { reactive, ref } from '@common/utils/vueTools'
import { resolveUserListGroup } from '@common/listGroup'
import { getListUpdateInfo, setUserListProfile } from '@renderer/utils/data'

export const userListGroups = reactive<Record<string, LX.List.UserListGroup>>({})
export const userListRevealRequest = ref<{ id: string, token: number } | null>(null)

let revealToken = 0

const hydrateGroups = async(lists: readonly LX.List.UserListInfo[]) => {
  const metadata = await getListUpdateInfo()
  const liveIds = new Set(lists.map(list => list.id))
  for (const id of Object.keys(userListGroups)) {
    if (!liveIds.has(id)) delete userListGroups[id]
  }

  for (const list of lists) {
    const storedGroup = metadata[list.id]?.profile?.group
    const group = resolveUserListGroup(list, storedGroup)
    userListGroups[list.id] = group
  }
  // A derived display group is not an edit. Persisting it here can race with
  // an explicit profile arriving after its playlist during initial sync.
}

export const initializeUserListGroups = hydrateGroups
export const ensureUserListGroups = hydrateGroups

export const getUserListGroup = (list: LX.List.UserListInfo) => {
  return userListGroups[list.id] ?? resolveUserListGroup(list, undefined)
}

export const cacheUserListGroup = (id: string, group: LX.List.UserListGroup) => {
  userListGroups[id] = group
}

export const setUserListGroup = async(id: string, group: LX.List.UserListGroup) => {
  await setUserListProfile(id, { group })
  userListGroups[id] = group
}

export const requestUserListReveal = (id: string) => {
  userListRevealRequest.value = { id, token: ++revealToken }
}

export const consumeUserListRevealRequest = (request: { id: string, token: number }) => {
  if (userListRevealRequest.value?.token != request.token) return false
  userListRevealRequest.value = null
  return true
}
