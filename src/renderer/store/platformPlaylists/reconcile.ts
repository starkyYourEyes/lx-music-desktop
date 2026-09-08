import { getListUpdateInfo, setUserListProfile } from '@renderer/utils/data'
import { createUserList, getUserLists, removeUserList, updateUserList } from '@renderer/store/list/listManage/rendererListManage'
import { userLists } from '@renderer/store/list/state'
import { importSourceList } from '@renderer/store/list/importSourceList'
import type { PlatformPlaylistFailure, PlatformPlaylistGroupKey } from './types'

export const getPlatformPlaylistErrorMessage = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export const isManagedPlatformPlaylist = (listInfo: LX.List.UserListInfo & { profile?: LX.List.UserListProfile }) => {
  return listInfo.profile?.managed === true && !!listInfo.profile.provider && !!listInfo.profile.kind
}

export const isManagedPlatformPlaylistForAccount = (
  listInfo: LX.List.UserListInfo & { profile?: LX.List.UserListProfile },
  provider: LX.PlatformPlaylistProvider,
  accountKey: string,
) => isManagedPlatformPlaylist(listInfo) && listInfo.profile?.provider == provider && listInfo.profile.accountKey == accountKey

export const managedPlatformListId = (summary: LX.PlatformPlaylistSummary) => {
  return `platform:${summary.provider}:${summary.accountKey}:${summary.kind}:${summary.sourceListId}`
}

export const syncPlatformPlaylistSongs = async(
  lists: LX.List.UserListInfo[],
  now = Date.now,
  canCommit = () => true,
): Promise<PlatformPlaylistFailure[]> => {
  const failures: PlatformPlaylistFailure[] = []
  if (!canCommit()) return failures
  const updateInfo = await getListUpdateInfo()
  for (const info of lists) {
    if (!canCommit()) break
    const profile = updateInfo[info.id]?.profile
    if (!profile?.managed || !profile.kind || !info.source || !info.sourceListId) throw new Error('Playlist metadata unavailable')
    try {
      const importedId = await importSourceList({
        id: info.id,
        source: info.source,
        sourceListId: info.sourceListId,
        name: info.name,
        reveal: false,
        canCommit,
      })
      if (!canCommit()) break
      if (importedId) await setUserListProfile(info.id, { ...profile, lastSyncAt: now() })
    } catch (error) {
      if (!canCommit()) break
      failures.push({
        listId: info.id,
        sourceListId: info.sourceListId,
        name: info.name,
        kind: profile.kind,
        message: getPlatformPlaylistErrorMessage(error),
        hasCache: !!updateInfo[info.id]?.updateTime,
      })
    }
  }
  return failures
}

export const reconcilePlatformPlaylistSummaries = async(
  summaries: LX.PlatformPlaylistSummary[],
  provider: LX.PlatformPlaylistProvider,
  accountKey: string,
  now = Date.now,
  kinds: readonly LX.PlatformPlaylistKind[] = ['created', 'collected'],
  { canCommit = () => true, onListsChanged }: { canCommit?: () => boolean, onListsChanged?: () => Promise<void> } = {},
) => {
  const result = { created: 0, updated: 0, removed: 0, failures: [] as PlatformPlaylistFailure[] }
  if (!canCommit()) return result
  const updateInfo = await getListUpdateInfo()
  if (!canCommit()) return result
  const current = userLists.filter(item => {
    const profile = updateInfo[item.id]?.profile
    return isManagedPlatformPlaylistForAccount({ ...item, profile }, provider, accountKey) && kinds.some(kind => kind == profile?.kind)
  })
  const incoming = summaries.filter(item => item.provider == provider && item.accountKey == accountKey && kinds.includes(item.kind))
  const incomingIds = new Set<string>()
  const updates: LX.List.UserListInfo[] = []
  const created: LX.List.UserListInfo[] = []
  const profiles: Array<[string, LX.List.UserListProfile]> = []
  for (const summary of incoming) {
    const id = managedPlatformListId(summary)
    if (incomingIds.has(id)) continue
    incomingIds.add(id)
    const info: LX.List.UserListInfo = {
      id,
      name: summary.name,
      source: summary.provider == 'netease' ? 'wy' : summary.provider == 'qq_music' ? 'tx' : 'kg',
      sourceListId: summary.sourceListId,
      locationUpdateTime: null,
    }
    if (userLists.some(item => item.id == id)) updates.push(info)
    else created.push(info)
    profiles.push([id, {
      managed: true,
      provider: summary.provider,
      kind: summary.kind,
      accountKey: summary.accountKey,
      ...(summary.coverUrl ? { coverUrl: summary.coverUrl } : {}),
      lastSyncAt: updateInfo[id]?.profile?.lastSyncAt ?? 0,
    }])
  }
  // Persist through the main-process list API; the event handlers only update renderer memory.
  if (!canCommit()) return result
  if (created.length) {
    await createUserList({ listInfos: created, position: userLists.length })
    result.created = created.length
    if (!canCommit()) return result
  }
  for (const [id, profile] of profiles) {
    if (!canCommit()) return result
    await setUserListProfile(id, profile)
    if (!canCommit()) return result
  }
  if (!canCommit()) return result
  if (updates.length) {
    await updateUserList(updates)
    result.updated = updates.length
    if (!canCommit()) return result
  }
  const stale = current.filter(item => !incomingIds.has(item.id)).map(item => item.id)
  if (!canCommit()) return result
  if (stale.length) {
    await removeUserList(stale)
    result.removed = stale.length
    if (!canCommit()) return result
  }
  await getUserLists()
  if (!canCommit()) return result
  await onListsChanged?.()
  if (!canCommit()) return result
  result.failures = await syncPlatformPlaylistSongs([...created, ...updates], now, canCommit)
  return result
}

export const groupKeyForList = (listInfo: LX.List.UserListInfo & { profile?: LX.List.UserListProfile }): PlatformPlaylistGroupKey | null => {
  if (!isManagedPlatformPlaylist(listInfo)) return null
  return `${listInfo.profile!.provider}:${listInfo.profile!.kind}` as PlatformPlaylistGroupKey
}
