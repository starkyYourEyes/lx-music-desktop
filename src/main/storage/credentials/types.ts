import type { JsonValue } from '../../../common/storage/canonicalJson'

export type CredentialRef =
  | { kind: 'netease-cookie' }
  | { kind: 'qq-music-cookie' }
  | { kind: 'kugou-cookie' }
  | { kind: 'webdav-basic' }
  | { kind: 'sync-client', serverId: string }
  | { kind: 'sync-server-device', userName: string, clientId: string }
  | { kind: 'legacy-quarantine', sourceSha256: string }

export interface WebDAVCredentialPayloadV1 {
  version: 1
  username: string
  password: string
}

export interface SyncKeyPayloadV1 {
  version: 1
  key: string
}

export interface LegacyQuarantinePayloadV1 {
  version: 1
  sourceSha256: string
  keys: string[]
  payload: Record<string, JsonValue>
}

export interface CredentialCipher {
  readonly mode: 'encrypted' | 'memory-only'
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
}

const identifierSegmentPattern = /^[A-Za-z0-9._@-]{1,256}$/
const standardBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const maxCookieOrSyncKeyLength = 64 * 1024
const maxWebDAVFieldLength = 4 * 1024
const sha256Pattern = /^[0-9a-f]{64}$/

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value == null || ['string', 'boolean'].includes(typeof value)) return true
  if (typeof value == 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isPlainRecord(value) && Object.values(value).every(isJsonValue)
}

const assertString = (value: unknown, maximumLength: number, field: string): string => {
  if (typeof value != 'string' || value.length == 0 || Buffer.byteLength(value, 'utf8') > maximumLength) {
    throw new Error(`Invalid credential ${field}`)
  }
  return value
}

const assertIdentifierSegment = (value: unknown, field: string): string => {
  if (typeof value != 'string' || !identifierSegmentPattern.test(value)) {
    throw new Error(`Invalid credential identifier ${field}`)
  }
  return value
}

const assertSyncIdentifier = (value: unknown, field: string): string => {
  if (typeof value != 'string' || value.length == 0 || value.length > 256 ||
      (!identifierSegmentPattern.test(value) && (!standardBase64Pattern.test(value) || Buffer.from(value, 'base64').toString('base64') != value))) {
    throw new Error(`Invalid credential identifier ${field}`)
  }
  return value
}

export const toCredentialEntryId = (reference: CredentialRef): string => {
  switch (reference.kind) {
    case 'netease-cookie':
    case 'qq-music-cookie':
    case 'kugou-cookie':
    case 'webdav-basic':
      return reference.kind
    case 'sync-client':
      return `${reference.kind}:${assertSyncIdentifier(reference.serverId, 'serverId')}`
    case 'sync-server-device':
      return `${reference.kind}:${assertIdentifierSegment(reference.userName, 'userName')}:${assertSyncIdentifier(reference.clientId, 'clientId')}`
    case 'legacy-quarantine':
      return `${reference.kind}:${assertIdentifierSegment(reference.sourceSha256, 'sourceSha256')}`
    default:
      throw new Error('Invalid credential identifier kind')
  }
}

export const assertCookieCredential = (value: unknown): string => assertString(value, maxCookieOrSyncKeyLength, 'cookie')

export const assertSyncKeyCredential = (value: unknown): string => assertString(value, maxCookieOrSyncKeyLength, 'sync key')

export const assertWebDAVCredential = (value: unknown): WebDAVCredentialPayloadV1 => {
  if (value == null || typeof value != 'object' || Array.isArray(value)) throw new Error('Invalid WebDAV credential')
  const payload = value as Record<string, unknown>
  if (payload.version != 1) throw new Error('Invalid WebDAV credential version')

  return {
    version: 1,
    username: assertString(payload.username, maxWebDAVFieldLength, 'WebDAV username'),
    password: assertString(payload.password, maxWebDAVFieldLength, 'WebDAV password'),
  }
}

export const assertLegacyQuarantinePayload = (value: unknown): LegacyQuarantinePayloadV1 => {
  if (!isPlainRecord(value) || Object.keys(value).length != 4 ||
    !['version', 'sourceSha256', 'keys', 'payload'].every(key => Object.hasOwn(value, key)) ||
    value.version !== 1 || typeof value.sourceSha256 != 'string' || !sha256Pattern.test(value.sourceSha256) ||
    !Array.isArray(value.keys) || !isPlainRecord(value.payload)) {
    throw new Error('Invalid legacy quarantine payload')
  }
  const keys = value.keys as unknown[]
  const payload = value.payload
  if (!keys.every((key): key is string => typeof key == 'string') || new Set(keys).size != keys.length ||
    keys.some((key, index) => index > 0 && keys[index - 1] >= key) ||
    keys.length != Object.keys(payload).length || keys.some(key => !Object.hasOwn(payload, key)) ||
    !isJsonValue(payload)) {
    throw new Error('Invalid legacy quarantine payload')
  }
  return {
    version: 1,
    sourceSha256: value.sourceSha256,
    keys: [...keys],
    payload: Object.fromEntries(keys.map(key => [key, payload[key] as JsonValue])),
  }
}
