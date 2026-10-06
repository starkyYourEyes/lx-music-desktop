const { normalizeProfile, isRecord } = require('./listProfile')
const fields = ['description', 'coverUrl', 'group', 'createdAt']
const safeId = id => typeof id == 'string' && id.length > 0 && id.length <= 256 && !['__proto__', 'prototype', 'constructor'].includes(id)
const normalizeSnapshot = value => {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.profiles) || !Array.isArray(value.listIds)) throw new Error('Invalid playlist profile snapshot')
  const ids = Object.keys(value.profiles)
  if (ids.length > 10000 || value.listIds.length > 10000 || ![...ids, ...value.listIds].every(safeId) || JSON.stringify(value).length > 8 * 1024 * 1024) throw new Error('Playlist profile snapshot exceeds limits')
  return {
    version: 1,
    listIds: [...new Set(value.listIds)].sort(),
    profiles: Object.fromEntries(ids.sort().map(id => {
      if (!isRecord(value.profiles[id])) throw new Error(`Invalid playlist profile: ${id}`)
      return [id, normalizeProfile(value.profiles[id])]
    }).filter(([, profile]) => Object.keys(profile).length)),
  }
}
const mergeSnapshots = (localInput, remoteInput, baseInput, mode = 'merge_local_remote') => {
  const local = normalizeSnapshot(localInput)
  const remote = normalizeSnapshot(remoteInput)
  const base = baseInput ? normalizeSnapshot(baseInput) : { listIds: [], profiles: {} }
  const liveIds = new Set([...local.listIds, ...remote.listIds])
  const deleted = new Set(base.listIds.filter(id => !liveIds.has(id)))
  const ids = [...new Set([...Object.keys(local.profiles), ...Object.keys(remote.profiles)])].sort()
  const preferRemote = mode.includes('remote_local')
  const overwrite = mode.startsWith('overwrite_')
  const profiles = {}
  for (const id of ids) {
    if (deleted.has(id)) continue
    const profile = {}
    for (const key of fields) {
      const a = local.profiles[id]?.[key]
      const b = remote.profiles[id]?.[key]
      const previous = base.profiles[id]?.[key]
      let value
      if (a === undefined) value = b
      else if (b === undefined) value = a
      else if (overwrite) value = preferRemote ? b : a
      else if (a === previous) value = b
      else if (b === previous) value = a
      else value = preferRemote ? b : a
      if (value !== undefined) profile[key] = value
    }
    if (Object.keys(profile).length) profiles[id] = profile
  }
  return normalizeSnapshot({ version: 1, profiles, listIds: [...liveIds] })
}
const snapshotsEqual = (a, b) => JSON.stringify(normalizeSnapshot(a)) == JSON.stringify(normalizeSnapshot(b))
const rebaseSnapshot = (current, incoming, base) => {
  const next = mergeSnapshots(current, incoming, base)
  // A missing profile in an acknowledged proposal is a deletion only after
  // its list has gone on both sides. Unknown, not-yet-arrived lists survive.
  const liveIds = new Set(next.listIds)
  next.profiles = Object.fromEntries(Object.entries(next.profiles).filter(([id]) =>
    liveIds.has(id) || !Object.hasOwn(base.profiles, id) || Object.hasOwn(incoming.profiles, id)))
  return next
}
module.exports = { normalizeSnapshot, mergeSnapshots, snapshotsEqual, rebaseSnapshot }
