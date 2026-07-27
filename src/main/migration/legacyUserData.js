const fs = require('node:fs')
const path = require('node:path')
const { PROJECT_IDENTITY } = require('../../common/projectIdentity')

const LEGACY_USER_DATA_DIR_NAME = 'lx-music-desktop'
const MIGRATION_MARKER_FILE = '.legacy-user-data-migration.json'
const TEMP_SUFFIX = '.migration-tmp'
const LOCK_SUFFIX = '.migration.lock'

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

const closeLock = (fsApi, lockFd, logger) => {
  try {
    fsApi.closeSync(lockFd)
  } catch (error) {
    safeLog(logger, 'warn', 'Could not close user-data migration lock', error)
  }
}

const releaseOwnedLock = (fsApi, lockPath, lockFd, lockIdentity, logger) => {
  try {
    const lockPathIdentity = fsApi.lstatSync(lockPath)
    if (isSameNode(lockIdentity, lockPathIdentity)) fsApi.unlinkSync(lockPath)
  } catch (error) {
    if (error?.code != 'ENOENT') safeLog(logger, 'warn', 'Could not remove user-data migration lock', error)
  }
  closeLock(fsApi, lockFd, logger)
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

const createManifest = (fsApi, rootPath) => {
  const manifest = []

  const visit = (entryPath, relativePath) => {
    const stats = fsApi.lstatSync(entryPath)
    if (stats.isSymbolicLink()) throw new Error(`Migration does not support linked data: ${relativePath}`)

    if (stats.isDirectory()) {
      manifest.push({ path: relativePath, type: 'directory' })
      for (const entry of fsApi.readdirSync(entryPath).sort()) {
        visit(path.join(entryPath, entry), relativePath == '.' ? entry : path.join(relativePath, entry))
      }
      return
    }
    if (stats.isFile()) {
      manifest.push({ path: relativePath, type: 'file', size: stats.size })
      return
    }
    throw new Error(`Migration does not support this data type: ${relativePath}`)
  }

  visit(rootPath, '.')
  return manifest
}

const manifestsMatch = (left, right) => {
  if (left.length != right.length) return false
  return left.every((entry, index) => {
    const candidate = right[index]
    return entry.path == candidate.path && entry.type == candidate.type && entry.size == candidate.size
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

  let lockFd
  let lockIdentity
  try {
    lockFd = fsApi.openSync(lockPath, 'wx')
    lockIdentity = fsApi.fstatSync(lockFd)
  } catch (error) {
    safeLog(logger, 'error', 'Could not acquire user-data migration lock', error)
    if (lockFd != null && lockIdentity != null) releaseOwnedLock(fsApi, lockPath, lockFd, lockIdentity, logger)
    else if (lockFd != null) closeLock(fsApi, lockFd, logger)
    return createResult('failed', false, error)
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
      const legacyManifest = createManifest(fsApi, legacyPath)
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
      const finalLegacyManifest = createManifest(fsApi, legacyPath)
      if (!manifestsMatch(legacyManifest, copiedManifest) || !manifestsMatch(legacyManifest, finalLegacyManifest)) {
        throw new Error('Migration verification failed: recursive manifests do not match')
      }

      fsApi.writeFileSync(path.join(payloadPath, MIGRATION_MARKER_FILE), JSON.stringify({
        sourceDirectory: LEGACY_USER_DATA_DIR_NAME,
        completedAt: new Date().toISOString(),
      }, null, 2), { flag: 'wx' })

      // Node has no portable RENAME_NOREPLACE for directories. The exclusive lock
      // prevents cooperating migrators from entering this recheck/rename window.
      if (fsApi.existsSync(userDataPath)) {
        if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
        throw new Error(`Current user-data path is not a directory: ${userDataPath}`)
      }
      fsApi.renameSync(payloadPath, userDataPath)
      safeLog(logger, 'info', `Migrated user data to ${userDataPath}`)
      return createResult('migrated', true)
    } catch (error) {
      safeLog(logger, 'error', 'Legacy user-data migration failed', error)
      const userDataPathReady = ensureDirectory(fsApi, userDataPath, logger)
      return createResult('failed', userDataPathReady, error)
    } finally {
      removeOwnedTemp(fsApi, tempPath, logger)
    }
  } finally {
    releaseOwnedLock(fsApi, lockPath, lockFd, lockIdentity, logger)
  }
}

module.exports = {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
}
