export const PLAY_BAR_HEIGHT_MIN = 56
export const PLAY_BAR_HEIGHT_MAX = 74
export const PLAY_BAR_HEIGHT_DEFAULT = 74

const PLAY_BAR_ARTWORK_MIN = 42
const PLAY_BAR_ARTWORK_MAX = 54

export const normalizePlayBarHeight = (value: unknown): number => {
  if (typeof value != 'number' && typeof value != 'string') return PLAY_BAR_HEIGHT_DEFAULT
  if (typeof value == 'string' && !value.trim()) return PLAY_BAR_HEIGHT_DEFAULT
  const height = Math.round(Number(value))
  if (!Number.isFinite(height)) return PLAY_BAR_HEIGHT_DEFAULT
  return Math.min(PLAY_BAR_HEIGHT_MAX, Math.max(PLAY_BAR_HEIGHT_MIN, height))
}

export const getPlayBarLayout = (value: unknown) => {
  const height = normalizePlayBarHeight(value)
  const ratio = (height - PLAY_BAR_HEIGHT_MIN) / (PLAY_BAR_HEIGHT_MAX - PLAY_BAR_HEIGHT_MIN)
  const artworkSize = PLAY_BAR_ARTWORK_MIN + ratio * (PLAY_BAR_ARTWORK_MAX - PLAY_BAR_ARTWORK_MIN)

  return {
    height,
    artworkSize,
    paddingY: (height - artworkSize) / 2,
  }
}
