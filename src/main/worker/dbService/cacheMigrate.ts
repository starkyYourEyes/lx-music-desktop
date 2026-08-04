import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CACHE_SCHEMA_SOURCE } from './cacheTables'

export const CACHE_SCHEMA_VERSION = 1 as const
export const CACHE_MIGRATION_NAME = 'cache_schema_v1' as const
export const CACHE_MIGRATION_CHECKSUM = createHash('sha256').update(CACHE_SCHEMA_SOURCE).digest('hex')

const assertTimestamp = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('cache_schema_invalid')
}

export const bootstrapCacheSchema = (db: Database.Database, appliedAtMs: number): void => {
  assertTimestamp(appliedAtMs)
  db.transaction(() => {
    const existing = db.prepare(`
      SELECT count(*) AS count FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND type IN ('table', 'index', 'view', 'trigger')
    `).get() as { count: number }
    if (existing.count != 0 || db.pragma('user_version', { simple: true }) != 0) {
      throw new Error('cache_schema_invalid')
    }
    db.exec(CACHE_SCHEMA_SOURCE)
    db.prepare(`
      INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM, appliedAtMs)
    db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`)
  }).immediate()
}
