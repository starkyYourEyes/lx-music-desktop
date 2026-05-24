const formatPlayCount = (count: unknown): string => {
  const value = Number(count)
  if (!Number.isFinite(value) || value <= 0) return ''
  if (value >= 100000000) return `${Math.floor(value / 10000000) / 10}亿`
  if (value >= 10000) return `${Math.floor(value / 1000) / 10}万`
  return String(Math.floor(value))
}

export const normalizePlaylist = (playlist: any): LX.Netease.Playlist | null => {
  const id = playlist?.id ?? playlist?.playlistId
  if (id == null) return null

  const creator = playlist.creator ?? playlist.user ?? {}
  const imageUrl = playlist.picUrl ?? playlist.coverImgUrl ?? playlist.coverUrl ?? ''

  return {
    id: String(id),
    name: playlist.name ?? '',
    img: imageUrl,
    author: creator.nickname ?? playlist.copywriter ?? '',
    play_count: formatPlayCount(playlist.playCount),
    desc: playlist.copywriter ?? playlist.description ?? null,
    source: 'wy',
    total: playlist.trackCount == null ? undefined : String(playlist.trackCount),
  }
}

export const normalizePlaylistList = (playlists: any[] = []): LX.Netease.Playlist[] => {
  const ids = new Set<string>()
  const list: LX.Netease.Playlist[] = []

  for (const playlist of playlists) {
    const normalized = normalizePlaylist(playlist)
    if (!normalized || ids.has(normalized.id)) continue
    ids.add(normalized.id)
    list.push(normalized)
  }

  return list
}
