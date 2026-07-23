import { computed, onBeforeUnmount, ref, shallowRef } from '@common/utils/vueTools'
import {
  checkQQMusicLoginQr,
  createQQMusicLoginQr,
} from '@renderer/utils/ipc'
import {
  isLoggedIn,
  setQQMusicAccountStatus,
} from '@renderer/store/qqMusic'

const statusText = {
  waiting: '请使用手机 QQ 扫码登录',
  scanned: '已扫码，请在手机上确认登录',
  expired: '二维码已过期，请重新获取',
  success: '登录成功',
} as const

const creatingText = '正在生成二维码...'
const createFailedText = '二维码生成失败，请重试'
const checkFailedText = '检查登录状态失败，稍后重试'

export const useQQMusicLoginQr = (onLoginSuccess: () => Promise<void>) => {
  const qrInfo = shallowRef<LX.QQMusic.LoginQr | null>(null)
  const qrStatusText = ref(creatingText)
  const isCreatingQr = ref(false)
  const showLoginPanel = ref(false)

  let qrState: LX.QQMusic.LoginQrState | null = null
  let qrTimer: number | null = null
  let createRevision = 0
  const checkingKeys = new Set<string>()
  let isDisposed = false

  const clearQrTimer = () => {
    if (qrTimer == null) return
    window.clearTimeout(qrTimer)
    qrTimer = null
  }

  const isPending = () => qrState == 'waiting' || qrState == 'scanned'

  const canPoll = (key: string) => {
    return !isDisposed &&
      showLoginPanel.value &&
      !isLoggedIn.value &&
      qrInfo.value?.key == key &&
      isPending()
  }

  const scheduleQrCheck = (key: string) => {
    clearQrTimer()
    if (!canPoll(key)) return
    qrTimer = window.setTimeout(() => {
      qrTimer = null
      void checkLoginStatus(key)
    }, 2000)
  }

  const checkLoginStatus = async(key: string) => {
    if (!canPoll(key)) return
    if (checkingKeys.size) {
      scheduleQrCheck(key)
      return
    }

    checkingKeys.add(key)
    let status: LX.QQMusic.LoginQrCheck
    try {
      status = await checkQQMusicLoginQr(key)
    } catch {
      checkingKeys.delete(key)
      if (canPoll(key)) {
        qrStatusText.value = checkFailedText
        scheduleQrCheck(key)
      }
      return
    }
    checkingKeys.delete(key)

    if (!canPoll(key)) return
    qrState = status.state
    qrStatusText.value = statusText[status.state]

    if (status.state == 'success') {
      clearQrTimer()
      setQQMusicAccountStatus(status)
      try {
        await onLoginSuccess()
      } catch {}
      return
    }

    if (status.state == 'expired') {
      clearQrTimer()
      return
    }

    scheduleQrCheck(key)
  }

  const handleCreateLoginQr = async() => {
    const revision = ++createRevision
    clearQrTimer()
    showLoginPanel.value = true
    isCreatingQr.value = true
    qrStatusText.value = creatingText
    qrState = null
    qrInfo.value = null

    try {
      const info = await createQQMusicLoginQr()
      if (isDisposed || revision != createRevision || !showLoginPanel.value) return
      qrInfo.value = info
      qrState = 'waiting'
      qrStatusText.value = statusText.waiting
      scheduleQrCheck(info.key)
    } catch {
      if (!isDisposed && revision == createRevision && showLoginPanel.value) {
        qrStatusText.value = createFailedText
      }
    } finally {
      if (revision == createRevision) isCreatingQr.value = false
    }
  }

  const handleShowLogin = () => {
    showLoginPanel.value = true
    if (qrInfo.value?.qrimg && isPending()) {
      scheduleQrCheck(qrInfo.value.key)
      return
    }
    void handleCreateLoginQr()
  }

  const handleCloseLogin = () => {
    showLoginPanel.value = false
    createRevision++
    isCreatingQr.value = false
    clearQrTimer()
  }

  onBeforeUnmount(() => {
    isDisposed = true
    showLoginPanel.value = false
    createRevision++
    clearQrTimer()
  })

  return {
    qrInfo,
    qrStatusText,
    qrImg: computed(() => qrInfo.value?.qrimg ?? ''),
    isCreatingQr,
    showLoginPanel,
    handleCreateLoginQr,
    handleShowLogin,
    handleCloseLogin,
  }
}
