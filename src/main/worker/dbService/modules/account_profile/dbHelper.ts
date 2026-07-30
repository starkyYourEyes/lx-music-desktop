import {
  createGetAccountProfileStatement,
  createRemoveAccountProfileStatement,
  createUpsertAccountProfileStatement,
} from './statements'
import { normalizePublicAccountProfile } from '../../../../../common/storage/accountProfile'
import { sha256Canonical, type JsonValue } from '../../../../../common/storage/canonicalJson'
import type { AccountProfileProvider, AccountProfileRow } from './index'
import { getDB } from '../../db'
import { putMigrationMarker } from '../../migrate'
import type { MigrationMarker } from '../../migrations/types'

const providers: readonly AccountProfileProvider[] = ['netease', 'qq_music']

const assertProvider: (provider: unknown) => asserts provider is AccountProfileProvider = provider => {
  if (!providers.includes(provider as AccountProfileProvider)) throw new Error('Invalid account profile provider')
}

const assertPublicProfileJson = (provider: AccountProfileProvider, profileJson: unknown): void => {
  if (typeof profileJson != 'string') throw new Error('Invalid account profile JSON')
  let profile: unknown
  try {
    profile = JSON.parse(profileJson)
  } catch {
    throw new Error('Invalid account profile JSON')
  }
  normalizePublicAccountProfile(provider, profile)
}

const assertRow = (row: AccountProfileRow): void => {
  if (row == null || typeof row != 'object') throw new Error('Invalid account profile row')
  assertProvider(row.provider)
  assertPublicProfileJson(row.provider, row.profileJson)
  if (!Number.isSafeInteger(row.updatedAtMs) || row.updatedAtMs < 0) {
    throw new Error('Invalid account profile timestamp')
  }
}

export const queryAccountProfile = (provider: AccountProfileProvider): AccountProfileRow | null => {
  assertProvider(provider)
  const row = createGetAccountProfileStatement().get(provider)
  if (row == null) return null
  const result = { provider: row.provider, profileJson: row.profile_json, updatedAtMs: row.updated_at_ms }
  assertRow(result)
  return result
}

export const upsertAccountProfileRow = (row: AccountProfileRow): void => {
  assertRow(row)
  createUpsertAccountProfileStatement().run(row)
}

export const deleteAccountProfile = (provider: AccountProfileProvider): void => {
  assertProvider(provider)
  createRemoveAccountProfileStatement().run(provider)
}

export const migrateAccountProfileRows = (rows: AccountProfileRow[], marker: MigrationMarker): void => {
  for (const row of rows) assertRow(row)
  const db = getDB()
  db.transaction(() => {
    for (const row of rows) createUpsertAccountProfileStatement().run(row)
    const storedRows = rows.map(row => queryAccountProfile(row.provider))
    if (storedRows.some(row => row == null) || storedRows.length != rows.length) {
      throw new Error('Account profile migration readback failed')
    }
    const expected = rows.map(row => ({ ...row })).sort((left, right) => left.provider.localeCompare(right.provider))
    const actual = storedRows.map(row => row!).sort((left, right) => left.provider.localeCompare(right.provider))
    if (sha256Canonical(expected as unknown as JsonValue) != sha256Canonical(actual as unknown as JsonValue)) {
      throw new Error('Account profile migration hash verification failed')
    }
    putMigrationMarker(db, marker)
  })()
}
