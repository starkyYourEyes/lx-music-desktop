import { computed, nextTick, ref, shallowRef, type ComputedRef } from '@common/utils/vueTools'
import {
  getNeteaseHomeRecommendation,
  getNeteaseRecommendPlaylists,
} from '@renderer/utils/ipc'
import { isLoggedIn } from '@renderer/store/netease'
import { appSetting } from '@renderer/store/setting'
import { isPrivateFmMode } from '@renderer/store/privateFm/state'
import { preparePrivateFmQueue } from '@renderer/store/privateFm/action'
import { loadDailyRecommendSongs } from '@renderer/store/dailyRecommend/action'
import {
  EXPLORE_PLAYLIST_LIMIT,
  HOME_RECOMMEND_PLAYLIST_LIMIT,
  HOME_SONG_LIMIT,
  RECOMMEND_CACHE_TTL,
} from './constants'

const CORE_HOME_SECTIONS: LX.Netease.HomeRecommendationParams['sections'] = ['radarPlaylists', 'styleSongs', 'dailySongCategories', 'similarSongs', 'recommendPlaylists']
const CHART_HOME_SECTIONS: LX.Netease.HomeRecommendationParams['sections'] = ['charts']

const recommendPlaylistCache = new Map<string, {
  list: LX.Netease.Playlist[]
  updatedAt: number
}>()

const homeRecommendationCache = new Map<string, {
  data: LX.Netease.HomeRecommendation
  updatedAt: number
}>()

const recommendScrollCache = new Map<string, number>()

export const useRecommendData = ({
  accountKey,
  isExploreMode,
  playlistScrollRef,
  onHomeSongsUpdated,
}: {
  accountKey: ComputedRef<string | null>
  isExploreMode: ComputedRef<boolean>
  playlistScrollRef: { value: HTMLElement | null }
  onHomeSongsUpdated: () => void
}) => {
  const isLoadingPlaylists = ref(false)
  const playlistLoadError = ref('')
  const recommendPlaylists = ref<LX.Netease.Playlist[]>([])
  const homeRecommendation = shallowRef<LX.Netease.HomeRecommendation | null>(null)
  const isRefreshingStyleSongs = ref(false)
  const isRefreshingSimilarSongs = ref(false)
  const isRefreshingRecommendPlaylists = ref(false)

  let activeAccountKey = accountKey.value
  let accountRevision = 0
  let loadRevision = 0

  interface AccountRequestContext {
    accountKey: string | null
    accountRevision: number
    homeRecommendationCacheKey: string
  }

  interface LoadRequestContext extends AccountRequestContext {
    loadRevision: number
    isExploreMode: boolean
    recommendPlaylistCacheKey: string
    scrollCacheKey: string
  }

  const accountCacheKey = computed(() => accountKey.value == null ? 'guest' : `user:${accountKey.value}`)
  const recommendPlaylistCacheKey = computed(() => `${isExploreMode.value ? 'explore' : 'home'}:${accountCacheKey.value}`)
  const homeRecommendationCacheKey = computed(() => {
    const dailySongCategoryTagKeys = appSetting['recommend.dailySongCategoryTagKeys']
    return `${accountCacheKey.value}:${JSON.stringify(dailySongCategoryTagKeys)}`
  })
  const scrollCacheKey = computed(() => {
    return `${recommendPlaylistCacheKey.value}:${homeRecommendationCacheKey.value}`
  })

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

  const saveScrollPosition = () => {
    recommendScrollCache.set(scrollCacheKey.value, playlistScrollRef.value?.scrollTop ?? 0)
  }

  const restoreScrollPosition = async(key = scrollCacheKey.value, context?: LoadRequestContext) => {
    const scrollTop = recommendScrollCache.get(key)
    if (scrollTop == null) return
    await nextTick()
    requestAnimationFrame(() => {
      if (context && !isCurrentRequest(context)) return
      if (playlistScrollRef.value) playlistScrollRef.value.scrollTop = scrollTop
    })
  }

  const hasCoreHomeContent = (data: LX.Netease.HomeRecommendation | null) => {
    return !!(
      data?.radarPlaylists.length ||
      data?.styleSongs.length ||
      data?.dailySongCategoryPlaylists.length ||
      data?.similarSongs.length ||
      data?.recommendPlaylists.length
    )
  }

  const displayedPlaylists = computed(() => recommendPlaylists.value.slice(0, EXPLORE_PLAYLIST_LIMIT))
  const homeRadarPlaylists = computed(() => homeRecommendation.value?.radarPlaylists ?? [])
  const homeStyleSongsTitle = computed(() => homeRecommendation.value?.styleSongsTitle || '多元旋律之旅')
  const homeStyleSongs = computed(() => (homeRecommendation.value?.styleSongs ?? []).slice(0, HOME_SONG_LIMIT))
  const homeDailySongCategoryPlaylists = computed(() => homeRecommendation.value?.dailySongCategoryPlaylists ?? [])
  const homeSimilarSongs = computed(() => (homeRecommendation.value?.similarSongs ?? []).slice(0, HOME_SONG_LIMIT))
  const homeRecommendPlaylists = computed(() => homeRecommendation.value?.recommendPlaylists ?? [])
  const homeCharts = computed(() => homeRecommendation.value?.charts ?? [])
  const hasHomeContent = computed(() => {
    return !!(
      homeRadarPlaylists.value.length ||
      homeStyleSongs.value.length ||
      homeDailySongCategoryPlaylists.value.length ||
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

  const clearVisibleState = () => {
    recommendPlaylists.value = []
    homeRecommendation.value = null
    playlistLoadError.value = ''
    isLoadingPlaylists.value = false
    isRefreshingStyleSongs.value = false
    isRefreshingSimilarSongs.value = false
    isRefreshingRecommendPlaylists.value = false
  }

  const handleAccountChange = () => {
    if (activeAccountKey == accountKey.value) return
    activeAccountKey = accountKey.value
    accountRevision++
    loadRevision++
    clearVisibleState()
  }

  const createAccountRequestContext = (): AccountRequestContext => {
    handleAccountChange()
    return {
      accountKey: accountKey.value,
      accountRevision,
      homeRecommendationCacheKey: homeRecommendationCacheKey.value,
    }
  }

  const createLoadRequestContext = (): LoadRequestContext => {
    const accountContext = createAccountRequestContext()
    return {
      ...accountContext,
      loadRevision: ++loadRevision,
      isExploreMode: isExploreMode.value,
      recommendPlaylistCacheKey: recommendPlaylistCacheKey.value,
      scrollCacheKey: scrollCacheKey.value,
    }
  }

  const isCurrentAccountRequest = (context: AccountRequestContext) => {
    return context.accountKey == accountKey.value && context.accountRevision == accountRevision
  }

  const isCurrentRequest = (context: LoadRequestContext) => {
    return isCurrentAccountRequest(context) && context.loadRevision == loadRevision
  }

  const fetchBaseRecommendPlaylists = async(context: LoadRequestContext, forceRefresh = false) => {
    const cacheKey = context.recommendPlaylistCacheKey
    const cachedList = forceRefresh ? null : getRecommendPlaylistCache(cacheKey)
    if (cachedList) return cachedList

    const list = await getNeteaseRecommendPlaylists(
      context.isExploreMode ? EXPLORE_PLAYLIST_LIMIT : HOME_RECOMMEND_PLAYLIST_LIMIT,
      context.isExploreMode,
    )
    if (isCurrentRequest(context)) setRecommendPlaylistCache(list, cacheKey)
    return list
  }

  const fetchHomeRecommendation = async(
    context: LoadRequestContext,
    forceRefresh = false,
    sections?: LX.Netease.HomeRecommendationParams['sections'],
  ) => {
    const cacheKey = context.homeRecommendationCacheKey
    const isFullHomeRequest = !sections?.length
    const cachedData = isFullHomeRequest && !forceRefresh ? getHomeRecommendationCache(cacheKey) : null
    if (cachedData) return cachedData

    const data = await getNeteaseHomeRecommendation({
      forceRefresh,
      playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
      songLimit: HOME_SONG_LIMIT,
      sections,
    })
    if (isFullHomeRequest && isCurrentRequest(context)) setHomeRecommendationCache(data, cacheKey)
    return data
  }

  const loadRecommendPlaylists = async(forceRefresh = false) => {
    const context = createLoadRequestContext()
    const cachedList = forceRefresh ? null : getRecommendPlaylistCache(context.recommendPlaylistCacheKey)
    const cachedHome = forceRefresh || context.isExploreMode ? null : getHomeRecommendationCache(context.homeRecommendationCacheKey)
    if (cachedList) recommendPlaylists.value = cachedList
    if (cachedHome) homeRecommendation.value = cachedHome
    if (!forceRefresh && (context.isExploreMode ? !!cachedList : hasCoreHomeContent(cachedHome))) {
      await restoreScrollPosition(context.scrollCacheKey, context)
      return
    }

    isLoadingPlaylists.value = true
    playlistLoadError.value = ''

    const errors: any[] = []
    const baseTask = fetchBaseRecommendPlaylists(context, forceRefresh)
      .then(list => {
        if (!isCurrentRequest(context)) return null
        recommendPlaylists.value = list
        return null
      }).catch(err => {
        if (isCurrentRequest(context)) errors.push(err)
        return null
      })

    const homeTask = !context.isExploreMode
      ? fetchHomeRecommendation(context, forceRefresh, CORE_HOME_SECTIONS).then(data => {
        if (!isCurrentRequest(context)) return null
        const didMerge = mergeHomeRecommendation({
          radarPlaylists: data.radarPlaylists,
          styleSongsTitle: data.styleSongsTitle,
          styleSongs: data.styleSongs,
          dailySongCategoryPlaylists: data.dailySongCategoryPlaylists,
          similarSongs: data.similarSongs,
          recommendPlaylists: data.recommendPlaylists,
        }, context)
        if (didMerge) onHomeSongsUpdated()
        return null
      }).catch(err => {
        if (isCurrentRequest(context)) errors.push(err)
        return null
      })
      : Promise.resolve<LX.Netease.HomeRecommendation | null>(null)

    const chartTask = !context.isExploreMode
      ? fetchHomeRecommendation(context, forceRefresh, CHART_HOME_SECTIONS).then(data => {
        if (!isCurrentRequest(context)) return null
        mergeHomeRecommendation({ charts: data.charts }, context)
        return null
      }).catch(err => {
        if (isCurrentRequest(context)) console.warn('Load home charts failed:', err)
        return null
      })
      : Promise.resolve(null)

    const warmupTasks: Array<Promise<unknown>> = []
    if (!context.isExploreMode && isLoggedIn.value) {
      warmupTasks.push(loadDailyRecommendSongs(forceRefresh).catch(err => {
        console.warn('Load daily recommend failed:', err)
      }))
      warmupTasks.push(preparePrivateFmQueue(forceRefresh && !isPrivateFmMode.value).catch(err => {
        console.warn('Load private FM failed:', err)
      }))
    }

    try {
      const blockingTasks: Array<Promise<unknown>> = context.isExploreMode
        ? [baseTask]
        : [homeTask]
      const backgroundTasks = context.isExploreMode
        ? warmupTasks
        : [baseTask, chartTask, ...warmupTasks]

      await Promise.all(blockingTasks)
      void Promise.all(backgroundTasks)
      if (!isCurrentRequest(context)) return
      if (errors.length && (context.isExploreMode ? !recommendPlaylists.value.length : !hasHomeContent.value)) {
        playlistLoadError.value = errors[0]?.message ?? '推荐内容加载失败'
      }
      if (forceRefresh) {
        setTimeout(() => {
          playlistScrollRef.value?.scrollTo({ top: 0 })
        })
      } else {
        await restoreScrollPosition(context.scrollCacheKey, context)
      }
    } finally {
      if (isCurrentRequest(context)) isLoadingPlaylists.value = false
    }
  }

  const mergeHomeRecommendation = (
    partial: Partial<LX.Netease.HomeRecommendation>,
    context: AccountRequestContext,
  ) => {
    if (!isCurrentAccountRequest(context)) return false
    const nextData: LX.Netease.HomeRecommendation = {
      radarPlaylists: homeRecommendation.value?.radarPlaylists ?? [],
      styleSongsTitle: homeRecommendation.value?.styleSongsTitle ?? '',
      styleSongs: homeRecommendation.value?.styleSongs ?? [],
      dailySongCategoryPlaylists: homeRecommendation.value?.dailySongCategoryPlaylists ?? [],
      similarSongs: homeRecommendation.value?.similarSongs ?? [],
      recommendPlaylists: homeRecommendation.value?.recommendPlaylists ?? [],
      charts: homeRecommendation.value?.charts ?? [],
      ...partial,
    }
    homeRecommendation.value = nextData
    setHomeRecommendationCache(nextData, context.homeRecommendationCacheKey)
    return true
  }

  const handleRefreshStyleSongs = async() => {
    if (isRefreshingStyleSongs.value) return
    const context = createAccountRequestContext()
    isRefreshingStyleSongs.value = true
    playlistLoadError.value = ''
    try {
      const data = await getNeteaseHomeRecommendation({
        forceRefresh: true,
        playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
        songLimit: HOME_SONG_LIMIT,
        sections: ['styleSongs'],
      })
      mergeHomeRecommendation({
        styleSongsTitle: data.styleSongsTitle,
        styleSongs: data.styleSongs,
      }, context)
    } catch (err: any) {
      if (isCurrentAccountRequest(context)) playlistLoadError.value = err?.message ?? '风格推荐歌曲刷新失败'
    } finally {
      if (isCurrentAccountRequest(context)) isRefreshingStyleSongs.value = false
    }
  }

  const handleRefreshSimilarSongs = async() => {
    if (isRefreshingSimilarSongs.value) return
    const context = createAccountRequestContext()
    isRefreshingSimilarSongs.value = true
    playlistLoadError.value = ''
    try {
      const data = await getNeteaseHomeRecommendation({
        forceRefresh: true,
        playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
        songLimit: HOME_SONG_LIMIT,
        sections: ['similarSongs'],
      })
      if (mergeHomeRecommendation({ similarSongs: data.similarSongs }, context)) onHomeSongsUpdated()
    } catch (err: any) {
      if (isCurrentAccountRequest(context)) playlistLoadError.value = err?.message ?? '红心相似歌曲刷新失败'
    } finally {
      if (isCurrentAccountRequest(context)) isRefreshingSimilarSongs.value = false
    }
  }

  const handleRefreshRecommendPlaylists = async() => {
    if (isRefreshingRecommendPlaylists.value) return
    const context = createAccountRequestContext()
    isRefreshingRecommendPlaylists.value = true
    playlistLoadError.value = ''
    try {
      const data = await getNeteaseHomeRecommendation({
        forceRefresh: true,
        playlistLimit: HOME_RECOMMEND_PLAYLIST_LIMIT,
        songLimit: HOME_SONG_LIMIT,
        sections: ['recommendPlaylists'],
      })
      mergeHomeRecommendation({ recommendPlaylists: data.recommendPlaylists }, context)
    } catch (err: any) {
      if (isCurrentAccountRequest(context)) playlistLoadError.value = err?.message ?? '推荐歌单刷新失败'
    } finally {
      if (isCurrentAccountRequest(context)) isRefreshingRecommendPlaylists.value = false
    }
  }

  return {
    isLoadingPlaylists,
    playlistLoadError,
    recommendPlaylists,
    displayedPlaylists,
    homeRadarPlaylists,
    homeStyleSongsTitle,
    homeStyleSongs,
    homeDailySongCategoryPlaylists,
    homeSimilarSongs,
    homeRecommendPlaylists,
    homeCharts,
    hasHomeContent,
    playlistNoItemText,
    isRefreshingStyleSongs,
    isRefreshingSimilarSongs,
    isRefreshingRecommendPlaylists,
    loadRecommendPlaylists,
    handleAccountChange,
    handleRefresh: async() => loadRecommendPlaylists(true),
    handleRefreshStyleSongs,
    handleRefreshSimilarSongs,
    handleRefreshRecommendPlaylists,
    saveScrollPosition,
    restoreScrollPosition,
  }
}
