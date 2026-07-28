import { getCookieValue, mergeCookieUpdates } from './auth'
import { createQQMusicFallbackGuid } from './request'

const REFRESH_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg'
const REFRESH_AFTER_MS = 20 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 10_000
const INVALID_CODES = new Set([1000, 104400, 104401])

type JsonRecord = Record<string, unknown>

export type QQMusicCredentialRefreshErrorKind =
  | 'invalid'
  | 'unavailable'
  | 'transient'

export class QQMusicCredentialRefreshError extends Error {
  readonly kind: QQMusicCredentialRefreshErrorKind

  constructor(kind: QQMusicCredentialRefreshErrorKind) {
    super(`QQ Music credential refresh ${kind}`)
    this.name = 'QQMusicCredentialRefreshError'
    this.kind = kind
  }
}

export const isQQMusicCredentialRefreshError = (
  error: unknown,
): error is QQMusicCredentialRefreshError => {
  const value = error as Partial<QQMusicCredentialRefreshError> | null
  return !!value &&
    value.name == 'QQMusicCredentialRefreshError' &&
    (value.kind == 'invalid' ||
      value.kind == 'unavailable' ||
      value.kind == 'transient')
}

export interface QQMusicCredentialService {
  refresh: (cookie: string) => Promise<string>
  getRefreshDueAt: (cookie: string) => number | null
}

interface QQMusicRefreshInput {
  currentUin: string
  currentQQMusicUin: string
  uin: string
  musicId: number
  musicKey: string
  openid: string
  accessToken: string
  refreshToken: string
}

const normalizeUin = (cookie: string): string => {
  return (
    getCookieValue(cookie, 'uin') ||
    getCookieValue(cookie, 'qqmusic_uin')
  ).replace(/^o/, '')
}

const getRefreshInput = (cookie: string): QQMusicRefreshInput | null => {
  const currentUin = getCookieValue(cookie, 'uin')
  const currentQQMusicUin = getCookieValue(cookie, 'qqmusic_uin')
  const uin = normalizeUin(cookie)
  const musicId = Number(uin)
  const musicKey =
    getCookieValue(cookie, 'qqmusic_key') ||
    getCookieValue(cookie, 'qm_keyst')
  const openid = getCookieValue(cookie, 'psrf_qqopenid')
  const accessToken = getCookieValue(cookie, 'psrf_qqaccess_token')
  const refreshToken = getCookieValue(cookie, 'psrf_qqrefresh_token')
  if (!uin ||
    !/^[1-9]\d*$/.test(uin) ||
    !Number.isSafeInteger(musicId) ||
    musicId <= 0 ||
    !musicKey ||
    !openid ||
    !accessToken ||
    !refreshToken) return null
  return {
    currentUin,
    currentQQMusicUin,
    uin,
    musicId,
    musicKey,
    openid,
    accessToken,
    refreshToken,
  }
}

export const getQQMusicCredentialRefreshDueAt = (
  cookie: string,
): number | null => {
  if (!getRefreshInput(cookie)) return null
  const createdAt = Number(
    getCookieValue(cookie, 'psrf_musickey_createtime'),
  )
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) return null
  return createdAt * 1000 + REFRESH_AFTER_MS
}

const getRotatedUin = (
  current: string,
  returned: unknown,
): string | undefined => {
  const value = String(returned ?? '').replace(/^o/, '')
  if (!value) return undefined
  return current.startsWith('o') ? `o${value}` : value
}

const getMeaningfulValue = (
  ...values: unknown[]
): string | number | undefined => {
  return values.find((value): value is string | number => {
    if (typeof value != 'string' && typeof value != 'number') return false
    const normalized = String(value).trim()
    return !!normalized && normalized != '0'
  })
}

const isJsonRecord = (value: unknown): value is JsonRecord => {
  return typeof value == 'object' && value != null && !Array.isArray(value)
}

const getScalarValue = (value: unknown): string | number | undefined => {
  return typeof value == 'string' || typeof value == 'number'
    ? value
    : undefined
}

export const createQQMusicCredentialService = ({
  fetchImpl = fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: {
  fetchImpl?: typeof fetch
  timeoutMs?: number
} = {}): QQMusicCredentialService => {
  const refresh = async(cookie: string): Promise<string> => {
    const input = getRefreshInput(cookie)
    if (!input) throw new QQMusicCredentialRefreshError('unavailable')
    const {
      currentUin,
      currentQQMusicUin,
      uin,
      musicId,
      musicKey,
      openid,
      accessToken,
      refreshToken,
    } = input

    const expiresAt =
      Number(getCookieValue(cookie, 'psrf_access_token_expiresAt')) || 0
    const unionid = getCookieValue(cookie, 'psrf_qqunionid')
    const body = JSON.stringify({
      comm: {
        _channelid: '19',
        _os_version: '6.2.9200-2',
        authst: musicKey,
        ct: '19',
        cv: '2116',
        guid:
          getCookieValue(cookie, 'guid') ||
          getCookieValue(cookie, 'qqmusic_guid') ||
          createQQMusicFallbackGuid(uin),
        patch: '118',
        psrf_access_token_expiresAt: expiresAt,
        psrf_qqaccess_token: accessToken,
        psrf_qqopenid: openid,
        psrf_qqunionid: unionid,
        tmeAppID: 'qqmusic',
        tmeLoginType: Number(getCookieValue(cookie, 'tmeLoginType')) || 2,
        uin,
        wid: getCookieValue(cookie, 'wid') || '0',
      },
      req_0: {
        module: 'music.login.LoginServer',
        method: 'Login',
        param: {
          access_token: accessToken,
          appid: 100497308,
          expired_in: expiresAt,
          encryptUin: getCookieValue(cookie, 'euin'),
          forceRefreshToken: 0,
          musicid: musicId,
          musickey: musicKey,
          musickeyCreateTime:
            Number(getCookieValue(cookie, 'psrf_musickey_createtime')) || 0,
          onlyNeedAccessToken: 0,
          openid,
          refresh_key: getCookieValue(cookie, 'refresh_key'),
          refresh_token: refreshToken,
          str_musicid: uin,
          unionid,
        },
      },
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    let payload: unknown
    try {
      const response = await fetchImpl(REFRESH_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://y.qq.com',
          Referer: 'https://y.qq.com/',
          Cookie: cookie,
        },
        body,
      })
      if (!response.ok) throw new Error()
      payload = await response.json()
    } catch {
      throw new QQMusicCredentialRefreshError('transient')
    } finally {
      clearTimeout(timeout)
    }
    if (!isJsonRecord(payload)) {
      throw new QQMusicCredentialRefreshError('transient')
    }
    const moduleResult = payload.req_0
    if (!isJsonRecord(moduleResult)) {
      throw new QQMusicCredentialRefreshError('transient')
    }
    if (
      typeof moduleResult.code == 'number' &&
      INVALID_CODES.has(moduleResult.code)
    ) {
      throw new QQMusicCredentialRefreshError('invalid')
    }
    const data = moduleResult.data
    if (
      payload.code !== 0 ||
      moduleResult.code !== 0 ||
      !isJsonRecord(data) ||
      typeof data.musickey != 'string' ||
      !data.musickey.trim() ||
      data.musickey.trim() == '0'
    ) {
      throw new QQMusicCredentialRefreshError('transient')
    }

    const normalizedReturnedUins = [data.str_musicid, data.musicid]
      .map(value => String(value ?? '').replace(/^o/, '').trim())
      .filter(value => value && value != '0')
    if (normalizedReturnedUins.some(value => value != uin)) {
      throw new QQMusicCredentialRefreshError('transient')
    }
    const normalizedReturnedUin = normalizedReturnedUins[0]
    const returnedExpiresAt = getMeaningfulValue(
      data.expired_at,
      data.expired_in,
    )
    return mergeCookieUpdates(cookie, {
      psrf_qqopenid: getScalarValue(data.openid),
      psrf_qqunionid: getScalarValue(data.unionid),
      psrf_qqaccess_token: getScalarValue(data.access_token),
      psrf_qqrefresh_token: getScalarValue(data.refresh_token),
      qqmusic_key: data.musickey,
      qm_keyst: data.musickey,
      psrf_musickey_createtime: getScalarValue(data.musickeyCreateTime),
      psrf_access_token_expiresAt: returnedExpiresAt,
      euin: getScalarValue(data.encryptUin),
      refresh_key: getScalarValue(data.refresh_key),
      login_type: getScalarValue(data.login_type),
      tmeLoginType: getScalarValue(data.loginType),
      uin: currentUin
        ? getRotatedUin(currentUin, normalizedReturnedUin)
        : undefined,
      qqmusic_uin: currentQQMusicUin
        ? getRotatedUin(currentQQMusicUin, normalizedReturnedUin)
        : undefined,
    })
  }

  return {
    refresh,
    getRefreshDueAt: getQQMusicCredentialRefreshDueAt,
  }
}
