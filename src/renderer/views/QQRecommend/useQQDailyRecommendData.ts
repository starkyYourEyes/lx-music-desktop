import { computed, ref } from '@common/utils/vueTools'
import { prepareQQDailyRecommend, resetQQDailyRecommend } from '@renderer/store/qqDailyRecommend/action'
import { isLoadingQQDailyRecommend, qqDailyRecommendSongs } from '@renderer/store/qqDailyRecommend/state'
import { getQQMusicAccountKey, initQQMusicAccount } from '@renderer/store/qqMusic'

const LOAD_ERROR = '每日30首加载失败，请稍后重试'

export const useQQDailyRecommendData = () => {
  const songs = computed(() => qqDailyRecommendSongs)
  const isRefreshing = ref(false)
  const loadError = ref('')
  let requestRevision = 0

  const load = async(force = false) => {
    const revision = ++requestRevision
    const accountKey = getQQMusicAccountKey()
    if (!accountKey) {
      loadError.value = ''
      return []
    }

    loadError.value = ''
    if (force) isRefreshing.value = true
    try {
      const nextSongs = await prepareQQDailyRecommend(accountKey, force)
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
    resetQQDailyRecommend()
  }

  return {
    songs,
    isLoading: isLoadingQQDailyRecommend,
    isRefreshing,
    loadError,
    load,
    clear,
  }
}
