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
import { HOME_SIMILAR_SONGS_TEMP_LIST_ID, HOME_STYLE_SONGS_TEMP_LIST_ID } from './constants'
import { toCloneable } from './utils'
import type { RecommendCard } from './types'

export const useRecommendPlayback = ({
  homeStyleSongs,
  homeSimilarSongs,
  setError,
}: {
  homeStyleSongs: { value: LX.Music.MusicInfoOnline[] }
  homeSimilarSongs: { value: LX.Music.MusicInfoOnline[] }
  setError: (message: string) => void
}) => {
  const route = useRoute()
  const router = useRouter()

  const isPrivateFmPlaying = () => isPrivateFmMode.value && isPlay.value
  const isDailyRecommendPlaying = () => isDailyRecommendPlayingList.value && isPlay.value
  const isSongSectionPlayingList = (tempListId: string) => playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == tempListId
  const isStyleSongsPlayingList = () => isSongSectionPlayingList(HOME_STYLE_SONGS_TEMP_LIST_ID)
  const isHomeSongsPlayingList = () => isSongSectionPlayingList(HOME_SIMILAR_SONGS_TEMP_LIST_ID)
  const isStyleSongsPlaying = () => isStyleSongsPlayingList() && isPlay.value
  const isHomeSongsPlaying = () => isHomeSongsPlayingList() && isPlay.value

  const getPlaylistTempListId = (playlist: LX.Netease.Playlist) => `${playlist.source}__${playlist.id}`

  const isPlaylistPlayingList = (playlist: LX.Netease.Playlist) => {
    return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == getPlaylistTempListId(playlist)
  }

  const isSongSectionSongPlaying = (tempListId: string, song: LX.Music.MusicInfoOnline) => {
    return isSongSectionPlayingList(tempListId) && playMusicInfo.musicInfo?.id == song.id
  }
  const isStyleSongPlaying = (song: LX.Music.MusicInfoOnline) => isSongSectionSongPlaying(HOME_STYLE_SONGS_TEMP_LIST_ID, song)
  const isHomeSongPlaying = (song: LX.Music.MusicInfoOnline) => isSongSectionSongPlaying(HOME_SIMILAR_SONGS_TEMP_LIST_ID, song)

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

  const handleToggleSongSection = async(tempListId: string, songs: { value: LX.Music.MusicInfoOnline[] }) => {
    if (!songs.value.length) return
    if (isSongSectionPlayingList(tempListId)) {
      if (isPlay.value) pause()
      else play()
      return
    }

    await setTempList(tempListId, toCloneable(songs.value))
    playList(LIST_IDS.TEMP, 0)
  }

  const handlePlaySongSection = async(tempListId: string, songs: { value: LX.Music.MusicInfoOnline[] }, index = 0) => {
    if (!songs.value.length) return
    if (isSongSectionPlayingList(tempListId) && playMusicInfo.musicInfo?.id == songs.value[index]?.id) {
      if (isPlay.value) pause()
      else play()
      return
    }

    await setTempList(tempListId, toCloneable(songs.value))
    playList(LIST_IDS.TEMP, Math.min(index, songs.value.length - 1))
  }

  const handleToggleStyleSongs = async() => handleToggleSongSection(HOME_STYLE_SONGS_TEMP_LIST_ID, homeStyleSongs)
  const handleToggleHomeSongs = async() => handleToggleSongSection(HOME_SIMILAR_SONGS_TEMP_LIST_ID, homeSimilarSongs)
  const handlePlayStyleSongs = async(index = 0) => handlePlaySongSection(HOME_STYLE_SONGS_TEMP_LIST_ID, homeStyleSongs, index)
  const handlePlayHomeSongs = async(index = 0) => handlePlaySongSection(HOME_SIMILAR_SONGS_TEMP_LIST_ID, homeSimilarSongs, index)

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
    isStyleSongsPlayingList,
    isHomeSongsPlayingList,
    isStyleSongsPlaying,
    isHomeSongsPlaying,
    isStyleSongPlaying,
    isHomeSongPlaying,
    isCardPlaying,
    getCardPlayLabel,
    getPlaylistPlayLabel,
    handleToggleCardPlay,
    handleTogglePlaylistPlay,
    handleToggleStyleSongs,
    handleToggleHomeSongs,
    handlePlayStyleSongs,
    handlePlayHomeSongs,
    handleOpenPlaylist,
    handleOpenChart,
    handleShowAll,
  }
}
