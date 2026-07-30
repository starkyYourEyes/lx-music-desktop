import path from 'node:path'
import { File } from '@common/constants_sync'
import { createAtomicJsonFile, type AtomicJsonFile } from '@main/storage/atomicJsonFile'
import { getCredentialVault } from '@main/storage/credentials'
import type { SyncKeyPayloadV1 } from '@main/storage/credentials/types'

interface ClientServersFileV1 {
  version: 1
  servers: Record<string, LX.Sync.SyncClientProfile>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const isProfile = (value: unknown): value is LX.Sync.SyncClientProfile => isRecord(value) &&
  typeof value.clientId == 'string' && value.clientId.length > 0 &&
  typeof value.serverName == 'string' && value.serverName.length > 0 &&
  (value.syncProtocol == null || value.syncProtocol == 'current' || value.syncProtocol == 'legacy') &&
  Object.keys(value).every(key => ['clientId', 'serverName', 'syncProtocol'].includes(key))

const isClientServersFileV1 = (value: unknown): value is ClientServersFileV1 => isRecord(value) &&
  value.version == 1 && isRecord(value.servers) && Object.values(value.servers).every(isProfile) &&
  Object.keys(value).every(key => ['version', 'servers'].includes(key))

let profiles: Record<string, LX.Sync.SyncClientProfile> | null = null
let metadataFile: AtomicJsonFile<ClientServersFileV1> | null = null

const getMetadataFile = () => {
  metadataFile ??= createAtomicJsonFile<ClientServersFileV1>({
    filePath: path.join(global.lxDataPath, File.clientDataPath, File.syncAuthKeysJSON),
    validate: isClientServersFileV1,
    shouldPreservePrevious: () => false,
    mode: 0o600,
  })
  return metadataFile
}

const toProfile = ({ key: _key, ...profile }: LX.Sync.ClientKeyInfo): LX.Sync.SyncClientProfile => profile

const initClientInfo = async() => {
  if (profiles != null) return
  const document = await getMetadataFile().read()
  // eslint-disable-next-line require-atomic-updates
  profiles = document?.servers ?? {}
  if (document == null) await getMetadataFile().replace({ version: 1, servers: profiles })
}

export const getSyncAuthKey = async(serverId: string): Promise<LX.Sync.ClientKeyInfo | null> => {
  await initClientInfo()
  const profile = profiles![serverId]
  if (profile == null) return null
  const credential = getCredentialVault().read<SyncKeyPayloadV1>({ kind: 'sync-client', serverId })
  if (credential.status != 'available' && credential.status != 'memory-only') return null
  return { ...profile, key: credential.value.key }
}

export const setSyncAuthKey = async(serverId: string, info: LX.Sync.ClientKeyInfo) => {
  await initClientInfo()
  const vault = getCredentialVault()
  const credential: SyncKeyPayloadV1 = { version: 1, key: info.key }
  await vault.write({ kind: 'sync-client', serverId }, credential)
  if (!await vault.verify({ kind: 'sync-client', serverId }, credential)) throw new Error('Sync client credential verification failed')
  profiles![serverId] = toProfile(info)
  await getMetadataFile().replace({ version: 1, servers: profiles! })
}
