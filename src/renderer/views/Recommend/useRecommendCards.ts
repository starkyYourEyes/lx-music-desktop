import { computed } from '@common/utils/vueTools'
import { DAILY_RECOMMEND_TEMP_LIST_ID, dailyRecommendSongs } from '@renderer/store/dailyRecommend/state'
import { privateFmQueue } from '@renderer/store/privateFm/state'
import {
  PRIVATE_FM_CARD_ID,
  PRIVATE_RADAR_PLAYLIST_ID,
  QQ_GUESS_LIKE_CARD_ID,
} from './constants'
import type { RecommendCard } from './types'

interface RecommendCardOptions {
  showQQGuessLike: { value: boolean }
  qqGuessLikeSongs: { value: LX.Music.MusicInfoOnline[] }
  isQQGuessLikeLoading: { value: boolean }
  qqGuessLikeLoadError: { value: string }
}

export const useRecommendCards = (
  recommendPlaylists: { value: LX.Netease.Playlist[] },
  {
    showQQGuessLike,
    qqGuessLikeSongs,
    isQQGuessLikeLoading,
    qqGuessLikeLoadError,
  }: RecommendCardOptions,
) => {
  const firstPrivateFmSong = computed(() => privateFmQueue[0] ?? null)
  const firstDailyRecommendSong = computed(() => dailyRecommendSongs[0] ?? null)

  const dailyRecommendCard = computed((): (LX.Netease.Playlist & { isDailyRecommend: true }) | null => {
    const song = firstDailyRecommendSong.value
    if (!song) return null
    return {
      id: DAILY_RECOMMEND_TEMP_LIST_ID,
      source: 'wy',
      play_count: '',
      author: song.singer,
      name: '每日推荐',
      time: '',
      img: song.meta.picUrl ?? '',
      desc: `从《${song.name}》开始`,
      total: `${dailyRecommendSongs.length}`,
      isDailyRecommend: true,
    }
  })

  const privateFmCard = computed((): (LX.Netease.Playlist & { isPrivateFm: true }) | null => {
    const song = firstPrivateFmSong.value
    if (!song) return null
    return {
      id: PRIVATE_FM_CARD_ID,
      source: 'wy',
      play_count: '',
      author: song.singer,
      name: `从《${song.name}》开始漫游`,
      time: '',
      img: song.meta.picUrl ?? '',
      desc: song.singer || '私人 FM',
      total: '',
      isPrivateFm: true,
    }
  })

  const privateRadarCard = computed((): (LX.Netease.Playlist & { isPrivateRadar: true }) | null => {
    const playlist = recommendPlaylists.value.find(playlist => playlist.id == PRIVATE_RADAR_PLAYLIST_ID)
    if (!playlist) return null
    return {
      ...playlist,
      isPrivateRadar: true,
    }
  })

  const qqGuessLikeCard = computed((): RecommendCard | null => {
    if (!showQQGuessLike.value) return null
    const song = qqGuessLikeSongs.value[0]
    return {
      id: QQ_GUESS_LIKE_CARD_ID,
      source: 'tx',
      play_count: '',
      author: song?.singer || 'QQ Music',
      name: '猜你喜欢',
      time: '',
      img: song?.meta.picUrl ?? '',
      desc: isQQGuessLikeLoading.value
        ? '正在从 QQ 音乐加载猜你喜欢...'
        : qqGuessLikeLoadError.value || song?.name || 'QQ Music',
      total: song ? `${qqGuessLikeSongs.value.length}` : '',
      isQQGuessLike: true,
    }
  })

  const specialCards = computed(() => {
    const result: RecommendCard[] = []
    if (dailyRecommendCard.value) result.push(dailyRecommendCard.value)
    if (privateFmCard.value) result.push(privateFmCard.value)
    if (qqGuessLikeCard.value) result.push(qqGuessLikeCard.value)
    if (privateRadarCard.value) result.push(privateRadarCard.value)
    return result
  })

  const getSpecialCardKicker = (playlist: RecommendCard) => {
    if (playlist.isDailyRecommend) return 'Daily Mix'
    if (playlist.isPrivateFm) return 'Private FM'
    if (playlist.isPrivateRadar) return 'Radar'
    if (playlist.isQQGuessLike) return 'QQ Music'
    return 'Playlist'
  }

  return {
    specialCards,
    getSpecialCardKicker,
  }
}
