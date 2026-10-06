const assert = require('node:assert/strict')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const sessions = new Map()
const windows = []
const logErrors = []
let nextWebContentsId = 0
let remainingDestroyFailures = 0

const getSession = partition => {
  let runtimeSession = sessions.get(partition)
  if (runtimeSession) return runtimeSession
  runtimeSession = {
    cleanupCalls: [],
    cleanup(name) {
      this.cleanupCalls.push(name)
      if (this.cleanupFailure != name) return
      if (this.cleanupFailureMode == 'throw') throw this.cleanupError
      return Promise.reject(this.cleanupError)
    },
    clearAuthCache() { throw new Error('must preserve authentication') },
    clearStorageData(options) { assert.deepEqual(options, { storages: ['cachestorage'] }); return this.cleanup('storage') },
    clearCodeCaches() { return this.cleanup('code') },
    clearCache() { return this.cleanup('cache') },
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

  listenerCount(name) {
    return this.listeners.get(name)?.size ?? 0
  }

  emit(name, ...args) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args)
  }

  async loadURL() {}

  isDestroyed() {
    return this.destroyed
  }

  destroy() {
    if (remainingDestroyFailures > 0) {
      remainingDestroyFailures--
      throw new Error('simulated destroy failure')
    }
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
  sessionRegistry: { register: () => ({ ready: Promise.resolve(), unregister() {} }) },
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
  assert.deepEqual(isolatedRuntime.session.cleanupCalls, ['cache', 'storage', 'code'])
  assert.deepEqual(newRuntime.session.cleanupCalls, [])

  const windowsBeforeSessionClear = windows.length
  await runtimeWindow.clearRuntimeSession('user_api/never-created', deps)
  assert.equal(windows.length, windowsBeforeSessionClear)
  assert.deepEqual(
    getSession(runtimeWindow.getRuntimePartition('user_api/never-created')).cleanupCalls,
    ['cache', 'storage', 'code'],
  )

  await runtimeWindow.disposeRuntimeWindow(newRuntime, { clearSession: false }, deps)
  const destroyFailureRuntime = await runtimeWindow.createRuntimeWindow({
    apiInfo: { ...apiInfo, id: 'user_api/destroy-failure' },
    generation: 1,
    hooks,
    deps,
  })
  remainingDestroyFailures = 1
  await assert.rejects(
    runtimeWindow.disposeRuntimeWindow(destroyFailureRuntime, { clearSession: true }, deps),
    /simulated destroy failure/,
  )
  assert.equal(destroyFailureRuntime.window.destroyed, false)
  assert.equal(destroyFailureRuntime.window.listenerCount('closed'), 1)
  assert.deepEqual(destroyFailureRuntime.session.cleanupCalls, [])
  await runtimeWindow.disposeRuntimeWindow(destroyFailureRuntime, { clearSession: true }, deps)
  assert.equal(destroyFailureRuntime.window.destroyed, true)
  assert.deepEqual(destroyFailureRuntime.session.cleanupCalls, ['cache', 'storage', 'code'])

  for (const stage of ['cache', 'storage', 'code']) {
    for (const mode of ['throw', 'reject']) {
      const cleanupRuntime = await runtimeWindow.createRuntimeWindow({
        apiInfo: { ...apiInfo, id: 'user_api/cleanup-' + stage + '-' + mode },
        generation: 1,
        hooks,
        deps,
      })
      const cleanupError = new Error('simulated ' + stage + ' ' + mode + ' cleanup failure')
      cleanupRuntime.session.cleanupFailure = stage
      cleanupRuntime.session.cleanupFailureMode = mode
      cleanupRuntime.session.cleanupError = cleanupError
      await runtimeWindow.disposeRuntimeWindow(cleanupRuntime, { clearSession: true }, deps)
      assert.equal(cleanupRuntime.window.destroyed, true)
      assert.deepEqual(cleanupRuntime.session.cleanupCalls, ['cache', 'storage', 'code'])
      const label = { cache: 'cache', storage: 'cache storage', code: 'code cache' }[stage]
      assert.equal(logErrors.some(args => args[0] === 'session_cache_clear_failed' && args[1] === label), true)
      assert.equal(logErrors.some(args => args.includes(cleanupError)), false, 'cleanup logs must not expose raw session errors')
    }
  }

  console.log('User API runtime close transaction tests passed')
})().catch(err => {
  console.error(err)
  process.exitCode = 1
})
