import type fs from 'node:fs'
import type { MigrationLease } from './migrationLease'

export interface DirectoryManifestEntry {
  path: string
  type: 'directory' | 'file'
  size?: number
  hash?: string
}

export interface DirectoryPromotionOptions {
  fsApi?: typeof fs
  rootPath: string
  sourcePath: string
  destinationPath: string
  stagePrefix: string
  runId: string
  lease: MigrationLease
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
  writePayloadMarker?: (input: {
    payloadPath: string
    sourceManifest: DirectoryManifestEntry[]
    copiedManifest: DirectoryManifestEntry[]
  }) => Promise<void> | void
  beforePromotion?: (input: {
    payloadPath: string
    sourceManifest: DirectoryManifestEntry[]
    destinationManifest: DirectoryManifestEntry[]
    sourceManifestHash: string
    destinationManifestHash: string
  }) => Promise<void> | void
}

// The public migration contract intentionally mirrors the task-level result union shape.
// eslint-disable-next-line @typescript-eslint/consistent-type-definitions
export type DirectoryPromotionResult = {
  status: 'promoted' | 'destination-exists' | 'failed'
  stagePath?: string
  sourceManifest?: DirectoryManifestEntry[]
  destinationManifest?: DirectoryManifestEntry[]
  sourceManifestHash?: string
  destinationManifestHash?: string
  error?: unknown
}

export class DirectorySourceChangedError extends Error {}
export class UnsupportedDirectoryEntryError extends Error {}
export const STAGE_MARKER_FILE: string

export const assertDirectChild: (rootPath: string, candidatePath: string) => string
export const createDirectoryManifest: (
  fsApi: typeof fs,
  rootPath: string,
) => Promise<DirectoryManifestEntry[]>
export const ensureDirectory: (
  fsApi: typeof fs,
  directoryPath: string,
  logger?: Pick<Console, 'error'>,
) => boolean
export const getUsableDirectory: (fsApi: typeof fs, directoryPath: string) => boolean
export const hashManifest: (manifest: DirectoryManifestEntry[]) => string
export const isSameNode: (left: fs.Stats, right: fs.Stats) => boolean
export const manifestsMatch: (left: DirectoryManifestEntry[], right: DirectoryManifestEntry[]) => boolean
export function copyDirectoryWithManifestPromotion(
  options: DirectoryPromotionOptions,
): Promise<DirectoryPromotionResult>
