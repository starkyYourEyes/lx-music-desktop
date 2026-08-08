import { log } from '@common/utils'
import { buildMovedUserListOrder } from '@common/listGroup'
import { updateUserListPosition } from '@renderer/store/list/action'
import { userLists } from '@renderer/store/list/state'
import { userListGroups } from '@renderer/store/list/group'

export const persistExactUserListOrder = async(ids: readonly string[]): Promise<void> => {
  for (let position = 0; position < ids.length; position++) {
    const current = userLists.findIndex(item => item.id == ids[position])
    if (current != position) await updateUserListPosition({ ids: [ids[position]], position })
  }
}

export const reorderUserListWithinGroup = async({ id, group, toIndex }: {
  id: string
  group: LX.List.UserListGroup
  toIndex: number
}): Promise<void> => {
  const oldOrder = userLists.map(list => list.id)
  const nextOrder = buildMovedUserListOrder(userLists, userListGroups, id, group, toIndex)
  try {
    await persistExactUserListOrder(nextOrder)
  } catch (error) {
    await persistExactUserListOrder(oldOrder).catch(log.error)
    throw error
  }
}
