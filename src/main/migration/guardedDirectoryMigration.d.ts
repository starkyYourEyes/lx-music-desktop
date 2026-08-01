import type fs from 'node:fs'

export interface DirectoryManifestEntry {
  path: string
  type: 'directory' | 'file'
  size?: number
  hash?: string
}

export interface MigrationLock {
  fd: number
  identity: fs.Stats
  lockPath: string
  owner: { version: 1, pid: number, nonce: string, createdAt: string }
}

export class DirectorySourceChangedError extends Error {}
export class UnsupportedDirectoryEntryError extends Error {}
export const STAGE_MARKER_FILE: string

export const acquireMigrationLock: (options: {
  fsApi?: typeof fs
  rootPath: string
  lockPath: string
  isProcessAlive?: (pid: number) => boolean
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}) => MigrationLock | { error: unknown }

export const releaseMigrationLock: (options: {
  fsApi?: typeof fs
  lock: MigrationLock
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}) => void

export const assertDirectChild: (rootPath: string, candidatePath: string) => string
export const createDirectoryManifest: (fsApi: typeof fs, rootPath: string) => DirectoryManifestEntry[]
export const defaultIsProcessAlive: (pid: number) => boolean
export const ensureDirectory: (fsApi: typeof fs, directoryPath: string, logger?: Pick<Console, 'error'>) => boolean
export const getUsableDirectory: (fsApi: typeof fs, directoryPath: string) => boolean
export const hashManifest: (manifest: DirectoryManifestEntry[]) => string
export const isSameNode: (left: fs.Stats, right: fs.Stats) => boolean
export const manifestsMatch: (left: DirectoryManifestEntry[], right: DirectoryManifestEntry[]) => boolean
export const removeStaleOwnedStages: (options: {
  fsApi: typeof fs
  rootPath: string
  stagePrefix: string
  logger?: Pick<Console, 'warn'>
}) => void

export const copyDirectoryWithManifestPromotion: (options: {
  fsApi?: typeof fs
  rootPath: string
  sourcePath: string
  destinationPath: string
  stagePrefix: string
  runId: string
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
  writePayloadMarker?: (input: {
    payloadPath: string
    sourceManifest: DirectoryManifestEntry[]
    copiedManifest: DirectoryManifestEntry[]
  }) => void
  beforePromotion?: (input: {
    payloadPath: string
    sourceManifest: DirectoryManifestEntry[]
    destinationManifest: DirectoryManifestEntry[]
    sourceManifestHash: string
    destinationManifestHash: string
  }) => void
  cleanupWarning?: string
}) => {
  status: 'promoted' | 'destination-exists' | 'failed'
  stagePath?: string
  sourceManifest?: DirectoryManifestEntry[]
  destinationManifest?: DirectoryManifestEntry[]
  sourceManifestHash?: string
  destinationManifestHash?: string
  error?: unknown
}
