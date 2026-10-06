import { computed, shallowRef, watch } from '@common/utils/vueTools'
import { isRecommendationEnabled, useRecommendationPage } from '@renderer/core/features/recommendationAccess'

type QQRadioCardSongKey = 'guessLike' | 'brushMode'

const lastSongs = {
  guessLike: shallowRef<LX.Music.MusicInfo_tx | null>(null),
  brushMode: shallowRef<LX.Music.MusicInfo_tx | null>(null),
}
const accountOwners: Record<QQRadioCardSongKey, string | null> = {
  guessLike: null,
  brushMode: null,
}

export const useQQRadioCardSong = (
  key: QQRadioCardSongKey,
  {
    accountKey,
    currentSong,
  }: {
    accountKey: { value: string | null }
    currentSong: { value: LX.Music.MusicInfo_tx | null }
  },
) => {
  const lastSong = lastSongs[key]

  watch(() => accountKey.value, value => {
    if (accountOwners[key] == value) return
    accountOwners[key] = value
    lastSong.value = null
  }, { immediate: true, flush: 'sync' })

  watch(() => currentSong.value, song => {
    if (song && isRecommendationEnabled('qqRecommend')) lastSong.value = song
  }, { immediate: true, flush: 'sync' })

  useRecommendationPage('qqRecommend', () => { lastSong.value = null })

  return {
    song: computed(() => currentSong.value ?? lastSong.value),
    clear: () => {
      lastSong.value = null
    },
  }
}
