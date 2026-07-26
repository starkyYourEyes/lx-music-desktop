declare namespace LX {
  namespace Sync {
    namespace UserApi {
      interface ApiInfo {
        id: string
        name: string
        description: string
        author: string
        homepage: string
        version: string
        allowShowUpdateAlert?: boolean
        remote?: LX.UserApi.GitHubRemoteInfo
        script: string
        scriptEncoding: 'plain'
      }

      interface Data {
        source: 'desktop'
        updatedAt: number
        apis: ApiInfo[]
      }

      type SyncMode = 'merge' | 'overwrite'

      interface Meta {
        md5: string
        updatedAt: number
        count: number
      }

      type ActionList =
        LX.Sync.SyncAction<'user_api_data_changed', Meta>
    }
  }
}
