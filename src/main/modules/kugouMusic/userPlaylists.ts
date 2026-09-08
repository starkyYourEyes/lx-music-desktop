import { createKugouApiClient, type KugouApi } from './api'
import { KugouAuthError } from './recommend'

const PAGE_SIZE = 100
const MAX_PAGES = 1000
const requestFailure = () => new Error('KuGou user playlists request failed')
const text = (value: unknown): string => typeof value == 'string' || typeof value == 'number' ? String(value).trim() : ''
const record = (value: any): Record<string, any> => value != null && typeof value == 'object' && !Array.isArray(value) ? value : {}
const bodyOf = (response: any): Record<string, any> => record(response?.body ?? response)
const authCodes = new Set([401, 403, 1001, 2001])

const isAuthFailure = (error: any): boolean => {
  if (error instanceof KugouAuthError) return true
  const response = error?.response ?? error
  const body = bodyOf(response)
  const data = record(body.data)
  const codes = [response?.status, response?.code, body.error_code, body.errcode, body.err_code, body.code, data.error_code, data.code]
  if (codes.some(code => authCodes.has(Number(code)))) return true
  const message = [body.message, body.msg, body.error_msg, body.errmsg, data.message, data.msg, data.errmsg].map(text).join(' ')
  return /\b(?:login|authentication)\s+(?:required|expired|invalid)\b|\b(?:not|please)\s+log(?:ged)?\s+in\b|\btoken\s+(?:expired|invalid)\b|\u672a\u767b\u5f55|\u767b\u5f55(?:\u5931\u6548|\u8fc7\u671f|\u5f02\u5e38)|\u8ba4\u8bc1(?:\u5931\u8d25|\u5931\u6548|\u8fc7\u671f)/i.test(message)
}

const dataOf = (response: any): Record<string, any> => {
  if (isAuthFailure(response)) throw new KugouAuthError()
  const body = bodyOf(response)
  if (Number(response?.status) >= 400) throw requestFailure()
  for (const code of [body.error_code, body.errcode, body.err_code, body.code]) {
    if (code != null && code !== '' && Number(code) != 0 && Number(code) != 200) throw requestFailure()
  }
  if (body.status != null && Number(body.status) != 1 && Number(body.status) != 200) throw requestFailure()
  const data = record(body.data)
  if (!Array.isArray(data.info)) throw requestFailure()
  return data
}

const globalId = (...values: unknown[]): string => {
  for (const value of values) {
    if (typeof value == 'number' && (!Number.isSafeInteger(value) || value <= 0)) continue
    const id = text(value)
    if (id && id != '0' && /^\w+$/.test(id)) return id
  }
  return ''
}

const playlistKind = (item: Record<string, any>, accountKey: string): LX.PlatformPlaylistKind => {
  const creator = text(item.list_create_userid)
  if (creator && creator != '0') return creator == accountKey ? 'created' : 'collected'
  if (item.type != null && Number(item.type) == 0) return 'created'
  if (item.type != null && Number(item.type) == 1) return 'collected'
  throw requestFailure()
}

const normalizePlaylist = (
  item: Record<string, any>,
  accountKey: string,
  kinds: readonly LX.PlatformPlaylistKind[],
): LX.PlatformPlaylistSummary | null => {
  // Cloud lists also contain collected albums, identified by their authors field.
  if (item.authors && text(item.list_create_userid) != accountKey) return null
  const kind = playlistKind(item, accountKey)
  if (!kinds.includes(kind)) return null
  const collectionId = globalId(item.list_create_gid, item.global_collection_id, item.global_specialid)
  const specialId = globalId(item.specialid, item.special_id)
  let id: string
  let sourceListId: string
  if (collectionId) {
    id = collectionId
    // Bare numeric IDs are share codes in kg/songList; global IDs need a link.
    const link = new URL('https://www.kugou.com/songlist/')
    link.searchParams.set('global_collection_id', collectionId)
    sourceListId = link.toString()
  } else if (specialId && /^\d+$/.test(specialId)) {
    id = sourceListId = `id_${specialId}`
  } else throw requestFailure()
  const name = text(item.name ?? item.specialname)
  if (!name) throw requestFailure()
  const cover = text(item.pic ?? item.imgurl ?? item.cover).replace(/\{size\}/g, '240')
  return {
    provider: 'kugou',
    kind,
    id,
    sourceListId,
    name,
    coverUrl: /^https?:\/\//i.test(cover) ? cover : '',
    accountKey,
  }
}

const totalOf = (data: Record<string, any>): number | undefined => {
  const value = data.total ?? data.total_count
  if (value == null || value === '') return undefined
  const total = Number(value)
  if (!Number.isSafeInteger(total) || total < 0) throw requestFailure()
  return total
}

export const createKugouUserPlaylistService = ({
  api = createKugouApiClient(),
  getCookie,
  getProfile,
  onAuthFailure,
}: {
  api?: Pick<KugouApi, 'userPlaylist'>
  getCookie: () => string
  getProfile: () => LX.KuGouMusic.Profile | null
  onAuthFailure?: () => Promise<void>
}) => {
  const getUserPlaylists = async(kinds: readonly LX.PlatformPlaylistKind[] = ['created', 'collected']): Promise<LX.PlatformPlaylistSummary[]> => {
    if (!kinds.length) return []
    const cookie = getCookie()
    const accountKey = text(getProfile()?.userId)
    if (!cookie || !accountKey) throw new KugouAuthError()
    const isCurrentAccount = () => getCookie() == cookie && text(getProfile()?.userId) == accountKey
    const playlists = new Map<string, LX.PlatformPlaylistSummary>()
    const seenRows = new Set<string>()
    try {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await api.userPlaylist({ cookie, userid: accountKey, page, pagesize: PAGE_SIZE })
        if (!isCurrentAccount()) throw requestFailure()
        const data = dataOf(response)
        const rows: any[] = data.info
        const before = seenRows.size
        for (const row of rows) {
          const item = record(row)
          const rowId = text(item.listid) || globalId(item.list_create_gid, item.global_collection_id, item.specialid, item.special_id)
          if (!rowId) throw requestFailure()
          seenRows.add(rowId)
          const playlist = normalizePlaylist(item, accountKey, kinds)
          if (!playlist) continue
          const previous = playlists.get(playlist.sourceListId)
          if (!previous || previous.kind != 'created') playlists.set(playlist.sourceListId, playlist)
        }
        const total = totalOf(data)
        const more = data.has_more ?? data.hasmore ?? data.more
        const reportedPageSize = Number(data.pagesize)
        const pageSize = Number.isSafeInteger(reportedPageSize) && reportedPageSize > 0 ? reportedPageSize : PAGE_SIZE
        const hasMore = more === true || Number(more) == 1
        const hasEnd = more === false || (more != null && Number(more) == 0)
        if (total != null && seenRows.size >= total && !hasMore) return [...playlists.values()]
        if (hasEnd) {
          if (total != null && seenRows.size < total) throw requestFailure()
          return [...playlists.values()]
        }
        if (total == null && !hasMore && rows.length < pageSize) return [...playlists.values()]
        if (seenRows.size == before) throw requestFailure()
      }
      throw requestFailure()
    } catch (error) {
      if (!isCurrentAccount()) throw new Error('KuGou account changed while loading playlists')
      if (isAuthFailure(error)) {
        if (onAuthFailure) await onAuthFailure().catch(() => {})
        throw new KugouAuthError()
      }
      throw requestFailure()
    }
  }

  return { getUserPlaylists }
}
