const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const appPath = path.resolve(__dirname, '../../src/main/app.ts')

const unusedRuntimeModules = Object.fromEntries([
  '@common/config',
  '@common/constants',
  '@common/defaultSetting',
  '@common/projectIdentity',
  '@common/utils',
  '@common/utils/request',
  '@main/event',
  '@main/utils/webContentsNavigationGuard',
  './migration/credentials/credentialMigration',
  './migration/credentials/legacySources',
  './migration/credentials/recoveryError',
  './migration/legacyData/activity',
  './migration/legacyData/nonActivity',
  './services/musicUrlAuthorization',
  './services/sessionRegistry',
  './startup/phase3Attestation',
  './storage/accounts/accountRepository',
  './storage/atomicJsonFile',
  './storage/credentials',
  './storage/settings/document',
  './utils/migrate',
  './worker',
].map(request => [request, {}]))

test('keeps the primary alive when a second instance arrives before the main window exists', () => {
  let secondInstanceListener
  let quitCalls = 0
  const { initSingleInstanceHandle } = loadTsModule(appPath, {
    ...unusedRuntimeModules,
    electron: {
      app: {
        on: (event, listener) => {
          if (event == 'second-instance') secondInstanceListener = listener
        },
        quit: () => { quitCalls++ },
      },
      nativeTheme: {},
      screen: {},
      shell: {},
    },
    './modules/winMain': {
      isExistWindow: () => false,
      showWindow: () => {},
    },
    './utils': {
      parseEnvParams: () => ({ cmdParams: {}, deeplink: null }),
    },
  })

  initSingleInstanceHandle()
  assert.equal(typeof secondInstanceListener, 'function')

  secondInstanceListener({}, [], '')

  assert.equal(quitCalls, 0)
})
