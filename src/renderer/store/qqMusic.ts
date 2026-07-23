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
let initPromiseRevision = 0
let accountRevision = 0

export const profile = computed(() => accountStatus.value.profile)
export const isLoggedIn = computed(() => accountStatus.value.isLoggedIn)

const commitQQMusicAccountStatus = (status: LX.QQMusic.AccountStatus) => {
  accountStatus.value = {
    isLoggedIn: status.isLoggedIn,
    profile: status.profile,
  }
}

export const setQQMusicAccountStatus = (status: LX.QQMusic.AccountStatus) => {
  accountRevision++
  commitQQMusicAccountStatus(status)
  isQQMusicAccountInited.value = true
}

export const initQQMusicAccount = async(force = false) => {
  if (!force) {
    if (initPromise && initPromiseRevision == accountRevision) return initPromise
    if (isQQMusicAccountInited.value) return accountStatus.value
  }

  const revision = ++accountRevision
  isInitingQQMusicAccount.value = true
  let request: Promise<LX.QQMusic.AccountStatus>
  request = getQQMusicAccountStatus()
    .then(status => {
      if (revision == accountRevision) {
        commitQQMusicAccountStatus(status)
        isQQMusicAccountInited.value = true
      }
      return accountStatus.value
    })
    .catch(err => {
      if (revision == accountRevision) {
        commitQQMusicAccountStatus(emptyStatus)
        isQQMusicAccountInited.value = false
      }
      throw err
    })
    .finally(() => {
      if (initPromise != request) return
      isInitingQQMusicAccount.value = false
      initPromise = null
      initPromiseRevision = 0
    })

  initPromise = request
  initPromiseRevision = revision
  return request
}

export const logoutQQMusicAccount = async() => {
  const revision = ++accountRevision
  await logoutQQMusic()
  if (revision != accountRevision) return
  commitQQMusicAccountStatus(emptyStatus)
  isQQMusicAccountInited.value = true
}
