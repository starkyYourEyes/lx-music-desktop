import {
  createQQMusicBrowserAuthSession,
  type QQMusicBrowserAuthSession,
} from './browserAuth'

export interface QQMusicLoginQr {
  key: string
  qrimg: string
}

export type QQMusicInternalLoginCheck =
  | { state: 'waiting' | 'scanned' | 'expired', message: string }
  | { state: 'success', message: string, cookie: string }

type QQMusicLoginDiagnostic =
  | { stage: 'browser-auth-error', reason: 'create-failed' | 'check-failed' }

interface LoginEntry {
  auth: QQMusicBrowserAuthSession
  expiresAt: number
}

const QR_SESSION_TTL_MS = 5 * 60 * 1000
const CREATE_ERROR = 'QQ Music login QR creation failed'
const CHECK_ERROR = 'QQ Music login check failed'
const EXPIRED_RESULT: QQMusicInternalLoginCheck = {
  state: 'expired',
  message: '二维码已过期',
}

const defaultDiagnostic = (event: QQMusicLoginDiagnostic) => {
  console.warn('[QQ Music login diagnostic]', event)
}

export const createQQMusicLoginService = ({
  createBrowserAuthSession = createQQMusicBrowserAuthSession,
  idFactory = () => crypto.randomUUID(),
  now = Date.now,
  ttlMs = QR_SESSION_TTL_MS,
  onDiagnostic = defaultDiagnostic,
}: {
  createBrowserAuthSession?: () => Promise<QQMusicBrowserAuthSession>
  idFactory?: () => string
  now?: () => number
  ttlMs?: number
  onDiagnostic?: (event: QQMusicLoginDiagnostic) => void
} = {}) => {
  const entries = new Map<string, LoginEntry>()

  const disposeEntry = async(key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    try {
      await entry.auth.destroy()
    } catch {}
  }

  const clearEntries = async() => {
    await Promise.all([...entries.keys()].map(disposeEntry))
  }

  const createLoginQr = async(): Promise<QQMusicLoginQr> => {
    await clearEntries()
    let auth: QQMusicBrowserAuthSession | undefined
    try {
      auth = await createBrowserAuthSession()
      if (!auth.qrimg.startsWith('data:image/png;base64,')) throw new Error(CREATE_ERROR)
    } catch {
      try {
        await auth?.destroy()
      } catch {}
      onDiagnostic({ stage: 'browser-auth-error', reason: 'create-failed' })
      throw new Error(CREATE_ERROR)
    }
    const key = idFactory()
    entries.set(key, { auth, expiresAt: now() + ttlMs })
    return { key, qrimg: auth.qrimg }
  }

  const checkLoginQr = async(key: string): Promise<QQMusicInternalLoginCheck> => {
    const entry = entries.get(key)
    if (!entry) return EXPIRED_RESULT
    if (entry.expiresAt <= now()) {
      await disposeEntry(key)
      return EXPIRED_RESULT
    }

    let result: QQMusicInternalLoginCheck
    try {
      result = await entry.auth.check()
    } catch {
      await disposeEntry(key)
      onDiagnostic({ stage: 'browser-auth-error', reason: 'check-failed' })
      throw new Error(CHECK_ERROR)
    }

    if (result.state == 'expired' || result.state == 'success') await disposeEntry(key)
    return result
  }

  return { createLoginQr, checkLoginQr }
}
