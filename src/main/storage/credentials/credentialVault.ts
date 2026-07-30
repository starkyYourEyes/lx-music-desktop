import path from 'node:path'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import { createAtomicJsonFile, type AtomicJsonFile } from '../atomicJsonFile'
import {
  assertCookieCredential,
  assertSyncKeyCredential,
  assertWebDAVCredential,
  toCredentialEntryId,
  type CredentialCipher,
  type CredentialRef,
} from './types'

export interface CredentialVaultFileV1 {
  version: 1
  entries: Record<string, {
    version: 1
    ciphertext: string
    updatedAtMs: number
  }>
  migrationMarkers: Record<string, {
    sourceId: string
    completedAtMs: number
  }>
}

export type CredentialRead<T> =
  | { status: 'available', value: T }
  | { status: 'missing' }
  | { status: 'undecryptable' }
  | { status: 'memory-only', value: T }

export interface CredentialVault {
  readonly mode: CredentialCipher['mode']
  read: <T>(ref: CredentialRef) => CredentialRead<T>
  write: <T>(ref: CredentialRef, value: T) => Promise<{ persistence: 'encrypted' | 'memory-only' }>
  remove: (ref: CredentialRef) => Promise<void>
  verify: <T>(ref: CredentialRef, expected: T) => Promise<boolean>
  getMigrationMarker: (name: string) => { sourceId: string, completedAtMs: number } | null
  putMigrationMarker: (name: string, sourceId: string, completedAtMs: number) => Promise<void>
  flush: () => Promise<void>
}

interface CreateCredentialVaultOptions {
  profileRoot: string
  cipher: CredentialCipher
  now?: () => number
  file?: AtomicJsonFile<CredentialVaultStorageFileV1>
}

type CorruptibleNumberMetadata = number | boolean | null
type CorruptibleCiphertext = string | number | boolean | null

interface CredentialVaultStorageEntryV1 {
  version?: CorruptibleNumberMetadata
  ciphertext?: CorruptibleCiphertext
  updatedAtMs?: CorruptibleNumberMetadata
}

interface CredentialVaultStorageFileV1 {
  version: 1
  entries: Record<string, CredentialVaultStorageEntryV1>
  migrationMarkers: Record<string, CredentialVaultFileV1['migrationMarkers'][string] | {
    sourceSha256: string
    completedAtMs: number
  }>
}

interface EncryptedCredentialPayloadV1 {
  version: 1
  entryId: string
  payload: JsonValue
}

const timestampIsValid = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= 0

const recordIsValid = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actualKeys = Object.keys(value)
  return actualKeys.length == keys.length && actualKeys.every(key => keys.includes(key))
}

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every(key => keys.includes(key))

const base64IsValid = (value: unknown): value is string => {
  if (typeof value != 'string' || value.length == 0 || value.length % 4 != 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') == value
}

const sourceIdIsValid = (value: unknown): value is string =>
  typeof value == 'string' && /^[\x21-\x7e]{1,512}$/.test(value)

const migrationMarkerIsValid = (value: unknown): boolean => {
  if (!recordIsValid(value) || !timestampIsValid(value.completedAtMs)) return false
  if (hasExactKeys(value, ['sourceId', 'completedAtMs'])) return sourceIdIsValid(value.sourceId)
  return hasExactKeys(value, ['sourceSha256', 'completedAtMs']) &&
    typeof value.sourceSha256 == 'string' && /^[a-f0-9]{64}$/i.test(value.sourceSha256)
}

const credentialEntryIsDecryptable = (value: CredentialVaultStorageEntryV1): value is CredentialVaultFileV1['entries'][string] =>
  value.version == 1 && base64IsValid(value.ciphertext) && timestampIsValid(value.updatedAtMs)

const corruptibleNumberMetadataIsValid = (value: unknown): value is CorruptibleNumberMetadata =>
  value == null || typeof value == 'boolean' || (typeof value == 'number' && Number.isFinite(value))

const corruptibleCiphertextIsValid = (value: unknown): value is CorruptibleCiphertext =>
  typeof value == 'string' || corruptibleNumberMetadataIsValid(value)

const credentialStorageEntryIsValid = (value: unknown): value is CredentialVaultStorageEntryV1 => {
  if (!recordIsValid(value) || !hasOnlyKeys(value, ['version', 'ciphertext', 'updatedAtMs'])) return false
  if (Object.hasOwn(value, 'version') && !corruptibleNumberMetadataIsValid(value.version)) return false
  if (Object.hasOwn(value, 'ciphertext') && !corruptibleCiphertextIsValid(value.ciphertext)) return false
  return !Object.hasOwn(value, 'updatedAtMs') || corruptibleNumberMetadataIsValid(value.updatedAtMs)
}

const isCredentialVaultStorageFileV1 = (value: unknown): value is CredentialVaultStorageFileV1 => {
  if (!recordIsValid(value) || !hasExactKeys(value, ['version', 'entries', 'migrationMarkers']) ||
      value.version != 1 || !recordIsValid(value.entries) || !recordIsValid(value.migrationMarkers)) {
    return false
  }
  return Object.values(value.entries).every(credentialStorageEntryIsValid) &&
    Object.values(value.migrationMarkers).every(migrationMarkerIsValid)
}

const emptyEnvelope = (): CredentialVaultStorageFileV1 => ({
  version: 1,
  entries: {},
  migrationMarkers: {},
})

const normalizeMigrationMarkers = (value: CredentialVaultStorageFileV1): {
  envelope: CredentialVaultStorageFileV1
  changed: boolean
} => {
  let changed = false
  const markers: CredentialVaultFileV1['migrationMarkers'] = {}
  for (const [name, marker] of Object.entries(value.migrationMarkers)) {
    if ('sourceId' in marker) markers[name] = { sourceId: marker.sourceId, completedAtMs: marker.completedAtMs }
    else {
      changed = true
      markers[name] = { sourceId: name, completedAtMs: marker.completedAtMs }
    }
  }
  return { envelope: { ...value, migrationMarkers: markers }, changed }
}

const cloneEnvelope = (value: CredentialVaultStorageFileV1): CredentialVaultStorageFileV1 =>
  JSON.parse(canonicalJson(value as unknown as JsonValue))

const removeUnsafeCiphertextEntries = (value: CredentialVaultStorageFileV1): void => {
  for (const [entryId, entry] of Object.entries(value.entries)) {
    if (!base64IsValid(entry.ciphertext)) Reflect.deleteProperty(value.entries, entryId)
  }
}

const containsUnsafeCiphertext = (value: CredentialVaultStorageFileV1): boolean =>
  Object.values(value.entries).some(entry => !base64IsValid(entry.ciphertext))

const containsLegacySourceHash = (value: CredentialVaultStorageFileV1): boolean =>
  Object.values(value.migrationMarkers).some(marker => 'sourceSha256' in marker)

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return recordIsValid(value) && Object.values(value).every(isJsonValue)
}

const normalizePayload = (ref: CredentialRef, value: unknown): JsonValue => {
  switch (ref.kind) {
    case 'netease-cookie':
    case 'qq-music-cookie':
      if (typeof value == 'string') return assertCookieCredential(value)
      if (!recordIsValid(value) || value.version != 1) throw new Error('Invalid cookie credential')
      return { version: 1, cookie: assertCookieCredential(value.cookie) }
    case 'webdav-basic':
      return assertWebDAVCredential(value) as unknown as JsonValue
    case 'sync-client':
    case 'sync-server-device':
      if (!recordIsValid(value) || value.version != 1) throw new Error('Invalid sync credential')
      return { version: 1, key: assertSyncKeyCredential(value.key) }
    case 'legacy-quarantine':
      if (!isJsonValue(value)) throw new Error('Invalid quarantined credential')
      return value
  }
}

const parseEncryptedPayload = (entryId: string, plaintext: string): JsonValue => {
  const value: unknown = JSON.parse(plaintext)
  if (!recordIsValid(value) || !hasExactKeys(value, ['version', 'entryId', 'payload']) ||
      value.version != 1 || value.entryId != entryId || !isJsonValue(value.payload)) {
    throw new Error('Invalid encrypted credential envelope')
  }
  return value.payload
}

const markerNameIsValid = (name: string): boolean =>
  /^[\x21-\x7e]{1,512}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name)

const assertMarker = (name: string, sourceId: string, completedAtMs: number): void => {
  if (!markerNameIsValid(name)) throw new Error('Invalid credential migration marker name')
  if (!sourceIdIsValid(sourceId)) throw new Error('Invalid credential migration source identity')
  if (!timestampIsValid(completedAtMs)) throw new Error('Invalid credential migration timestamp')
}

export const createCredentialVault = async(options: CreateCredentialVaultOptions): Promise<CredentialVault> => {
  const now = options.now ?? Date.now
  const file = options.file ?? createAtomicJsonFile<CredentialVaultStorageFileV1>({
    filePath: path.join(options.profileRoot, 'credentials.v1.json'),
    validate: isCredentialVaultStorageFileV1,
    shouldPreservePrevious: current => !containsUnsafeCiphertext(current) && !containsLegacySourceHash(current),
    mode: 0o600,
  })
  const loadedEnvelope = await file.read() ?? emptyEnvelope()
  const normalizedMarkers = normalizeMigrationMarkers(loadedEnvelope)
  if (normalizedMarkers.changed) await file.replace(normalizedMarkers.envelope)
  let envelope = normalizedMarkers.envelope
  const memoryEntries = new Map<string, JsonValue>()
  const volatileUndecryptableEntryIds = new Set(
    Object.entries(envelope.entries)
      .filter(([, entry]) => !base64IsValid(entry.ciphertext))
      .map(([entryId]) => entryId),
  )
  let lifecycle = Promise.resolve()

  const serialize = async<T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(operation)
    lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  const persist = async(
    mutate: (next: CredentialVaultStorageFileV1) => void,
    options?: { retainUnsafeCiphertext?: boolean },
  ): Promise<void> => serialize(async() => {
    const next = cloneEnvelope(envelope)
    mutate(next)
    if (!options?.retainUnsafeCiphertext) removeUnsafeCiphertextEntries(next)
    await file.replace(next)
    // Serialized vault mutations make this post-commit assignment race-free.
    // eslint-disable-next-line require-atomic-updates
    envelope = next
  })

  const read = <T>(ref: CredentialRef): CredentialRead<T> => {
    const entryId = toCredentialEntryId(ref)
    if (memoryEntries.has(entryId)) return { status: 'memory-only', value: memoryEntries.get(entryId) as T }
    const entry = envelope.entries[entryId]
    if (entry == null) return volatileUndecryptableEntryIds.has(entryId) ? { status: 'undecryptable' } : { status: 'missing' }
    if (!credentialEntryIsDecryptable(entry)) return { status: 'undecryptable' }
    try {
      const plaintext = options.cipher.decrypt(Buffer.from(entry.ciphertext, 'base64'))
      return { status: 'available', value: normalizePayload(ref, parseEncryptedPayload(entryId, plaintext)) as T }
    } catch {
      return { status: 'undecryptable' }
    }
  }

  const write = async<T>(ref: CredentialRef, value: T): Promise<{ persistence: 'encrypted' | 'memory-only' }> => {
    const entryId = toCredentialEntryId(ref)
    const payload = normalizePayload(ref, value)
    const encryptedPayload: EncryptedCredentialPayloadV1 = { version: 1, entryId, payload }
    const plaintext = canonicalJson(encryptedPayload as unknown as JsonValue)
    if (options.cipher.mode == 'memory-only') {
      memoryEntries.set(entryId, JSON.parse(canonicalJson(payload)) as JsonValue)
      if (envelope.entries[entryId] != null) {
        await persist(next => {
          Reflect.deleteProperty(next.entries, entryId)
        }, { retainUnsafeCiphertext: true })
      }
      return { persistence: 'memory-only' }
    }
    const entry = {
      version: 1 as const,
      ciphertext: options.cipher.encrypt(plaintext).toString('base64'),
      updatedAtMs: now(),
    }
    await persist(next => {
      next.entries[entryId] = entry
    })
    volatileUndecryptableEntryIds.delete(entryId)
    return { persistence: 'encrypted' }
  }

  const remove = async(ref: CredentialRef): Promise<void> => {
    const entryId = toCredentialEntryId(ref)
    memoryEntries.delete(entryId)
    if (envelope.entries[entryId] == null) {
      volatileUndecryptableEntryIds.delete(entryId)
      return
    }
    await persist(next => {
      Reflect.deleteProperty(next.entries, entryId)
    })
    volatileUndecryptableEntryIds.delete(entryId)
  }

  const verify = async<T>(ref: CredentialRef, expected: T): Promise<boolean> => {
    let normalizedExpected: JsonValue
    try {
      normalizedExpected = normalizePayload(ref, expected)
    } catch {
      return false
    }
    const actual = read<JsonValue>(ref)
    if (actual.status != 'available' && actual.status != 'memory-only') return false
    return canonicalJson(actual.value) == canonicalJson(normalizedExpected)
  }

  const getMigrationMarker = (name: string): { sourceId: string, completedAtMs: number } | null => {
    if (!markerNameIsValid(name) || !Object.hasOwn(envelope.migrationMarkers, name)) return null
    const marker = envelope.migrationMarkers[name]
    return 'sourceId' in marker ? { ...marker } : { sourceId: name, completedAtMs: marker.completedAtMs }
  }

  const putMigrationMarker = async(name: string, sourceId: string, completedAtMs: number): Promise<void> => {
    assertMarker(name, sourceId, completedAtMs)
    await persist(next => {
      next.migrationMarkers[name] = { sourceId, completedAtMs }
    }, options.cipher.mode == 'memory-only' ? { retainUnsafeCiphertext: true } : undefined)
  }

  const flush = async(): Promise<void> => {
    await lifecycle
    await file.flush()
  }

  return { mode: options.cipher.mode, read, write, remove, verify, getMigrationMarker, putMigrationMarker, flush }
}
