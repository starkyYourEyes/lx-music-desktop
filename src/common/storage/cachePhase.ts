import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from './canonicalJson'
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

export interface CachePhase4Result {
  schemaVersion: 6 | 7 | 8
  typedOwnershipVerified: boolean
}

export const storageFramedSha256 = (domain: string, payload: JsonValue): string => {
  const domainBytes = Buffer.from(domain, 'utf8')
  const jsonBytes = Buffer.from(canonicalJson(payload), 'utf8')
  const domainLength = Buffer.allocUnsafe(4)
  const jsonLength = Buffer.allocUnsafe(4)
  domainLength.writeUInt32BE(domainBytes.length)
  jsonLength.writeUInt32BE(jsonBytes.length)
  return createHash('sha256')
    .update(domainLength).update(domainBytes)
    .update(jsonLength).update(jsonBytes)
    .digest('hex')
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
  if (!isPlainRecord(value)) invalidPrerequisite()
  const manifest = value as Record<string, unknown>
  if (!hasExactKeys(manifest, ['version', 'checks']) || manifest.version !== 1 || !Array.isArray(manifest.checks) ||
    manifest.checks.length != manifestChecks.length) invalidPrerequisite()
  const rawChecks = manifest.checks as unknown[]

  const checks: Phase3ManifestCheckV1[] = rawChecks.map((check: unknown, index: number) => {
    if (!isPlainRecord(check)) invalidPrerequisite()
    const record = check as Record<string, unknown>
    if (!hasExactKeys(record, ['name', 'version', 'state', 'evidenceSha256']) ||
      record.name !== manifestChecks[index] || record.version !== 1 ||
      (record.state != 'complete' && record.state != 'not-applicable') ||
      typeof record.evidenceSha256 != 'string' || !SHA256_PATTERN.test(record.evidenceSha256)) {
      invalidPrerequisite()
    }
    return {
      name: manifestChecks[index],
      version: 1,
      state: record.state as Phase3CheckState,
      evidenceSha256: record.evidenceSha256 as string,
    }
  })

  if (checks[5].state != 'complete' || checks[6].state != 'complete') invalidPrerequisite()
  return { version: 1, checks }
}

export const getCachePhasePrerequisite = (value?: unknown): CachePhasePrerequisiteV1 => {
  if (!isPlainRecord(value)) invalidPrerequisite()
  const marker = value as Record<string, unknown>
  if (!hasExactKeys(marker, ['name', 'sourceSha256', 'completedAtMs', 'detailsJson']) ||
    marker.name !== CROSS_ARTIFACT_MARKER_NAME || typeof marker.sourceSha256 != 'string' || !SHA256_PATTERN.test(marker.sourceSha256) ||
    !Number.isSafeInteger(marker.completedAtMs) || (marker.completedAtMs as number) < 0 || typeof marker.detailsJson != 'string') {
    invalidPrerequisite()
  }
  const sourceSha256 = marker.sourceSha256 as string
  const completedAtMs = marker.completedAtMs as number
  const detailsJson = marker.detailsJson as string

  let parsed: unknown
  try {
    parsed = JSON.parse(detailsJson)
  } catch {
    invalidPrerequisite()
  }
  const manifest = parseManifest(parsed)
  if (phase3ManifestJson(manifest) != detailsJson || phase3ManifestSha256(manifest) != sourceSha256) {
    invalidPrerequisite()
  }
  return {
    version: 1,
    markerName: CROSS_ARTIFACT_MARKER_NAME,
    sourceSha256,
    completedAtMs,
  }
}
