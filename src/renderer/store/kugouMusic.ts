import { computed, ref, shallowRef } from '@common/utils/vueTools'
import {
  getKugouMusicAccountStatus,
  logoutKugouMusic,
} from '@renderer/utils/ipc'

const emptyStatus: LX.KuGouMusic.AccountStatus = {
  isLoggedIn: false,
  profile: null,
}

export const accountStatus = shallowRef<LX.KuGouMusic.AccountStatus>({ ...emptyStatus })
export const isInitingKugouMusicAccount = ref(false)
export const isKugouMusicAccountInited = ref(false)

let initPromise: Promise<LX.KuGouMusic.AccountStatus> | null = null
let initPromiseRevision = 0
let accountRevision = 0

export const profile = computed(() => accountStatus.value.profile)
export const isLoggedIn = computed(() => accountStatus.value.isLoggedIn)

export const getKugouMusicAccountKey = () => {
  if (!accountStatus.value.isLoggedIn) return null
  return `${accountStatus.value.profile?.userId ?? 'unknown'}:${accountRevision}`
}

const commitKugouMusicAccountStatus = (status: LX.KuGouMusic.AccountStatus) => {
  accountStatus.value = {
    isLoggedIn: status.isLoggedIn,
    profile: status.profile,
  }
}

export const setKugouMusicAccountStatus = (status: LX.KuGouMusic.AccountStatus) => {
  accountRevision++
  commitKugouMusicAccountStatus(status)
  isKugouMusicAccountInited.value = true
}

export const initKugouMusicAccount = async(force = false) => {
  if (!force) {
    if (initPromise && initPromiseRevision == accountRevision) return initPromise
    if (isKugouMusicAccountInited.value) return accountStatus.value
  }

  const revision = ++accountRevision
  isInitingKugouMusicAccount.value = true
  let request: Promise<LX.KuGouMusic.AccountStatus>
  request = getKugouMusicAccountStatus()
    .then(status => {
      if (revision == accountRevision) {
        commitKugouMusicAccountStatus(status)
        isKugouMusicAccountInited.value = true
      }
      return accountStatus.value
    })
    .catch(err => {
      if (revision == accountRevision) {
        commitKugouMusicAccountStatus(emptyStatus)
        isKugouMusicAccountInited.value = false
      }
      throw err
    })
    .finally(() => {
      if (initPromise != request) return
      isInitingKugouMusicAccount.value = false
      initPromise = null
      initPromiseRevision = 0
    })

  initPromise = request
  initPromiseRevision = revision
  return request
}

export const logoutKugouMusicAccount = async() => {
  const revision = ++accountRevision
  await logoutKugouMusic()
  if (revision != accountRevision) return
  commitKugouMusicAccountStatus(emptyStatus)
  isKugouMusicAccountInited.value = true
}
