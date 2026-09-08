import path from 'node:path'

interface KugouRequestOptions {
  baseURL?: string
  url: string
  method?: string
  params?: Record<string, any>
  data?: any
  headers?: Record<string, string | number>
  encryptType?: 'android' | 'web' | 'register'
  cookie?: Record<string, any>
  encryptKey?: boolean
  clearDefaultParams?: boolean
  notSignature?: boolean
}

export interface KugouRequestResponse {
  status: number
  body: any
  cookie: string[]
  headers: Record<string, string>
}

export type KugouRequest = (options: KugouRequestOptions) => Promise<KugouRequestResponse>

type FetchLike = typeof globalThis.fetch
interface SigningHelpers {
  signKey: (hash: unknown, mid: unknown, userId: unknown, appId: unknown) => string
  signatureAndroidParams: (params: Record<string, any>, data?: string | Buffer) => string
  signatureRegisterParams: (params: Record<string, any>) => string
  signatureWebParams: (params: Record<string, any>, data?: string | Buffer) => string
}

declare const __non_webpack_require__: NodeRequire
const packageRequire = __non_webpack_require__
const packageEntry = packageRequire.resolve('kugoumusicapi')
const packageRoot = path.dirname(packageEntry)
const signing = packageRequire(path.join(packageRoot, 'util', 'helper.js')) as SigningHelpers
const config = packageRequire(path.join(packageRoot, 'util', 'config.json')) as {
  appid: number
  clientver: number
  liteAppid: number
  liteClientver: number
}

const parseSetCookie = (cookie: string): string => cookie.split(';', 1)[0]?.trim() ?? ''

export const createKugouRequest = (fetchImpl: FetchLike = globalThis.fetch): KugouRequest => {
  return async(options) => {
    let requestUrl: URL
    try {
      requestUrl = new URL(options.url, options.baseURL ?? 'https://gateway.kugou.com')
    } catch {
      throw new Error('KuGou HTTPS request failed')
    }
    if (requestUrl.protocol != 'https:') throw new Error('KuGou API requests require HTTPS')

    const cookie = options.cookie ?? {}
    const isLite = process.env.platform == 'lite'
    const appid = isLite ? config.liteAppid : config.appid
    const clientver = isLite ? config.liteClientver : config.clientver
    const dfid = cookie.dfid || '-'
    const mid = String(cookie.KUGOU_API_MID ?? '')
    const token = cookie.token || ''
    const userid = cookie.userid || 0
    const clienttime = Math.floor(Date.now() / 1000)
    const params: Record<string, any> = options.clearDefaultParams
      ? { ...(options.params ?? {}) }
      : {
          dfid,
          mid,
          uuid: '-',
          appid,
          clientver,
          clienttime,
          ...(token ? { token } : {}),
          ...(userid && userid !== 0 ? { userid } : {}),
          ...(options.params ?? {}),
        }

    if (options.encryptKey) params.key = signing.signKey(params.hash, params.mid, params.userid, params.appid)
    const signatureData = Buffer.isBuffer(options.data)
      ? options.data
      : typeof options.data == 'object' && options.data != null ? JSON.stringify(options.data) : String(options.data ?? '')
    if (!params.signature && !options.notSignature) {
      if (options.encryptType == 'register') params.signature = signing.signatureRegisterParams(params)
      else if (options.encryptType == 'web') params.signature = signing.signatureWebParams(params, signatureData)
      else params.signature = signing.signatureAndroidParams(params, signatureData)
    }

    for (const [key, value] of Object.entries(params)) {
      if (value == null) continue
      requestUrl.searchParams.set(key, typeof value == 'object' ? JSON.stringify(value) : String(value))
    }

    const headers: Record<string, string> = {
      'User-Agent': 'Android15-1070-11083-46-0-DiscoveryDRADProtocol-wifi',
      dfid: String(dfid),
      clienttime: String(params.clienttime ?? clienttime),
      mid,
      'kg-rc': '1',
      'kg-thash': '5d816a0',
      'kg-rec': '1',
      'kg-rf': 'B9EDA08A64250DEFFBCADDEE00F8F25F',
    }
    for (const [key, value] of Object.entries(options.headers ?? {})) headers[key] = String(value)

    const method = (options.method ?? 'GET').toUpperCase()
    let body: BodyInit | undefined
    if (method != 'GET' && method != 'HEAD' && options.data != null) {
      body = (Buffer.isBuffer(options.data) ? options.data : signatureData) as unknown as BodyInit
      if (!Object.keys(headers).some(key => key.toLowerCase() == 'content-type') && !Buffer.isBuffer(options.data)) {
        headers['Content-Type'] = 'application/json'
      }
    }

    try {
      const response = await fetchImpl(requestUrl, { method, headers, body, redirect: 'error' })
      const rawBody = await response.text()
      let responseBody: any = rawBody
      try { responseBody = JSON.parse(rawBody) } catch {}

      const getSetCookie = (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
      const rawCookies = typeof getSetCookie == 'function'
        ? getSetCookie.call(response.headers)
        : [response.headers.get('set-cookie') ?? '']
      const responseHeaders: Record<string, string> = {}
      const ssaCode = response.headers.get('ssa-code') ?? response.headers.get('SSA-CODE')
      if (ssaCode) responseHeaders['ssa-code'] = ssaCode

      return {
        status: response.status,
        body: responseBody,
        cookie: rawCookies.map(parseSetCookie).filter(Boolean),
        headers: responseHeaders,
      }
    } catch {
      throw new Error('KuGou HTTPS request failed')
    }
  }
}
