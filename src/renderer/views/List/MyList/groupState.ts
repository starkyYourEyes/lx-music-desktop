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
