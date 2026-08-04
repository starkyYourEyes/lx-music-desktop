const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { PROJECT_IDENTITY } = require('../../common/projectIdentity')
const {
  closeDirectDirectory,
  createDirectChildDirectory,
  observeDirectChild,
  revalidateDirectDirectory,
  validateDirectDirectory,
} = require('../storage/directDirectory')
const {
  DirectorySourceChangedError,
  assertDirectChild,
  copyDirectoryWithManifestPromotion,
  getUsableDirectory,
  safeLog,
} = require('./guardedDirectoryMigration')
const {
  acquireMigrationLease,
  releaseMigrationLease,
} = require('./migrationLease')

const LEGACY_USER_DATA_DIR_NAME = 'lx-music-desktop'
const MIGRATION_MARKER_FILE = '.legacy-user-data-migration.json'
const TEMP_SUFFIX = '.migration-tmp'
const LOCK_SUFFIX = '.migration.lock'

const getPortableUserDataPaths = ({ platform, executablePath, pathExists = fs.existsSync }) => {
  if (platform != 'win32') return null
  const appDataPath = path.win32.join(path.win32.dirname(executablePath), 'portable')
  if (!pathExists(appDataPath)) return null
  return {
    appDataPath,
    userDataPath: path.win32.join(appDataPath, 'userData'),
  }
}

const preparePortableUserDataPaths = ({
  platform,
  executablePath,
  portableExecutableDir,
  fsApi = fs,
}) => {
  if (platform != 'win32') return null
  if (portableExecutableDir == null) {
    const paths = getPortableUserDataPaths({
      platform,
      executablePath,
      pathExists: fsApi.existsSync,
    })
    if (paths == null) return null
    const root = validateDirectDirectory(paths.appDataPath, { fsApi, pathApi: path.win32 })
    try {
      revalidateDirectDirectory(root)
      return paths
    } finally {
      closeDirectDirectory(root)
    }
  }
  if (typeof portableExecutableDir != 'string' || portableExecutableDir.length == 0 ||
    !path.win32.isAbsolute(portableExecutableDir)) {
    throw new Error('portable_executable_directory_invalid')
  }

  const launcherPath = path.win32.resolve(portableExecutableDir)
  const launcher = validateDirectDirectory(launcherPath, { fsApi, pathApi: path.win32 })
  let portable
  try {
    portable = createDirectChildDirectory(launcher, 'portable', { mode: 0o700 })
    revalidateDirectDirectory(launcher)
    revalidateDirectDirectory(portable)
    return Object.freeze({
      appDataPath: portable.path,
      userDataPath: path.win32.join(portable.path, 'userData'),
    })
  } finally {
    try {
      if (portable != null) closeDirectDirectory(portable)
    } finally {
      closeDirectDirectory(launcher)
    }
  }
}

const migrateLegacyUserData = async({
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
    ...(tempPath == null ? {} : { tempPath }),
    lockPath,
    userDataPathReady,
    ...(error == null ? {} : { error }),
  })

  const prepareFreshUserDataUnderDirectGuard = lease => {
    let rootGuard
    let childGuard
    try {
      lease?.assertHeld()
      rootGuard = validateDirectDirectory(rootPath, { fsApi })
      lease?.assertHeld()
      const observation = observeDirectChild(rootGuard, path.basename(userDataPath))
      lease?.assertHeld()
      if (observation.status == 'present') {
        childGuard = observation.guard
        return true
      }
      lease?.assertHeld()
      childGuard = createDirectChildDirectory(rootGuard, observation.basename)
      lease?.assertHeld()
      return true
    } catch (error) {
      safeLog(logger, 'error', `Could not create migration directory: ${userDataPath}`, error)
      return false
    } finally {
      if (childGuard != null) {
        try { closeDirectDirectory(childGuard) } catch (error) {
          safeLog(logger, 'warn', `Could not close user-data directory guard: ${userDataPath}`, error)
        }
      }
      if (rootGuard != null) {
        try { closeDirectDirectory(rootGuard) } catch (error) {
          safeLog(logger, 'warn', `Could not close app-data directory guard: ${rootPath}`, error)
        }
      }
    }
  }

  const prepareFreshResult = (status, lease) => {
    const userDataPathReady = prepareFreshUserDataUnderDirectGuard(lease)
    const error = userDataPathReady ? undefined : new Error(`Could not prepare user-data path: ${userDataPath}`)
    return createResult(userDataPathReady ? status : 'failed', userDataPathReady, error)
  }

  if (fsApi.existsSync(userDataPath)) {
    if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
    return createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
  }

  if (!fsApi.existsSync(legacyPath)) return prepareFreshResult('legacy-missing')

  let lease
  try {
    lease = await acquireMigrationLease({ rootPath, lockPath, logger })
  } catch (error) {
    safeLog(logger, 'error', 'Could not acquire user-data migration lease', error)
    return createResult('failed', false, error)
  }

  try {
    lease.assertHeld()
    if (fsApi.existsSync(userDataPath)) {
      if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
      return createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
    }
    lease.assertHeld()
    if (!fsApi.existsSync(legacyPath)) return prepareFreshResult('legacy-missing', lease)

    const migration = await copyDirectoryWithManifestPromotion({
      fsApi,
      rootPath,
      sourcePath: legacyPath,
      destinationPath: userDataPath,
      stagePrefix: tempPrefix,
      runId: crypto.randomUUID(),
      lease,
      logger,
      writePayloadMarker({ payloadPath }) {
        fsApi.writeFileSync(path.join(payloadPath, MIGRATION_MARKER_FILE), JSON.stringify({
          sourceDirectory: LEGACY_USER_DATA_DIR_NAME,
          completedAt: new Date().toISOString(),
        }, null, 2), { flag: 'wx' })
      },
    })
    tempPath = migration.stagePath
    if (migration.status == 'promoted') {
      safeLog(logger, 'info', `Migrated user data to ${userDataPath}`)
      return createResult('migrated', true)
    }
    if (migration.status == 'destination-exists') {
      return getUsableDirectory(fsApi, userDataPath)
        ? createResult('current-exists', true)
        : createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
    }
    safeLog(logger, 'error', 'Legacy user-data migration failed', migration.error)
    if (migration.error instanceof DirectorySourceChangedError) {
      return createResult('failed', false, migration.error)
    }
    lease.assertHeld()
    const userDataPathReady = prepareFreshUserDataUnderDirectGuard(lease)
    return createResult('failed', userDataPathReady, migration.error)
  } finally {
    await releaseMigrationLease(lease)
  }
}

module.exports = {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
  preparePortableUserDataPaths,
}
