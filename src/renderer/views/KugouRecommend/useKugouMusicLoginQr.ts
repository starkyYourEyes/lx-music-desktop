import { computed, onBeforeUnmount, ref, shallowRef } from '@common/utils/vueTools'
import { useI18n } from '@root/lang'
import {
  cancelKugouMusicLoginQr,
  checkKugouMusicLoginQr,
  createKugouMusicLoginQr,
} from '@renderer/utils/ipc'
import {
  isLoggedIn,
  setKugouMusicAccountStatus,
} from '@renderer/store/kugouMusic'

const createRequestId = () => window.crypto.randomUUID().toLowerCase()

const qrStatusKeys = {
  waiting: 'kugou_recommend_qr_status_waiting',
  scanned: 'kugou_recommend_qr_status_scanned',
  expired: 'kugou_recommend_qr_status_expired',
  success: 'kugou_recommend_qr_status_success',
  creating: 'kugou_recommend_qr_creating',
  createFailed: 'kugou_recommend_qr_create_failed',
  checkFailed: 'kugou_recommend_qr_check_failed',
} as const

export const useKugouMusicLoginQr = (onLoginSuccess: () => Promise<void>) => {
  const t = useI18n()
  const qrInfo = shallowRef<LX.KuGouMusic.LoginQr | null>(null)
  const qrStatusKey = ref<keyof typeof qrStatusKeys>('creating')
  const qrStatusText = computed(() => t(qrStatusKeys[qrStatusKey.value]))
  const isCreatingQr = ref(false)
  const showLoginPanel = ref(false)

  let qrState: LX.KuGouMusic.LoginQrCheck['state'] | null = null
  let qrTimer: number | null = null
  let createRevision = 0
  const checkingRequestIds = new Set<string>()
  let isDisposed = false
  let currentRequestId: string | null = null

  const clearQrTimer = () => {
    if (qrTimer == null) return
    window.clearTimeout(qrTimer)
    qrTimer = null
  }

  const isPending = () => qrState == 'waiting' || qrState == 'scanned'

  const cancelCurrentRequest = async(): Promise<void> => {
    const requestId = currentRequestId
    currentRequestId = null
    if (!requestId) return
    try {
      await cancelKugouMusicLoginQr(requestId)
    } catch {}
  }

  const canPoll = (requestId: string) => {
    return !isDisposed &&
      currentRequestId == requestId &&
      showLoginPanel.value &&
      !isLoggedIn.value &&
      qrInfo.value?.requestId == requestId &&
      isPending()
  }

  const scheduleQrCheck = (requestId: string) => {
    clearQrTimer()
    if (!canPoll(requestId)) return
    qrTimer = window.setTimeout(() => {
      qrTimer = null
      void checkLoginStatus(requestId)
    }, 2000)
  }

  const checkLoginStatus = async(requestId: string) => {
    if (!canPoll(requestId)) return
    if (checkingRequestIds.has(requestId)) {
      scheduleQrCheck(requestId)
      return
    }

    checkingRequestIds.add(requestId)
    let status: LX.KuGouMusic.LoginQrCheck
    try {
      status = await checkKugouMusicLoginQr(requestId)
    } catch {
      checkingRequestIds.delete(requestId)
      if (canPoll(requestId)) {
        qrStatusKey.value = 'checkFailed'
        scheduleQrCheck(requestId)
      }
      return
    }
    checkingRequestIds.delete(requestId)

    if (!canPoll(requestId)) return
    if (status.state == 'success' && !status.isLoggedIn) {
      qrState = 'scanned'
      qrStatusKey.value = 'checkFailed'
      scheduleQrCheck(requestId)
      return
    }
    qrState = status.state
    qrStatusKey.value = status.state

    if (status.state == 'success' || status.state == 'expired') {
      if (currentRequestId == requestId) currentRequestId = null
    }

    if (status.state == 'success') {
      clearQrTimer()
      setKugouMusicAccountStatus(status)
      try {
        await onLoginSuccess()
      } catch {}
      return
    }

    if (status.state == 'expired') {
      clearQrTimer()
      return
    }

    scheduleQrCheck(requestId)
  }

  const handleCreateLoginQr = async() => {
    const revision = ++createRevision
    clearQrTimer()
    showLoginPanel.value = true
    isCreatingQr.value = true
    qrStatusKey.value = 'creating'
    qrState = null
    qrInfo.value = null

    await cancelCurrentRequest()
    if (isDisposed || revision != createRevision || !showLoginPanel.value) return

    const requestId = createRequestId()
    currentRequestId = requestId
    try {
      const info = await createKugouMusicLoginQr(requestId)
      if (isDisposed || revision != createRevision ||
        currentRequestId != requestId || !showLoginPanel.value) return
      if (info.requestId != requestId) throw new Error('Unexpected QR request ID')
      qrInfo.value = info
      qrState = 'waiting'
      qrStatusKey.value = 'waiting'
      scheduleQrCheck(requestId)
    } catch {
      const isCurrent = currentRequestId == requestId
      if (isCurrent) {
        currentRequestId = null
        void cancelKugouMusicLoginQr(requestId).catch(() => {})
      }
      if (!isDisposed && revision == createRevision &&
        isCurrent && showLoginPanel.value) qrStatusKey.value = 'createFailed'
    } finally {
      if (revision == createRevision) isCreatingQr.value = false
    }
  }

  const handleShowLogin = () => {
    showLoginPanel.value = true
    if (qrInfo.value?.image && isPending()) {
      scheduleQrCheck(qrInfo.value.requestId)
      return
    }
    void handleCreateLoginQr()
  }

  const handleCloseLogin = () => {
    showLoginPanel.value = false
    createRevision++
    isCreatingQr.value = false
    qrState = null
    qrInfo.value = null
    clearQrTimer()
    void cancelCurrentRequest()
  }

  const handleQrImageLoad = () => {}

  onBeforeUnmount(() => {
    isDisposed = true
    showLoginPanel.value = false
    createRevision++
    clearQrTimer()
    void cancelCurrentRequest()
  })

  return {
    qrInfo,
    qrStatusText,
    qrImg: computed(() => qrInfo.value?.image ?? ''),
    isCreatingQr,
    showLoginPanel,
    handleCreateLoginQr,
    handleShowLogin,
    handleCloseLogin,
    handleQrImageLoad,
  }
}
