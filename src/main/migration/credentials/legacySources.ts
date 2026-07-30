import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalJson, sha256Canonical, type JsonValue } from '../../../common/storage/canonicalJson'
import { normalizePublicAccountProfile } from '../../../common/storage/accountProfile'
import { assertCookieCredential, assertSyncKeyCredential, assertWebDAVCredential, toCredentialEntryId, type CredentialRef } from '../../storage/credentials/types'

export interface LegacyCredentialSource {
  markerName: string
  sourceSha256: string
  ref: CredentialRef
  value: JsonValue
  documentPath: string
  redact: (document: Record<string, unknown>) => void
}

export interface LegacyAccountProfile {
  provider: 'netease' | 'qq_music'
  profileJson: string
  updatedAtMs: number
}

export interface LegacyCredentialInventory {
  credentials: LegacyCredentialSource[]
  profiles: LegacyAccountProfile[]
}

interface SourceDocument {
  path: string
  value: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const isMissing = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && 'code' in error && error.code == 'ENOENT'

const sourceMarker = (documentPath: string, ref: CredentialRef): string =>
  `legacy_data_v1.credentials.${sha256Canonical({ version: 1, documentPath, entryId: toCredentialEntryId(ref) })}`

const sourceHash = (documentPath: string, ref: CredentialRef, value: JsonValue): string =>
  sha256Canonical({ version: 1, documentPath, entryId: toCredentialEntryId(ref), value })

const readJsonDocument = async(filePath: string): Promise<SourceDocument | null> => {
  let stats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    stats = await fs.lstat(filePath)
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('Invalid legacy credential source path')
  const value: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'))
  if (!isRecord(value)) throw new Error('Invalid legacy credential source document')
  return { path: filePath, value }
}

const append = (
  values: LegacyCredentialSource[],
  document: SourceDocument,
  ref: CredentialRef,
  value: JsonValue,
  redact: (document: Record<string, unknown>) => void,
): void => {
  values.push({
    markerName: sourceMarker(document.path, ref),
    sourceSha256: sourceHash(document.path, ref, value),
    ref,
    value,
    documentPath: document.path,
    redact,
  })
}

const removeAccountCookie = (key: string): ((document: Record<string, unknown>) => void) => document => {
  const account = document[key]
  if (!isRecord(account)) return
  Reflect.deleteProperty(account, 'cookie')
}

const accountInventory = (document: SourceDocument, credentials: LegacyCredentialSource[], profiles: LegacyAccountProfile[]): void => {
  const entries: Array<{
    key: string
    provider: 'netease' | 'qq_music'
    ref: CredentialRef
  }> = [
    { key: 'neteaseAccount', provider: 'netease', ref: { kind: 'netease-cookie' } },
    { key: 'qqMusicAccount', provider: 'qq_music', ref: { kind: 'qq-music-cookie' } },
  ]
  for (const entry of entries) {
    const account = document.value[entry.key]
    if (!isRecord(account)) continue
    if (account.profile != null) {
      const profile = normalizePublicAccountProfile(entry.provider, account.profile)
      const updatedAtMs = account.updatedAt
      if (typeof updatedAtMs != 'number' || !Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
        throw new Error('Invalid legacy account timestamp')
      }
      profiles.push({ provider: entry.provider, profileJson: JSON.stringify(profile), updatedAtMs })
    }
    if (typeof account.cookie != 'string' || account.cookie.length == 0) continue
    const cookie = assertCookieCredential(account.cookie)
    append(credentials, document, entry.ref, { version: 1, cookie }, removeAccountCookie(entry.key))
  }
}

const clientInventory = (document: SourceDocument, credentials: LegacyCredentialSource[], containerKey?: string): void => {
  const clientKeys = containerKey == null ? document.value : document.value[containerKey]
  if (!isRecord(clientKeys)) return
  for (const [serverId, info] of Object.entries(clientKeys)) {
    if (!isRecord(info) || typeof info.key != 'string') continue
    const ref: CredentialRef = { kind: 'sync-client', serverId }
    const value = { version: 1, key: assertSyncKeyCredential(info.key) } as const
    append(credentials, document, ref, value, current => {
      const clients = containerKey == null ? current : current[containerKey]
      if (!isRecord(clients) || !isRecord(clients[serverId])) return
      Reflect.deleteProperty(clients[serverId], 'key')
    })
  }
}

const serverInventory = (document: SourceDocument, credentials: LegacyCredentialSource[], userName: string): void => {
  const clients = document.value.clients
  if (!isRecord(clients)) return
  for (const [clientId, info] of Object.entries(clients)) {
    if (!isRecord(info) || typeof info.key != 'string') continue
    const ref: CredentialRef = { kind: 'sync-server-device', userName, clientId }
    const value = { version: 1, key: assertSyncKeyCredential(info.key) } as const
    append(credentials, document, ref, value, current => {
      const currentClients = current.clients
      if (!isRecord(currentClients) || !isRecord(currentClients[clientId])) return
      Reflect.deleteProperty(currentClients[clientId], 'key')
    })
  }
}

const ensureContainedRealPath = async(rootPath: string, candidate: string): Promise<void> => {
  const root = await fs.realpath(rootPath)
  const resolved = path.resolve(candidate)
  const relative = path.relative(root, resolved)
  if (relative == '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Invalid sync user path')
}

const userInventory = async(dataRoot: string, credentials: LegacyCredentialSource[]): Promise<void> => {
  const userRoot = path.join(dataRoot, 'sync', 'server', 'users')
  let rootStats: Awaited<ReturnType<typeof fs.lstat>>
  try {
    rootStats = await fs.lstat(userRoot)
  } catch (error) {
    if (isMissing(error)) return
    throw error
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error('Invalid sync user path')
  for (const directoryName of await fs.readdir(userRoot)) {
    if (!/^[A-Za-z0-9._@-]{1,256}$/.test(directoryName)) throw new Error('Invalid sync user path')
    const directory = path.join(userRoot, directoryName)
    await ensureContainedRealPath(userRoot, directory)
    const directoryStats = await fs.lstat(directory)
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) throw new Error('Invalid sync user path')
    const document = await readJsonDocument(path.join(directory, 'devices.json'))
    if (document != null) serverInventory(document, credentials, directoryName)
  }
}

export const collectLegacyCredentialInventory = async(dataRoot: string): Promise<LegacyCredentialInventory> => {
  const credentials: LegacyCredentialSource[] = []
  const profiles: LegacyAccountProfile[] = []
  const data = await readJsonDocument(path.join(dataRoot, 'data.json'))
  if (data != null) accountInventory(data, credentials, profiles)

  const config = await readJsonDocument(path.join(dataRoot, 'config_v2.json'))
  const setting = config?.value.setting
  if (config != null && isRecord(setting) && (Object.hasOwn(setting, 'webdav.username') || Object.hasOwn(setting, 'webdav.password'))) {
    const ref: CredentialRef = { kind: 'webdav-basic' }
    const value = assertWebDAVCredential({ version: 1, username: setting['webdav.username'], password: setting['webdav.password'] })
    append(credentials, config, ref, value as unknown as JsonValue, document => {
      const currentSetting = document.setting
      if (!isRecord(currentSetting)) return
      Reflect.deleteProperty(currentSetting, 'webdav.username')
      Reflect.deleteProperty(currentSetting, 'webdav.password')
    })
  }

  const client = await readJsonDocument(path.join(dataRoot, 'sync', 'client', 'syncAuthKey.json'))
  if (client != null) clientInventory(client, credentials)
  const server = await readJsonDocument(path.join(dataRoot, 'sync', 'server', 'devices.json'))
  if (server != null) serverInventory(server, credentials, typeof server.value.userName == 'string' ? server.value.userName : 'default')
  await userInventory(dataRoot, credentials)

  const legacy = await readJsonDocument(path.join(dataRoot, 'sync.json'))
  if (legacy != null) {
    clientInventory(legacy, credentials, 'syncAuthKey')
    serverInventory({ ...legacy, value: { clients: legacy.value.clients } }, credentials, 'default')
  }
  const destinations = new Map<string, string>()
  for (const credential of credentials) {
    const destination = toCredentialEntryId(credential.ref)
    const value = canonicalJson(credential.value)
    const existing = destinations.get(destination)
    if (existing != null && existing != value) throw new Error('Conflicting legacy credential destination')
    destinations.set(destination, value)
  }
  return { credentials, profiles }
}
