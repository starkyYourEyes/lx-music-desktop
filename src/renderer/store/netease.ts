import { computed, ref, shallowRef } from '@common/utils/vueTools'
import {
  getNeteaseAccountStatus,
  logoutNetease,
} from '@renderer/utils/ipc'

const emptyStatus: LX.Netease.AccountStatus = {
  isLoggedIn: false,
  profile: null,
}

export const accountStatus = shallowRef<LX.Netease.AccountStatus>({ ...emptyStatus })
export const isInitingNeteaseAccount = ref(false)
export const isNeteaseAccountInited = ref(false)

let initPromise: Promise<LX.Netease.AccountStatus> | null = null

export const profile = computed(() => accountStatus.value.profile)
export const isLoggedIn = computed(() => accountStatus.value.isLoggedIn)

export const setNeteaseAccountStatus = (status: LX.Netease.AccountStatus) => {
  accountStatus.value = {
    isLoggedIn: status.isLoggedIn,
    profile: status.profile,
  }
  isNeteaseAccountInited.value = true
}

export const initNeteaseAccount = async(force = false) => {
  if (!force) {
    if (initPromise) return initPromise
    if (isNeteaseAccountInited.value) return accountStatus.value
  }

  isInitingNeteaseAccount.value = true
  initPromise = getNeteaseAccountStatus()
    .then(status => {
      setNeteaseAccountStatus(status)
      return accountStatus.value
    })
    .catch(err => {
      setNeteaseAccountStatus({ ...emptyStatus })
      throw err
    })
    .finally(() => {
      isInitingNeteaseAccount.value = false
      initPromise = null
    })

  return initPromise
}

export const logoutNeteaseAccount = async() => {
  await logoutNetease()
  setNeteaseAccountStatus({ ...emptyStatus })
}
