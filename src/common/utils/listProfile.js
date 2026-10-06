const isRecord = value => value != null && typeof value == 'object' && !Array.isArray(value)
const isPortableCover = value => {
  if (typeof value != 'string' || value.length > 2048) return false
  return value == '' || /^https?:\/\/[^/@\s?#]+(?::\d+)?(?:[/?#][^\s]*)?$/i.test(value)
}
const normalizeProfile = value => {
  if (!isRecord(value)) return {}
  const result = {}
  if (typeof value.description == 'string') result.description = value.description.slice(0, 4000)
  if (isPortableCover(value.coverUrl)) result.coverUrl = value.coverUrl
  if (value.group == 'mine' || value.group == 'external') result.group = value.group
  if (Number.isSafeInteger(value.createdAt) && value.createdAt >= 0) result.createdAt = value.createdAt
  return result
}
const resolveGroup = (list, profile) => profile?.group == 'mine' || profile?.group == 'external'
  ? profile.group
  : list.source != null || list.sourceListId != null ? 'external' : 'mine'

const moveWithinGroup = (lists, profiles, id, offset) => {
  const selected = lists.find(list => list.id == id)
  if (!selected) return lists.map(list => list.id)
  const group = resolveGroup(selected, profiles[id])
  const siblings = lists.filter(list => resolveGroup(list, profiles[list.id]) == group)
  const index = siblings.findIndex(list => list.id == id)
  const nextIndex = Math.max(0, Math.min(index + offset, siblings.length - 1))
  siblings.splice(index, 1)
  siblings.splice(nextIndex, 0, selected)
  let cursor = 0
  return lists.map(list => resolveGroup(list, profiles[list.id]) == group ? siblings[cursor++].id : list.id)
}

module.exports = { isRecord, isPortableCover, normalizeProfile, resolveGroup, moveWithinGroup }
