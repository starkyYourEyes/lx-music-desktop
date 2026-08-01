import type { MigrationMarker } from '../../migrations/types'
import { getDB } from '../../db'
import { getMigrationMarker, putMigrationMarker } from '../../migrate'
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

const CROSS_ARTIFACT_MARKER_NAME = 'legacy_data_v1.cross_artifact_complete'

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
    marker = getMigrationMarker(getDB(), markerName)
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

const assertPrerequisite = (
  actual: Phase3CheckInputV1,
  expected: Phase3CheckInputV1,
  field: string,
): void => {
  if (actual.state != expected.state || actual.evidenceSha256 != expected.evidenceSha256) {
    throw phase3Error('phase3_attestation_prerequisite_mismatch', `Invalid Phase 3 attestation ${field}`)
  }
}

const readCrossMarker = (): MigrationMarker | null => {
  try {
    return getMigrationMarker(getDB(), CROSS_ARTIFACT_MARKER_NAME)
  } catch {
    throw phase3Error('phase3_attestation_conflict', 'Phase 3 attestation marker is corrupt')
  }
}

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
  const existing = readCrossMarker()
  if (existing != null) {
    if (existing.name != expected.name || existing.sourceSha256 != expected.sourceSha256 ||
      existing.detailsJson != expected.detailsJson) {
      throw phase3Error('phase3_attestation_conflict', 'Phase 3 attestation marker conflict')
    }
    return existing
  }

  try {
    putMigrationMarker(getDB(), expected)
  } catch {
    throw phase3Error('phase3_attestation_write_failed', 'Phase 3 attestation marker write failed')
  }
  const stored = readCrossMarker()
  if (stored == null || stored.name != expected.name || stored.sourceSha256 != expected.sourceSha256 ||
    stored.completedAtMs != expected.completedAtMs || stored.detailsJson != expected.detailsJson) {
    throw phase3Error('phase3_attestation_verification_failed', 'Phase 3 attestation marker verification failed')
  }
  return stored
}

export type {
  Phase3AttestationCommandV1,
  Phase3AttestationPrerequisitesV1,
} from '../../../../../common/storage/phase3'
