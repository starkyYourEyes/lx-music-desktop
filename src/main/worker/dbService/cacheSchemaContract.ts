import type Database from 'better-sqlite3'
import {
  CACHE_MIGRATION_CHECKSUM,
  CACHE_MIGRATION_NAME,
  CACHE_MIGRATION_V1_CHECKSUM,
  CACHE_MIGRATION_V1_NAME,
  CACHE_SCHEMA_V1_VERSION,
  CACHE_SCHEMA_VERSION,
} from './cacheMigrate'
import { CACHE_SCHEMA_SOURCE, CACHE_SCHEMA_V1_SOURCE } from './cacheTables'
import type { SchemaContract } from './schemaContract'
import { verifyDatabaseAgainstContract } from './verifyDB'

export type CacheSchemaDiagnostic = 'cache_schema_invalid' | 'cache_integrity_failed'

export type CacheSchemaVerification =
  | { ok: true }
  | { ok: false, diagnostic: CacheSchemaDiagnostic }

export type CacheSchemaInspection =
  | { ok: true, version: 1 | 2 }
  | { ok: false, diagnostic: CacheSchemaDiagnostic }

interface ColumnRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
  hidden: number
}

interface IndexListRow {
  name: string
  unique: number
  origin: string
  partial: number
}

interface IndexInfoRow {
  name: string | null
  seqno: number
  coll: string
  desc: number
  key: number
}

interface ForeignKeyRow {
  id: number
  seq: number
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
}

interface MigrationRow {
  version: unknown
  name: unknown
  checksum: unknown
  applied_at_ms: unknown
}

interface SchemaSqlRow {
  sql: string | null
}

type ColumnContract = readonly [name: string, type: string, notNull: boolean, primaryKeyPosition: number]

const v1Columns = new Map<string, readonly ColumnContract[]>([
  ['cache_schema_migrations', [
    ['version', 'INTEGER', false, 1],
    ['name', 'TEXT', true, 0],
    ['checksum', 'TEXT', true, 0],
    ['applied_at_ms', 'INTEGER', true, 0],
  ]],
  ['raw_lyric_groups', [
    ['provider', 'TEXT', true, 1],
    ['source_track_id', 'TEXT', true, 2],
    ['byte_size', 'INTEGER', true, 0],
    ['created_at_ms', 'INTEGER', true, 0],
    ['last_accessed_at_ms', 'INTEGER', true, 0],
  ]],
  ['raw_lyrics', [
    ['provider', 'TEXT', true, 1],
    ['source_track_id', 'TEXT', true, 2],
    ['lyric_type', 'TEXT', true, 3],
    ['text', 'TEXT', true, 0],
    ['byte_size', 'INTEGER', true, 0],
  ]],
  ['music_urls', [
    ['provider', 'TEXT', true, 1],
    ['account_scope', 'TEXT', true, 2],
    ['source_track_id', 'TEXT', true, 3],
    ['quality', 'TEXT', true, 4],
    ['url', 'TEXT', true, 0],
    ['expires_at_ms', 'INTEGER', true, 0],
    ['created_at_ms', 'INTEGER', true, 0],
    ['last_accessed_at_ms', 'INTEGER', true, 0],
  ]],
  ['other_source_groups', [
    ['original_provider', 'TEXT', true, 1],
    ['original_track_id', 'TEXT', true, 2],
    ['byte_size', 'INTEGER', true, 0],
    ['expires_at_ms', 'INTEGER', true, 0],
    ['created_at_ms', 'INTEGER', true, 0],
    ['last_accessed_at_ms', 'INTEGER', true, 0],
  ]],
  ['other_sources', [
    ['original_provider', 'TEXT', true, 1],
    ['original_track_id', 'TEXT', true, 2],
    ['rank', 'INTEGER', true, 3],
    ['candidate_provider', 'TEXT', true, 0],
    ['candidate_track_id', 'TEXT', true, 0],
    ['candidate_json', 'TEXT', true, 0],
    ['byte_size', 'INTEGER', true, 0],
  ]],
])

const v2Columns = new Map(v1Columns)
v2Columns.set('music_urls', [
  ['provider', 'TEXT', true, 1],
  ['account_scope', 'TEXT', true, 2],
  ['source_track_id', 'TEXT', true, 3],
  ['quality', 'TEXT', true, 4],
  ['url', 'TEXT', true, 0],
  ['reported_quality', 'TEXT', false, 0],
  ['expires_at_ms', 'INTEGER', true, 0],
  ['created_at_ms', 'INTEGER', true, 0],
  ['last_accessed_at_ms', 'INTEGER', true, 0],
])

const indexSignature = (
  name: string | null,
  unique: boolean,
  origin: string,
  partial: boolean,
  indexColumns: ReadonlyArray<string | null>,
  collations: readonly string[] = indexColumns.map(() => 'BINARY'),
  descending: readonly boolean[] = indexColumns.map(() => false),
): string => [
  origin,
  unique ? '1' : '0',
  partial ? '1' : '0',
  name ?? '*',
  indexColumns.map((column, index) => [
    column ?? '*',
    collations[index]?.toUpperCase() ?? '',
    descending[index] ? '1' : '0',
  ].join(':')).join(','),
].join('|')

const expectedIndexes = new Map<string, readonly string[]>([
  ['cache_schema_migrations', [
    indexSignature(null, true, 'u', false, ['name']),
  ]],
  ['raw_lyric_groups', [
    indexSignature(null, true, 'pk', false, ['provider', 'source_track_id']),
    indexSignature('raw_lyric_groups_lru', false, 'c', false, [
      'last_accessed_at_ms', 'created_at_ms', 'provider', 'source_track_id',
    ]),
  ]],
  ['raw_lyrics', [
    indexSignature(null, true, 'pk', false, ['provider', 'source_track_id', 'lyric_type']),
  ]],
  ['music_urls', [
    indexSignature(null, true, 'pk', false, ['provider', 'account_scope', 'source_track_id', 'quality']),
    indexSignature('music_urls_expiry', false, 'c', false, [
      'expires_at_ms', 'provider', 'account_scope', 'source_track_id', 'quality',
    ]),
    indexSignature('music_urls_lru', false, 'c', false, [
      'last_accessed_at_ms', 'created_at_ms', 'provider', 'account_scope', 'source_track_id', 'quality',
    ]),
  ]],
  ['other_source_groups', [
    indexSignature(null, true, 'pk', false, ['original_provider', 'original_track_id']),
    indexSignature('other_source_groups_expiry', false, 'c', false, [
      'expires_at_ms', 'original_provider', 'original_track_id',
    ]),
    indexSignature('other_source_groups_lru', false, 'c', false, [
      'last_accessed_at_ms', 'created_at_ms', 'original_provider', 'original_track_id',
    ]),
  ]],
  ['other_sources', [
    indexSignature(null, true, 'pk', false, ['original_provider', 'original_track_id', 'rank']),
    indexSignature(null, true, 'u', false, [
      'original_provider', 'original_track_id', 'candidate_provider', 'candidate_track_id',
    ]),
  ]],
])

const foreignKeySignature = (
  table: string,
  from: readonly string[],
  to: readonly string[],
  onUpdate: string,
  onDelete: string,
): string => [table, from.join(','), to.join(','), onUpdate.toUpperCase(), onDelete.toUpperCase()].join('|')

const expectedForeignKeys = new Map<string, readonly string[]>([
  ['cache_schema_migrations', []],
  ['raw_lyric_groups', []],
  ['raw_lyrics', [foreignKeySignature(
    'raw_lyric_groups',
    ['provider', 'source_track_id'],
    ['provider', 'source_track_id'],
    'NO ACTION',
    'CASCADE',
  )]],
  ['music_urls', []],
  ['other_source_groups', []],
  ['other_sources', [foreignKeySignature(
    'other_source_groups',
    ['original_provider', 'original_track_id'],
    ['original_provider', 'original_track_id'],
    'NO ACTION',
    'CASCADE',
  )]],
])

const createCacheCheckContract = (includeReportedQuality: boolean): SchemaContract => ({
  tables: [
    {
      name: 'cache_schema_migrations',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'checksum.length', expression: 'length(checksum) = 64' },
        { name: 'applied_at_ms.nonnegative', expression: 'applied_at_ms >= 0' },
      ],
    },
    {
      name: 'raw_lyric_groups',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'byte_size.nonnegative', expression: 'byte_size >= 0' },
        { name: 'created_at_ms.nonnegative', expression: 'created_at_ms >= 0' },
        { name: 'last_accessed_at_ms.order', expression: 'last_accessed_at_ms >= created_at_ms' },
      ],
    },
    {
      name: 'raw_lyrics',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'lyric_type.enum', expression: "lyric_type IN ('lyric','tlyric','rlyric','lxlyric')" },
        { name: 'byte_size.nonnegative', expression: 'byte_size >= 0' },
      ],
    },
    {
      name: 'music_urls',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [
        ...(includeReportedQuality ? [{
          name: 'reported_quality.enum',
          expression: "reported_quality IS NULL OR reported_quality IN ('128k','192k','320k','flac','flac24bit','ape','wav')",
        }] : []),
        { name: 'expires_at_ms.nonnegative', expression: 'expires_at_ms >= 0' },
        { name: 'created_at_ms.nonnegative', expression: 'created_at_ms >= 0' },
        { name: 'last_accessed_at_ms.order', expression: 'last_accessed_at_ms >= created_at_ms' },
      ],
    },
    {
      name: 'other_source_groups',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'byte_size.nonnegative', expression: 'byte_size >= 0' },
        { name: 'expires_at_ms.nonnegative', expression: 'expires_at_ms >= 0' },
        { name: 'created_at_ms.nonnegative', expression: 'created_at_ms >= 0' },
        { name: 'last_accessed_at_ms.order', expression: 'last_accessed_at_ms >= created_at_ms' },
      ],
    },
    {
      name: 'other_sources',
      columns: [],
      indexes: [],
      foreignKeys: [],
      checks: [
        { name: 'rank.nonnegative', expression: 'rank >= 0' },
        { name: 'candidate_json.valid', expression: 'json_valid(candidate_json)' },
        { name: 'byte_size.nonnegative', expression: 'byte_size >= 0' },
      ],
    },
  ],
})

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`

const isSqlWordCharacter = (value: string | undefined): boolean =>
  value != null && /[a-z0-9_$]/i.test(value)

const readQuotedEnd = (sql: string, start: number): number => {
  const delimiter = sql[start] == '[' ? ']' : sql[start]
  for (let index = start + 1; index < sql.length; index++) {
    if (sql[index] != delimiter) continue
    if (sql[index + 1] == delimiter) index++
    else return index + 1
  }
  return sql.length
}

const readCommentEnd = (sql: string, start: number): number | null => {
  if (sql[start] == '-' && sql[start + 1] == '-') {
    const end = sql.indexOf('\n', start + 2)
    return end == -1 ? sql.length : end + 1
  }
  if (sql[start] == '/' && sql[start + 1] == '*') {
    const end = sql.indexOf('*/', start + 2)
    return end == -1 ? sql.length : end + 2
  }
  return null
}

const splitSqlStatements = (sql: string): string[] => {
  const statements: string[] = []
  let start = 0
  for (let index = 0; index < sql.length;) {
    const character = sql[index]
    if (character == "'" || character == '"' || character == '`' || character == '[') {
      index = readQuotedEnd(sql, index)
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd != null) {
      index = commentEnd
      continue
    }
    if (character == ';') {
      const statement = sql.slice(start, index).trim()
      if (statement.length > 0) statements.push(statement)
      start = index + 1
    }
    index++
  }
  const trailing = sql.slice(start).trim()
  if (trailing.length > 0) statements.push(trailing)
  return statements
}

const normalizeQuotedToken = (sql: string, start: number, end: number): string => {
  const delimiter = sql[start] == '[' ? ']' : sql[start]
  const value = sql.slice(start + 1, end - 1).split(`${delimiter}${delimiter}`).join(delimiter)
  if (sql[start] == "'") return `'${value.split("'").join("''")}'`
  return value.toLowerCase()
}

const normalizeTableSql = (sql: string): string => {
  const tokens: string[] = []
  const pairedOperators = new Set(['>=', '<=', '<>', '!=', '==', '||', '->'])
  for (let index = 0; index < sql.length;) {
    const character = sql[index]
    if (/\s/.test(character)) {
      index++
      continue
    }
    if (character == "'" || character == '"' || character == '`' || character == '[') {
      const end = readQuotedEnd(sql, index)
      tokens.push(normalizeQuotedToken(sql, index, end))
      index = end
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd != null) {
      index = commentEnd
      continue
    }
    if (isSqlWordCharacter(character)) {
      let end = index + 1
      while (isSqlWordCharacter(sql[end])) end++
      tokens.push(sql.slice(index, end).toLowerCase())
      index = end
      continue
    }
    const paired = sql.slice(index, index + 2)
    if (pairedOperators.has(paired)) {
      tokens.push(paired)
      index += 2
      continue
    }
    if (character != ';' || sql.slice(index + 1).trim().length > 0) tokens.push(character)
    index++
  }
  return tokens.join(' ')
}

const expectedTableSql = (source: string): Map<string, string> => {
  const tables = new Map<string, string>()
  for (const statement of splitSqlStatements(source)) {
    const table = /^CREATE\s+TABLE\s+([a-z_][a-z0-9_]*)/i.exec(statement)?.[1]
    if (table != null) tables.set(table, normalizeTableSql(statement))
  }
  return tables
}

const countCheckExpressions = (sql: string): number => {
  let count = 0
  for (let index = 0; index < sql.length;) {
    const character = sql[index]
    if (character == "'" || character == '"' || character == '`' || character == '[') {
      index = readQuotedEnd(sql, index)
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd != null) {
      index = commentEnd
      continue
    }
    if (!isSqlWordCharacter(sql[index - 1]) && sql.slice(index, index + 5).toLowerCase() == 'check' &&
      !isSqlWordCharacter(sql[index + 5])) count++
    index++
  }
  return count
}

const sameSorted = (actual: readonly string[], expected: readonly string[]): boolean => {
  if (actual.length != expected.length) return false
  const left = [...actual].sort()
  const right = [...expected].sort()
  return left.every((value, index) => value == right[index])
}

const readIndexSignatures = (db: Database.Database, table: string): string[] =>
  (db.pragma(`index_list(${quoteIdentifier(table)})`) as IndexListRow[]).map(index => {
    const indexColumns = (db.pragma(`index_xinfo(${quoteIdentifier(index.name)})`) as IndexInfoRow[])
      .filter(row => row.key == 1)
      .sort((left, right) => left.seqno - right.seqno)
    return indexSignature(
      index.origin == 'c' ? index.name : null,
      index.unique == 1,
      index.origin,
      index.partial == 1,
      indexColumns.map(row => row.name),
      indexColumns.map(row => row.coll),
      indexColumns.map(row => row.desc == 1),
    )
  })

const readForeignKeySignatures = (db: Database.Database, table: string): string[] => {
  const groups = new Map<number, ForeignKeyRow[]>()
  for (const row of db.pragma(`foreign_key_list(${quoteIdentifier(table)})`) as ForeignKeyRow[]) {
    const group = groups.get(row.id) ?? []
    group.push(row)
    groups.set(row.id, group)
  }
  return [...groups.values()].map(group => {
    group.sort((left, right) => left.seq - right.seq)
    return foreignKeySignature(
      group[0].table,
      group.map(row => row.from),
      group.map(row => row.to),
      group[0].on_update,
      group[0].on_delete,
    )
  })
}

const errorCode = (error: unknown): string =>
  error != null && typeof error == 'object' && 'code' in error && typeof error.code == 'string'
    ? error.code
    : ''

const isIntegrityError = (error: unknown): boolean =>
  /^(SQLITE_CORRUPT|SQLITE_NOTADB)(?:_|$)/.test(errorCode(error))

interface CacheSchemaContract {
  version: 1 | 2
  columns: Map<string, readonly ColumnContract[]>
  checks: SchemaContract
  tableSql: Map<string, string>
  ledger: ReadonlyArray<readonly [version: 1 | 2, name: string, checksum: string]>
}

const v1Contract: CacheSchemaContract = {
  version: CACHE_SCHEMA_V1_VERSION,
  columns: v1Columns,
  checks: createCacheCheckContract(false),
  tableSql: expectedTableSql(CACHE_SCHEMA_V1_SOURCE),
  ledger: [[CACHE_SCHEMA_V1_VERSION, CACHE_MIGRATION_V1_NAME, CACHE_MIGRATION_V1_CHECKSUM]],
}

const v2Contract: CacheSchemaContract = {
  version: CACHE_SCHEMA_VERSION,
  columns: v2Columns,
  checks: createCacheCheckContract(true),
  tableSql: expectedTableSql(CACHE_SCHEMA_SOURCE),
  ledger: [
    [CACHE_SCHEMA_V1_VERSION, CACHE_MIGRATION_V1_NAME, CACHE_MIGRATION_V1_CHECKSUM],
    [CACHE_SCHEMA_VERSION, CACHE_MIGRATION_NAME, CACHE_MIGRATION_CHECKSUM],
  ],
}

const verifyCacheSchemaVersion = (
  db: Database.Database,
  contract: CacheSchemaContract,
): CacheSchemaVerification => {
  try {
    if (db.pragma('quick_check', { simple: true }) != 'ok') {
      return { ok: false, diagnostic: 'cache_integrity_failed' }
    }
  } catch {
    return { ok: false, diagnostic: 'cache_integrity_failed' }
  }

  try {
    if (db.pragma('user_version', { simple: true }) != contract.version) {
      return { ok: false, diagnostic: 'cache_schema_invalid' }
    }
    const actualTables = (db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>).map(row => row.name)
    if (!sameSorted(actualTables, [...contract.columns.keys()])) {
      return { ok: false, diagnostic: 'cache_schema_invalid' }
    }
    const unexpectedObjects = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type IN ('view', 'trigger') AND name NOT LIKE 'sqlite_%'
    `).all() as Array<{ name: string }>
    if (unexpectedObjects.length != 0) return { ok: false, diagnostic: 'cache_schema_invalid' }

    for (const [table, expectedColumnsForTable] of contract.columns) {
      const actual = db.pragma(`table_xinfo(${quoteIdentifier(table)})`) as ColumnRow[]
      if (actual.length != expectedColumnsForTable.length || !actual.every((row, index) => {
        const expected = expectedColumnsForTable[index]
        return row.name == expected[0] && row.type.toUpperCase() == expected[1] &&
          (row.notnull == 1) == expected[2] && row.pk == expected[3] &&
          row.dflt_value == null && row.hidden == 0
      })) return { ok: false, diagnostic: 'cache_schema_invalid' }
      if (!sameSorted(readIndexSignatures(db, table), expectedIndexes.get(table) ?? [])) {
        return { ok: false, diagnostic: 'cache_schema_invalid' }
      }
      if (!sameSorted(readForeignKeySignatures(db, table), expectedForeignKeys.get(table) ?? [])) {
        return { ok: false, diagnostic: 'cache_schema_invalid' }
      }
      const tableSql = (db.prepare(`
        SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
      `).get(table) as SchemaSqlRow | undefined)?.sql
      if (tableSql == null || normalizeTableSql(tableSql) != contract.tableSql.get(table) ||
        countCheckExpressions(tableSql) != (contract.checks.tables.find(value => value.name == table)?.checks?.length ?? 0)) {
        return { ok: false, diagnostic: 'cache_schema_invalid' }
      }
    }
    if (!verifyDatabaseAgainstContract(db, contract.checks, {
      runQuickCheck: false,
      runForeignKeyCheck: false,
    }).ok) return { ok: false, diagnostic: 'cache_schema_invalid' }

    const ledger = db.prepare(`
      SELECT version, name, checksum, applied_at_ms
      FROM cache_schema_migrations ORDER BY version
    `).all() as MigrationRow[]
    if (ledger.length != contract.ledger.length || !ledger.every((row, index) => {
      const expected = contract.ledger[index]
      return row.version === expected[0] && row.name === expected[1] && row.checksum === expected[2] &&
        Number.isSafeInteger(row.applied_at_ms) && (row.applied_at_ms as number) >= 0
    })) {
      return { ok: false, diagnostic: 'cache_schema_invalid' }
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length != 0) {
      return { ok: false, diagnostic: 'cache_integrity_failed' }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      diagnostic: isIntegrityError(error) ? 'cache_integrity_failed' : 'cache_schema_invalid',
    }
  }
}

export const verifyCacheSchemaV1 = (db: Database.Database): CacheSchemaVerification =>
  verifyCacheSchemaVersion(db, v1Contract)

export const verifyCacheSchema = (db: Database.Database): CacheSchemaVerification =>
  verifyCacheSchemaVersion(db, v2Contract)

export const inspectCacheSchema = (db: Database.Database): CacheSchemaInspection => {
  const version = db.pragma('user_version', { simple: true })
  if (version !== CACHE_SCHEMA_V1_VERSION && version !== CACHE_SCHEMA_VERSION) {
    return { ok: false, diagnostic: 'cache_schema_invalid' }
  }
  const verification = version == CACHE_SCHEMA_V1_VERSION
    ? verifyCacheSchemaV1(db)
    : verifyCacheSchema(db)
  return verification.ok ? { ok: true, version } : verification
}

export default verifyCacheSchema
