import path from 'node:path'
import { app, dialog, shell } from 'electron'
import type { StorageRecoveryTarget, StorageStartupOutcome } from './storageCoordinator'

type RecoveryOutcome = Extract<StorageStartupOutcome, { status: 'recovery' }>

const sanitizePath = (value: string | null): string => {
  if (value == null) return 'Not available'
  return path.normalize(value).replace(/[\r\n\t]/g, ' ')
}

const sanitizeDiagnostic = (value: string): string | null => {
  return /^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value) ? value : null
}

const targetPath = (target: StorageRecoveryTarget): string | null => {
  switch (target.kind) {
    case 'database': return target.databasePath
    case 'legacy-json': return target.sourcePath
    case 'external-migration': return target.affectedPath
  }
}

const targetDetail = (target: StorageRecoveryTarget): string[] => {
  switch (target.kind) {
    case 'database':
      return [
        `Database: ${sanitizePath(target.databasePath)}`,
        `Backup: ${sanitizePath(target.backupPath)}`,
        ...target.diagnostics.map(sanitizeDiagnostic).filter((value): value is string => value != null),
      ]
    case 'legacy-json':
      return [
        `Source: ${sanitizePath(target.sourcePath)}`,
        `Previous: ${sanitizePath(target.candidatePreviousPath)}`,
      ]
    case 'external-migration':
      return [
        `Component: ${target.component}`,
        `Affected path: ${sanitizePath(target.affectedPath)}`,
        ...target.diagnostics.map(sanitizeDiagnostic).filter((value): value is string => value != null),
      ]
  }
}

export const showStorageRecovery = async(outcome: RecoveryOutcome): Promise<void> => {
  const affectedPath = targetPath(outcome.target)
  const response = await dialog.showMessageBox({
    type: 'error',
    message: 'Storage recovery required',
    detail: targetDetail(outcome.target).join('\n'),
    buttons: ['Open data folder', 'Quit'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (response.response == 0 && affectedPath != null) {
    await shell.openPath(path.dirname(affectedPath))
    return
  }
  app.quit()
}
