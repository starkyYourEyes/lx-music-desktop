import path from 'node:path'
import { app } from 'electron'
import { getPortableUserDataPaths, migrateLegacyUserData } from './migration/legacyUserData'
import { initializeStoragePaths, resolveApplicationCacheRoot } from './utils/storagePaths'

type BootstrapApp = Pick<typeof app, 'getPath' | 'setPath' | 'exit'>
interface BootstrapRuntime {
  platform: NodeJS.Platform
  env: Readonly<NodeJS.ProcessEnv>
}

const importApplication = async(): Promise<void> => {
  await import('./application')
}

export const bootstrap = async(
  electronApp: BootstrapApp = app,
  loadApplication: () => Promise<unknown> = importApplication,
  runtime: BootstrapRuntime = { platform: process.platform, env: process.env },
): Promise<void> => {
  const executablePath = electronApp.getPath('exe')
  const portablePaths = getPortableUserDataPaths({
    platform: runtime.platform,
    executablePath,
  })

  let profileRoot: string
  let legacyRoot: string
  let applicationCacheRoot: string
  if (portablePaths != null) {
    profileRoot = path.join(portablePaths.appDataPath, 'profile')
    legacyRoot = portablePaths.userDataPath
    applicationCacheRoot = portablePaths.appDataPath
  } else {
    const migration = migrateLegacyUserData({ appDataPath: electronApp.getPath('appData'), logger: console })
    if (!migration.userDataPathReady) {
      console.error('User data is unavailable; startup has been aborted.', migration.error)
      electronApp.exit(1)
      return
    }
    profileRoot = path.join(migration.userDataPath, 'LxDatas')
    legacyRoot = migration.userDataPath
    applicationCacheRoot = resolveApplicationCacheRoot({
      platform: runtime.platform,
      env: runtime.env,
      homePath: electronApp.getPath('home'),
    })
  }

  const storagePaths = initializeStoragePaths({
    profileRoot,
    applicationCacheRoot,
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
