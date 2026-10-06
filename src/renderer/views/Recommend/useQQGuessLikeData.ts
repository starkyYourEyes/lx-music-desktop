import { computed, ref } from '@common/utils/vueTools'
import { prepareQQGuessLikeQueue, resetQQGuessLikeQueue } from '@renderer/store/qqGuessLike/action'
import { isLoadingQQGuessLike, isQQGuessLikeMode, qqGuessLikeQueue } from '@renderer/store/qqGuessLike/state'
import { getQQMusicAccountKey, initQQMusicAccount } from '@renderer/store/qqMusic'
import { useRecommendationPage } from '@renderer/core/features/recommendationAccess'

const LOAD_ERROR = '猜你喜欢加载失败，请稍后重试'

export const useQQGuessLikeData = () => {
  const songs = computed(() => qqGuessLikeQueue)
  const isRefreshing = ref(false)
  const loadError = ref('')
  let requestRevision = 0

  const load = async(force = false) => {
    if (!isEnabled()) return []
    const revision = ++requestRevision
    const accountKey = getQQMusicAccountKey()
    if (!accountKey) {
      loadError.value = ''
      resetQQGuessLikeQueue()
      return []
    }

    loadError.value = ''
    if (force) isRefreshing.value = true
    try {
      const nextSongs = await prepareQQGuessLikeQueue(accountKey, force)
      if (revision != requestRevision || getQQMusicAccountKey() != accountKey) return []
      return nextSongs
    } catch {
      if (revision != requestRevision || getQQMusicAccountKey() != accountKey) return []
      loadError.value = LOAD_ERROR
      await initQQMusicAccount(true).catch(() => null)
      return []
    } finally {
      if (revision == requestRevision) isRefreshing.value = false
    }
  }

  const clear = () => {
    requestRevision++
    loadError.value = ''
    isRefreshing.value = false
    resetQQGuessLikeQueue()
  }

  const isEnabled = useRecommendationPage('qqRecommend', () => {
    requestRevision++
    loadError.value = ''
    isRefreshing.value = false
    if (!isQQGuessLikeMode.value) resetQQGuessLikeQueue()
  })

  return {
    songs,
    isLoading: isLoadingQQGuessLike,
    isRefreshing,
    loadError,
    load,
    clear,
  }
}
