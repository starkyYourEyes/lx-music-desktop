export const LEGACY_BACKUP_EXTENSION: string
export const BACKUP_EXPORT_EXTENSIONS: readonly string[]
export const BACKUP_IMPORT_EXTENSIONS: readonly string[]
export const BACKUP_NAMES: Readonly<{
  allData: string
  setting: string
  playlist: string
  playlistText: string
  playlistCsv: string
}>

export const ensureBackupExportPath: (filePath: string) => string
export const createPlaylistPartBackupName: (name: string) => string
export const createListTextName: (name: string) => string
export const createListCsvName: (name: string) => string
