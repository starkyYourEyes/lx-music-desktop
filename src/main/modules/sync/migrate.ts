import { File } from '../../../common/constants_sync'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import fs from 'node:fs'
import path from 'node:path'
import { createAtomicJsonFile } from '@main/storage/atomicJsonFile'
import { getCredentialVault } from '@main/storage/credentials'
import { assertSyncKeyCredential, type CredentialRef, type SyncKeyPayloadV1 } from '@main/storage/credentials/types'
import { exists } from './utils'

interface LegacyServerKeyInfo {
  clientId: string
  deviceName: string
  lastSyncDate?: number
  snapshotKey?: string
  lastConnectDate?: number
  isMobile: boolean
  syncProtocol?: LX.Sync.SyncProtocolId
  key?: string
}

type MetadataDocument =
  | { version: 1, servers: Record<string, LX.Sync.SyncClientProfile> }
  | { version: 2, userName: string, clients: Record<string, LX.Sync.SyncServerDevice> }

type RootMigrationPhase =
  | 'after-directories'
  | 'after-server-info'
  | 'after-server-metadata'
  | 'after-snapshots'
  | 'after-client-metadata'

interface RootMigrationOptions {
  failAt?: RootMigrationPhase
}

const legacyClientKeysJSON = 'syncAuthKey.json'
const legacyDevicesJSON = 'devices.json'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

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
  ((value.version == 1 && isRecord(value.servers)) ||
    (value.version == 2 && typeof value.userName == 'string' && isRecord(value.clients)))

const replaceMetadata = async(filePath: string, value: MetadataDocument): Promise<void> => {
  await createAtomicJsonFile<MetadataDocument>({
    filePath,
    validate: isMetadataDocument,
    shouldPreservePrevious: () => false,
    mode: 0o600,
  }).replace(value)
}

const replaceJson = async(filePath: string, value: JsonValue): Promise<void> => {
  await createAtomicJsonFile<JsonValue>({
    filePath,
    validate: isJsonValue,
    shouldPreservePrevious: () => false,
    mode: 0o600,
  }).replace(value)
}

const readJson = async(filePath: string): Promise<unknown | null> => {
  if (!await exists(filePath)) return null
  return JSON.parse(await fs.promises.readFile(filePath, 'utf8'))
}

const verifyJson = async(filePath: string, expected: JsonValue): Promise<void> => {
  const actual = await readJson(filePath)
  if (!isJsonValue(actual) || canonicalJson(actual) != canonicalJson(expected)) {
    throw new Error('Sync migration destination verification failed')
  }
}

const mergeMissing = <Value>(preferred: Record<string, Value>, fallback: Record<string, Value>): Record<string, Value> => ({
  ...fallback,
  ...preferred,
})

const vaultKey = async(ref: CredentialRef, key: unknown): Promise<void> => {
  if (typeof key != 'string') return
  const credential: SyncKeyPayloadV1 = { version: 1, key: assertSyncKeyCredential(key) }
  const vault = getCredentialVault()
  await vault.write(ref, credential)
  if (!await vault.verify(ref, credential)) throw new Error('Sync credential migration verification failed')
}

const vaultClientKeys = async(value: unknown): Promise<void> => {
  if (!isRecord(value)) return
  for (const [serverId, info] of Object.entries(value)) {
    if (isRecord(info) && Object.hasOwn(info, 'key')) await vaultKey({ kind: 'sync-client', serverId }, info.key)
  }
}

const vaultServerKeys = async(value: unknown, userName: string): Promise<void> => {
  if (!isRecord(value)) return
  for (const [clientId, info] of Object.entries(value)) {
    if (isRecord(info) && Object.hasOwn(info, 'key')) {
      await vaultKey({ kind: 'sync-server-device', userName, clientId }, info.key)
    }
  }
}

const canonicalizeExistingMetadata = async(dataPath: string, rootSource?: Record<string, unknown>): Promise<void> => {
  const clientPath = path.join(dataPath, File.clientDataPath)
  const serverPath = path.join(dataPath, File.serverDataPath)
  const currentClients = path.join(clientPath, File.syncAuthKeysJSON)
  const currentDevices = path.join(serverPath, File.userDevicesJSON)
  const rootProfiles = toProfiles(rootSource?.syncAuthKey)
  const rootDevices = toDevices(rootSource?.clients)
  await vaultClientKeys(rootSource?.syncAuthKey)
  await vaultServerKeys(rootSource?.clients, 'default')

  const hasCurrentClients = await exists(currentClients)
  let hasClientMetadataSource = hasCurrentClients || Object.keys(rootProfiles).length > 0
  let currentClientDocument: unknown = null
  let currentProfiles: Record<string, LX.Sync.SyncClientProfile> = {}
  if (hasCurrentClients) {
    currentClientDocument = await readJson(currentClients)
    if (!isRecord(currentClientDocument) || currentClientDocument.version != 1 || !isRecord(currentClientDocument.servers)) {
      throw new Error('Invalid sync client metadata')
    }
    await vaultClientKeys(currentClientDocument.servers)
    currentProfiles = toProfiles(currentClientDocument.servers)
  } else {
    const legacyClients = await readJson(path.join(clientPath, legacyClientKeysJSON))
    hasClientMetadataSource = legacyClients != null
    await vaultClientKeys(legacyClients)
    currentProfiles = toProfiles(legacyClients)
  }
  const expectedClients: MetadataDocument = { version: 1, servers: mergeMissing(currentProfiles, rootProfiles) }
  if (hasClientMetadataSource && (!hasCurrentClients || canonicalJson(currentClientDocument as JsonValue) != canonicalJson(expectedClients))) {
    await replaceMetadata(currentClients, expectedClients)
  }
  if (hasClientMetadataSource) await verifyJson(currentClients, expectedClients as unknown as JsonValue)

  const hasCurrentDevices = await exists(currentDevices)
  let hasDeviceMetadataSource = hasCurrentDevices || Object.keys(rootDevices).length > 0
  let currentDeviceDocument: unknown = null
  let currentUserName = 'default'
  let currentDeviceValues: Record<string, LX.Sync.SyncServerDevice> = {}
  if (hasCurrentDevices) {
    currentDeviceDocument = await readJson(currentDevices)
    if (!isRecord(currentDeviceDocument) || currentDeviceDocument.version != 2 ||
        typeof currentDeviceDocument.userName != 'string' || !isRecord(currentDeviceDocument.clients)) {
      throw new Error('Invalid sync server metadata')
    }
    currentUserName = currentDeviceDocument.userName
    await vaultServerKeys(currentDeviceDocument.clients, currentUserName)
    currentDeviceValues = toDevices(currentDeviceDocument.clients)
  } else {
    const legacyDevices = await readJson(path.join(serverPath, legacyDevicesJSON))
    hasDeviceMetadataSource = legacyDevices != null
    if (isRecord(legacyDevices)) {
      currentUserName = typeof legacyDevices.userName == 'string' ? legacyDevices.userName : 'default'
      await vaultServerKeys(legacyDevices.clients, currentUserName)
      currentDeviceValues = toDevices(legacyDevices.clients)
    }
  }
  const expectedDevices: MetadataDocument = {
    version: 2,
    userName: currentUserName,
    clients: mergeMissing(currentDeviceValues, rootDevices),
  }
  if (hasDeviceMetadataSource && (!hasCurrentDevices || canonicalJson(currentDeviceDocument as JsonValue) != canonicalJson(expectedDevices))) {
    await replaceMetadata(currentDevices, expectedDevices)
  }
  if (hasDeviceMetadataSource) await verifyJson(currentDevices, expectedDevices as unknown as JsonValue)
}

const failIfRequested = (options: RootMigrationOptions, phase: RootMigrationPhase): void => {
  if (options.failAt == phase) throw new Error(`injected failure: ${phase}`)
}

const migrateRootSource = async(dataPath: string, info: Record<string, unknown>, options: RootMigrationOptions): Promise<void> => {
  const serverId = info.serverId
  if (typeof serverId != 'string' || !isRecord(info.clients) || !isRecord(info.syncAuthKey) || !isRecord(info.snapshotInfo)) {
    throw new Error('Invalid root sync migration source')
  }
  await vaultClientKeys(info.syncAuthKey)
  await vaultServerKeys(info.clients, 'default')

  const serverSyncDataPath = path.join(dataPath, File.serverDataPath)
  const clientSyncDataPath = path.join(dataPath, File.clientDataPath)
  const listDir = path.join(serverSyncDataPath, File.listDir)
  const snapshotDestination = path.join(listDir, File.listSnapshotDir)
  await fs.promises.mkdir(snapshotDestination, { recursive: true })
  await fs.promises.mkdir(clientSyncDataPath, { recursive: true })
  failIfRequested(options, 'after-directories')

  const serverInfo = { serverId, version: 2 } as const
  const serverInfoPath = path.join(serverSyncDataPath, File.serverInfoJSON)
  await replaceJson(serverInfoPath, serverInfo)
  await verifyJson(serverInfoPath, serverInfo)
  failIfRequested(options, 'after-server-info')

  const currentDeviceDocument = await readJson(path.join(serverSyncDataPath, File.userDevicesJSON))
  const currentDevices = isRecord(currentDeviceDocument) && currentDeviceDocument.version == 2 &&
    currentDeviceDocument.userName == 'default' ? toDevices(currentDeviceDocument.clients) : {}
  const deviceMetadata = {
    version: 2 as const,
    userName: 'default',
    clients: mergeMissing(currentDevices, toDevices(info.clients)),
  }
  const devicePath = path.join(serverSyncDataPath, File.userDevicesJSON)
  await replaceMetadata(devicePath, deviceMetadata)
  await verifyJson(devicePath, deviceMetadata as unknown as JsonValue)
  failIfRequested(options, 'after-server-metadata')

  const snapshotInfo = JSON.parse(canonicalJson(info.snapshotInfo as unknown as JsonValue)) as Record<string, unknown>
  const snapshotClients: Record<string, JsonValue> = {}
  for (const device of Object.values(info.clients) as LegacyServerKeyInfo[]) {
    if (typeof device.clientId != 'string') continue
    snapshotClients[device.clientId] = {
      ...(typeof device.snapshotKey == 'string' ? { snapshotKey: device.snapshotKey } : {}),
      ...(typeof device.lastSyncDate == 'number' ? { lastSyncDate: device.lastSyncDate } : {}),
    }
  }
  snapshotInfo.clients = snapshotClients
  const snapshotInfoPath = path.join(listDir, File.listSnapshotInfoJSON)
  await replaceJson(snapshotInfoPath, snapshotInfo as JsonValue)
  const snapshots = (await fs.promises.readdir(dataPath)).filter(name => name.startsWith('snapshot_'))
  for (const file of snapshots) {
    await fs.promises.copyFile(path.join(dataPath, file), path.join(snapshotDestination, file))
  }
  await verifyJson(snapshotInfoPath, snapshotInfo as JsonValue)
  failIfRequested(options, 'after-snapshots')

  const currentClientDocument = await readJson(path.join(clientSyncDataPath, File.syncAuthKeysJSON))
  const currentProfiles = isRecord(currentClientDocument) && currentClientDocument.version == 1
    ? toProfiles(currentClientDocument.servers)
    : {}
  const clientMetadata = {
    version: 1 as const,
    servers: mergeMissing(currentProfiles, toProfiles(info.syncAuthKey)),
  }
  const clientPath = path.join(clientSyncDataPath, File.syncAuthKeysJSON)
  await replaceMetadata(clientPath, clientMetadata)
  await verifyJson(clientPath, clientMetadata as unknown as JsonValue)
  failIfRequested(options, 'after-client-metadata')

  await vaultClientKeys(info.syncAuthKey)
  await vaultServerKeys(info.clients, 'default')
  for (const file of snapshots) {
    const source = await fs.promises.readFile(path.join(dataPath, file))
    const destination = await fs.promises.readFile(path.join(snapshotDestination, file))
    if (!source.equals(destination)) throw new Error('Sync snapshot migration verification failed')
  }
  for (const file of snapshots) await fs.promises.unlink(path.join(dataPath, file))
  await fs.promises.unlink(path.join(dataPath, 'sync.json'))
}

// Credential migration runs first in normal startup; direct callers are still fail-closed if keys remain.
export default async(dataPath: string, options: RootMigrationOptions = {}): Promise<void> => {
  const rootSource = await readJson(path.join(dataPath, 'sync.json'))
  if (rootSource != null) {
    if (!isRecord(rootSource)) throw new Error('Invalid root sync migration source')
    if (typeof rootSource.serverId == 'string' && isRecord(rootSource.snapshotInfo)) {
      await migrateRootSource(dataPath, rootSource, options)
    } else {
      await canonicalizeExistingMetadata(dataPath, rootSource)
      await vaultClientKeys(rootSource.syncAuthKey)
      await vaultServerKeys(rootSource.clients, 'default')
      await fs.promises.unlink(path.join(dataPath, 'sync.json'))
    }
  }
  await canonicalizeExistingMetadata(dataPath)
}
