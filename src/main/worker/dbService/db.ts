import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'path'
import tables, { LEGACY_DB_VERSION } from './tables'
import verifyDB from './verifyDB'
import migrateData from './migrate'

let db: Database.Database


const initTables = (db: Database.Database) => {
  db.exec(`
    ${Array.from(tables.values()).join('\n')}
    INSERT INTO "main"."db_info" ("field_name", "field_value") VALUES ('version', '${LEGACY_DB_VERSION}');
  `)
}


// 打开、初始化数据库
export const init = (lxDataPath: string): boolean | null => {
  const databasePath = path.join(lxDataPath, 'lx.data.db')
  const nativeBinding = path.join(__dirname, '../node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  const databaseOptions = fs.existsSync(nativeBinding) ? { nativeBinding } : {}
  let dbFileExists = true

  try {
    db = new Database(databasePath, {
      fileMustExist: true,
      ...databaseOptions,
      // verbose: process.env.NODE_ENV !== 'production' ? console.log : undefined,
    })
  } catch {
    db = new Database(databasePath, {
      ...databaseOptions,
      // verbose: process.env.NODE_ENV !== 'production' ? console.log : undefined,
    })
    initTables(db)
    dbFileExists = false
  }
  db.pragma('foreign_keys = ON')
  db.pragma('journal_mode = WAL')

  migrateData(db)

  // https://www.sqlite.org/pragma.html#pragma_optimize
  if (dbFileExists) db.exec('PRAGMA optimize;')
  if (!verifyDB(db)) {
    db.close()
    return null
  }

  // https://www.sqlite.org/lang_vacuum.html
  // db.exec('VACUUM "main"')

  process.on('exit', () => db.close())
  // require('./test')
  return dbFileExists
}

// 获取数据库实例
export const getAppDB = (): Database.Database => db
export const getDB = getAppDB
