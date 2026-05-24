declare namespace LX {
  namespace Sync {

    interface EnableServer {
      enable: boolean
      port: string
    }
    interface EnableClient {
      enable: boolean
      host: string
      authCode?: string
    }

    interface SyncActionBase <A> {
      action: A
    }
    interface SyncActionData<A, D> extends SyncActionBase<A> {
      data: D
    }
    type SyncAction<A, D = undefined> = D extends undefined ? SyncActionBase<A> : SyncActionData<A, D>


    interface ModeTypes {
      list: LX.Sync.List.SyncMode
      dislike: LX.Sync.Dislike.SyncMode
    }

    type ModeType = { [K in keyof ModeTypes]: { type: K, mode: ModeTypes[K] } }[keyof ModeTypes]

    type SyncMainWindowActions = SyncAction<'select_mode', { deviceName: string, type: keyof ModeTypes }>
    | SyncAction<'close_select_mode'>
    | SyncAction<'client_status', ClientStatus>
    | SyncAction<'server_status', ServerStatus>

    type SyncServiceActions = SyncAction<'select_mode', ModeType>
    | SyncAction<'get_server_status'>
    | SyncAction<'get_client_status'>
    | SyncAction<'generate_code'>
    | SyncAction<'enable_server', EnableServer>
    | SyncAction<'enable_client', EnableClient>

    type ServerDevices = ServerKeyInfo[]

    interface ServerStatus {
      status: boolean
      message: string
      address: string[]
      code: string
      devices: ServerKeyInfo[]
    }

    interface ClientStatus {
      status: boolean
      message: string
      address: string[]
    }

    interface ClientKeyInfo {
      clientId: string
      key: string
      serverName: string
    }

    interface ServerKeyInfo {
      clientId: string
      key: string
      deviceName: string
      lastConnectDate?: number
      isMobile: boolean
    }

    interface ListConfig {
      skipSnapshot: boolean
    }
    interface DislikeConfig {
      skipSnapshot: boolean
    }
    type PartyConfig = Record<string, never>
    type ServerType = 'desktop-app' | 'server'
    interface EnabledFeatures {
      list?: false | ListConfig
      dislike?: false | DislikeConfig
      party?: false | PartyConfig
    }
    type SupportedFeatures = Partial<{ [k in keyof EnabledFeatures]: number }>
  }

  namespace Party {
    type RoomControlMode = 'host' | 'all'

    interface OperatorInfo {
      clientId: string
      userName: string
      deviceName: string
      displayName: string
    }

    interface Member {
      clientId: string
      userName: string
      deviceName: string
      displayName: string
      isHost: boolean
      isOnline: boolean
      isReady: boolean
      isLoading: boolean
      joinedAt: number
      lastSeenAt: number
    }

    interface QueueItem {
      id: string
      musicInfo: LX.Music.MusicInfo
      addedAt: number
      requestedBy: OperatorInfo
    }

    interface QueueItemInput {
      id?: string
      musicInfo: LX.Music.MusicInfo
    }

    interface PlaybackState {
      currentMusic: LX.Music.MusicInfo | null
      currentIndex: number
      queue: QueueItem[]
      playing: boolean
      progress: number
      progressAt: number
      duration: number | null
      rate: number
      version: number
      updatedAt: number
      operator: OperatorInfo | null
    }

    interface PlaybackUpdateInput {
      currentMusic?: LX.Music.MusicInfo | null
      currentIndex?: number
      playing?: boolean
      progress?: number
      progressAt?: number
      duration?: number | null
      rate?: number
      queue?: QueueItemInput[]
    }

    interface RoomSettings {
      controlMode: RoomControlMode
      maxMembers: number
      hasPassword?: boolean
      [key: string]: unknown
    }

    interface RoomSnapshot {
      roomId: string
      roomCode: string
      name: string
      ownerClientId: string
      members: Member[]
      settings: RoomSettings
      playback: PlaybackState
      createdAt: number
      updatedAt: number
    }

    interface RoomSummary {
      roomId: string
      roomCode: string
      name: string
      ownerClientId: string
      ownerName: string
      memberCount: number
      onlineCount: number
      maxMembers: number
      hasPassword: boolean
      controlMode: RoomControlMode
      currentMusic: LX.Music.MusicInfo | null
      playing: boolean
    }

    interface RoomCreateInput {
      name?: string
      roomCode?: string
      password?: string
      controlMode?: RoomControlMode
      maxMembers?: number
      displayName?: string
    }

    interface RoomJoinInput {
      roomId?: string
      roomCode?: string
      password?: string
      displayName?: string
    }

    interface MemberUpdateInput {
      displayName?: string
      isReady?: boolean
      isLoading?: boolean
    }

    type SyncReason =
      | 'initial_sync'
      | 'room_created'
      | 'room_joined'
      | 'room_left'
      | 'room_dismissed'
      | 'room_updated'
      | 'owner_transferred'
      | 'member_updated'
      | 'member_removed'
      | 'member_online'
      | 'member_offline'
      | 'playback_updated'
      | 'queue_updated'
      | 'heartbeat'

    interface SyncAction {
      action: 'party_room_state'
      data: {
        reason: SyncReason
        room: RoomSnapshot | null
      }
    }

    interface StatePayload {
      room: RoomSnapshot | null
      selfClientId: string | null
    }

    type MainWindowActions = LX.Sync.SyncAction<'state', StatePayload>

    type ServiceActions =
      | LX.Sync.SyncAction<'get_state'>
      | LX.Sync.SyncAction<'create_room', RoomCreateInput>
      | LX.Sync.SyncAction<'join_room', RoomJoinInput>
      | LX.Sync.SyncAction<'leave_room'>
      | LX.Sync.SyncAction<'dismiss_room'>
      | LX.Sync.SyncAction<'sync_playback', PlaybackUpdateInput>
      | LX.Sync.SyncAction<'queue_append', QueueItemInput[]>
      | LX.Sync.SyncAction<'queue_remove', string[]>
      | { action: 'ping', data?: MemberUpdateInput }
  }
}
