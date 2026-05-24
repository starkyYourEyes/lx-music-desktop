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
  }
}
