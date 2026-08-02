import type Database from 'better-sqlite3'

export interface MigrationContext {
  readonly appliedAtMs: number
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
