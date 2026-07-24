import { ref, shallowReactive } from '@common/utils/vueTools'
import { LIST_IDS } from '@common/constants'
import { playInfo } from '@renderer/store/player/state'
import { tempListMeta } from '@renderer/store/list/state'

export const QQ_DAILY_RECOMMEND_LIST_ID = 'qq_daily_30'
export const QQ_DAILY_RECOMMEND_TEMP_LIST_ID = `tx__${QQ_DAILY_RECOMMEND_LIST_ID}`

export const qqDailyRecommendSongs = shallowReactive<LX.Music.MusicInfo_tx[]>([])
export const qqDailyRecommendOwnerAccountKey = ref<string | null>(null)
export const qqDailyRecommendGeneration = ref(0)
export const isLoadingQQDailyRecommend = ref(false)

export const isQQDailyRecommendPlayingList = () => {
  return playInfo.playerListId == LIST_IDS.TEMP &&
    tempListMeta.id == QQ_DAILY_RECOMMEND_TEMP_LIST_ID
}
