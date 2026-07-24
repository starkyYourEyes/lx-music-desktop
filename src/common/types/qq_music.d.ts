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

    interface GuessLikeRequest {
      continuation?: boolean
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
      featuredPlaylists: RecommendPlaylist[]
      privatePlaylists: RecommendPlaylist[]
      relatedSongTitle: string
      relatedSongGroups: LX.Music.MusicInfo_tx[][]
      guidePlaylists: RecommendPlaylist[]
    }

  }
}
