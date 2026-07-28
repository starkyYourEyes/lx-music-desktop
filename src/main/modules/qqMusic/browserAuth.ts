import { BrowserWindow, session } from 'electron'
import {
  configureSessionProxy,
  type SessionProxyConfig,
} from '@main/utils/sessionProxy'
import { registerWebContentsNavigationGuard } from '@main/utils/webContentsNavigationGuard'
import { getQQMusicAccountUin } from './auth'

export type QQMusicBrowserAuthCheck =
  | { state: 'waiting' | 'scanned' | 'expired', message: string }
  | { state: 'success', message: string, cookie: string }

export type QQMusicBrowserAuthTerminalReason =
  | 'blocked-navigation'
  | 'main-frame-load-failed'
  | 'window-destroyed'

export type QQMusicBrowserAuthProgressStage =
  | 'proxy-configured'
  | 'navigation-started'
  | 'login-frame-found'
  | 'qr-image-ready'
  | 'qr-captured'
  | 'partition-cleanup-completed'

export type QQMusicBrowserAuthDiagnostic =
  | {
      stage: QQMusicBrowserAuthProgressStage
      elapsedMs: number
    }
  | {
      stage: 'cancelled' | 'timed-out'
      elapsedMs: number
    }
  | {
      stage: 'terminal-failure'
      elapsedMs: number
      reason: QQMusicBrowserAuthTerminalReason | 'qr-capture-failed'
    }
  | {
      stage: 'partition-cleanup-timed-out'
      elapsedMs: number
    }

export interface QQMusicBrowserAuthCreateOptions {
  signal: AbortSignal
  startedAt: number
  deadlineAt: number
  proxy: SessionProxyConfig | null
  cleanupTimeoutMs?: number
  onDiagnostic?: (event: QQMusicBrowserAuthDiagnostic) => void
}

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

const QR_DISCOVERY_INTERVAL_MS = 100
const PARTITION_CLEANUP_TIMEOUT_MS = 5_000
const AUTH_REDIRECT_URI = 'https://y.qq.com/portal/wx_redirect.html?login_type=1&surl=https://y.qq.com/'
const MUSIC_COOKIE_URL = 'https://u.y.qq.com/'
const CREATE_ERROR = 'QQ Music login QR creation failed'

const defaultDiagnostic = (event: QQMusicBrowserAuthDiagnostic) => {
  const isWarning = event.stage == 'timed-out' ||
    event.stage == 'terminal-failure' ||
    event.stage == 'partition-cleanup-timed-out'
  const write = isWarning ? console.warn : console.info
  write('[QQ Music browser auth diagnostic]', event)
}

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

export const isExpectedAllowedNavigationAbort = (
  error: unknown,
  isInitialLoadAbortEligible: boolean,
): boolean => {
  if (!isInitialLoadAbortEligible || !error || typeof error != 'object') return false
  const value = error as { code?: unknown, errno?: unknown, message?: unknown }
  return value.code == 'ERR_ABORTED' ||
    value.errno == -3 ||
    (typeof value.message == 'string' && value.message.includes('ERR_ABORTED'))
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

type CreateFailureReason = 'cancelled' | 'timed-out' | 'failed'

class QQMusicBrowserCreateError extends Error {
  constructor(readonly reason: CreateFailureReason) {
    super(CREATE_ERROR)
  }
}

const waitWithinCreation = async<Result>(
  promise: Promise<Result>,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<Result> => {
  return new Promise<Result>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', handleAbort)
      callback()
    }
    const handleAbort = () => {
      finish(() => reject(new QQMusicBrowserCreateError('cancelled')))
    }
    promise.then(
      value => {
        const reason = Date.now() >= deadlineAt ? 'timed-out' : null
        finish(() => {
          if (reason) reject(new QQMusicBrowserCreateError(reason))
          else resolve(value)
        })
      },
      error => {
        const timedOut = Date.now() >= deadlineAt
        finish(() => {
          if (timedOut) reject(new QQMusicBrowserCreateError('timed-out'))
          else reject(error)
        })
      },
    )

    const remainingMs = deadlineAt - Date.now()
    if (signal.aborted) {
      handleAbort()
      return
    }
    if (remainingMs <= 0) {
      finish(() => reject(new QQMusicBrowserCreateError('timed-out')))
      return
    }

    signal.addEventListener('abort', handleAbort, { once: true })
    timer = setTimeout(() => {
      finish(() => reject(new QQMusicBrowserCreateError('timed-out')))
    }, remainingMs)
  })
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

const captureQrImage = async({
  win,
  signal,
  deadlineAt,
  getTerminalReason,
  emit,
}: {
  win: Electron.BrowserWindow
  signal: AbortSignal
  deadlineAt: number
  getTerminalReason: () => QQMusicBrowserAuthTerminalReason | null
  emit: (stage: QQMusicBrowserAuthProgressStage) => void
}): Promise<string> => {
  let frameReported = false
  let imageReported = false

  while (Date.now() < deadlineAt) {
    const terminalReason = getTerminalReason()
    if (terminalReason) throw new QQMusicBrowserCreateError('failed')
    if (signal.aborted) throw new QQMusicBrowserCreateError('cancelled')
    if (win.isDestroyed()) throw new QQMusicBrowserCreateError('failed')

    const frame = findLoginFrame(win)
    if (frame) {
      if (!frameReported) {
        frameReported = true
        emit('login-frame-found')
      }
      try {
        const [iframeRect, imageInfo] = await waitWithinCreation(
          Promise.all([
            win.webContents.executeJavaScript(GET_IFRAME_RECT_SCRIPT) as Promise<RectLike | null>,
            frame.executeJavaScript(GET_QR_IMAGE_INFO_SCRIPT) as Promise<QrImageInfo | null>,
          ]),
          signal,
          deadlineAt,
        )
        if (iframeRect && imageInfo?.complete &&
          imageInfo.naturalWidth > 0 && imageInfo.naturalHeight > 0) {
          if (!imageReported) {
            imageReported = true
            emit('qr-image-ready')
          }
          const captureRect = getQQMusicQrCaptureRect(iframeRect, imageInfo)
          if (captureRect) {
            const image = await waitWithinCreation(
              win.webContents.capturePage(captureRect),
              signal,
              deadlineAt,
            )
            if (!image.isEmpty()) {
              emit('qr-captured')
              return image.toDataURL()
            }
          }
        }
      } catch (error) {
        if (error instanceof QQMusicBrowserCreateError) throw error
      }
    }

    await waitWithinCreation(delay(QR_DISCOVERY_INTERVAL_MS), signal, deadlineAt)
  }

  throw new QQMusicBrowserCreateError('timed-out')
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
  signal,
  startedAt,
  deadlineAt,
  proxy,
  cleanupTimeoutMs = PARTITION_CLEANUP_TIMEOUT_MS,
  onDiagnostic = defaultDiagnostic,
}: QQMusicBrowserAuthCreateOptions): Promise<QQMusicBrowserAuthSession> => {
  const emit = (stage: QQMusicBrowserAuthProgressStage) => {
    onDiagnostic({
      stage,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    })
  }

  let terminalReason: QQMusicBrowserAuthTerminalReason | null = null
  const markTerminal = (reason: QQMusicBrowserAuthTerminalReason) => {
    if (!terminalReason) terminalReason = reason
  }

  void cleanupTimeoutMs
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
  const authorizeUrl = createQQMusicAuthorizeUrl(crypto.randomUUID())
  let initialLoadPending = false
  let sawAllowedSupersedingNavigation = false
  const unregisterNavigationGuard = registerWebContentsNavigationGuard(
    win.webContents,
    isQQMusicLoginNavigationAllowed,
  )

  const inspectNavigation = (
    event: { preventDefault: () => void },
    value: string,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && isOAuthCallback(value)) callbackReached = true
    if (isQQMusicLoginNavigationAllowed(value)) {
      if (isMainFrame && initialLoadPending && value != authorizeUrl) {
        sawAllowedSupersedingNavigation = true
      }
      return
    }
    event.preventDefault()
    const target = getSafePageTarget(value)
    if (target == 'https://y.qq.com/') return
    markTerminal('blocked-navigation')
  }

  const handleNavigation = (
    event: Electron.Event,
    value: string,
    _isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    inspectNavigation(event, value, isMainFrame)
  }
  const handleFrameNavigation = (
    event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>,
  ) => {
    inspectNavigation(event, event.url, event.isMainFrame)
  }

  win.webContents.on('will-navigate', handleNavigation)
  win.webContents.on('will-redirect', handleNavigation)
  win.webContents.on('will-frame-navigate', handleFrameNavigation)
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
    await waitWithinCreation(
      configureSessionProxy(loginSession, proxy),
      signal,
      deadlineAt,
    )
    emit('proxy-configured')

    initialLoadPending = true
    const loadPromise = win.loadURL(authorizeUrl)
    emit('navigation-started')
    void loadPromise.then(
      () => {
        initialLoadPending = false
        sawAllowedSupersedingNavigation = false
      },
      error => {
        const expectedAbort = isExpectedAllowedNavigationAbort(
          error,
          initialLoadPending && sawAllowedSupersedingNavigation,
        )
        initialLoadPending = false
        sawAllowedSupersedingNavigation = false
        if (!expectedAbort) markTerminal('main-frame-load-failed')
      },
    )

    const qrimg = await captureQrImage({
      win,
      signal,
      deadlineAt,
      getTerminalReason: () => terminalReason,
      emit,
    })

    const check = async(): Promise<QQMusicBrowserAuthCheck> => {
      if (destroyed || win.isDestroyed() || terminalReason) {
        throw new Error('browser-auth-unavailable')
      }
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
    const reason = error instanceof QQMusicBrowserCreateError
      ? error.reason
      : 'failed'
    if (reason == 'cancelled') {
      onDiagnostic({
        stage: 'cancelled',
        elapsedMs: Math.max(0, Date.now() - startedAt),
      })
    } else if (reason == 'timed-out') {
      onDiagnostic({
        stage: 'timed-out',
        elapsedMs: Math.max(0, Date.now() - startedAt),
      })
    } else {
      onDiagnostic({
        stage: 'terminal-failure',
        elapsedMs: Math.max(0, Date.now() - startedAt),
        reason: terminalReason ?? 'qr-capture-failed',
      })
    }
    await destroy()
    throw new Error(CREATE_ERROR)
  }
}
