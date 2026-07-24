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
  getAccountRevision = () => 0,
  onLoginRequired,
}: {
  loadSongs: () => Promise<LX.Music.MusicInfoOnline[]>
  getAccountKey: () => string | null
  getAccountRevision?: () => number
  onLoginRequired: () => void
}) => {
  let activation: { accountKey: string, accountRevision: number, task: Promise<void> } | null = null

  const isPlayingList = () => isQQGuessLikeListActive(getAccountKey())
  const isPlaying = () => isPlayingList() && isPlay.value

  const start = async(accountKey: string, accountRevision: number) => {
    const songs = await loadSongs()
    if (!songs.length || getAccountKey() != accountKey || getAccountRevision() != accountRevision) return
    await enterQQGuessLikeMode(accountKey)
  }

  const toggle = async() => {
    const accountKey = getAccountKey()
    const accountRevision = getAccountRevision()
    if (!accountKey) {
      onLoginRequired()
      return
    }
    if (isPlayingList()) {
      if (isPlay.value) pause()
      else play()
      return
    }
    if (activation?.accountKey == accountKey && activation.accountRevision == accountRevision) return activation.task

    const task = start(accountKey, accountRevision)
    const currentActivation = { accountKey, accountRevision, task }
    activation = currentActivation
    try {
      await task
    } finally {
      if (activation == currentActivation) activation = null
    }
  }

  return {
    isCardPlaying: (_card: RecommendCard) => isPlaying(),
    getCardPlayLabel: (_card: RecommendCard) => isPlaying() ? '暂停猜你喜欢' : '播放猜你喜欢',
    handleCardAction: async(_card: RecommendCard) => toggle(),
  }
}
