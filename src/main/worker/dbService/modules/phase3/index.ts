import type { MigrationMarker } from '../../migrations/types'
import { getAppDB } from '../../db'
import { getMigrationMarker } from '../../migrate'
import {
  createPhase3Manifest,
  parsePhase3AttestationCommand,
  phase3ManifestJson,
  phase3ManifestSha256,
  phase3NotApplicableEvidence,
  type Phase3AttestationPrerequisitesV1,
  type Phase3CheckInputV1,
  type Phase3ManifestCheckV1,
  type Phase3PrerequisiteV1,
} from '../../../../../common/storage/phase3'
import {
  getCachePhasePrerequisite as parseCachePhasePrerequisite,
  type CachePhasePrerequisiteV1,
} from '../../../../../common/storage/cachePhase'

const CROSS_ARTIFACT_MARKER_NAME = 'legacy_data_v1.cross_artifact_complete'

interface RawCrossMarkerRow {
  name: unknown
  sourceSha256: unknown
  completedAtMs: unknown
  detailsJson: unknown
}

const phase3Error = (code: string, message: string): Error & { code: string } => {
  const error = new Error(message) as Error & { code: string }
  error.code = code
  return error
}

const prerequisite = <T extends Phase3PrerequisiteV1['markerName']>(
  markerName: T,
  checkName: Phase3ManifestCheckV1['name'],
): Phase3PrerequisiteV1 & { markerName: T } => {
  let marker: MigrationMarker | null
  try {
    marker = getMigrationMarker(getAppDB(), markerName)
  } catch {
    throw phase3Error('phase3_prerequisite_invalid', `Phase 3 prerequisite ${checkName} is invalid`)
  }
  return marker == null
    ? { markerName, state: 'not-applicable', evidenceSha256: phase3NotApplicableEvidence(checkName) }
    : { markerName, state: 'complete', evidenceSha256: marker.sourceSha256 }
}

export const getPhase3AttestationPrerequisites = (value?: unknown): Phase3AttestationPrerequisitesV1 => {
  if (value !== undefined) throw phase3Error('phase3_request_invalid', 'Invalid Phase 3 request')
  return {
    version: 1,
    accountProfile: prerequisite('legacy_data_v1.account_profiles', 'account-profile'),
    phase2: prerequisite('legacy_data_v1.phase2_complete', 'phase2-storage'),
    playbackActivity: prerequisite('legacy_data_v1.playback_activity', 'playback-activity'),
  }
}

export const getCachePhasePrerequisite = (value?: unknown): CachePhasePrerequisiteV1 => {
  if (value !== undefined) throw phase3Error('cache_phase3_prerequisite_invalid', 'cache_phase3_prerequisite_invalid')
  try {
    return parseCachePhasePrerequisite(readCrossMarker(getAppDB()))
  } catch {
    throw phase3Error('cache_phase3_prerequisite_invalid', 'cache_phase3_prerequisite_invalid')
  }
}

const assertPrerequisite = (
  actual: Phase3CheckInputV1,
  expected: Phase3CheckInputV1,
  field: string,
): void => {
  if (actual.state != expected.state || actual.evidenceSha256 != expected.evidenceSha256) {
    throw phase3Error('phase3_attestation_prerequisite_mismatch', `Invalid Phase 3 attestation ${field}`)
  }
}

const readCrossMarker = (db: ReturnType<typeof getAppDB>): MigrationMarker | null => {
  const row = db.prepare<[string]>(`
    SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs,
      details_json AS detailsJson
    FROM migration_markers WHERE name = ?
  `).get(CROSS_ARTIFACT_MARKER_NAME) as RawCrossMarkerRow | undefined
  if (row == null) return null
  if (row.name !== CROSS_ARTIFACT_MARKER_NAME || typeof row.sourceSha256 != 'string' ||
    !Number.isSafeInteger(row.completedAtMs) || (row.completedAtMs as number) < 0 ||
    typeof row.detailsJson != 'string') {
    throw phase3Error('phase3_attestation_conflict', 'Phase 3 attestation marker is corrupt')
  }
  return {
    name: CROSS_ARTIFACT_MARKER_NAME,
    sourceSha256: row.sourceSha256,
    completedAtMs: row.completedAtMs as number,
    detailsJson: row.detailsJson,
  }
}

const matchesImmutableMarker = (actual: MigrationMarker, expected: MigrationMarker): boolean =>
  actual.name == expected.name && actual.sourceSha256 == expected.sourceSha256 &&
  actual.detailsJson == expected.detailsJson

const matchesExactMarker = (actual: MigrationMarker, expected: MigrationMarker): boolean =>
  matchesImmutableMarker(actual, expected) && actual.completedAtMs == expected.completedAtMs

export const completePhase3Attestation = (value: unknown): MigrationMarker => {
  let command
  try {
    command = parsePhase3AttestationCommand(value)
  } catch (error) {
    if (error instanceof Error) {
      throw phase3Error('phase3_attestation_invalid', error.message)
    }
    throw phase3Error('phase3_attestation_invalid', 'Invalid Phase 3 attestation')
  }
  const prerequisites = getPhase3AttestationPrerequisites()
  assertPrerequisite(command.checks.accountProfile, prerequisites.accountProfile, 'accountProfile')
  assertPrerequisite(command.checks.phase2, prerequisites.phase2, 'phase2')
  assertPrerequisite(command.checks.playbackActivity, prerequisites.playbackActivity, 'playbackActivity')

  const manifest = createPhase3Manifest(command)
  const expected: MigrationMarker = {
    name: CROSS_ARTIFACT_MARKER_NAME,
    sourceSha256: phase3ManifestSha256(manifest),
    completedAtMs: command.completedAtMs,
    detailsJson: phase3ManifestJson(manifest),
  }
  const db = getAppDB()
  return db.transaction(() => {
    let existing: MigrationMarker | null
    try {
      existing = readCrossMarker(db)
    } catch {
      throw phase3Error('phase3_attestation_conflict', 'Phase 3 attestation marker is corrupt')
    }
    if (existing != null) {
      if (!matchesImmutableMarker(existing, expected)) {
        throw phase3Error('phase3_attestation_conflict', 'Phase 3 attestation marker conflict')
      }
      return existing
    }

    try {
      db.prepare(`
        INSERT INTO migration_markers (name, source_sha256, completed_at_ms, details_json)
        VALUES (?, ?, ?, ?)
      `).run(expected.name, expected.sourceSha256, expected.completedAtMs, expected.detailsJson)
    } catch {
      throw phase3Error('phase3_attestation_write_failed', 'Phase 3 attestation marker write failed')
    }
    let stored: MigrationMarker | null
    try {
      stored = readCrossMarker(db)
    } catch {
      throw phase3Error('phase3_attestation_verification_failed', 'Phase 3 attestation marker verification failed')
    }
    if (stored == null || !matchesExactMarker(stored, expected)) {
      throw phase3Error('phase3_attestation_verification_failed', 'Phase 3 attestation marker verification failed')
    }
    return stored
  }).immediate()
}

export type {
  Phase3AttestationCommandV1,
  Phase3AttestationPrerequisitesV1,
} from '../../../../../common/storage/phase3'
