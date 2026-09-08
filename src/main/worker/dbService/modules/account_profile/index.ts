import {
  deleteAccountProfile,
  migrateAccountProfileRows,
  queryAccountProfile,
  upsertAccountProfileRow,
} from './dbHelper'
import type { MigrationMarker } from '../../migrations/types'

export type AccountProfileProvider = 'netease' | 'qq_music' | 'kugou'

export interface AccountProfileRow {
  provider: AccountProfileProvider
  profileJson: string
  updatedAtMs: number
}

export const getAccountProfile = (provider: AccountProfileProvider): AccountProfileRow | null =>
  queryAccountProfile(provider)

export const upsertAccountProfile = (row: AccountProfileRow): void => {
  upsertAccountProfileRow(row)
}

export const removeAccountProfile = (provider: AccountProfileProvider): void => {
  deleteAccountProfile(provider)
}

export const migrateLegacyAccountProfiles = (input: {
  rows: AccountProfileRow[]
  marker: MigrationMarker
}): void => {
  migrateAccountProfileRows(input.rows, input.marker)
}
