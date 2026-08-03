import crypto from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { getPortableUserDataPaths, migrateLegacyUserData } from './migration/legacyUserData'
import { preparePortableProfile, retireAcknowledgedPortableSource } from './migration/portableProfile'
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
  global.portableProfileStartup = null
  global.runTempReservation = null
  if (portablePaths != null) {
    const startupRunId = crypto.randomUUID()
    const retirement = retireAcknowledgedPortableSource({
      portableRoot: portablePaths.appDataPath,
      runId: startupRunId,
      logger: console,
    })
    if (retirement.state == 'failed') {
      console.error('Portable profile source retirement failed; startup has been aborted.', retirement.error)
      electronApp.exit(1)
      return
    }
    const preparation = preparePortableProfile({
      portableRoot: portablePaths.appDataPath,
      runId: startupRunId,
      logger: console,
    })
    if (preparation.state == 'failed') {
      console.error('Portable profile migration failed; startup has been aborted.', preparation.error)
      electronApp.exit(1)
      return
    }
    global.portableProfileStartup = preparation.token == null ? null : { token: preparation.token }
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

  let initialized
  try {
    initialized = await initializeStoragePaths({
      profileRoot,
      applicationCacheRoot,
      tempBase: electronApp.getPath('temp'),
      portableRoot: portablePaths?.appDataPath ?? null,
    })
  } catch (error) {
    console.error('Storage root validation failed; startup has been aborted.', error)
    electronApp.exit(1)
    return
  }
  electronApp.setPath('userData', initialized.paths.profileRoot)
  electronApp.setPath('sessionData', initialized.paths.sessionDataRoot)
  global.storagePaths = initialized.paths
  global.runTempReservation = initialized.runTempReservation
  global.lxDataPath = initialized.paths.profileRoot
  global.lxOldDataPath = legacyRoot
  await loadApplication()
}
