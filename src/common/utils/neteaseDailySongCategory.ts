export const DAILY_SONG_CATEGORY_TAG_KEY_SEPARATOR = ':'
export const DAILY_SONG_CATEGORY_PLAYLIST_ID_PREFIX = 'daily_song_category'

export const getDailySongCategoryTagKey = (categoryId: string | number, tagId: string | number) => {
  return `${categoryId}${DAILY_SONG_CATEGORY_TAG_KEY_SEPARATOR}${tagId}`
}

export const parseDailySongCategoryTagKey = (key: string) => {
  const [categoryId, tagId] = String(key).split(DAILY_SONG_CATEGORY_TAG_KEY_SEPARATOR)
  if (!categoryId || !tagId) return null
  return { categoryId, tagId }
}

export const getDailySongCategoryPlaylistId = (categoryId: string | number, tagId: string | number) => {
  return `${DAILY_SONG_CATEGORY_PLAYLIST_ID_PREFIX}__${categoryId}__${tagId}`
}

export const parseDailySongCategoryPlaylistId = (id: string) => {
  const [prefix, categoryId, tagId] = String(id).split('__')
  if (prefix != DAILY_SONG_CATEGORY_PLAYLIST_ID_PREFIX || !categoryId || !tagId) return null
  return { categoryId, tagId }
}
