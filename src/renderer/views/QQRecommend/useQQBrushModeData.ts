import { computed, ref } from '@common/utils/vueTools'
import { prepareQQBrushModeQueue, resetQQBrushModeQueue } from '@renderer/store/qqBrushMode/action'
import { isLoadingQQBrushMode, qqBrushModeQueue } from '@renderer/store/qqBrushMode/state'
import { getQQMusicAccountKey, initQQMusicAccount } from '@renderer/store/qqMusic'

const LOAD_ERROR = '刷歌模式加载失败，请稍后重试'

export const useQQBrushModeData = () => {
  const songs = computed(() => qqBrushModeQueue)
  const loadError = ref('')
  let requestRevision = 0

  const load = async(force = false) => {
    const revision = ++requestRevision
    const accountKey = getQQMusicAccountKey()
    if (!accountKey) {
      loadError.value = ''
      resetQQBrushModeQueue()
      return []
    }

    loadError.value = ''
    try {
      const nextSongs = await prepareQQBrushModeQueue(accountKey, force)
      if (revision != requestRevision || getQQMusicAccountKey() != accountKey) return []
      return nextSongs
    } catch {
      if (revision != requestRevision || getQQMusicAccountKey() != accountKey) return []
      loadError.value = LOAD_ERROR
      await initQQMusicAccount(true).catch(() => null)
      return []
    }
  }

  const clear = () => {
    requestRevision++
    loadError.value = ''
    resetQQBrushModeQueue()
  }

  return {
    songs,
    isLoading: isLoadingQQBrushMode,
    loadError,
    load,
    clear,
  }
}
