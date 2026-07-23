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
  }
}
