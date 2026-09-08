import { log } from '@common/utils'
import { buildMovedUserListOrder } from '@common/listGroup'
import { getUserLists, updateUserListPosition } from '@renderer/store/list/action'
import { userLists } from '@renderer/store/list/state'
import { getUserListGroup, initializeUserListGroups, setUserListGroup } from '@renderer/store/list/group'

export const persistExactUserListOrder = async(ids: readonly string[]): Promise<void> => {
  for (let position = 0; position < ids.length; position++) {
    const current = userLists.findIndex(item => item.id == ids[position])
    if (current != position) await updateUserListPosition({ ids: [ids[position]], position })
  }
}

interface MoveUserListDependencies {
  readLists: () => LX.List.UserListInfo[]
  getGroup: (list: LX.List.UserListInfo) => LX.List.UserListGroup
  setGroup: (id: string, group: LX.List.UserListGroup) => Promise<void>
  setOrder: (ids: readonly string[]) => Promise<void>
  reload: () => Promise<void>
}

interface MoveRequest {
  id: string
  toGroup: LX.List.UserListGroup
  toIndex: number
}

export const createMoveUserList = (dependencies: MoveUserListDependencies) => {
  let transaction = Promise.resolve()
  const execute = async({ id, toGroup, toIndex }: MoveRequest): Promise<void> => {
    const lists = dependencies.readLists()
    const list = lists.find(item => item.id == id)
    if (!list || id.startsWith('platform:')) return

    const oldGroup = dependencies.getGroup(list)
    const oldOrder = lists.map(item => item.id)
    const groups = Object.fromEntries(lists.map(item => [item.id, dependencies.getGroup(item)]))
    const ordinaryLists = lists.filter(item => !item.id.startsWith('platform:'))
    const ordinaryOrder = buildMovedUserListOrder(ordinaryLists, groups, id, toGroup, toIndex)
    let ordinaryIndex = 0
    const nextOrder = lists.map(item => item.id.startsWith('platform:') ? item.id : ordinaryOrder[ordinaryIndex++])
    let groupWritten = false
    let orderStarted = false

    try {
      if (oldGroup != toGroup) {
        await dependencies.setGroup(id, toGroup)
        groupWritten = true
      }
      orderStarted = true
      await dependencies.setOrder(nextOrder)
    } catch (error) {
      if (!orderStarted) throw error

      const rollbacks: Array<Promise<void>> = []
      if (groupWritten) rollbacks.push(dependencies.setGroup(id, oldGroup))
      rollbacks.push(dependencies.setOrder(oldOrder))
      const results = await Promise.allSettled(rollbacks)
      if (results.some(result => result.status == 'rejected')) {
        await dependencies.reload().catch(log.error)
      }
      throw error
    }
  }
  return async(request: MoveRequest): Promise<void> => {
    const result = transaction.then(async() => execute(request))
    transaction = result.catch(() => {})
    await result
  }
}

export const moveUserList = createMoveUserList({
  readLists: () => userLists,
  getGroup: getUserListGroup,
  setGroup: setUserListGroup,
  setOrder: persistExactUserListOrder,
  reload: async() => {
    const lists = await getUserLists()
    await initializeUserListGroups([...lists])
  },
})

export const reorderUserListWithinGroup = async({ id, group, toIndex }: {
  id: string
  group: LX.List.UserListGroup
  toIndex: number
}): Promise<void> => {
  await moveUserList({ id, toGroup: group, toIndex })
}
