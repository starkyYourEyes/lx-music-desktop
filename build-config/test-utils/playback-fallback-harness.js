const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const playbackError = (scope, kind, apiId) => Object.assign(new Error(kind), {
  name: 'PlaybackSourceError', scope, kind, apiId,
})

const onlineMusic = {
  id: 'song', source: 'wy', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', _qualitys: { '128k': {}, '320k': {}, flac: {} } },
}
const matchedTx = { ...onlineMusic, id: 'song-tx', source: 'tx' }
const matchedKg = { ...onlineMusic, id: 'song-kg', source: 'kg' }
const flacMusic = onlineMusic
const no128Music = { ...onlineMusic, id: 'no-128', meta: { ...onlineMusic.meta, _qualitys: { flac: {} } } }
const localMusic = {
  id: 'local-song', source: 'local', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', filePath: 'C:\\Music\\Song.mp3', _qualitys: {} },
}
const webdavMusic = {
  id: 'webdav-song', source: 'webdav', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', filePath: '/Song.mp3', _qualitys: {} },
}
const downloadItem = {
  id: 'download-song', progress: 0, status: 'run',
  metadata: { musicInfo: onlineMusic, quality: '320k' },
}
const song = onlineMusic
const songA = onlineMusic
const songB = { ...onlineMusic, id: 'song-b' }

const createRuntimeWindowHarness = ({
  destroyFailures = 0,
  loadFailures = 0,
  readFailures = 0,
  useDefaultReadRuntimeHtml = false,
} = {}) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const sessions = new Map()
  const windows = []
  const initEnvelopes = []
  let webContentsId = 0
  let remainingDestroyFailures = destroyFailures
  let remainingLoadFailures = loadFailures
  let remainingReadFailures = readFailures
  process.env.NODE_ENV = 'production'

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
        id: ++webContentsId,
        session: options.webPreferences.session,
        listeners: new Map(),
        on: (name, listener) => {
          let listeners = this.webContents.listeners.get(name)
          if (!listeners) this.webContents.listeners.set(name, listeners = new Set())
          listeners.add(listener)
        },
        removeListener: (name, listener) => this.webContents.listeners.get(name)?.delete(listener),
        emit: (name, ...args) => {
          for (const listener of [...(this.webContents.listeners.get(name) ?? [])]) listener(...args)
        },
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

    async loadURL() {
      if (remainingLoadFailures > 0) {
        remainingLoadFailures--
        throw new Error('simulated load failure')
      }
      this.webContents.emit('did-finish-load')
    }

    isDestroyed() {
      return this.destroyed
    }

    destroy() {
      if (remainingDestroyFailures > 0) {
        remainingDestroyFailures--
        throw new Error('simulated destroy failure')
      }
      this.destroyed = true
      for (const listener of [...(this.listeners.get('closed') ?? [])]) listener()
    }
  }

  const runtimeWindow = loadTsModule(
    path.join(__dirname, '../../src/main/modules/userApi/runtimeWindow.ts'),
    {
      electron: { BrowserWindow: FakeBrowserWindow, session: { fromPartition: getSession } },
      '@common/mainIpc': { mainSend() {} },
      '@common/projectIdentity': { PROJECT_IDENTITY: { userApiPartition: 'starky-lx-user-api' } },
      '@common/utils': { log: { error() {} } },
      './main': { getProxy: () => ({ host: '127.0.0.1', port: '1080' }) },
      './utils': { getScript: async id => 'script:' + id },
      fs: {
        promises: {
          readFile: async() => {
            if (remainingReadFailures > 0) {
              remainingReadFailures--
              throw new Error('simulated HTML read failure')
            }
            return '<html></html>'
          },
        },
      },
      'node:path': { join: (...parts) => parts.join('/') },
    },
  )

  const deps = {
    createWindow: options => new FakeBrowserWindow(options),
    fromPartition: getSession,
    getScript: async id => 'script:' + id,
    getProxy: () => ({ host: '127.0.0.1', port: '1080' }),
    send(runtime, name, payload) {
      if (name == 'userApi_initEnv') initEnvelopes.push(payload)
      return !runtime.window.isDestroyed()
    },
    logError() {},
  }
  if (!useDefaultReadRuntimeHtml) deps.readRuntimeHtml = async() => '<html></html>'
  const hooks = {
    onClosed() {},
    onRenderProcessGone() {},
  }

  return {
    create: (apiInfo, generation) => runtimeWindow.createRuntimeWindow({ apiInfo, generation, hooks, deps }),
    initialize: (runtime, apiInfo) => runtimeWindow.initializeRuntimeWindow(runtime, apiInfo, deps),
    dispose: (runtime, options) => runtimeWindow.disposeRuntimeWindow(runtime, options, deps),
    initEnvelopes,
    sessions,
    windows,
    runtimeWindow,
    deps,
  }
}

const createFakeClock = (start = 0) => {
  let now = start
  let sequence = 0
  const timers = new Map()
  const clock = {
    now: () => now,
    setTimeout(handler, delay) {
      const id = ++sequence
      timers.set(id, { id, deadline: now + Math.max(0, delay), handler })
      return id
    },
    clearTimeout: id => timers.delete(id),
    advance(ms) {
      now += ms
      while (true) {
        const due = [...timers.values()]
          .filter(timer => timer.deadline <= now)
          .sort((a, b) => a.deadline - b.deadline || a.id - b.id)[0]
        if (!due) break
        timers.delete(due.id)
        due.handler()
      }
    },
    setNow(value) {
      if (value < now) throw new RangeError('fake clock cannot move backwards')
      now = value
    },
    async flush() {
      await Promise.resolve()
      await Promise.resolve()
    },
  }
  return clock
}

module.exports = {
  deferred,
  playbackError,
  createFakeClock,
  onlineMusic,
  matchedTx,
  matchedKg,
  flacMusic,
  no128Music,
  localMusic,
  webdavMusic,
  downloadItem,
  song,
  songA,
  songB,
  createRuntimeWindowHarness,
}
