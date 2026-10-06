import { computed, ref, shallowRef } from '@common/utils/vueTools'
import { initQQMusicAccount } from '@renderer/store/qqMusic'
import { getQQMusicHomeRecommendation } from '@renderer/utils/ipc'
import { useRecommendationPage } from '@renderer/core/features/recommendationAccess'

const LOAD_ERROR = 'QQ 音乐推荐加载失败，请稍后重试'
const cache = new Map<string, LX.QQMusic.HomeRecommendation>()

export const useQQHomeRecommendData = ({
  accountKey,
}: {
  accountKey: { value: string | null }
}) => {
  const data = shallowRef<LX.QQMusic.HomeRecommendation | null>(null)
  const loadingAccountKey = ref<string | null>(null)
  const isRefreshing = ref(false)
  const loadError = ref('')
  let requestRevision = 0

  const isLoading = computed(() => loadingAccountKey.value != null)

  const load = async(force = false) => {
    if (!isEnabled()) return null
    const key = accountKey.value
    if (!key) {
      clear()
      return null
    }

    if (!force) {
      const cached = cache.get(key)
      if (cached) {
        data.value = cached
        loadError.value = ''
        return cached
      }
    }

    const revision = ++requestRevision
    loadingAccountKey.value = key
    isRefreshing.value = force && data.value != null
    loadError.value = ''
    try {
      const nextData = await getQQMusicHomeRecommendation()
      if (revision != requestRevision || accountKey.value != key) return null
      cache.set(key, nextData)
      data.value = nextData
      return nextData
    } catch {
      if (revision != requestRevision || accountKey.value != key) return null
      loadError.value = LOAD_ERROR
      await initQQMusicAccount(true).catch(() => null)
      return null
    } finally {
      if (revision == requestRevision) {
        loadingAccountKey.value = null
        isRefreshing.value = false
      }
    }
  }

  function clear() {
    requestRevision++
    data.value = null
    loadingAccountKey.value = null
    isRefreshing.value = false
    loadError.value = ''
  }

  const isEnabled = useRecommendationPage('qqRecommend', () => {
    cache.clear()
    clear()
  })

  return {
    data,
    isLoading,
    isRefreshing,
    loadError,
    load,
    clear,
  }
}
