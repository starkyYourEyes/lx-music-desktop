import { pause, play } from '@renderer/core/player'
import {
  enterQQGuessLikeMode,
  isQQGuessLikeListActive,
} from '@renderer/store/qqGuessLike/action'
import { isPlay } from '@renderer/store/player/state'
import type { RecommendCard } from '@renderer/views/Recommend/types'

export const useQQGuessLikePlayback = ({
  loadSongs,
  getAccountKey,
  onLoginRequired,
}: {
  loadSongs: () => Promise<LX.Music.MusicInfoOnline[]>
  getAccountKey: () => string | null
  onLoginRequired: () => void
}) => {
  let activation: {
    accountKey: string
    token: symbol
    task: Promise<void>
  } | null = null

  const isPlayingList = () => isQQGuessLikeListActive(getAccountKey())
  const isPlaying = () => isPlayingList() && isPlay.value

  const start = async(accountKey: string, token: symbol) => {
    const songs = await loadSongs()
    if (!songs.length || getAccountKey() != accountKey || activation?.token != token) return
    await enterQQGuessLikeMode(accountKey)
  }

  const toggle = async() => {
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
    if (activation?.accountKey == accountKey) return activation.task

    const token = Symbol('qq-guess-like-activation')
    const task = start(accountKey, token)
    activation = { accountKey, token, task }
    try {
      await task
    } finally {
      if (activation?.token == token) activation = null
    }
  }

  return {
    isCardPlaying: (_card: RecommendCard) => isPlaying(),
    getCardPlayLabel: (_card: RecommendCard) => isPlaying() ? '暂停猜你喜欢' : '播放猜你喜欢',
    handleCardAction: async(_card: RecommendCard) => toggle(),
  }
}
