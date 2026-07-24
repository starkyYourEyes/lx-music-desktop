export type RecommendCard = Omit<LX.Netease.Playlist, 'source'> & {
  source: 'wy' | 'tx'
  isPrivateFm?: boolean
  isDailyRecommend?: boolean
  isPrivateRadar?: boolean
  isQQGuessLike?: boolean
  isPlaceholder?: boolean
}
