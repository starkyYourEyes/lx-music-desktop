import { sha256Canonical, type JsonValue } from '../../../common/storage/canonicalJson'
import type { AccountProfileRow } from '../../worker/dbService/modules/account_profile'
import type { CredentialVault } from '../../storage/credentials/credentialVault'
import { toCredentialEntryId } from '../../storage/credentials/types'
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
  vault: Pick<CredentialVault, 'mode' | 'write' | 'verify' | 'getMigrationMarker' | 'putMigrationMarker'>
  profiles: {
    migrateLegacyAccountProfiles: (input: { rows: AccountProfileRow[], marker: DatabaseMigrationMarker }) => Promise<void> | void
  }
  now?: () => number
  failAt?: 'after-vault-write' | 'after-profile-write' | 'after-source-redaction'
}

const profileMarkerName = 'legacy_data_v1.account_profiles'
const credentialMarkerName = 'legacy_data_v1.credentials'
const memoryOnlyMarkerName = 'legacy_data_v1.credentials.memory-only'

const toProfileRows = (profiles: readonly LegacyAccountProfile[]): AccountProfileRow[] => profiles.map(profile => ({ ...profile }))

const failIfRequested = (deps: CredentialMigrationDeps, stage: CredentialMigrationDeps['failAt']): void => {
  if (deps.failAt == stage) throw new Error('injected failure')
}

export const migrateLegacyCredentials = async(deps: CredentialMigrationDeps): Promise<CredentialMigrationResult> => {
  const inventory = await collectLegacyCredentialInventory(deps.dataRoot)
  const now = deps.now ?? Date.now
  if (inventory.credentials.length == 0 && deps.vault.mode == 'memory-only' && deps.vault.getMigrationMarker(memoryOnlyMarkerName) != null) {
    return { status: 'secure-storage-unavailable', volatileEntries: 0 }
  }
  let encryptedEntries = 0
  let memoryOnlyEntries = 0
  const credentialsByDestination = new Map<string, typeof inventory.credentials>()
  for (const source of inventory.credentials) {
    const destination = toCredentialEntryId(source.ref)
    const sources = credentialsByDestination.get(destination) ?? []
    sources.push(source)
    credentialsByDestination.set(destination, sources)
  }

  for (const sources of Array.from(credentialsByDestination.values())) {
    const source = sources[0]
    const persisted = await deps.vault.write(source.ref, source.value)
    if (!await deps.vault.verify(source.ref, source.value)) throw new Error('Credential migration destination verification failed')
    for (const contributingSource of sources) {
      const existing = deps.vault.getMigrationMarker(contributingSource.markerName)
      if (existing == null || existing.sourceId != contributingSource.markerName) {
        await deps.vault.putMigrationMarker(contributingSource.markerName, contributingSource.markerName, now())
      }
    }
    if (persisted.persistence == 'encrypted') encryptedEntries++
    else {
      memoryOnlyEntries++
    }
  }
  if (inventory.credentials.length) {
    await deps.vault.putMigrationMarker(credentialMarkerName, credentialMarkerName, now())
  }
  if (memoryOnlyEntries > 0) {
    await deps.vault.putMigrationMarker(memoryOnlyMarkerName, memoryOnlyMarkerName, now())
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
