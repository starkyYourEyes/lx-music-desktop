import type { RecentTrackV1 } from '@common/storage/playback'
import { getRecentPlayback } from '@renderer/utils/playback'
import { recentPlayList } from './state'

export const RECENT_PLAY_LIMIT = 520

export const initRecentPlayList = async() => {
  const list = await getRecentPlayback(RECENT_PLAY_LIMIT)
  recentPlayList.splice(0, recentPlayList.length, ...list)
}

export const getRecentPlayablePayload = (row: RecentTrackV1): LX.Music.MusicInfo | null => row.playablePayload
