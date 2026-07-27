const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { PROJECT_IDENTITY } = require('../../common/projectIdentity')

const LEGACY_USER_DATA_DIR_NAME = 'lx-music-desktop'
const MIGRATION_MARKER_FILE = '.legacy-user-data-migration.json'
const TEMP_SUFFIX = '.migration-tmp'
const LOCK_SUFFIX = '.migration.lock'
const LOCK_VERSION = 1
const LOCK_ACQUIRE_ATTEMPTS = 3
const HASH_BUFFER_SIZE = 64 * 1024

class LegacyDataChangedError extends Error {}
class UnsupportedLegacyDataError extends Error {}

const assertDirectChild = (rootPath, candidatePath) => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (path.dirname(candidate) != root || candidate == root) {
    throw new Error(`Migration path must be a direct child of appData: ${candidate}`)
  }
}

const safeLog = (logger, method, ...args) => {
  try {
    logger[method]?.(...args)
  } catch {}
}

const isSameNode = (left, right) => left.dev == right.dev && left.ino == right.ino

const closeDescriptor = (fsApi, fd, logger) => {
  try {
    fsApi.closeSync(fd)
  } catch (error) {
    safeLog(logger, 'warn', 'Could not close user-data migration file', error)
  }
}

const parseLockOwner = raw => {
  let owner
  try {
    owner = JSON.parse(raw)
  } catch {
    throw new Error('Migration lock metadata is invalid')
  }
  if (
    owner?.version != LOCK_VERSION ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce != 'string' ||
    !/^[a-f0-9]{32}$/.test(owner.nonce) ||
    typeof owner.createdAt != 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt))
  ) {
    throw new Error('Migration lock metadata is invalid')
  }
  return owner
}

const readLockSnapshot = (fsApi, lockPath) => {
  const before = fsApi.lstatSync(lockPath)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Migration lock must be a regular file: ${lockPath}`)
  }
  const raw = fsApi.readFileSync(lockPath, 'utf8')
  const after = fsApi.lstatSync(lockPath)
  if (!isSameNode(before, after)) throw new Error('Migration lock changed while it was inspected')
  return { identity: after, owner: parseLockOwner(raw), raw }
}

const removeOwnedLockFile = (fsApi, lockPath, expectedIdentity, expectedOwner, logger) => {
  try {
    const snapshot = readLockSnapshot(fsApi, lockPath)
    if (!isSameNode(expectedIdentity, snapshot.identity) || snapshot.owner.nonce != expectedOwner.nonce) return false
    fsApi.unlinkSync(lockPath)
    return true
  } catch (error) {
    if (error?.code != 'ENOENT') safeLog(logger, 'warn', `Could not remove owned migration file: ${lockPath}`, error)
    return false
  }
}

const releaseOwnedLock = (fsApi, lock, logger) => {
  removeOwnedLockFile(fsApi, lock.lockPath, lock.identity, lock.owner, logger)
  closeDescriptor(fsApi, lock.fd, logger)
}

const defaultIsProcessAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code != 'ESRCH'
  }
}

const reclaimDeadLock = (fsApi, lockPath, isProcessAlive, logger) => {
  let first
  try {
    first = readLockSnapshot(fsApi, lockPath)
  } catch (error) {
    return { reclaimed: false, error }
  }

  try {
    if (isProcessAlive(first.owner.pid)) {
      return { reclaimed: false, error: new Error(`User-data migration is active in process ${first.owner.pid}`) }
    }
  } catch (error) {
    return { reclaimed: false, error: new Error(`Could not verify migration lock owner: ${error.message}`) }
  }

  try {
    const current = readLockSnapshot(fsApi, lockPath)
    if (!isSameNode(first.identity, current.identity) || first.raw != current.raw) {
      return { reclaimed: false, error: new Error('Migration lock changed before stale-lock recovery') }
    }
    // This check/unlink is exact for cooperating app processes. Portable Node has
    // no unlink-by-handle primitive that can exclude arbitrary filesystem writers.
    fsApi.unlinkSync(lockPath)
    const candidatePath = `${lockPath}.${first.owner.nonce}.candidate`
    removeOwnedLockFile(fsApi, candidatePath, first.identity, first.owner, logger)
    safeLog(logger, 'info', `Recovered stale user-data migration lock from process ${first.owner.pid}`)
    return { reclaimed: true }
  } catch (error) {
    if (error?.code == 'ENOENT') return { reclaimed: true }
    return { reclaimed: false, error }
  }
}

const writeAll = (fsApi, fd, value) => {
  const data = Buffer.from(value)
  let offset = 0
  while (offset < data.length) {
    const written = fsApi.writeSync(fd, data, offset, data.length - offset)
    if (written <= 0) throw new Error('Could not write migration lock metadata')
    offset += written
  }
}

const acquireMigrationLock = ({ fsApi, rootPath, lockPath, isProcessAlive, logger }) => {
  let lastError = new Error('Could not acquire user-data migration lock')

  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const owner = {
      version: LOCK_VERSION,
      pid: process.pid,
      nonce: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
    }
    const candidatePath = `${lockPath}.${owner.nonce}.candidate`
    assertDirectChild(rootPath, candidatePath)
    let fd
    let identity
    let linkAttempted = false

    try {
      fd = fsApi.openSync(candidatePath, 'wx')
      writeAll(fsApi, fd, JSON.stringify(owner))
      fsApi.fsyncSync(fd)
      identity = fsApi.fstatSync(fd)
      linkAttempted = true
      fsApi.linkSync(candidatePath, lockPath)
      removeOwnedLockFile(fsApi, candidatePath, identity, owner, logger)
      return { fd, identity, lockPath, owner }
    } catch (error) {
      lastError = error
      if (identity != null) removeOwnedLockFile(fsApi, candidatePath, identity, owner, logger)
      if (fd != null) closeDescriptor(fsApi, fd, logger)

      if (!linkAttempted && error?.code == 'EEXIST') continue
      if (!linkAttempted || error?.code != 'EEXIST') break

      const recovery = reclaimDeadLock(fsApi, lockPath, isProcessAlive, logger)
      if (!recovery.reclaimed) return { error: recovery.error ?? error }
    }
  }

  return { error: lastError }
}

const removeOwnedTemp = (fsApi, tempPath, logger) => {
  if (tempPath == null) return
  try {
    fsApi.rmSync(tempPath, { recursive: true, force: true })
  } catch (error) {
    safeLog(logger, 'warn', 'Could not remove user-data migration temporary directory', error)
  }
}

const getUsableDirectory = (fsApi, directoryPath) => {
  try {
    const stats = fsApi.lstatSync(directoryPath)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

const ensureDirectory = (fsApi, directoryPath, logger) => {
  try {
    if (!fsApi.existsSync(directoryPath)) fsApi.mkdirSync(directoryPath)
  } catch (error) {
    safeLog(logger, 'error', `Could not create user-data directory: ${directoryPath}`, error)
  }
  return getUsableDirectory(fsApi, directoryPath)
}

const hashFile = (fsApi, filePath) => {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
  const fd = fsApi.openSync(filePath, 'r')
  try {
    let bytesRead
    while ((bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
    }
    return hash.digest('hex')
  } finally {
    fsApi.closeSync(fd)
  }
}

const createManifest = (fsApi, rootPath) => {
  const manifest = []

  const visit = (entryPath, relativePath) => {
    const stats = fsApi.lstatSync(entryPath)
    if (stats.isSymbolicLink()) throw new UnsupportedLegacyDataError(`Migration does not support linked data: ${relativePath}`)

    if (stats.isDirectory()) {
      manifest.push({ path: relativePath, type: 'directory' })
      for (const entry of fsApi.readdirSync(entryPath).sort()) {
        visit(path.join(entryPath, entry), relativePath == '.' ? entry : path.join(relativePath, entry))
      }
      return
    }
    if (stats.isFile()) {
      manifest.push({ path: relativePath, type: 'file', size: stats.size, hash: hashFile(fsApi, entryPath) })
      return
    }
    throw new UnsupportedLegacyDataError(`Migration does not support this data type: ${relativePath}`)
  }

  visit(rootPath, '.')
  return manifest
}

const createInitialLegacyManifest = (fsApi, legacyPath) => {
  try {
    return createManifest(fsApi, legacyPath)
  } catch (error) {
    if (error instanceof UnsupportedLegacyDataError) throw error
    throw new LegacyDataChangedError(`Legacy data changed during initial migration scan: ${error.message}`)
  }
}

const manifestsMatch = (left, right) => {
  if (left.length != right.length) return false
  return left.every((entry, index) => {
    const candidate = right[index]
    return entry.path == candidate.path && entry.type == candidate.type &&
      entry.size == candidate.size && entry.hash == candidate.hash
  })
}

const getPortableUserDataPaths = ({ platform, executablePath, pathExists = fs.existsSync }) => {
  if (platform != 'win32') return null
  const appDataPath = path.win32.join(path.win32.dirname(executablePath), 'portable')
  if (!pathExists(appDataPath)) return null
  return {
    appDataPath,
    userDataPath: path.win32.join(appDataPath, 'userData'),
  }
}

const migrateLegacyUserData = ({
  appDataPath,
  currentDirName = PROJECT_IDENTITY.userDataDirName,
  fsApi = fs,
  isProcessAlive = defaultIsProcessAlive,
  logger = console,
}) => {
  const rootPath = path.resolve(appDataPath)
  const legacyPath = path.join(rootPath, LEGACY_USER_DATA_DIR_NAME)
  const userDataPath = path.join(rootPath, currentDirName)
  const tempPrefix = `${userDataPath}${TEMP_SUFFIX}-`
  const lockPath = `${userDataPath}${LOCK_SUFFIX}`
  let tempPath

  assertDirectChild(rootPath, legacyPath)
  assertDirectChild(rootPath, userDataPath)
  assertDirectChild(rootPath, tempPrefix)
  assertDirectChild(rootPath, lockPath)

  const createResult = (status, userDataPathReady, error) => ({
    status,
    legacyPath,
    userDataPath,
    tempPath,
    lockPath,
    userDataPathReady,
    ...(error == null ? {} : { error }),
  })

  if (fsApi.existsSync(userDataPath)) {
    if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
    return createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
  }

  const lock = acquireMigrationLock({ fsApi, rootPath, lockPath, isProcessAlive, logger })
  if (lock.error != null) {
    safeLog(logger, 'error', 'Could not acquire user-data migration lock', lock.error)
    return createResult('failed', false, lock.error)
  }

  try {
    if (fsApi.existsSync(userDataPath)) {
      if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
      return createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
    }
    if (!fsApi.existsSync(legacyPath)) {
      const userDataPathReady = ensureDirectory(fsApi, userDataPath, logger)
      const error = userDataPathReady ? undefined : new Error(`Could not prepare user-data path: ${userDataPath}`)
      return createResult(userDataPathReady ? 'legacy-missing' : 'failed', userDataPathReady, error)
    }

    try {
      const legacyManifest = createInitialLegacyManifest(fsApi, legacyPath)
      const createdTempPath = fsApi.mkdtempSync(tempPrefix)
      assertDirectChild(rootPath, createdTempPath)
      if (!path.resolve(createdTempPath).startsWith(path.resolve(tempPrefix))) {
        throw new Error(`Unexpected migration temporary path: ${createdTempPath}`)
      }
      tempPath = createdTempPath
      const payloadPath = path.join(tempPath, 'payload')

      fsApi.cpSync(legacyPath, payloadPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        dereference: true,
      })

      const copiedManifest = createManifest(fsApi, payloadPath)
      let finalLegacyManifest
      try {
        finalLegacyManifest = createManifest(fsApi, legacyPath)
      } catch (error) {
        throw new LegacyDataChangedError(`Legacy data changed during migration: ${error.message}`)
      }
      if (!manifestsMatch(legacyManifest, finalLegacyManifest)) {
        throw new LegacyDataChangedError('Legacy data changed during migration; close other app instances and retry')
      }
      if (!manifestsMatch(legacyManifest, copiedManifest)) {
        throw new Error('Migration verification failed: recursive manifests do not match')
      }

      fsApi.writeFileSync(path.join(payloadPath, MIGRATION_MARKER_FILE), JSON.stringify({
        sourceDirectory: LEGACY_USER_DATA_DIR_NAME,
        completedAt: new Date().toISOString(),
      }, null, 2), { flag: 'wx' })

      // Electron's single-instance lock and this file lock serialize cooperating
      // app processes. Node has no portable RENAME_NOREPLACE for arbitrary writers.
      if (fsApi.existsSync(userDataPath)) {
        if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
        throw new Error(`Current user-data path is not a directory: ${userDataPath}`)
      }
      fsApi.renameSync(payloadPath, userDataPath)
      safeLog(logger, 'info', `Migrated user data to ${userDataPath}`)
      return createResult('migrated', true)
    } catch (error) {
      safeLog(logger, 'error', 'Legacy user-data migration failed', error)
      if (error instanceof LegacyDataChangedError) return createResult('failed', false, error)
      const userDataPathReady = ensureDirectory(fsApi, userDataPath, logger)
      return createResult('failed', userDataPathReady, error)
    } finally {
      removeOwnedTemp(fsApi, tempPath, logger)
    }
  } finally {
    releaseOwnedLock(fsApi, lock, logger)
  }
}

module.exports = {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
}
