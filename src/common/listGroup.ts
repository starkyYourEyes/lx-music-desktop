export const isUserListGroup = (value: unknown): value is LX.List.UserListGroup => {
  return value == 'mine' || value == 'external'
}

export const resolveUserListGroup = (
  list: Pick<LX.List.UserListInfo, 'source' | 'sourceListId'>,
  storedGroup: unknown,
): LX.List.UserListGroup => {
  if (isUserListGroup(storedGroup)) return storedGroup
  return list.source != null || list.sourceListId != null ? 'external' : 'mine'
}

export const partitionUserLists = <T>(
  lists: readonly T[],
  getGroup: (list: T) => LX.List.UserListGroup,
): { mine: T[], external: T[] } => {
  const result: { mine: T[], external: T[] } = { mine: [], external: [] }
  for (const list of lists) result[getGroup(list)].push(list)
  return result
}

export const buildMovedUserListOrder = (
  lists: readonly LX.List.UserListInfo[],
  groups: Readonly<Record<string, LX.List.UserListGroup | undefined>>,
  id: string,
  toGroup: LX.List.UserListGroup,
  toIndex: number,
): string[] => {
  const moved = lists.find(list => list.id == id)
  if (!moved) return lists.map(list => list.id)
  const remaining = lists.filter(list => list.id != id)
  const partitioned = partitionUserLists(remaining, list => resolveUserListGroup(list, groups[list.id]))
  const target = partitioned[toGroup]
  const index = Number.isFinite(toIndex) ? Math.max(0, Math.min(Math.trunc(toIndex), target.length)) : target.length
  target.splice(index, 0, moved)
  return [...partitioned.mine, ...partitioned.external].map(list => list.id)
}
