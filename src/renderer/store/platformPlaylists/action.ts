import { computed } from '@common/utils/vueTools'
import { appSetting } from '@renderer/store/setting'
import { getNeteaseUserPlaylists, getQQMusicUserPlaylists, getKugouUserPlaylists } from '@renderer/utils/ipc'
import { getListUpdateInfo } from '@renderer/utils/data'
import { userLists } from '@renderer/store/list/state'
import { accountStatus as neteaseStatus } from '@renderer/store/netease'
import { accountStatus as qqStatus } from '@renderer/store/qqMusic'
import { accountStatus as kugouStatus } from '@renderer/store/kugouMusic'
import { platformPlaylistStatuses } from './state'
import { platformPlaylistGroupKey, type PlatformPlaylistFailure } from './types'
import { reconcilePlatformPlaylistSummaries, syncPlatformPlaylistSongs, getPlatformPlaylistErrorMessage, groupKeyForList, isManagedPlatformPlaylistForAccount } from './reconcile'
import { getUserLists, removeUserList } from '@renderer/store/list/listManage/rendererListManage'

const providers: Array<{ provider: LX.PlatformPlaylistProvider, get: (kinds?: readonly LX.PlatformPlaylistKind[]) => Promise<LX.PlatformPlaylistSummary[]>, accountKey: () => string | null, loggedIn: () => boolean }> = [
  { provider: 'netease', get: getNeteaseUserPlaylists, accountKey: () => neteaseStatus.value.profile?.userId == null ? null : String(neteaseStatus.value.profile.userId), loggedIn: () => neteaseStatus.value.isLoggedIn },
  { provider: 'qq_music', get: getQQMusicUserPlaylists, accountKey: () => qqStatus.value.profile?.uin ?? null, loggedIn: () => qqStatus.value.isLoggedIn },
  { provider: 'kugou', get: getKugouUserPlaylists, accountKey: () => kugouStatus.value.profile?.userId ?? null, loggedIn: () => kugouStatus.value.isLoggedIn },
]

const isEnabled = (provider: LX.PlatformPlaylistProvider, kind: LX.PlatformPlaylistKind) => {
  return appSetting[`list.platformPlaylists.${provider}.${kind}`] !== false
}

const kinds = ['created', 'collected'] as const
const inFlight = new Map<LX.PlatformPlaylistProvider, { accountKey: string, enabledKey: string, retryKind?: LX.PlatformPlaylistKind, promise: Promise<void> }>()
const revisions = new Map<LX.PlatformPlaylistProvider, number>()
const writeQueues = new Map<LX.PlatformPlaylistProvider, Promise<void>>()

const queueProviderWrite = async(provider: LX.PlatformPlaylistProvider, operation: () => Promise<void>) => {
  const result = (writeQueues.get(provider) ?? Promise.resolve()).then(operation)
  writeQueues.set(provider, result.catch(() => {}))
  await result
}

const refreshProvider = async(item: typeof providers[number], retryKind?: LX.PlatformPlaylistKind): Promise<void> => {
  const accountKey = item.loggedIn() ? item.accountKey() : null
  const enabledKinds = kinds.filter(kind => isEnabled(item.provider, kind))
  const enabledKey = enabledKinds.join(',')
  const pending = inFlight.get(item.provider)
  if (accountKey && pending?.accountKey == accountKey && pending.enabledKey == enabledKey) {
    if (!pending.retryKind || pending.retryKind == retryKind) return pending.promise
    await pending.promise
    if (!item.loggedIn() || item.accountKey() != accountKey || (retryKind && !isEnabled(item.provider, retryKind))) return
    return refreshProvider(item, retryKind)
  }

  const revision = (revisions.get(item.provider) ?? 0) + 1
  revisions.set(item.provider, revision)
  inFlight.delete(item.provider)
  const isCurrent = () => revisions.get(item.provider) == revision && item.loggedIn() && item.accountKey() == accountKey
  const groups = (retryKind ? [retryKind] : kinds).map(kind => platformPlaylistStatuses[platformPlaylistGroupKey(item.provider, kind)])
  for (const group of groups) {
    if (group.accountKey != accountKey || !isEnabled(item.provider, group.kind)) {
      group.lists = []
      group.failures = []
      group.lastDirectorySuccessAt = undefined
      group.lastSuccessAt = undefined
    }
    group.accountKey = accountKey
    if (accountKey) group.lastAccountKey = accountKey
    group.errorMessage = undefined
    group.errorStage = undefined
    if (accountKey && enabledKinds.includes(group.kind)) {
      group.status = 'loading'
      if (retryKind) group.status = 'syncing'
    } else group.status = 'idle'
  }
  if (!accountKey) return Promise.resolve()

  const updateGroupLists = async() => {
    const updateInfo = await getListUpdateInfo()
    if (!isCurrent()) return
    for (const group of groups) {
      group.lists = isEnabled(item.provider, group.kind) ? userLists.filter(list => {
        const profile = updateInfo[list.id]?.profile
        return profile?.managed === true && profile.provider == item.provider && profile.kind == group.kind && profile.accountKey == accountKey
      }) : []
      group.failures = group.failures?.filter(failure => group.lists.some(list => list.id == failure.listId)) ?? []
    }
  }

  const promise = (async() => {
    let errorStage: 'directory' | 'songs' = retryKind ? 'songs' : 'directory'
    try {
      // Serialize writes so a new account cleans up any commit already started by the previous one.
      await queueProviderWrite(item.provider, async() => {
        if (!isCurrent()) return
        await getUserLists()
        const updateInfo = await getListUpdateInfo()
        if (!isCurrent()) return
        const oldIds = userLists.filter(list => {
          const profile = updateInfo[list.id]?.profile
          if (profile?.managed === true) return profile.provider == item.provider && profile.accountKey != accountKey
          // A cancelled creation may commit its list before its metadata write.
          const identity = /^platform:(netease|qq_music|kugou):([^:]+):(created|collected):/.exec(list.id)
          return identity?.[1] == item.provider && identity[2] != accountKey
        }).map(list => list.id)
        if (oldIds.length) {
          await removeUserList(oldIds)
          await getUserLists()
        }
      })
      await updateGroupLists()
      if (!isCurrent() || !enabledKinds.length) return
      const summaries = retryKind ? [] : await item.get(enabledKinds)
      if (!isCurrent()) return
      let failures: PlatformPlaylistFailure[] = []
      await queueProviderWrite(item.provider, async() => {
        if (!isCurrent()) return
        if (retryKind) {
          const group = groups[0]
          const failedIds = new Set(group.failures?.map(failure => failure.listId))
          failures = await syncPlatformPlaylistSongs(group.lists.filter(list => failedIds.has(list.id)), Date.now, isCurrent)
          return
        }
        const visibleKinds = enabledKinds.filter(kind => isEnabled(item.provider, kind))
        if (visibleKinds.length) {
          const result = await reconcilePlatformPlaylistSummaries(summaries, item.provider, accountKey, Date.now, visibleKinds, {
            canCommit: isCurrent,
            onListsChanged: async() => {
              await updateGroupLists()
              if (!isCurrent()) return
              errorStage = 'songs'
              for (const group of groups) {
                if (!isEnabled(item.provider, group.kind)) continue
                group.lastDirectorySuccessAt = Date.now()
                group.status = 'syncing'
              }
            },
          })
          failures = result.failures
        }
      })
      await updateGroupLists()
      if (!isCurrent()) return
      for (const group of groups) {
        if (!isEnabled(item.provider, group.kind)) continue
        const errors = failures.filter(failure => failure.kind == group.kind)
        group.failures = errors
        if (errors.length) {
          group.status = 'partial'
          group.errorMessage = errors.map(error => `${error.name}: ${error.message}`).join('\n')
          continue
        }
        group.status = 'ready'
        group.lastSuccessAt = Date.now()
        group.errorMessage = undefined
      }
    } catch (error) {
      if (!isCurrent()) return
      const code = (error as { code?: string })?.code
      const message = getPlatformPlaylistErrorMessage(error)
      for (const group of groups) {
        if (!isEnabled(item.provider, group.kind)) continue
        group.status = code == 'platform_playlist_unsupported' || /not supported|暂不支持|unsupported/i.test(message) ? 'unsupported' : 'error'
        if (errorStage == 'songs') group.status = 'error'
        group.errorStage = errorStage
        group.errorMessage = message
      }
    }
  })().finally(() => {
    if (revisions.get(item.provider) == revision) inFlight.delete(item.provider)
  })
  inFlight.set(item.provider, { accountKey, enabledKey, retryKind, promise })
  return promise
}

export const refreshPlatformUserPlaylists = async(options?: { force?: boolean }) => {
  await Promise.all(providers.map(async item => refreshProvider(item)))
}

export const retryPlatformUserPlaylistGroup = async(provider: LX.PlatformPlaylistProvider, kind: LX.PlatformPlaylistKind) => {
  if (!isEnabled(provider, kind)) return
  const item = providers.find(item => item.provider == provider)
  if (!item) return
  const group = platformPlaylistStatuses[platformPlaylistGroupKey(provider, kind)]
  const retrySongs = (group.status == 'partial' || group.status == 'syncing') && !!group.failures?.length && group.accountKey == item.accountKey() && item.loggedIn()
  await refreshProvider(item, retrySongs ? kind : undefined)
}

export const getPlatformPlaylistFailure = (listId: string) => {
  for (const group of Object.values(platformPlaylistStatuses)) {
    if (!group.accountKey || !isEnabled(group.provider, group.kind)) continue
    const failure = group.failures?.find(failure => failure.listId == listId)
    if (failure) return failure
  }
}

export const getPlatformPlaylistGroups = () => computed(() => Object.values(platformPlaylistStatuses).filter(group => isEnabled(group.provider, group.kind)))

export { platformPlaylistStatuses, groupKeyForList, isManagedPlatformPlaylistForAccount }
