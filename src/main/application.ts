import { app, session } from 'electron'
import { initLog } from './utils/logInit'
import '@common/error'
import {
  initGlobalData,
  initSingleInstanceHandle,
  applyElectronEnvParams,
  registerDeeplink,
  listenerAppEvent,
} from './app'
import { isLinux } from '@common/utils'
import { completePhase3StartupAttestation, initAppSetting, runPlaybackActivityMigration, runStorageMigrationHooks } from '@main/app'
import registerModules from '@main/modules'
import { flushStores } from '@main/utils/store'
import { createRunState } from '@main/startup/runState'
import { checkCredentialStartup, createStorageCoordinator } from '@main/startup/storageCoordinator'
import { showStorageRecovery } from '@main/startup/recovery'
import { readLegacyDataSource } from '@main/migration/legacyData/source'
import { acknowledgePortableProfileStartup } from '@main/migration/portableProfile'
import { createRunTempHandle } from '@main/utils/tempLifecycle'
import { createThemeAssetManager } from '@main/services/themeAssetManager'
import { createCacheManager } from '@main/services/cacheManager'
import { STORAGE_CACHE_GENERATION_EVENT } from '@common/storage/cache'
import { sendEvent } from '@main/modules/winMain/main'
import { createDefaultSessionLifetime, type DefaultSessionLifetime } from '@main/services/defaultSessionLifetime'

let isFinishingStorageShutdown = false

const getStorageCoordinator = () => {
  const portableProfileStartup = global.portableProfileStartup
  global.lx.cacheManager ??= createCacheManager({
    cacheRoot: global.storagePaths.cacheRoot,
    worker: global.lx.worker.dbService,
    sessionRegistry: global.lx.sessionRegistry,
    publishGeneration: generation => { sendEvent(STORAGE_CACHE_GENERATION_EVENT, generation) },
  })
  global.lx.storage ??= createStorageCoordinator({
    cacheManager: global.lx.cacheManager,
    runState: createRunState({ runtimeRoot: global.storagePaths.runtimeRoot }),
    initializeTempLifecycle: async() => {
      const reservation = global.runTempReservation
      if (reservation == null) throw new Error('run_temp_owner_invalid')
      global.runTempReservation = null
      global.lx.runTemp = await createRunTempHandle({ reservation })
      const themeAssets = createThemeAssetManager({
        profileRoot: global.storagePaths.profileRoot,
        runTemp: global.lx.runTemp,
      })
      await themeAssets.prepareThemeAssetStorage()
      global.lx.themeAssets = themeAssets
    },
    cleanupTempLifecycle: async() => {
      const runTemp = global.lx.runTemp
      global.lx.themeAssets = null
      global.lx.runTemp = null
      await runTemp?.cleanup()
    },
    preflightLegacyData: () => readLegacyDataSource({
      profileRoot: global.storagePaths.profileRoot,
      legacyRoot: global.lxOldDataPath,
    }),
    initDatabase: previousShutdownWasClean => global.lx.worker.dbService.init({
      dataPath: global.storagePaths.profileRoot,
      cacheRoot: global.storagePaths.cacheRoot,
      backupsRoot: global.storagePaths.backupsRoot,
      previousShutdownWasClean,
      targetSchemaVersion: 6,
    }),
    closeDatabase: () => global.lx.worker.dbService.close(),
    runMigrationHooks: runStorageMigrationHooks,
    runPlaybackActivityMigration,
    checkCredentials: () => checkCredentialStartup({
      dataRoot: global.storagePaths.profileRoot,
      vault: global.lx.credentialVault,
      profileRepository: global.lx.accountRepository,
    }),
    interruptStalePlaybackSessions: input => global.lx.worker.dbService.playbackMarkStaleSessionsInterrupted(input),
    runPlaybackTypedSmoke: () => global.lx.worker.dbService.playbackRunTypedSmoke(),
    getPhase3AttestationPrerequisites: () => global.lx.worker.dbService.getPhase3AttestationPrerequisites(),
    completePhase3Attestation: completePhase3StartupAttestation,
    ...(portableProfileStartup == null
      ? {}
      : {
          portableProfileToken: portableProfileStartup.token,
          acknowledgePortableProfileStartup: async(token) => {
            const acknowledgement = await acknowledgePortableProfileStartup(token)
            if (portableProfileStartup.token === token) global.portableProfileStartup = null
            return acknowledgement
          },
        }),
    initSettings: initAppSetting,
    registerModules,
    appInited: () => global.lx.event_app.app_inited(),
    showRecovery: showStorageRecovery,
    flushStores,
    reportShutdownFailure: diagnostic => {
      console.error('Storage shutdown failed', diagnostic)
    },
  })
  return global.lx.storage
}

initSingleInstanceHandle()
initLog()
initGlobalData()
applyElectronEnvParams()

let defaultSessionLifetime: DefaultSessionLifetime | null = null
const applicationReady = app.whenReady().then(async() => {
  defaultSessionLifetime ??= createDefaultSessionLifetime(global.lx.sessionRegistry)
  await defaultSessionLifetime.admit(session.defaultSession)
})

const init = () => {
  void applicationReady.then(async() => {
    const outcome = await getStorageCoordinator().start()
    if (outcome.status == 'fatal' && !isFinishingStorageShutdown) {
      console.error('Storage startup failed', outcome.reason)
      app.exit(1)
    }
  })
}

app.on('before-quit', event => {
  const coordinator = global.lx.storage
  if (coordinator == null || isFinishingStorageShutdown) return
  isFinishingStorageShutdown = true
  event.preventDefault()
  void coordinator.shutdown().catch(() => {}).finally(() => {
    app.quit()
  })
})
registerDeeplink(init)
listenerAppEvent(init)

// https://github.com/electron/electron/issues/16809
void applicationReady.then(() => {
  isLinux ? setTimeout(init, 300) : init()
})
