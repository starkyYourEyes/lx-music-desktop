import { app } from 'electron'
import path from 'node:path'
import { initLog } from './utils/logInit'
import '@common/error'
import {
  initGlobalData,
  initSingleInstanceHandle,
  applyElectronEnvParams,
  setUserDataPath,
  registerDeeplink,
  listenerAppEvent,
} from './app'
import { isLinux } from '@common/utils'
import { initAppSetting, runPlaybackActivityMigration, runStorageMigrationHooks } from '@main/app'
import registerModules from '@main/modules'
import { flushStores } from '@main/utils/store'
import { createRunState } from '@main/startup/runState'
import { checkCredentialStartup, createStorageCoordinator } from '@main/startup/storageCoordinator'
import { showStorageRecovery } from '@main/startup/recovery'
import { readLegacyDataSource } from '@main/migration/legacyData/source'

// 初始化应用
let isFinishingStorageShutdown = false

const getStorageCoordinator = () => {
  global.lx.storage ??= createStorageCoordinator({
    runState: createRunState({ runtimeRoot: global.lxDataPath }),
    preflightLegacyData: () => readLegacyDataSource({
      profileRoot: global.lxDataPath,
      legacyRoot: global.lxOldDataPath,
    }),
    initDatabase: previousShutdownWasClean => global.lx.worker.dbService.init({
      dataPath: global.lxDataPath,
      backupDir: path.join(global.lxDataPath, 'backups'),
      previousShutdownWasClean,
    }),
    closeDatabase: () => global.lx.worker.dbService.close(),
    runMigrationHooks: runStorageMigrationHooks,
    runPlaybackActivityMigration,
    checkCredentials: () => checkCredentialStartup({
      dataRoot: global.lxDataPath,
      vault: global.lx.credentialVault,
      profileRepository: global.lx.accountRepository,
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

const init = () => {
  void getStorageCoordinator().start().then(outcome => {
    if (outcome.status == 'fatal' && !isFinishingStorageShutdown) {
      console.error('Storage startup failed', outcome.reason)
      app.exit(1)
    }
  })
}

const userDataStatus = setUserDataPath()
if (!userDataStatus.ready) {
  console.error('User data is unavailable; startup has been aborted.', userDataStatus.error)
  app.exit(1)
} else {
  initSingleInstanceHandle()
  initLog()
  initGlobalData()
  applyElectronEnvParams()
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
  void app.whenReady().then(() => {
    isLinux ? setTimeout(init, 300) : init()
  })
}
