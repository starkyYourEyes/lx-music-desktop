import type fs from 'node:fs'

export type MigrationStatus = 'migrated' | 'current-exists' | 'legacy-missing' | 'failed'

export interface MigrationResult {
  status: MigrationStatus
  legacyPath: string
  userDataPath: string
  tempPath: string
  error?: unknown
}

export const LEGACY_USER_DATA_DIR_NAME: string
export const MIGRATION_MARKER_FILE: string

export const getPortableUserDataPaths: (options: {
  platform: NodeJS.Platform
  executablePath: string
  pathExists?: (candidate: string) => boolean
}) => { appDataPath: string, userDataPath: string } | null

export const migrateLegacyUserData: (options: {
  appDataPath: string
  currentDirName?: string
  fsApi?: typeof fs
  logger?: Pick<Console, 'info' | 'error'>
}) => MigrationResult
