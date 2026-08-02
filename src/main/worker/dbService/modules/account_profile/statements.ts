import { getAppDB } from '../../db'
import type { AccountProfileProvider, AccountProfileRow } from './index'

interface AccountProfileDatabaseRow {
  provider: AccountProfileProvider
  profile_json: string
  updated_at_ms: number
}

export const createGetAccountProfileStatement = () => getAppDB().prepare<[AccountProfileProvider], AccountProfileDatabaseRow>(`
  SELECT provider, profile_json, updated_at_ms
  FROM account_profiles
  WHERE provider = ?
`)

export const createUpsertAccountProfileStatement = () => getAppDB().prepare<[AccountProfileRow]>(`
  INSERT INTO account_profiles (provider, profile_json, updated_at_ms)
  VALUES (@provider, @profileJson, @updatedAtMs)
  ON CONFLICT(provider) DO UPDATE SET
    profile_json = excluded.profile_json,
    updated_at_ms = excluded.updated_at_ms
`)

export const createRemoveAccountProfileStatement = () => getAppDB().prepare<[AccountProfileProvider]>(`
  DELETE FROM account_profiles
  WHERE provider = ?
`)
