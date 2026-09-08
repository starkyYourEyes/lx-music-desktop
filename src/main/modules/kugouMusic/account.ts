import type { AccountRepository } from '../../storage/accounts/accountRepository'
import type { KugouApi } from './api'

const QR_TTL_MS = 5 * 60 * 1000

interface Session { key: string, expiresAt: number, generation: number, nonce: string }

const payloadOf = (result: any): any => result?.body?.data ?? result?.body ?? result?.data ?? result ?? {}

const normalizeCookie = (value: unknown): string => {
  if (value == null) return ''
  if (Array.isArray(value)) return value.map(normalizeCookie).filter(Boolean).join(';')
  if (typeof value == 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}=${String(item)}`).join(';')
  }
  return String(value)
}

const mergeCookies = (...values: unknown[]): string => {
  const parts = values.flatMap(value => normalizeCookie(value).split(';'))
    .map(value => value.trim()).filter(Boolean)
  const merged = new Map<string, string>()
  for (const part of parts) {
    const separator = part.indexOf('=')
    const name = separator > 0 ? part.slice(0, separator).trim().toLowerCase() : part
    merged.set(name, part)
  }
  return [...merged.values()].join(';')
}

const profileOf = (result: any, fallbackUserId?: unknown): LX.KuGouMusic.Profile | null => {
  const data = payloadOf(result)
  const user = data?.userInfo ?? data?.userinfo ?? data?.info ?? data
  const userId = user?.userId ?? user?.userid ?? user?.user_id ?? user?.uid ?? fallbackUserId
  if (userId == null || userId === '') return null
  return {
    userId: String(userId),
    nickname: String(user?.nickname ?? user?.username ?? user?.user_name ?? ''),
    avatarUrl: String(user?.avatarUrl ?? user?.avatar ?? user?.headImg ?? user?.headimg ?? user?.pic ?? ''),
  }
}

const invalidAccountCode = (result: any): number | null => {
  const response = result?.response ?? result
  const body = response?.body ?? response
  const codes = [body?.error_code, body?.errcode, body?.code, body?.status, body?.data?.code, response?.code]
  for (const value of codes) {
    const code = Number(value)
    if (code == 401 || code == 403 || code == 1001 || code == 2001) return code
  }
  return null
}

const explicitInvalidAccount = (result: any): boolean => invalidAccountCode(result) != null

const stateForCode = (code: number): 'waiting' | 'scanned' | 'success' | 'expired' => {
  if (code == 1) return 'waiting'
  if (code == 2) return 'scanned'
  if (code == 4) return 'success'
  return 'expired'
}

export const createKugouAccountService = ({
  accounts,
  api,
  now = Date.now,
  idFactory = () => `${Date.now()}-${Math.random()}`,
}: {
  accounts: Pick<AccountRepository, 'getStatus' | 'getCookie' | 'save' | 'clear'>
  api: Pick<KugouApi, 'loginQrKey' | 'loginQrCreate' | 'loginQrCheck' | 'userInfo'>
  now?: () => number
  idFactory?: () => string
}) => {
  const sessions = new Map<string, Session>()
  let generation = 0
  let lastClearGeneration = -1

  const prune = () => {
    const timestamp = now()
    for (const [requestId, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(requestId)
    }
  }

  const currentStatus = (): LX.KuGouMusic.AccountStatus => {
    const status = accounts.getStatus('kugou')
    return {
      isLoggedIn: !!status.loggedIn,
      profile: profileOf(status.profile),
      ...(status.unavailableReason == null ? {} : { unavailableReason: status.unavailableReason }),
    }
  }

  const getAccountStatus = async(): Promise<LX.KuGouMusic.AccountStatus> => currentStatus()

  const createLoginQr = async(requestId: string): Promise<LX.KuGouMusic.LoginQr> => {
    if (typeof requestId != 'string' || !requestId) throw new Error('KuGou login QR creation failed')
    prune()
    generation++
    const requestGeneration = generation
    sessions.delete(requestId)
    try {
      const keyResult = await api.loginQrKey()
      const keyData = payloadOf(keyResult)
      const key = keyData?.qrcode ?? keyData?.qrCode ?? keyData?.key ?? keyData?.qrkey
      if (typeof key != 'string' || !key) throw new Error('missing key')
      const qrResult = await api.loginQrCreate({ key, qrimg: true })
      const qrData = payloadOf(qrResult)
      const image = qrData?.base64 ?? qrData?.qrimg ?? qrData?.image ?? qrData?.qrImage
      if (typeof image != 'string' || !image) throw new Error('missing image')
      if (generation != requestGeneration) throw new Error('stale generation')
      sessions.set(requestId, { key, expiresAt: now() + QR_TTL_MS, generation, nonce: idFactory() })
      const qr: LX.KuGouMusic.LoginQr = { requestId, image }
      return qr
    } catch {
      throw new Error('KuGou login QR creation failed')
    }
  }

  const checkLoginQr = async(requestId: string): Promise<LX.KuGouMusic.LoginQrCheck> => {
    prune()
    const session = sessions.get(requestId)
    if (!session) return { code: 0, state: 'expired', isLoggedIn: false, profile: null }
    const sessionGeneration = session.generation
    const sessionNonce = session.nonce
    let result: any
    try {
      result = await api.loginQrCheck({ key: session.key })
    } catch {
      const current = sessions.get(requestId)
      if (generation != sessionGeneration || current?.generation != sessionGeneration || current?.nonce != sessionNonce) {
        return { code: 0, state: 'expired', isLoggedIn: false, profile: null }
      }
      throw new Error('KuGou login check failed')
    }
    if (now() >= session.expiresAt) {
      sessions.delete(requestId)
      return { code: 0, state: 'expired', isLoggedIn: false, profile: null }
    }
    if (sessions.get(requestId)?.generation != sessionGeneration ||
      sessions.get(requestId)?.nonce != sessionNonce || generation != sessionGeneration) {
      return { code: 0, state: 'expired', isLoggedIn: false, profile: null }
    }
    const data = payloadOf(result)
    if (explicitInvalidAccount(result)) {
      sessions.delete(requestId)
      lastClearGeneration = generation
      await accounts.clear('kugou')
      return { code: invalidAccountCode(result) ?? 0, state: 'expired', isLoggedIn: false, profile: null }
    }
    const code = Number(data?.status ?? data?.code ?? result?.body?.code ?? 0)
    const message: string | undefined = undefined
    const state = stateForCode(code)
    if (state == 'waiting' || state == 'scanned') return { code, state, message, isLoggedIn: false, profile: null }
    if (state != 'success') return { code, state: 'expired', message, isLoggedIn: false, profile: null }

    const cookie = mergeCookies(
      accounts.getCookie('kugou'),
      result?.cookie,
      result?.body?.cookie,
      data?.cookie,
      data?.token && (String(data.token).includes('=') ? data.token : `token=${data.token}`),
      data?.userid != null ? `userid=${data.userid}` : '',
    )
    if (!cookie) return { code, state, message, isLoggedIn: false, profile: null }
    let info: any
    try {
      info = await api.userInfo({ cookie })
    } catch (error) {
      const current = sessions.get(requestId)
      if (generation != sessionGeneration || current?.generation != sessionGeneration || current?.nonce != sessionNonce) {
        return { code, state: 'expired', isLoggedIn: false, profile: null }
      }
      if (explicitInvalidAccount(error)) {
        sessions.delete(requestId)
        lastClearGeneration = generation
        await accounts.clear('kugou')
        return { code: invalidAccountCode(error) ?? code, state: 'expired', isLoggedIn: false, profile: null }
      }
      throw new Error('KuGou login check failed')
    }
    if (sessions.get(requestId)?.generation != sessionGeneration ||
      sessions.get(requestId)?.nonce != sessionNonce || generation != sessionGeneration) {
      return { code, state: 'expired', isLoggedIn: false, profile: null }
    }
    if (explicitInvalidAccount(info)) {
      sessions.delete(requestId)
      lastClearGeneration = generation
      await accounts.clear('kugou')
      return { code, state, message, isLoggedIn: false, profile: null }
    }
    const profile = profileOf(info, data?.userId ?? data?.userid ?? data?.user_id ?? data?.uid)
    if (!profile) return { code, state, message, isLoggedIn: false, profile: null }
    const previousCookie = accounts.getCookie('kugou')
    const previousProfile = profileOf(accounts.getStatus('kugou').profile)
    await accounts.save('kugou', {
      cookie,
      profile: { userId: profile.userId, nickname: profile.nickname, avatarUrl: profile.avatarUrl ?? '' },
      updatedAtMs: now(),
    })
    if (generation != sessionGeneration || sessions.get(requestId)?.generation != sessionGeneration ||
      sessions.get(requestId)?.nonce != sessionNonce) {
      if (accounts.getCookie('kugou') == cookie) {
        if (lastClearGeneration > sessionGeneration) {
          await accounts.clear('kugou')
        } else if (previousCookie && previousProfile) {
          await accounts.save('kugou', {
            cookie: previousCookie,
            profile: { userId: previousProfile.userId, nickname: previousProfile.nickname, avatarUrl: previousProfile.avatarUrl ?? '' },
            updatedAtMs: now(),
          })
        } else {
          await accounts.clear('kugou')
        }
      }
      return { code, state: 'expired', isLoggedIn: false, profile: null }
    }
    sessions.delete(requestId)
    return { code, state, message, isLoggedIn: true, profile }
  }

  const cancelLoginQr = async(requestId: string): Promise<void> => {
    generation++
    sessions.delete(requestId)
  }

  const logout = async(): Promise<void> => {
    generation++
    lastClearGeneration = generation
    sessions.clear()
    await accounts.clear('kugou')
  }

  void idFactory
  return {
    getAccountStatus,
    getCookie: () => accounts.getCookie('kugou') ?? '',
    getProfile: () => profileOf(accounts.getStatus('kugou').profile),
    createLoginQr,
    checkLoginQr,
    cancelLoginQr,
    logout,
  }
}
