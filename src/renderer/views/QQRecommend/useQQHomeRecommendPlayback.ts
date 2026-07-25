import { LIST_IDS } from '@common/constants'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { pause, play, playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { isPlay, playInfo, playMusicInfo } from '@renderer/store/player/state'
import { toCloneable } from '@renderer/views/Recommend/utils'
import { playSongListDetail } from '@renderer/views/songList/Detail/action'

export const QQ_HOME_RELATED_TEMP_LIST_ID = 'tx__qq_home_related'

const getPlaylistTempListId = (playlist: LX.QQMusic.RecommendPlaylist) => `tx__${playlist.id}`

export const useQQHomeRecommendPlayback = ({
  relatedSongs,
  setError,
}: {
  relatedSongs: { value: LX.Music.MusicInfo_tx[] }
  setError: (message: string) => void
}) => {
  const route = useRoute()
  const router = useRouter()
  let installedRelatedSignature = ''

  const getRelatedSignature = () => relatedSongs.value.map(song => song.id).join('|')

  const toggleCurrentPlayback = () => {
    if (isPlay.value) pause()
    else play()
  }

  const isPlaylistPlayingList = (playlist: LX.QQMusic.RecommendPlaylist) => {
    return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == getPlaylistTempListId(playlist)
  }

  const openPlaylist = async(playlist: LX.QQMusic.RecommendPlaylist) => {
    try {
      await router.push({
        path: '/songList/detail',
        query: {
          source: 'tx',
          id: playlist.id,
          picUrl: playlist.img,
          fromName: String(route.name || 'QQRecommend'),
        },
      })
    } catch {
      setError('打开歌单失败，请稍后重试')
    }
  }

  const togglePlaylist = async(playlist: LX.QQMusic.RecommendPlaylist) => {
    try {
      if (isPlaylistPlayingList(playlist)) {
        toggleCurrentPlayback()
        return
      }
      await playSongListDetail(playlist.id, 'tx')
    } catch {
      setError('播放歌单失败，请稍后重试')
    }
  }

  const isRelatedListActive = () => {
    return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == QQ_HOME_RELATED_TEMP_LIST_ID
  }

  const isVisibleRelatedListActive = () => {
    return isRelatedListActive() && installedRelatedSignature == getRelatedSignature()
  }

  const isRelatedSongCurrent = (song: LX.Music.MusicInfo_tx) => {
    return isVisibleRelatedListActive() && playMusicInfo.musicInfo?.id == song.id
  }

  const playRelatedSong = async(index: number) => {
    const songs = relatedSongs.value
    const song = songs[index]
    if (!song) return
    try {
      if (isRelatedSongCurrent(song)) {
        toggleCurrentPlayback()
        return
      }
      const signature = getRelatedSignature()
      if (!isRelatedListActive() || installedRelatedSignature != signature) {
        installedRelatedSignature = signature
        await setTempList(QQ_HOME_RELATED_TEMP_LIST_ID, toCloneable(songs))
      }
      playList(LIST_IDS.TEMP, index)
    } catch {
      setError('播放推荐歌曲失败，请稍后重试')
    }
  }

  const toggleRelatedSongs = async() => {
    if (isVisibleRelatedListActive()) {
      toggleCurrentPlayback()
      return
    }
    await playRelatedSong(0)
  }

  return {
    openPlaylist,
    togglePlaylist,
    isPlaylistPlayingList,
    getPlaylistPlayLabel: (playlist: LX.QQMusic.RecommendPlaylist) => {
      return isPlaylistPlayingList(playlist) && isPlay.value ? `暂停 ${playlist.name}` : `播放 ${playlist.name}`
    },
    playRelatedSong,
    toggleRelatedSongs,
    isRelatedSongPlaying: (song: LX.Music.MusicInfo_tx) => isRelatedSongCurrent(song) && isPlay.value,
    isRelatedSongsPlaying: () => isVisibleRelatedListActive() && isPlay.value,
  }
}
