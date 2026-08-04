import { reactive } from '@common/utils/vueTools'
import type { ListeningStatsV1 } from '@common/storage/playback'

const emptyBucket = () => ({
  baselinePlayedMs: 0,
  livePlayedMs: 0,
  baselineActiveMs: 0,
  liveActiveMs: 0,
  playedMs: 0,
  activeMs: 0,
})

export const listeningTimeStats = reactive<ListeningStatsV1>({
  version: 1,
  total: emptyBucket(),
  daily: [],
  tracks: [],
  updatedAtMs: 0,
})
