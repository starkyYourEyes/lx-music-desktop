import {
  createQrSessionStore,
  getCookieValue,
  getGtk,
  getGuid,
  getQQMusicAccountUin,
  getSetCookieValues,
  hash33,
  mergeCookieValues,
  type QQQrSessionStore,
} from './auth'

export interface QQMusicLoginQr {
  key: string
  qrimg: string
}

export type QQMusicInternalLoginCheck =
  | { state: 'waiting' | 'scanned' | 'expired', message: string }
  | { state: 'success', message: string, cookie: string }

const LOGIN_JUMP_URL = 'https://graph.qq.com/oauth2.0/login_jump'
const OAUTH_REDIRECT_URI = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/'
const REQUEST_TIMEOUT_MS = 10_000
const CREATE_ERROR = 'QQ Music login QR creation failed'
const CHECK_ERROR = 'QQ Music login check failed'

// Protocol adapted from sansenjian/qq-music-api at commit 90b80c99257b343ed7acfe3006131a51de36b2b5.
export const parseQQQrStatus = (text: string): { code: string, redirectUrl: string } => {
  const match = text.match(/^\s*ptuiCB\(\s*'([^']*)'\s*,\s*'[^']*'\s*,\s*'([^']*)'/)
  return {
    code: match?.[1] ?? '',
    redirectUrl: match?.[2] ?? '',
  }
}

const getTrustedCheckSigUrl = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(CHECK_ERROR)
  }
  const hasTrustedOrigin = url.protocol == 'https:' && !url.username && !url.password &&
    (!url.port || url.port == '443')
  const hasTrustedTarget =
    (url.hostname == 'ssl.ptlogin2.graph.qq.com' && url.pathname == '/check_sig') ||
    (url.hostname == 'graph.qq.com' && ['/oauth2.0/login_jump', '/check-sig'].includes(url.pathname))
  if (!hasTrustedOrigin || !hasTrustedTarget) throw new Error(CHECK_ERROR)
  return url.toString()
}

const getTrustedOAuthCode = (value: string): string => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(CHECK_ERROR)
  }
  const isTrusted = url.protocol == 'https:' && !url.username && !url.password &&
    (!url.port || url.port == '443') && url.hostname == 'y.qq.com' &&
    url.pathname == '/portal/wx_redirect.html'
  const code = isTrusted ? url.searchParams.get('code') ?? '' : ''
  if (!code) throw new Error(CHECK_ERROR)
  return code
}

const fetchWithTimeout = async<Result>(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit = {},
  consume: (response: Response) => Result | Promise<Result>,
  timeoutMs: number,
): Promise<Result> => {
  const controller = new AbortController()
  const suppliedSignal = init.signal
  const abortFromSuppliedSignal = () => {
    controller.abort(suppliedSignal?.reason)
  }
  if (suppliedSignal?.aborted) abortFromSuppliedSignal()
  else suppliedSignal?.addEventListener('abort', abortFromSuppliedSignal, { once: true })
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  try {
    const response = await fetchImpl(input, { ...init, signal: controller.signal })
    return await consume(response)
  } finally {
    clearTimeout(timer)
    suppliedSignal?.removeEventListener('abort', abortFromSuppliedSignal)
  }
}

const getResponseCookies = (response: Response) => {
  return getSetCookieValues(response.headers).filter(value => !/^\s*qrsig=/i.test(value))
}

const createAuthorizeData = (pSkey: string) => {
  const data = new FormData()
  data.append('response_type', 'code')
  data.append('client_id', '100497308')
  data.append('redirect_uri', OAUTH_REDIRECT_URI)
  data.append('scope', 'get_user_info,get_app_friends')
  data.append('state', 'state')
  data.append('switch', '')
  data.append('from_ptlogin', '1')
  data.append('src', '1')
  data.append('update_auth', '1')
  data.append('openapi', '1010_1030')
  data.append('g_tk', String(getGtk(pSkey)))
  data.append('auth_time', new Date().toString())
  data.append('ui', getGuid())
  return data
}

const getLoginBody = (pSkey: string, code: string) => JSON.stringify({
  comm: { g_tk: getGtk(pSkey), platform: 'yqq', ct: 24, cv: 0 },
  req: {
    module: 'QQConnectLogin.LoginServer',
    method: 'QQLogin',
    param: { code },
  },
})

export const createQQMusicLoginService = ({
  fetchImpl = fetch,
  sessions = createQrSessionStore(),
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
}: {
  fetchImpl?: typeof fetch
  sessions?: QQQrSessionStore
  requestTimeoutMs?: number
} = {}) => {
  const createLoginQr = async(): Promise<QQMusicLoginQr> => {
    try {
      const url = new URL('https://ssl.ptlogin2.qq.com/ptqrshow')
      url.searchParams.set('appid', '716027609')
      url.searchParams.set('e', '2')
      url.searchParams.set('l', 'M')
      url.searchParams.set('s', '3')
      url.searchParams.set('d', '72')
      url.searchParams.set('v', '4')
      url.searchParams.set('t', String(Math.random()))
      url.searchParams.set('daid', '383')
      url.searchParams.set('pt_3rd_aid', '100497308')
      url.searchParams.set('u1', LOGIN_JUMP_URL)
      const { qrsig, bytes } = await fetchWithTimeout(fetchImpl, url, {}, async response => {
        if (!response.ok) throw new Error(CREATE_ERROR)
        const cookie = mergeCookieValues(getSetCookieValues(response.headers))
        const qrsig = getCookieValue(cookie, 'qrsig')
        if (!qrsig) throw new Error(CREATE_ERROR)
        return { qrsig, bytes: await response.arrayBuffer() }
      }, requestTimeoutMs)
      const key = sessions.create({ qrsig, ptqrtoken: hash33(qrsig) })
      return {
        key,
        qrimg: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
      }
    } catch {
      throw new Error(CREATE_ERROR)
    }
  }

  const completeOAuth = async(response: Response, redirectUrl: string): Promise<string> => {
    const cookieValues = getResponseCookies(response)
    const getCookie = () => mergeCookieValues(cookieValues)

    const checkSigResponse = await fetchWithTimeout(fetchImpl, redirectUrl, {
      redirect: 'manual',
      headers: { Cookie: getCookie() },
    }, response => response, requestTimeoutMs)
    cookieValues.push(...getResponseCookies(checkSigResponse))
    const pSkey = getCookieValue(getCookie(), 'p_skey')
    if (!pSkey) throw new Error(CHECK_ERROR)

    const authorizeResponse = await fetchWithTimeout(fetchImpl, 'https://graph.qq.com/oauth2.0/authorize', {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: getCookie() },
      body: createAuthorizeData(pSkey),
    }, response => response, requestTimeoutMs)
    cookieValues.push(...getResponseCookies(authorizeResponse))
    const location = authorizeResponse.headers.get('location')
    if (authorizeResponse.status < 300 || authorizeResponse.status >= 400 || !location) {
      throw new Error(CHECK_ERROR)
    }
    const code = getTrustedOAuthCode(location)

    const loginResponse = await fetchWithTimeout(fetchImpl, 'https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: getCookie(),
      },
      body: getLoginBody(pSkey, code),
    }, response => response, requestTimeoutMs)
    if (!loginResponse.ok) throw new Error(CHECK_ERROR)
    cookieValues.push(...getResponseCookies(loginResponse))
    const cookie = getCookie()
    if (!getQQMusicAccountUin(cookie)) throw new Error(CHECK_ERROR)
    return cookie
  }

  const checkLoginQr = async(key: string): Promise<QQMusicInternalLoginCheck> => {
    const session = sessions.get(key)
    if (!session) return { state: 'expired', message: '二维码已过期' }

    let response: Response
    let status: ReturnType<typeof parseQQQrStatus>
    try {
      const url = new URL('https://ssl.ptlogin2.qq.com/ptqrlogin')
      url.searchParams.set('u1', LOGIN_JUMP_URL)
      url.searchParams.set('ptqrtoken', String(session.ptqrtoken))
      url.searchParams.set('ptredirect', '0')
      url.searchParams.set('h', '1')
      url.searchParams.set('t', '1')
      url.searchParams.set('g', '1')
      url.searchParams.set('from_ui', '1')
      url.searchParams.set('ptlang', '2052')
      url.searchParams.set('action', '0-0-1711022193435')
      url.searchParams.set('js_ver', '23111510')
      url.searchParams.set('js_type', '1')
      url.searchParams.set('login_sig', 'du-YS1h8*0GqVqcrru0pXkpwVg2DYw-DtbFulJ62IgPf6vfiJe*4ONVrYc5hMUNE')
      url.searchParams.set('pt_uistyle', '40')
      url.searchParams.set('aid', '716027609')
      url.searchParams.set('daid', '383')
      url.searchParams.set('pt_3rd_aid', '100497308')
      url.searchParams.set('o1vId', '3674fc47871e9c407d8838690b355408')
      url.searchParams.set('pt_js_version', 'v1.48.1')
      const pollResult = await fetchWithTimeout(fetchImpl, url, {
        headers: { Cookie: `qrsig=${session.qrsig}` },
      }, async response => {
        if (!response.ok) throw new Error(CHECK_ERROR)
        return { response, text: await response.text() }
      }, requestTimeoutMs)
      response = pollResult.response
      status = parseQQQrStatus(pollResult.text)
    } catch {
      throw new Error(CHECK_ERROR)
    }

    if (status.code == '66') return { state: 'waiting', message: '等待扫码' }
    if (status.code == '67') return { state: 'scanned', message: '等待手机确认' }
    if (status.code == '65') {
      sessions.delete(key)
      return { state: 'expired', message: '二维码已过期' }
    }
    if (status.code != '0' || !status.redirectUrl) {
      sessions.delete(key)
      throw new Error(CHECK_ERROR)
    }

    try {
      const cookie = await completeOAuth(response, getTrustedCheckSigUrl(status.redirectUrl))
      sessions.delete(key)
      return { state: 'success', message: '登录成功', cookie }
    } catch {
      sessions.delete(key)
      throw new Error(CHECK_ERROR)
    }
  }

  return { createLoginQr, checkLoginQr }
}
