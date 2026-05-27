import { LIST_IDS } from '@common/constants'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { isPlay, playInfo, playMusicInfo } from '@renderer/store/player/state'
import { tempListMeta } from '@renderer/store/list/state'
import { setTempList } from '@renderer/store/list/action'
import { enterPrivateFmMode } from '@renderer/store/privateFm/action'
import { isLoadingPrivateFm, isPrivateFmMode } from '@renderer/store/privateFm/state'
import { playDailyRecommend } from '@renderer/store/dailyRecommend/action'
import { isDailyRecommendPlayingList, isLoadingDailyRecommend } from '@renderer/store/dailyRecommend/state'
import { pause, play, playList } from '@renderer/core/player'
import { playSongListDetail } from '@renderer/views/songList/Detail/action'
import { HOME_SIMILAR_SONGS_TEMP_LIST_ID } from './constants'
import { toCloneable } from './utils'
import type { RecommendCard } from './types'

export const useRecommendPlayback = ({
  homeSimilarSongs,
  setError,
}: {
  homeSimilarSongs: { value: LX.Music.MusicInfoOnline[] }
  setError: (message: string) => void
}) => {
  const route = useRoute()
  const router = useRouter()

  const isPrivateFmPlaying = () => isPrivateFmMode.value && isPlay.value
  const isDailyRecommendPlaying = () => isDailyRecommendPlayingList.value && isPlay.value
  const isHomeSongsPlayingList = () => playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == HOME_SIMILAR_SONGS_TEMP_LIST_ID

  const getPlaylistTempListId = (playlist: LX.Netease.Playlist) => `${playlist.source}__${playlist.id}`

  const isPlaylistPlayingList = (playlist: LX.Netease.Playlist) => {
    return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == getPlaylistTempListId(playlist)
  }

  const isHomeSongPlaying = (song: LX.Music.MusicInfoOnline) => {
    return isHomeSongsPlayingList() && playMusicInfo.musicInfo?.id == song.id
  }

  const handleToggleDailyRecommend = async() => {
    if (isDailyRecommendPlaying()) {
      pause()
      return
    }
    if (isDailyRecommendPlayingList.value) {
      play()
      return
    }
    if (isLoadingDailyRecommend.value) return
    try {
      await playDailyRecommend()
    } catch (err: any) {
      setError(err?.message ?? '每日推荐加载失败')
    }
  }

  const handleTogglePrivateFm = async() => {
    if (isPrivateFmPlaying()) {
      pause()
      return
    }
    if (isPrivateFmMode.value) {
      play()
      return
    }
    if (isLoadingPrivateFm.value) return
    try {
      await enterPrivateFmMode()
    } catch (err: any) {
      setError(err?.message ?? '私人 FM 加载失败')
    }
  }

  const handleTogglePrivateRadar = async(playlist: LX.Netease.Playlist) => {
    if (isPlaylistPlayingList(playlist)) {
      if (isPlay.value) pause()
      else play()
      return
    }
    try {
      await playSongListDetail(playlist.id, playlist.source)
    } catch (err: any) {
      setError(err?.message ?? '私人雷达加载失败')
    }
  }

  const handleTogglePlaylistPlay = async(playlist: LX.Netease.Playlist) => {
    if (isPlaylistPlayingList(playlist)) {
      if (isPlay.value) pause()
      else play()
      return
    }
    try {
      await playSongListDetail(playlist.id, playlist.source)
    } catch (err: any) {
      setError(err?.message ?? '歌单加载失败')
    }
  }

  const handlePlayHomeSongs = async(index = 0) => {
    if (!homeSimilarSongs.value.length) return
    if (isHomeSongsPlayingList() && playMusicInfo.musicInfo?.id == homeSimilarSongs.value[index]?.id) {
      if (isPlay.value) pause()
      else play()
      return
    }

    await setTempList(HOME_SIMILAR_SONGS_TEMP_LIST_ID, toCloneable(homeSimilarSongs.value))
    playList(LIST_IDS.TEMP, Math.min(index, homeSimilarSongs.value.length - 1))
  }

  const handleOpenPlaylist = (playlist: RecommendCard | LX.Netease.Playlist) => {
    if ('isPlaceholder' in playlist && playlist.isPlaceholder) return
    if ('isPrivateFm' in playlist && playlist.isPrivateFm) {
      void handleTogglePrivateFm()
      return
    }
    void router.push({
      path: '/songList/detail',
      query: {
        source: playlist.source,
        id: playlist.id,
        picUrl: playlist.img,
        fromName: route.name as string,
      },
    })
  }

  const handleOpenChart = (chart: LX.Netease.HomeChart) => {
    if (chart.isSales) return
    void router.push({
      path: '/songList/detail',
      query: {
        source: chart.source,
        id: chart.id,
        picUrl: chart.img,
        fromName: route.name as string,
      },
    })
  }

  const isCardPlaying = (playlist: RecommendCard) => {
    if (playlist.isPrivateFm) return isPrivateFmPlaying()
    if (playlist.isDailyRecommend) return isDailyRecommendPlaying()
    if (playlist.isPrivateRadar) return isPlaylistPlayingList(playlist) && isPlay.value
    return false
  }

  const getCardPlayLabel = (playlist: RecommendCard) => {
    if (playlist.isPrivateFm) return isPrivateFmPlaying() ? '暂停私人 FM' : '播放私人 FM'
    if (playlist.isDailyRecommend) return isDailyRecommendPlaying() ? '暂停每日推荐' : '播放每日推荐'
    if (playlist.isPrivateRadar) return isCardPlaying(playlist) ? '暂停私人雷达' : '播放私人雷达'
    return '播放'
  }

  const getPlaylistPlayLabel = (playlist: LX.Netease.Playlist) => {
    return isPlaylistPlayingList(playlist) && isPlay.value ? `暂停 ${playlist.name}` : `播放 ${playlist.name}`
  }

  const handleToggleCardPlay = (playlist: RecommendCard) => {
    if (playlist.isPrivateFm) {
      void handleTogglePrivateFm()
      return
    }
    if (playlist.isDailyRecommend) {
      void handleToggleDailyRecommend()
      return
    }
    if (playlist.isPrivateRadar) {
      void handleTogglePrivateRadar(playlist)
    }
  }

  const handleShowAll = () => {
    void router.push({
      path: '/recommend',
      query: {
        category: 'playlists',
      },
    })
  }

  return {
    isPlaylistPlayingList,
    isHomeSongPlaying,
    isCardPlaying,
    getCardPlayLabel,
    getPlaylistPlayLabel,
    handleToggleCardPlay,
    handleTogglePlaylistPlay,
    handlePlayHomeSongs,
    handleOpenPlaylist,
    handleOpenChart,
    handleShowAll,
  }
}
