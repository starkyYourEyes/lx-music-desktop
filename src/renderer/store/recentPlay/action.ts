import { throttle } from '@common/utils'
import { toRaw } from '@common/utils/vueTools'
import { getRecentPlayList, saveRecentPlayList } from '@renderer/utils/ipc'
import { recentPlayList } from './state'

export const RECENT_PLAY_LIMIT = 520

const createMusicIdentity = (musicInfo: LX.Music.MusicInfo) => `${musicInfo.source}:${musicInfo.id}`

export const createRecentPlayList = (
  list: LX.Music.MusicInfo[],
  musicInfo: LX.Music.MusicInfo,
  limit = RECENT_PLAY_LIMIT,
): LX.Music.MusicInfo[] => {
  const targetIdentity = createMusicIdentity(musicInfo)
  return [
    musicInfo,
    ...list.filter(item => createMusicIdentity(item) != targetIdentity),
  ].slice(0, limit)
}

const saveRecentPlayListThrottle = throttle(() => {
  saveRecentPlayList(recentPlayList)
}, 1000)

export const initRecentPlayList = async() => {
  const list = await getRecentPlayList()
  if (!list?.length) return
  recentPlayList.splice(0, recentPlayList.length, ...list.slice(0, RECENT_PLAY_LIMIT))
}

export const addRecentPlayMusic = (musicInfo: LX.Music.MusicInfo) => {
  const nextList = createRecentPlayList(recentPlayList, toRaw(musicInfo))
  recentPlayList.splice(0, recentPlayList.length, ...nextList)
  saveRecentPlayListThrottle()
}
