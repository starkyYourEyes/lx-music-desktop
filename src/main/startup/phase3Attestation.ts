import {
  parsePhase3AttestationCommand,
  phase3Evidence,
  phase3NotApplicableEvidence,
  type Phase3AttestationCommandV1,
  type Phase3AttestationPrerequisitesV1,
  type Phase3ActivityEvidence,
  type Phase3CheckState,
} from '../../common/storage/phase3'

export interface Phase3CredentialEvidence {
  state: Phase3CheckState
  encrypted: boolean
  vaultReadable: boolean
  profileRepositoryReadable: boolean
  activePlaintextSources: string[]
}

export interface Phase3PlaybackSmokeEvidence {
  version: 1
  writerEvidenceSha256: string
  readerEvidenceSha256: string
}

export interface CreatePhase3AttestationCommandOptions {
  completedAtMs: number
  credential: Phase3CredentialEvidence
  prerequisites: Phase3AttestationPrerequisitesV1
  activity: Phase3ActivityEvidence
  smoke: Phase3PlaybackSmokeEvidence
}

export type { Phase3ActivityEvidence }

const SHA256_PATTERN = /^[0-9a-f]{64}$/

const fail = (field: string): never => {
  const error = new Error(`Phase 3 ${field} evidence is unavailable`) as Error & { code: string }
  error.code = 'phase3_attestation_inputs_invalid'
  throw error
}

const hash = (value: string | null, field: string): string => {
  if (value == null || !SHA256_PATTERN.test(value)) fail(field)
  return value!
}

export const createPhase3AttestationCommand = (
  options: CreatePhase3AttestationCommandOptions,
): Phase3AttestationCommandV1 => {
  if (!options.credential.vaultReadable || !options.credential.profileRepositoryReadable ||
    options.credential.activePlaintextSources.length != 0) fail('credential')
  if (options.credential.state == 'complete' && !options.credential.encrypted) fail('credential')
  if (options.prerequisites.version !== 1 || options.smoke.version !== 1) fail('version')
  if (options.activity.sourceState != options.prerequisites.playbackActivity.state) fail('playback activity')
  if (options.activity.sourceState == 'complete') hash(options.activity.legacySourceSha256, 'legacy source')
  else if (options.activity.legacySourceSha256 != null) fail('legacy source')

  const credential = options.credential.state == 'complete'
    ? {
        state: 'complete' as const,
        evidenceSha256: phase3Evidence('credentials', {
          state: 'complete',
          encrypted: true,
          vaultReadable: true,
          profileRepositoryReadable: true,
          activePlaintextSourceCount: 0,
        }),
      }
    : {
        state: 'not-applicable' as const,
        evidenceSha256: phase3NotApplicableEvidence('credentials'),
      }

  let quarantine: Phase3AttestationCommandV1['checks']['quarantine']
  if (options.activity.quarantineRequired) {
    if (!options.activity.quarantineEncrypted || !options.activity.quarantineVerified ||
      hash(options.activity.legacySourceSha256, 'legacy source') !=
        hash(options.activity.quarantineSourceSha256, 'quarantine source')) fail('quarantine')
    quarantine = {
      state: 'complete',
      evidenceSha256: phase3Evidence('quarantine', {
        state: 'complete',
        sourceSha256: options.activity.legacySourceSha256!,
        encrypted: true,
        verified: true,
      }),
    }
  } else {
    if (options.activity.quarantineEncrypted || options.activity.quarantineVerified ||
      options.activity.quarantineSourceSha256 != null) fail('quarantine')
    quarantine = {
      state: 'not-applicable',
      evidenceSha256: phase3NotApplicableEvidence('quarantine'),
    }
  }

  return parsePhase3AttestationCommand({
    version: 1,
    completedAtMs: options.completedAtMs,
    checks: {
      credentials: credential,
      accountProfile: {
        state: options.prerequisites.accountProfile.state,
        evidenceSha256: options.prerequisites.accountProfile.evidenceSha256,
      },
      phase2: {
        state: options.prerequisites.phase2.state,
        evidenceSha256: options.prerequisites.phase2.evidenceSha256,
      },
      playbackActivity: {
        state: options.prerequisites.playbackActivity.state,
        evidenceSha256: options.prerequisites.playbackActivity.evidenceSha256,
      },
      quarantine,
      playbackWriter: { state: 'complete', evidenceSha256: options.smoke.writerEvidenceSha256 },
      playbackReader: { state: 'complete', evidenceSha256: options.smoke.readerEvidenceSha256 },
    },
  })
}
