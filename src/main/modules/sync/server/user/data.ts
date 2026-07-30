import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { filterFileName, toMD5 } from '../utils'
import { File } from '@common/constants_sync'
import { createAtomicJsonFile, type AtomicJsonFile } from '@main/storage/atomicJsonFile'
import { getCredentialVault } from '@main/storage/credentials'
import type { SyncKeyPayloadV1 } from '@main/storage/credentials/types'
import { exists } from '../../utils'

interface ServerInfo {
  serverId: string
  version: number
}

interface DevicesInfoV2 {
  version: 2
  userName: string
  clients: Record<string, LX.Sync.SyncServerDevice>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const isDevice = (value: unknown): value is LX.Sync.SyncServerDevice => isRecord(value) &&
  typeof value.clientId == 'string' && value.clientId.length > 0 &&
  typeof value.deviceName == 'string' && value.deviceName.length > 0 &&
  typeof value.isMobile == 'boolean' &&
  (value.lastConnectDate == null || (typeof value.lastConnectDate == 'number' && Number.isSafeInteger(value.lastConnectDate) && value.lastConnectDate >= 0)) &&
  (value.syncProtocol == null || value.syncProtocol == 'current' || value.syncProtocol == 'legacy') &&
  Object.keys(value).every(key => ['clientId', 'deviceName', 'isMobile', 'lastConnectDate', 'syncProtocol'].includes(key))

const isDevicesInfoV2 = (value: unknown): value is DevicesInfoV2 => isRecord(value) &&
  value.version == 2 && typeof value.userName == 'string' && isRecord(value.clients) &&
  Object.values(value.clients).every(isDevice) &&
  Object.keys(value).every(key => ['version', 'userName', 'clients'].includes(key))

export const toPublicDevice = ({ key: _key, ...device }: LX.Sync.ServerKeyInfo): LX.Sync.SyncServerDevice => device

let serverInfo: ServerInfo
let serverInfoQueue = Promise.resolve()
let lastServerInfoError: unknown = null

const serializeServerInfo = async<Value>(operation: () => Promise<Value>): Promise<Value> => {
  const result = serverInfoQueue.then(operation, operation)
  serverInfoQueue = result.then(() => {
    lastServerInfoError = null
  }, error => {
    lastServerInfoError = error
  })
  return await result
}

const persistServerInfo = async(): Promise<void> => {
  const directory = path.join(global.lxDataPath, File.serverDataPath)
  const destination = path.join(directory, File.serverInfoJSON)
  const temporary = `${destination}.next`
  await fs.promises.mkdir(directory, { recursive: true })
  await fs.promises.writeFile(temporary, JSON.stringify(serverInfo), { mode: 0o600 })
  const handle = await fs.promises.open(temporary, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.promises.rename(temporary, destination)
}

export const initServerInfo = async() => {
  if (serverInfo != null) return
  const serverInfoFilePath = path.join(global.lxDataPath, File.serverDataPath, File.serverInfoJSON)
  if (await exists(serverInfoFilePath)) {
    // eslint-disable-next-line require-atomic-updates
    serverInfo = JSON.parse((await fs.promises.readFile(serverInfoFilePath)).toString())
  } else {
    // eslint-disable-next-line require-atomic-updates
    serverInfo = {
      serverId: randomBytes(4 * 4).toString('base64'),
      version: 2,
    }
    await serializeServerInfo(persistServerInfo)
  }
}
export const getServerId = () => serverInfo.serverId
export const getVersion = async() => {
  await initServerInfo()
  return serverInfo.version ?? 1
}
export const setVersion = async(version: number) => {
  await initServerInfo()
  await serializeServerInfo(async() => {
    serverInfo.version = version
    await persistServerInfo()
  })
}

export const flushServerInfo = async(): Promise<void> => {
  await serverInfoQueue
  if (lastServerInfoError instanceof Error) throw lastServerInfoError
  if (lastServerInfoError != null) throw new Error('Server info persistence failed')
}

export const getUserDirname = (userName: string) => `${filterFileName(userName)}_${toMD5(userName).substring(0, 6)}`

export const getUserConfig = (_userName: string) => ({
  maxSnapshotNum: global.lx.appSetting['sync.server.maxSsnapshotNum'],
  'list.addMusicLocationType': global.lx.appSetting['list.addMusicLocationType'],
})

export const createClientKeyInfo = (
  deviceName: string,
  isMobile: boolean,
  syncProtocol: LX.Sync.SyncProtocolId = 'current',
): LX.Sync.ServerKeyInfo => ({
  clientId: randomBytes(4 * 4).toString('base64'),
  key: randomBytes(16).toString('base64'),
  deviceName,
  isMobile,
  syncProtocol,
  lastConnectDate: 0,
})

export class UserDataManage {
  userName: string
  userDir: string
  devicesFilePath: string
  devicesInfo: DevicesInfoV2 = { version: 2, userName: '', clients: {} }
  private readonly metadataFile: AtomicJsonFile<DevicesInfoV2>
  private readonly ready: Promise<void>

  private async init(): Promise<void> {
    const document = await this.metadataFile.read()
    if (document != null && document.userName == this.userName) {
      this.devicesInfo = document
      return
    }
    this.devicesInfo = { version: 2, userName: this.userName, clients: {} }
    await this.metadataFile.replace(this.devicesInfo)
  }

  getAllClientKeyInfo = async(): Promise<LX.Sync.SyncServerDevice[]> => {
    await this.ready
    return Object.values(this.devicesInfo.clients).sort((a, b) => (b.lastConnectDate ?? 0) - (a.lastConnectDate ?? 0))
  }

  saveClientKeyInfo = async(keyInfo: LX.Sync.ServerKeyInfo): Promise<void> => {
    await this.ready
    if (this.devicesInfo.clients[keyInfo.clientId] == null && Object.keys(this.devicesInfo.clients).length > 101) throw new Error('max keys')
    const vault = getCredentialVault()
    const ref = { kind: 'sync-server-device' as const, userName: this.userName, clientId: keyInfo.clientId }
    const credential: SyncKeyPayloadV1 = { version: 1, key: keyInfo.key }
    await vault.write(ref, credential)
    if (!await vault.verify(ref, credential)) throw new Error('Sync server credential verification failed')
    this.devicesInfo.clients[keyInfo.clientId] = toPublicDevice(keyInfo)
    await this.metadataFile.replace(this.devicesInfo)
  }

  getClientKeyInfo = async(clientId?: string | null): Promise<LX.Sync.ServerKeyInfo | null> => {
    await this.ready
    if (!clientId) return null
    const device = this.devicesInfo.clients[clientId]
    if (device == null) return null
    const credential = getCredentialVault().read<SyncKeyPayloadV1>({
      kind: 'sync-server-device',
      userName: this.userName,
      clientId,
    })
    if (credential.status != 'available' && credential.status != 'memory-only') return null
    return { ...device, key: credential.value.key }
  }

  removeClientKeyInfo = async(clientId: string) => {
    await this.ready
    const ref = { kind: 'sync-server-device' as const, userName: this.userName, clientId }
    await getCredentialVault().remove(ref)
    Reflect.deleteProperty(this.devicesInfo.clients, clientId)
    await this.metadataFile.replace(this.devicesInfo)
  }

  isIncluedsClient = async(clientId: string) => {
    await this.ready
    return Object.hasOwn(this.devicesInfo.clients, clientId)
  }

  constructor(userName: string) {
    this.userName = userName
    this.userDir = path.join(global.lxDataPath, File.serverDataPath)
    this.devicesFilePath = path.join(this.userDir, File.userDevicesJSON)
    this.metadataFile = createAtomicJsonFile<DevicesInfoV2>({
      filePath: this.devicesFilePath,
      validate: isDevicesInfoV2,
      shouldPreservePrevious: () => false,
      mode: 0o600,
    })
    this.ready = this.init()
  }
}
