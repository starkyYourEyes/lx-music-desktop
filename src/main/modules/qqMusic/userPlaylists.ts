import { getCookieValue, getGtk } from './auth'
import { QQMusicAuthError } from './song'

const USER_PLAYLIST_ERROR = 'QQ Music user playlists request failed'
const PAGE_SIZE = 100
const MAX_PAGES = 1000
const CREATED_URL = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss'
const COLLECTED_URL = 'https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg'

const getId = (value: unknown): string => {
  if (typeof value == 'number' && !Number.isSafeInteger(value)) return ''
  if (typeof value != 'string' && typeof value != 'number') return ''
  const id = String(value)
  return /^[1-9]\d*$/.test(id) ? id : ''
}

const getText = (value: unknown): string => typeof value == 'string' ? value.trim() : ''

const normalizePlaylist = (
  playlist: any,
  kind: LX.PlatformPlaylistKind,
  accountKey: string,
): LX.PlatformPlaylistSummary | null => {
  // dirid is an account-local folder number, not a playable global playlist ID.
  const id = getId(kind == 'created' ? playlist?.tid : playlist?.dissid)
  if (!id) return null
  return {
    provider: 'qq_music',
    kind,
    id,
    sourceListId: id,
    name: getText(kind == 'created' ? playlist?.diss_name : playlist?.dissname),
    coverUrl: getText(kind == 'created' ? playlist?.diss_cover : playlist?.logo),
    accountKey,
  }
}

const getTotal = (value: unknown): number | null => {
  if (value == null) return null
  if (typeof value != 'number' && (typeof value != 'string' || !/^\d+$/.test(value))) {
    throw new Error(USER_PLAYLIST_ERROR)
  }
  const total = Number(value)
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(USER_PLAYLIST_ERROR)
  return total
}

export const createQQMusicUserPlaylistService = ({
  fetchImpl = fetch,
  getCookie,
  getProfile,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: {
  fetchImpl?: typeof fetch
  getCookie: () => string
  getProfile: () => LX.QQMusic.Profile | null
  setTimeoutImpl?: typeof setTimeout
  clearTimeoutImpl?: typeof clearTimeout
}) => {
  const getUserPlaylists = async(
    kinds: readonly LX.PlatformPlaylistKind[] = ['created', 'collected'],
  ): Promise<LX.PlatformPlaylistSummary[]> => {
    const requestedKinds = (['created', 'collected'] as const).filter(kind => kinds.includes(kind))
    if (!requestedKinds.length) return []
    const cookie = getCookie()
    const profile = getProfile()
    const uin = (getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')).replace(/^o0*/, '')
    const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
    if (!key || !getId(uin) || !profile || profile.uin.replace(/^o0*/, '') != uin) {
      throw new QQMusicAuthError('QQ Music account is not logged in')
    }
    const accountKey = profile.uin
    const assertCurrentAccount = () => {
      if (getCookie() != cookie || getProfile()?.uin != accountKey) throw new QQMusicAuthError()
    }

    const requestPage = async(kind: LX.PlatformPlaylistKind, offset: number) => {
      assertCurrentAccount()
      const url = new URL(kind == 'created' ? CREATED_URL : COLLECTED_URL)
      const params: Record<string, string> = {
        format: 'json',
        inCharset: 'utf8',
        outCharset: 'utf-8',
        notice: '0',
        platform: 'yqq.json',
        needNewCode: '0',
        g_tk: String(getGtk(key)),
        loginUin: uin,
        hostUin: '0',
        sin: String(offset),
      }
      if (kind == 'created') {
        params.hostuin = uin
        params.size = String(PAGE_SIZE)
      } else {
        params.ct = '20'
        params.cid = '205360956'
        params.userid = uin
        params.reqtype = '3'
        params.ein = String(offset + PAGE_SIZE)
      }
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
      const controller = new AbortController()
      const timer = setTimeoutImpl(() => { controller.abort() }, 10_000)
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            Referer: 'https://y.qq.com/portal/profile.html',
            Cookie: cookie,
          },
        })
        if (response.status == 401 || response.status == 403) throw new QQMusicAuthError()
        if (!response.ok) throw new Error(USER_PLAYLIST_ERROR)
        const payload = await response.json()
        if (payload?.code == 1000 || (payload?.code == -1 && payload?.subcode == -2)) {
          throw new QQMusicAuthError()
        }
        if (payload?.code != 0) throw new Error(USER_PLAYLIST_ERROR)
        const data = payload?.data
        const rows = kind == 'created' ? data?.disslist : data?.cdlist
        if (!Array.isArray(rows)) throw new Error(USER_PLAYLIST_ERROR)
        return {
          rows,
          total: getTotal(kind == 'created' ? data.total : data.totaldiss),
        }
      } finally {
        clearTimeoutImpl(timer)
      }
    }

    try {
      const playlists = new Map<string, LX.PlatformPlaylistSummary>()
      for (const kind of requestedKinds) {
        let offset = 0
        const pageSignatures = new Set<string>()
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) throw new Error(USER_PLAYLIST_ERROR)
          const { rows, total } = await requestPage(kind, offset)
          if (!rows.length) {
            if (total != null && offset < total) throw new Error(USER_PLAYLIST_ERROR)
            break
          }
          const signature = JSON.stringify(rows.map(row => kind == 'created' ? row?.tid : row?.dissid))
          if (pageSignatures.has(signature)) throw new Error(USER_PLAYLIST_ERROR)
          pageSignatures.add(signature)
          for (const row of rows) {
            const playlist = normalizePlaylist(row, kind, accountKey)
            if (!playlist || playlists.has(playlist.id)) continue
            playlists.set(playlist.id, playlist)
          }
          // Count upstream rows, including duplicates; the two APIs use different end bounds.
          offset += rows.length
          if (total != null ? offset >= total : rows.length < PAGE_SIZE) break
        }
      }
      assertCurrentAccount()
      return [...playlists.values()]
    } catch (error) {
      if (error instanceof QQMusicAuthError) throw error
      throw new Error(USER_PLAYLIST_ERROR)
    }
  }

  return { getUserPlaylists }
}
