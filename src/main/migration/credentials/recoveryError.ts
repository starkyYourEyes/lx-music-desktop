import path from 'node:path'

export type CredentialMigrationRecoveryCode =
  | 'credentials.sync_metadata_invalid'
  | 'credentials.sync_metadata_changed_after_inventory'

export class CredentialMigrationRecoveryError extends Error {
  override readonly name = 'CredentialMigrationRecoveryError'

  constructor(
    readonly code: CredentialMigrationRecoveryCode,
    readonly affectedPath: string,
  ) {
    super(code)
  }
}

export const createSyncMetadataRecoveryError = (
  code: CredentialMigrationRecoveryCode,
  dataRoot: string,
  affectedPath: string,
): CredentialMigrationRecoveryError => {
  const root = path.resolve(dataRoot)
  const candidate = path.resolve(affectedPath)
  const allowed = [
    path.join(root, 'sync', 'client', 'servers.v1.json'),
    path.join(root, 'sync', 'server', 'devices.v2.json'),
  ]
  if (!allowed.includes(candidate)) throw new Error('Invalid sync metadata recovery path')
  return new CredentialMigrationRecoveryError(code, candidate)
}

export const isCredentialMigrationRecoveryError = (
  error: unknown,
): error is CredentialMigrationRecoveryError => error instanceof CredentialMigrationRecoveryError
