const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { PROJECT_IDENTITY } = require('../../common/projectIdentity')
const {
  DirectorySourceChangedError,
  acquireMigrationLock,
  assertDirectChild,
  copyDirectoryWithManifestPromotion,
  defaultIsProcessAlive,
  ensureDirectory,
  getUsableDirectory,
  releaseMigrationLock,
  safeLog,
} = require('./guardedDirectoryMigration')

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

  const prepareFreshUserData = () => {
    const userDataPathReady = ensureDirectory(fsApi, userDataPath, logger)
    const error = userDataPathReady ? undefined : new Error(`Could not prepare user-data path: ${userDataPath}`)
    return createResult(userDataPathReady ? 'legacy-missing' : 'failed', userDataPathReady, error)
  }

  if (!fsApi.existsSync(legacyPath)) return prepareFreshUserData()

  const lock = acquireMigrationLock({ fsApi, rootPath, lockPath, isProcessAlive, logger })
  if ('error' in lock) {
    safeLog(logger, 'error', 'Could not acquire user-data migration lock', lock.error)
    return createResult('failed', false, lock.error)
  }

  try {
    if (fsApi.existsSync(userDataPath)) {
      if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
      return createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
    }
    if (!fsApi.existsSync(legacyPath)) return prepareFreshUserData()

    const migration = copyDirectoryWithManifestPromotion({
      fsApi,
      rootPath,
      sourcePath: legacyPath,
      destinationPath: userDataPath,
      stagePrefix: tempPrefix,
      runId: crypto.randomUUID(),
      logger,
      cleanupWarning: 'Could not verify owned user-data migration temporary directory',
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
      if (getUsableDirectory(fsApi, userDataPath)) return createResult('current-exists', true)
      return createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
    }

    safeLog(logger, 'error', 'Legacy user-data migration failed', migration.error)
    if (migration.error instanceof DirectorySourceChangedError) {
      return createResult('failed', false, migration.error)
    }
    const userDataPathReady = ensureDirectory(fsApi, userDataPath, logger)
    return createResult('failed', userDataPathReady, migration.error)
  } finally {
    releaseMigrationLock({ fsApi, lock, logger })
  }
}

module.exports = {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
}
