import { DATA_KEYS, STORE_NAMES } from '@common/constants'
import getStore from '@main/utils/store'
import {
  createQQMusicLoginService,
  type QQMusicInternalLoginCheck,
  type QQMusicLoginQr,
} from './login'
import { createQQMusicSongService, isQQMusicAuthError } from './song'

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
  getGuessLikeSongs: () => Promise<LX.Music.MusicInfo_tx[]>
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
  return value
}

const getCookieValue = (cookie: string, name: string) => {
  let result = ''
  for (const item of cookie.split(';')) {
    const separator = item.indexOf('=')
    if (separator < 1 || item.slice(0, separator).trim() != name) continue
    result = item.slice(separator + 1).trim()
  }
  return result
}

export const createQQMusicAccountService = ({
  store,
  loginService,
  songService,
  now = Date.now,
}: {
  store: AccountStore
  loginService: LoginService
  songService: SongService
  now?: () => number
}) => {
  const clearAccount = () => store.set(DATA_KEYS.qqMusicAccount, emptyAccount(now()))

  const getAccountStatus = (): QQMusicAccountStatus => {
    const account = getAccountData(store)
    return {
      isLoggedIn: !!account.cookie && !!account.profile,
      profile: account.cookie ? account.profile : null,
    }
  }

  const createLoginQr = async() => loginService.createLoginQr()

  const checkLoginQr = async(key: string) => {
    const result = await loginService.checkLoginQr(key)
    if (result.state != 'success') {
      return {
        state: result.state,
        message: result.message,
        isLoggedIn: false,
        profile: null,
      }
    }
    const profile: QQMusicProfile = {
      uin: getCookieValue(result.cookie, 'uin') || getCookieValue(result.cookie, 'qqmusic_uin'),
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
    clearAccount()
  }

  const getGuessLikeSongs = async() => {
    try {
      return await songService.getGuessLikeSongs()
    } catch (error) {
      if (isQQMusicAuthError(error)) clearAccount()
      throw error
    }
  }

  return {
    getAccountStatus,
    createLoginQr,
    checkLoginQr,
    logout,
    getGuessLikeSongs,
  }
}

const store = getStore(STORE_NAMES.DATA)
const loginService = createQQMusicLoginService()
const songService = createQQMusicSongService({
  getCookie: () => getAccountData(store).cookie,
})
const accountService = createQQMusicAccountService({ store, loginService, songService })

export const getAccountStatus = accountService.getAccountStatus
export const createLoginQr = accountService.createLoginQr
export const checkLoginQr = accountService.checkLoginQr
export const logout = accountService.logout
export const getGuessLikeSongs = accountService.getGuessLikeSongs
