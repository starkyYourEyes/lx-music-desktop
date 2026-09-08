export const SIDEBAR_FONT_SIZE_MIN = 10
export const SIDEBAR_FONT_SIZE_MAX = 24

export const SIDEBAR_FONT_SETTINGS = [
  { id: 'navigation', key: 'common.sidebarNavigationFontSize', defaultValue: 13, cssVariable: '--sidebar-navigation-font-size' },
  { id: 'title', key: 'common.sidebarTitleFontSize', defaultValue: 12, cssVariable: '--sidebar-title-font-size' },
  { id: 'playlists', key: 'common.sidebarPlaylistFontSize', defaultValue: 13, cssVariable: '--sidebar-playlist-font-size' },
] as const

export const normalizeSidebarFontSize = (value: unknown, fallback: number): number => {
  if (typeof value != 'number' && typeof value != 'string') return fallback
  if (typeof value == 'string' && !value.trim()) return fallback
  const size = Math.round(Number(value))
  if (!Number.isFinite(size)) return fallback
  return Math.min(SIDEBAR_FONT_SIZE_MAX, Math.max(SIDEBAR_FONT_SIZE_MIN, size))
}

export const getSidebarFontStyles = (setting: Partial<LX.AppSetting>) => Object.fromEntries(
  SIDEBAR_FONT_SETTINGS.map(item => [item.cssVariable, `${normalizeSidebarFontSize(setting[item.key], item.defaultValue)}px`]),
)
