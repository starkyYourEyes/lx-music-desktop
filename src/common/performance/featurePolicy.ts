export const FEATURE_IDS = [
  'neteaseRecommend', 'qqRecommend', 'kugouRecommend', 'download',
  'desktopLyric', 'soundEffects', 'audioVisualization', 'customTrayMenu',
] as const

export type FeatureId = typeof FEATURE_IDS[number]
export type FeatureLoadMode = 'off' | 'onDemand' | 'resident'
export type FeatureSettingKey = `performance.features.${FeatureId}`
export type CacheProfile = 'compact' | 'balanced' | 'generous'
export type PerformanceSettings = Record<FeatureSettingKey, FeatureLoadMode> & {
  'performance.settingsVersion': 1
  'performance.cacheProfile': CacheProfile
  'performance.sourceIdleMinutes': 0 | 1 | 5 | 15
  'performance.simplifyVisuals': boolean
}

export const FEATURE_MODES: readonly FeatureLoadMode[] = ['off', 'onDemand', 'resident']
export const featureSettingKey = (feature: FeatureId): FeatureSettingKey => `performance.features.${feature}`
export const PERFORMANCE_KEYS = [
  ...FEATURE_IDS.map(featureSettingKey),
  'performance.settingsVersion', 'performance.cacheProfile',
  'performance.sourceIdleMinutes', 'performance.simplifyVisuals',
] as const

const valuesOf = (settings: object): Record<string, unknown> => settings as Record<string, unknown>
const isMode = (value: unknown): value is FeatureLoadMode => FEATURE_MODES.includes(value as FeatureLoadMode)

export const getFeatureMode = (settings: object, feature: FeatureId): FeatureLoadMode => {
  const values = valuesOf(settings)
  const explicit = values[featureSettingKey(feature)]
  if (isMode(explicit)) return explicit
  let enabled: boolean
  switch (feature) {
    case 'download': enabled = values['download.enable'] === true; break
    case 'desktopLyric': enabled = values['desktopLyric.enable'] === true; break
    case 'customTrayMenu': enabled = values['tray.enable'] === true; break
    case 'audioVisualization':
      enabled = values['player.audioVisualization'] === true || values['desktopLyric.audioVisualization'] === true
      break
    case 'soundEffects': enabled = values['player.soundEffect.mode'] !== 'original'; break
    default: enabled = true
  }
  return enabled ? 'onDemand' : 'off'
}

export const isFeatureEnabled = (settings: object, feature: FeatureId): boolean => getFeatureMode(settings, feature) != 'off'

export const migratePerformanceSettings = (settings: object): PerformanceSettings => {
  const values = valuesOf(settings)
  const profile = values['performance.cacheProfile']
  const idle = values['performance.sourceIdleMinutes']
  const migrated: PerformanceSettings = {
    ...Object.fromEntries(FEATURE_IDS.map(feature => [featureSettingKey(feature), getFeatureMode(settings, feature)])) as Record<FeatureSettingKey, FeatureLoadMode>,
    'performance.settingsVersion': 1,
    'performance.cacheProfile': ['compact', 'balanced', 'generous'].includes(profile as string) ? profile as CacheProfile : 'compact',
    'performance.sourceIdleMinutes': [0, 1, 5, 15].includes(idle as number) ? idle as 0 | 1 | 5 | 15 : 5,
    'performance.simplifyVisuals': values['performance.simplifyVisuals'] === true,
  }
  return migrated
}

export const isPerformanceSetting = (key: string): key is keyof PerformanceSettings => (
  (PERFORMANCE_KEYS as readonly string[]).includes(key)
)

export const normalizePerformancePatch = (current: object, patch: object): Record<string, unknown> => {
  const result = { ...valuesOf(patch) }
  for (const [key, value] of Object.entries(result)) {
    if (!key.startsWith('performance.')) continue
    let valid = isPerformanceSetting(key)
    if (key.startsWith('performance.features.')) valid &&= isMode(value)
    else if (key == 'performance.cacheProfile') valid &&= ['compact', 'balanced', 'generous'].includes(value as string)
    else if (key == 'performance.sourceIdleMinutes') valid &&= [0, 1, 5, 15].includes(value as number)
    else if (key == 'performance.simplifyVisuals') valid &&= typeof value == 'boolean'
    else if (key == 'performance.settingsVersion') valid &&= value === 1
    if (!valid) throw new Error(`Invalid performance setting: ${key}`)
  }
  const downloadKey = featureSettingKey('download')
  if (Object.hasOwn(result, downloadKey)) result['download.enable'] = result[downloadKey] != 'off'
  else if (Object.hasOwn(result, 'download.enable')) {
    const existing = getFeatureMode(current, 'download')
    result[downloadKey] = result['download.enable'] === true ? existing == 'off' ? 'onDemand' : existing : 'off'
  }
  return result
}

export const getFeatureForPath = (path: string): FeatureId | null => {
  switch (path.replace(/\/$/, '')) {
    case '/recommend': return 'neteaseRecommend'
    case '/qq-recommend': return 'qqRecommend'
    case '/kg-recommend': return 'kugouRecommend'
    case '/download': return 'download'
    default: return null
  }
}
