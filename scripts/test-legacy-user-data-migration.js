const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
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

const makeLockMetadata = (pid, createdAt = new Date().toISOString()) => JSON.stringify({
  version: 1,
  pid,
  nonce: '0123456789abcdef0123456789abcdef',
  createdAt,
})

const createDirectoryLink = (t, targetPath, linkPath) => {
  try {
    fs.symlinkSync(targetPath, linkPath, process.platform == 'win32' ? 'junction' : 'dir')
    return true
  } catch (error) {
    if (['EACCES', 'ENOSYS', 'ENOTSUP', 'EPERM'].includes(error.code)) {
      t.skip(`directory links are unavailable: ${error.code}`)
      return false
    }
    throw error
  }
}

const startLockHolder = lockPath => new Promise((resolve, reject) => {
  const script = `
    const fs = require('node:fs')
    const lockPath = process.argv[1]
    const fd = fs.openSync(lockPath, 'wx')
    fs.writeSync(fd, JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: 'fedcba9876543210fedcba9876543210',
      createdAt: new Date().toISOString(),
    }))
    fs.fsyncSync(fd)
    process.stdout.write('locked\\n')
    setInterval(() => {}, 1000)
  `
  const child = spawn(process.execPath, ['-e', script, lockPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  let settled = false
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.once('error', reject)
  child.once('exit', code => {
    if (!settled) reject(new Error(`lock holder exited with ${code}: ${stderr}`))
  })
  child.stdout.once('data', chunk => {
    if (!chunk.toString().includes('locked')) return reject(new Error(`unexpected lock holder output: ${chunk}`))
    settled = true
    resolve(child)
  })
})

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

test('uses a valid current directory without touching a stale lock', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  const lockContents = makeLockMetadata(2147483647)
  fs.mkdirSync(currentPath)
  fs.writeFileSync(path.join(currentPath, 'value'), 'current')
  fs.writeFileSync(lockPath, lockContents)

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'current')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents)
})

test('creates an empty current directory when no legacy data exists', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'legacy-missing')
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('fresh install does not require hard-link support', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const fsApi = {
    ...fs,
    linkSync() {
      const error = new Error('hard links unsupported')
      error.code = 'ENOTSUP'
      throw error
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'legacy-missing')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.lstatSync(result.userDataPath).isDirectory(), true)
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

test('does not delete a pre-existing deterministic temporary-path occupant', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const collisionPath = `${currentPath}.migration-tmp`
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(collisionPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  fs.writeFileSync(path.join(collisionPath, 'sentinel'), 'unowned')

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(collisionPath, 'sentinel'), 'utf8'), 'unowned')
  assert.notEqual(result.tempPath, collisionPath)
})

test('rejects a linked legacy root without writing through it', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const externalPath = path.join(appDataPath, 'external')
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(externalPath)
  fs.writeFileSync(path.join(externalPath, 'value'), 'external')
  if (!createDirectoryLink(t, externalPath, legacyPath)) return

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.readFileSync(path.join(externalPath, 'value'), 'utf8'), 'external')
  assert.equal(fs.existsSync(path.join(externalPath, MIGRATION_MARKER_FILE)), false)
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('rejects linked entries inside the legacy tree', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const externalPath = path.join(appDataPath, 'external')
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(externalPath)
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(externalPath, 'value'), 'external')
  if (!createDirectoryLink(t, externalPath, path.join(legacyPath, 'linked'))) return

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(externalPath, 'value'), 'utf8'), 'external')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('rejects an incomplete nested copy instead of promoting it', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'nested', 'kept'), 'kept')
  fs.writeFileSync(path.join(legacyPath, 'nested', 'omitted'), 'omitted')
  const fsApi = {
    ...fs,
    cpSync(sourcePath, destinationPath, options) {
      fs.cpSync(sourcePath, destinationPath, options)
      fs.rmSync(path.join(destinationPath, 'nested', 'omitted'))
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'nested', 'omitted'), 'utf8'), 'omitted')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('rejects a same-size torn copy using content hashes', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'LxDatas'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'LxDatas', 'lx_data.db-wal'), 'before')
  const fsApi = {
    ...fs,
    cpSync(sourcePath, destinationPath, options) {
      fs.cpSync(sourcePath, destinationPath, options)
      fs.writeFileSync(path.join(destinationPath, 'LxDatas', 'lx_data.db-wal'), 'torn!!')
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'LxDatas', 'lx_data.db-wal'), 'utf8'), 'before')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('leaves no destination when live legacy data changes during migration', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const walPath = path.join(legacyPath, 'LxDatas', 'lx_data.db-wal')
  fs.mkdirSync(path.dirname(walPath), { recursive: true })
  fs.writeFileSync(walPath, 'before')
  const fsApi = {
    ...fs,
    cpSync(sourcePath, destinationPath, options) {
      fs.cpSync(sourcePath, destinationPath, options)
      fs.writeFileSync(walPath, 'during')
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(result.userDataPath), false)
  assert.equal(fs.readFileSync(walPath, 'utf8'), 'during')
})

test('leaves no destination when a WAL disappears during the initial scan', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const walPath = path.join(legacyPath, 'LxDatas', 'lx_data.db-wal')
  fs.mkdirSync(path.dirname(walPath), { recursive: true })
  fs.writeFileSync(walPath, 'active')
  let removed = false
  const fsApi = {
    ...fs,
    openSync(filePath, flags, ...args) {
      if (!removed && filePath == walPath && flags == 'r') {
        removed = true
        fs.rmSync(walPath)
      }
      return fs.openSync(filePath, flags, ...args)
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(result.userDataPath), false)
})

test('does not promote data when writing the marker fails', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  const fsApi = {
    ...fs,
    writeFileSync(filePath, ...args) {
      if (path.basename(filePath) == MIGRATION_MARKER_FILE) throw new Error('marker failed')
      return fs.writeFileSync(filePath, ...args)
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'legacy')
})

test('cleanup failure does not prevent the empty-directory fallback', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  const fsApi = {
    ...fs,
    cpSync() { throw new Error('copy failed') },
    rmSync() { throw new Error('cleanup failed') },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.existsSync(result.userDataPath), true)
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'legacy')
})

test('a cooperating process lock blocks migration without creating the destination', async t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  const lockHolder = await startLockHolder(lockPath)

  try {
    const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
    assert.equal(result.status, 'failed')
    assert.equal(result.userDataPathReady, false)
    assert.equal(fs.existsSync(currentPath), false)
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, lockHolder.pid)
  } finally {
    lockHolder.kill()
    await once(lockHolder, 'exit')
  }
})

test('reclaims a dead owner lock and migrates', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  const lockContents = makeLockMetadata(2147483647)
  const candidatePath = `${lockPath}.${JSON.parse(lockContents).nonce}.candidate`
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  fs.writeFileSync(candidatePath, lockContents)
  fs.linkSync(candidatePath, lockPath)

  const result = migrateLegacyUserData({
    appDataPath,
    isProcessAlive: () => false,
    logger: silentLogger,
  })
  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'legacy')
  assert.equal(fs.existsSync(lockPath), false)
  assert.equal(fs.existsSync(candidatePath), false)
})

test('does not reclaim an invalid lock solely because it is old', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(lockPath, '')
  fs.utimesSync(lockPath, new Date(0), new Date(0))

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(currentPath), false)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '')
})

test('does not reclaim an old lock while its validated owner is alive', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  const lockContents = makeLockMetadata(process.pid, '2000-01-01T00:00:00.000Z')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(lockPath, lockContents)

  const result = migrateLegacyUserData({
    appDataPath,
    isProcessAlive: () => true,
    logger: silentLogger,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents)
})

test('rejects a linked lock path without mutating its target', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const externalPath = path.join(appDataPath, 'external-lock-target')
  const lockPath = path.join(appDataPath, 'starky-lx-music-desktop.migration.lock')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(externalPath)
  fs.writeFileSync(path.join(externalPath, 'sentinel'), 'external')
  if (!createDirectoryLink(t, externalPath, lockPath)) return

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.readFileSync(path.join(externalPath, 'sentinel'), 'utf8'), 'external')
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true)
})

test('rejects a non-regular lock path', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const lockPath = path.join(appDataPath, 'starky-lx-music-desktop.migration.lock')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(lockPath)

  const result = migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true)
})

test('closes an exclusively created lock if reading its identity fails', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  let lockClosed = false
  let failIdentity = true
  const fsApi = {
    ...fs,
    fstatSync(fd) {
      if (failIdentity) {
        failIdentity = false
        throw new Error('identity failed')
      }
      return fs.fstatSync(fd)
    },
    closeSync(fd) {
      lockClosed = true
      fs.closeSync(fd)
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(lockClosed, true)
  assert.equal(fs.existsSync(result.lockPath), false)

  const restartedResult = migrateLegacyUserData({
    appDataPath,
    fsApi,
    logger: silentLogger,
  })
  assert.equal(restartedResult.status, 'migrated')
  assert.equal(fs.existsSync(restartedResult.lockPath), false)
})

test('removes its candidate when writing lock metadata fails', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  const fsApi = {
    ...fs,
    writeSync() { throw new Error('write failed') },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.deepEqual(fs.readdirSync(appDataPath).filter(entry => entry.endsWith('.candidate')), [])
  assert.equal(fs.existsSync(result.lockPath), false)
})

test('removes its candidate when syncing lock metadata fails', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  const fsApi = {
    ...fs,
    fsyncSync() { throw new Error('sync failed') },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.deepEqual(fs.readdirSync(appDataPath).filter(entry => entry.endsWith('.candidate')), [])
  assert.equal(fs.existsSync(result.lockPath), false)
})

test('recovers a failed lock release after the owner process exits', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const valuePath = path.join(legacyPath, 'value')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(valuePath, 'before')
  let failRelease = true
  const fsApi = {
    ...fs,
    cpSync(sourcePath, destinationPath, options) {
      fs.cpSync(sourcePath, destinationPath, options)
      fs.writeFileSync(valuePath, 'during')
    },
    unlinkSync(filePath) {
      if (failRelease && filePath.endsWith('.migration.lock')) {
        failRelease = false
        throw new Error('release failed')
      }
      return fs.unlinkSync(filePath)
    },
  }

  const firstResult = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(firstResult.status, 'failed')
  assert.equal(firstResult.userDataPathReady, false)
  assert.equal(fs.existsSync(firstResult.userDataPath), false)
  assert.equal(fs.existsSync(firstResult.lockPath), true)

  const restartedResult = migrateLegacyUserData({
    appDataPath,
    fsApi: { ...fsApi, cpSync: fs.cpSync },
    isProcessAlive: () => false,
    logger: silentLogger,
  })
  assert.equal(restartedResult.status, 'migrated')
  assert.equal(restartedResult.userDataPathReady, true)
  assert.equal(fs.readFileSync(path.join(restartedResult.userDataPath, 'value'), 'utf8'), 'during')
  assert.equal(fs.existsSync(restartedResult.lockPath), false)
})

test('reports an error when the empty-directory fallback cannot be created', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const fsApi = {
    ...fs,
    mkdirSync(directoryPath, ...args) {
      if (directoryPath == currentPath) throw new Error('create failed')
      return fs.mkdirSync(directoryPath, ...args)
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(result.error instanceof Error, true)
})

test('rechecks a concurrently created destination immediately before promotion', t => {
  const appDataPath = makeRoot()
  t.after(() => fs.rmSync(appDataPath, { recursive: true, force: true }))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  const fsApi = {
    ...fs,
    writeFileSync(filePath, ...args) {
      const result = fs.writeFileSync(filePath, ...args)
      if (path.basename(filePath) == MIGRATION_MARKER_FILE && path.dirname(filePath) != currentPath) {
        fs.mkdirSync(currentPath)
        fs.writeFileSync(path.join(currentPath, 'sentinel'), 'concurrent')
      }
      return result
    },
  }

  const result = migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(fs.readFileSync(path.join(currentPath, 'sentinel'), 'utf8'), 'concurrent')
  assert.equal(fs.existsSync(path.join(currentPath, 'value')), false)
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

test('startup exits cleanly when installed user data is not ready', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '../src/main/app.ts'), 'utf8')
  const indexSource = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8')
  const singleInstanceIndex = indexSource.indexOf('initSingleInstanceHandle()')
  const userDataIndex = indexSource.indexOf('const userDataStatus = setUserDataPath()')

  assert.ok(singleInstanceIndex >= 0 && singleInstanceIndex < userDataIndex)
  assert.match(appSource, /if \(!migration\.userDataPathReady\) \{\s*return \{ ready: false, error:/)
  assert.match(indexSource, /if \(!userDataStatus\.ready\) \{[\s\S]*log\.error\([\s\S]*app\.exit\(1\)[\s\S]*\} else \{[\s\S]*registerDeeplink\(init\)[\s\S]*listenerAppEvent\(init\)[\s\S]*app\.whenReady\(\)/)
  assert.match(appSource, /if \(!app\.requestSingleInstanceLock\(\)\) \{[\s\S]*process\.exit\(0\)/)
})
