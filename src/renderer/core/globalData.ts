// import defaultSetting from '@common/defaultSetting'
import createWorkers from '@renderer/worker'
import { getRunTempRoot } from '@renderer/utils/ipc'

window.lx = {
  // appSetting: defaultSetting,
  isEditingHotKey: false,
  isPlayedStop: false,
  appHotKeyConfig: {
    local: {
      enable: false,
      keys: {},
    },
    global: {
      enable: false,
      keys: {},
    },
  },
  songListInfo: {
    fromName: '',
    searchKey: '',
    searchPosition: 0,
    songlistKey: '',
    songlistPosition: 0,
  },
  restorePlayInfo: null,
  worker: createWorkers(),
  isProd: process.env.NODE_ENV == 'production',
  rootOffset: window.dt ? 0 : 8,
  apiInitPromise: [Promise.resolve(false), true, () => {}],
}

window.lxData = {}

void getRunTempRoot()
  .then(
    ownership => window.lx.worker.main.configureRunTempRoot(ownership),
    async error => {
      console.error('Could not acquire local artwork storage', error)
      await window.lx.worker.main.configureRunTempRoot(null)
    },
  )
  .catch(error => {
    console.error('Could not configure local artwork storage', error)
  })

window.ELECTRON_DISABLE_SECURITY_WARNINGS = process.env.ELECTRON_DISABLE_SECURITY_WARNINGS
