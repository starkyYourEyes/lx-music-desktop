import { getListeningPlayback } from '@renderer/utils/playback'
import { listeningTimeStats } from './state'

export const initListeningTimeStats = async() => {
  const stats = await getListeningPlayback()
  listeningTimeStats.version = stats.version
  listeningTimeStats.total = stats.total
  listeningTimeStats.daily = stats.daily
  listeningTimeStats.tracks = stats.tracks
  listeningTimeStats.updatedAtMs = stats.updatedAtMs
}
