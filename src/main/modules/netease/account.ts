import type { AccountRepository } from '@main/storage/accounts/accountRepository'

interface NeteaseAccountApi {
  login_qr_key: (params?: Record<string, unknown>) => Promise<any>
  login_qr_create: (params: Record<string, unknown>) => Promise<any>
  login_qr_check: (params: Record<string, unknown>) => Promise<any>
  login_status: (params: Record<string, unknown>) => Promise<any>
  logout: (params: Record<string, unknown>) => Promise<any>
}

const normalizeCookie = (cookie: unknown): string => {
  if (!cookie) return ''
  if (Array.isArray(cookie)) return cookie.join(';')
  return String(cookie)
}

const normalizeProfile = (profile: any): LX.Netease.Profile | null => {
  if (!profile?.userId) return null
  return {
    userId: profile.userId,
    nickname: profile.nickname ?? '',
    avatarUrl: profile.avatarUrl ?? '',
    backgroundUrl: profile.backgroundUrl,
    signature: profile.signature,
  }
}

const toRepositoryProfile = (profile: LX.Netease.Profile) => ({
  userId: profile.userId,
  nickname: profile.nickname,
  avatarUrl: profile.avatarUrl,
  ...(profile.backgroundUrl == null ? {} : { backgroundUrl: profile.backgroundUrl }),
  ...(profile.signature == null ? {} : { signature: profile.signature }),
})

export const createNeteaseAccountService = ({
  accounts,
  api,
  now = Date.now,
}: {
  accounts: AccountRepository
  api: NeteaseAccountApi
  now?: () => number
}) => {
  const getAccountData = () => {
    const status = accounts.getStatus('netease')
    return {
      cookie: accounts.getCookie('netease') ?? '',
      profile: normalizeProfile(status.profile),
      updatedAt: status.updatedAtMs ?? 0,
    }
  }

  const refreshLoginStatus = async(cookie: string): Promise<LX.Netease.AccountStatus> => {
    if (!cookie) return { isLoggedIn: false, profile: null }

    const result = await api.login_status({ cookie })
    const profile = normalizeProfile(result.body?.data?.profile ?? result.body?.profile)
    if (profile == null) {
      await accounts.clear('netease')
      return { isLoggedIn: false, profile: null }
    }
    const mergedCookie = normalizeCookie(result.body?.cookie || result.cookie) || cookie
    await accounts.save('netease', {
      cookie: mergedCookie,
      profile: toRepositoryProfile(profile),
      updatedAtMs: now(),
    })

    return { isLoggedIn: true, profile }
  }

  const getAccountStatus = async(): Promise<LX.Netease.AccountStatus> => {
    const account = getAccountData()
    if (!account.cookie) return { isLoggedIn: false, profile: null }
    if (account.profile && now() - account.updatedAt < 5 * 60 * 1000) {
      return { isLoggedIn: true, profile: account.profile }
    }
    return refreshLoginStatus(account.cookie).catch(() => ({
      isLoggedIn: !!account.profile,
      profile: account.profile,
    }))
  }

  const createLoginQr = async(): Promise<LX.Netease.LoginQr> => {
    const keyResult = await api.login_qr_key()
    const key = keyResult.body?.data?.unikey
    if (!key) throw new Error('Failed to create login QR key')
    const qrResult = await api.login_qr_create({ key, qrimg: true })
    const data = qrResult.body?.data
    return { key, qrurl: data?.qrurl ?? '', qrimg: data?.qrimg ?? '' }
  }

  const checkLoginQr = async(key: string): Promise<LX.Netease.LoginQrCheck> => {
    const result = await api.login_qr_check({ key })
    const code = Number(result.body?.code ?? 0)
    const message = result.body?.message ?? ''
    if (code !== 803) return { code, message, isLoggedIn: false, profile: null }
    const status = await refreshLoginStatus(normalizeCookie(result.body?.cookie || result.cookie))
    return { code, message, ...status }
  }

  const logout = async() => {
    const cookie = accounts.getCookie('netease')
    if (cookie) await api.logout({ cookie }).catch(() => null)
    await accounts.clear('netease')
  }

  return {
    getCookie: () => accounts.getCookie('netease') ?? '',
    getAccountStatus,
    createLoginQr,
    checkLoginQr,
    logout,
  }
}
