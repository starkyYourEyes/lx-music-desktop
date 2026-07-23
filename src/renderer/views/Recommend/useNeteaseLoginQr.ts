import { computed, onBeforeUnmount, ref, shallowRef } from '@common/utils/vueTools'
import {
  checkNeteaseLoginQr,
  createNeteaseLoginQr,
} from '@renderer/utils/ipc'
import {
  isLoggedIn,
  setNeteaseAccountStatus,
} from '@renderer/store/netease'
import { LOGIN_QR_PENDING_CODES } from './constants'

export const useNeteaseLoginQr = (onLoginSuccess: () => Promise<void>) => {
  const qrInfo = shallowRef<LX.Netease.LoginQr | null>(null)
  const qrStatusText = ref('正在生成二维码...')
  const isCreatingQr = ref(false)
  const showLoginPanel = ref(false)

  let qrTimer: number | null = null
  let createRevision = 0
  const checkingKeys = new Set<string>()
  let isDisposed = false

  const clearQrTimer = () => {
    if (qrTimer == null) return
    window.clearTimeout(qrTimer)
    qrTimer = null
  }

  const canPoll = (key: string) => {
    return !isDisposed &&
      showLoginPanel.value &&
      !isLoggedIn.value &&
      qrInfo.value?.key == key
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
    let status: LX.Netease.LoginQrCheck
    try {
      status = await checkNeteaseLoginQr(key)
    } catch (err: any) {
      checkingKeys.delete(key)
      if (canPoll(key)) {
        qrStatusText.value = err?.message ?? '检查登录状态失败，稍后重试'
        scheduleQrCheck(key)
      }
      return
    }
    checkingKeys.delete(key)

    if (!canPoll(key)) return
    if (status.code == 803) {
      clearQrTimer()
      setNeteaseAccountStatus(status)
      qrStatusText.value = '登录成功'
      try {
        await onLoginSuccess()
      } catch {}
      return
    }

    if (status.code == 800) {
      clearQrTimer()
      qrStatusText.value = '二维码已过期，请重新获取'
      return
    }

    qrStatusText.value = status.code == 802
      ? '已扫码，请在手机上确认登录'
      : status.message ?? '请使用 WY App 扫码登录'

    if (LOGIN_QR_PENDING_CODES.has(status.code)) scheduleQrCheck(key)
  }

  const handleCreateLoginQr = async() => {
    const revision = ++createRevision
    clearQrTimer()
    showLoginPanel.value = true
    isCreatingQr.value = true
    qrStatusText.value = '正在生成二维码...'
    qrInfo.value = null

    try {
      const info = await createNeteaseLoginQr()
      if (isDisposed || revision != createRevision || !showLoginPanel.value) return
      qrInfo.value = info
      qrStatusText.value = '请使用 WY App 扫码登录'
      scheduleQrCheck(info.key)
    } catch (err: any) {
      if (!isDisposed && revision == createRevision && showLoginPanel.value) {
        qrStatusText.value = err?.message ?? '二维码生成失败'
      }
    } finally {
      if (revision == createRevision) isCreatingQr.value = false
    }
  }

  const handleShowLogin = () => {
    showLoginPanel.value = true
    if (qrInfo.value?.qrimg) {
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
