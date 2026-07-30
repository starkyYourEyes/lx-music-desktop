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
  let accountGeneration = 0

  const getAccountData = () => {
    const status = accounts.getStatus('netease')
    return {
      cookie: accounts.getCookie('netease') ?? '',
      profile: normalizeProfile(status.profile),
      updatedAt: status.updatedAtMs ?? 0,
    }
  }

  const getLoggedOutStatus = (): LX.Netease.AccountStatus => ({
    isLoggedIn: false,
    profile: null,
  })

  const isCurrentAccount = (cookie: string, generation: number) => {
    return generation == accountGeneration && accounts.getCookie('netease') == cookie
  }

  const isCurrentGeneration = (generation: number) => generation == accountGeneration

  const refreshLoginStatus = async(
    cookie: string,
    sourceCookie: string,
    generation: number,
    canReplaceSourceAccount = false,
  ): Promise<LX.Netease.AccountStatus> => {
    if (!cookie) return { isLoggedIn: false, profile: null }

    const isCurrentRefresh = () => canReplaceSourceAccount
      ? isCurrentGeneration(generation) && (() => {
        const currentCookie = accounts.getCookie('netease') ?? ''
        return currentCookie == sourceCookie || !currentCookie
      })()
      : isCurrentAccount(sourceCookie, generation)

    const result = await api.login_status({ cookie })
    if (!isCurrentRefresh()) return getLoggedOutStatus()
    const profile = normalizeProfile(result.body?.data?.profile ?? result.body?.profile)
    if (profile == null) {
      if (!isCurrentRefresh()) return getLoggedOutStatus()
      await accounts.clear('netease')
      return { isLoggedIn: false, profile: null }
    }
    const mergedCookie = normalizeCookie(result.body?.cookie || result.cookie) || cookie
    if (!isCurrentRefresh()) return getLoggedOutStatus()
    await accounts.save('netease', {
      cookie: mergedCookie,
      profile: toRepositoryProfile(profile),
      updatedAtMs: now(),
    })

    return isCurrentGeneration(generation) && accounts.getCookie('netease') == mergedCookie
      ? { isLoggedIn: true, profile }
      : getLoggedOutStatus()
  }

  const getAccountStatus = async(): Promise<LX.Netease.AccountStatus> => {
    const account = getAccountData()
    if (!account.cookie) return { isLoggedIn: false, profile: null }
    if (account.profile && now() - account.updatedAt < 5 * 60 * 1000) {
      return { isLoggedIn: true, profile: account.profile }
    }
    const generation = accountGeneration
    return refreshLoginStatus(account.cookie, account.cookie, generation).catch(() => ({
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
    const generation = ++accountGeneration
    const sourceCookie = accounts.getCookie('netease') ?? ''
    const result = await api.login_qr_check({ key })
    const code = Number(result.body?.code ?? 0)
    const message = result.body?.message ?? ''
    if (code !== 803 || !isCurrentGeneration(generation)) {
      return { code, message, isLoggedIn: false, profile: null }
    }
    const status = await refreshLoginStatus(
      normalizeCookie(result.body?.cookie || result.cookie),
      sourceCookie,
      generation,
      true,
    )
    return { code, message, ...status }
  }

  const logout = async() => {
    const cookie = accounts.getCookie('netease')
    const generation = ++accountGeneration
    if (cookie) await api.logout({ cookie }).catch(() => null)
    if (!isCurrentGeneration(generation)) return
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
