import { computed } from '@common/utils/vueTools'
import { QQ_GUESS_LIKE_CARD_ID } from '@renderer/views/Recommend/constants'
import type { RecommendCard } from '@renderer/views/Recommend/types'

export const useQQGuessLikeCard = ({
  songs,
  currentSong,
  isLoading,
  loadError,
  isLoggedIn,
}: {
  songs: { value: LX.Music.MusicInfo_tx[] }
  currentSong: { value: LX.Music.MusicInfo_tx | null }
  isLoading: { value: boolean }
  loadError: { value: string }
  isLoggedIn: { value: boolean }
}) => {
  const card = computed((): RecommendCard => {
    const activeSong = currentSong.value
    const previewSong = songs.value[0]
    const song = activeSong ?? previewSong
    const songText = song ? `${song.name} · ${song.singer}` : ''
    let desc = '登录 QQ 音乐后获取猜你喜欢'
    if (isLoggedIn.value) {
      desc = activeSong
        ? songText
        : isLoading.value
          ? '正在从 QQ 音乐加载猜你喜欢...'
          : loadError.value || songText || '暂时没有拿到猜你喜欢'
    }

    return {
      id: QQ_GUESS_LIKE_CARD_ID,
      source: 'tx',
      play_count: '',
      author: song?.singer || 'QQ Music',
      name: '猜你喜欢',
      time: '',
      img: song?.meta.picUrl ?? '',
      desc,
      total: song ? `${songs.value.length}` : '',
      isQQGuessLike: true,
    }
  })

  const getKicker = () => 'QQ Music'

  return {
    card,
    getKicker,
  }
}
