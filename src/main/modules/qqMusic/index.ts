import { DATA_KEYS, STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import {
  createQQMusicLoginService,
  type QQMusicInternalLoginCheck,
  type QQMusicLoginQr,
} from './login'
import { getQQMusicAccountUin } from './auth'
import { createQQMusicSongService, isQQMusicAuthError } from './song'
import { createQQMusicDailyRecommendService } from './dailyRecommend'

const CHECK_ERROR = 'QQ Music login check failed'

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
  createLoginQr: () => Promise<QQMusicLoginQr>
  checkLoginQr: (key: string) => Promise<QQMusicInternalLoginCheck>
}

interface SongService {
  getGuessLikeSongs: (options?: LX.QQMusic.GuessLikeRequest) => Promise<LX.Music.MusicInfo_tx[]>
}

interface DailyRecommendService {
  getDailyRecommendSongs: () => Promise<LX.Music.MusicInfo_tx[]>
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
  now = Date.now,
}: {
  store: AccountStore
  loginService: LoginService
  songService: SongService
  dailyRecommendService: DailyRecommendService
  now?: () => number
}) => {
  let loginGeneration = 0

  const clearAccount = () => store.set(DATA_KEYS.qqMusicAccount, emptyAccount(now()))

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

  const createLoginQr = async() => {
    loginGeneration++
    return loginService.createLoginQr()
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
    store.set(DATA_KEYS.qqMusicAccount, {
      cookie: result.cookie,
      profile,
      updatedAt: now(),
    } satisfies QQMusicAccountData)
    return {
      state: result.state,
      message: result.message,
      isLoggedIn: true,
      profile,
    }
  }

  const logout = async() => {
    loginGeneration++
    clearAccount()
  }

  const runAuthenticatedRequest = async<T>(request: () => Promise<T>) => {
    const account = getAccountData(store)
    try {
      return await request()
    } catch (error) {
      if (isQQMusicAuthError(error)) {
        const currentAccount = getAccountData(store)
        if (currentAccount.cookie == account.cookie && currentAccount.updatedAt == account.updatedAt) {
          clearAccount()
        }
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

  return {
    getAccountStatus,
    createLoginQr,
    checkLoginQr,
    logout,
    getGuessLikeSongs,
    getDailyRecommendSongs,
  }
}

let accountService: ReturnType<typeof createQQMusicAccountService> | undefined

const getAccountService = () => {
  if (accountService) return accountService
  const store = getStore(STORE_NAMES.DATA)
  const loginService = createQQMusicLoginService()
  const getCookie = () => getAccountData(store).cookie
  const songService = createQQMusicSongService({ getCookie })
  const dailyRecommendService = createQQMusicDailyRecommendService({ getCookie })
  accountService = createQQMusicAccountService({ store, loginService, songService, dailyRecommendService })
  return accountService
}

export const getAccountStatus = () => getAccountService().getAccountStatus()
export const createLoginQr = async() => getAccountService().createLoginQr()
export const checkLoginQr = async(key: string) => getAccountService().checkLoginQr(key)
export const logout = async() => getAccountService().logout()
export const getGuessLikeSongs = async(options?: LX.QQMusic.GuessLikeRequest) => {
  return getAccountService().getGuessLikeSongs(options)
}
export const getDailyRecommendSongs = async() => getAccountService().getDailyRecommendSongs()
