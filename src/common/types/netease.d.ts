declare namespace LX {
  namespace Netease {
    interface Profile {
      userId: number
      nickname: string
      avatarUrl: string
      backgroundUrl?: string
      signature?: string
    }

    interface AccountStatus {
      isLoggedIn: boolean
      profile: Profile | null
    }

    interface LoginQr {
      key: string
      qrurl: string
      qrimg: string
    }

    interface LoginQrCheck {
      code: number
      message?: string
      isLoggedIn: boolean
      profile: Profile | null
    }

    interface MusicUrlParams {
      musicInfo: LX.Music.MusicInfo
      quality: LX.Quality
    }

    interface PrivateFmTrashParams {
      musicInfo: LX.Music.MusicInfo
      time?: number
    }

    interface PlaylistDetailParams {
      id: string
      page?: number
    }

    interface HomeRecommendationParams {
      forceRefresh?: boolean
      playlistLimit?: number
      songLimit?: number
    }

    type PrivateFmModeId = 'DEFAULT' | 'FAMILIAR' | 'EXPLORE' | 'EXERCISE' | 'FOCUS' | 'NIGHT_EMO'

    interface PrivateFmParams {
      mode?: PrivateFmModeId
      limit?: number
    }

    interface Playlist {
      play_count: string
      id: string
      author: string
      name: string
      time?: string
      img: string
      desc: string | null
      source: 'wy'
      total?: string
    }

    interface HomeChartSong {
      name: string
      singer: string
    }

    interface HomeChart {
      id: string
      name: string
      img: string
      desc: string | null
      play_count: string
      updateFrequency: string
      source: 'wy'
      isSales?: boolean
      songs: HomeChartSong[]
    }

    interface HomeRecommendation {
      radarPlaylists: Playlist[]
      similarSongs: LX.Music.MusicInfoOnline[]
      recommendPlaylists: Playlist[]
      charts: HomeChart[]
    }

    interface PlaylistDetailInfo {
      list: LX.Music.MusicInfoOnline[]
      source: 'wy'
      desc: string | null
      total: number
      page: number
      limit: number
      key: string | null
      id: string
      info: {
        name?: string
        img?: string
        desc?: string | null
        author?: string
        play_count?: string
      }
      noItemLabel: string
    }
  }
}
