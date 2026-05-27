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

  const clearQrTimer = () => {
    if (qrTimer == null) return
    window.clearTimeout(qrTimer)
    qrTimer = null
  }

  const scheduleQrCheck = () => {
    clearQrTimer()
    qrTimer = window.setTimeout(() => {
      void checkLoginStatus()
    }, 2000)
  }

  const checkLoginStatus = async() => {
    if (!qrInfo.value?.key || isLoggedIn.value) return

    try {
      const status = await checkNeteaseLoginQr(qrInfo.value.key)
      if (status.code == 803) {
        clearQrTimer()
        setNeteaseAccountStatus(status)
        qrStatusText.value = '登录成功'
        await onLoginSuccess()
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

      if (LOGIN_QR_PENDING_CODES.has(status.code)) scheduleQrCheck()
    } catch (err: any) {
      qrStatusText.value = err?.message ?? '检查登录状态失败，稍后重试'
      scheduleQrCheck()
    }
  }

  const handleCreateLoginQr = async() => {
    clearQrTimer()
    showLoginPanel.value = true
    isCreatingQr.value = true
    qrStatusText.value = '正在生成二维码...'
    qrInfo.value = null

    try {
      qrInfo.value = await createNeteaseLoginQr()
      qrStatusText.value = '请使用 WY App 扫码登录'
      scheduleQrCheck()
    } catch (err: any) {
      qrStatusText.value = err?.message ?? '二维码生成失败'
    } finally {
      isCreatingQr.value = false
    }
  }

  const handleShowLogin = () => {
    if (qrInfo.value?.qrimg) {
      showLoginPanel.value = true
      scheduleQrCheck()
      return
    }
    void handleCreateLoginQr()
  }

  const handleCloseLogin = () => {
    showLoginPanel.value = false
    clearQrTimer()
  }

  onBeforeUnmount(clearQrTimer)

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
