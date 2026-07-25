const assert = require('node:assert')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const waitForAsyncTurn = () => new Promise(resolve => setImmediate(resolve))

const createHarness = ({
  destroyError,
  cleanupFailure,
  cleanupFailureMode = 'reject',
  deferClosedOnDestroy = false,
} = {}) => {
  const cleanupCalls = []
  const logErrors = []
  const sentEvents = []
  const windows = []
  const appListeners = new Map()
  const cleanupError = cleanupFailure
    ? new Error('simulated ' + cleanupFailure + ' cleanup failure')
    : undefined

  const eventApp = {
    on(name, listener) {
      let listeners = appListeners.get(name)
      if (!listeners) appListeners.set(name, listeners = new Set())
      listeners.add(listener)
    },
    off(name, listener) {
      appListeners.get(name)?.delete(listener)
    },
    emit(name, ...args) {
      for (const listener of [...(appListeners.get(name) ?? [])]) listener(...args)
    },
    listenerCount(name) {
      return appListeners.get(name)?.size ?? 0
    },
  }

  const cleanup = name => {
    cleanupCalls.push(name)
    if (cleanupFailure != name) return Promise.resolve()
    if (cleanupFailureMode == 'throw') throw cleanupError
    return Promise.reject(cleanupError)
  }

  const isolatedSession = {
    clearAuthCache: () => cleanup('auth'),
    clearStorageData: () => cleanup('storage'),
    clearCache: () => cleanup('cache'),
    setPermissionRequestHandler() {},
  }

  class FakeBrowserWindow {
    constructor(options) {
      this.destroyed = false
      this.listeners = new Map()
      this.webContents = {
        session: options.webPreferences.session,
        on() {},
        setWindowOpenHandler() {},
      }
      windows.push(this)
    }

    on(name, listener) {
      let listeners = this.listeners.get(name)
      if (!listeners) this.listeners.set(name, listeners = new Set())
      listeners.add(listener)
    }

    emit(name, ...args) {
      for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args)
    }

    async loadURL() {}

    destroy() {
      if (destroyError) throw destroyError
      this.destroyed = true
      if (!deferClosedOnDestroy) this.emit('closed')
    }
  }

  global.envParams = { cmdParams: {} }
  global.lx = {
    appSetting: {
      'network.proxy.enable': true,
      'network.proxy.host': '127.0.0.1',
      'network.proxy.port': '1080',
    },
    event_app: eventApp,
  }
  process.env.NODE_ENV = 'production'

  const runtime = loadTsModule(
    path.join(root, 'src/main/modules/userApi/main.ts'),
    {
      '@common/mainIpc': {
        mainSend(window, name, params) {
          sentEvents.push({ window, name, params })
        },
      },
      '@common/utils': {
        log: {
          error(...args) {
            logErrors.push(args)
          },
        },
      },
      electron: {
        BrowserWindow: FakeBrowserWindow,
        session: { fromPartition: () => isolatedSession },
      },
      fs: { promises: { readFile: async() => '<html></html>' } },
      '@main/utils': { openDevTools() {} },
      './rendererEvent/name': {
        __esModule: true,
        default: { initEnv: 'init', proxyUpdate: 'proxy' },
      },
      './utils': { getScript: async(id) => 'script:' + id },
    },
  )

  return {
    runtime,
    cleanupCalls,
    cleanupError,
    logErrors,
    sentEvents,
    windows,
    eventApp,
  }
}

const activateRuntime = async(harness, id) => {
  await harness.runtime.createWindow({ id })
  const window = harness.windows.at(-1)
  window.emit('ready-to-show')
  await waitForAsyncTurn()
  return window
}

const captureCloseError = async(closeWindow) => {
  try {
    await closeWindow()
  } catch (err) {
    return err
  }
}

const runDestroyFailure = async() => {
  const destroyError = new Error('simulated destroy failure')
  const harness = createHarness({ destroyError })
  const oldWindow = await activateRuntime(harness, 'stable-id')
  const closeError = await captureCloseError(harness.runtime.closeWindow)

  harness.runtime.sendEvent('probe', 'old-runtime')
  harness.eventApp.emit('updated_config', ['network.proxy.enable'])

  return {
    closeError: closeError?.message,
    oldDestroyed: oldWindow.destroyed,
    listenerCount: harness.eventApp.listenerCount('updated_config'),
    cleanupCalls: harness.cleanupCalls,
    probeReachedOld: harness.sentEvents.some(event => (
      event.name == 'probe' && event.window === oldWindow
    )),
    proxyReachedOld: harness.sentEvents.some(event => (
      event.name == 'proxy' && event.window === oldWindow
    )),
  }
}

const runCleanupFailure = async(stage, cleanupFailureMode) => {
  const harness = createHarness({
    cleanupFailure: stage,
    cleanupFailureMode,
  })
  const oldWindow = await activateRuntime(harness, 'stable-id')
  const closeError = await captureCloseError(harness.runtime.closeWindow)
  const listenerCountAfterClose = harness.eventApp.listenerCount('updated_config')

  let newWindow
  if (!closeError) {
    newWindow = await activateRuntime(harness, 'next-id')
    harness.runtime.sendEvent('probe', 'new-runtime')
    harness.eventApp.emit('updated_config', ['network.proxy.enable'])
  }

  return {
    stage,
    closeError: closeError?.message,
    oldDestroyed: oldWindow.destroyed,
    listenerCountAfterClose,
    cleanupCalls: harness.cleanupCalls,
    cleanupErrorLogged: harness.logErrors.some(args => args.includes(harness.cleanupError)),
    newWindowCreated: newWindow != null,
    listenerCountAfterReload: harness.eventApp.listenerCount('updated_config'),
    probeReachedNew: harness.sentEvents.some(event => (
      event.name == 'probe' && event.window === newWindow
    )),
    proxyReachedNew: harness.sentEvents.some(event => (
      event.name == 'proxy' && event.window === newWindow
    )),
  }
}
const runExternalClose = async() => {
  const harness = createHarness()
  const oldWindow = await activateRuntime(harness, 'stable-id')
  oldWindow.destroyed = true
  oldWindow.emit('closed')
  await harness.runtime.closeWindow()
  harness.eventApp.emit('updated_config', ['network.proxy.enable'])

  return {
    listenerCount: harness.eventApp.listenerCount('updated_config'),
    cleanupCalls: harness.cleanupCalls,
    proxyReachedClosed: harness.sentEvents.some(event => event.name == 'proxy'),
  }
}

const runDelayedClosed = async() => {
  const harness = createHarness({ deferClosedOnDestroy: true })
  const oldWindow = await activateRuntime(harness, 'stable-id')
  await harness.runtime.closeWindow()
  const newWindow = await activateRuntime(harness, 'next-id')
  oldWindow.emit('closed')
  harness.eventApp.emit('updated_config', ['network.proxy.enable'])

  return {
    listenerCount: harness.eventApp.listenerCount('updated_config'),
    newWindowDestroyed: newWindow.destroyed,
    proxyReachedNew: harness.sentEvents.some(event => event.name == 'proxy' && event.window === newWindow),
  }
}

;(async() => {
  const destroyFailure = await runDestroyFailure()
  const externalClose = await runExternalClose()
  const delayedClosed = await runDelayedClosed()
  const cleanupFailures = []
  for (const [stage, mode] of [
    ['auth', 'throw'],
    ['storage', 'reject'],
    ['cache', 'reject'],
  ]) {
    cleanupFailures.push(await runCleanupFailure(stage, mode))
  }

  assert.deepStrictEqual(destroyFailure, {
    closeError: 'simulated destroy failure',
    oldDestroyed: false,
    listenerCount: 1,
    cleanupCalls: [],
    probeReachedOld: true,
    proxyReachedOld: true,
  })
  assert.deepStrictEqual(externalClose, {
    listenerCount: 0,
    cleanupCalls: [],
    proxyReachedClosed: false,
  })
  assert.deepStrictEqual(delayedClosed, {
    listenerCount: 1,
    newWindowDestroyed: false,
    proxyReachedNew: true,
  })


  for (const result of cleanupFailures) {
    assert.equal(result.closeError, undefined, result.stage + ' cleanup rejected closeWindow')
    assert.equal(result.oldDestroyed, true, result.stage + ' cleanup kept the old runtime alive')
    assert.equal(result.listenerCountAfterClose, 0)
    assert.deepStrictEqual(result.cleanupCalls, ['auth', 'storage', 'cache'])
    assert.equal(result.cleanupErrorLogged, true)
    assert.equal(result.newWindowCreated, true)
    assert.equal(result.listenerCountAfterReload, 1)
    assert.equal(result.probeReachedNew, true)
    assert.equal(result.proxyReachedNew, true)
  }

  console.log('User API runtime close transaction tests passed')
})().catch(err => {
  console.error(err)
  process.exitCode = 1
})
