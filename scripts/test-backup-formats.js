const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const {
  BACKUP_IMPORT_EXTENSIONS,
  BACKUP_NAMES,
  createPlaylistPartBackupName,
  createListTextName,
  createListCsvName,
  ensureBackupExportPath,
} = require('../src/common/backupFormats')

test('new exports use approved names and extension', () => {
  assert.deepEqual(BACKUP_NAMES, {
    allData: 'starky_datas_v2.slxmc',
    setting: 'starky_setting_v2.slxmc',
    playlist: 'starky_list.slxmc',
    playlistText: 'starky_list_all.txt',
    playlistCsv: 'starky_list_all.csv',
  })
  assert.equal(createPlaylistPartBackupName('Road Trip'), 'starky_list_part_Road Trip.slxmc')
  assert.equal(createListTextName('Road Trip'), 'starky_list_Road Trip.txt')
  assert.equal(createListCsvName('Road Trip'), 'starky_list_Road Trip.csv')
  assert.equal(ensureBackupExportPath('D:/backup/data'), 'D:/backup/data.slxmc')
  assert.equal(ensureBackupExportPath('D:/backup/data.SLXMC'), 'D:/backup/data.SLXMC')
  assert.equal(ensureBackupExportPath('D:/backup/data.lxmc'), 'D:/backup/data.lxmc.slxmc')
})

test('selectors retain JSON and accept new and legacy backup extensions', () => {
  assert.deepEqual(BACKUP_IMPORT_EXTENSIONS, ['json', 'slxmc', 'lxmc'])
})

test('backup UI and worker consume the shared helper', () => {
  for (const relativePath of [
    'src/common/utils/nodejs.ts',
    'src/renderer/views/Setting/components/SettingBackup.vue',
    'src/renderer/views/List/MyList/useShare.ts',
    'src/renderer/worker/main/list.ts',
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert.match(source, /backupFormats/, relativePath)
    assert.doesNotMatch(source, /defaultPath:\s*['"`]lx_/, relativePath)
  }
})
