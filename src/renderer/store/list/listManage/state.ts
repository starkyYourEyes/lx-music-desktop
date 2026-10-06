import { LIST_IDS } from '@common/constants'
import { markRaw, reactive } from '@common/utils/vueTools'
import { BoundedCache } from '@common/performance/boundedCache'
import { getCacheProfile, registerCacheProfile } from '@common/performance/cacheProfile'

const owners = new Map<unknown, Set<string>>()
export const allMusicList = markRaw(new BoundedCache<string, LX.Music.MusicInfo[]>({
  maxEntries: getCacheProfile().localEntries,
  maxWeight: getCacheProfile().localSongs,
  weight: list => list.length,
  // WebDAV's list is authoritative renderer state, not a reloadable DB cache.
  isPinned: id => id == LIST_IDS.WEBDAV || [...owners.values()].some(ids => ids.has(id)),
}))

export const setMusicListCacheOwner = (owner: unknown, ids: Array<string | null | undefined>) => {
  const present = ids.filter((id): id is string => !!id)
  if (present.length) owners.set(owner, new Set(present))
  else owners.delete(owner)
  allMusicList.prune()
}

export const retainMusicList = (id: string | null | undefined) => {
  const owner = {}
  setMusicListCacheOwner(owner, [id])
  return () => { setMusicListCacheOwner(owner, []) }
}

registerCacheProfile(profile => { allMusicList.configure({ maxEntries: profile.localEntries, maxWeight: profile.localSongs }) })

export let musicListReadGeneration = 0
export const invalidateMusicListReads = () => { musicListReadGeneration++ }

export const defaultList = markRaw<LX.List.MyDefaultListInfo>({
  id: LIST_IDS.DEFAULT,
  name: 'list__name_default',
  // name: '试听列表',
})

export const loveList = markRaw<LX.List.MyLoveListInfo>({
  id: LIST_IDS.LOVE,
  name: 'list__name_love',
  // name: '我的收藏',
})
export const webDAVList = markRaw<LX.List.MyWebDAVListInfo>({
  id: LIST_IDS.WEBDAV,
  name: '我的云盘',
})
export const tempList = markRaw<LX.List.MyTempListInfo>({
  id: LIST_IDS.TEMP,
  name: '临时列表',
  meta: {},
})

export const userLists: LX.List.UserListInfo[] = reactive([])
