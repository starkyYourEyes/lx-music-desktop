import {
  phase3ManifestJson,
  phase3ManifestSha256,
  type Phase3CheckState,
  type Phase3ManifestCheckV1,
  type Phase3ManifestV1,
} from './phase3'

const CROSS_ARTIFACT_MARKER_NAME = 'legacy_data_v1.cross_artifact_complete' as const
const SHA256_PATTERN = /^[0-9a-f]{64}$/

const manifestChecks: ReadonlyArray<Phase3ManifestCheckV1['name']> = [
  'credentials',
  'account-profile',
  'phase2-storage',
  'playback-activity',
  'quarantine',
  'playback-writer',
  'playback-reader',
]

export interface CachePhasePrerequisiteV1 {
  version: 1
  markerName: typeof CROSS_ARTIFACT_MARKER_NAME
  sourceSha256: string
  completedAtMs: number
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value == 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) == Object.prototype

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Reflect.ownKeys(value)
  return actual.length == keys.length && actual.every(key => typeof key == 'string' && keys.includes(key))
}

const invalidPrerequisite = (): never => {
  const error = new Error('cache_phase3_prerequisite_invalid') as Error & { code: string }
  error.code = 'cache_phase3_prerequisite_invalid'
  throw error
}

const parseManifest = (value: unknown): Phase3ManifestV1 => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['version', 'checks']) || value.version !== 1 || !Array.isArray(value.checks) ||
    value.checks.length != manifestChecks.length) invalidPrerequisite()

  const checks = value.checks.map((check, index) => {
    if (!isPlainRecord(check) || !hasExactKeys(check, ['name', 'version', 'state', 'evidenceSha256']) ||
      check.name !== manifestChecks[index] || check.version !== 1 ||
      (check.state != 'complete' && check.state != 'not-applicable') ||
      typeof check.evidenceSha256 != 'string' || !SHA256_PATTERN.test(check.evidenceSha256)) {
      invalidPrerequisite()
    }
    return {
      name: manifestChecks[index],
      version: 1,
      state: check.state as Phase3CheckState,
      evidenceSha256: check.evidenceSha256,
    }
  })

  if (checks[5].state != 'complete' || checks[6].state != 'complete') invalidPrerequisite()
  return { version: 1, checks }
}

export const getCachePhasePrerequisite = (value?: unknown): CachePhasePrerequisiteV1 => {
  if (!isPlainRecord(value) || !hasExactKeys(value, ['name', 'sourceSha256', 'completedAtMs', 'detailsJson']) ||
    value.name !== CROSS_ARTIFACT_MARKER_NAME || typeof value.sourceSha256 != 'string' || !SHA256_PATTERN.test(value.sourceSha256) ||
    !Number.isSafeInteger(value.completedAtMs) || value.completedAtMs < 0 || typeof value.detailsJson != 'string') {
    invalidPrerequisite()
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value.detailsJson)
  } catch {
    invalidPrerequisite()
  }
  const manifest = parseManifest(parsed)
  if (phase3ManifestJson(manifest) != value.detailsJson || phase3ManifestSha256(manifest) != value.sourceSha256) {
    invalidPrerequisite()
  }
  return {
    version: 1,
    markerName: CROSS_ARTIFACT_MARKER_NAME,
    sourceSha256: value.sourceSha256,
    completedAtMs: value.completedAtMs,
  }
}
