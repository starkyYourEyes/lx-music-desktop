import type { NodeIdentity } from '../storage/directDirectory'

export interface MigrationLease {
  rootPath: string
  rootIdentity: NodeIdentity
  lockPath: string
  lockIdentity: NodeIdentity
  assertHeld(): void
}

export function acquireMigrationLease(input: {
  rootPath: string
  lockPath: string
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}): Promise<MigrationLease>

export function releaseMigrationLease(lease: MigrationLease): Promise<void>
