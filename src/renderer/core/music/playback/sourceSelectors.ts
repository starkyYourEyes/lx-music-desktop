type PlaybackSettingSnapshot = Pick<
LX.AppSetting,
'common.apiSource' | 'common.apiFallbackSources'
>

export const canStartPlaybackWithRegistry = (
  source: LX.Source,
  setting: PlaybackSettingSnapshot,
  installedApiIds: ReadonlySet<string>,
): boolean => {
  if (source == 'local' || source == 'webdav') return true
  return [setting['common.apiSource'], ...setting['common.apiFallbackSources']]
    .some(apiId => installedApiIds.has(apiId))
}

export const deriveQualityListFromCapabilities = (
  capabilities: LX.Playback.SourceCapabilities | undefined,
): LX.QualityList => {
  const qualitys: LX.QualityList = {}
  for (const [source, info] of Object.entries(capabilities?.sources ?? {})) {
    if (info.actions.includes('musicUrl')) qualitys[source as LX.OnlineSource] = [...info.qualitys]
  }
  return qualitys
}

export const canOpenPrimaryDownloadWithRegistry = (
  source: LX.Source,
  primaryId: string,
  builtinQualitys: Readonly<Record<string, LX.QualityList>>,
  installedCustomIds: ReadonlySet<string>,
  knownCapabilities: Readonly<Record<string, LX.Playback.SourceCapabilities>>,
): boolean => {
  if (source == 'local' || source == 'webdav') return false
  const builtin = builtinQualitys[primaryId]
  if (builtin) return (builtin[source] ?? []).length > 0
  if (!installedCustomIds.has(primaryId)) return false
  const known = knownCapabilities[primaryId]
  if (!known) return true
  const info = known.sources[source]
  return info?.actions.includes('musicUrl') == true && info.qualitys.length > 0
}
