import { DEFAULT_SETTING } from '@common/constants'
import { type CatalogPreferencesV1 } from '@common/storage/stateContracts'
import { parseCatalogPreferences } from '@common/storage/stateValidation'
import { assertBoundedString, assertRecord } from '@common/storage/validation'

const STORAGE_SCHEMA_VERSION = 1
const MAX_VERSION_LENGTH = 256
const webDAVCredentialSettingKeys = ['webdav.username', 'webdav.password'] as const

type WebDAVCredentialSettingKey = typeof webDAVCredentialSettingKeys[number]
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
const assertStorageRecord: (value: unknown, field: string) => asserts value is Record<string, unknown> = assertRecord
const assertStorageString: (value: unknown, field: string, minimum: number, maximum: number) => asserts value is string = assertBoundedString

export type PersistedAppSettingV1 = Omit<LX.AppSetting, WebDAVCredentialSettingKey>

export interface SettingsDocumentV1 {
  storageSchemaVersion: 1
  version: string
  setting: PersistedAppSettingV1
  catalogPreferences: CatalogPreferencesV1
}

const invalidField = (field: string): never => {
  throw new Error(`Invalid ${field}`)
}

const assertDataRecord: (value: unknown, field: string) => asserts value is Record<string, unknown> = (value, field) => {
  assertStorageRecord(value, field)
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key != 'string' || descriptor == null || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalidField(field)
    }
  }
}

const assertExactKeys = (value: Record<string, unknown>, field: string, keys: readonly string[]): void => {
  if (Object.keys(value).length != keys.length || keys.some(key => !Object.hasOwn(value, key))) invalidField(field)
}

const assertVersion: (value: unknown, field: string) => asserts value is string = (value, field) => {
  assertStorageString(value, field, 1, MAX_VERSION_LENGTH)
}

const cloneJsonValue = (value: unknown, field: string, ancestors: Set<object>): JsonValue => {
  if (value === null || typeof value == 'string' || typeof value == 'boolean') return value
  if (typeof value == 'number') {
    if (!Number.isFinite(value)) invalidField(field)
    return value
  }
  if (typeof value != 'object' || ancestors.has(value)) invalidField(field)

  const objectValue = value as object
  ancestors.add(objectValue)
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length != value.length + 1) invalidField(field)
      const result: JsonValue[] = []
      for (let index = 0; index < value.length; index++) {
        if (!Object.hasOwn(value, index)) invalidField(field)
        result.push(cloneJsonValue(value[index], field, ancestors))
      }
      return result
    }

    assertDataRecord(value, field)
    const result: Record<string, JsonValue> = {}
    for (const [key, item] of Object.entries(value)) result[key] = cloneJsonValue(item, field, ancestors)
    return result
  } finally {
    ancestors.delete(objectValue)
  }
}

const parsePersistedSetting = (value: unknown, stripLegacyCredentials: boolean): PersistedAppSettingV1 => {
  assertDataRecord(value, 'setting')
  if (!stripLegacyCredentials && webDAVCredentialSettingKeys.some(key => Object.hasOwn(value, key))) invalidField('setting')

  const result: Record<string, JsonValue> = {}
  const ancestors = new Set<object>([value])
  for (const [key, item] of Object.entries(value)) {
    if (webDAVCredentialSettingKeys.includes(key as WebDAVCredentialSettingKey)) continue
    result[key] = cloneJsonValue(item, 'setting', ancestors)
  }
  assertVersion(result.version, 'setting version')
  return result as PersistedAppSettingV1
}

const parseReplacementSetting = (value: unknown): PersistedAppSettingV1 => {
  assertDataRecord(value, 'setting')
  for (const key of webDAVCredentialSettingKeys) {
    if (Object.hasOwn(value, key) && value[key] !== '') {
      throw new Error('WebDAV credentials cannot be written through settings')
    }
  }
  return parsePersistedSetting(
    Object.fromEntries(Object.entries(value).filter(([key]) => !webDAVCredentialSettingKeys.includes(key as WebDAVCredentialSettingKey))),
    false,
  )
}

const getDefaultCatalogPreferences = (): CatalogPreferencesV1 => parseCatalogPreferences({
  version: 1,
  leaderboard: { ...DEFAULT_SETTING.leaderboard },
  songList: { ...DEFAULT_SETTING.songList },
  search: { ...DEFAULT_SETTING.search },
})

export const parseSettingsDocument = (value: unknown): SettingsDocumentV1 => {
  assertDataRecord(value, 'settings document')
  const isVersioned = Object.hasOwn(value, 'storageSchemaVersion')
  assertExactKeys(
    value,
    'settings document',
    isVersioned
      ? ['storageSchemaVersion', 'version', 'setting', 'catalogPreferences']
      : ['version', 'setting'],
  )
  assertVersion(value.version, 'version')

  if (!isVersioned) {
    return {
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      version: value.version,
      setting: parsePersistedSetting(value.setting, true),
      catalogPreferences: getDefaultCatalogPreferences(),
    }
  }

  if (value.storageSchemaVersion !== STORAGE_SCHEMA_VERSION) invalidField('storageSchemaVersion')
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    version: value.version,
    setting: parsePersistedSetting(value.setting, false),
    catalogPreferences: parseCatalogPreferences(value.catalogPreferences),
  }
}

export const replaceOrdinarySettings = (
  current: SettingsDocumentV1,
  setting: LX.AppSetting,
): SettingsDocumentV1 => {
  const currentDocument = parseSettingsDocument(current)
  const persistedSetting = parseReplacementSetting(setting)
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    version: persistedSetting.version,
    setting: persistedSetting,
    catalogPreferences: parseCatalogPreferences(currentDocument.catalogPreferences),
  }
}

export const replaceCatalogPreferences = (
  current: SettingsDocumentV1,
  preferences: CatalogPreferencesV1,
): SettingsDocumentV1 => {
  const currentDocument = parseSettingsDocument(current)
  return {
    storageSchemaVersion: STORAGE_SCHEMA_VERSION,
    version: currentDocument.version,
    setting: parsePersistedSetting(currentDocument.setting, false),
    catalogPreferences: parseCatalogPreferences(preferences),
  }
}
