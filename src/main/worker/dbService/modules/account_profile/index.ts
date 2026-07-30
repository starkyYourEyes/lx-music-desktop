import {
  deleteAccountProfile,
  queryAccountProfile,
  upsertAccountProfileRow,
} from './dbHelper'

export type AccountProfileProvider = 'netease' | 'qq_music'

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
