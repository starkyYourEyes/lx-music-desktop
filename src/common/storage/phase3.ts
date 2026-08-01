import { canonicalJson, sha256Canonical, type JsonValue } from './canonicalJson'

export type Phase3CheckState = 'complete' | 'not-applicable'

export type Phase3CheckKey =
  | 'credentials'
  | 'accountProfile'
  | 'phase2'
  | 'playbackActivity'
  | 'quarantine'
  | 'playbackWriter'
  | 'playbackReader'

export interface Phase3CheckInputV1 {
  state: Phase3CheckState
  evidenceSha256: string
}

export interface Phase3AttestationCommandV1 {
  version: 1
  completedAtMs: number
  checks: Record<Phase3CheckKey, Phase3CheckInputV1>
}

export interface Phase3ManifestCheckV1 extends Phase3CheckInputV1 {
  name:
  | 'credentials'
  | 'account-profile'
  | 'phase2-storage'
  | 'playback-activity'
  | 'quarantine'
  | 'playback-writer'
  | 'playback-reader'
  version: 1
}

export interface Phase3ManifestV1 {
  version: 1
  checks: Phase3ManifestCheckV1[]
}

export interface Phase3PrerequisiteV1 extends Phase3CheckInputV1 {
  markerName:
  | 'legacy_data_v1.account_profiles'
  | 'legacy_data_v1.phase2_complete'
  | 'legacy_data_v1.playback_activity'
}

export interface Phase3AttestationPrerequisitesV1 {
  version: 1
  accountProfile: Phase3PrerequisiteV1 & { markerName: 'legacy_data_v1.account_profiles' }
  phase2: Phase3PrerequisiteV1 & { markerName: 'legacy_data_v1.phase2_complete' }
  playbackActivity: Phase3PrerequisiteV1 & { markerName: 'legacy_data_v1.playback_activity' }
}

export interface Phase3ActivityEvidence {
  sourceState: Phase3CheckState
  legacySourceSha256: string | null
  quarantineRequired: boolean
  quarantineSourceSha256: string | null
  quarantineEncrypted: boolean
  quarantineVerified: boolean
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/
const checkOrder: Array<{ key: Phase3CheckKey, name: Phase3ManifestCheckV1['name'] }> = [
  { key: 'credentials', name: 'credentials' },
  { key: 'accountProfile', name: 'account-profile' },
  { key: 'phase2', name: 'phase2-storage' },
  { key: 'playbackActivity', name: 'playback-activity' },
  { key: 'quarantine', name: 'quarantine' },
  { key: 'playbackWriter', name: 'playback-writer' },
  { key: 'playbackReader', name: 'playback-reader' },
]

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value)
  return actual.length == keys.length && actual.every(key => typeof key == 'string' && keys.includes(key))
}

const parseCheck = (value: unknown, key: Phase3CheckKey): Phase3CheckInputV1 => {
  if (!isPlainRecord(value) || !exactKeys(value, ['state', 'evidenceSha256']) ||
    (value.state != 'complete' && value.state != 'not-applicable') ||
    typeof value.evidenceSha256 != 'string' || !SHA256_PATTERN.test(value.evidenceSha256)) {
    throw new Error(`Invalid Phase 3 attestation ${key}`)
  }
  if ((key == 'playbackWriter' || key == 'playbackReader') && value.state != 'complete') {
    throw new Error(`Invalid Phase 3 attestation ${key}`)
  }
  return { state: value.state as Phase3CheckState, evidenceSha256: value.evidenceSha256 }
}

export const parsePhase3AttestationCommand = (value: unknown): Phase3AttestationCommandV1 => {
  if (!isPlainRecord(value) || !exactKeys(value, ['version', 'completedAtMs', 'checks']) || value.version !== 1 ||
    !Number.isSafeInteger(value.completedAtMs) || (value.completedAtMs as number) < 0 ||
    !isPlainRecord(value.checks) || !exactKeys(value.checks, checkOrder.map(check => check.key))) {
    throw new Error('Invalid Phase 3 attestation command')
  }
  const checks = value.checks
  return {
    version: 1,
    completedAtMs: value.completedAtMs as number,
    checks: Object.fromEntries(checkOrder.map(({ key }) => [key, parseCheck(checks[key], key)])) as Phase3AttestationCommandV1['checks'],
  }
}

export const createPhase3Manifest = (command: Phase3AttestationCommandV1): Phase3ManifestV1 => ({
  version: 1,
  checks: checkOrder.map(({ key, name }) => ({
    name,
    version: 1,
    ...command.checks[key],
  })),
})

export const phase3ManifestJson = (manifest: Phase3ManifestV1): string =>
  canonicalJson(manifest as unknown as JsonValue)

export const phase3ManifestSha256 = (manifest: Phase3ManifestV1): string =>
  sha256Canonical(manifest as unknown as JsonValue)

export const phase3NotApplicableEvidence = (name: Phase3ManifestCheckV1['name']): string =>
  sha256Canonical({ version: 1, name, state: 'not-applicable' })

export const phase3Evidence = (name: string, value: Record<string, JsonValue>): string =>
  sha256Canonical({ version: 1, name, ...value })
