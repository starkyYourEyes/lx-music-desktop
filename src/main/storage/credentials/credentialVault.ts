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
    sourceSha256: string
    completedAtMs: number
  }>
}

export type CredentialRead<T> =
  | { status: 'available', value: T }
  | { status: 'missing' }
  | { status: 'undecryptable' }
  | { status: 'memory-only', value: T }

export interface CredentialVault {
  read: <T>(ref: CredentialRef) => CredentialRead<T>
  write: <T>(ref: CredentialRef, value: T) => Promise<{ persistence: 'encrypted' | 'memory-only' }>
  remove: (ref: CredentialRef) => Promise<void>
  verify: <T>(ref: CredentialRef, expected: T) => Promise<boolean>
  getMigrationMarker: (name: string) => { sourceSha256: string, completedAtMs: number } | null
  putMigrationMarker: (name: string, sourceSha256: string, completedAtMs: number) => Promise<void>
  flush: () => Promise<void>
}

interface CreateCredentialVaultOptions {
  profileRoot: string
  cipher: CredentialCipher
  now?: () => number
  file?: AtomicJsonFile<CredentialVaultFileV1>
}

const timestampIsValid = (value: unknown): value is number =>
  typeof value == 'number' && Number.isSafeInteger(value) && value >= 0

const recordIsValid = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value)

const base64IsValid = (value: unknown): value is string => {
  if (typeof value != 'string' || value.length == 0 || value.length % 4 != 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false
  return Buffer.from(value, 'base64').toString('base64') == value
}

const migrationMarkerIsValid = (value: unknown): boolean => recordIsValid(value) &&
  typeof value.sourceSha256 == 'string' && /^[a-f0-9]{64}$/i.test(value.sourceSha256) &&
  timestampIsValid(value.completedAtMs)

const credentialEntryIsValid = (value: unknown): boolean => recordIsValid(value) &&
  value.version == 1 && base64IsValid(value.ciphertext) && timestampIsValid(value.updatedAtMs)

const isCredentialVaultFileV1 = (value: unknown): value is CredentialVaultFileV1 => {
  if (!recordIsValid(value) || value.version != 1 || !recordIsValid(value.entries) || !recordIsValid(value.migrationMarkers)) {
    return false
  }
  return Object.values(value.entries).every(credentialEntryIsValid) &&
    Object.values(value.migrationMarkers).every(migrationMarkerIsValid)
}

const emptyEnvelope = (): CredentialVaultFileV1 => ({
  version: 1,
  entries: {},
  migrationMarkers: {},
})

const cloneEnvelope = (value: CredentialVaultFileV1): CredentialVaultFileV1 =>
  JSON.parse(canonicalJson(value as unknown as JsonValue))

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

const markerNameIsValid = (name: string): boolean =>
  /^[\x21-\x7e]{1,512}$/.test(name) && !['__proto__', 'constructor', 'prototype'].includes(name)

const assertMarker = (name: string, sourceSha256: string, completedAtMs: number): void => {
  if (!markerNameIsValid(name)) throw new Error('Invalid credential migration marker name')
  if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('Invalid credential migration source hash')
  if (!timestampIsValid(completedAtMs)) throw new Error('Invalid credential migration timestamp')
}

export const createCredentialVault = async(options: CreateCredentialVaultOptions): Promise<CredentialVault> => {
  const now = options.now ?? Date.now
  const file = options.file ?? createAtomicJsonFile<CredentialVaultFileV1>({
    filePath: path.join(options.profileRoot, 'credentials.v1.json'),
    validate: isCredentialVaultFileV1,
    mode: 0o600,
  })
  let envelope = await file.read() ?? emptyEnvelope()
  const memoryEntries = new Map<string, JsonValue>()
  let lifecycle = Promise.resolve()

  const serialize = async<T>(operation: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(operation)
    lifecycle = result.then(() => undefined, () => undefined)
    return result
  }

  const persist = async(mutate: (next: CredentialVaultFileV1) => void): Promise<void> => serialize(async() => {
    const next = cloneEnvelope(envelope)
    mutate(next)
    await file.replace(next)
    // Serialized vault mutations make this post-commit assignment race-free.
    // eslint-disable-next-line require-atomic-updates
    envelope = next
  })

  const read = <T>(ref: CredentialRef): CredentialRead<T> => {
    const entryId = toCredentialEntryId(ref)
    if (memoryEntries.has(entryId)) return { status: 'memory-only', value: memoryEntries.get(entryId) as T }
    const entry = envelope.entries[entryId]
    if (entry == null) return { status: 'missing' }
    try {
      const plaintext = options.cipher.decrypt(Buffer.from(entry.ciphertext, 'base64'))
      return { status: 'available', value: normalizePayload(ref, JSON.parse(plaintext)) as T }
    } catch {
      return { status: 'undecryptable' }
    }
  }

  const write = async<T>(ref: CredentialRef, value: T): Promise<{ persistence: 'encrypted' | 'memory-only' }> => {
    const entryId = toCredentialEntryId(ref)
    const payload = normalizePayload(ref, value)
    const plaintext = canonicalJson(payload)
    if (options.cipher.mode == 'memory-only') {
      memoryEntries.set(entryId, JSON.parse(plaintext) as JsonValue)
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
    return { persistence: 'encrypted' }
  }

  const remove = async(ref: CredentialRef): Promise<void> => {
    const entryId = toCredentialEntryId(ref)
    memoryEntries.delete(entryId)
    if (options.cipher.mode == 'memory-only' || envelope.entries[entryId] == null) return
    await persist(next => {
      Reflect.deleteProperty(next.entries, entryId)
    })
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

  const getMigrationMarker = (name: string): { sourceSha256: string, completedAtMs: number } | null => {
    if (!markerNameIsValid(name) || !Object.hasOwn(envelope.migrationMarkers, name)) return null
    const marker = envelope.migrationMarkers[name]
    return { ...marker }
  }

  const putMigrationMarker = async(name: string, sourceSha256: string, completedAtMs: number): Promise<void> => {
    assertMarker(name, sourceSha256, completedAtMs)
    if (options.cipher.mode == 'memory-only') {
      envelope.migrationMarkers[name] = { sourceSha256, completedAtMs }
      return
    }
    await persist(next => {
      next.migrationMarkers[name] = { sourceSha256, completedAtMs }
    })
  }

  const flush = async(): Promise<void> => {
    await lifecycle
    if (options.cipher.mode == 'encrypted') await file.flush()
  }

  return { read, write, remove, verify, getMigrationMarker, putMigrationMarker, flush }
}
