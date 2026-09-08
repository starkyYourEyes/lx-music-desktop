import { LIST_IDS } from '@common/constants'
import { useRoute, useRouter } from '@common/utils/vueRouter'
import { useI18n } from '@root/lang'
import { pause, play, playList } from '@renderer/core/player'
import { setTempList } from '@renderer/store/list/action'
import { tempListMeta } from '@renderer/store/list/state'
import { isPlay, playInfo, playMusicInfo } from '@renderer/store/player/state'
import { toCloneable } from '@renderer/views/Recommend/utils'
import { playSongListDetail } from '@renderer/views/songList/Detail/action'

type SectionName = 'public' | 'daily' | 'style' | 'fm'

const sectionTempListIds: Record<SectionName, string> = {
  public: 'kg__recommend_rank',
  daily: 'kg__daily_recommend',
  style: 'kg__style_recommend',
  fm: 'kg__private_fm',
}

const sectionNameKeys = {
  public: 'kugou_recommend_rank_title',
  daily: 'kugou_recommend_daily_title',
  style: 'kugou_recommend_style_title',
  fm: 'kugou_recommend_fm_title',
} as const

const getPlaylistTempListId = (playlist: LX.KuGouMusic.RecommendPlaylist) => `kg__${playlist.id}`

export const useKugouRecommendPlayback = ({
  publicSongs,
  dailySongs,
  styleSongs,
  fmSongs,
  setError,
}: {
  publicSongs: { value: LX.Music.MusicInfo_kg[] }
  dailySongs: { value: LX.Music.MusicInfo_kg[] }
  styleSongs: { value: LX.Music.MusicInfo_kg[] }
  fmSongs: { value: LX.Music.MusicInfo_kg[] }
  setError: (message: string) => void
}) => {
  const route = useRoute()
  const router = useRouter()
  const t = useI18n()
  const installedSignatures = new Map<SectionName, string>()
  const getSectionName = (name: SectionName) => t(sectionNameKeys[name])

  const getSongs = (name: SectionName) => {
    return ({ public: publicSongs, daily: dailySongs, style: styleSongs, fm: fmSongs })[name].value
  }
  const getSignature = (songs: LX.Music.MusicInfo_kg[]) => songs.map(song => `${song.id}:${song.meta.hash}`).join('|')
  const toggleCurrentPlayback = () => {
    if (isPlay.value) pause()
    else play()
  }
  const isSectionListActive = (name: SectionName) => {
    return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == sectionTempListIds[name]
  }
  const isVisibleSectionActive = (name: SectionName) => {
    return isSectionListActive(name) && installedSignatures.get(name) == getSignature(getSongs(name))
  }

  const installSection = async(name: SectionName) => {
    const songs = getSongs(name)
    const signature = getSignature(songs)
    if (isSectionListActive(name) && installedSignatures.get(name) == signature) return signature
    await setTempList(sectionTempListIds[name], toCloneable(songs))
    return signature
  }

  const playSection = async(name: SectionName) => {
    const songs = getSongs(name)
    if (!songs.length) return
    try {
      if (isVisibleSectionActive(name)) {
        toggleCurrentPlayback()
        return
      }
      const signature = await installSection(name)
      playList(LIST_IDS.TEMP, 0)
      installedSignatures.set(name, signature)
    } catch {
      setError(t('kugou_recommend_playback_section_error', { name: getSectionName(name) }))
    }
  }

  const playSong = async(name: SectionName, index: number) => {
    const songs = getSongs(name)
    const song = songs[index]
    if (!song) return
    try {
      if (isVisibleSectionActive(name) && playMusicInfo.musicInfo?.id == song.id) {
        toggleCurrentPlayback()
        return
      }
      const signature = await installSection(name)
      playList(LIST_IDS.TEMP, index)
      installedSignatures.set(name, signature)
    } catch {
      setError(t('kugou_recommend_playback_section_error', { name: getSectionName(name) }))
    }
  }

  const isSectionPlaying = (name: SectionName) => isVisibleSectionActive(name) && isPlay.value
  const isSongPlaying = (song: LX.Music.MusicInfo_kg) => {
    return isPlay.value && playMusicInfo.musicInfo?.id == song.id &&
      (Object.keys(sectionTempListIds) as SectionName[]).some(name => isVisibleSectionActive(name))
  }
  const isPlaylistPlaying = (playlist: LX.KuGouMusic.RecommendPlaylist) => {
    return playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == getPlaylistTempListId(playlist) && isPlay.value
  }

  const openPlaylist = async(playlist: LX.KuGouMusic.RecommendPlaylist) => {
    try {
      await router.push({
        path: '/songList/detail',
        query: {
          source: 'kg',
          id: playlist.id,
          picUrl: playlist.img,
          fromName: String(route.name || 'KugouRecommend'),
        },
      })
    } catch {
      setError(t('kugou_recommend_open_playlist_error'))
    }
  }

  const togglePlaylist = async(playlist: LX.KuGouMusic.RecommendPlaylist) => {
    try {
      if (playInfo.playerListId == LIST_IDS.TEMP && tempListMeta.id == getPlaylistTempListId(playlist)) {
        toggleCurrentPlayback()
        return
      }
      await playSongListDetail(playlist.id, 'kg')
    } catch {
      setError(t('kugou_recommend_playback_playlist_error'))
    }
  }

  const getSectionPlayLabel = (name: SectionName) => {
    return isSectionPlaying(name)
      ? t('kugou_recommend_pause_section', { name: getSectionName(name) })
      : t('kugou_recommend_play_section', { name: getSectionName(name) })
  }
  const getPlaylistPlayLabel = (playlist: LX.KuGouMusic.RecommendPlaylist) => {
    return isPlaylistPlaying(playlist)
      ? t('kugou_recommend_pause_playlist', { name: playlist.name })
      : t('kugou_recommend_play_playlist', { name: playlist.name })
  }

  return {
    playSection,
    playSong,
    isSectionPlaying,
    isSongPlaying,
    isPlaylistPlaying,
    openPlaylist,
    togglePlaylist,
    getSectionPlayLabel,
    getPlaylistPlayLabel,
  }
}
