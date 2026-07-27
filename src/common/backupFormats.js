const { PROJECT_IDENTITY } = require('./projectIdentity')

const LEGACY_BACKUP_EXTENSION = 'lxmc'
const BACKUP_IMPORT_EXTENSIONS = Object.freeze([
  'json',
  PROJECT_IDENTITY.backupExtension,
  LEGACY_BACKUP_EXTENSION,
])
const BACKUP_NAMES = Object.freeze({
  allData: PROJECT_IDENTITY.allDataBackupName,
  setting: PROJECT_IDENTITY.settingBackupName,
  playlist: PROJECT_IDENTITY.playlistBackupName,
  playlistText: 'starky_list_all.txt',
  playlistCsv: 'starky_list_all.csv',
})

const ensureBackupExportPath = filePath => filePath.toLowerCase().endsWith(`.${PROJECT_IDENTITY.backupExtension}`)
  ? filePath
  : `${filePath}.${PROJECT_IDENTITY.backupExtension}`
const createPlaylistPartBackupName = name => `starky_list_part_${name}.${PROJECT_IDENTITY.backupExtension}`
const createListTextName = name => `starky_list_${name}.txt`
const createListCsvName = name => `starky_list_${name}.csv`

module.exports = {
  LEGACY_BACKUP_EXTENSION,
  BACKUP_IMPORT_EXTENSIONS,
  BACKUP_NAMES,
  ensureBackupExportPath,
  createPlaylistPartBackupName,
  createListTextName,
  createListCsvName,
}
