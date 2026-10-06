import path from 'node:path'
import { File } from '@common/constants_sync'
import { createAtomicJsonFile, type AtomicJsonFile } from '@main/storage/atomicJsonFile'
import { getCredentialVault } from '@main/storage/credentials'
import type { SyncKeyPayloadV1 } from '@main/storage/credentials/types'
import { createOperationJournal, type OperationJournal } from '@main/storage/operationJournal'
import {
  isSyncClientServersFileV1,
  type SyncClientServersFileV1,
} from '@common/storage/syncMetadata'

let profiles: Record<string, LX.Sync.SyncClientProfile> | null = null
let metadataFile: AtomicJsonFile<SyncClientServersFileV1> | null = null
let operationJournal: OperationJournal | null = null
let initializationPromise: Promise<void> | null = null
let shutdownFlusherRegistered = false
let operationQueue = Promise.resolve()

export class SyncCredentialUnavailableError extends Error {
  readonly unavailableReason = 'credential_undecryptable' as const

  constructor() {
    super('credential unavailable')
    this.name = 'SyncCredentialUnavailableError'
  }
}

interface SyncCredentialMutationOptions {
  failAt?: 'after-vault-write' | 'after-vault-remove'
}

const getMetadataFile = () => {
  if (!shutdownFlusherRegistered && global.lx.storage != null) {
    global.lx.storage.registerShutdownFlusher('sync-client-credentials', flushSyncClientData, { restartSafe: true })
    shutdownFlusherRegistered = true
  }
  metadataFile ??= createAtomicJsonFile<SyncClientServersFileV1>({
    filePath: path.join(global.lxDataPath, File.clientDataPath, File.syncAuthKeysJSON),
    validate: isSyncClientServersFileV1,
    shouldPreservePrevious: () => false,
    mode: 0o600,
  })
  return metadataFile
}

const getOperationJournal = (): OperationJournal => {
  operationJournal ??= createOperationJournal({
    filePath: path.join(global.lxDataPath, File.clientDataPath, 'credential-operations.v1.json'),
  })
  return operationJournal
}

const toProfile = ({ key: _key, ...profile }: LX.Sync.ClientKeyInfo): LX.Sync.SyncClientProfile => profile

const failIfRequested = (
  options: SyncCredentialMutationOptions | undefined,
  stage: SyncCredentialMutationOptions['failAt'],
): void => {
  if (options?.failAt == stage) throw new Error(`injected failure: ${stage}`)
}

const serialize = async<Value>(_serverId: string, operation: () => Promise<Value>): Promise<Value> => {
  const result = operationQueue.then(operation, operation)
  operationQueue = result.then(() => undefined, () => undefined)
  return await result
}

const initClientInfo = async(): Promise<void> => {
  initializationPromise ??= (async() => {
    const document = await getMetadataFile().read()
    let nextProfiles = document?.servers ?? {}
    if (document == null) await getMetadataFile().replace({ version: 1, servers: nextProfiles })
    for (const intent of await getOperationJournal().list()) {
      await getCredentialVault().remove({ kind: 'sync-client', serverId: intent.key })
      if (Object.hasOwn(nextProfiles, intent.key)) {
        nextProfiles = { ...nextProfiles }
        Reflect.deleteProperty(nextProfiles, intent.key)
        await getMetadataFile().replace({ version: 1, servers: nextProfiles })
      }
      await getOperationJournal().complete(intent.key, intent.revision)
    }
    profiles = nextProfiles
  })()
  await initializationPromise
}

export const getSyncAuthKey = async(serverId: string): Promise<LX.Sync.ClientKeyInfo | null> => {
  return await serialize(serverId, async() => {
    await initClientInfo()
    const profile = profiles![serverId]
    if (profile == null) return null
    const credential = getCredentialVault().read<SyncKeyPayloadV1>({ kind: 'sync-client', serverId })
    if (credential.status == 'undecryptable') throw new SyncCredentialUnavailableError()
    if (credential.status == 'missing') return null
    return { ...profile, key: credential.value.key }
  })
}

export const setSyncAuthKey = async(
  serverId: string,
  info: LX.Sync.ClientKeyInfo,
  options?: SyncCredentialMutationOptions,
): Promise<void> => {
  await serialize(serverId, async() => {
    await initClientInfo()
    const journal = getOperationJournal()
    const revision = await journal.begin(serverId, 'save')
    const vault = getCredentialVault()
    const ref = { kind: 'sync-client' as const, serverId }
    const credential: SyncKeyPayloadV1 = { version: 1, key: info.key }
    await vault.write(ref, credential)
    failIfRequested(options, 'after-vault-write')
    if (!await vault.verify(ref, credential)) throw new Error('Sync client credential verification failed')
    const nextProfiles = { ...profiles!, [serverId]: toProfile(info) }
    await getMetadataFile().replace({ version: 1, servers: nextProfiles })
    await journal.complete(serverId, revision)
    // The server-scoped operation queue owns this snapshot publication.
    // eslint-disable-next-line require-atomic-updates
    profiles = nextProfiles
  })
}

export const removeSyncAuthKey = async(
  serverId: string,
  options?: SyncCredentialMutationOptions,
): Promise<void> => {
  await serialize(serverId, async() => {
    await initClientInfo()
    const journal = getOperationJournal()
    const revision = await journal.begin(serverId, 'remove')
    await getCredentialVault().remove({ kind: 'sync-client', serverId })
    failIfRequested(options, 'after-vault-remove')
    const nextProfiles = { ...profiles! }
    Reflect.deleteProperty(nextProfiles, serverId)
    await getMetadataFile().replace({ version: 1, servers: nextProfiles })
    await journal.complete(serverId, revision)
    // The server-scoped operation queue owns this snapshot publication.
    // eslint-disable-next-line require-atomic-updates
    profiles = nextProfiles
  })
}

export const flushSyncClientData = async(): Promise<void> => {
  await initializationPromise
  await operationQueue
  await operationJournal?.flush()
  await metadataFile?.flush()
}
