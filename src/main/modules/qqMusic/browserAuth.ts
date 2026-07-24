import { BrowserWindow, session } from 'electron'
import { registerWebContentsNavigationGuard } from '@main/utils/webContentsNavigationGuard'
import { getQQMusicAccountUin } from './auth'

export type QQMusicBrowserAuthCheck =
  | { state: 'waiting' | 'scanned' | 'expired', message: string }
  | { state: 'success', message: string, cookie: string }

export interface QQMusicBrowserAuthSession {
  qrimg: string
  check: () => Promise<QQMusicBrowserAuthCheck>
  destroy: () => Promise<void>
}

interface RectLike {
  x: number
  y: number
  width: number
  height: number
}

interface CookieLike {
  name: string
  value: string
  domain?: string
}

interface QrImageInfo extends RectLike {
  complete: boolean
  naturalWidth: number
  naturalHeight: number
}

type FrameLoginState = 'waiting' | 'scanned' | 'expired'

const AUTH_LOAD_TIMEOUT_MS = 15_000
const QR_DISCOVERY_INTERVAL_MS = 100
const AUTH_REDIRECT_URI = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/'
const MUSIC_COOKIE_URL = 'https://u.y.qq.com/'
const CREATE_ERROR = 'QQ Music login QR creation failed'

const GET_IFRAME_RECT_SCRIPT = `(() => {
  const iframe = document.querySelector('#ptlogin_iframe')
  if (!iframe) return null
  const rect = iframe.getBoundingClientRect()
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
})()`

const GET_QR_IMAGE_INFO_SCRIPT = `(() => {
  const image = document.querySelector('#qrlogin_img, #qr_img, img[src*="ptqrshow"]')
  if (!image) return null
  const rect = image.getBoundingClientRect()
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
  }
})()`

const GET_LOGIN_STATE_SCRIPT = `(() => {
  const visible = element => {
    if (!element) return false
    const style = window.getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' &&
      (element.offsetWidth > 0 || element.offsetHeight > 0 || element.getClientRects().length > 0)
  }
  if (visible(document.querySelector('#qr_invalid'))) return 'expired'
  if (visible(document.querySelector('#qrlogin_step2')) ||
    visible(document.querySelector('#qrlogin_step3'))) return 'scanned'
  return 'waiting'
})()`

export const createQQMusicAuthorizeUrl = (state: string): string => {
  const url = new URL('https://graph.qq.com/oauth2.0/show')
  url.searchParams.set('which', 'Login')
  url.searchParams.set('display', 'pc')
  url.searchParams.set('client_id', '100497308')
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', AUTH_REDIRECT_URI)
  url.searchParams.set('scope', 'get_user_info,get_app_friends')
  url.searchParams.set('state', state)
  return url.toString()
}

export const isQQMusicLoginNavigationAllowed = (value: string): boolean => {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol != 'https:' || url.username || url.password || (url.port && url.port != '443')) return false

  const allowedPaths: Record<string, string[]> = {
    'graph.qq.com': ['/oauth2.0/show', '/oauth2.0/authorize', '/oauth2.0/login_jump'],
    'ssl.ptlogin2.graph.qq.com': ['/check_sig'],
    'xui.ptlogin2.qq.com': ['/cgi-bin/xlogin'],
    'ssl.ptlogin2.qq.com': ['/check_sig', '/login', '/ptqrlogin', '/ptqrshow'],
    'y.qq.com': ['/portal/wx_redirect.html'],
  }
  return allowedPaths[url.hostname]?.includes(url.pathname) ?? false
}

export const getQQMusicQrCaptureRect = (
  iframeRect: RectLike,
  imageRect: RectLike,
): Electron.Rectangle | null => {
  const values = [
    iframeRect.x,
    iframeRect.y,
    iframeRect.width,
    iframeRect.height,
    imageRect.x,
    imageRect.y,
    imageRect.width,
    imageRect.height,
  ]
  if (values.some(value => !Number.isFinite(value)) || imageRect.width <= 0 || imageRect.height <= 0) return null
  if (imageRect.x < 0 || imageRect.y < 0 ||
    imageRect.x + imageRect.width > iframeRect.width ||
    imageRect.y + imageRect.height > iframeRect.height) return null
  return {
    x: Math.round(iframeRect.x + imageRect.x),
    y: Math.round(iframeRect.y + imageRect.y),
    width: Math.round(imageRect.width),
    height: Math.round(imageRect.height),
  }
}

export const getQQMusicBrowserCookie = (cookies: CookieLike[]): string => {
  const values = new Map<string, string>()
  for (const cookie of cookies) {
    const domain = cookie.domain?.replace(/^\./, '').toLowerCase() ?? ''
    if (!cookie.name || !cookie.value || (domain != 'qq.com' && !domain.endsWith('.qq.com'))) continue
    values.set(cookie.name, `${cookie.name}=${cookie.value}`)
  }
  return [...values.values()].join('; ')
}

const getSafePageTarget = (value: string): string => {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return ''
  }
}

const isOAuthCallback = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol == 'https:' && url.hostname == 'y.qq.com' &&
      url.pathname == '/portal/wx_redirect.html' && !!url.searchParams.get('code')
  } catch {
    return false
  }
}

const delay = async(ms: number) => new Promise(resolve => {
  setTimeout(resolve, ms)
})

const withTimeout = async<Result>(promise: Promise<Result>, timeoutMs: number): Promise<Result> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<Result>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(CREATE_ERROR))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const findLoginFrame = (win: Electron.BrowserWindow): Electron.WebFrameMain | null => {
  return win.webContents.mainFrame.frames.find(frame => {
    try {
      return ['xui.ptlogin2.qq.com', 'ssl.ptlogin2.qq.com'].includes(new URL(frame.url).hostname)
    } catch {
      return false
    }
  }) ?? null
}

const captureQrImage = async(win: Electron.BrowserWindow, timeoutMs: number): Promise<string> => {
  const deadline = Date.now() + timeoutMs
  while (!win.isDestroyed() && Date.now() < deadline) {
    const frame = findLoginFrame(win)
    if (frame) {
      try {
        const [iframeRect, imageInfo] = await Promise.all([
          win.webContents.executeJavaScript(GET_IFRAME_RECT_SCRIPT) as Promise<RectLike | null>,
          frame.executeJavaScript(GET_QR_IMAGE_INFO_SCRIPT) as Promise<QrImageInfo | null>,
        ])
        if (iframeRect && imageInfo?.complete && imageInfo.naturalWidth > 0 && imageInfo.naturalHeight > 0) {
          const captureRect = getQQMusicQrCaptureRect(iframeRect, imageInfo)
          if (captureRect) {
            const image = await win.webContents.capturePage(captureRect)
            if (!image.isEmpty()) return image.toDataURL()
          }
        }
      } catch {}
    }
    await delay(QR_DISCOVERY_INTERVAL_MS)
  }
  throw new Error(CREATE_ERROR)
}

const getFrameLoginState = async(win: Electron.BrowserWindow): Promise<FrameLoginState> => {
  const frame = findLoginFrame(win)
  if (!frame) return 'waiting'
  try {
    const state = await frame.executeJavaScript(GET_LOGIN_STATE_SCRIPT) as FrameLoginState
    return ['waiting', 'scanned', 'expired'].includes(state) ? state : 'waiting'
  } catch {
    return 'waiting'
  }
}

// The official OAuth parent page is required because current QQ login_jump only notifies its parent.
// Protocol and app identifiers follow sansenjian/qq-music-api at 90b80c99257b343ed7acfe3006131a51de36b2b5.
export const createQQMusicBrowserAuthSession = async({
  loadTimeoutMs = AUTH_LOAD_TIMEOUT_MS,
  onDiagnostic = (event: { stage: string, [key: string]: unknown }) => {
    console.warn('[QQ Music browser auth diagnostic]', event)
  },
}: {
  loadTimeoutMs?: number
  onDiagnostic?: (event: { stage: string, [key: string]: unknown }) => void
} = {}): Promise<QQMusicBrowserAuthSession> => {
  const partition = `qq-music-login:${crypto.randomUUID()}`
  const loginSession = session.fromPartition(partition, { cache: false })
  loginSession.setPermissionRequestHandler((_webContents, _permission, resolve) => {
    resolve(false)
  })
  loginSession.setPermissionCheckHandler(() => false)

  const win = new BrowserWindow({
    width: 720,
    height: 520,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      session: loginSession,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      spellcheck: false,
      autoplayPolicy: 'document-user-activation-required',
      enableWebSQL: false,
      webSecurity: true,
    },
  })
  let destroyed = false
  let callbackReached = false
  let blockedNavigation = false
  const unregisterNavigationGuard = registerWebContentsNavigationGuard(
    win.webContents,
    isQQMusicLoginNavigationAllowed,
  )

  const inspectNavigation = (event: { preventDefault: () => void }, value: string) => {
    if (isOAuthCallback(value)) callbackReached = true
    if (isQQMusicLoginNavigationAllowed(value)) return
    event.preventDefault()
    const target = getSafePageTarget(value)
    if (target != 'https://y.qq.com/') {
      blockedNavigation = true
      onDiagnostic({ stage: 'blocked-navigation', target })
    }
  }
  win.webContents.on('will-navigate', inspectNavigation)
  win.webContents.on('will-redirect', inspectNavigation)
  win.webContents.on('will-frame-navigate', event => {
    inspectNavigation(event, event.url)
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', event => {
    event.preventDefault()
  })

  const destroy = async() => {
    if (destroyed) return
    destroyed = true
    unregisterNavigationGuard()
    if (!win.isDestroyed()) win.destroy()
    await Promise.allSettled([
      loginSession.clearAuthCache(),
      loginSession.clearStorageData(),
      loginSession.clearCache(),
    ])
  }

  try {
    const authorizeUrl = createQQMusicAuthorizeUrl(crypto.randomUUID())
    await withTimeout(win.loadURL(authorizeUrl), loadTimeoutMs)
    const qrimg = await captureQrImage(win, loadTimeoutMs)

    const check = async(): Promise<QQMusicBrowserAuthCheck> => {
      if (destroyed || win.isDestroyed() || blockedNavigation) throw new Error('browser-auth-unavailable')
      const cookies = await loginSession.cookies.get({ url: MUSIC_COOKIE_URL })
      const cookie = getQQMusicBrowserCookie(cookies)
      if (getQQMusicAccountUin(cookie)) {
        return { state: 'success', message: '登录成功', cookie }
      }
      if (callbackReached) return { state: 'scanned', message: '正在完成 QQ 音乐登录' }
      const state = await getFrameLoginState(win)
      if (state == 'expired') return { state, message: '二维码已过期' }
      if (state == 'scanned') return { state, message: '等待手机确认' }
      return { state: 'waiting', message: '等待扫码' }
    }

    return { qrimg, check, destroy }
  } catch (error) {
    onDiagnostic({
      stage: 'create-failed',
      reason: (error as Error)?.message == CREATE_ERROR ? 'timeout-or-qr-missing' : 'page-load-failed',
    })
    await destroy()
    throw new Error(CREATE_ERROR)
  }
}
