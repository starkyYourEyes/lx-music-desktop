import { computed, onBeforeUnmount, ref, shallowRef } from '@common/utils/vueTools'
import { isKugouAuthError } from '@common/kugouMusic'
import { initKugouMusicAccount } from '@renderer/store/kugouMusic'
import { useRecommendationPage } from '@renderer/core/features/recommendationAccess'
import {
  getKugouDailyRecommendSongs,
  getKugouPrivateFmSongs,
  getKugouPublicRecommendation,
  getKugouRankRecommendation,
  getKugouStyleRecommendation,
} from '@renderer/utils/ipc'

interface PublicRecommendationCache {
  recommendation: LX.KuGouMusic.PublicRecommendation | null
  rankRecommendation: LX.KuGouMusic.RankRecommendation | null
}

interface PrivateRecommendationCache {
  dailySongs?: LX.Music.MusicInfo_kg[]
  styleSongs?: LX.Music.MusicInfo_kg[]
  fmSongs?: LX.Music.MusicInfo_kg[]
}

const publicCache: PublicRecommendationCache = { recommendation: null, rankRecommendation: null }
const privateCache = new Map<string, PrivateRecommendationCache>()
let accountStatusSyncPromise: Promise<unknown> | null = null

const syncAccountAfterAuthFailure = async(error: unknown): Promise<boolean> => {
  if (!isKugouAuthError(error)) return false
  if (!accountStatusSyncPromise) {
    accountStatusSyncPromise = initKugouMusicAccount(true)
      .finally(() => { accountStatusSyncPromise = null })
  }
  await accountStatusSyncPromise.catch(() => null)
  return true
}

const getErrorMessage = (error: unknown, fallback: string) => {
  return error instanceof Error && error.message ? error.message : fallback
}

export const useKugouRecommendData = ({ accountKey }: { accountKey: { value: string | null } }) => {
  const publicRecommendation = shallowRef<LX.KuGouMusic.PublicRecommendation | null>(publicCache.recommendation)
  const rankRecommendation = shallowRef<LX.KuGouMusic.RankRecommendation | null>(publicCache.rankRecommendation)
  const dailySongs = ref<LX.Music.MusicInfo_kg[]>([])
  const styleSongs = ref<LX.Music.MusicInfo_kg[]>([])
  const fmSongs = ref<LX.Music.MusicInfo_kg[]>([])

  const isLoadingPublicRecommendation = ref(false)
  const isLoadingPublicSongs = ref(false)
  const isLoadingDailySongs = ref(false)
  const isLoadingStyleSongs = ref(false)
  const isLoadingFmSongs = ref(false)
  const publicRecommendationLoadError = ref('')
  const publicSongsLoadError = ref('')
  const dailySongsLoadError = ref('')
  const styleSongsLoadError = ref('')
  const fmSongsLoadError = ref('')

  const playlists = computed(() => publicRecommendation.value?.playlists ?? [])
  const ranks = computed(() => publicRecommendation.value?.ranks ?? [])
  const publicSongs = computed(() => rankRecommendation.value?.songs ?? [])
  const publicRank = computed(() => rankRecommendation.value?.rank ?? null)
  const isLoadingPublic = computed(() => isLoadingPublicRecommendation.value || isLoadingPublicSongs.value)
  const isLoadingPrivate = computed(() => isLoadingDailySongs.value || isLoadingStyleSongs.value || isLoadingFmSongs.value)

  let activeAccountKey = accountKey.value
  let publicRecommendationRevision = 0
  let rankRevision = 0
  let dailyRevision = 0
  let styleRevision = 0
  let fmRevision = 0

  const clearPrivateState = () => {
    dailySongs.value = []
    styleSongs.value = []
    fmSongs.value = []
    dailySongsLoadError.value = ''
    styleSongsLoadError.value = ''
    fmSongsLoadError.value = ''
    isLoadingDailySongs.value = false
    isLoadingStyleSongs.value = false
    isLoadingFmSongs.value = false
  }

  const invalidatePrivateRequests = () => {
    dailyRevision++
    styleRevision++
    fmRevision++
  }

  const handleAccountChange = () => {
    if (activeAccountKey == accountKey.value) return
    activeAccountKey = accountKey.value
    invalidatePrivateRequests()
    clearPrivateState()
  }

  const getPrivateCache = (key: string) => {
    const cached = privateCache.get(key) ?? {}
    privateCache.set(key, cached)
    return cached
  }

  const loadPublicRecommendation = async(force = false) => {
    if (!isEnabled()) return
    if (!force && publicCache.recommendation) {
      publicRecommendation.value = publicCache.recommendation
      return
    }
    const revision = ++publicRecommendationRevision
    isLoadingPublicRecommendation.value = true
    publicRecommendationLoadError.value = ''
    try {
      const recommendation = await getKugouPublicRecommendation()
      if (revision != publicRecommendationRevision) return
      publicCache.recommendation = recommendation
      publicRecommendation.value = recommendation
    } catch (error) {
      if (revision == publicRecommendationRevision) {
        publicRecommendationLoadError.value = getErrorMessage(error, 'Kugou public recommendation failed')
      }
    } finally {
      if (revision == publicRecommendationRevision) isLoadingPublicRecommendation.value = false
    }
  }

  const loadRankRecommendation = async(force = false) => {
    if (!isEnabled()) return
    if (!force && publicCache.rankRecommendation) {
      rankRecommendation.value = publicCache.rankRecommendation
      return
    }
    const revision = ++rankRevision
    isLoadingPublicSongs.value = true
    publicSongsLoadError.value = ''
    try {
      const recommendation = await getKugouRankRecommendation()
      if (revision != rankRevision) return
      publicCache.rankRecommendation = recommendation
      rankRecommendation.value = recommendation
    } catch (error) {
      if (revision == rankRevision) publicSongsLoadError.value = getErrorMessage(error, 'Kugou chart songs failed')
    } finally {
      if (revision == rankRevision) isLoadingPublicSongs.value = false
    }
  }

  const loadDailySongs = async(force = false) => {
    if (!isEnabled()) return
    handleAccountChange()
    const requestAccountKey = accountKey.value
    if (!requestAccountKey) return
    const cached = privateCache.get(requestAccountKey)?.dailySongs
    if (!force && cached) {
      dailySongs.value = cached
      return
    }
    const revision = ++dailyRevision
    isLoadingDailySongs.value = true
    dailySongsLoadError.value = ''
    try {
      const songs = await getKugouDailyRecommendSongs()
      if (revision != dailyRevision || accountKey.value != requestAccountKey) return
      dailySongs.value = songs
      getPrivateCache(requestAccountKey).dailySongs = songs
    } catch (error) {
      if (await syncAccountAfterAuthFailure(error)) {
        handleAccountChange()
        if (accountKey.value != requestAccountKey) return
      }
      if (revision == dailyRevision && accountKey.value == requestAccountKey) {
        dailySongsLoadError.value = getErrorMessage(error, 'Kugou daily recommendation failed')
      }
    } finally {
      if (revision == dailyRevision && accountKey.value == requestAccountKey) isLoadingDailySongs.value = false
    }
  }

  const loadStyleSongs = async(force = false) => {
    if (!isEnabled()) return
    handleAccountChange()
    const requestAccountKey = accountKey.value
    if (!requestAccountKey) return
    const cached = privateCache.get(requestAccountKey)?.styleSongs
    if (!force && cached) {
      styleSongs.value = cached
      return
    }
    const revision = ++styleRevision
    isLoadingStyleSongs.value = true
    styleSongsLoadError.value = ''
    try {
      const songs = await getKugouStyleRecommendation()
      if (revision != styleRevision || accountKey.value != requestAccountKey) return
      styleSongs.value = songs
      getPrivateCache(requestAccountKey).styleSongs = songs
    } catch (error) {
      if (await syncAccountAfterAuthFailure(error)) {
        handleAccountChange()
        if (accountKey.value != requestAccountKey) return
      }
      if (revision == styleRevision && accountKey.value == requestAccountKey) {
        styleSongsLoadError.value = getErrorMessage(error, 'Kugou style recommendation failed')
      }
    } finally {
      if (revision == styleRevision && accountKey.value == requestAccountKey) isLoadingStyleSongs.value = false
    }
  }

  const loadFmSongs = async(force = false) => {
    if (!isEnabled()) return
    handleAccountChange()
    const requestAccountKey = accountKey.value
    if (!requestAccountKey) return
    const cached = privateCache.get(requestAccountKey)?.fmSongs
    if (!force && cached) {
      fmSongs.value = cached
      return
    }
    const revision = ++fmRevision
    isLoadingFmSongs.value = true
    fmSongsLoadError.value = ''
    try {
      const songs = await getKugouPrivateFmSongs()
      if (revision != fmRevision || accountKey.value != requestAccountKey) return
      fmSongs.value = songs
      getPrivateCache(requestAccountKey).fmSongs = songs
    } catch (error) {
      if (await syncAccountAfterAuthFailure(error)) {
        handleAccountChange()
        if (accountKey.value != requestAccountKey) return
      }
      if (revision == fmRevision && accountKey.value == requestAccountKey) {
        fmSongsLoadError.value = getErrorMessage(error, 'Kugou Private FM failed')
      }
    } finally {
      if (revision == fmRevision && accountKey.value == requestAccountKey) isLoadingFmSongs.value = false
    }
  }

  const loadPublic = async(force = false) => {
    await Promise.all([loadPublicRecommendation(force), loadRankRecommendation(force)])
  }

  const loadPrivate = async(force = false) => {
    handleAccountChange()
    if (!accountKey.value) return
    await Promise.all([loadDailySongs(force), loadStyleSongs(force), loadFmSongs(force)])
  }

  const loadAll = async(force = false) => {
    await Promise.all([loadPublic(force), loadPrivate(force)])
  }

  const clearPrivate = () => {
    activeAccountKey = accountKey.value
    invalidatePrivateRequests()
    privateCache.clear()
    clearPrivateState()
  }

  const clearAll = () => {
    publicRecommendationRevision++
    rankRevision++
    publicCache.recommendation = null
    publicCache.rankRecommendation = null
    privateCache.clear()
    publicRecommendation.value = null
    rankRecommendation.value = null
    publicRecommendationLoadError.value = ''
    publicSongsLoadError.value = ''
    isLoadingPublicRecommendation.value = false
    isLoadingPublicSongs.value = false
    clearPrivate()
  }

  onBeforeUnmount(() => {
    publicRecommendationRevision++
    rankRevision++
    invalidatePrivateRequests()
    isLoadingPublicRecommendation.value = false
    isLoadingPublicSongs.value = false
    clearPrivateState()
  })

  const isEnabled = useRecommendationPage('kugouRecommend', clearAll)

  return {
    publicRecommendation,
    rankRecommendation,
    playlists,
    ranks,
    publicRank,
    publicSongs,
    dailySongs,
    styleSongs,
    fmSongs,
    isLoadingPublicRecommendation,
    isLoadingPublicSongs,
    isLoadingDailySongs,
    isLoadingStyleSongs,
    isLoadingFmSongs,
    isLoadingPublic,
    isLoadingPrivate,
    publicRecommendationLoadError,
    publicSongsLoadError,
    dailySongsLoadError,
    styleSongsLoadError,
    fmSongsLoadError,
    loadPublicRecommendation,
    loadRankRecommendation,
    loadDailySongs,
    loadStyleSongs,
    loadFmSongs,
    loadPublic,
    loadPrivate,
    loadAll,
    handleRefresh: async() => loadAll(true),
    clearPrivate,
    clearAll,
  }
}
