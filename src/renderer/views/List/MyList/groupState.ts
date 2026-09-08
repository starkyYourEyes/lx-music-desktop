const storageKey = 'my-list-group-collapsed-v1'

export type MyListGroupCollapsed = Record<LX.List.UserListGroup, boolean>

const defaultState = (): MyListGroupCollapsed => ({ mine: false, external: false })

const isCollapsedState = (value: unknown): value is MyListGroupCollapsed => {
  if (!value || typeof value != 'object' || Array.isArray(value)) return false
  const state = value as Record<string, unknown>
  return typeof state.mine == 'boolean' && typeof state.external == 'boolean'
}

export const loadMyListGroupCollapsed = (storage: Storage | Pick<Storage, 'getItem'> = localStorage): MyListGroupCollapsed => {
  try {
    const value = storage.getItem(storageKey)
    if (!value) return defaultState()
    const state: unknown = JSON.parse(value)
    return isCollapsedState(state) ? { mine: state.mine, external: state.external } : defaultState()
  } catch {
    return defaultState()
  }
}

export const saveMyListGroupCollapsed = (storage: Storage | Pick<Storage, 'setItem'> = localStorage, state: MyListGroupCollapsed) => {
  try {
    storage.setItem(storageKey, JSON.stringify({ mine: !!state.mine, external: !!state.external }))
  } catch {}
}

const platformStorageKey = 'platform-playlist-group-collapsed-v1'

export interface PlatformGroupCollapsed {
  providers: Record<LX.PlatformPlaylistProvider, boolean>
  kinds: Partial<Record<`${LX.PlatformPlaylistProvider}:${LX.PlatformPlaylistKind}`, boolean>>
}

const normalizePlatformGroupCollapsed = (value: unknown): PlatformGroupCollapsed => {
  const result: PlatformGroupCollapsed = {
    providers: { netease: false, qq_music: false, kugou: false },
    kinds: {},
  }
  if (!value || typeof value != 'object' || Array.isArray(value)) return result
  const state = value as Partial<PlatformGroupCollapsed>
  for (const provider of ['netease', 'qq_music', 'kugou'] as const) {
    if (typeof state.providers?.[provider] == 'boolean') result.providers[provider] = state.providers[provider]
    for (const kind of ['created', 'collected'] as const) {
      const key = `${provider}:${kind}` as const
      if (typeof state.kinds?.[key] == 'boolean') result.kinds[key] = state.kinds[key]
    }
  }
  return result
}

export const loadPlatformGroupCollapsed = (storage?: Pick<Storage, 'getItem'>): PlatformGroupCollapsed => {
  try {
    const value = (storage ?? localStorage).getItem(platformStorageKey)
    return normalizePlatformGroupCollapsed(value ? JSON.parse(value) : null)
  } catch {
    return normalizePlatformGroupCollapsed(null)
  }
}

export const savePlatformGroupCollapsed = (storage: Pick<Storage, 'setItem'> | undefined, state: PlatformGroupCollapsed) => {
  try {
    (storage ?? localStorage).setItem(platformStorageKey, JSON.stringify(normalizePlatformGroupCollapsed(state)))
  } catch {}
}
