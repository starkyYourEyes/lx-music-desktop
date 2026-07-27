declare namespace LX {
  namespace QQMusic {
    interface Profile {
      uin: string
      nickname: string
    }

    interface AccountStatus {
      isLoggedIn: boolean
      profile: Profile | null
    }

    interface LoginQr {
      key: string
      qrimg: string
    }

    type LoginQrState = 'waiting' | 'scanned' | 'expired' | 'success'

    interface LoginQrCheck extends AccountStatus {
      state: LoginQrState
      message: string
    }

    type GuessLikeApiVersion = 'new' | 'legacy'
    type RadioMode = 'guessLike' | 'brush'

    interface GuessLikeRequest {
      continuation?: boolean
      apiVersion?: GuessLikeApiVersion
      radioMode?: RadioMode
    }

    interface BrushMode {
      id: '99'
      title: string
      description: string
    }

    interface RecommendPlaylist {
      id: string
      source: 'tx'
      name: string
      img: string
      description: string
      author: string
      playCount: string
    }

    interface HomeRecommendation {
      title: string
      brushMode: BrushMode | null
      featuredPlaylists: RecommendPlaylist[]
      privatePlaylists: RecommendPlaylist[]
      relatedSongTitle: string
      relatedSongGroups: LX.Music.MusicInfo_tx[][]
      guidePlaylists: RecommendPlaylist[]
    }

    interface PlaylistDetailInfo {
      list: LX.Music.MusicInfo_tx[]
      source: 'tx'
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

    interface PlaylistDetailParams {
      id: string
      page: number
    }

  }
}
