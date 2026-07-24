import { computed, ref } from '@common/utils/vueTools'
import { prepareQQGuessLikeQueue, resetQQGuessLikeQueue } from '@renderer/store/qqGuessLike/action'
import { isLoadingQQGuessLike, qqGuessLikeQueue } from '@renderer/store/qqGuessLike/state'
import { getQQMusicAccountKey, initQQMusicAccount } from '@renderer/store/qqMusic'

const LOAD_ERROR = '猜你喜欢加载失败，请稍后重试'

export const useQQGuessLikeData = () => {
  const songs = computed(() => qqGuessLikeQueue)
  const isRefreshing = ref(false)
  const loadError = ref('')
  let requestRevision = 0

  const load = async(force = false) => {
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

  return {
    songs,
    isLoading: isLoadingQQGuessLike,
    isRefreshing,
    loadError,
    load,
    clear,
  }
}
