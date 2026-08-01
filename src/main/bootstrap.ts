import path from 'node:path'
import { app } from 'electron'
import { getPortableUserDataPaths, migrateLegacyUserData } from './migration/legacyUserData'
import { initializeStoragePaths } from './utils/storagePaths'

type BootstrapApp = Pick<typeof app, 'getPath' | 'setPath' | 'exit'>

const importApplication = async(): Promise<void> => {
  await import('./application')
}

export const bootstrap = async(
  electronApp: BootstrapApp = app,
  loadApplication: () => Promise<unknown> = importApplication,
): Promise<void> => {
  const executablePath = electronApp.getPath('exe')
  const portablePaths = getPortableUserDataPaths({
    platform: process.platform,
    executablePath,
  })

  let profileRoot: string
  let legacyRoot: string
  if (portablePaths != null) {
    profileRoot = path.join(portablePaths.appDataPath, 'profile')
    legacyRoot = portablePaths.userDataPath
  } else {
    const migration = migrateLegacyUserData({ appDataPath: electronApp.getPath('appData'), logger: console })
    if (!migration.userDataPathReady) {
      console.error('User data is unavailable; startup has been aborted.', migration.error)
      electronApp.exit(1)
      return
    }
    profileRoot = path.join(migration.userDataPath, 'LxDatas')
    legacyRoot = migration.userDataPath
  }

  const storagePaths = initializeStoragePaths({
    profileRoot,
    applicationCacheRoot: electronApp.getPath('sessionData'),
    tempBase: electronApp.getPath('temp'),
    portableRoot: portablePaths?.appDataPath ?? null,
  })
  electronApp.setPath('userData', storagePaths.profileRoot)
  electronApp.setPath('sessionData', storagePaths.sessionDataRoot)
  global.storagePaths = storagePaths
  global.lxDataPath = storagePaths.profileRoot
  global.lxOldDataPath = legacyRoot
  await loadApplication()
}
