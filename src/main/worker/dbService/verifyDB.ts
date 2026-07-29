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

const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`

const sameColumns = (actual: readonly unknown[], expected: readonly string[]): boolean =>
  actual.length == expected.length && actual.every((value, index) => value == expected[index])

const readIndexes = (db: Database.Database, table: string): Array<{
  name: string
  unique: boolean
  partial: boolean
  columns: Array<string | null>
}> =>
  (db.pragma(`index_list(${quoteIdentifier(table)})`) as IndexListRow[]).map(index => ({
    name: index.name,
    unique: index.unique == 1,
    partial: index.partial == 1,
    columns: (db.pragma(`index_info(${quoteIdentifier(index.name)})`) as IndexInfoRow[])
      .sort((a, b) => a.seqno - b.seqno)
      .map(columnInfo => columnInfo.name),
  }))

const hasIndex = (
  actual: ReturnType<typeof readIndexes>,
  expected: SchemaIndexContract,
): boolean => actual.some(index =>
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
    }
    const indexes = readIndexes(db, table.name)
    for (const expected of table.indexes) {
      if (!hasIndex(indexes, expected)) diagnostics.push(`schema.index_invalid:${table.name}.${expected.name}`)
    }
    const foreignKeys = readForeignKeys(db, table.name)
    for (const expected of table.foreignKeys) {
      if (!hasForeignKey(foreignKeys, expected)) {
        diagnostics.push(`schema.foreign_key_invalid:${table.name}.${expected.name}`)
      }
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
