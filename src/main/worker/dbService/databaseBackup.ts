import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

export async function createOnlineBackup(
  db: Database.Database,
  destination: string,
  nativeOptions: { nativeBinding?: string } = {},
): Promise<void> {
  const resolvedDestination = path.resolve(destination)
  fs.mkdirSync(path.dirname(resolvedDestination), { recursive: true })
  const reservation = await fs.promises.open(resolvedDestination, 'wx', 0o600)
  await reservation.close()
  await db.backup(resolvedDestination)

  const verificationDb = new Database(resolvedDestination, { ...nativeOptions, readonly: true, fileMustExist: true })
  try {
    if (verificationDb.pragma('quick_check', { simple: true }) != 'ok') {
      throw new Error('backup_quick_check_failed')
    }
  } finally {
    verificationDb.close()
  }
}
