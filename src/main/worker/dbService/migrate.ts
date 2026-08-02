import type Database from 'better-sqlite3'
import { canonicalJson, type JsonValue } from '../../../common/storage/canonicalJson'
import tables, { LEGACY_DB_VERSION } from './tables'
import { migrations } from './migrations'
import type { MigrationContext, MigrationMarker, MigrationRunResult, SchemaMigration } from './migrations/types'

const FIRST_MIGRATION_VERSION = 3
const MAX_ORDINARY_SCHEMA_VERSION = 6
const checksumPattern = /^[0-9a-f]{64}$/

const createLedgerSql = `CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK(typeof(applied_at_ms) = 'integer' AND applied_at_ms >= 0)
);`

interface AppliedMigrationRow {
  version: number
  name: string
  checksum: string
}

interface MigrationMarkerRow {
  name: string
  source_sha256: string
  completed_at_ms: number
  details_json: string
}

const hasTable = (db: Database.Database, name: string): boolean => db
  .prepare<[string]>('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?')
  .get(name) != null

const readLegacyVersion = (db: Database.Database): 1 | 2 => {
  if (!hasTable(db, 'db_info')) throw new Error('Unsupported or malformed legacy database version')
  const rows = db.prepare<[]>('SELECT field_value FROM db_info WHERE field_name = \'version\'').all() as Array<{ field_value: unknown }>
  if (rows.length != 1 || (rows[0].field_value != '1' && rows[0].field_value != '2')) {
    throw new Error('Unsupported or malformed legacy database version')
  }
  return rows[0].field_value == '1' ? 1 : 2
}

const readAppliedMigrations = (db: Database.Database): AppliedMigrationRow[] => {
  if (!hasTable(db, 'schema_migrations')) return []
  return db.prepare<[]>('SELECT version, name, checksum FROM schema_migrations ORDER BY version').all() as AppliedMigrationRow[]
}

const validateRegistry = (registry: readonly SchemaMigration[]): void => {
  if (registry.length == 0) throw new Error('Invalid migration registry: it must begin at version 3')
  for (let index = 0; index < registry.length; index++) {
    const migration = registry[index]
    const expectedVersion = FIRST_MIGRATION_VERSION + index
    if (!Number.isSafeInteger(migration.version) || migration.version != expectedVersion) {
      throw new Error(`Invalid migration registry: expected version ${expectedVersion}`)
    }
    if (typeof migration.name != 'string' || migration.name.trim().length == 0) {
      throw new Error(`Invalid migration registry: version ${migration.version} has no name`)
    }
    if (!checksumPattern.test(migration.checksum)) {
      throw new Error(`Invalid migration registry: version ${migration.version} has an invalid checksum`)
    }
    if (typeof migration.up != 'function') {
      throw new Error(`Invalid migration registry: version ${migration.version} has no up function`)
    }
  }
}

const validateAppliedMigrations = (
  applied: readonly AppliedMigrationRow[],
  registry: readonly SchemaMigration[],
): void => {
  for (let index = 0; index < applied.length; index++) {
    const row = applied[index]
    const expectedVersion = FIRST_MIGRATION_VERSION + index
    if (row.version != expectedVersion) {
      throw new Error(`Applied migration ledger is non-contiguous at version ${row.version}`)
    }
    const registered = registry[index]
    if (!registered) throw new Error(`Migration registry is missing applied version ${row.version}`)
    if (registered.name != row.name) throw new Error(`Applied migration ${row.version} name mismatch`)
    if (registered.checksum != row.checksum) throw new Error(`Applied migration ${row.version} checksum mismatch`)
  }
}

const validateTarget = (
  currentVersion: number,
  registry: readonly SchemaMigration[],
  requestedTarget: number | undefined,
): number => {
  const highestVersion = registry[registry.length - 1].version
  if (requestedTarget != null && requestedTarget > MAX_ORDINARY_SCHEMA_VERSION) {
    throw new Error(`Invalid target schema version ${String(requestedTarget)}`)
  }
  const target = requestedTarget ?? Math.max(currentVersion, Math.min(highestVersion, MAX_ORDINARY_SCHEMA_VERSION))
  const isBoundary = target == currentVersion || registry.some(migration => migration.version == target)
  if (!Number.isSafeInteger(target) || target < currentVersion || target > highestVersion || !isBoundary) {
    throw new Error(`Invalid target schema version ${String(target)}`)
  }
  return target
}

const expectedLegacyObjects = new Map(Array.from(tables.keys()).map(name => [
  name,
  name.startsWith('index_') ? 'index' : 'table',
]))

const validateLegacySchema = (db: Database.Database, version: 1 | 2): void => {
  const rows = db.prepare<[]>(`
    SELECT name, type FROM sqlite_master
    WHERE type IN ('table', 'index') AND name NOT LIKE 'sqlite_%'
      AND name NOT IN ('schema_migrations', 'migration_markers')
  `).all() as Array<{ name: string, type: string }>
  const actual = new Map(rows.map(row => [row.name, row.type]))
  const withoutDislike = version == 1 && !actual.has('dislike_list')
  if (withoutDislike) actual.set('dislike_list', 'table')
  const valid = actual.size == expectedLegacyObjects.size &&
    Array.from(expectedLegacyObjects).every(([name, type]) => actual.get(name) == type)
  if (!valid) throw new Error(`Unsupported or malformed legacy database schema for version ${version}`)
}

export const getSchemaVersion = (db: Database.Database): number => {
  const applied = readAppliedMigrations(db)
  return applied.length == 0 ? readLegacyVersion(db) : applied[applied.length - 1].version
}

export const getPendingMigrations = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: { targetSchemaVersion?: number },
): SchemaMigration[] => {
  validateRegistry(registry)
  const applied = readAppliedMigrations(db)
  validateAppliedMigrations(applied, registry)
  const currentVersion = applied.length == 0 ? readLegacyVersion(db) : applied[applied.length - 1].version
  const target = validateTarget(currentVersion, registry, options?.targetSchemaVersion)
  return registry.filter(migration => migration.version > currentVersion && migration.version <= target)
}

interface MigrationOptions {
  now?: () => number
  targetSchemaVersion?: number
}

const applyMigrations = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: MigrationOptions,
): MigrationRunResult => {
  validateRegistry(registry)
  const pending = getPendingMigrations(db, registry, options)
  const fromVersion = getSchemaVersion(db)
  let toVersion = fromVersion
  const appliedVersions: number[] = []
  if (pending.length == 0) return { fromVersion, toVersion, applied: appliedVersions }

  const applied = readAppliedMigrations(db)
  if (applied.length == 0) {
    const legacyVersion = readLegacyVersion(db)
    validateLegacySchema(db, legacyVersion)
    if (legacyVersion == 1 && !hasTable(db, 'dislike_list')) db.exec(tables.get('dislike_list')!)
    if (!hasTable(db, 'schema_migrations')) db.exec(createLedgerSql)
  }

  const insert = db.prepare('INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)')
  const updateMirror = db.prepare('UPDATE db_info SET field_value = ? WHERE field_name = \'version\'')
  for (const migration of pending) {
    const appliedAtMs = (options?.now ?? Date.now)()
    if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
      throw new Error(`Migration ${migration.version} produced an invalid applied timestamp`)
    }
    const context: MigrationContext = Object.freeze({ appliedAtMs })
    migration.up(db, context)
    insert.run(migration.version, migration.name, migration.checksum, appliedAtMs)
    if (updateMirror.run(String(migration.version)).changes != 1) {
      throw new Error(`Migration ${migration.version} could not update the legacy version mirror`)
    }
    migration.verify?.(db, context)
    appliedVersions.push(migration.version)
    toVersion = migration.version
  }

  return { fromVersion, toVersion, applied: appliedVersions }
}

export const runMigrations = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: MigrationOptions,
): MigrationRunResult => db.transaction(() => applyMigrations(db, registry, options))()

export const bootstrapDatabaseSchema = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: MigrationOptions,
): MigrationRunResult => db.transaction(() => {
  db.exec(`
    ${Array.from(tables.values()).join('\n')}
    INSERT INTO "main"."db_info" ("field_name", "field_value") VALUES ('version', '${LEGACY_DB_VERSION}');
  `)
  return applyMigrations(db, registry, options)
})()

const normalizeMarker = (marker: MigrationMarker): MigrationMarker => {
  if (typeof marker.name != 'string' || marker.name.trim().length == 0) {
    throw new Error('Invalid migration marker name')
  }
  if (!checksumPattern.test(marker.sourceSha256)) {
    throw new Error(`Invalid migration marker ${marker.name}: source SHA-256`)
  }
  if (!Number.isSafeInteger(marker.completedAtMs) || marker.completedAtMs < 0) {
    throw new Error(`Invalid migration marker ${marker.name}: completion timestamp`)
  }
  let details: unknown
  try {
    details = JSON.parse(marker.detailsJson)
  } catch {
    throw new Error(`Invalid migration marker ${marker.name}: details JSON`)
  }
  if (details == null || Array.isArray(details) || typeof details != 'object' ||
    Object.getPrototypeOf(details) != Object.prototype ||
    (details as { version?: unknown }).version != 1) {
    throw new Error(`Invalid migration marker ${marker.name}: details envelope`)
  }
  return { ...marker, detailsJson: canonicalJson(details as JsonValue) }
}

export const getMigrationMarker = (db: Database.Database, name: string): MigrationMarker | null => {
  if (typeof name != 'string' || name.trim().length == 0) throw new Error('Invalid migration marker name')
  const row = db.prepare<[string]>(`
    SELECT name, source_sha256, completed_at_ms, details_json
    FROM migration_markers WHERE name = ?
  `).get(name) as MigrationMarkerRow | undefined
  if (!row) return null
  return normalizeMarker({
    name: row.name,
    sourceSha256: row.source_sha256,
    completedAtMs: row.completed_at_ms,
    detailsJson: row.details_json,
  })
}

export const putMigrationMarker = (db: Database.Database, marker: MigrationMarker): void => {
  const normalized = normalizeMarker(marker)
  const existing = getMigrationMarker(db, normalized.name)
  if (existing) {
    if (existing.sourceSha256 == normalized.sourceSha256) return
    throw new Error(`Migration marker ${normalized.name} source conflict`)
  }
  db.prepare(`
    INSERT INTO migration_markers (name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(normalized.name, normalized.sourceSha256, normalized.completedAtMs, normalized.detailsJson)
}

export default (db: Database.Database): MigrationRunResult => runMigrations(db, migrations, { targetSchemaVersion: 6 })
