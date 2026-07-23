import { computed, ref, shallowRef } from '@common/utils/vueTools'
import {
  getQQMusicAccountStatus,
  logoutQQMusic,
} from '@renderer/utils/ipc'

const emptyStatus: LX.QQMusic.AccountStatus = {
  isLoggedIn: false,
  profile: null,
}

export const accountStatus = shallowRef<LX.QQMusic.AccountStatus>({ ...emptyStatus })
export const isInitingQQMusicAccount = ref(false)
export const isQQMusicAccountInited = ref(false)

let initPromise: Promise<LX.QQMusic.AccountStatus> | null = null

export const profile = computed(() => accountStatus.value.profile)
export const isLoggedIn = computed(() => accountStatus.value.isLoggedIn)

export const setQQMusicAccountStatus = (status: LX.QQMusic.AccountStatus) => {
  accountStatus.value = {
    isLoggedIn: status.isLoggedIn,
    profile: status.profile,
  }
  isQQMusicAccountInited.value = true
}

export const initQQMusicAccount = async(force = false) => {
  if (!force) {
    if (initPromise) return initPromise
    if (isQQMusicAccountInited.value) return accountStatus.value
  }

  isInitingQQMusicAccount.value = true
  initPromise = getQQMusicAccountStatus()
    .then(status => {
      setQQMusicAccountStatus(status)
      return accountStatus.value
    })
    .catch(err => {
      accountStatus.value = { ...emptyStatus }
      isQQMusicAccountInited.value = false
      throw err
    })
    .finally(() => {
      isInitingQQMusicAccount.value = false
      initPromise = null
    })

  return initPromise
}

export const logoutQQMusicAccount = async() => {
  await logoutQQMusic()
  setQQMusicAccountStatus({ ...emptyStatus })
}
