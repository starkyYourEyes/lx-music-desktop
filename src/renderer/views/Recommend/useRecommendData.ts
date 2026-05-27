import { computed, ref, shallowRef, type ComputedRef } from '@common/utils/vueTools'
import {
  getNeteaseHomeRecommendation,
  getNeteaseRecommendPlaylists,
} from '@renderer/utils/ipc'
import { isLoggedIn } from '@renderer/store/netease'
import { isPrivateFmMode } from '@renderer/store/privateFm/state'
import { preparePrivateFmQueue } from '@renderer/store/privateFm/action'
import { loadDailyRecommendSongs } from '@renderer/store/dailyRecommend/action'
import {
  EXPLORE_PLAYLIST_LIMIT,
  HOME_RECOMMEND_PLAYLIST_LIMIT,
  HOME_SONG_LIMIT,
  RECOMMEND_CACHE_TTL,
} from './constants'

const recommendPlaylistCache = new Map<string, {
  list: LX.Netease.Playlist[]
  updatedAt: number
}>()

const homeRecommendationCache = new Map<string, {
  data: LX.Netease.HomeRecommendation
  updatedAt: number
}>()

export const useRecommendData = ({
  isExploreMode,
  playlistScrollRef,
  onHomeSongsUpdated,
}: {
  isExploreMode: ComputedRef<boolean>
  playlistScrollRef: { value: HTMLElement | null }
  onHomeSongsUpdated: () => void
}) => {
  const isLoadingPlaylists = ref(false)
  const playlistLoadError = ref('')
  const recommendPlaylists = ref<LX.Netease.Playlist[]>([])
  const homeRecommendation = shallowRef<LX.Netease.HomeRecommendation | null>(null)
  const isRefreshingSimilarSongs = ref(false)
  const isRefreshingRecommendPlaylists = ref(false)

  const recommendPlaylistCacheKey = computed(() => `${isExploreMode.value ? 'explore' : 'home'}:${isLoggedIn.value ? 'login' : 'guest'}`)
  const homeRecommendationCacheKey = computed(() => `${isLoggedIn.value ? 'login' : 'guest'}`)

  const getRecommendPlaylistCache = (key = recommendPlaylistCacheKey.value) => {
    const cache = recommendPlaylistCache.get(key)
    if (!cache || Date.now() - cache.updatedAt > RECOMMEND_CACHE_TTL) return null
    return cache.list
  }

  const setRecommendPlaylistCache = (list: LX.Netease.Playlist[], key = recommendPlaylistCacheKey.value) => {
    recommendPlaylistCache.set(key, {
      list,
      updatedAt: Date.now(),
    })
  }

  const getHomeRecommendationCache = (key = homeRecommendationCacheKey.value) => {
    const cache = homeRecommendationCache.get(key)
    if (!cache || Date.now() - cache.updatedAt > RECOMMEND_CACHE_TTL) return null
    return cache.data
  }

  const setHomeRecommendationCache = (data: LX.Netease.HomeRecommendation, key = homeRecommendationCacheKey.value) => {
    homeRecommendationCache.set(key, {
      data,
      updatedAt: Date.now(),
    })
  }

  const displayedPlaylists = computed(() => recommendPlaylists.value.slice(0, EXPLORE_PLAYLIST_LIMIT))
  const homeRadarPlaylists = computed(() => homeRecommendation.value?.radarPlaylists ?? [])
  const homeSimilarSongs = computed(() => (homeRecommendation.value?.similarSongs ?? []).slice(0, HOME_SONG_LIMIT))
  const homeRecommendPlaylists = computed(() => homeRecommendation.value?.recommendPlaylists ?? [])
  const homeCharts = computed(() => homeRecommendation.value?.charts ?? [])
  const hasHomeContent = computed(() => {
    return !!(
      homeRadarPlaylists.value.length ||
      homeSimilarSongs.value.length ||
      homeRecommendPlaylists.value.length ||
      homeCharts.value.length
    )
  })

  const playlistNoItemText = computed(() => {
    if (isExploreMode.value) {
      if (isLoadingPlaylists.value) return '推荐歌单加载中...'
      if (playlistLoadError.value) return playlistLoadError.value
      if (!recommendPlaylists.value.length) return '暂时没有拿到推荐歌单'
      return ''
    }

    if (isLoadingPlaylists.value && !hasHomeContent.value) return '推荐内容加载中...'
    if (playlistLoadError.value && !hasHomeContent.value) return playlistLoadError.value
    if (!hasHomeContent.value) return '暂时没有拿到推荐内容'
    return ''
  })

  const fetchBaseRecommendPlaylists = async(forceRefresh = false) => {
    const cacheKey = recommendPlaylistCacheKey.value
    const cachedList = forceRefresh ? null : getRecommendPlaylistCache(cacheKey)
    if (cachedList) return cachedList

    const list = await getNeteaseRecommendPlaylists(
      isExploreMode.value ? EXPLORE_PLAYLIST_LIMIT : HOME_RECOMMEND_PLAYLIST_LIMIT,
      isExploreMode.value,
    )
    setRecommendPlaylistCache(list, cacheKey)
    return list
  }

  const fetchHomeRecommendation = async(forceRefresh = false) => {
    const cacheKey = homeRecommendationCacheKey.value
    const cachedData = forceRefresh ? null : getHomeRecommendationCache(cacheKey)
    if (cachedData) return cachedData

    const data = await getNeteaseHomeRecommendation({
      forceRefresh,
      playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
      songLimit: HOME_SONG_LIMIT,
    })
    setHomeRecommendationCache(data, cacheKey)
    return data
  }

  const loadRecommendPlaylists = async(forceRefresh = false) => {
    const cachedList = forceRefresh ? null : getRecommendPlaylistCache()
    const cachedHome = forceRefresh || isExploreMode.value ? null : getHomeRecommendationCache()
    if (cachedList) recommendPlaylists.value = cachedList
    if (cachedHome) homeRecommendation.value = cachedHome
    if (!forceRefresh && cachedList && (isExploreMode.value || cachedHome)) return

    isLoadingPlaylists.value = true
    playlistLoadError.value = ''

    const errors: any[] = []
    const baseTask = fetchBaseRecommendPlaylists(forceRefresh)

    const homeTask = !isExploreMode.value
      ? fetchHomeRecommendation(forceRefresh)
      : Promise.resolve<LX.Netease.HomeRecommendation | null>(null)

    const warmupTasks: Array<Promise<unknown>> = []
    if (!isExploreMode.value && isLoggedIn.value) {
      warmupTasks.push(loadDailyRecommendSongs(forceRefresh).catch(err => {
        console.warn('Load daily recommend failed:', err)
      }))
      warmupTasks.push(preparePrivateFmQueue(forceRefresh && !isPrivateFmMode.value).catch(err => {
        console.warn('Load private FM failed:', err)
      }))
    }

    try {
      const [baseResult, homeResult] = await Promise.all([
        baseTask.catch(err => {
          errors.push(err)
          return null
        }),
        homeTask.catch(err => {
          errors.push(err)
          return null
        }),
      ])
      await Promise.all(warmupTasks)
      if (baseResult) recommendPlaylists.value = baseResult
      if (homeResult) homeRecommendation.value = homeResult
      onHomeSongsUpdated()
      if (errors.length && (isExploreMode.value ? !recommendPlaylists.value.length : !hasHomeContent.value)) {
        playlistLoadError.value = errors[0]?.message ?? '推荐内容加载失败'
      }
      if (forceRefresh) {
        setTimeout(() => {
          playlistScrollRef.value?.scrollTo({ top: 0 })
        })
      }
    } finally {
      isLoadingPlaylists.value = false
    }
  }

  const mergeHomeRecommendation = (partial: Partial<LX.Netease.HomeRecommendation>) => {
    const nextData: LX.Netease.HomeRecommendation = {
      radarPlaylists: homeRecommendation.value?.radarPlaylists ?? [],
      similarSongs: homeRecommendation.value?.similarSongs ?? [],
      recommendPlaylists: homeRecommendation.value?.recommendPlaylists ?? [],
      charts: homeRecommendation.value?.charts ?? [],
      ...partial,
    }
    homeRecommendation.value = nextData
    setHomeRecommendationCache(nextData)
  }

  const handleRefreshSimilarSongs = async() => {
    if (isRefreshingSimilarSongs.value) return
    isRefreshingSimilarSongs.value = true
    playlistLoadError.value = ''
    try {
      const data = await getNeteaseHomeRecommendation({
        forceRefresh: true,
        playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
        songLimit: HOME_SONG_LIMIT,
      })
      mergeHomeRecommendation({ similarSongs: data.similarSongs })
      onHomeSongsUpdated()
    } catch (err: any) {
      playlistLoadError.value = err?.message ?? '红心相似歌曲刷新失败'
    } finally {
      isRefreshingSimilarSongs.value = false
    }
  }

  const handleRefreshRecommendPlaylists = async() => {
    if (isRefreshingRecommendPlaylists.value) return
    isRefreshingRecommendPlaylists.value = true
    playlistLoadError.value = ''
    try {
      const data = await getNeteaseHomeRecommendation({
        forceRefresh: true,
        playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
        songLimit: HOME_SONG_LIMIT,
      })
      mergeHomeRecommendation({ recommendPlaylists: data.recommendPlaylists })
    } catch (err: any) {
      playlistLoadError.value = err?.message ?? '推荐歌单刷新失败'
    } finally {
      isRefreshingRecommendPlaylists.value = false
    }
  }

  return {
    isLoadingPlaylists,
    playlistLoadError,
    recommendPlaylists,
    displayedPlaylists,
    homeRadarPlaylists,
    homeSimilarSongs,
    homeRecommendPlaylists,
    homeCharts,
    hasHomeContent,
    playlistNoItemText,
    isRefreshingSimilarSongs,
    isRefreshingRecommendPlaylists,
    loadRecommendPlaylists,
    handleRefresh: async() => loadRecommendPlaylists(true),
    handleRefreshSimilarSongs,
    handleRefreshRecommendPlaylists,
  }
}
