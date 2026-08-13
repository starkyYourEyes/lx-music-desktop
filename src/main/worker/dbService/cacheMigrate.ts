import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { CACHE_SCHEMA_SOURCE, CACHE_SCHEMA_V1_SOURCE } from './cacheTables'

export const CACHE_SCHEMA_V1_VERSION = 1 as const
export const CACHE_SCHEMA_VERSION = 2 as const
export const CACHE_MIGRATION_V1_NAME = 'cache_schema_v1' as const
export const CACHE_MIGRATION_V1_CHECKSUM = createHash('sha256')
  .update(CACHE_SCHEMA_V1_SOURCE).digest('hex')

export const CACHE_SCHEMA_V2_MIGRATION_SOURCE = `CREATE TABLE music_urls_v2 (
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  url TEXT NOT NULL,
  reported_quality TEXT CHECK(
    reported_quality IS NULL OR
    reported_quality IN ('128k','192k','320k','flac','flac24bit','ape','wav')
  ),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, account_scope, source_track_id, quality)
);

INSERT INTO music_urls_v2(
  provider, account_scope, source_track_id, quality, url, reported_quality,
  expires_at_ms, created_at_ms, last_accessed_at_ms
)
SELECT provider, account_scope, source_track_id, quality, url, NULL,
  expires_at_ms, created_at_ms, last_accessed_at_ms
FROM music_urls;

DROP INDEX music_urls_expiry;
DROP INDEX music_urls_lru;
DROP TABLE music_urls;
ALTER TABLE music_urls_v2 RENAME TO music_urls;

CREATE INDEX music_urls_expiry
ON music_urls(expires_at_ms, provider COLLATE BINARY, account_scope COLLATE BINARY,
  source_track_id COLLATE BINARY, quality COLLATE BINARY);

CREATE INDEX music_urls_lru
ON music_urls(last_accessed_at_ms, created_at_ms, provider COLLATE BINARY,
  account_scope COLLATE BINARY, source_track_id COLLATE BINARY, quality COLLATE BINARY);`

export const CACHE_MIGRATION_NAME = 'cache_schema_v2_reported_quality' as const
export const CACHE_MIGRATION_CHECKSUM = createHash('sha256')
  .update(CACHE_SCHEMA_V2_MIGRATION_SOURCE).digest('hex')

export interface CacheMigrationHooks {
  beforeCommitV2?: () => void
}

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
    `).run(CACHE_SCHEMA_V1_VERSION, CACHE_MIGRATION_V1_NAME, CACHE_MIGRATION_V1_CHECKSUM, appliedAtMs)
    db.prepare(`
      INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM, appliedAtMs)
    db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`)
  }).immediate()
}

export const migrateCacheSchemaV1ToV2 = (
  db: Database.Database,
  appliedAtMs: number,
  verifyFinal: (db: Database.Database) => boolean,
  hooks: CacheMigrationHooks = {},
): void => {
  assertTimestamp(appliedAtMs)
  db.transaction(() => {
    if (db.pragma('user_version', { simple: true }) != CACHE_SCHEMA_V1_VERSION) {
      throw new Error('cache_schema_invalid')
    }
    db.exec(CACHE_SCHEMA_V2_MIGRATION_SOURCE)
    db.prepare(`
      INSERT INTO cache_schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (?, ?, ?, ?)
    `).run(CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM, appliedAtMs)
    db.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`)
    hooks.beforeCommitV2?.()
    if (!verifyFinal(db)) throw new Error('cache_schema_invalid')
  }).immediate()
}
