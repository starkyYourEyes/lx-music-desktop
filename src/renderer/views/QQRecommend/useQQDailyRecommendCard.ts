import { computed } from '@common/utils/vueTools'
import { QQ_DAILY_RECOMMEND_LIST_ID } from '@renderer/store/qqDailyRecommend/state'
import type { RecommendCard } from '@renderer/views/Recommend/types'

export const useQQDailyRecommendCard = ({
  songs,
  isLoading,
  loadError,
  isLoggedIn,
}: {
  songs: { value: LX.Music.MusicInfo_tx[] }
  isLoading: { value: boolean }
  loadError: { value: string }
  isLoggedIn: { value: boolean }
}) => {
  const card = computed((): RecommendCard => {
    const song = songs.value[0]
    let desc = '登录 QQ 音乐后获取每日30首'
    if (isLoggedIn.value) {
      desc = isLoading.value
        ? '正在加载每日30首...'
        : loadError.value || (song ? `${song.name} · ${song.singer}` : '暂无每日30首推荐')
    }

    return {
      id: QQ_DAILY_RECOMMEND_LIST_ID,
      source: 'tx',
      play_count: '',
      author: song?.singer || 'QQ Music',
      name: '每日30首',
      time: '',
      img: song?.meta.picUrl ?? '',
      desc,
      total: song ? `${songs.value.length}` : '',
      isQQDailyRecommend: true,
    }
  })

  return {
    card,
    getKicker: () => 'Daily 30',
  }
}
