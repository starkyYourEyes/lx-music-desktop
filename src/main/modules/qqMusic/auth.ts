export interface QQQrSession {
  qrsig: string
  ptqrtoken: number
}

interface HeadersWithSetCookie {
  getSetCookie?: () => string[]
  get: (name: string) => string | null
}

export const hash33 = (value: string): number => {
  let hash = 0
  for (const char of value) hash += (hash << 5) + char.charCodeAt(0)
  return hash & 0x7fffffff
}

export const getGtk = (value: string): number => {
  let hash = 5381
  for (const char of value) hash += (hash << 5) + char.charCodeAt(0)
  return hash & 0x7fffffff
}

export const getGuid = (): string => crypto.randomUUID().toUpperCase()

const splitCombinedSetCookie = (value: string): string[] => {
  return value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/).map(item => item.trim()).filter(Boolean)
}

export const getSetCookieValues = (headers: HeadersWithSetCookie): string[] => {
  const structured = headers.getSetCookie?.()
  if (structured?.length) return structured
  const combined = headers.get('set-cookie')
  return combined ? splitCombinedSetCookie(combined) : []
}

const getCookiePair = (value: string) => {
  const pair = value.split(';', 1)[0].trim()
  const separator = pair.indexOf('=')
  if (separator <= 0 || separator == pair.length - 1) return null
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  }
}

export const mergeCookieValues = (values: string[]): string => {
  const cookies = new Map<string, string>()
  for (const value of values) {
    const pair = getCookiePair(value)
    if (pair) cookies.set(pair.name, `${pair.name}=${pair.value}`)
  }
  return [...cookies.values()].join('; ')
}

export const getCookieValue = (cookie: string, name: string): string => {
  let result = ''
  for (const item of cookie.split(';')) {
    const pair = getCookiePair(item)
    if (pair?.name == name) result = pair.value
  }
  return result
}

export const getQQMusicAccountUin = (cookie: string): string => {
  const key = getCookieValue(cookie, 'qqmusic_key') || getCookieValue(cookie, 'qm_keyst')
  const uin = getCookieValue(cookie, 'uin') || getCookieValue(cookie, 'qqmusic_uin')
  return key && uin ? uin : ''
}

export const redactQQMusicSecret = (value: unknown): string => {
  return String(value)
    .replace(/("Cookie"\s*:\s*")(?:\\.|[^"\\\r\n])*"/gi, '$1[REDACTED]"')
    .replace(/('Cookie'\s*:\s*')(?:\\.|[^'\\\r\n])*'/gi, "$1[REDACTED]'")
    .replace(/Cookie:\s*[^\r\n]*?(?=(?<![;\s])\s+(?:qrsig|ptqrtoken|code)=|[\r\n]|$)/gi, 'Cookie: [REDACTED]')
    .replace(/\b(qrsig|ptqrtoken|code)=([^\s&]+)/gi, '$1=[REDACTED]')
}

export const createQrSessionStore = ({
  now = Date.now,
  idFactory = () => crypto.randomUUID(),
  ttlMs = 5 * 60 * 1000,
}: {
  now?: () => number
  idFactory?: () => string
  ttlMs?: number
} = {}) => {
  const entries = new Map<string, { value: QQQrSession, expiresAt: number }>()
  const clearExpired = () => {
    const current = now()
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= current) entries.delete(key)
    }
  }
  return {
    create(value: QQQrSession) {
      clearExpired()
      const key = idFactory()
      entries.set(key, { value, expiresAt: now() + ttlMs })
      return key
    },
    get(key: string) {
      clearExpired()
      return entries.get(key)?.value ?? null
    },
    delete(key: string) {
      entries.delete(key)
    },
    clearExpired,
    size() {
      clearExpired()
      return entries.size
    },
  }
}

export type QQQrSessionStore = ReturnType<typeof createQrSessionStore>
