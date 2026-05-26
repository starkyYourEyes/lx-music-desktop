import { computed, ref, shallowReactive } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { playInfo } from '@renderer/store/player/state'
import { tempListMeta } from '@renderer/store/list/state'

export const DAILY_RECOMMEND_LIST_ID = 'wy_daily_recommend'
export const DAILY_RECOMMEND_TEMP_LIST_ID = `wy__${DAILY_RECOMMEND_LIST_ID}`

export const dailyRecommendSongs = shallowReactive<LX.Music.MusicInfoOnline[]>([])
export const isLoadingDailyRecommend = ref(false)

export const isDailyRecommendPlayingList = computed(() => {
  return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == DAILY_RECOMMEND_TEMP_LIST_ID
})
