export const createSettingsDraft = <T extends object>(initial: T) => {
  const base = { ...initial }
  const values = { ...initial }
  const conflicts = new Set<keyof T>()
  return {
    values,
    set<K extends keyof T>(key: K, value: T[K]) { values[key] = value; conflicts.delete(key) },
    sync(saved: T) {
      for (const key of Object.keys(saved) as Array<keyof T>) {
        if (values[key] == base[key]) values[key] = saved[key]
        else if (saved[key] != base[key] && saved[key] != values[key]) conflicts.add(key)
        if (saved[key] == values[key]) conflicts.delete(key)
        base[key] = saved[key]
      }
    },
    reset() { Object.assign(values, base); conflicts.clear() },
    conflicts: () => [...conflicts],
    patch: (): Partial<T> => Object.fromEntries(
      (Object.keys(values) as Array<keyof T>).filter(key => values[key] != base[key]).map(key => [key, values[key]]),
    ) as Partial<T>,
  }
}
