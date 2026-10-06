// Apply only fields edited since the caller read its base. Keep intervening edits.
const mergeMetadataUpdate = (current, value, base) => {
  if (base === undefined) return value
  const previous = base ?? {}
  const result = { ...(current ?? { updateTime: 0, isAutoUpdate: false }) }
  for (const key of ['updateTime', 'isAutoUpdate']) {
    if (value[key] !== previous[key]) result[key] = value[key]
  }
  const profile = { ...current?.profile }
  for (const key of new Set([...Object.keys(previous.profile ?? {}), ...Object.keys(value.profile ?? {})])) {
    if (value.profile?.[key] === previous.profile?.[key]) continue
    if (value.profile?.[key] === undefined) delete profile[key]
    else profile[key] = value.profile[key]
  }
  if (Object.keys(profile).length) result.profile = profile
  else delete result.profile
  return result
}
module.exports = { mergeMetadataUpdate }
