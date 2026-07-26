export interface CreateUserApiSyncDataOptions {
  updatedAt?: number
  onScriptError?: (err: Error, api: LX.UserApi.UserApiInfo) => void
}

export const decodeUserApiScript: (script: string | null | undefined) => string

export const createUserApiSyncData: (
  apis: LX.UserApi.UserApiInfo[],
  getScript: (id: string) => string | Promise<string>,
  options?: CreateUserApiSyncDataOptions
) => Promise<LX.Sync.UserApi.Data>

export const createStableUserApiSyncData: (data: LX.Sync.UserApi.Data) => {
  source: 'desktop'
  apis: LX.Sync.UserApi.ApiInfo[]
}

export const createUserApiSyncMeta: (data: LX.Sync.UserApi.Data) => LX.Sync.UserApi.Meta

export const createUserApiSyncMD5: (data: LX.Sync.UserApi.Data) => string

/**
 * Validates and freezes the accepted data, API array, API records, and remote metadata.
 * Returns the same frozen data object.
 */
export const assertUserApiSyncData: (data: unknown) => LX.Sync.UserApi.Data

export const mergeUserApiSyncData: (
  baseData: LX.Sync.UserApi.Data,
  incomingData: LX.Sync.UserApi.Data,
  options?: { updatedAt?: number }
) => LX.Sync.UserApi.Data
