/* eslint-disable @typescript-eslint/no-dynamic-delete */
import { log } from '@common/utils'
import { reactive, ref } from '@common/utils/vueTools'
import { isUserListGroup, resolveUserListGroup } from '@common/listGroup'
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

  const backfills: Array<Promise<void>> = []
  for (const list of lists) {
    const storedGroup = metadata[list.id]?.profile?.group
    const group = resolveUserListGroup(list, storedGroup)
    userListGroups[list.id] = group
    if (!isUserListGroup(storedGroup)) {
      backfills.push(setUserListProfile(list.id, { group }).catch(error => {
        log.error(error)
      }))
    }
  }
  await Promise.all(backfills)
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
