import { computed, onBeforeUnmount, ref, shallowRef } from '@common/utils/vueTools'
import {
  cancelQQMusicLoginQr,
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
const createTimeoutText = '二维码生成超时，请重试'
const checkFailedText = '检查登录状态失败，稍后重试'

interface QrVisibilityAttempt {
  requestId: string
  startedAt: number
  reported: boolean
}

export const isRenderedQQMusicQrImage = (
  image: HTMLImageElement,
): boolean => {
  const style = window.getComputedStyle(image)
  const bounds = image.getBoundingClientRect()
  return image.isConnected &&
    image.naturalWidth > 0 &&
    image.naturalHeight > 0 &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    style.display != 'none' &&
    style.visibility != 'hidden' &&
    style.visibility != 'collapse' &&
    Number.parseFloat(style.opacity) > 0
}

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
  let currentRequestId: string | null = null
  let visibilityAttempt: QrVisibilityAttempt | null = null

  const clearVisibilityAttempt = (requestId?: string) => {
    if (requestId && visibilityAttempt?.requestId != requestId) return
    visibilityAttempt = null
  }

  const clearQrTimer = () => {
    if (qrTimer == null) return
    window.clearTimeout(qrTimer)
    qrTimer = null
  }

  const isPending = () => qrState == 'waiting' || qrState == 'scanned'

  const cancelCurrentRequest = async(): Promise<void> => {
    const requestId = currentRequestId
    currentRequestId = null
    clearVisibilityAttempt(requestId ?? undefined)
    if (!requestId) return
    try {
      await cancelQQMusicLoginQr(requestId)
    } catch {}
  }

  const canPoll = (key: string) => {
    return !isDisposed &&
      currentRequestId == key &&
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
    if (checkingKeys.has(key)) {
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

    if (status.state == 'success' || status.state == 'expired') {
      if (currentRequestId == key) currentRequestId = null
      clearVisibilityAttempt(key)
    }

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

    await cancelCurrentRequest()
    if (isDisposed || revision != createRevision || !showLoginPanel.value) return

    const requestId = window.crypto.randomUUID()
    currentRequestId = requestId
    try {
      visibilityAttempt = {
        requestId,
        startedAt: window.performance.now(),
        reported: false,
      }
      const info = await createQQMusicLoginQr(requestId)
      if (isDisposed || revision != createRevision ||
        currentRequestId != requestId || !showLoginPanel.value) return
      if (info.key != requestId) throw new Error(createFailedText)
      qrInfo.value = info
      qrState = 'waiting'
      qrStatusText.value = statusText.waiting
      scheduleQrCheck(requestId)
    } catch (error) {
      clearVisibilityAttempt(requestId)
      const isCurrent = currentRequestId == requestId
      if (isCurrent) {
        currentRequestId = null
        void cancelQQMusicLoginQr(requestId).catch(() => {})
      }
      if (!isDisposed && revision == createRevision &&
        isCurrent && showLoginPanel.value) {
        qrStatusText.value = error instanceof Error &&
          error.message.includes('QQ Music login QR creation timed out')
          ? createTimeoutText
          : createFailedText
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

  const handleQrImageLoad = (event: Event) => {
    const image = event.currentTarget
    if (!(image instanceof HTMLImageElement)) return
    const attempt = visibilityAttempt
    const revision = createRevision
    if (!attempt || attempt.reported) return

    window.requestAnimationFrame(() => {
      if (isDisposed || revision != createRevision ||
        visibilityAttempt !== attempt || attempt.reported ||
        currentRequestId != attempt.requestId ||
        qrInfo.value?.key != attempt.requestId) return

      if (!isRenderedQQMusicQrImage(image)) return

      attempt.reported = true
      const end = window.performance.now()
      window.performance.measure('qq-music-login-qr-visible', {
        start: attempt.startedAt,
        end,
      })
      console.info('[QQ Music login performance]', {
        stage: 'qr-visible',
        elapsedMs: Math.max(0, Math.round(end - attempt.startedAt)),
      })
    })
  }

  const handleCloseLogin = () => {
    showLoginPanel.value = false
    createRevision++
    isCreatingQr.value = false
    qrState = null
    qrInfo.value = null
    clearQrTimer()
    clearVisibilityAttempt()
    void cancelCurrentRequest()
  }

  onBeforeUnmount(() => {
    isDisposed = true
    showLoginPanel.value = false
    createRevision++
    clearQrTimer()
    clearVisibilityAttempt()
    void cancelCurrentRequest()
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
    handleQrImageLoad,
  }
}
