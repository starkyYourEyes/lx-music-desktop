type PlaybackSourceSetting = Pick<
  LX.AppSetting,
  'common.apiSource' | 'common.apiFallbackSources' | 'common.apiFallbackMode'
>

export const normalizePlaybackSourceSetting = (
  setting: Partial<PlaybackSourceSetting>,
  availableApiIds?: ReadonlySet<string>,
): Pick<PlaybackSourceSetting, 'common.apiFallbackSources' | 'common.apiFallbackMode'> => {
  const primaryId = typeof setting['common.apiSource'] == 'string' ? setting['common.apiSource'] : ''
  const fallbackIds = Array.isArray(setting['common.apiFallbackSources'])
    ? setting['common.apiFallbackSources']
    : []
  const seen = new Set<string>()
  const normalizedIds: string[] = []
  for (const id of fallbackIds) {
    if (typeof id != 'string' || !id || id == primaryId || seen.has(id)) continue
    if (availableApiIds && !availableApiIds.has(id)) continue
    seen.add(id)
    normalizedIds.push(id)
  }
  return {
    'common.apiFallbackSources': normalizedIds,
    'common.apiFallbackMode': 'serial',
  }
}

export const changePrimaryPlaybackSource = (
  setting: PlaybackSourceSetting,
  primaryId: string,
): PlaybackSourceSetting => ({
  ...setting,
  'common.apiSource': primaryId,
  ...normalizePlaybackSourceSetting({ ...setting, 'common.apiSource': primaryId }),
})

export const addPlaybackFallback = (ids: readonly string[], apiId: string): string[] => (
  !apiId || ids.includes(apiId) ? [...ids] : [...ids, apiId]
)

export const movePlaybackFallback = (ids: readonly string[], apiId: string, offset: -1 | 1): string[] => {
  const next = [...ids]
  const index = next.indexOf(apiId)
  const target = index + offset
  if (index < 0 || target < 0 || target >= next.length) return next
  ;[next[index], next[target]] = [next[target], next[index]]
  return next
}

export const removePlaybackFallback = (ids: readonly string[], apiId: string): string[] => (
  ids.filter(id => id != apiId)
)

export const reconcilePlaybackSourceRegistry = (
  setting: PlaybackSourceSetting,
  builtinIds: readonly string[],
  customIds: readonly string[],
  authoritative: boolean,
) => normalizePlaybackSourceSetting(
  setting,
  authoritative ? new Set([...builtinIds, ...customIds]) : undefined,
)

export interface PlaybackSourceChoice {
  id: string
  disabled: boolean
}

export const getAddablePlaybackSources = <T extends PlaybackSourceChoice>(
  sources: readonly T[],
  primaryId: string,
  fallbackIds: readonly string[],
): T[] => {
  const selected = new Set(fallbackIds)
  return sources.filter(source => (
    !source.disabled && source.id != primaryId && !selected.has(source.id)
  ))
}
