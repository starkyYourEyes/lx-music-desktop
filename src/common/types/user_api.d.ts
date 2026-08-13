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

    interface GitHubReplaceSuccess {
      apiList: UserApiInfo[]
      skipped: string[]
    }

    type GitHubReplaceResult = ({
      success: true
    } & GitHubReplaceSuccess) | {
      success: false
      apiList?: UserApiInfo[]
      error: GitHubReplaceError
    }

    type UserApiRemoveResult = {
      success: true
      apiList: UserApiInfo[]
    } | {
      success: false
      apiList: UserApiInfo[]
      error: GitHubReplaceError
    }

    interface UserApiSourceInfo {
      name: string
      type: UserApiSourceInfoType
      actions: UserApiSourceInfoActions[]
      qualitys: LX.Quality[]
    }

    type UserApiSources = Partial<Record<LX.Source, UserApiSourceInfo>>


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
      apiId: string
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

    interface SourceUserApiRequestParams {
      apiId: string
      requestId: string
      data: any
    }
    type UserApiRequestParams = SourceUserApiRequestParams
    interface SourceUserApiRequestCancelParams {
      apiId: string
      requestId: string
      reason?: 'cancelled' | 'timeout'
    }
    type UserApiRequestCancelParams = SourceUserApiRequestCancelParams
    interface UserApiRuntimeIdentity {
      apiId: string
      generation: number
    }
    interface UserApiRuntimeLeaseParams {
      apiIds: string[]
      leaseId: string
    }
    type UserApiGetStatusParams = string
    type UserApiEnsureParams = string
    type UserApiRequestResult<T = any> =
      | { ok: true, value: T }
      | { ok: false, error: LX.Playback.SourceFailureData }
    interface MusicUrlResponseData {
      source: LX.Source
      type: LX.Quality
      url: string
      persistentCache: false
    }
    type UserApiEnsureResult =
      | { ok: true, value: UserApiStatus }
      | { ok: false, error: LX.Playback.SourceFailureData }

    interface UserApiRuntimeEnvelope<T> {
      identity: UserApiRuntimeIdentity
      status: boolean
      message?: string
      code?: string
      statusCode?: number
      data: T
    }
    type UserApiRuntimeInitEnvelope = UserApiRuntimeEnvelope<{
      sources: UserApiSources
    }>
    type UserApiRuntimeResponseEnvelope<T = any> = UserApiRuntimeEnvelope<{
      requestId: string
      result?: T
    }>
    type UserApiRuntimeUpdateAlertEnvelope = UserApiRuntimeEnvelope<{
      log: string
      updateUrl?: string
    }>
    type UserApiRuntimeControlEnvelope = UserApiRuntimeEnvelope<undefined>
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
