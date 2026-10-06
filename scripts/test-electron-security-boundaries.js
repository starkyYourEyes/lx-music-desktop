const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')
const { PROJECT_IDENTITY } = require('../src/common/projectIdentity')

const root = path.resolve(__dirname, '..')
const isolatedSession = {
  clearAuthCache: async() => {},
  clearStorageData: async() => {},
  clearCache: async() => {},
  clearCodeCaches: async() => {},
  setPermissionRequestHandler(handler) {
    this.permissionHandler = handler
  },
}
const defaultSession = {
  ...isolatedSession,
  setPermissionRequestHandler(handler) {
    this.permissionHandler = handler
  },
}
let browserOptions
let userApiPartition

class FakeBrowserWindow {
  constructor(options) {
    browserOptions = options
    this.webContents = {
      session: options.webPreferences.session ?? defaultSession,
      on() {},
      removeListener() {},
      setWindowOpenHandler() {},
    }
  }

  on() {}
  removeListener() {}
  isDestroyed() { return !!this.destroyed }
  async loadURL() {}
  destroy() { this.destroyed = true }
}

global.envParams = { cmdParams: {} }
global.lx = {
  sessionRegistry: { register: () => ({ ready: Promise.resolve(), unregister() {} }) },
  appSetting: {},
  event_app: { on() {}, off() {} },
}
process.env.NODE_ENV = 'production'

const { createRuntimeWindow, disposeRuntimeWindow, getRuntimePartition } = loadTsModule(
  path.join(root, 'src/main/modules/userApi/runtimeWindow.ts'),
  {
    '@common/mainIpc': { mainSend() {} },
    '@common/utils': { log: { error() {} } },
    '@common/projectIdentity': { PROJECT_IDENTITY },
    electron: {
      BrowserWindow: FakeBrowserWindow,
      session: {
        fromPartition: partition => {
          userApiPartition = partition
          return isolatedSession
        },
      },
    },
    fs: { promises: { readFile: async() => '<html></html>' } },
    '@main/utils': { openDevTools() {} },
    './rendererEvent/name': { __esModule: true, default: {} },
    './main': { getProxy: () => ({ host: '', port: '' }) },
    './utils': { getScript: async() => '' },
  },
)

const run = async() => {
  const runtime = await createRuntimeWindow({ apiInfo: { id: 'test' }, generation: 1, hooks: { onClosed() {}, onRenderProcessGone() {} } })
  assert.strictEqual(userApiPartition, getRuntimePartition('test'))
  assert.notStrictEqual(userApiPartition, getRuntimePartition('other'), 'sources must not share a session partition')
  assert.strictEqual(
    browserOptions.webPreferences.session,
    isolatedSession,
    'User API code should run in an isolated Electron session',
  )
  assert.strictEqual(defaultSession.permissionHandler, undefined)
  assert.strictEqual(typeof isolatedSession.permissionHandler, 'function')

  let permissionGranted
  isolatedSession.permissionHandler({}, 'geolocation', value => { permissionGranted = value })
  assert.strictEqual(permissionGranted, false)
  await disposeRuntimeWindow(runtime, { clearSession: true })

  const appSource = fs.readFileSync(path.join(root, 'src/main/app.ts'), 'utf8')
  const navigationHandler = /contents\.on\('will-navigate',[\s\S]*?\n\s*}\)/.exec(appSource)?.[0]
  assert(navigationHandler, 'Expected a global will-navigate handler')
  assert.doesNotMatch(
    navigationHandler,
    /NODE_ENV\s*!==\s*'production'\)\s*\{[^{}]*\breturn\b[^{}]*\}/,
    'Development navigation should not bypass the URL allowlist',
  )
}

run().then(() => {
  console.log('Electron security boundary tests passed')
}).catch((err) => {
  console.error(err)
  process.exitCode = 1
})
