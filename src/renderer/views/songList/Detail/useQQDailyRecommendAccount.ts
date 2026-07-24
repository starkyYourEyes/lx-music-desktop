import { computed, watch } from '@common/utils/vueTools'
import { QQ_DAILY_RECOMMEND_LIST_ID } from '@renderer/store/qqDailyRecommend/state'

export const useQQDailyRecommendDetailAccount = ({
  accountKey,
  source,
  id,
  page,
  refresh,
  clear,
  reload,
}: {
  accountKey: { value: string | null }
  source: { value: LX.OnlineSource }
  id: { value: string }
  page: { value: number }
  refresh: { value: boolean }
  clear: () => void
  reload: (source: LX.OnlineSource, id: string, page: number, refresh: boolean) => void | Promise<void>
}) => {
  watch(accountKey, (value, oldValue) => {
    if (value == oldValue || source.value != 'tx' || id.value != QQ_DAILY_RECOMMEND_LIST_ID) return
    clear()
    void reload(source.value, id.value, page.value, refresh.value)
  })
}

export const useQQDailyRecommendDetailCover = ({
  source,
  id,
  picUrl,
  detailImg,
}: {
  source: { value: LX.OnlineSource }
  id: { value: string }
  picUrl: { value: string }
  detailImg: { value: string | undefined }
}) => computed(() => {
  if (source.value == 'tx' && id.value == QQ_DAILY_RECOMMEND_LIST_ID) return detailImg.value ?? ''
  return picUrl.value ? picUrl.value : detailImg.value ?? ''
})
