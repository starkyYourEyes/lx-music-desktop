declare namespace LX {
  namespace UserApi {
    type UserApiSourceInfoType = 'music'
    type UserApiSourceInfoActions = 'musicUrl' | 'lyric' | 'pic'

    interface GitHubRemoteInfo {
      provider: 'github'
      repository: 'Macrohard0001/lx-ikun-music-sources'
      version: string
      group: string
      path: string
      blobSha: string
      commitSha: string
    }

    interface GitHubImportItem {
      script: string
      remote: GitHubRemoteInfo
    }

    interface GitHubReplaceError {
      message: string
      code?: string
      detail?: string
    }

    type GitHubReplaceResult = {
      success: true
      apiList: UserApiInfo[]
    } | {
      success: false
      apiList?: UserApiInfo[]
      error: GitHubReplaceError
    }

    interface UserApiSourceInfo {
      name: string
      type: UserApiSourceInfoType
      actions: UserApiSourceInfoActions[]
      qualitys: LX.Quality[]
    }

    type UserApiSources = Record<LX.Source, UserApiSourceInfo>


    interface UserApiInfoFull {
      id: string
      name: string
      description: string
      script: string
      allowShowUpdateAlert: boolean
      author?: string
      homepage?: string
      version?: string
      remote?: GitHubRemoteInfo
      sources?: UserApiSources
    }

    type UserApiInfo = Omit<UserApiInfoFull, 'script'>

    interface UserApiStatus {
      status: boolean
      message?: string
      apiInfo?: UserApiInfo
    }

    interface UserApiUpdateInfo {
      name: string
      description: string
      log: string
      updateUrl?: string
    }

    interface UserApiRequestParams {
      requestKey: string
      data: any
    }
    type UserApiRequestCancelParams = string
    type UserApiSetApiParams = string

    interface UserApiSetAllowUpdateAlertParams {
      id: string
      enable: boolean
    }

    interface ImportUserApi {
      apiInfo: UserApiInfo
      apiList: UserApiInfo[]
    }

  }
}
