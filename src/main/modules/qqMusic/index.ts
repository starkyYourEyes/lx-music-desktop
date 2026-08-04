import type { AccountRepository } from '@main/storage/accounts/accountRepository'
import type { MusicUrlAuthorizationService } from '@main/services/musicUrlAuthorization'
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
import { createQQMusicFeedbackService } from './feedback'

const CHECK_ERROR = 'QQ Music login check failed'
const MAX_SCHEDULE_DELAY_MS = 2_147_483_647

interface QQMusicProfile {
  uin: string
  nickname: string
}

interface QQMusicAccountStatus {
  isLoggedIn: boolean
  profile: QQMusicProfile | null
  unavailableReason?: 'credential_undecryptable'
}

interface QQMusicAccountData {
  cookie: string
  profile: QQMusicProfile | null
  updatedAt: number
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

interface FeedbackService {
  likeMusic: (musicInfo: LX.Music.MusicInfo_tx) => Promise<void>
  dislikeMusic: (musicInfo: LX.Music.MusicInfo_tx) => Promise<void>
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

const getAccountData = (accounts: AccountRepository): QQMusicAccountData => {
  const status = accounts.getStatus('qq_music')
  const cookie = accounts.getCookie('qq_music')
  if (!cookie || !isProfile(status.profile) || status.updatedAtMs == null) {
    return emptyAccount()
  }
  const uin = getQQMusicAccountUin(cookie)
  if (!uin || status.profile.uin != uin) return emptyAccount()
  return {
    cookie,
    profile: status.profile,
    updatedAt: status.updatedAtMs,
  }
}

const toRepositoryProfile = (profile: QQMusicProfile) => ({
  uin: profile.uin,
  nickname: profile.nickname,
})

export const createQQMusicAccountService = ({
  accounts,
  loginService,
  songService,
  dailyRecommendService,
  homeRecommendService,
  playlistDetailService,
  feedbackService,
  credentialService,
  onRefreshDiagnostic = defaultRefreshDiagnostic,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout,
  retryDelayMs = 60 * 60 * 1000,
  musicUrlAuthorization,
}: {
  accounts: AccountRepository
  loginService: LoginService
  songService: SongService
  dailyRecommendService: DailyRecommendService
  homeRecommendService: HomeRecommendService
  playlistDetailService: PlaylistDetailService
  feedbackService: FeedbackService
  credentialService: QQMusicCredentialService
  onRefreshDiagnostic?: (event: QQMusicRefreshDiagnostic) => void
  now?: () => number
  schedule?: typeof setTimeout
  cancelSchedule?: typeof clearTimeout
  retryDelayMs?: number
  musicUrlAuthorization: Pick<MusicUrlAuthorizationService, 'transition'>
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
    if (!isSameAccount(getAccountData(accounts), account)) return
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
    if (!isSameAccount(getAccountData(accounts), account)) return
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
    if (!isSameAccount(getAccountData(accounts), account)) return
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
      isSameAccount(getAccountData(accounts), account)) {
      scheduleRefreshRetry(account)
    }
  }

  const clearMatchingAccount = async(account: QQMusicAccountData, generation: number) => {
    return musicUrlAuthorization.transition('tx', async() => {
      const current = getAccountData(accounts)
      if (generation != loginGeneration || !isSameAccount(current, account)) {
        return { status: 'unchanged', value: false }
      }
      cancelRefreshTimer()
      refreshRetry = undefined
      lastSuccessfulRefresh = undefined
      await accounts.clear('qq_music')
      return { status: 'changed', value: true }
    })
  }

  async function performRefresh(
    account: QQMusicAccountData,
    trigger: QQMusicRefreshTrigger,
  ): Promise<QQMusicRefreshOutcome> {
    try {
      const cookie = await credentialService.refresh(account.cookie)
      const current = getAccountData(accounts)
      if (!isSameAccount(current, account)) {
        emitRefreshDiagnostic({ trigger, outcome: 'stale' })
        return { status: 'stale' }
      }
      const refreshedUin = getQQMusicAccountUin(cookie)
      if (!account.profile || !refreshedUin || refreshedUin != account.profile.uin) {
        emitRefreshDiagnostic({ trigger, outcome: 'transient' })
        return { status: 'transient' }
      }
      const refreshed: QQMusicAccountData = {
        cookie,
        profile: toRepositoryProfile(account.profile),
        updatedAt: getNextUpdatedAt(current.updatedAt),
      }
      const committed = await musicUrlAuthorization.transition('tx', async() => {
        if (!isSameAccount(getAccountData(accounts), account)) {
          return { status: 'unchanged', value: false }
        }
        if (refreshRetry && isSameAccount(refreshRetry.account, account)) {
          refreshRetry = undefined
        }
        await accounts.save('qq_music', {
          cookie: refreshed.cookie,
          profile: toRepositoryProfile(refreshed.profile!),
          updatedAtMs: refreshed.updatedAt,
        })
        lastSuccessfulRefresh = { source: account, refreshed }
        return { status: 'changed', value: true }
      })
      if (!committed) {
        emitRefreshDiagnostic({ trigger, outcome: 'stale' })
        return { status: 'stale' }
      }
      emitRefreshDiagnostic({ trigger, outcome: 'success' })
      return { status: 'success', account: refreshed }
    } catch (error) {
      const current = getAccountData(accounts)
      if (!isSameAccount(current, account)) {
        emitRefreshDiagnostic({ trigger, outcome: 'stale' })
        return { status: 'stale' }
      }
      const outcome = isQQMusicCredentialRefreshError(error)
        ? error.kind
        : 'transient'
      if (outcome == 'invalid') await clearMatchingAccount(account, loginGeneration)
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
      if (!isSameAccount(getAccountData(accounts), account)) {
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
    const repositoryStatus = accounts.getStatus('qq_music')
    if (repositoryStatus.unavailableReason != null) {
      return {
        isLoggedIn: false,
        profile: null,
        unavailableReason: repositoryStatus.unavailableReason,
      }
    }
    const account = getAccountData(accounts)
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
    const current = getAccountData(accounts)
    refreshRetry = undefined
    lastSuccessfulRefresh = undefined
    const account = {
      cookie: result.cookie,
      profile,
      updatedAt: getNextUpdatedAt(current.updatedAt),
    } satisfies QQMusicAccountData
    const committed = await musicUrlAuthorization.transition('tx', async() => {
      if (generation != loginGeneration) return { status: 'unchanged', value: false }
      await accounts.save('qq_music', {
        cookie: account.cookie,
        profile: toRepositoryProfile(account.profile),
        updatedAtMs: account.updatedAt,
      })
      return { status: 'changed', value: true }
    })
    if (!committed || generation != loginGeneration) return getExpiredLoginCheck()
    scheduleAccountRefresh(account)
    return {
      state: result.state,
      message: result.message,
      isLoggedIn: true,
      profile,
    }
  }

  const logout = async() => {
    const account = getAccountData(accounts)
    const generation = ++loginGeneration
    await loginService.disposeAll()
    if (generation != loginGeneration) return
    await clearMatchingAccount(account, generation)
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
    let account = getAccountData(accounts)
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
        account = getAccountData(accounts)
        if (!account.cookie) throw new QQMusicAuthError()
        refreshAttempted = false
      } else if (outcome.status == 'transient' &&
        isSameAccount(getAccountData(accounts), account)) {
        scheduleRefreshRetry(account)
      } else if (outcome.status == 'invalid') {
        throw new QQMusicAuthError()
      }
    }

    try {
      return await request()
    } catch (error) {
      if (!isQQMusicAuthError(error) || refreshAttempted) throw error
      const current = getAccountData(accounts)
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
        isSameAccount(getAccountData(accounts), account)) {
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

  const likeMusic = async(musicInfo: LX.Music.MusicInfo_tx) => {
    if (!getAccountData(accounts).cookie) return
    await runAuthenticatedRequest(async() => feedbackService.likeMusic(musicInfo))
  }

  const dislikeMusic = async(musicInfo: LX.Music.MusicInfo_tx) => {
    if (!getAccountData(accounts).cookie) {
      throw new QQMusicAuthError('QQ Music account is not logged in')
    }
    await runAuthenticatedRequest(async() => feedbackService.dislikeMusic(musicInfo))
  }

  scheduleAccountRefresh(getAccountData(accounts))

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
    likeMusic,
    dislikeMusic,
  }
}

let accountService: ReturnType<typeof createQQMusicAccountService> | undefined

const getAccountService = () => {
  if (accountService) return accountService
  const accounts = global.lx.accountRepository
  if (accounts == null) throw new Error('Account repository has not been initialized')
  const musicUrlAuthorization = global.lx.musicUrlAuthorization
  if (musicUrlAuthorization == null) throw new Error('Music URL authorization has not been initialized')
  const loginService = createQQMusicLoginService()
  const credentialService = createQQMusicCredentialService()
  const getCookie = () => accounts.getCookie('qq_music') ?? ''
  const songService = createQQMusicSongService({ getCookie })
  const dailyRecommendService = createQQMusicDailyRecommendService({ getCookie })
  const homeRecommendService = createQQMusicHomeRecommendService({ getCookie })
  const playlistDetailService = createQQMusicPlaylistDetailService({ getCookie })
  const feedbackService = createQQMusicFeedbackService({ getCookie })
  accountService = createQQMusicAccountService({
    accounts,
    loginService,
    songService,
    dailyRecommendService,
    homeRecommendService,
    playlistDetailService,
    feedbackService,
    credentialService,
    musicUrlAuthorization,
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
export const likeMusic = async(musicInfo: LX.Music.MusicInfo_tx) => {
  await getAccountService().likeMusic(musicInfo)
}
export const dislikeMusic = async(musicInfo: LX.Music.MusicInfo_tx) => {
  await getAccountService().dislikeMusic(musicInfo)
}
