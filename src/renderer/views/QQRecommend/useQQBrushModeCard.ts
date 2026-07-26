import { computed } from '@common/utils/vueTools'
import { QQ_BRUSH_MODE_CARD_ID } from '@renderer/views/Recommend/constants'
import type { RecommendCard } from '@renderer/views/Recommend/types'

export const useQQBrushModeCard = ({
  descriptor,
  songs,
  currentSong,
  isLoading,
  loadError,
  fallbackImg,
}: {
  descriptor: { value: LX.QQMusic.BrushMode | null }
  songs: { value: LX.Music.MusicInfo_tx[] }
  currentSong: { value: LX.Music.MusicInfo_tx | null }
  isLoading: { value: boolean }
  loadError: { value: string }
  fallbackImg: { value: string }
}) => {
  const card = computed((): RecommendCard => {
    const activeSong = currentSong.value
    const previewSong = songs.value[0]
    const song = activeSong ?? previewSong
    const songText = song ? `${song.name} · ${song.singer}` : ''
    const author = song?.singer ? song.singer : 'QQ Music'
    const img = song?.meta.picUrl ? song.meta.picUrl : fallbackImg.value
    let desc = descriptor.value?.description ?? '猜你喜欢，一首接一首'
    if (songText) desc = songText
    if (loadError.value) desc = loadError.value
    if (isLoading.value) desc = '正在准备下一首推荐...'
    if (activeSong) desc = songText

    return {
      id: QQ_BRUSH_MODE_CARD_ID,
      source: 'tx',
      play_count: '',
      author,
      name: descriptor.value?.title ?? '刷歌模式',
      time: '',
      img,
      desc,
      total: song ? String(songs.value.length) : '',
      isQQBrushMode: true,
    }
  })

  return {
    card,
    getKicker: () => '沉浸推荐',
  }
}
