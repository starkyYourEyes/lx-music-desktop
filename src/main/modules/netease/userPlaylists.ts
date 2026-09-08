interface NeteaseUserPlaylistApi {
  user_playlist: (params: Record<string, unknown>) => Promise<any>
}

const pageLimit = 1000

const normalizePlaylist = (
  playlist: any,
  accountKey: string,
): LX.Netease.UserPlaylistSummary | null => {
  const playlistId = playlist?.id ?? playlist?.playlistId
  if (playlistId == null) return null

  const sourceListId = String(playlistId)
  if (!sourceListId) return null

  return {
    provider: 'netease',
    kind: String(playlist?.creator?.userId ?? playlist?.user?.userId ?? '') == accountKey ? 'created' : 'collected',
    id: sourceListId,
    sourceListId,
    name: playlist?.name ?? '',
    coverUrl: playlist?.coverImgUrl ?? playlist?.picUrl ?? playlist?.coverUrl ?? '',
    accountKey,
  }
}

export const createNeteaseUserPlaylistService = ({
  api,
  getCookie,
  getProfile,
}: {
  api: NeteaseUserPlaylistApi
  getCookie: () => string
  getProfile: () => LX.Netease.Profile | null
}) => {
  const getUserPlaylists = async(kinds: readonly LX.PlatformPlaylistKind[] = ['created', 'collected']): Promise<LX.PlatformPlaylistSummary[]> => {
    if (!kinds.length) return []
    const cookie = getCookie()
    const profile = getProfile()
    if (!cookie || !profile) throw new Error('Not logged in')

    const accountKey = String(profile.userId)
    const playlistIds = new Set<string>()
    const playlists: LX.Netease.UserPlaylistSummary[] = []
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const result = await api.user_playlist({
        cookie,
        uid: profile.userId,
        limit: pageLimit,
        offset,
      })
      const body = result?.body ?? result
      if (body?.code != 200) throw new Error(body?.message ?? 'Failed to load user playlists')

      if (!Array.isArray(body?.playlist)) throw new Error('Invalid user playlist response')
      const page = body.playlist
      const previousSize = playlistIds.size
      for (const playlist of page) {
        const normalized = normalizePlaylist(playlist, accountKey)
        if (!normalized || playlistIds.has(normalized.sourceListId)) continue
        playlistIds.add(normalized.sourceListId)
        if (kinds.includes(normalized.kind)) playlists.push(normalized)
      }

      offset += page.length
      hasMore = body?.more === true && page.length > 0
      if (hasMore && playlistIds.size == previousSize) throw new Error('User playlist pagination did not advance')
    }

    return playlists
  }

  return { getUserPlaylists }
}
