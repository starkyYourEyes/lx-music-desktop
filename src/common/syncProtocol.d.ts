export interface SyncProtocol {
  readonly id: LX.Sync.SyncProtocolId
  readonly syncDesktopId: string
  readonly syncMobileId: string
  readonly syncAuthPrefix: string
  readonly syncConnectMessage: string
}

export const CURRENT_SYNC_PROTOCOL: Readonly<SyncProtocol>
export const LEGACY_SYNC_PROTOCOL: Readonly<SyncProtocol>
export const SYNC_PROTOCOLS: ReadonlyArray<Readonly<SyncProtocol>>
export function getSyncProtocol(protocolId?: unknown): Readonly<SyncProtocol>
export function getSyncProtocolCandidates(protocolId?: LX.Sync.SyncProtocolId): ReadonlyArray<Readonly<SyncProtocol>>
