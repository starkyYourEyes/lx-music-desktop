import crypto from 'node:crypto'
import path from 'node:path'
import { app } from 'electron'
import { migrateLegacyUserData, preparePortableUserDataPaths } from './migration/legacyUserData'
import { preparePortableProfile, retireAcknowledgedPortableSource } from './migration/portableProfile'
import {
  initializeStoragePaths,
  prepareElectronBootstrapPaths,
  resolveApplicationCacheRoot,
  resolveApplicationRuntimeRoot,
  type ElectronBootstrapPaths,
} from './utils/storagePaths'

type BootstrapApp = Pick<typeof app, 'getPath' | 'setPath' | 'requestSingleInstanceLock' | 'exit'>
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
  let portablePaths
  try {
    portablePaths = preparePortableUserDataPaths({
      platform: runtime.platform,
      executablePath,
      portableExecutableDir: runtime.env.PORTABLE_EXECUTABLE_DIR,
    })
  } catch (error) {
    console.error('Portable root validation failed; startup has been aborted.', error)
    electronApp.exit(1)
    return
  }

  let profileRoot: string
  let legacyRoot: string
  let applicationCacheRoot: string
  let applicationRuntimeRoot: string
  let installedAppDataRoot: string | null = null
  let electronPaths: ElectronBootstrapPaths
  global.portableProfileStartup = null
  global.isPortableProfileCutoverStartup = false
  global.runTempReservation = null
  try {
    if (portablePaths != null) {
      applicationCacheRoot = portablePaths.appDataPath
      applicationRuntimeRoot = path.join(portablePaths.appDataPath, 'runtime')
    } else {
      installedAppDataRoot = electronApp.getPath('appData')
      const installedHomePath = electronApp.getPath('home')
      applicationCacheRoot = resolveApplicationCacheRoot({
        platform: runtime.platform,
        env: runtime.env,
        homePath: installedHomePath,
      })
      applicationRuntimeRoot = resolveApplicationRuntimeRoot({
        platform: runtime.platform,
        env: runtime.env,
        homePath: installedHomePath,
        appDataPath: installedAppDataRoot,
      })
    }
    electronPaths = prepareElectronBootstrapPaths({
      applicationRuntimeRoot,
      portableRoot: portablePaths?.appDataPath ?? null,
    })
    electronApp.setPath('userData', electronPaths.electronUserDataRoot)
    electronApp.setPath('sessionData', electronPaths.sessionDataRoot)
    if (!electronApp.requestSingleInstanceLock()) {
      electronApp.exit(0)
      return
    }
  } catch (error) {
    console.error('Electron storage root validation failed; startup has been aborted.', error)
    electronApp.exit(1)
    return
  }

  if (portablePaths != null) {
    const startupRunId = crypto.randomUUID()
    let retirement
    let preparation
    try {
      retirement = await retireAcknowledgedPortableSource({
        portableRoot: portablePaths.appDataPath,
        runId: startupRunId,
        logger: console,
      })
    } catch (error) {
      console.error('Portable profile validation failed; startup has been aborted.', error)
      electronApp.exit(1)
      return
    }
    if (retirement.state == 'failed') {
      console.error('Portable profile source retirement failed; startup has been aborted.', retirement.error)
      electronApp.exit(1)
      return
    }
    try {
      preparation = await preparePortableProfile({
        portableRoot: portablePaths.appDataPath,
        runId: startupRunId,
        logger: console,
      })
    } catch (error) {
      console.error('Portable profile validation failed; startup has been aborted.', error)
      electronApp.exit(1)
      return
    }
    if (preparation.state == 'failed') {
      console.error('Portable profile migration failed; startup has been aborted.', preparation.error)
      electronApp.exit(1)
      return
    }
    global.portableProfileStartup = preparation.token == null ? null : { token: preparation.token }
    global.isPortableProfileCutoverStartup = preparation.token != null || retirement.state == 'retired'
    profileRoot = path.join(portablePaths.appDataPath, 'profile')
    legacyRoot = portablePaths.userDataPath
  } else {
    if (installedAppDataRoot == null) {
      console.error('Installed application data root is unavailable; startup has been aborted.')
      electronApp.exit(1)
      return
    }
    const migration = await migrateLegacyUserData({ appDataPath: installedAppDataRoot, logger: console })
    if (!migration.userDataPathReady) {
      console.error('User data is unavailable; startup has been aborted.', migration.error)
      electronApp.exit(1)
      return
    }
    profileRoot = path.join(migration.userDataPath, 'LxDatas')
    legacyRoot = migration.userDataPath
  }

  let initialized
  try {
    initialized = await initializeStoragePaths({
      profileRoot,
      applicationCacheRoot,
      applicationRuntimeRoot,
      tempBase: electronApp.getPath('temp'),
      portableRoot: portablePaths?.appDataPath ?? null,
    })
  } catch (error) {
    console.error('Storage root validation failed; startup has been aborted.', error)
    electronApp.exit(1)
    return
  }
  if (initialized.paths.electronUserDataRoot != electronPaths.electronUserDataRoot ||
    initialized.paths.sessionDataRoot != electronPaths.sessionDataRoot) {
    console.error('Electron storage root changed during startup; startup has been aborted.')
    electronApp.exit(1)
    return
  }
  global.storagePaths = initialized.paths
  global.runTempReservation = initialized.runTempReservation
  global.lxDataPath = initialized.paths.profileRoot
  global.lxOldDataPath = legacyRoot
  await loadApplication()
}
