const assert = require('node:assert/strict')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const sessions = new Map()
const windows = []
const logErrors = []
let nextWebContentsId = 0

const getSession = partition => {
  let runtimeSession = sessions.get(partition)
  if (runtimeSession) return runtimeSession
  runtimeSession = {
    cleanupCalls: [],
    clearAuthCache() { this.cleanupCalls.push('auth') },
    clearStorageData() { this.cleanupCalls.push('storage') },
    clearCache() { this.cleanupCalls.push('cache') },
    setPermissionRequestHandler(handler) { this.permissionHandler = handler },
  }
  sessions.set(partition, runtimeSession)
  return runtimeSession
}

class FakeBrowserWindow {
  constructor(options) {
    this.destroyed = false
    this.listeners = new Map()
    this.webContents = {
      id: ++nextWebContentsId,
      session: options.webPreferences.session,
      listeners: new Map(),
      on: (name, listener) => {
        let listeners = this.webContents.listeners.get(name)
        if (!listeners) this.webContents.listeners.set(name, listeners = new Set())
        listeners.add(listener)
      },
      removeListener: (name, listener) => this.webContents.listeners.get(name)?.delete(listener),
      setWindowOpenHandler() {},
    }
    windows.push(this)
  }

  on(name, listener) {
    let listeners = this.listeners.get(name)
    if (!listeners) this.listeners.set(name, listeners = new Set())
    listeners.add(listener)
  }

  removeListener(name, listener) {
    this.listeners.get(name)?.delete(listener)
  }

  emit(name, ...args) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args)
  }

  async loadURL() {}

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    this.destroyed = true
  }
}

const runtimeWindow = loadTsModule(
  path.join(root, 'src/main/modules/userApi/runtimeWindow.ts'),
  {
    '@common/mainIpc': { mainSend() {} },
    '@common/projectIdentity': { PROJECT_IDENTITY: { userApiPartition: 'starky-lx-user-api' } },
    '@common/utils': { log: { error(...args) { logErrors.push(args) } } },
    electron: { BrowserWindow: FakeBrowserWindow, session: { fromPartition: getSession } },
    fs: { promises: { readFile: async() => '<html></html>' } },
    'node:path': { join: (...parts) => parts.join('/') },
    './main': { getProxy: () => ({ host: '', port: '' }) },
    './rendererEvent/name': { __esModule: true, default: { initEnv: 'userApi_initEnv' } },
    './utils': { getScript: async id => 'script:' + id },
  },
)

const deps = {
  createWindow: options => new FakeBrowserWindow(options),
  fromPartition: getSession,
  readRuntimeHtml: async() => '<html></html>',
  getScript: async id => 'script:' + id,
  getProxy: () => ({ host: '', port: '' }),
  send: runtime => !runtime.window.isDestroyed(),
  logError(message, reason) { logErrors.push([message, reason]) },
}

const sameIdentity = (first, second) => (
  first.apiId == second.apiId && first.generation == second.generation
)

;(async() => {
  let activeRuntime
  const hooks = {
    onClosed(identity) {
      if (activeRuntime && sameIdentity(activeRuntime.identity, identity)) activeRuntime = undefined
    },
    onRenderProcessGone() {},
  }
  const apiInfo = { id: 'user_api/a', name: 'A', description: '', sources: {} }
  const oldRuntime = await runtimeWindow.createRuntimeWindow({
    apiInfo,
    generation: 1,
    hooks,
    deps,
  })
  activeRuntime = oldRuntime
  const newRuntime = await runtimeWindow.createRuntimeWindow({
    apiInfo,
    generation: 2,
    hooks,
    deps,
  })
  activeRuntime = newRuntime

  oldRuntime.window.emit('closed')
  assert.strictEqual(activeRuntime, newRuntime)
  assert.equal(newRuntime.window.destroyed, false)

  await runtimeWindow.disposeRuntimeWindow(oldRuntime, { clearSession: false }, deps)
  assert.deepEqual(oldRuntime.session.cleanupCalls, [])
  assert.deepEqual(newRuntime.session.cleanupCalls, [])
  assert.equal(newRuntime.window.destroyed, false)

  const isolatedRuntime = await runtimeWindow.createRuntimeWindow({
    apiInfo: { ...apiInfo, id: 'user_api/b' },
    generation: 1,
    hooks,
    deps,
  })
  await runtimeWindow.disposeRuntimeWindow(isolatedRuntime, { clearSession: true }, deps)
  assert.deepEqual(isolatedRuntime.session.cleanupCalls, ['auth', 'storage', 'cache'])
  assert.deepEqual(newRuntime.session.cleanupCalls, [])

  const windowsBeforeSessionClear = windows.length
  await runtimeWindow.clearRuntimeSession('user_api/never-created', deps)
  assert.equal(windows.length, windowsBeforeSessionClear)
  assert.deepEqual(
    getSession(runtimeWindow.getRuntimePartition('user_api/never-created')).cleanupCalls,
    ['auth', 'storage', 'cache'],
  )

  await runtimeWindow.disposeRuntimeWindow(newRuntime, { clearSession: false }, deps)
  assert.equal(logErrors.length, 0)
  console.log('User API runtime close transaction tests passed')
})().catch(err => {
  console.error(err)
  process.exitCode = 1
})
