export const BACKGROUND_TRANSPARENCY_MIN = 0
export const BACKGROUND_TRANSPARENCY_MAX = 100
export const BACKGROUND_TRANSPARENCY_DEFAULT = 40

export const normalizeBackgroundTransparency = (value: unknown): number => {
  if (typeof value != 'number' && typeof value != 'string') return BACKGROUND_TRANSPARENCY_DEFAULT
  if (typeof value == 'string' && !value.trim()) return BACKGROUND_TRANSPARENCY_DEFAULT
  const transparency = Math.round(Number(value))
  if (!Number.isFinite(transparency)) return BACKGROUND_TRANSPARENCY_DEFAULT
  return Math.min(BACKGROUND_TRANSPARENCY_MAX, Math.max(BACKGROUND_TRANSPARENCY_MIN, transparency))
}

export const getLayoutBackgroundOpacity = (value: unknown): number =>
  (BACKGROUND_TRANSPARENCY_MAX - normalizeBackgroundTransparency(value)) / BACKGROUND_TRANSPARENCY_MAX
