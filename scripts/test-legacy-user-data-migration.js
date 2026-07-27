const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
} = require('../src/main/migration/legacyUserData')

const makeRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'starky-user-data-test-'))
const silentLogger = { info() {}, warn() {}, error() {} }

test('copies legacy data atomically and leaves the source unchanged', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'LxDatas'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'LxDatas', 'config.json'), 'legacy')

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(result.userDataPath, 'LxDatas', 'config.json'), 'utf8'), 'legacy')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'LxDatas', 'config.json'), 'utf8'), 'legacy')
  assert.equal(fs.existsSync(path.join(result.userDataPath, MIGRATION_MARKER_FILE)), true)
})

test('does not copy or overwrite when the new directory already exists', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(currentPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'old')
  fs.writeFileSync(path.join(currentPath, 'value'), 'new')

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'old')
})

test('creates an empty current directory when no legacy data exists', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'legacy-missing')
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('cleans only its temporary directory after a copy failure', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'old')
  const fsApi = { ...fs, cpSync() { throw new Error('copy failed') } }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'old')
  assert.equal(fs.existsSync(result.tempPath), false)
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('refuses a user-data name that escapes appData', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  assert.throws(() => migrateLegacyUserData({
    appDataPath,
    currentDirName: '..',
    logger: silentLogger,
  }), /direct child/)
})

test('portable mode resolves package-local paths without invoking migration', () => {
  const result = getPortableUserDataPaths({
    platform: 'win32',
    executablePath: 'D:\\Apps\\LX Music\\LX Music.exe',
    pathExists: candidate => candidate.endsWith('portable'),
  })
  assert.deepEqual(result, {
    appDataPath: path.win32.normalize('D:\\Apps\\LX Music\\portable'),
    userDataPath: path.win32.normalize('D:\\Apps\\LX Music\\portable\\userData'),
  })
  assert.equal(getPortableUserDataPaths({
    platform: 'linux',
    executablePath: '/opt/lx/LX Music',
    pathExists: () => true,
  }), null)
})
