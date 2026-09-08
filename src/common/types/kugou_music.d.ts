declare namespace LX {
  namespace KuGouMusic {
    interface Profile { userId: string, nickname: string, avatarUrl?: string }
    interface AccountStatus { isLoggedIn: boolean, profile: Profile | null, unavailableReason?: 'credential_undecryptable' }
    interface LoginQr { requestId: string, image: string }
    interface LoginQrCheck extends AccountStatus {
      code: number
      state: 'waiting' | 'scanned' | 'expired' | 'success'
      message?: string
    }
    interface RecommendPlaylist { id: string, source: 'kg', name: string, img: string, description: string, author: string, playCount: string }
    interface Rank { id: string, source: 'kg', name: string, img: string, description: string, songs: LX.Music.MusicInfo_kg[] }
    interface PublicRecommendation { playlists: RecommendPlaylist[], ranks: Rank[] }
    interface RankRecommendation { rank: Rank | null, songs: LX.Music.MusicInfo_kg[] }
    interface HomeRecommendation { playlists: RecommendPlaylist[], ranks: Rank[], songs: LX.Music.MusicInfo_kg[] }
    interface PrivateRecommendation { dailySongs: LX.Music.MusicInfo_kg[], styleSongs: LX.Music.MusicInfo_kg[], fmSongs: LX.Music.MusicInfo_kg[] }
  }
}
