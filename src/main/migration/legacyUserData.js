const fs = require('node:fs')
const path = require('node:path')
const { PROJECT_IDENTITY } = require('../../common/projectIdentity')

const LEGACY_USER_DATA_DIR_NAME = 'lx-music-desktop'
const MIGRATION_MARKER_FILE = '.legacy-user-data-migration.json'
const TEMP_SUFFIX = '.migration-tmp'

const assertDirectChild = (rootPath, candidatePath) => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (path.dirname(candidate) != root || candidate == root) {
    throw new Error(`Migration path must be a direct child of appData: ${candidate}`)
  }
}

const ensureDirectory = (fsApi, directoryPath) => {
  if (!fsApi.existsSync(directoryPath)) fsApi.mkdirSync(directoryPath, { recursive: true })
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
  const tempPath = `${userDataPath}${TEMP_SUFFIX}`

  assertDirectChild(rootPath, legacyPath)
  assertDirectChild(rootPath, userDataPath)
  assertDirectChild(rootPath, tempPath)

  if (fsApi.existsSync(userDataPath)) {
    return { status: 'current-exists', legacyPath, userDataPath, tempPath }
  }
  if (!fsApi.existsSync(legacyPath)) {
    ensureDirectory(fsApi, userDataPath)
    return { status: 'legacy-missing', legacyPath, userDataPath, tempPath }
  }

  try {
    if (fsApi.existsSync(tempPath)) fsApi.rmSync(tempPath, { recursive: true, force: true })
    fsApi.cpSync(legacyPath, tempPath, { recursive: true, force: false, errorOnExist: true })

    const legacyEntries = fsApi.readdirSync(legacyPath)
    const copiedEntries = new Set(fsApi.readdirSync(tempPath))
    for (const entry of legacyEntries) {
      if (!copiedEntries.has(entry)) throw new Error(`Migration verification failed: ${entry}`)
    }

    fsApi.renameSync(tempPath, userDataPath)
    fsApi.writeFileSync(path.join(userDataPath, MIGRATION_MARKER_FILE), JSON.stringify({
      sourceDirectory: LEGACY_USER_DATA_DIR_NAME,
      completedAt: new Date().toISOString(),
    }, null, 2))
    logger.info(`Migrated user data to ${userDataPath}`)
    return { status: 'migrated', legacyPath, userDataPath, tempPath }
  } catch (error) {
    logger.error('Legacy user-data migration failed', error)
    if (fsApi.existsSync(tempPath)) fsApi.rmSync(tempPath, { recursive: true, force: true })
    ensureDirectory(fsApi, userDataPath)
    return { status: 'failed', legacyPath, userDataPath, tempPath, error }
  }
}

module.exports = {
  LEGACY_USER_DATA_DIR_NAME,
  MIGRATION_MARKER_FILE,
  getPortableUserDataPaths,
  migrateLegacyUserData,
}
