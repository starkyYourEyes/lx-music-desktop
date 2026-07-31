import { File } from '../../../common/constants_sync'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import {
  isSyncClientServersFileV1,
  isSyncServerDevicesFileV2,
  normalizeSyncClientProfile,
  normalizeSyncServerDevice,
  type SyncClientServersFileV1,
  type SyncServerDevicesFileV2,
} from '../../../common/storage/syncMetadata'
import fs from 'node:fs'
import path from 'node:path'
import { createSyncMetadataRecoveryError } from '@main/migration/credentials/recoveryError'
import { createAtomicJsonFile } from '@main/storage/atomicJsonFile'
import { getCredentialVault } from '@main/storage/credentials'
import { assertSyncKeyCredential, type CredentialRef, type SyncKeyPayloadV1 } from '@main/storage/credentials/types'

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

type MetadataDocument = SyncClientServersFileV1 | SyncServerDevicesFileV2

interface JsonDocumentRead {
  value: unknown
}

interface CurrentMetadataDocuments {
  clientPath: string
  serverPath: string
  client: SyncClientServersFileV1 | null
  server: SyncServerDevicesFileV2 | null
}

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

const toProfiles = (value: unknown): Record<string, LX.Sync.SyncClientProfile> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([serverId, info]) => {
    const profile = normalizeSyncClientProfile(info)
    return profile == null ? [] : [[serverId, profile]]
  }))
}

const toDevices = (value: unknown): Record<string, LX.Sync.SyncServerDevice> => {
  if (!isRecord(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([clientId, info]) => {
    const device = normalizeSyncServerDevice(info)
    return device == null ? [] : [[clientId, device]]
  }))
}

const isMetadataDocument = (value: unknown): value is MetadataDocument =>
  isSyncClientServersFileV1(value) || isSyncServerDevicesFileV2(value)

const replaceMetadata = async(
  filePath: string,
  value: MetadataDocument,
): Promise<void> => {
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

const readJsonDocument = async(filePath: string): Promise<JsonDocumentRead | null> => {
  let bytes: string
  try {
    bytes = await fs.promises.readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code == 'ENOENT') return null
    throw error
  }
  return { value: JSON.parse(bytes) }
}

const readCurrentMetadataDocument = async(
  dataPath: string,
  filePath: string,
): Promise<JsonDocumentRead | null> => {
  try {
    return await readJsonDocument(filePath)
  } catch {
    throw createSyncMetadataRecoveryError(
      'credentials.sync_metadata_invalid', dataPath, filePath,
    )
  }
}

const preflightCurrentMetadata = async(dataPath: string): Promise<CurrentMetadataDocuments> => {
  const clientPath = path.join(dataPath, File.clientDataPath, File.syncAuthKeysJSON)
  const serverPath = path.join(dataPath, File.serverDataPath, File.userDevicesJSON)
  const clientSource = await readCurrentMetadataDocument(dataPath, clientPath)
  if (clientSource != null && !isSyncClientServersFileV1(clientSource.value)) {
    throw createSyncMetadataRecoveryError(
      'credentials.sync_metadata_invalid', dataPath, clientPath,
    )
  }
  const serverSource = await readCurrentMetadataDocument(dataPath, serverPath)
  if (serverSource != null && !isSyncServerDevicesFileV2(serverSource.value)) {
    throw createSyncMetadataRecoveryError(
      'credentials.sync_metadata_invalid', dataPath, serverPath,
    )
  }
  return {
    clientPath,
    serverPath,
    client: clientSource?.value as SyncClientServersFileV1 | null ?? null,
    server: serverSource?.value as SyncServerDevicesFileV2 | null ?? null,
  }
}

const readJson = async(filePath: string): Promise<unknown | null> => (await readJsonDocument(filePath))?.value ?? null

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
  const currentMetadata = await preflightCurrentMetadata(dataPath)
  const clientPath = path.join(dataPath, File.clientDataPath)
  const serverPath = path.join(dataPath, File.serverDataPath)
  const currentClients = currentMetadata.clientPath
  const currentDevices = currentMetadata.serverPath
  const rootProfiles = toProfiles(rootSource?.syncAuthKey)
  const rootDevices = toDevices(rootSource?.clients)
  await vaultClientKeys(rootSource?.syncAuthKey)
  await vaultServerKeys(rootSource?.clients, 'default')

  const hasCurrentClients = currentMetadata.client != null
  let hasClientMetadataSource = hasCurrentClients || Object.keys(rootProfiles).length > 0
  const currentClientDocument = currentMetadata.client
  let currentProfiles: Record<string, LX.Sync.SyncClientProfile> = {}
  if (currentClientDocument != null) {
    currentProfiles = currentClientDocument.servers
  } else {
    const legacyClients = await readJson(path.join(clientPath, legacyClientKeysJSON))
    hasClientMetadataSource = legacyClients != null
    await vaultClientKeys(legacyClients)
    currentProfiles = toProfiles(legacyClients)
  }
  const expectedClients: MetadataDocument = { version: 1, servers: mergeMissing(currentProfiles, rootProfiles) }
  if (hasClientMetadataSource && (!hasCurrentClients ||
      canonicalJson(currentClientDocument as JsonValue) != canonicalJson(expectedClients as unknown as JsonValue))) {
    await replaceMetadata(currentClients, expectedClients)
  }
  if (hasClientMetadataSource) await verifyJson(currentClients, expectedClients as unknown as JsonValue)

  const hasCurrentDevices = currentMetadata.server != null
  let hasDeviceMetadataSource = hasCurrentDevices || Object.keys(rootDevices).length > 0
  const currentDeviceDocument = currentMetadata.server
  let currentUserName = 'default'
  let currentDeviceValues: Record<string, LX.Sync.SyncServerDevice> = {}
  if (currentDeviceDocument != null) {
    currentUserName = currentDeviceDocument.userName
    currentDeviceValues = currentDeviceDocument.clients
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
  if (hasDeviceMetadataSource && (!hasCurrentDevices ||
      canonicalJson(currentDeviceDocument as JsonValue) != canonicalJson(expectedDevices as unknown as JsonValue))) {
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
  const currentMetadata = await preflightCurrentMetadata(dataPath)
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

  const devicePath = currentMetadata.serverPath
  const currentDeviceDocument = currentMetadata.server
  let currentDevices: Record<string, LX.Sync.SyncServerDevice> = {}
  if (currentDeviceDocument != null) {
    currentDevices = currentDeviceDocument.clients
  }
  const deviceMetadata = {
    version: 2 as const,
    userName: 'default',
    clients: mergeMissing(currentDevices, toDevices(info.clients)),
  }
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

  const clientPath = currentMetadata.clientPath
  const currentClientDocument = currentMetadata.client
  let currentProfiles: Record<string, LX.Sync.SyncClientProfile> = {}
  if (currentClientDocument != null) {
    currentProfiles = currentClientDocument.servers
  }
  const clientMetadata = {
    version: 1 as const,
    servers: mergeMissing(currentProfiles, toProfiles(info.syncAuthKey)),
  }
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
