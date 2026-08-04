import type Database from 'better-sqlite3'
import type { CutoverDetailsV2 } from '../../../migration/cache/cutover'

export interface CacheCleanupMigrationContext {
  readonly cutover: CutoverDetailsV2
  // The migration contract intentionally requires method syntax.
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  assertBackupGuard(): void
}

export interface MigrationContext {
  readonly appliedAtMs: number
  readonly cacheCleanup?: CacheCleanupMigrationContext
}

export interface SchemaMigration {
  version: number
  name: string
  checksum: string
  // The migration contract intentionally requires method syntax.
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  up(db: Database.Database, context: MigrationContext): void
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  verify?(db: Database.Database, context: MigrationContext): void
}

export interface MigrationRunResult {
  fromVersion: number
  toVersion: number
  applied: number[]
}

export interface MigrationMarker {
  name: string
  sourceSha256: string
  completedAtMs: number
  detailsJson: string
}
