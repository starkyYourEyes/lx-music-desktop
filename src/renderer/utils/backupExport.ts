import { ensureBackupExportPath } from '@common/backupFormats'

interface BackupSaveOptions {
  allowOverwrite: boolean
}

interface BackupExportOptions {
  selectedPath: string
  createData: () => unknown | Promise<unknown>
  saveFile: (filePath: string, data: unknown, options: BackupSaveOptions) => Promise<string>
  confirmOverwrite: (filePath: string) => boolean | Promise<boolean>
  showError: (error: unknown) => void | Promise<void>
}

const isFileExistsError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false
  return error.name == 'BackupFileExistsError' ||
    (error as NodeJS.ErrnoException).code == 'EEXIST'
}

export const exportBackupFile = async({
  selectedPath,
  createData,
  saveFile,
  confirmOverwrite,
  showError,
}: BackupExportOptions): Promise<string | null> => {
  const finalPath = ensureBackupExportPath(selectedPath)
  const allowOverwrite = finalPath == selectedPath

  try {
    const data = await createData()
    try {
      return await saveFile(finalPath, data, { allowOverwrite })
    } catch (error) {
      if (allowOverwrite || !isFileExistsError(error)) throw error
      if (!await confirmOverwrite(finalPath)) return null
      return await saveFile(finalPath, data, { allowOverwrite: true })
    }
  } catch (error) {
    await showError(error)
    return null
  }
}
