import { pause, play } from '@renderer/core/player'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import {
  isQQDailyRecommendListActive,
  playQQDailyRecommend,
} from '@renderer/store/qqDailyRecommend/action'
import { QQ_DAILY_RECOMMEND_LIST_ID } from '@renderer/store/qqDailyRecommend/state'
import { isPlay } from '@renderer/store/player/state'
import type { RecommendCard } from '@renderer/views/Recommend/types'

export const useQQDailyRecommendPlayback = ({
  loadSongs,
  getAccountKey,
  onLoginRequired,
}: {
  loadSongs: () => Promise<LX.Music.MusicInfoOnline[]>
  getAccountKey: () => string | null
  onLoginRequired: () => void
}) => {
  const route = useRoute()
  const router = useRouter()
  let activation: Promise<void> | null = null

  const isPlayingList = () => isQQDailyRecommendListActive(getAccountKey())
  const isPlaying = () => isPlayingList() && isPlay.value

  const start = async(accountKey: string) => {
    const songs = await loadSongs()
    if (!songs.length || getAccountKey() != accountKey) return
    await playQQDailyRecommend(accountKey)
  }

  const handleCardPlay = async(_card: RecommendCard) => {
    const accountKey = getAccountKey()
    if (!accountKey) {
      onLoginRequired()
      return
    }
    if (isPlayingList()) {
      if (isPlay.value) pause()
      else play()
      return
    }
    if (activation) return activation

    const task = start(accountKey)
    activation = task
    try {
      await task
    } finally {
      if (activation == task) activation = null
    }
  }

  const handleCardOpen = async(card: RecommendCard) => {
    if (!getAccountKey()) {
      onLoginRequired()
      return
    }
    await router.push({
      path: '/songList/detail',
      query: {
        source: 'tx',
        id: QQ_DAILY_RECOMMEND_LIST_ID,
        picUrl: card.img,
        fromName: route.name as string,
      },
    })
  }

  return {
    isCardPlaying: (_card: RecommendCard) => isPlaying(),
    getCardPlayLabel: (_card: RecommendCard) => isPlaying() ? '暂停每日30首' : '播放每日30首',
    handleCardPlay,
    handleCardOpen,
  }
}
