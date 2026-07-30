import { File } from '../../../common/constants_sync'
import fs from 'node:fs'
import path from 'node:path'
import { createAtomicJsonFile } from '@main/storage/atomicJsonFile'
import { exists } from './utils'

interface LegacyServerKeyInfo {
  clientId: string
  deviceName: string
  lastSyncDate?: number
  snapshotKey?: string
  lastConnectDate?: number
  isMobile: boolean
  syncProtocol?: LX.Sync.SyncProtocolId
}

type MetadataDocument =
  | { version: 1, servers: Record<string, LX.Sync.SyncClientProfile> }
  | { version: 2, userName: string, clients: Record<string, LX.Sync.SyncServerDevice> }

const legacyClientKeysJSON = 'syncAuthKey.json'
const legacyDevicesJSON = 'devices.json'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const toSyncProtocolId = (value: unknown): LX.Sync.SyncProtocolId | undefined =>
  value == 'current' || value == 'legacy' ? value as LX.Sync.SyncProtocolId : undefined

const toClientProfile = (value: unknown): LX.Sync.SyncClientProfile | null => {
  if (!isRecord(value) || typeof value.clientId != 'string' || typeof value.serverName != 'string') return null
  const syncProtocol = toSyncProtocolId(value.syncProtocol)
  return {
    clientId: value.clientId,
    serverName: value.serverName,
    ...(syncProtocol == null ? {} : { syncProtocol }),
  }
}

const toServerDevice = (value: unknown): LX.Sync.SyncServerDevice | null => {
  if (!isRecord(value) || typeof value.clientId != 'string' || typeof value.deviceName != 'string' || typeof value.isMobile != 'boolean') return null
  const syncProtocol = toSyncProtocolId(value.syncProtocol)
  return {
    clientId: value.clientId,
    deviceName: value.deviceName,
    isMobile: value.isMobile,
    ...(typeof value.lastConnectDate == 'number'
      ? { lastConnectDate: value.lastConnectDate }
      : typeof value.lastSyncDate == 'number' ? { lastConnectDate: value.lastSyncDate } : {}),
    ...(syncProtocol == null ? {} : { syncProtocol }),
  }
}

const toProfiles = (value: unknown): Record<string, LX.Sync.SyncClientProfile> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([serverId, info]) => {
    const profile = toClientProfile(info)
    return profile == null ? [] : [[serverId, profile]]
  }))
}

const toDevices = (value: unknown): Record<string, LX.Sync.SyncServerDevice> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([clientId, info]) => {
    const device = toServerDevice(info)
    return device == null ? [] : [[clientId, device]]
  }))
}

const isMetadataDocument = (value: unknown): value is MetadataDocument => isRecord(value) &&
  ((value.version == 1 && isRecord(value.servers)) || (value.version == 2 && typeof value.userName == 'string' && isRecord(value.clients)))

const replaceMetadata = async(filePath: string, value: MetadataDocument) => {
  await createAtomicJsonFile<MetadataDocument>({
    filePath,
    validate: isMetadataDocument,
    shouldPreservePrevious: () => false,
    mode: 0o600,
  }).replace(value)
}

const readJson = async(filePath: string): Promise<unknown | null> => {
  if (!await exists(filePath)) return null
  return JSON.parse((await fs.promises.readFile(filePath)).toString())
}

const mergeMissing = <Value>(preferred: Record<string, Value>, fallback: Record<string, Value>): Record<string, Value> => ({
  ...fallback,
  ...preferred,
})

const cutoverExistingMetadata = async(dataPath: string) => {
  const clientPath = path.join(dataPath, File.clientDataPath)
  const serverPath = path.join(dataPath, File.serverDataPath)
  const currentClients = path.join(clientPath, File.syncAuthKeysJSON)
  const currentDevices = path.join(serverPath, File.userDevicesJSON)
  const rootLegacy = await readJson(path.join(dataPath, 'sync.json'))
  const rootProfiles = isRecord(rootLegacy) ? toProfiles(rootLegacy.syncAuthKey) : {}
  const rootDevices = isRecord(rootLegacy) ? toDevices(rootLegacy.clients) : {}

  const hasCurrentClients = await exists(currentClients)
  let hasClientMetadataSource = hasCurrentClients || Object.keys(rootProfiles).length > 0
  let currentProfiles: Record<string, LX.Sync.SyncClientProfile> = {}
  if (hasCurrentClients) {
    const current = await readJson(currentClients)
    if (!isRecord(current) || current.version != 1 || !isRecord(current.servers)) throw new Error('Invalid sync client metadata')
    currentProfiles = toProfiles(current.servers)
  } else {
    const legacyClients = await readJson(path.join(clientPath, legacyClientKeysJSON))
    hasClientMetadataSource ||= legacyClients != null
    currentProfiles = toProfiles(legacyClients)
  }
  const mergedProfiles = mergeMissing(currentProfiles, rootProfiles)
  if (hasClientMetadataSource && (!hasCurrentClients || Object.keys(mergedProfiles).length != Object.keys(currentProfiles).length)) {
    await replaceMetadata(currentClients, { version: 1, servers: mergedProfiles })
  }

  const hasCurrentDevices = await exists(currentDevices)
  let hasDeviceMetadataSource = hasCurrentDevices || Object.keys(rootDevices).length > 0
  let currentUserName = 'default'
  let currentDeviceValues: Record<string, LX.Sync.SyncServerDevice> = {}
  if (hasCurrentDevices) {
    const current = await readJson(currentDevices)
    if (!isRecord(current) || current.version != 2 || typeof current.userName != 'string' || !isRecord(current.clients)) {
      throw new Error('Invalid sync server metadata')
    }
    currentUserName = current.userName
    currentDeviceValues = toDevices(current.clients)
  } else {
    const legacyDevices = await readJson(path.join(serverPath, legacyDevicesJSON))
    hasDeviceMetadataSource ||= legacyDevices != null
    if (isRecord(legacyDevices)) {
      currentUserName = typeof legacyDevices.userName == 'string' ? legacyDevices.userName : 'default'
      currentDeviceValues = toDevices(legacyDevices.clients)
    }
  }
  const mergedDevices = mergeMissing(currentDeviceValues, rootDevices)
  if (hasDeviceMetadataSource && (!hasCurrentDevices || Object.keys(mergedDevices).length != Object.keys(currentDeviceValues).length)) {
    await replaceMetadata(currentDevices, {
      version: 2,
      userName: currentUserName,
      clients: mergedDevices,
    })
  }
}

// Migrate v2 sync data. Credential migration runs first and owns key extraction.
export default async(dataPath: string) => {
  const syncDataPath = path.join(dataPath, 'sync')
  if (await exists(syncDataPath)) {
    await cutoverExistingMetadata(dataPath)
    return
  }
  const oldInfoPath = path.join(dataPath, 'sync.json')
  if (!await exists(oldInfoPath)) return
  const serverSyncDataPath = path.join(dataPath, File.serverDataPath)
  const clientSyncDataPath = path.join(dataPath, File.clientDataPath)

  await fs.promises.mkdir(serverSyncDataPath, { recursive: true })
  await fs.promises.mkdir(clientSyncDataPath, { recursive: true })
  const info = JSON.parse((await fs.promises.readFile(oldInfoPath)).toString())

  const serverInfoPath = path.join(serverSyncDataPath, File.serverInfoJSON)
  const devicesInfoPath = path.join(serverSyncDataPath, File.userDevicesJSON)
  const listDir = path.join(serverSyncDataPath, File.listDir)
  await fs.promises.mkdir(listDir)

  const snapshotInfo = info.snapshotInfo
  delete info.snapshotInfo
  snapshotInfo.clients = {}
  for (const device of Object.values<LegacyServerKeyInfo>(info.clients)) {
    snapshotInfo.clients[device.clientId] = {
      snapshotKey: device.snapshotKey,
      lastSyncDate: device.lastSyncDate,
    }
  }
  await fs.promises.writeFile(serverInfoPath, JSON.stringify({ serverId: info.serverId, version: 2 }))
  await replaceMetadata(devicesInfoPath, {
    version: 2,
    userName: 'default',
    clients: toDevices(info.clients),
  })
  await fs.promises.writeFile(path.join(listDir, File.listSnapshotInfoJSON), JSON.stringify(snapshotInfo))

  const snapshotPath = path.join(listDir, File.listSnapshotDir)
  await fs.promises.mkdir(snapshotPath)
  const snapshots = (await fs.promises.readdir(dataPath)).filter(name => name.startsWith('snapshot_'))
  if (snapshots.length) {
    for (const file of snapshots) {
      await fs.promises.copyFile(path.join(dataPath, file), path.join(snapshotPath, file))
    }
  }

  await replaceMetadata(path.join(clientSyncDataPath, File.syncAuthKeysJSON), {
    version: 1,
    servers: toProfiles(info.syncAuthKey),
  })

  for (const file of snapshots) {
    await fs.promises.unlink(path.join(dataPath, file))
  }
  await fs.promises.unlink(oldInfoPath)
}
