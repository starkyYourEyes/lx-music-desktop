import { app } from 'electron'
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
import { initAppSetting } from '@main/app'
import registerModules from '@main/modules'

// 初始化应用
const init = () => {
  console.log('init')
  void initAppSetting().then(() => {
    registerModules()
    global.lx.event_app.app_inited()
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
  registerDeeplink(init)
  listenerAppEvent(init)

  // https://github.com/electron/electron/issues/16809
  void app.whenReady().then(() => {
    isLinux ? setTimeout(init, 300) : init()
  })
}
