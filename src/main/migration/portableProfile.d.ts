import type fs from 'node:fs'
import type { NodeIdentity } from '../storage/directDirectory'

export type PortableJournalStateV2 =
  | 'promoted'
  | 'typed-only-acknowledged'
  | 'retirement-intent'
  | 'retirement-isolated'
  | 'retired'
  | 'retired-retained'

export interface PortableRetirementEvidenceV2 {
  isolationBasename: string
  isolationIdentity: NodeIdentity
  sourceIdentity: NodeIdentity
  sourceManifestHash: string
  destinationManifestHash: string
}

export interface PortableJournalV2 {
  version: 2
  sourceManifestHash: string
  destinationManifestHash: string
  sourceIdentity: NodeIdentity
  destinationIdentity: NodeIdentity
  userDataIdentity: NodeIdentity
  promotionRunId: string
  preparationRunId: string
  acknowledgementRunId: string | null
  state: PortableJournalStateV2
  retirement: PortableRetirementEvidenceV2 | null
}

export interface PortableProfileStartupToken {
  readonly version: 1
  readonly portableRoot: string
  readonly promotionRunId: string
  readonly startupRunId: string
  readonly destinationIdentity: Readonly<{ dev: string, ino: string }>
}

export type PortableProfilePreparationState =
  | 'source-missing'
  | 'promoted'
  | 'already-promoted'
  | 'already-acknowledged'
  | 'failed'

export interface PortableProfilePreparationResult {
  state: PortableProfilePreparationState
  portableRoot: string
  userDataPath: string
  sourcePath: string
  destinationPath: string
  lockPath: string
  journalPath: string
  receiptPath: string
  stagePrefix: string
  stagePath?: string
  token?: PortableProfileStartupToken
  error?: unknown
}

export interface PortableProfileOptions {
  portableRoot: string
  runId?: string
  fsApi?: typeof fs
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}

export interface PortableProfileRetirementOptions extends PortableProfileOptions {
  beforeSourceRetirement?: () => void | Promise<void>
  beforeSourceRename?: () => void | Promise<void>
  afterJournalWrite?: (journal: PortableJournalV2) => void | Promise<void>
}

export const PORTABLE_PROFILE_JOURNAL_FILE: string
export const PORTABLE_PROFILE_LOCK_FILE: string
export const PORTABLE_PROFILE_RECEIPT_FILE: string
export const PORTABLE_PROFILE_STAGE_PREFIX: string

export const preparePortableProfile: (options: PortableProfileOptions) => Promise<PortableProfilePreparationResult>

export const acknowledgePortableProfileStartup: (
  token: PortableProfileStartupToken,
  options?: Omit<PortableProfileOptions, 'portableRoot' | 'runId'>,
) => Promise<{ state: 'typed-only-acknowledged' }>

export interface PortableProfileRetirementResult extends Omit<PortableProfilePreparationResult, 'state' | 'token'> {
  state: 'not-acknowledged' | 'same-startup' | 'already-retired' | 'retired' | 'failed'
}

export const retireAcknowledgedPortableSource: (
  options: PortableProfileRetirementOptions,
) => Promise<PortableProfileRetirementResult>
