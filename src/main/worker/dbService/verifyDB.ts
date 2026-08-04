import type Database from 'better-sqlite3'
import databaseSchemaContract, {
  type SchemaContract,
  type SchemaForeignKeyContract,
  type SchemaIndexContract,
} from './schemaContract'

export interface DatabaseVerificationOptions {
  runQuickCheck: boolean
  runForeignKeyCheck: boolean
}

export type DatabaseVerificationResult =
  | { ok: true, diagnostics: [] }
  | {
    ok: false
    reason: 'schema_invalid' | 'quick_check_failed' | 'foreign_key_check_failed'
    diagnostics: string[]
  }

interface TableInfoRow {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

interface IndexListRow {
  name: string
  unique: number
  partial: number
}

interface IndexInfoRow {
  name: string | null
  seqno: number
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

interface SchemaSqlRow {
  sql: string | null
}

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`

const sameColumns = (actual: readonly unknown[], expected: readonly string[]): boolean =>
  actual.length == expected.length && actual.every((value, index) => value == expected[index])

const isSqlWordCharacter = (value: string | undefined): boolean =>
  value != null && /[a-z0-9_$]/i.test(value)

const isSqlQuote = (value: string): boolean => value == "'" || value == '"' || value == '`' || value == '['

const readQuotedEnd = (sql: string, start: number): number => {
  const delimiter = sql[start] == '[' ? ']' : sql[start]
  for (let index = start + 1; index < sql.length; index++) {
    if (sql[index] == delimiter) {
      if (sql[index + 1] == delimiter) {
        index++
      } else {
        return index + 1
      }
    }
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

const skipSqlTrivia = (sql: string, start: number): number => {
  let index = start
  while (index < sql.length) {
    if (/\s/.test(sql[index])) {
      index++
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd == null) break
    index = commentEnd
  }
  return index
}

const findSqlKeyword = (sql: string, keyword: string, start = 0): number => {
  for (let index = start; index < sql.length;) {
    if (isSqlQuote(sql[index])) {
      index = readQuotedEnd(sql, index)
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd != null) {
      index = commentEnd
      continue
    }
    if (!isSqlWordCharacter(sql[index - 1]) &&
      sql.slice(index, index + keyword.length).toLowerCase() == keyword &&
      !isSqlWordCharacter(sql[index + keyword.length])) return index
    index++
  }
  return -1
}

const findBalancedParenthesisEnd = (sql: string, start: number): number | null => {
  let depth = 0
  for (let index = start; index < sql.length;) {
    if (isSqlQuote(sql[index])) {
      index = readQuotedEnd(sql, index)
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd != null) {
      index = commentEnd
      continue
    }
    if (sql[index] == '(') {
      depth++
    } else if (sql[index] == ')' && --depth == 0) {
      return index
    }
    index++
  }
  return null
}

const isSqlTightCharacter = (value: string | undefined): boolean =>
  value != null && /[(),;<>!=+*/%|&~-]/.test(value)

const normalizeSqlExpression = (sql: string): string => {
  let result = ''
  let needsSpace = false
  for (let index = 0; index < sql.length;) {
    if (isSqlQuote(sql[index])) {
      const end = readQuotedEnd(sql, index)
      if (needsSpace && result.length > 0 && !isSqlTightCharacter(result.at(-1))) result += ' '
      result += sql.slice(index, end)
      needsSpace = false
      index = end
      continue
    }
    const commentEnd = readCommentEnd(sql, index)
    if (commentEnd != null) {
      needsSpace = true
      index = commentEnd
      continue
    }
    if (/\s/.test(sql[index])) {
      needsSpace = true
      index++
      continue
    }
    if (isSqlTightCharacter(sql[index])) {
      result = result.trimEnd() + sql[index].toLowerCase()
    } else {
      if (needsSpace && result.length > 0 && !isSqlTightCharacter(result.at(-1))) result += ' '
      result += sql[index].toLowerCase()
    }
    needsSpace = false
    index++
  }
  return result.trim()
}

const extractCheckExpressions = (sql: string): string[] => {
  const expressions: string[] = []
  for (let start = 0; start < sql.length;) {
    const checkStart = findSqlKeyword(sql, 'check', start)
    if (checkStart == -1) break
    const open = skipSqlTrivia(sql, checkStart + 'check'.length)
    if (sql[open] != '(') {
      start = open
      continue
    }
    const close = findBalancedParenthesisEnd(sql, open)
    if (close == null) break
    expressions.push(sql.slice(open + 1, close))
    start = close + 1
  }
  return expressions
}

const readSchemaSql = (db: Database.Database, type: 'table' | 'index', name: string): string | null =>
  (db.prepare<[string, string]>('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
    .get(type, name) as SchemaSqlRow | undefined)?.sql ?? null

const readWhere = (sql: string | null): string | null => {
  if (sql == null) return null
  const where = findSqlKeyword(sql, 'where')
  return where == -1 ? null : normalizeSqlExpression(sql.slice(where + 'where'.length))
}

const sameDefault = (actual: string | null, expected: string | null): boolean => {
  if (actual == null || expected == null) return actual == expected
  const unwrap = (value: string): string => normalizeSqlExpression(value).replace(/^\((.*)\)$/, '$1')
  return unwrap(actual) == unwrap(expected)
}

const readIndexes = (db: Database.Database, table: string): Array<{
  name: string
  unique: boolean
  partial: boolean
  columns: Array<string | null>
  sql: string | null
}> =>
  (db.pragma(`index_list(${quoteIdentifier(table)})`) as IndexListRow[]).map(index => ({
    name: index.name,
    unique: index.unique == 1,
    partial: index.partial == 1,
    columns: (db.pragma(`index_info(${quoteIdentifier(index.name)})`) as IndexInfoRow[])
      .sort((a, b) => a.seqno - b.seqno)
      .map(columnInfo => columnInfo.name),
    sql: readSchemaSql(db, 'index', index.name),
  }))

const matchingIndexes = (
  actual: ReturnType<typeof readIndexes>,
  expected: SchemaIndexContract,
): ReturnType<typeof readIndexes> => actual.filter(index =>
  index.unique == expected.unique &&
  index.partial == expected.partial &&
  sameColumns(index.columns, expected.columns))

const readForeignKeys = (db: Database.Database, table: string): ForeignKeyRow[][] => {
  const rows = db.pragma(`foreign_key_list(${quoteIdentifier(table)})`) as ForeignKeyRow[]
  const grouped = new Map<number, ForeignKeyRow[]>()
  for (const row of rows) {
    const group = grouped.get(row.id) ?? []
    group.push(row)
    grouped.set(row.id, group)
  }
  return Array.from(grouped.values()).map(group => group.sort((a, b) => a.seq - b.seq))
}

const hasForeignKey = (actual: ForeignKeyRow[][], expected: SchemaForeignKeyContract): boolean =>
  actual.some(rows => rows.length > 0 &&
    rows[0].table == expected.table &&
    rows[0].on_update.toUpperCase() == expected.onUpdate.toUpperCase() &&
    rows[0].on_delete.toUpperCase() == expected.onDelete.toUpperCase() &&
    sameColumns(rows.map(row => row.from), expected.from) &&
    sameColumns(rows.map(row => row.to), expected.to))

const verifyStructure = (db: Database.Database, contract: SchemaContract): string[] => {
  const diagnostics: string[] = []
  for (const table of contract.tables) {
    const columns = db.pragma(`table_info(${quoteIdentifier(table.name)})`) as TableInfoRow[]
    if (columns.length == 0) {
      diagnostics.push(`schema.table_missing:${table.name}`)
      continue
    }
    const columnMap = new Map(columns.map(info => [info.name, info]))
    for (const expected of table.columns) {
      const actual = columnMap.get(expected.name)
      if (!actual) {
        diagnostics.push(`schema.column_missing:${table.name}.${expected.name}`)
        continue
      }
      if (actual.type.toUpperCase() != expected.type.toUpperCase()) {
        diagnostics.push(`schema.column_type:${table.name}.${expected.name}`)
      }
      if ((actual.notnull == 1) != expected.notNull) {
        diagnostics.push(`schema.column_not_null:${table.name}.${expected.name}`)
      }
      if (actual.pk != expected.primaryKeyPosition) {
        diagnostics.push(`schema.column_primary_key:${table.name}.${expected.name}`)
      }
      if (expected.defaultValue !== undefined && !sameDefault(actual.dflt_value, expected.defaultValue)) {
        diagnostics.push(`schema.column_default:${table.name}.${expected.name}`)
      }
    }
    const indexes = readIndexes(db, table.name)
    for (const expected of table.indexes) {
      const matching = matchingIndexes(indexes, expected)
      if (matching.length == 0) {
        diagnostics.push(`schema.index_invalid:${table.name}.${expected.name}`)
      } else if (expected.where !== undefined &&
        !matching.some(index => readWhere(index.sql) == normalizeSqlExpression(expected.where!))) {
        diagnostics.push(`schema.index_where:${table.name}.${expected.name}`)
      }
    }
    const foreignKeys = readForeignKeys(db, table.name)
    for (const expected of table.foreignKeys) {
      if (!hasForeignKey(foreignKeys, expected)) {
        diagnostics.push(`schema.foreign_key_invalid:${table.name}.${expected.name}`)
      }
    }
    const tableSql = readSchemaSql(db, 'table', table.name)
    const actualChecks = tableSql == null
      ? []
      : extractCheckExpressions(tableSql).map(normalizeSqlExpression)
    for (const expected of table.checks ?? []) {
      if (!actualChecks.includes(normalizeSqlExpression(expected.expression))) {
        diagnostics.push(`schema.check_missing:${table.name}.${expected.name}`)
      }
    }
    for (const expected of table.requiredRows ?? []) {
      const values = Object.entries(expected.values)
      const where = values.map(([name]) => `${quoteIdentifier(name)} IS ?`).join(' AND ')
      const exists = values.length > 0 && db.prepare(`
        SELECT 1 FROM ${quoteIdentifier(table.name)} WHERE ${where} LIMIT 1
      `).get(...values.map(([, value]) => value)) != null
      if (!exists) diagnostics.push(`schema.seed_missing:${table.name}.${expected.name}`)
    }
  }
  return diagnostics
}

export function verifyDatabaseAgainstContract(
  db: Database.Database,
  contract: SchemaContract,
  options: DatabaseVerificationOptions,
): DatabaseVerificationResult {
  let diagnostics: string[]
  try {
    diagnostics = verifyStructure(db, contract)
  } catch {
    return { ok: false, reason: 'schema_invalid', diagnostics: ['schema.inspect_failed'] }
  }
  if (diagnostics.length > 0) return { ok: false, reason: 'schema_invalid', diagnostics }

  if (options.runQuickCheck) {
    try {
      if (db.pragma('quick_check', { simple: true }) != 'ok') {
        return { ok: false, reason: 'quick_check_failed', diagnostics: ['quick_check.failed'] }
      }
    } catch {
      return { ok: false, reason: 'quick_check_failed', diagnostics: ['quick_check.error'] }
    }
  }

  if (options.runForeignKeyCheck) {
    try {
      if ((db.pragma('foreign_key_check') as unknown[]).length > 0) {
        return { ok: false, reason: 'foreign_key_check_failed', diagnostics: ['foreign_key_check.failed'] }
      }
    } catch {
      return { ok: false, reason: 'foreign_key_check_failed', diagnostics: ['foreign_key_check.error'] }
    }
  }
  return { ok: true, diagnostics: [] }
}

export function verifyDatabase(
  db: Database.Database,
  options: DatabaseVerificationOptions,
): DatabaseVerificationResult {
  return verifyDatabaseAgainstContract(db, databaseSchemaContract, options)
}

export default verifyDatabase
