const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('./test-utils/load-ts-module')
const { createTestStorageRoot } = require('../build-config/storage/helpers/test-storage-root.js')

const {
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
  preparePortableUserDataPaths,
} = require('../src/main/migration/legacyUserData')

const fixtureByPath = new Map()
const makeRoot = () => {
  const fixture = createTestStorageRoot('legacy-user-data')
  fixtureByPath.set(fixture.path, fixture)
  return fixture.path
}
const cleanupRoot = rootPath => {
  const fixture = fixtureByPath.get(rootPath)
  if (fixture == null) throw new Error('Legacy migration test fixture is not owned')
  fixture.cleanup()
  fixtureByPath.delete(rootPath)
}
const silentLogger = { info() {}, warn() {}, error() {} }

const createAsyncCopyFs = ({ afterDestinationClose, writeError } = {}) => {
  const destinationByDescriptor = new Map()
  return {
    ...fs,
    open(filePath, flags, mode, callback) {
      if (typeof mode == 'function') {
        callback = mode
        mode = undefined
      }
      const done = (error, descriptor) => {
        if (error == null && flags == 'wx' && filePath.includes('.migration-tmp-')) {
          destinationByDescriptor.set(descriptor, filePath)
        }
        callback(error, descriptor)
      }
      if (mode == null) fs.open(filePath, flags, done)
      else fs.open(filePath, flags, mode, done)
    },
    write(descriptor, buffer, offset, length, position, callback) {
      if (writeError != null && destinationByDescriptor.has(descriptor)) {
        return process.nextTick(callback, writeError)
      }
      fs.write(descriptor, buffer, offset, length, position, callback)
    },
    close(descriptor, callback) {
      const destinationPath = destinationByDescriptor.get(descriptor)
      fs.close(descriptor, error => {
        destinationByDescriptor.delete(descriptor)
        if (error == null && destinationPath != null) afterDestinationClose?.(destinationPath)
        callback(error)
      })
    },
  }
}

const runMainStartup = async({ appDataPath, materializeApplicationData, mutateLegacyDuringCopy = false }) => {
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  let exitCode
  let applicationLoaded = false
  const paths = {
    appData: appDataPath,
    exe: path.join(appDataPath, 'LX Music.exe'),
    home: path.join(appDataPath, 'home'),
    temp: path.join(appDataPath, 'temp'),
  }
  const localAppData = path.join(appDataPath, 'local')
  fs.mkdirSync(paths.temp)
  fs.mkdirSync(localAppData)
  const electronApp = {
    exit(code) {
      exitCode = code
    },
    getPath(name) {
      return paths[name]
    },
    setPath(name, value) {
      paths[name] = value
    },
  }
  const realStoragePaths = loadTsModule(path.join(__dirname, '../src/main/utils/storagePaths.ts'))
  const storagePaths = {
    ...realStoragePaths,
    async initializeStoragePaths(input) {
      const resolved = realStoragePaths.resolveStoragePaths(input)
      return {
        paths: { ...resolved, runTempRoot: path.join(resolved.tempRoot, 'run') },
        runTempReservation: null,
      }
    },
  }
  const { bootstrap } = loadTsModule(path.join(__dirname, '../src/main/bootstrap.ts'), {
    electron: { app: {} },
    './utils/storagePaths': storagePaths,
  })

  const originalOpen = fs.open
  const originalConsole = { error: console.error, info: console.info, warn: console.warn }
  if (mutateLegacyDuringCopy) {
    const legacyConfigPath = path.join(appDataPath, 'lx-music-desktop', 'LxDatas', 'config.json')
    let mutated = false
    fs.open = (filePath, flags, ...args) => {
      if (!mutated && filePath == legacyConfigPath && flags == 'r') {
        mutated = true
        fs.writeFileSync(legacyConfigPath, 'changed')
      }
      return originalOpen(filePath, flags, ...args)
    }
  }
  console.error = () => {}
  console.info = () => {}
  console.warn = () => {}
  try {
    await bootstrap(electronApp, async() => {
      applicationLoaded = true
      await materializeApplicationData?.({ currentPath, paths })
    }, {
      platform: 'win32',
      env: { LOCALAPPDATA: localAppData },
    })
  } finally {
    fs.open = originalOpen
    console.error = originalConsole.error
    console.info = originalConsole.info
    console.warn = originalConsole.warn
    delete global.storagePaths
    delete global.lxDataPath
    delete global.lxOldDataPath
    delete global.portableProfileStartup
  }

  return { applicationLoaded, currentPath, exitCode, paths }
}

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

test('copies legacy data atomically and leaves the source unchanged', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'LxDatas'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'LxDatas', 'config.json'), 'legacy')

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(result.userDataPath, 'LxDatas', 'config.json'), 'utf8'), 'legacy')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'LxDatas', 'config.json'), 'utf8'), 'legacy')
  assert.equal(fs.existsSync(path.join(result.userDataPath, MIGRATION_MARKER_FILE)), true)
})

test('does not copy or overwrite when the new directory already exists', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(currentPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'old')
  fs.writeFileSync(path.join(currentPath, 'value'), 'new')

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'old')
})

test('uses a valid current directory without touching a stale lock', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  const lockContents = makeLockMetadata(2147483647)
  fs.mkdirSync(currentPath)
  fs.writeFileSync(path.join(currentPath, 'value'), 'current')
  fs.writeFileSync(lockPath, lockContents)

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'current')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents)
})

test('creates an empty current directory when no legacy data exists', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'legacy-missing')
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('fresh install does not require hard-link support', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const fsApi = {
    ...fs,
    linkSync() {
      const error = new Error('hard links unsupported')
      error.code = 'ENOTSUP'
      throw error
    },
  }

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'legacy-missing')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.lstatSync(result.userDataPath).isDirectory(), true)
})

test('cleans only its temporary directory after a copy failure', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'old')
  const fsApi = createAsyncCopyFs({ writeError: new Error('copy failed') })

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'old')
  assert.equal(fs.existsSync(result.tempPath), false)
  assert.equal(fs.existsSync(result.userDataPath), true)
})

test('does not delete a pre-existing deterministic temporary-path occupant', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const collisionPath = `${currentPath}.migration-tmp`
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(collisionPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  fs.writeFileSync(path.join(collisionPath, 'sentinel'), 'unowned')

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'migrated')
  assert.equal(fs.readFileSync(path.join(collisionPath, 'sentinel'), 'utf8'), 'unowned')
  assert.notEqual(result.tempPath, collisionPath)
})

test('rejects a linked legacy root without writing through it', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const externalPath = path.join(appDataPath, 'external')
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(externalPath)
  fs.writeFileSync(path.join(externalPath, 'value'), 'external')
  if (!createDirectoryLink(t, externalPath, legacyPath)) return

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.readFileSync(path.join(externalPath, 'value'), 'utf8'), 'external')
  assert.equal(fs.existsSync(path.join(externalPath, MIGRATION_MARKER_FILE)), false)
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('rejects linked entries inside the legacy tree', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const externalPath = path.join(appDataPath, 'external')
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(externalPath)
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(externalPath, 'value'), 'external')
  if (!createDirectoryLink(t, externalPath, path.join(legacyPath, 'linked'))) return

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(externalPath, 'value'), 'utf8'), 'external')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('rejects an incomplete nested copy instead of promoting it', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'nested', 'kept'), 'kept')
  fs.writeFileSync(path.join(legacyPath, 'nested', 'omitted'), 'omitted')
  const fsApi = createAsyncCopyFs({
    afterDestinationClose(destinationPath) {
      if (path.basename(destinationPath) == 'omitted') fs.rmSync(destinationPath)
    },
  })

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'nested', 'omitted'), 'utf8'), 'omitted')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('rejects a same-size torn copy using content hashes', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(path.join(legacyPath, 'LxDatas'), { recursive: true })
  fs.writeFileSync(path.join(legacyPath, 'LxDatas', 'lx_data.db-wal'), 'before')
  const fsApi = createAsyncCopyFs({
    afterDestinationClose(destinationPath) {
      if (path.basename(destinationPath) == 'lx_data.db-wal') fs.writeFileSync(destinationPath, 'torn!!')
    },
  })

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(fs.readFileSync(path.join(legacyPath, 'LxDatas', 'lx_data.db-wal'), 'utf8'), 'before')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
})

test('leaves no destination when live legacy data changes during migration', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const walPath = path.join(legacyPath, 'LxDatas', 'lx_data.db-wal')
  fs.mkdirSync(path.dirname(walPath), { recursive: true })
  fs.writeFileSync(walPath, 'before')
  const fsApi = createAsyncCopyFs({
    afterDestinationClose(destinationPath) {
      if (path.basename(destinationPath) == 'lx_data.db-wal') fs.writeFileSync(walPath, 'during')
    },
  })

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(result.userDataPath), false)
  assert.equal(fs.readFileSync(walPath, 'utf8'), 'during')
})

test('leaves no destination when a WAL disappears during the initial scan', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const walPath = path.join(legacyPath, 'LxDatas', 'lx_data.db-wal')
  fs.mkdirSync(path.dirname(walPath), { recursive: true })
  fs.writeFileSync(walPath, 'active')
  let removed = false
  const fsApi = {
    ...fs,
    open(filePath, flags, mode, callback) {
      if (typeof mode == 'function') {
        callback = mode
        mode = undefined
      }
      if (!removed && filePath == walPath && flags == 'r') {
        removed = true
        fs.rmSync(walPath)
      }
      if (mode == null) fs.open(filePath, flags, callback)
      else fs.open(filePath, flags, mode, callback)
    },
  }

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(result.userDataPath), false)
})

test('does not promote data when writing the marker fails', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
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

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.deepEqual(fs.readdirSync(result.userDataPath), [])
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'legacy')
})

test('cleanup failure does not prevent the empty-directory fallback', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  const fsApi = createAsyncCopyFs({ writeError: new Error('copy failed') })
  const originalRm = fs.rmSync
  fs.rmSync = (targetPath, ...args) => {
    if (path.basename(targetPath) == 'payload' &&
      path.basename(path.dirname(targetPath)).startsWith('.guarded-directory-migration-isolation-')) {
      throw new Error('cleanup failed')
    }
    return originalRm(targetPath, ...args)
  }
  let result
  try {
    result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  } finally {
    fs.rmSync = originalRm
  }
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, true)
  assert.equal(fs.existsSync(result.userDataPath), true)
  assert.equal(fs.readFileSync(path.join(legacyPath, 'value'), 'utf8'), 'legacy')
})

test('lease compromise blocks fresh user-data creation after copy failure', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  let compromised = false
  const fsApi = createAsyncCopyFs({ writeError: new Error('copy failed') })
  const originalWrite = fsApi.write
  fsApi.write = (...args) => {
    if (!compromised) {
      compromised = true
      fs.writeFileSync(path.join(lockPath, 'compromise'), 'foreign')
    }
    originalWrite(...args)
  }

  await assert.rejects(
    migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger }),
    error => error?.code == 'migration_lease_compromised',
  )

  assert.equal(fs.existsSync(currentPath), false)
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true)
  assert.equal(fs.readFileSync(path.join(lockPath, 'compromise'), 'utf8'), 'foreign')
})

test('rejects a pre-existing old regular-file lock without deleting it', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  const lockContents = makeLockMetadata(2147483647)
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  fs.writeFileSync(lockPath, lockContents)

  const result = await migrateLegacyUserData({
    appDataPath,
    isProcessAlive: () => false,
    logger: silentLogger,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(currentPath), false)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents)
})

test('does not reclaim an invalid lock solely because it is old', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(lockPath, '')
  fs.utimesSync(lockPath, new Date(0), new Date(0))

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.existsSync(currentPath), false)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), '')
})

test('does not reclaim an old lock while its validated owner is alive', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  const lockContents = makeLockMetadata(process.pid, '2000-01-01T00:00:00.000Z')
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(lockPath, lockContents)

  const result = await migrateLegacyUserData({
    appDataPath,
    isProcessAlive: () => true,
    logger: silentLogger,
  })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockContents)
})

test('rejects a linked lock path without mutating its target', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const externalPath = path.join(appDataPath, 'external-lock-target')
  const lockPath = path.join(appDataPath, 'starky-lx-music-desktop.migration.lock')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(externalPath)
  fs.writeFileSync(path.join(externalPath, 'sentinel'), 'external')
  if (!createDirectoryLink(t, externalPath, lockPath)) return

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.readFileSync(path.join(externalPath, 'sentinel'), 'utf8'), 'external')
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true)
})

test('rejects a non-regular lock path', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const lockPath = path.join(appDataPath, 'starky-lx-music-desktop.migration.lock')
  fs.mkdirSync(legacyPath)
  fs.mkdirSync(lockPath)

  const result = await migrateLegacyUserData({ appDataPath, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true)
})

test('lease release failure overrides an otherwise successful migration', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyPath = path.join(appDataPath, 'lx-music-desktop')
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const lockPath = `${currentPath}.migration.lock`
  fs.mkdirSync(legacyPath)
  fs.writeFileSync(path.join(legacyPath, 'value'), 'legacy')
  const originalRmdir = fs.rmdir
  fs.rmdir = (targetPath, callback) => {
    if (path.resolve(targetPath) == lockPath) {
      return process.nextTick(callback, Object.assign(new Error('injected release failure'), { code: 'EACCES' }))
    }
    return originalRmdir(targetPath, callback)
  }
  try {
    await assert.rejects(
      migrateLegacyUserData({ appDataPath, logger: silentLogger }),
      /injected release failure/,
    )
  } finally {
    fs.rmdir = originalRmdir
  }

  assert.equal(fs.readFileSync(path.join(currentPath, 'value'), 'utf8'), 'legacy')
  assert.equal(fs.lstatSync(lockPath).isDirectory(), true)
  assert.deepEqual(fs.readdirSync(lockPath), [])
})

test('reports an error when the empty-directory fallback cannot be created', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const currentPath = path.join(appDataPath, 'starky-lx-music-desktop')
  const fsApi = {
    ...fs,
    mkdirSync(directoryPath, ...args) {
      if (directoryPath == currentPath) throw new Error('create failed')
      return fs.mkdirSync(directoryPath, ...args)
    },
  }

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'failed')
  assert.equal(result.userDataPathReady, false)
  assert.equal(result.error instanceof Error, true)
})

test('rechecks a concurrently created destination immediately before promotion', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
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

  const result = await migrateLegacyUserData({ appDataPath, fsApi, logger: silentLogger })
  assert.equal(result.status, 'current-exists')
  assert.equal(fs.readFileSync(path.join(currentPath, 'sentinel'), 'utf8'), 'concurrent')
  assert.equal(fs.existsSync(path.join(currentPath, 'value')), false)
})

test('refuses a user-data name that escapes appData', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  await assert.rejects(async() => migrateLegacyUserData({
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

test('creates a direct portable root from the wrapper directory on first launch', t => {
  const launcherRoot = makeRoot()
  t.after(() => cleanupRoot(launcherRoot))
  const extractedExecutable = path.join(launcherRoot, 'nsis-temp', 'app.exe')

  const result = preparePortableUserDataPaths({
    platform: 'win32',
    executablePath: extractedExecutable,
    portableExecutableDir: launcherRoot,
  })

  assert.deepEqual(result, {
    appDataPath: path.join(launcherRoot, 'portable'),
    userDataPath: path.join(launcherRoot, 'portable', 'userData'),
  })
  const stat = fs.lstatSync(result.appDataPath)
  assert.equal(stat.isDirectory(), true)
  assert.equal(stat.isSymbolicLink(), false)
})

test('rejects invalid portable launcher directories without creating a portable child', t => {
  const launcherRoot = makeRoot()
  t.after(() => cleanupRoot(launcherRoot))

  for (const portableExecutableDir of ['', 'relative', 'C:drive-relative']) {
    assert.throws(() => preparePortableUserDataPaths({
      platform: 'win32',
      executablePath: path.join(launcherRoot, 'nsis-temp', 'app.exe'),
      portableExecutableDir,
    }), /portable_executable_directory_invalid/)
    assert.equal(fs.existsSync(path.join(launcherRoot, 'portable')), false)
  }
})

test('rejects linked launcher roots and portable children', t => {
  const launcherRoot = makeRoot()
  t.after(() => cleanupRoot(launcherRoot))
  const linkedLauncherTarget = path.join(launcherRoot, 'linked-launcher-target')
  const linkedLauncher = path.join(launcherRoot, 'linked-launcher')
  fs.mkdirSync(linkedLauncherTarget)
  if (!createDirectoryLink(t, linkedLauncherTarget, linkedLauncher)) return

  assert.throws(() => preparePortableUserDataPaths({
    platform: 'win32',
    executablePath: path.join(launcherRoot, 'nsis-temp', 'app.exe'),
    portableExecutableDir: linkedLauncher,
  }), /direct_directory_invalid/)

  const linkedPortableTarget = path.join(launcherRoot, 'linked-portable-target')
  fs.mkdirSync(linkedPortableTarget)
  if (!createDirectoryLink(t, linkedPortableTarget, path.join(launcherRoot, 'portable'))) return

  assert.throws(() => preparePortableUserDataPaths({
    platform: 'win32',
    executablePath: path.join(launcherRoot, 'nsis-temp', 'app.exe'),
    portableExecutableDir: launcherRoot,
  }), /direct_directory_invalid/)
})

test('startup migrates legacy data before Electron materializes the default user-data directory', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyConfigPath = path.join(appDataPath, 'lx-music-desktop', 'LxDatas', 'config.json')
  fs.mkdirSync(path.dirname(legacyConfigPath), { recursive: true })
  fs.writeFileSync(legacyConfigPath, 'legacy')

  const { currentPath, paths, applicationLoaded } = await runMainStartup({
    appDataPath,
    materializeApplicationData({ currentPath, paths }) {
      const migratedConfigPath = path.join(currentPath, 'LxDatas', 'config.json')
      assert.equal(fs.readFileSync(migratedConfigPath, 'utf8'), 'legacy')
      const logPath = path.join(paths.userData, 'logs', 'startup.log')
      fs.mkdirSync(path.dirname(logPath), { recursive: true })
      fs.writeFileSync(logPath, 'started')
    },
  })

  const migratedConfigPath = path.join(currentPath, 'LxDatas', 'config.json')
  assert.equal(applicationLoaded, true)
  assert.equal(fs.existsSync(migratedConfigPath), true, 'legacy config must exist before the Electron lock creates userData')
  assert.equal(fs.readFileSync(migratedConfigPath, 'utf8'), 'legacy')
  assert.equal(paths.userData, path.join(currentPath, 'LxDatas'))
  assert.equal(fs.readFileSync(path.join(paths.userData, 'logs', 'startup.log'), 'utf8'), 'started')
})

test('startup migration failure cannot materialize the new user-data directory through file logging', async t => {
  const appDataPath = makeRoot()
  t.after(() => cleanupRoot(appDataPath))
  const legacyConfigPath = path.join(appDataPath, 'lx-music-desktop', 'LxDatas', 'config.json')
  fs.mkdirSync(path.dirname(legacyConfigPath), { recursive: true })
  fs.writeFileSync(legacyConfigPath, 'legacy')

  const { applicationLoaded, currentPath, exitCode } = await runMainStartup({
    appDataPath,
    mutateLegacyDuringCopy: true,
    materializeApplicationData() {
      throw new Error('application loader must not run after migration failure')
    },
  })

  assert.equal(exitCode, 1)
  assert.equal(applicationLoaded, false)
  assert.equal(fs.existsSync(currentPath), false, 'a failed migration must remain retryable on the next launch')
})
