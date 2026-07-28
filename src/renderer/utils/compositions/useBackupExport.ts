import { BACKUP_EXPORT_EXTENSIONS } from '@common/backupFormats'
import { dialog } from '@renderer/plugins/Dialog'
import { useI18n } from '@renderer/plugins/i18n'
import { openSaveDir } from '@renderer/utils/ipc'
import { exportBackupFile } from '@renderer/utils/backupExport'

interface BackupDialogOptions {
  title: string
  defaultPath: string
}

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error)
}

export default () => {
  const t = useI18n()
  const showError = async(error: unknown) => {
    await dialog(t('setting__backup_export_failed', { message: getErrorMessage(error) }))
  }

  return async(
    options: BackupDialogOptions,
    createData: () => unknown | Promise<unknown>,
  ): Promise<string | null> => {
    try {
      const result = await openSaveDir({
        ...options,
        filters: [
          { name: 'Starky LX Music Backup', extensions: [...BACKUP_EXPORT_EXTENSIONS] },
        ],
      })
      if (result.canceled || !result.filePath) return null

      return await exportBackupFile({
        selectedPath: result.filePath,
        createData,
        saveFile: (filePath, data, saveOptions) => {
          return window.lx.worker.main.saveLxConfigFile(filePath, data, saveOptions)
        },
        confirmOverwrite: filePath => dialog.confirm({
          message: t('setting__backup_export_overwrite_confirm', { path: filePath }),
          cancelButtonText: t('cancel_button_text'),
          confirmButtonText: t('lists__import_part_button_confirm'),
        }),
        showError,
      })
    } catch (error) {
      await showError(error)
      return null
    }
  }
}
