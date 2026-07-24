import { ref } from '@common/utils/vueTools'
import { initQQMusicAccount, isLoggedIn, profile } from '@renderer/store/qqMusic'
import { getQQMusicGuessLikeSongs } from '@renderer/utils/ipc'

const recommendCache = new Map<string, LX.Music.MusicInfo_tx[]>()
const LOAD_ERROR = '猜你喜欢加载失败，请稍后重试'

export const useQQGuessLikeData = () => {
  const songs = ref<LX.Music.MusicInfo_tx[]>([])
  const isLoading = ref(false)
  const isRefreshing = ref(false)
  const loadError = ref('')

  let requestRevision = 0
  let visibleAccountKey: string | null = null
  let lastVisibleAccountKey: string | null = null

  const getAccountKey = () => isLoggedIn.value ? profile.value?.uin ?? null : null

  const resetVisibleState = () => {
    songs.value = []
    loadError.value = ''
    isLoading.value = false
    isRefreshing.value = false
  }

  const isCurrentRequest = (revision: number, accountKey: string) => {
    return revision == requestRevision &&
      visibleAccountKey == accountKey &&
      getAccountKey() == accountKey
  }

  const ownsLoadingState = (revision: number, accountKey: string) => {
    return revision == requestRevision && visibleAccountKey == accountKey
  }

  const load = async(force = false) => {
    const revision = ++requestRevision
    const accountKey = getAccountKey()

    if (!accountKey) {
      visibleAccountKey = null
      resetVisibleState()
      return []
    }

    if (visibleAccountKey != accountKey) resetVisibleState()
    visibleAccountKey = accountKey
    lastVisibleAccountKey = accountKey

    if (!force && recommendCache.has(accountKey)) {
      const cachedSongs = recommendCache.get(accountKey)!
      songs.value = cachedSongs
      loadError.value = ''
      isLoading.value = false
      isRefreshing.value = false
      return cachedSongs
    }

    loadError.value = ''
    if (force) {
      isRefreshing.value = true
      isLoading.value = false
    } else {
      isLoading.value = true
      isRefreshing.value = false
    }

    try {
      const nextSongs = await getQQMusicGuessLikeSongs()
      if (!isCurrentRequest(revision, accountKey)) return []
      recommendCache.set(accountKey, nextSongs)
      songs.value = nextSongs
      return nextSongs
    } catch {
      if (!isCurrentRequest(revision, accountKey)) return []
      loadError.value = LOAD_ERROR
      await initQQMusicAccount(true).catch(() => null)
      return []
    } finally {
      if (ownsLoadingState(revision, accountKey)) {
        isLoading.value = false
        isRefreshing.value = false
      }
    }
  }

  const clear = () => {
    const accountKey = getAccountKey()
    if (accountKey) recommendCache.delete(accountKey)
    if (lastVisibleAccountKey) recommendCache.delete(lastVisibleAccountKey)
    requestRevision++
    visibleAccountKey = null
    lastVisibleAccountKey = null
    resetVisibleState()
  }

  return {
    songs,
    isLoading,
    isRefreshing,
    loadError,
    load,
    clear,
  }
}
