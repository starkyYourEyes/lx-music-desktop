export type CredentialRef =
  | { kind: 'netease-cookie' }
  | { kind: 'qq-music-cookie' }
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

export interface CredentialCipher {
  readonly mode: 'encrypted' | 'memory-only'
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
}

const identifierSegmentPattern = /^[A-Za-z0-9._@-]{1,256}$/
const standardBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const maxCookieOrSyncKeyLength = 64 * 1024
const maxWebDAVFieldLength = 4 * 1024

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
