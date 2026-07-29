import { DATA_KEYS, STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import {
  createQQMusicLoginService,
  isQQMusicLoginRequestId,
  type QQMusicInternalLoginCheck,
  type QQMusicLoginQr,
} from './login'
import { getQQMusicAccountUin } from './auth'
import {
  createQQMusicCredentialService,
  isQQMusicCredentialRefreshError,
  type QQMusicCredentialService,
  type QQMusicCredentialRefreshErrorKind,
} from './credential'
import {
  createQQMusicSongService,
  isQQMusicAuthError,
  QQMusicAuthError,
} from './song'
import { createQQMusicDailyRecommendService } from './dailyRecommend'
import { createQQMusicHomeRecommendService } from './homeRecommend'
import { createQQMusicPlaylistDetailService } from './playlistDetail'

const CHECK_ERROR = 'QQ Music login check failed'
const MAX_SCHEDULE_DELAY_MS = 2_147_483_647

interface QQMusicProfile {
  uin: string
  nickname: string
}

interface QQMusicAccountStatus {
  isLoggedIn: boolean
  profile: QQMusicProfile | null
}

interface QQMusicAccountData {
  cookie: string
  profile: QQMusicProfile | null
  updatedAt: number
}

interface AccountStore {
  get: <Value>(key: string) => Value | undefined
  set: (key: string, value: unknown) => unknown
}

interface LoginService {
  createLoginQr: (
    requestId: string,
    startedAt: number,
  ) => Promise<QQMusicLoginQr>
  checkLoginQr: (requestId: string) => Promise<QQMusicInternalLoginCheck>
  cancelLoginQr: (requestId: string) => Promise<void>
  disposeAll: () => Promise<void>
}

interface SongService {
  getGuessLikeSongs: (options?: LX.QQMusic.GuessLikeRequest) => Promise<LX.Music.MusicInfo_tx[]>
}

interface DailyRecommendService {
  getDailyRecommendSongs: () => Promise<LX.Music.MusicInfo_tx[]>
}

interface HomeRecommendService {
  getHomeRecommendation: () => Promise<LX.QQMusic.HomeRecommendation>
}

interface PlaylistDetailService {
  getPlaylistDetail: (id: string, page?: number) => Promise<LX.QQMusic.PlaylistDetailInfo>
}

type QQMusicRefreshTrigger = 'scheduled' | 'preflight' | 'auth-error'
type QQMusicRefreshOutcome =
  | { status: 'success', account: QQMusicAccountData }
  | { status: QQMusicCredentialRefreshErrorKind | 'stale' }

interface QQMusicRefreshDiagnostic {
  trigger: QQMusicRefreshTrigger
  outcome: QQMusicRefreshOutcome['status']
}

const defaultRefreshDiagnostic = (event: QQMusicRefreshDiagnostic) => {
  console.warn('[QQ Music refresh diagnostic]', event)
}

const isSameAccount = (left: QQMusicAccountData, right: QQMusicAccountData) => {
  return left.cookie == right.cookie && left.updatedAt == right.updatedAt
}

const emptyAccount = (updatedAt = 0): QQMusicAccountData => ({
  cookie: '',
  profile: null,
  updatedAt,
})

const isProfile = (value: unknown): value is QQMusicProfile => {
  const profile = value as Partial<QQMusicProfile> | null
  return !!profile && typeof profile == 'object' &&
    typeof profile.uin == 'string' && typeof profile.nickname == 'string'
}

const getAccountData = (store: AccountStore): QQMusicAccountData => {
  const value = store.get<QQMusicAccountData>(DATA_KEYS.qqMusicAccount)
  if (!value || typeof value != 'object' || typeof value.cookie != 'string' ||
    (value.profile !== null && !isProfile(value.profile)) || typeof value.updatedAt != 'number') {
    return emptyAccount()
  }
  if (!value.cookie) return value.profile === null ? value : emptyAccount()
  const uin = getQQMusicAccountUin(value.cookie)
  if (!uin || !value.profile || value.profile.uin != uin) return emptyAccount()
  return value
}

export const createQQMusicAccountService = ({
  store,
  loginService,
  songService,
  dailyRecommendService,
  homeRecommendService,
  playlistDetailService,
  credentialService,
  onRefreshDiagnostic = defaultRefreshDiagnostic,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  retryDelayMs = 60 * 60 * 1000,
}: {
  store: AccountStore
  loginService: LoginService
  songService: SongService
  dailyRecommendService: DailyRecommendService
  homeRecommendService: HomeRecommendService
  playlistDetailService: PlaylistDetailService
  credentialService: QQMusicCredentialService
  onRefreshDiagnostic?: (event: QQMusicRefreshDiagnostic) => void
  now?: () => number
  schedule?: typeof setTimeout
  cancelSchedule?: typeof clearTimeout
  retryDelayMs?: number
}) => {
  let loginGeneration = 0
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let lastSuccessfulRefresh: {
    source: QQMusicAccountData
    refreshed: QQMusicAccountData
  } | undefined
  let refreshInFlight: {
    account: QQMusicAccountData
    promise: Promise<QQMusicRefreshOutcome>
  } | undefined
  let refreshRetry: {
    account: QQMusicAccountData
    notBefore: number
  } | undefined

  const getNextUpdatedAt = (previousUpdatedAt: number) => {
    return Math.max(now(), previousUpdatedAt + 1)
  }

  const emitRefreshDiagnostic = (event: QQMusicRefreshDiagnostic) => {
    try {
      onRefreshDiagnostic(event)
    } catch {}
  }

  function cancelRefreshTimer() {
    if (!refreshTimer) return
    cancelSchedule(refreshTimer)
    refreshTimer = undefined
  }

  function scheduleAccountRefresh(
    account: QQMusicAccountData,
    delayOverride?: number,
  ) {
    if (!isSameAccount(getAccountData(store), account)) return
    cancelRefreshTimer()
    if (!account.cookie) return
    let delay = delayOverride
    if (delay == null) {
      const dueAt = credentialService.getRefreshDueAt(account.cookie)
      if (dueAt == null) return
      delay = Math.max(0, dueAt - now())
    }
    const segmentDelay = Math.min(
      MAX_SCHEDULE_DELAY_MS,
      Math.max(0, delay),
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    timer = schedule(() => {
      if (refreshTimer !== timer) return
      refreshTimer = undefined
      void runScheduledRefresh(account).catch(() => {})
    }, segmentDelay)
    refreshTimer = timer
    timer?.unref?.()
  }

  function isRefreshRetryPending(account: QQMusicAccountData) {
    return !!refreshRetry &&
      isSameAccount(refreshRetry.account, account) &&
      refreshRetry.notBefore > now()
  }

  function scheduleRefreshRetry(account: QQMusicAccountData) {
    if (!isSameAccount(getAccountData(store), account)) return
    refreshRetry = {
      account,
      notBefore: now() + retryDelayMs,
    }
    scheduleAccountRefresh(account, retryDelayMs)
  }

  function scheduleRefreshedAccount(account: QQMusicAccountData) {
    const dueAt = credentialService.getRefreshDueAt(account.cookie)
    if (dueAt != null && dueAt <= now()) {
      scheduleRefreshRetry(account)
      return
    }
    scheduleAccountRefresh(account)
  }

  async function runScheduledRefresh(account: QQMusicAccountData) {
    if (!isSameAccount(getAccountData(store), account)) return
    if (refreshRetry && isSameAccount(refreshRetry.account, account)) {
      const retryDelay = refreshRetry.notBefore - now()
      if (retryDelay > 0) {
        scheduleAccountRefresh(account, retryDelay)
        return
      }
      refreshRetry = undefined
    } else {
      const dueAt = credentialService.getRefreshDueAt(account.cookie)
      if (dueAt == null) return
      const dueDelay = dueAt - now()
      if (dueDelay > 0) {
        scheduleAccountRefresh(account, dueDelay)
        return
      }
    }
    const outcome = await refreshAccount(account, 'scheduled')
    if (outcome.status == 'success') {
      scheduleRefreshedAccount(outcome.account)
    } else if (outcome.status == 'transient' &&
      isSameAccount(getAccountData(store), account)) {
      scheduleRefreshRetry(account)
    }
  }

  const clearAccount = () => {
    const account = getAccountData(store)
    cancelRefreshTimer()
    refreshRetry = undefined
    lastSuccessfulRefresh = undefined
    store.set(
      DATA_KEYS.qqMusicAccount,
      emptyAccount(getNextUpdatedAt(account.updatedAt)),
    )
  }

  const clearMatchingAccount = (account: QQMusicAccountData) => {
    const current = getAccountData(store)
    if (!isSameAccount(current, account)) return false
    clearAccount()
    return true
  }

  async function performRefresh(
    account: QQMusicAccountData,
    trigger: QQMusicRefreshTrigger,
  ): Promise<QQMusicRefreshOutcome> {
    try {
      const cookie = await credentialService.refresh(account.cookie)
      const current = getAccountData(store)
      if (!isSameAccount(current, account)) {
        emitRefreshDiagnostic({ trigger, outcome: 'stale' })
        return { status: 'stale' }
      }
      const refreshedUin = getQQMusicAccountUin(cookie)
      if (!refreshedUin || refreshedUin != account.profile?.uin) {
        emitRefreshDiagnostic({ trigger, outcome: 'transient' })
        return { status: 'transient' }
      }
      const refreshed: QQMusicAccountData = {
        cookie,
        profile: account.profile,
        updatedAt: getNextUpdatedAt(current.updatedAt),
      }
      if (refreshRetry && isSameAccount(refreshRetry.account, account)) {
        refreshRetry = undefined
      }
      store.set(DATA_KEYS.qqMusicAccount, refreshed)
      lastSuccessfulRefresh = { source: account, refreshed }
      emitRefreshDiagnostic({ trigger, outcome: 'success' })
      return { status: 'success', account: refreshed }
    } catch (error) {
      const current = getAccountData(store)
      if (!isSameAccount(current, account)) {
        emitRefreshDiagnostic({ trigger, outcome: 'stale' })
        return { status: 'stale' }
      }
      const outcome = isQQMusicCredentialRefreshError(error)
        ? error.kind
        : 'transient'
      if (outcome == 'invalid') clearMatchingAccount(account)
      emitRefreshDiagnostic({ trigger, outcome })
      return { status: outcome }
    }
  }

  async function refreshAccount(
    account: QQMusicAccountData,
    trigger: QQMusicRefreshTrigger,
  ): Promise<QQMusicRefreshOutcome> {
    if (refreshInFlight) {
      if (isSameAccount(refreshInFlight.account, account)) {
        return refreshInFlight.promise
      }
      await refreshInFlight.promise
      if (!isSameAccount(getAccountData(store), account)) {
        return { status: 'stale' }
      }
      return refreshAccount(account, trigger)
    }
    const entry = {
      account,
      promise: performRefresh(account, trigger),
    }
    refreshInFlight = entry
    try {
      return await entry.promise
    } finally {
      if (refreshInFlight === entry) refreshInFlight = undefined
    }
  }

  const getExpiredLoginCheck = () => ({
    state: 'expired' as const,
    message: '二维码已过期',
    isLoggedIn: false,
    profile: null,
  })

  const getAccountStatus = (): QQMusicAccountStatus => {
    const account = getAccountData(store)
    return {
      isLoggedIn: !!account.cookie && !!account.profile,
      profile: account.cookie ? account.profile : null,
    }
  }

  const createLoginQr = async(requestId: string, startedAt: number) => {
    if (!isQQMusicLoginRequestId(requestId)) {
      throw new Error('QQ Music login QR creation failed')
    }
    loginGeneration++
    return loginService.createLoginQr(requestId, startedAt)
  }

  const checkLoginQr = async(key: string) => {
    const generation = loginGeneration
    const result = await loginService.checkLoginQr(key)
    if (generation != loginGeneration) return getExpiredLoginCheck()
    if (result.state != 'success') {
      return {
        state: result.state,
        message: result.message,
        isLoggedIn: false,
        profile: null,
      }
    }
    const uin = getQQMusicAccountUin(result.cookie)
    if (!uin) throw new Error(CHECK_ERROR)
    const profile: QQMusicProfile = {
      uin,
      nickname: 'QQ 音乐账号',
    }
    const current = getAccountData(store)
    refreshRetry = undefined
    lastSuccessfulRefresh = undefined
    const account = {
      cookie: result.cookie,
      profile,
      updatedAt: getNextUpdatedAt(current.updatedAt),
    } satisfies QQMusicAccountData
    store.set(DATA_KEYS.qqMusicAccount, account)
    scheduleAccountRefresh(account)
    return {
      state: result.state,
      message: result.message,
      isLoggedIn: true,
      profile,
    }
  }

  const logout = async() => {
    loginGeneration++
    await loginService.disposeAll()
    clearAccount()
  }

  const cancelLoginQr = async(requestId: string) => {
    await loginService.cancelLoginQr(requestId)
  }

  const disposeLoginQr = async() => {
    loginGeneration++
    await loginService.disposeAll()
  }

  const runAuthenticatedRequest = async<T>(
    request: () => Promise<T>,
  ): Promise<T> => {
    let account = getAccountData(store)
    let refreshAttempted = false
    const dueAt = credentialService.getRefreshDueAt(account.cookie)
    if (account.cookie && dueAt != null && dueAt <= now() &&
      !isRefreshRetryPending(account)) {
      refreshAttempted = true
      const outcome = await refreshAccount(account, 'preflight')
      if (outcome.status == 'success') {
        account = outcome.account
        scheduleRefreshedAccount(account)
      } else if (outcome.status == 'stale') {
        account = getAccountData(store)
        if (!account.cookie) throw new QQMusicAuthError()
        refreshAttempted = false
      } else if (outcome.status == 'transient' &&
        isSameAccount(getAccountData(store), account)) {
        scheduleRefreshRetry(account)
      } else if (outcome.status == 'invalid') {
        throw new QQMusicAuthError()
      }
    }

    try {
      return await request()
    } catch (error) {
      if (!isQQMusicAuthError(error) || refreshAttempted) throw error
      const current = getAccountData(store)
      if (!isSameAccount(current, account)) {
        if (lastSuccessfulRefresh &&
          isSameAccount(lastSuccessfulRefresh.source, account) &&
          isSameAccount(lastSuccessfulRefresh.refreshed, current)) {
          return request()
        }
        throw error
      }
      if (isRefreshRetryPending(account)) throw error
      const outcome = await refreshAccount(account, 'auth-error')
      if (outcome.status == 'success') {
        scheduleRefreshedAccount(outcome.account)
        return request()
      }
      if (outcome.status == 'transient' &&
        isSameAccount(getAccountData(store), account)) {
        scheduleRefreshRetry(account)
      }
      throw error
    }
  }

  const getGuessLikeSongs = async(options?: LX.QQMusic.GuessLikeRequest) => {
    return runAuthenticatedRequest(async() => songService.getGuessLikeSongs(options))
  }

  const getDailyRecommendSongs = async() => {
    return runAuthenticatedRequest(async() => dailyRecommendService.getDailyRecommendSongs())
  }

  const getHomeRecommendation = async() => {
    return runAuthenticatedRequest(async() => homeRecommendService.getHomeRecommendation())
  }

  const getPlaylistDetail = async(id: string, page = 1) => {
    return runAuthenticatedRequest(async() => playlistDetailService.getPlaylistDetail(id, page))
  }

  scheduleAccountRefresh(getAccountData(store))

  return {
    getAccountStatus,
    createLoginQr,
    checkLoginQr,
    cancelLoginQr,
    disposeLoginQr,
    logout,
    getGuessLikeSongs,
    getDailyRecommendSongs,
    getHomeRecommendation,
    getPlaylistDetail,
  }
}

let accountService: ReturnType<typeof createQQMusicAccountService> | undefined

const getAccountService = () => {
  if (accountService) return accountService
  const store = getStore(STORE_NAMES.DATA)
  const loginService = createQQMusicLoginService()
  const credentialService = createQQMusicCredentialService()
  const getCookie = () => getAccountData(store).cookie
  const songService = createQQMusicSongService({ getCookie })
  const dailyRecommendService = createQQMusicDailyRecommendService({ getCookie })
  const homeRecommendService = createQQMusicHomeRecommendService({ getCookie })
  const playlistDetailService = createQQMusicPlaylistDetailService({ getCookie })
  accountService = createQQMusicAccountService({
    store,
    loginService,
    songService,
    dailyRecommendService,
    homeRecommendService,
    playlistDetailService,
    credentialService,
  })
  return accountService
}

export const getAccountStatus = () => getAccountService().getAccountStatus()
export const createLoginQr = async(requestId: string, startedAt: number) => {
  return getAccountService().createLoginQr(requestId, startedAt)
}
export const checkLoginQr = async(requestId: string) => {
  return getAccountService().checkLoginQr(requestId)
}
export const cancelLoginQr = async(requestId: string) => {
  await getAccountService().cancelLoginQr(requestId)
}
export const disposeLoginQr = async() => {
  if (!accountService) return
  await accountService.disposeLoginQr()
}
export { isQQMusicLoginRequestId }
export const logout = async() => getAccountService().logout()
export const getGuessLikeSongs = async(options?: LX.QQMusic.GuessLikeRequest) => {
  return getAccountService().getGuessLikeSongs(options)
}
export const getDailyRecommendSongs = async() => getAccountService().getDailyRecommendSongs()
export const getHomeRecommendation = async() => getAccountService().getHomeRecommendation()
export const getPlaylistDetail = async(id: string, page = 1) => {
  return getAccountService().getPlaylistDetail(id, page)
}
