const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const { gzipSync } = require('node:zlib')

const root = path.resolve(__dirname, '..')
const originalResolveFilename = require('node:module')._resolveFilename
require('node:module')._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@common/')) {
    request = path.join(root, 'src/common', request.slice('@common/'.length))
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: filename,
  })
  module._compile(outputText, filename)
}

const {
  BACKUP_EXPORT_EXTENSIONS,
  BACKUP_IMPORT_EXTENSIONS,
  BACKUP_NAMES,
  createPlaylistPartBackupName,
  createListTextName,
  createListCsvName,
  ensureBackupExportPath,
} = require('../src/common/backupFormats')
const {
  readLxConfigFile,
  saveLxConfigFile,
} = require('../src/common/utils/nodejs.ts')
const backupExportModule = require('../src/renderer/utils/backupExport.ts')

const createTempDir = async t => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'starky-backup-test-'))
  t.after(() => fs.promises.rm(tempDir, { recursive: true, force: true }))
  return tempDir
}

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
  assert.deepEqual(BACKUP_EXPORT_EXTENSIONS, ['slxmc'])
})

test('renderer exposes one compressed-backup export workflow', () => {
  assert.equal(typeof backupExportModule.exportBackupFile, 'function')
})

test('a derived target uses exclusive creation without an overwrite prompt', async t => {
  const tempDir = await createTempDir(t)
  const selectedPath = path.join(tempDir, 'new-backup')
  const saveOptions = []
  let confirmCount = 0
  const data = { type: 'setting_v2', data: { marker: 'new' } }

  const finalPath = await backupExportModule.exportBackupFile({
    selectedPath,
    createData: () => data,
    saveFile: async(filePath, value, options) => {
      saveOptions.push(options)
      return saveLxConfigFile(filePath, value, options)
    },
    confirmOverwrite: async() => {
      confirmCount++
      return true
    },
    showError: error => assert.fail(error),
  })

  assert.equal(finalPath, `${selectedPath}.slxmc`)
  assert.deepEqual(saveOptions, [{ allowOverwrite: false }])
  assert.equal(confirmCount, 0)
  assert.deepEqual(await readLxConfigFile(finalPath), data)
})

test('an existing derived target is overwritten only after explicit confirmation', async t => {
  const tempDir = await createTempDir(t)
  const selectedPath = path.join(tempDir, 'existing-backup')
  const finalPath = `${selectedPath}.slxmc`
  const originalData = { type: 'setting_v2', data: { marker: 'original' } }
  const replacementData = { type: 'setting_v2', data: { marker: 'replacement' } }
  await fs.promises.writeFile(finalPath, gzipSync(JSON.stringify(originalData)))
  const confirmations = []
  const saveOptions = []

  const result = await backupExportModule.exportBackupFile({
    selectedPath,
    createData: () => replacementData,
    saveFile: async(filePath, value, options) => {
      saveOptions.push(options)
      try {
        return await saveLxConfigFile(filePath, value, options)
      } catch (error) {
        const remoteError = new Error(error.message)
        remoteError.name = error.name
        throw remoteError
      }
    },
    confirmOverwrite: async(filePath) => {
      confirmations.push(filePath)
      return true
    },
    showError: error => assert.fail(error),
  })

  assert.equal(result, finalPath)
  assert.deepEqual(confirmations, [finalPath])
  assert.deepEqual(saveOptions, [{ allowOverwrite: false }, { allowOverwrite: true }])
  assert.deepEqual(await readLxConfigFile(finalPath), replacementData)
})

test('declining derived-target overwrite preserves the existing file', async t => {
  const tempDir = await createTempDir(t)
  const selectedPath = path.join(tempDir, 'declined-backup')
  const finalPath = `${selectedPath}.slxmc`
  const originalData = { type: 'setting_v2', data: { marker: 'original' } }
  await fs.promises.writeFile(finalPath, gzipSync(JSON.stringify(originalData)))

  const result = await backupExportModule.exportBackupFile({
    selectedPath,
    createData: () => ({ type: 'setting_v2', data: { marker: 'replacement' } }),
    saveFile: saveLxConfigFile,
    confirmOverwrite: async() => false,
    showError: error => assert.fail(error),
  })

  assert.equal(result, null)
  assert.deepEqual(await readLxConfigFile(finalPath), originalData)
})

test('an exact path confirmed by the native dialog may be overwritten', async t => {
  const tempDir = await createTempDir(t)
  const selectedPath = path.join(tempDir, 'confirmed.slxmc')
  const replacementData = { type: 'setting_v2', data: { marker: 'replacement' } }
  await fs.promises.writeFile(selectedPath, gzipSync(JSON.stringify({ marker: 'original' })))
  let confirmCount = 0

  const result = await backupExportModule.exportBackupFile({
    selectedPath,
    createData: () => replacementData,
    saveFile: saveLxConfigFile,
    confirmOverwrite: async() => {
      confirmCount++
      return true
    },
    showError: error => assert.fail(error),
  })

  assert.equal(result, selectedPath)
  assert.equal(confirmCount, 0)
  assert.deepEqual(await readLxConfigFile(selectedPath), replacementData)
})

test('backup export failures are routed to a visible error handler', async t => {
  const tempDir = await createTempDir(t)
  const errors = []

  const result = await backupExportModule.exportBackupFile({
    selectedPath: path.join(tempDir, 'missing', 'failed.slxmc'),
    createData: () => ({ type: 'setting_v2' }),
    saveFile: saveLxConfigFile,
    confirmOverwrite: async() => true,
    showError: error => errors.push(error),
  })

  assert.equal(result, null)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, 'ENOENT')
})

test('new backup save resolves after the compressed file is readable', async t => {
  const tempDir = await createTempDir(t)
  const requestedPath = path.join(tempDir, 'all-data')
  const expectedPath = `${requestedPath}.slxmc`
  const data = { type: 'allData_v2', setting: { theme: 'green' }, playList: [] }

  const finalPath = await saveLxConfigFile(requestedPath, data, { allowOverwrite: false })

  assert.equal(finalPath, expectedPath)
  assert.deepEqual(await readLxConfigFile(finalPath), data)
})

test('compressed backup extension detection is case insensitive', async t => {
  const tempDir = await createTempDir(t)
  const data = { type: 'playList', data: [{ id: 'legacy-list' }] }

  for (const extension of ['SLXMC', 'lxmc', 'LXMC']) {
    const filePath = path.join(tempDir, `backup.${extension}`)
    await fs.promises.writeFile(filePath, gzipSync(JSON.stringify(data)))
    assert.deepEqual(await readLxConfigFile(filePath), data)
  }
})

test('JSON backup detection is case insensitive', async t => {
  const tempDir = await createTempDir(t)
  const data = { type: 'setting_v2', data: { volume: 0.5 } }

  for (const extension of ['json', 'JSON']) {
    const filePath = path.join(tempDir, `settings.${extension}`)
    await fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8')
    assert.deepEqual(await readLxConfigFile(filePath), data)
  }
})

test('backup write errors reject the save promise', async t => {
  const tempDir = await createTempDir(t)
  const filePath = path.join(tempDir, 'missing', 'settings.slxmc')

  await assert.rejects(
    saveLxConfigFile(filePath, { type: 'setting_v2' }, { allowOverwrite: true }),
    error => error.code === 'ENOENT',
  )
})

test('an unconfirmed derived target is never silently overwritten', async t => {
  const tempDir = await createTempDir(t)
  const requestedPath = path.join(tempDir, 'existing')
  const finalPath = `${requestedPath}.slxmc`
  const originalData = { type: 'setting_v2', data: { marker: 'original' } }
  await fs.promises.writeFile(finalPath, gzipSync(JSON.stringify(originalData)))

  await assert.rejects(
    saveLxConfigFile(requestedPath, { type: 'setting_v2', data: { marker: 'replacement' } }, { allowOverwrite: false }),
    error => error.code === 'EEXIST',
  )
  assert.deepEqual(await readLxConfigFile(finalPath), originalData)
})

test('backup UI and worker consume the shared helper', () => {
  for (const relativePath of [
    'src/common/utils/nodejs.ts',
    'src/renderer/utils/compositions/useBackupExport.ts',
    'src/renderer/views/Setting/components/SettingBackup.vue',
    'src/renderer/views/List/MyList/useShare.ts',
    'src/renderer/worker/main/list.ts',
  ]) {
    const source = fs.readFileSync(path.join(root, relativePath), 'utf8')
    assert.match(source, /backupFormats/, relativePath)
    assert.doesNotMatch(source, /defaultPath:\s*['"`]lx_/, relativePath)
  }

  const exportComposition = fs.readFileSync(
    path.join(root, 'src/renderer/utils/compositions/useBackupExport.ts'),
    'utf8',
  )
  assert.match(exportComposition, /filters:[\s\S]*BACKUP_EXPORT_EXTENSIONS/)

  const settingBackup = fs.readFileSync(
    path.join(root, 'src/renderer/views/Setting/components/SettingBackup.vue'),
    'utf8',
  )
  const listBackup = fs.readFileSync(
    path.join(root, 'src/renderer/views/List/MyList/useShare.ts'),
    'utf8',
  )
  assert.equal(settingBackup.match(/await saveBackup\(/g)?.length, 3)
  assert.equal(listBackup.match(/await saveBackup\(/g)?.length, 1)
  assert.doesNotMatch(settingBackup, /void window\.lx\.worker\.main\.saveLxConfigFile/)
  assert.doesNotMatch(listBackup, /void window\.lx\.worker\.main\.saveLxConfigFile/)
})
