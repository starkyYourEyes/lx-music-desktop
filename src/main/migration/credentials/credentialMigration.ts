import { sha256Canonical, type JsonValue } from '../../../common/storage/canonicalJson'
import type { AccountProfileRow } from '../../worker/dbService/modules/account_profile'
import type { CredentialVault } from '../../storage/credentials/credentialVault'
import { collectLegacyCredentialInventory, type LegacyAccountProfile } from './legacySources'
import { redactLegacySecrets } from './redactLegacySecrets'

export type CredentialMigrationResult =
  | { status: 'complete', encryptedEntries: number, memoryOnlyEntries: number, profiles: number }
  | { status: 'secure-storage-unavailable', volatileEntries: number }

interface DatabaseMigrationMarker {
  name: string
  sourceSha256: string
  completedAtMs: number
  detailsJson: string
}

export interface CredentialMigrationDeps {
  dataRoot: string
  vault: Pick<CredentialVault, 'write' | 'verify' | 'getMigrationMarker' | 'putMigrationMarker'>
  profiles: {
    migrateLegacyAccountProfiles: (input: { rows: AccountProfileRow[], marker: DatabaseMigrationMarker }) => Promise<void> | void
    getMigrationMarker?: (name: string) => Promise<DatabaseMigrationMarker | null> | DatabaseMigrationMarker | null
  }
  now?: () => number
  failAt?: 'after-vault-write' | 'after-profile-write' | 'after-source-redaction'
}

const profileMarkerName = 'legacy_data_v1.account_profiles'
const credentialMarkerName = 'legacy_data_v1.credentials'

const toProfileRows = (profiles: readonly LegacyAccountProfile[]): AccountProfileRow[] => profiles.map(profile => ({ ...profile }))

const failIfRequested = (deps: CredentialMigrationDeps, stage: CredentialMigrationDeps['failAt']): void => {
  if (deps.failAt == stage) throw new Error('injected failure')
}

export const migrateLegacyCredentials = async(deps: CredentialMigrationDeps): Promise<CredentialMigrationResult> => {
  const inventory = await collectLegacyCredentialInventory(deps.dataRoot)
  const now = deps.now ?? Date.now
  let encryptedEntries = 0
  let memoryOnlyEntries = 0

  for (const source of inventory.credentials) {
    const existing = deps.vault.getMigrationMarker(source.markerName)
    const persisted = await deps.vault.write(source.ref, source.value)
    if (!await deps.vault.verify(source.ref, source.value)) throw new Error('Credential migration destination verification failed')
    if (existing == null || existing.sourceSha256 != source.sourceSha256) {
      await deps.vault.putMigrationMarker(source.markerName, source.sourceSha256, now())
    }
    if (persisted.persistence == 'encrypted') encryptedEntries++
    else memoryOnlyEntries++
  }
  if (inventory.credentials.length) {
    await deps.vault.putMigrationMarker(
      credentialMarkerName,
      sha256Canonical({ version: 1, sources: inventory.credentials.map(source => ({ markerName: source.markerName, sourceSha256: source.sourceSha256 })) }),
      now(),
    )
  }
  failIfRequested(deps, 'after-vault-write')

  const profileRows = toProfileRows(inventory.profiles)
  if (profileRows.length) {
    const marker: DatabaseMigrationMarker = {
      name: profileMarkerName,
      sourceSha256: sha256Canonical({ version: 1, rows: profileRows as unknown as JsonValue[] }),
      completedAtMs: now(),
      detailsJson: JSON.stringify({ version: 1, profileCount: profileRows.length }),
    }
    await deps.profiles.migrateLegacyAccountProfiles({ rows: profileRows, marker })
  }
  failIfRequested(deps, 'after-profile-write')

  if (inventory.credentials.length) await redactLegacySecrets(inventory.credentials)
  failIfRequested(deps, 'after-source-redaction')

  return memoryOnlyEntries > 0
    ? { status: 'secure-storage-unavailable', volatileEntries: memoryOnlyEntries }
    : { status: 'complete', encryptedEntries, memoryOnlyEntries, profiles: profileRows.length }
}
