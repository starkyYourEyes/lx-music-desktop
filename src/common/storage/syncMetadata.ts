export interface SyncClientServersFileV1 {
  version: 1
  servers: Record<string, LX.Sync.SyncClientProfile>
}

export interface SyncServerDevicesFileV2 {
  version: 2
  userName: string
  clients: Record<string, LX.Sync.SyncServerDevice>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const isSyncProtocolId = (value: unknown): value is LX.Sync.SyncProtocolId =>
  value == 'current' || value == 'legacy'

const isOptionalSyncProtocolId = (value: unknown): value is LX.Sync.SyncProtocolId | undefined =>
  value == null || isSyncProtocolId(value)

const isConnectDate = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= 0

export const normalizeSyncClientProfile = (value: unknown): LX.Sync.SyncClientProfile | null => {
  if (!isRecord(value) || typeof value.clientId != 'string' || value.clientId.length == 0 ||
    typeof value.serverName != 'string' || value.serverName.length == 0 ||
    !isOptionalSyncProtocolId(value.syncProtocol)) return null
  return {
    clientId: value.clientId,
    serverName: value.serverName,
    ...(value.syncProtocol == null ? {} : { syncProtocol: value.syncProtocol }),
  }
}

export const normalizeSyncServerDevice = (value: unknown): LX.Sync.SyncServerDevice | null => {
  if (!isRecord(value) || typeof value.clientId != 'string' || value.clientId.length == 0 ||
    typeof value.deviceName != 'string' || value.deviceName.length == 0 ||
    typeof value.isMobile != 'boolean' || !isOptionalSyncProtocolId(value.syncProtocol)) return null
  const hasLastConnectDate = Object.hasOwn(value, 'lastConnectDate')
  const hasLastSyncDate = Object.hasOwn(value, 'lastSyncDate')
  if ((hasLastConnectDate && !isConnectDate(value.lastConnectDate)) ||
    (hasLastSyncDate && !isConnectDate(value.lastSyncDate))) return null
  const lastConnectDate = hasLastConnectDate
    ? value.lastConnectDate as number
    : hasLastSyncDate ? value.lastSyncDate as number : undefined
  return {
    clientId: value.clientId,
    deviceName: value.deviceName,
    isMobile: value.isMobile,
    ...(lastConnectDate == null ? {} : { lastConnectDate }),
    ...(value.syncProtocol == null ? {} : { syncProtocol: value.syncProtocol }),
  }
}

export const isSyncClientProfile = (value: unknown): value is LX.Sync.SyncClientProfile =>
  normalizeSyncClientProfile(value) != null &&
  Object.keys(value as Record<string, unknown>).every(key => ['clientId', 'serverName', 'syncProtocol'].includes(key))

export const isSyncServerDevice = (value: unknown): value is LX.Sync.SyncServerDevice =>
  normalizeSyncServerDevice(value) != null &&
  Object.keys(value as Record<string, unknown>).every(key =>
    ['clientId', 'deviceName', 'isMobile', 'lastConnectDate', 'syncProtocol'].includes(key),
  )

export const isSyncClientServersFileV1 = (value: unknown): value is SyncClientServersFileV1 =>
  isRecord(value) && value.version == 1 && isRecord(value.servers) &&
  Object.values(value.servers).every(isSyncClientProfile) &&
  Object.keys(value).every(key => ['version', 'servers'].includes(key))

export const isSyncServerDevicesFileV2 = (value: unknown): value is SyncServerDevicesFileV2 =>
  isRecord(value) && value.version == 2 && typeof value.userName == 'string' && isRecord(value.clients) &&
  Object.values(value.clients).every(isSyncServerDevice) &&
  Object.keys(value).every(key => ['version', 'userName', 'clients'].includes(key))
