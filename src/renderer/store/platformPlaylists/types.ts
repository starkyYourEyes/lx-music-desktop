export type PlatformPlaylistStatus = 'idle' | 'loading' | 'syncing' | 'ready' | 'partial' | 'unsupported' | 'error'

export interface PlatformPlaylistFailure {
  listId: string
  sourceListId: string
  name: string
  kind: LX.PlatformPlaylistKind
  message: string
  hasCache: boolean
}

export interface PlatformPlaylistGroup {
  provider: LX.PlatformPlaylistProvider
  kind: LX.PlatformPlaylistKind
  accountKey: string | null
  lastAccountKey?: string | null
  status: PlatformPlaylistStatus
  errorMessage?: string
  errorStage?: 'directory' | 'songs'
  failures?: PlatformPlaylistFailure[]
  lastDirectorySuccessAt?: number
  lastSuccessAt?: number
  lists: LX.List.UserListInfo[]
}

export type PlatformPlaylistGroupKey = `${LX.PlatformPlaylistProvider}:${LX.PlatformPlaylistKind}`

export const platformPlaylistGroupKey = (
  provider: LX.PlatformPlaylistProvider,
  kind: LX.PlatformPlaylistKind,
): PlatformPlaylistGroupKey => `${provider}:${kind}`
