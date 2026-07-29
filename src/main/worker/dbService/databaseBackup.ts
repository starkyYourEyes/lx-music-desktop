import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const pathExists = (filePath: string): boolean => {
  try {
    fs.statSync(filePath)
    return true
  } catch (error) {
    if (error != null && typeof error == 'object' && 'code' in error && error.code == 'ENOENT') return false
    throw error
  }
}

export async function createOnlineBackup(
  db: Database.Database,
  destination: string,
): Promise<void> {
  const resolvedDestination = path.resolve(destination)
  if (pathExists(resolvedDestination)) throw new Error('backup_destination_exists')
  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true })
  await db.backup(resolvedDestination)

  const verificationDb = new Database(resolvedDestination, { readonly: true, fileMustExist: true })
  try {
    if (verificationDb.pragma('quick_check', { simple: true }) != 'ok') {
      throw new Error('backup_quick_check_failed')
    }
  } finally {
    verificationDb.close()
  }
}
