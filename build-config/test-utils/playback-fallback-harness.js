const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((_resolve, _reject) => { resolve = _resolve; reject = _reject })
  return { promise, resolve, reject }
}

const playbackError = (scope, kind, apiId) => Object.assign(new Error(kind), {
  name: 'PlaybackSourceError', scope, kind, apiId,
})

const onlineMusic = {
  id: 'song',
  source: 'wy',
  name: 'Song',
  singer: 'Artist',
  interval: '03:00',
  meta: { songId: 'song', albumName: 'Album', _qualitys: { '128k': {}, '320k': {}, flac: {} } },
}
const matchedTx = { ...onlineMusic, id: 'song-tx', source: 'tx', meta: { ...onlineMusic.meta, songId: 'song-tx' } }
const matchedKg = { ...onlineMusic, id: 'song-kg', source: 'kg', meta: { ...onlineMusic.meta, songId: 'song-kg' } }
const flacMusic = onlineMusic
const no128Music = { ...onlineMusic, id: 'no-128', meta: { ...onlineMusic.meta, _qualitys: { flac: {} } } }
const localMusic = {
  id: 'local-song',
  source: 'local',
  name: 'Song',
  singer: 'Artist',
  interval: '03:00',
  meta: { songId: 'C:\\Music\\Song.mp3', albumName: 'Album', filePath: 'C:\\Music\\Song.mp3', _qualitys: {} },
}
const webdavMusic = {
  id: 'webdav-song', source: 'webdav', name: 'Song', singer: 'Artist', interval: '03:00',
  meta: { albumName: 'Album', filePath: '/Song.mp3', picPath: '/cover.jpg', _qualitys: {} },
}
const downloadItem = {
  id: 'download-song',
  progress: 0,
  status: 'run',
  metadata: { musicInfo: onlineMusic, quality: '320k' },
}
const song = onlineMusic
const songA = onlineMusic
const songB = { ...onlineMusic, id: 'song-b', meta: { ...onlineMusic.meta, songId: 'song-b' } }

const musicUrlAuthorization = (provider = 'wy', accountScope = `test:${provider}`, generation = 1) => ({
  version: 1,
  provider,
  accountScope,
  generation,
})

const musicUrlKey = (
  musicInfo = onlineMusic,
  quality = '320k',
  authorization = musicUrlAuthorization(musicInfo.source),
) => ({
  authorization: structuredClone(authorization),
  sourceTrackId: musicInfo.id,
  quality,
})

const musicUrlKeyLabel = key => typeof key == 'string'
  ? key
  : `${key.sourceTrackId}_${key.quality}`

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
      clearStorageData(options) {
        this.cleanupCalls.push(options ? `storage:${options.storages.join(',')}` : 'storage')
      },
      clearCache() { this.cleanupCalls.push('cache') },
      clearCodeCaches() { this.cleanupCalls.push('code') },
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
    sessionRegistry: {
      register() { return { ready: Promise.resolve(), unregister() {} } },
    },
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
      for (let index = 0; index < 20; index++) await Promise.resolve()
    },
    get pendingTimerCount() { return timers.size },
  }
  return clock
}

const createPoolHarness = (options = {}) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const originalLx = global.lx
  const created = []
  let poolLookupCalls = 0
  const runtimePoolMocks = {
    './runtimeWindow': {},
    './runtimeError': require('../../scripts/test-utils/load-ts-module')(
      path.join(__dirname, '../../src/main/modules/userApi/runtimeError.ts'),
    ),
    './rendererEvent/name': {
      initEnv: 'userApi_initEnv',
      request: 'userApi_request',
      proxyUpdate: 'userApi_proxyUpdate',
    },
  }
  try {
    global.lx = options.globalLx
    const module = loadTsModule(
      path.join(__dirname, '../../src/main/modules/userApi/runtimePool.ts'),
      runtimePoolMocks,
    )
    if (options.loadOnly) {
      if (options.loadEntries) {
        const poolMock = {
          getUserApiRuntimePool() {
            poolLookupCalls++
            throw new Error('pool accessed during module evaluation')
          },
          initializeUserApiRuntimePool() {
            throw new Error('pool initialized during module evaluation')
          },
        }
        const inert = () => {}
        loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/index.ts'), {
          '@common/utils': { log: { error() {} } },
          '@main/modules/winMain': {},
          './runtimePool': poolMock,
          './main': {},
          './utils': {},
          './queue': { runUserApiTask: fn => fn() },
          './rendererEvent/rendererEvent': {},
        })
        loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/rendererEvent/rendererEvent.ts'), {
          '@common/mainIpc': { mainOn: inert },
          './name': { default: {} },
          '../runtimePool': poolMock,
          '../main': {},
          '../utils': {},
          '@main/modules/winMain': {},
        })
        loadTsModule(path.join(__dirname, '../../src/main/modules/winMain/rendererEvent/userApi.ts'), {
          '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} },
          '@common/mainIpc': { mainHandle: inert, mainOn: inert },
          '@common/utils': { log: { error() {} } },
          '@main/modules/userApi': {},
          '@main/modules/userApi/runtimeError': { normalizeRuntimeFailure() {} },
          '@main/modules/userApi/runtimePool': poolMock,
          '@main/modules/userApi/ipcValidation': {},
          '@main/modules/winMain/main': { sendEvent: inert },
        })
      }
      return {
        module,
        created,
        get poolLookupCalls() { return poolLookupCalls },
      }
    }

    const clock = options.clock ?? createFakeClock()
    const autoInit = options.autoInit ?? 'synchronous'
    const registry = new Map([
      ['a', { id: 'a', name: 'A', description: '', allowShowUpdateAlert: false, sources: {} }],
      ['b', { id: 'b', name: 'B', description: '', allowShowUpdateAlert: false, sources: {} }],
    ])
    const lifecycle = []
    const disposedIds = []
    const disposedGenerations = []
    const clearedSessionIds = []
    const sentRequests = []
    const proxyRecipients = []
    const alerts = []
    const devToolsIds = []
    const statusEvents = []
    const loggedErrors = []
    const remainingDisposeFailures = new Map(options.disposeFailures ?? [])
    const remainingClearSessionFailures = new Map(options.clearSessionFailures ?? [])
    const runtimes = new Map()
    const proxyListeners = new Set()
    const createWaiters = new Map()
    const runtimeWaiters = new Map()
    const initializeWaiters = new Map()
    const pendingWaiters = new Map()
    const disposeWaiters = new Map()
    const disposeCompleteWaiters = new Map()
    const disposePromiseSettledWaiters = new Map()
    const clearSessionWaiters = new Map()
    const clearSessionCompleteWaiters = new Map()
    const seenByMap = new Map()
    const logWaiters = []
    const queuedInit = new Map()
    let initAcceptCount = 0
    let proxyUnsubscribeCount = 0
    let pool

    const key = (apiId, generation) => `${apiId}:${generation ?? '*'}`
    const notify = (map, apiId, generation) => {
      let seen = seenByMap.get(map)
      if (!seen) seenByMap.set(map, seen = new Set())
      for (const item of [key(apiId, generation), key(apiId)]) {
        seen.add(item)
        map.get(item)?.resolve()
      }
    }
    const wait = (map, apiId, generation) => {
      const itemKey = key(apiId, generation)
      if (seenByMap.get(map)?.has(itemKey)) return Promise.resolve()
      let item = map.get(itemKey)
      if (!item) map.set(itemKey, item = deferred())
      return item.promise
    }
    const eventTarget = () => {
      const listeners = new Map()
      return {
        on(name, listener) {
          let set = listeners.get(name)
          if (!set) listeners.set(name, set = new Set())
          set.add(listener)
        },
        removeListener(name, listener) { listeners.get(name)?.delete(listener) },
        emit(name, ...args) {
          for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
        },
      }
    }
    let nextSenderId = 100
    const deps = {
      async createRuntimeWindow({ apiInfo, generation, hooks }) {
        lifecycle.push(`create:${apiInfo.id}:${generation}`)
        notify(createWaiters, apiInfo.id, generation)
        const createGate = typeof options.createGate == 'function'
          ? options.createGate(apiInfo.id, generation)
          : options.createGate
        if (createGate) await createGate
        if (options.createRejectIds?.includes(apiInfo.id)) {
          throw new Error(`create ${apiInfo.id} failed`)
        }
        const windowTarget = eventTarget()
        const webContentsTarget = eventTarget()
        const runtime = {
          identity: { apiId: apiInfo.id, generation },
          webContentsId: ++nextSenderId,
          partition: `partition:${apiInfo.id}`,
          session: {},
          window: {
            ...windowTarget,
            destroyed: false,
            isDestroyed() { return this.destroyed },
            destroy() { this.destroyed = true },
            webContents: { ...webContentsTarget, id: nextSenderId },
          },
          hooks,
        }
        runtimes.set(key(apiInfo.id, generation), runtime)
        created.push({ ...runtime.identity, webContentsId: runtime.webContentsId })
        notify(runtimeWaiters, apiInfo.id, generation)
        return runtime
      },
      async initializeRuntimeWindow(runtime) {
        lifecycle.push(`send-init:${runtime.identity.apiId}:${runtime.identity.generation}`)
        notify(initializeWaiters, runtime.identity.apiId, runtime.identity.generation)
        const initializeGate = typeof options.initializeGate == 'function'
          ? options.initializeGate(runtime.identity.apiId, runtime.identity.generation)
          : options.initializeGate
        if (initializeGate) await initializeGate
        const queued = queuedInit.get(runtime.identity.apiId)
        if (queued) {
          queuedInit.delete(runtime.identity.apiId)
          queued.resolve(pool.acceptInit(runtime.webContentsId, queued.envelope))
        } else if (autoInit) {
          const accept = () => {
            const accepted = pool.acceptInit(runtime.webContentsId, {
              identity: runtime.identity,
              status: true,
              data: { sources: {} },
            })
            lifecycle.push(`accept-init:${runtime.identity.apiId}:${runtime.identity.generation}:${accepted}`)
            if (accepted) initAcceptCount++
          }
          if (autoInit == 'synchronous') accept()
          else queueMicrotask(accept)
        }
        return true
      },
      disposeRuntimeWindow(runtime, { clearSession }) {
        const disposal = (async() => {
          lifecycle.push(`dispose:${runtime.identity.apiId}:${runtime.identity.generation}`)
          disposedIds.push(runtime.identity.apiId)
          disposedGenerations.push(runtime.identity.generation)
          notify(disposeWaiters, runtime.identity.apiId, runtime.identity.generation)
          const disposeGate = typeof options.disposeGate == 'function'
            ? options.disposeGate(runtime.identity.apiId, runtime.identity.generation)
            : options.disposeGate
          if (disposeGate) await disposeGate
          const remainingFailures = remainingDisposeFailures.get(runtime.identity.apiId) ?? 0
          if (remainingFailures > 0) {
            remainingDisposeFailures.set(runtime.identity.apiId, remainingFailures - 1)
            throw new Error(`dispose ${runtime.identity.apiId} failed`)
          }
          const disposeError = options.disposeErrors?.get(runtime.identity.apiId)
          if (disposeError) throw disposeError
          if (options.disposeRejectIds?.includes(runtime.identity.apiId)) throw new Error(`dispose ${runtime.identity.apiId} failed`)
          if (clearSession) {
            lifecycle.push(`clearSession:${runtime.identity.apiId}`)
            clearedSessionIds.push(runtime.identity.apiId)
          }
          notify(disposeCompleteWaiters, runtime.identity.apiId, runtime.identity.generation)
        })()
        void disposal.then(
          () => notify(disposePromiseSettledWaiters, runtime.identity.apiId, runtime.identity.generation),
          () => notify(disposePromiseSettledWaiters, runtime.identity.apiId, runtime.identity.generation),
        )
        return disposal
      },
      async clearRuntimeSession(apiId) {
        lifecycle.push(`clearSession:${apiId}`)
        notify(clearSessionWaiters, apiId)
        const clearSessionGate = typeof options.clearSessionGate == 'function'
          ? options.clearSessionGate(apiId)
          : options.clearSessionGate
        if (clearSessionGate) await clearSessionGate
        const remainingFailures = remainingClearSessionFailures.get(apiId) ?? 0
        if (remainingFailures > 0) {
          remainingClearSessionFailures.set(apiId, remainingFailures - 1)
          throw new Error(`clear session ${apiId} failed`)
        }
        clearedSessionIds.push(apiId)
        notify(clearSessionCompleteWaiters, apiId)
      },
      getApiInfo: apiId => registry.get(apiId),
      send(runtime, name, payload) {
        if (name == 'userApi_request') {
          sentRequests.push(payload)
          notify(pendingWaiters, payload.apiId, payload.requestId)
        } else if (name == 'userApi_proxyUpdate') {
          proxyRecipients.push(runtime.identity.apiId)
        }
        return true
      },
      onProxyUpdate(handler) {
        proxyListeners.add(handler)
        return () => { proxyListeners.delete(handler); proxyUnsubscribeCount++ }
      },
      getProxy: () => ({ host: '127.0.0.1', port: '1080' }),
      openDevTools: runtime => devToolsIds.push(runtime.identity.apiId),
      showUpdateAlert: info => alerts.push(structuredClone(info)),
      publishStatus: status => statusEvents.push(structuredClone(status)),
      initialConfiguredApiIds: new Set(options.initialConfiguredIds ?? ['a', 'b']),
      logError(message, reason) {
        loggedErrors.push({ message, reason })
        for (const waiter of logWaiters.splice(0)) if (message.includes(waiter.text)) waiter.resolve()
      },
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    }
    pool = module.createUserApiRuntimePool(deps)

    const binding = apiId => {
      const item = [...created].reverse().find(item => item.apiId == apiId)
      if (!item) throw new Error(`runtime ${apiId} has not been created`)
      return item
    }
    const sendInitEnvelope = (apiId, envelope) => {
      const current = binding(apiId)
      const runtime = runtimes.get(key(apiId, current.generation))
      if (!lifecycle.includes(`send-init:${apiId}:${current.generation}`)) {
        const result = deferred()
        queuedInit.set(apiId, { envelope, ...result })
        return result.promise
      }
      return Promise.resolve(pool.acceptInit(runtime.webContentsId, envelope))
    }
    const init = (apiId, data) => {
      const current = binding(apiId)
      return sendInitEnvelope(apiId, {
        identity: { apiId, generation: current.generation }, status: true, data,
      })
    }
    const failInit = (apiId, message) => {
      const current = binding(apiId)
      return sendInitEnvelope(apiId, {
        identity: { apiId, generation: current.generation }, status: false, message, data: { sources: {} },
      })
    }

    return {
      module,
      pool,
      init,
      failInit,
      respond(apiId, requestId, result) {
        const current = binding(apiId)
        return pool.acceptResponse(current.webContentsId, {
          identity: { apiId, generation: current.generation }, status: true, data: { requestId, result },
        })
      },
      async bind(apiId, webContentsId, generation, info = {}) {
        registry.set(apiId, { ...registry.get(apiId), ...info, id: apiId })
        nextSenderId = webContentsId - 1
        const ensuring = pool.ensure(apiId)
        await wait(initializeWaiters, apiId, generation)
        return { apiId, webContentsId, generation, ensuring }
      },
      binding,
      async ensureAndInit(apiId) {
        const ensuring = pool.ensure(apiId)
        await wait(initializeWaiters, apiId)
        if (!autoInit) await init(apiId, { sources: {} })
        return ensuring
      },
      emitProxyUpdate(proxy) {
        deps.getProxy = () => proxy
        for (const listener of [...proxyListeners]) listener()
      },
      sendUpdateAlert: (senderId, envelope) => pool.handleShowUpdateAlert(senderId, envelope),
      openDevTools: (senderId, envelope) => pool.handleOpenDevTools(senderId, envelope),
      getProxy: (senderId, envelope) => pool.handleGetProxy(senderId, envelope),
      waitForCreateCall: (apiId, generation) => wait(createWaiters, apiId, generation),
      waitForRuntimeCreated: (apiId, generation) => wait(runtimeWaiters, apiId, generation),
      waitForInitializeCall: (apiId, generation) => wait(initializeWaiters, apiId, generation),
      waitForPending: (apiId, requestId) => wait(pendingWaiters, apiId, requestId),
      waitForDisposed: (apiId, generation) => wait(disposeWaiters, apiId, generation),
      waitForDisposeCompleted: (apiId, generation) => wait(disposeCompleteWaiters, apiId, generation),
      waitForDisposePromiseSettled: (apiId, generation) => wait(disposePromiseSettledWaiters, apiId, generation),
      waitForSessionClearCall: apiId => wait(clearSessionWaiters, apiId),
      waitForSessionCleared: apiId => wait(clearSessionCompleteWaiters, apiId),
      waitForLog(text) {
        if (loggedErrors.some(entry => entry.message.includes(text))) return Promise.resolve()
        const item = deferred()
        logWaiters.push({ text, ...item })
        return item.promise
      },
      crash(apiId, generation = binding(apiId).generation) {
        const runtime = runtimes.get(key(apiId, generation))
        runtime.hooks.onRenderProcessGone(runtime.identity, { reason: 'crashed' })
      },
      createdGenerations: apiId => created.filter(item => item.apiId == apiId).map(item => item.generation),
      created,
      lifecycle,
      get initAcceptCount() { return initAcceptCount },
      disposedGenerations,
      disposedIds,
      clearedSessionIds,
      sentRequests,
      proxyRecipients,
      get proxyListenerCount() { return proxyListeners.size },
      alerts,
      devToolsIds,
      statusEvents,
      loggedErrors,
      get proxyUnsubscribeCount() { return proxyUnsubscribeCount },
    }
  } finally {
    global.lx = originalLx
  }
}

const createRuntimePreloadFailureHarness = async(identity = { apiId: 'a', generation: 1 }) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const names = {
    initEnv: 'userApi_initEnv',
    request: 'userApi_request',
    response: 'userApi_response',
    init: 'userApi_init',
    proxyUpdate: 'userApi_proxyUpdate',
    openDevTools: 'userApi_openDevTools',
    showUpdateAlert: 'userApi_showUpdateAlert',
  }
  const listeners = new Map()
  const exposed = new Map()
  const sent = []
  loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/renderer/preload.js'), {
    electron: {
      contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) },
      ipcRenderer: {
        on: (name, handler) => listeners.set(name, handler),
        send: (name, value) => sent.push({ name, value }),
      },
      webFrame: { executeJavaScript: async() => undefined },
    },
    needle: {},
    tunnel: { httpOverHttp: () => undefined, httpsOverHttp: () => undefined },
    '../rendererEvent/name': names,
  })
  listeners.get(names.initEnv)(null, {
    identity,
    apiInfo: {
      id: identity.apiId,
      name: 'A',
      description: '',
      version: '1',
      author: 'test',
      homepage: '',
      script: '',
    },
    proxy: { host: '', port: '' },
  })
  const lx = exposed.get('lx')
  await lx.send(lx.EVENT_NAMES.inited, {
    sources: {
      wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] },
    },
  })

  return {
    async reject(requestId, error) {
      await lx.on(lx.EVENT_NAMES.request, async() => { throw error })
      sent.length = 0
      listeners.get(names.request)(null, {
        requestId,
        data: {
          source: 'wy',
          action: 'musicUrl',
          info: { type: '128k' },
        },
      })
      await new Promise(resolve => setImmediate(resolve))
      return sent.find(item => item.name == names.response).value
    },
  }
}

const createAdapterHarness = (options = {}) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const builtinLookups = []
  const leases = []
  const builtinCapabilities = options.builtinCapabilities
    ? { builtin: options.builtinCapabilities }
    : options.builtinCapabilitiesById ?? {}
  const module = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/sourceAdapter.ts'),
    {
      '@common/constants': { QUALITYS: ['flac24bit', 'flac', 'wav', 'ape', '320k', '192k', '128k'] },
      '@common/utils/playbackSourceError': loadTsModule(
        path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
      ),
      '@common/utils/tools': loadTsModule(
        path.join(__dirname, '../../src/common/utils/tools.ts'),
      ),
      '@renderer/utils/ipc': {},
      '@renderer/utils/message': { requestMsg: {} },
      '@renderer/utils/musicSdk/api-source': {},
      '../utils': {
        getMusicUrlCacheKey: options.getMusicUrlCacheKey ?? (
          async(musicInfo, quality) => musicUrlKey(musicInfo, quality)
        ),
      },
    },
  )
  const adapter = module.createPlaybackSourceAdapter({
    isCustomApi: apiId => /^user_api/.test(apiId) || ['a'].includes(apiId),
    ensureUserApi: options.ensure ?? (async apiId => ({
      ok: true,
      value: { apiId, status: true, apiInfo: { id: apiId, sources: {} } },
    })),
    requestUserApi: options.request ?? (async params => ({
      ok: true,
      value: { source: params.data.source, action: params.data.action, data: { type: params.data.info.type, url: 'https://audio/custom' } },
    })),
    cancelUserApi: options.cancel ?? (() => {}),
    acquireRuntime: params => leases.push({ action: 'retain', ...params }),
    releaseRuntime: params => leases.push({ action: 'release', ...params }),
    getBuiltinCapabilities: apiId => {
      const sources = builtinCapabilities[apiId]
      return sources ? { sources } : undefined
    },
    getBuiltinApi(apiId, platform) {
      builtinLookups.push({ apiId, platform })
      return {
        getMusicUrl: options.builtinRequest ?? (async(_musicInfo, quality) => ({
          type: quality,
          url: 'https://audio/builtin',
        })),
      }
    },
    getMusicUrlCacheKey: options.getMusicUrlCacheKey ?? (
      async(musicInfo, quality) => musicUrlKey(musicInfo, quality)
    ),
    tooManyRequestsMessage: options.tooManyRequestsMessage,
    serverBusyMessages: options.serverBusyMessages ?? new Set(),
  })
  return Object.assign(adapter, { builtinLookups, leases })
}

const createColdUserApiRegistryHarness = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  let serializedUserApis
  const store = {
    get: key => key == 'userApis' && serializedUserApis != null
      ? structuredClone(serializedUserApis)
      : undefined,
    set: (key, value) => {
      if (key == 'userApis') serializedUserApis = structuredClone(value)
    },
  }
  const load = () => {
    const originalLx = global.lx
    try {
      global.lx = { event_app: { user_api_changed() {} } }
      return loadTsModule(path.join(__dirname, '../../src/main/modules/userApi/utils.ts'), {
        './config': { userApis: [] },
        '@common/constants': { STORE_NAMES: { USER_API: 'userApi' } },
        '@main/utils/store': () => store,
        '@common/utils/userApiSync': {
          assertUserApiSyncData() {},
          createUserApiSyncData() { return {} },
        },
        '@common/utils': { log: { error() {} } },
        '@common/utils/githubUserApi': {
          createGitHubUserApiError: message => new Error(message),
          GITHUB_USER_API_LIMITS: { maxFiles: 100, maxScriptBytes: 1024 * 1024, maxTotalBytes: 10 * 1024 * 1024 },
        },
      })
    } finally {
      global.lx = originalLx
    }
  }
  return {
    async importAndRestart(script) {
      const originalLx = global.lx
      try {
        global.lx = { event_app: { user_api_changed() {} } }
        await load().importApi(script)
      } finally {
        global.lx = originalLx
      }
      return load().getUserApis()
    },
    persistCapabilitiesAndRestart(apiId, sources) {
      const module = load()
      const state = module.getUserApiState()
      const api = state.apiList.find(api => api.id == apiId)
      api.sources = sources
      module.commitUserApiState(state)
      return Promise.resolve(load().getUserApis())
    },
    get serializedUserApis() {
      return structuredClone(serializedUserApis ?? [])
    },
  }
}

const createPrimaryCapabilityHarness = (options) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const module = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/primarySource.ts'),
    {
      '@common/utils/playbackSourceError': loadTsModule(
        path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
      ),
      '@renderer/store': {},
      '@renderer/store/setting': {},
      '@renderer/utils/ipc': {},
      '@renderer/utils/musicSdk/api-source': {},
      './playback/sourceSelectors': loadTsModule(
        path.join(__dirname, '../../src/renderer/core/music/playback/sourceSelectors.ts'),
      ),
    },
  )
  let primary = options.primary
  let ensureIndex = 0
  let requestId = 0
  const ensureCalls = []
  const requestActions = []
  const cancelledRequests = []
  const publishedCapabilities = []
  const ensureWaiters = new Map()
  const customIds = new Set((options.customApis ?? []).map(api => api.id))
  const runtimeStates = options.runtimeStates ?? {}
  const knownCapabilities = options.knownCapabilities ?? {}
  const notifyEnsure = apiId => {
    const count = ensureCalls.filter(id => id == apiId).length
    ensureWaiters.get(`${apiId}:${count}`)?.resolve()
  }
  const controller = module.createPrimarySourceCapabilityController({
    getPrimaryId: () => primary,
    isInstalledCustom: apiId => customIds.has(apiId),
    isCustomRegistryLoaded: () => options.customRegistryLoaded ?? true,
    getBuiltinCapabilities: apiId => options.builtinCapabilities?.[apiId],
    getRuntimeStatus: apiId => runtimeStates[apiId],
    getKnownCapabilities: apiId => knownCapabilities[apiId],
    ensureUserApi(apiId) {
      ensureCalls.push(apiId)
      notifyEnsure(apiId)
      if (options.ensure) return options.ensure(apiId)
      return Promise.resolve(options.ensureResults?.[ensureIndex++] ?? {
        ok: true,
        value: { apiId, status: true, apiInfo: { id: apiId, sources: {} } },
      })
    },
    requestUserApi(params) {
      requestActions.push(`${params.apiId}:${params.data.source}:${params.data.action}`)
      if (options.request) return options.request(params)
      return Promise.resolve({
        ok: true,
        value: { source: params.data.source, action: params.data.action, data: {} },
      })
    },
    cancelUserApi(params) { cancelledRequests.push(params) },
    publishCapabilities(apiId, value) { publishedCapabilities.push({ apiId, value }) },
    createRequestId: () => `primary:${++requestId}`,
  })
  const selectors = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/sourceSelectors.ts'),
  )
  return {
    controller,
    setPrimary(apiId) { primary = apiId },
    waitForEnsureCall(apiId, ordinal = 1) {
      if (ensureCalls.filter(id => id == apiId).length >= ordinal) return Promise.resolve()
      const key = `${apiId}:${ordinal}`
      let item = ensureWaiters.get(key)
      if (!item) ensureWaiters.set(key, item = deferred())
      return item.promise
    },
    ensureCalls,
    requestActions,
    cancelledRequests,
    publishedCapabilities,
    get qualityList() {
      const last = publishedCapabilities.at(-1)
      return selectors.deriveQualityListFromCapabilities(last?.value)
    },
  }
}

const createColdPrimaryMusicEntryHarness = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const ensureCalls = []
  const requestActions = []
  const runtimeStates = {}
  const capabilities = {}
  const rendererUserApi = {
    list: [{ id: 'user_api_a' }],
    runtimeStates,
    capabilities,
  }
  const runtimeSources = {
    local: { name: 'Local', type: 'music', actions: ['musicUrl', 'lyric', 'pic'], qualitys: [] },
  }
  const originalWindow = global.window
  const originalLx = global.lx
  try {
    global.window = { dt: false }
    loadTsModule(path.join(__dirname, '../../src/renderer/core/globalData.ts'), {
      '@renderer/worker': () => ({ main: { configureRunTempRoot: async() => {} } }),
      '@renderer/utils/ipc': {
        getRunTempRoot: () => ({
          then(resolve) {
            resolve(null)
            return { catch() {} }
          },
        }),
      },
    })
    const primaryModule = loadTsModule(
      path.join(__dirname, '../../src/renderer/core/music/primarySource.ts'),
      {
        '@common/utils/playbackSourceError': loadTsModule(
          path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
        ),
        '@renderer/store': {
          userApi: rendererUserApi,
          qualityList: { value: {} },
        },
        '@renderer/store/setting': { appSetting: { 'common.apiSource': 'user_api_a' } },
        '@renderer/utils/ipc': {
          ensureUserApi: async apiId => {
            ensureCalls.push(apiId)
            const status = { apiId, status: true, apiInfo: { id: apiId, sources: runtimeSources } }
            runtimeStates[apiId] = status
            return { ok: true, value: status }
          },
          sendUserApiRequest: async params => {
            requestActions.push(`${params.apiId}:${params.data.source}:${params.data.action}`)
            const data = params.data.action == 'musicUrl'
              ? { type: null, url: 'https://audio/local' }
              : params.data.action == 'lyric'
                ? { lyric: '[00:00]local' }
                : 'https://image/local'
            return { ok: true, value: { source: params.data.source, action: params.data.action, data } }
          },
          userApiRequestCancel() {},
        },
        '@renderer/utils/musicSdk/api-source': { supportQuality: {} },
        './playback/sourceSelectors': loadTsModule(
          path.join(__dirname, '../../src/renderer/core/music/playback/sourceSelectors.ts'),
        ),
      },
    )
    const compatibilityApi = {
      getMusicUrl: info => primaryModule.requestPrimarySourceAction({ source: 'local', action: 'musicUrl', info, quality: null }),
      getLyric: info => primaryModule.requestPrimarySourceAction({ source: 'local', action: 'lyric', info }),
      getPic: info => primaryModule.requestPrimarySourceAction({ source: 'local', action: 'pic', info }),
    }
    const candidateModule = loadTsModule(
      path.join(__dirname, '../../src/renderer/core/music/playback/candidates.ts'),
      {
        '@renderer/utils/musicSdk': { findMusic: async() => [] },
        '@renderer/utils': { toNewMusicInfo: value => value },
      },
    )
    const musicModule = loadTsModule(path.join(__dirname, '../../src/renderer/core/music/utils.ts'), {
      '@renderer/store': { apiSource: { value: 'user_api_a' }, qualityList: { value: {} } },
      '@renderer/store/netease': { isLoggedIn: { value: false } },
      '@renderer/store/qqMusic': { isLoggedIn: { value: false } },
      '@renderer/store/utils': { assertApiSupport: () => true },
      '@renderer/utils/musicSdk': { findMusic: async() => [] },
      '@renderer/utils/ipc': {
        getMusicUrl: async() => '',
        getPlayerLyric: async() => ({ lyric: '' }),
      },
      '@renderer/store/setting': { appSetting: { 'player.isS2t': false } },
      '@renderer/utils': { langS2T: async value => value, toNewMusicInfo: value => value, toOldMusicInfo: value => value },
      '@renderer/utils/message': { requestMsg: {} },
      '@renderer/utils/musicSdk/api-source': { apis: () => compatibilityApi },
      './playback/candidates': candidateModule,
      './playback/cache': { playbackUrlCache: { adoptCacheGeneration() {} } },
    })
    const globalDataKeys = Object.keys(global.window.lx)
    return {
      getLocalMusicUrl: () => musicModule.getOnlineOtherSourceMusicUrlByLocal(localMusic, false),
      getLocalLyric: () => musicModule.getOnlineOtherSourceLyricByLocal(localMusic, false),
      getLocalPicture: () => musicModule.getOnlineOtherSourcePicByLocal(localMusic),
      ensureCalls,
      requestActions,
      globalDataKeys,
    }
  } finally {
    global.window = originalWindow
    global.lx = originalLx
  }
}

const loadSourceSelectors = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  return loadTsModule(path.join(__dirname, '../../src/renderer/core/music/playback/sourceSelectors.ts'))
}
const canStartPlaybackWithRegistry = (...args) => loadSourceSelectors().canStartPlaybackWithRegistry(...args)
const canOpenPrimaryDownloadWithRegistry = (...args) => loadSourceSelectors().canOpenPrimaryDownloadWithRegistry(...args)
const deriveQualityListFromCapabilities = (...args) => loadSourceSelectors().deriveQualityListFromCapabilities(...args)

const loadCandidates = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  return loadTsModule(path.join(__dirname, '../../src/renderer/core/music/playback/candidates.ts'), {
    '@renderer/utils/musicSdk': { findMusic: async() => [] },
    '@renderer/utils': { toNewMusicInfo: value => value },
  })
}
const createOnlineProvider = (...args) => loadCandidates().createOnlineCandidateProvider(...args)
const createLocalProvider = (...args) => loadCandidates().createLocalCandidateProvider(...args)
const selectPlaybackQuality = (...args) => loadCandidates().selectPlaybackQuality(...args)

const loadPlaybackCache = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  return loadTsModule(path.join(__dirname, '../../src/renderer/core/music/playback/cache.ts'), {
    '@renderer/utils/ipc': {},
  })
}

const loadPlaybackSourceAdapter = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  return loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/sourceAdapter.ts'),
    {
      '@common/constants': { QUALITYS: ['flac24bit', 'flac', 'wav', 'ape', '320k', '192k', '128k'] },
      '@common/utils/playbackSourceError': loadTsModule(
        path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
      ),
      '@common/utils/tools': loadTsModule(
        path.join(__dirname, '../../src/common/utils/tools.ts'),
      ),
      '@renderer/utils/ipc': {},
      '@renderer/utils/message': { requestMsg: {} },
      '@renderer/utils/musicSdk/api-source': {},
      '../utils': { getMusicUrlCacheKey: async(musicInfo, quality) => musicUrlKey(musicInfo, quality) },
    },
  )
}

const loadPlaybackSession = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  return loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/session.ts'),
    {
      './candidates': loadCandidates(),
      './cache': loadPlaybackCache(),
      '@common/utils/playbackSourceError': loadTsModule(
        path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
      ),
    },
  )
}

const createResolveSessionHarness = (options, musicInfo, candidateProvider) => {
  const clock = options.clock ?? createFakeClock(0)
  const sourceIds = options.sourceIds ?? ['primary']
  const requestedSourceIds = []
  const sourceStarts = []
  const diagnostics = []
  const cacheCommits = []
  const leaseEvents = []
  const persistenceFailures = []
  const sourceWaiters = new Map()
  const sourceGates = new Map()
  const persistenceWaiters = new Map()
  const startedSources = new Set()

  const getSourceGate = apiId => {
    let gate = sourceGates.get(apiId)
    if (!gate) sourceGates.set(apiId, gate = deferred())
    return gate
  }
  const markSourceStarted = apiId => {
    if (startedSources.has(apiId)) return
    startedSources.add(apiId)
    requestedSourceIds.push(apiId)
    sourceStarts.push({ apiId, at: clock.now() })
  }
  const markSourceRequested = apiId => {
    sourceWaiters.get(apiId)?.resolve()
  }
  const capabilities = options.capabilities ?? {
    sources: {
      wy: { actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
      tx: { actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
      kg: { actions: ['musicUrl'], qualitys: ['128k', '320k', 'flac'] },
      local: { actions: ['musicUrl'], qualitys: ['128k'] },
    },
  }
  const requestDirect = request => {
    markSourceRequested(request.apiId)
    if (options.request) return Promise.resolve(options.request(request)).then(result => (
      Object.hasOwn(result, 'resolvedQuality')
        ? result
        : { ...result, resolvedQuality: result.quality ?? request.quality ?? '128k' }
    ))
    if (Object.prototype.hasOwnProperty.call(options.urls ?? {}, request.apiId)) {
      return Promise.resolve({
        url: options.urls[request.apiId],
        resolvedQuality: request.quality ?? '128k',
      })
    }
    return getSourceGate(request.apiId).promise.then(url => ({
      url,
      resolvedQuality: request.quality ?? '128k',
    }))
  }

  let adapter
  if (options.useRealAdapter) {
    const realAdapter = loadPlaybackSourceAdapter().createPlaybackSourceAdapter({
      isCustomApi: () => true,
      ensureUserApi: async apiId => ({
        ok: true,
        value: { apiId, status: true, apiInfo: { id: apiId, sources: capabilities.sources } },
      }),
      requestUserApi: params => {
        markSourceRequested(params.apiId)
        if (options.request) return options.request(params)
        return getSourceGate(params.apiId).promise.then(url => ({
          ok: true,
          value: { data: { type: params.data.info.type, url } },
        }))
      },
      cancelUserApi: () => {},
      acquireRuntime: ({ apiIds }) => apiIds.forEach(apiId => leaseEvents.push(`retain:${apiId}`)),
      releaseRuntime: ({ apiIds }) => apiIds.forEach(apiId => leaseEvents.push(`release:${apiId}`)),
      getBuiltinCapabilities: () => undefined,
      getBuiltinApi: () => { throw new Error('unexpected built-in playback source') },
      getMusicUrlCacheKey: options.authorizeMusicUrl ?? (
        async(musicInfo, quality) => musicUrlKey(musicInfo, quality)
      ),
      serverBusyMessages: new Set(),
    })
    adapter = {
      ...realAdapter,
      getCapabilities(apiId, signal) {
        markSourceStarted(apiId)
        return realAdapter.getCapabilities(apiId, signal)
      },
    }
  } else {
    adapter = {
      retainSources(apiIds) {
        apiIds.forEach(apiId => leaseEvents.push(`retain:${apiId}`))
      },
      releaseSources(apiIds) {
        apiIds.forEach(apiId => leaseEvents.push(`release:${apiId}`))
      },
      async getCapabilities(apiId) {
        markSourceStarted(apiId)
        return capabilities
      },
      authorizeMusicUrl(request) {
        if (options.authorizeMusicUrl) return options.authorizeMusicUrl(request)
        return Promise.resolve(musicUrlKey(request.musicInfo, request.quality))
      },
      getMusicUrl: options.requestOnline
        ? request => {
            markSourceRequested(request.apiId)
            const batch = request.musicInfo?.__playbackBatchIndex
            return options.requestOnline({
              apiId: request.apiId,
              batch,
              musicInfo: request.musicInfo,
            })
          }
        : requestDirect,
      getLocalMusicUrl: options.directLocal
        ? request => {
            markSourceRequested(request.apiId)
            return options.directLocal(request.apiId)
          }
        : requestDirect,
    }
  }

  const rows = new Map()
  if (options.cachedValue || options.cachedUrl) {
    rows.set(`${musicInfo.id}_${options.requestedQuality ?? '128k'}`, options.cachedValue ?? {
      url: options.cachedUrl,
      reportedQuality: null,
    })
  }
  const cache = createCacheHarness({
    rows,
    read: options.cacheRead,
    save: options.cacheCommit,
    remove: options.cacheDelete,
  })
  const observedCache = {
    ...cache,
    commit(...args) {
      cacheCommits.push(structuredClone(args))
      return cache.commit(...args)
    },
  }
  const reportPersistenceFailure = value => {
    persistenceFailures.push(value)
    persistenceWaiters.get(value.operation)?.resolve(value)
    if (options.throwPersistenceReporter) throw new Error('persistence reporter failed')
  }
  let id = 0
  const session = loadPlaybackSession().createPlaybackResolveSession({
    musicInfo,
    sourceIds,
    requestedQuality: options.requestedQuality ?? '128k',
    cacheMode: options.cacheMode ?? (options.cachedValue || options.cachedUrl ? 'lookup' : 'bypass'),
    adapter,
    cache: observedCache,
    candidateProvider,
    clock,
    createId: () => `playback-${++id}`,
    diagnostics: { record: value => diagnostics.push(value) },
    reportPersistenceFailure,
  })

  return {
    sourceIds: session.sourceIds,
    nextCandidate: () => session.nextCandidate(),
    accept: candidateId => session.accept(candidateId),
    rejectMedia: (candidateId, failure) => session.rejectMedia(candidateId, failure),
    expireCandidate: candidateId => session.expireCandidate(candidateId),
    cancel: reason => session.cancel(reason),
    requestedSourceIds,
    sourceStarts,
    diagnostics,
    cacheCommits,
    cacheRemoved: cache.removed,
    cacheSaveCalls: cache.saveCalls,
    leaseEvents,
    persistenceFailures,
    waitForSource(apiId) {
      if (requestedSourceIds.includes(apiId)) return Promise.resolve()
      let waiter = sourceWaiters.get(apiId)
      if (!waiter) sourceWaiters.set(apiId, waiter = deferred())
      return waiter.promise
    },
    succeed(apiId, url) {
      getSourceGate(apiId).resolve(url)
    },
    waitForPersistenceFailure(operation) {
      const existing = persistenceFailures.find(value => value.operation == operation)
      if (existing) return Promise.resolve(existing)
      let waiter = persistenceWaiters.get(operation)
      if (!waiter) persistenceWaiters.set(operation, waiter = deferred())
      return waiter.promise
    },
    async flush() {
      await new Promise(resolve => setImmediate(resolve))
      await Promise.resolve()
    },
  }
}

const createSessionHarness = (options = {}) => createResolveSessionHarness(
  options,
  options.musicInfo ?? onlineMusic,
  createOnlineProvider(
    options.musicInfo ?? onlineMusic,
    options.findCandidates ?? (async() => options.matched ?? []),
  ),
)

const createLocalSessionHarness = (options = {}) => {
  const batchIndexes = []
  let batchIndex = 0
  const musicInfo = options.musicInfo ?? (options.findCandidates
    ? { ...localMusic, name: 'Song - Artist' }
    : localMusic)
  const provider = createLocalProvider(musicInfo, async query => {
    const currentBatch = batchIndex++
    const result = options.findCandidates
      ? await options.findCandidates(query, currentBatch)
      : options.batches?.[currentBatch] ?? (currentBatch == 0 ? [matchedTx] : [])
    for (const candidate of result) {
      Object.defineProperty(candidate, '__playbackBatchIndex', {
        configurable: true,
        value: currentBatch,
      })
    }
    return result
  })
  const request = options.request
  const harness = createResolveSessionHarness(
    {
      ...options,
      request: request
        ? value => {
            if (value.musicInfo?.__playbackBatchIndex != null) {
              batchIndexes.push(value.musicInfo.__playbackBatchIndex)
            }
            return request(value)
          }
        : request,
    },
    musicInfo,
    provider,
  )
  return Object.assign(harness, { batchIndexes })
}

const createMusicFacadeHarness = (options = {}) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const primary = options.primary ?? 'primary'
  const fallbacks = options.fallbacks ?? ['fallback']
  const requestedQuality = options.requestedQuality ?? '320k'
  const requestedApiIds = []
  const cacheLookups = []
  const apiActionCalls = []
  const webdavActions = []
  const persistenceFailures = []
  const sessionCreateInputs = []
  let sessionSettings = {
    primaryId: primary,
    fallbackIds: [...fallbacks],
    requestedQuality,
  }
  let readSettingsCount = 0
  let sessionCreateCount = 0
  let localMusicUrlSaves = 0
  let webdavCalls = 0
  let downloadPlatformSwitches = 0
  let downloadRequestCount = 0

  const cacheModule = loadPlaybackCache()
  const candidatesModule = loadCandidates()
  const coordinatorModule = loadPlaybackCoordinator()
  const sessionModule = loadPlaybackSession()
  const invalidateQualityRange = options.throwCacheInvalidationSynchronously !== undefined
    ? () => { throw options.throwCacheInvalidationSynchronously }
    : async() => {
        if (options.rejectCacheInvalidation !== undefined) {
          throw options.rejectCacheInvalidation
        }
        if (options.cacheInvalidationGate) await options.cacheInvalidationGate.promise
      }
  const cache = {
    lookup: async() => null,
    tombstone: async() => {},
    tombstoneKey: async() => {},
    commit: async() => {},
    invalidateQualityRange,
    getPlaybackQualityOrder: cacheModule.getPlaybackQualityOrder,
  }
  const adapter = {
    retainSources() {},
    releaseSources() {},
    async getCapabilities() { return { sources: {} } },
    async authorizeMusicUrl({ musicInfo, quality }) { return musicUrlKey(musicInfo, quality) },
    async getMusicUrl() { throw new Error('not used') },
    async getLocalMusicUrl() { throw new Error('not used') },
  }
  const originalWindow = global.window
  global.window = {
    ...(originalWindow ?? {}),
    setTimeout,
    clearTimeout,
  }
  const playbackModule = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/index.ts'),
    {
      '@common/utils': { encodePath: value => `encoded:${value}`, log: { debug() {}, error() {} } },
      '@renderer/store/setting': {
        appSetting: {
          'common.apiSource': primary,
          'common.apiFallbackSources': [...fallbacks],
          'player.playQuality': requestedQuality,
        },
      },
      '@renderer/store/download/utils': { buildSavePath: () => 'D:\\downloads' },
      '@renderer/plugins/player': { clearResourceIf() {} },
      '@renderer/utils/music': {
        getDownloadFilePath: async() => options.downloadedFileExists === false
          ? null
          : 'D:\\downloads\\song.mp3',
        getLocalFilePath: async() => 'D:\\music\\song.mp3',
      },
      '../webdav': {
        getMusicUrl: async() => {
          webdavCalls++
          return 'https://dav.test/song.mp3'
        },
      },
      './cache': { ...cacheModule, playbackUrlCache: cache },
      './candidates': candidatesModule,
      './coordinator': {
        ...coordinatorModule,
        createPlaybackResolutionCoordinator: () => ({}),
      },
      './session': sessionModule,
      './sourceAdapter': { playbackSourceAdapter: adapter },
    },
  )
  global.window = originalWindow

  const reportPersistenceFailure = value => {
    persistenceFailures.push(value)
    if (options.throwPersistenceReporter) throw new Error('persistence reporter failed')
  }
  const sessionFactories = playbackModule.createPlaybackSessionFactories({
    readSettings: () => {
      readSettingsCount++
      return sessionSettings
    },
    cache,
    adapter,
    clock: createFakeClock(),
    createId: () => `facade-session-${sessionCreateCount + 1}`,
    diagnostics: { record() {} },
    reportPersistenceFailure,
    createResolveSession(input) {
      sessionCreateCount++
      sessionCreateInputs.push({
        sourceIds: [...input.sourceIds],
        requestedQuality: input.requestedQuality,
        cacheMode: input.cacheMode,
      })
      return sessionModule.createPlaybackResolveSession(input)
    },
    createOnlineCandidateProvider: musicInfo => candidatesModule.createOnlineCandidateProvider(
      musicInfo,
      async() => [],
    ),
    createLocalCandidateProvider: musicInfo => candidatesModule.createLocalCandidateProvider(
      musicInfo,
      async() => [],
    ),
  })
  const facade = playbackModule.createPlaybackMusicFacade({
    getDownloadFilePath: async() => options.downloadedFileExists === false
      ? null
      : 'D:\\downloads\\song.mp3',
    buildSavePath: () => 'D:\\downloads',
    getLocalFilePath: async() => 'D:\\music\\song.mp3',
    encodePath: value => `encoded:${value}`,
    getWebDAVMusicUrl: async() => {
      webdavCalls++
      return 'https://dav.test/song.mp3'
    },
    ...sessionFactories,
  })

  const onlineModule = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/online.ts'),
    {
      '@renderer/store/list/action': { updateListMusics() {} },
      '@renderer/store/setting': { appSetting: { 'player.playQuality': requestedQuality } },
      '@renderer/utils/ipc': {
        saveLyric() {},
        async getMusicUrl(key) {
          cacheLookups.push(`${key.sourceTrackId}_${key.quality}`)
          return null
        },
      },
      './utils': {
        buildLyricInfo: value => value,
        getPlayQuality: quality => quality,
        getCachedLyricInfo: async() => null,
        getMusicUrlCacheKey: async(musicInfo, quality) => ({
          authorization: {
            version: 1,
            provider: musicInfo.source,
            accountScope: `test:${musicInfo.source}`,
            generation: 1,
          },
          sourceTrackId: musicInfo.id,
          quality,
        }),
        async handleGetOnlineMusicUrl({ musicInfo, quality, allowToggleSource }) {
          requestedApiIds.push(primary)
          downloadRequestCount++
          if (options.failFirstDownloadRequest && downloadRequestCount == 1) {
            throw new Error('simulated primary download failure')
          }
          if (options.failFirstDownloadRequest && allowToggleSource) downloadPlatformSwitches++
          return {
            url: 'https://audio.test/song.mp3',
            quality: quality ?? requestedQuality,
            musicInfo,
            isFromCache: false,
          }
        },
        async handleGetOnlineLyricInfo({ musicInfo }) {
          apiActionCalls.push(`${primary}:${musicInfo.source}:lyric`)
          return { lyricInfo: { lyric: '' }, musicInfo, isFromCache: false }
        },
        async handleGetOnlinePicUrl({ musicInfo }) {
          apiActionCalls.push(`${primary}:${musicInfo.source}:pic`)
          return { url: 'https://image.test/cover.jpg', musicInfo, isFromCache: false }
        },
      },
    },
  )
  const localModule = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/local.ts'),
    {
      '@common/utils/common': { encodePath: value => value },
      '@renderer/store/list/action': { updateListMusics() {} },
      '@renderer/utils/ipc': {
        saveLyric() {},
        saveMusicUrl() { localMusicUrlSaves++ },
      },
      '@renderer/utils/music': { getLocalFilePath: async() => null },
      './utils': {
        buildLyricInfo: value => value,
        getCachedLyricInfo: async() => null,
        getOtherSource: async() => [],
        async getOnlineOtherSourceLyricByLocal() {
          apiActionCalls.push(`${primary}:local:lyric`)
          return { lyricInfo: { lyric: '' }, isFromCache: false }
        },
        async getOnlineOtherSourcePicByLocal() {
          apiActionCalls.push(`${primary}:local:pic`)
          return { url: 'https://image.test/local.jpg' }
        },
        async getOnlineOtherSourceMusicUrlByLocal() {
          return {
            url: 'https://audio.test/local.mp3',
            quality: '128k',
            isFromCache: false,
          }
        },
        async getOnlineOtherSourceMusicUrl() { throw new Error('not used') },
        async getOnlineOtherSourcePicUrl() { throw new Error('not used') },
        async getOnlineOtherSourceLyricInfo() { throw new Error('not used') },
      },
      './playback/candidates': candidatesModule,
    },
  )
  const webdavModule = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/webdav.ts'),
    {
      '@renderer/utils/ipc': {
        async getWebDAVMusicLyric() {
          webdavActions.push('lyric')
          return { lyric: '' }
        },
        async getWebDAVMusicPic() {
          webdavActions.push('pic')
          return 'https://dav.test/cover.jpg'
        },
        async getWebDAVMusicUrl() { throw new Error('not used') },
      },
      './utils': { buildLyricInfo: value => value },
    },
  )
  const actionModule = loadTsModule(
    path.join(__dirname, '../../src/renderer/store/download/action.ts'),
    {
      '@renderer/utils/ipc': {
        downloadTasksGet: async() => [],
        downloadTasksCreate: async() => {},
        downloadTasksRemove: async() => {},
        downloadTasksUpdate: async() => {},
      },
      './state': { downloadList: [] },
      '@common/utils/vueTools': { markRaw() {}, toRaw: value => value },
      '@renderer/core/music/online': onlineModule,
      '../setting': {
        appSetting: {
          'download.isUseOtherSource': true,
          'download.maxDownloadNum': 1,
        },
      },
      '..': { qualityList: { value: {} } },
      '@renderer/worker/utils': { proxyCallback: value => value },
      '@renderer/utils': {
        arrPush() {}, arrUnshift() {}, joinPath: (...values) => values.join('/'),
      },
      '@common/constants': { DOWNLOAD_STATUS: {} },
      '../index': { proxy: { enable: false } },
      './utils': { buildSavePath: () => 'D:\\downloads' },
      '@renderer/core/music/primarySource': { ensurePrimarySourceCapabilities: async() => {} },
    },
  )

  return {
    ...facade,
    createOnlinePlaybackSession: sessionFactories.createOnlinePlaybackSession,
    updateSessionSettings(value) { sessionSettings = value },
    getDownloadUrl(item) {
      if (!options.failFirstDownloadRequest) return actionModule.getDownloadUrl(item)
      const toggleMusicInfo = {
        ...item.metadata.musicInfo,
        id: `${item.metadata.musicInfo.id}-toggle`,
      }
      return actionModule.getDownloadUrl({
        ...item,
        metadata: {
          ...item.metadata,
          musicInfo: {
            ...item.metadata.musicInfo,
            meta: { ...item.metadata.musicInfo.meta, toggleMusicInfo },
          },
        },
      })
    },
    getOnlineLyric: info => onlineModule.getLyricInfo({ musicInfo: info, isRefresh: true }),
    getOnlinePic: info => onlineModule.getPicUrl({ musicInfo: info, isRefresh: true }),
    getLocalLyric: info => localModule.getLyricInfo({ musicInfo: info, isRefresh: true }),
    getLocalPic: info => localModule.getPicUrl({ musicInfo: info, isRefresh: true }),
    getLocalUrl: info => localModule.getPrimaryMusicUrl({
      musicInfo: info,
      isRefresh: true,
      allowToggleSource: false,
    }),
    getWebdavLyric: info => webdavModule.getLyricInfo({ musicInfo: info, isRefresh: true }),
    getWebdavPic: info => webdavModule.getPicUrl({ musicInfo: info, isRefresh: true }),
    get sessionCreateCount() { return sessionCreateCount },
    get readSettingsCount() { return readSettingsCount },
    get localMusicUrlSaves() { return localMusicUrlSaves },
    get webdavCalls() { return webdavCalls },
    requestedApiIds,
    cacheLookups,
    apiActionCalls,
    webdavActions,
    get downloadPlatformSwitches() { return downloadPlatformSwitches },
    persistenceFailures,
    sessionCreateInputs,
  }
}

const resolvePolicyForReason = reason => createMusicFacadeHarness().resolvePolicyForReason(reason)

const loadPlaybackCoordinator = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  return loadTsModule(path.join(__dirname, '../../src/renderer/core/music/playback/coordinator.ts'))
}

const createCoordinatorHarness = (options = {}) => {
  const clock = options.clock ?? createFakeClock(0)
  const coordinatorModule = loadPlaybackCoordinator()
  const deletedCacheKeys = []
  const sessionCancelReasons = []
  const publishedForegroundUrls = []
  const foregroundFailures = []
  const foregroundLifecycle = []
  const detachedForegroundUrls = []
  const requestedSourceIds = []
  const createdReasons = []
  const candidateByUrl = new Map()
  const candidateGates = new Map()
  const foregroundCandidates = []
  const foregroundCandidateWaiters = []
  const foregroundFailureWaiters = []
  const preloadPhaseEvents = []
  const preloadPhaseWaiters = []
  let futureSourceIds = [...(options.sourceIds ?? ['primary'])]
  let createRequestCount = 0
  let nextCandidateCount = 0
  let sessionCreateCount = 0
  let cacheCommitCount = 0
  let releaseSourcesCount = 0
  let candidateOrdinal = 0
  let sessionOrdinal = 0
  let sourceUrlCursor = 0
  let lastForegroundCandidate = null
  let lastPreloadCandidate = null
  let lazySession = null

  const notifyPreloadPhase = phase => {
    const waiterIndex = preloadPhaseWaiters.findIndex(waiter => waiter.phase == phase)
    if (waiterIndex >= 0) preloadPhaseWaiters.splice(waiterIndex, 1)[0].gate.resolve()
    else preloadPhaseEvents.push(phase)
  }
  const makeSourceError = (scope, kind) => playbackError(scope, kind)
  const releaseSession = session => {
    if (session.released) return
    session.released = true
    releaseSourcesCount++
  }
  const getSourceUrl = apiId => {
    if (options.sourceUrls) return options.sourceUrls[sourceUrlCursor++] ?? `https://${apiId}`
    if (options.sourceUrl) return options.sourceUrl
    return `https://${apiId}`
  }
  const makeCandidate = (session, origin, url, apiId, deadlineAt) => {
    const candidate = {
      sessionId: session.id,
      candidateId: `${session.id}:candidate:${++candidateOrdinal}`,
      songIdentity: session.songIdentity,
      origin,
      ...(apiId ? { apiId } : {}),
      quality: '128k',
      url,
      cacheKey: `${session.musicInfo.id}_128k`,
      deadlineAt,
    }
    candidateByUrl.set(url, candidate)
    return candidate
  }
  const createFakeSession = (musicInfo, sourceIds = futureSourceIds) => {
    sessionCreateCount++
    const sessionRecord = {
      id: `session-${++sessionOrdinal}`,
      songIdentity: `${musicInfo.source}:${musicInfo.id}`,
      sourceIds: Object.freeze([...sourceIds]),
      musicInfo,
      activeCandidate: null,
      cachePending: Boolean(options.cachedUrl),
      sourceIndex: 0,
      sourceDeadlineAt: null,
      mediaRejected: false,
      state: 'active',
      released: false,
    }
    const expire = candidate => {
      sessionRecord.activeCandidate = null
      if (candidate.origin == 'cache') deletedCacheKeys.push(candidate.cacheKey)
      else {
        if (sessionRecord.sourceIds.length > 1) sessionRecord.sourceIndex++
        sessionRecord.sourceDeadlineAt = null
      }
      return 'expired'
    }
    return {
      id: sessionRecord.id,
      songIdentity: sessionRecord.songIdentity,
      sourceIds: sessionRecord.sourceIds,
      async nextCandidate() {
        nextCandidateCount++
        notifyPreloadPhase('resolving')
        if (sessionRecord.state != 'active') throw makeSourceError('session', 'cancelled')
        if (sessionRecord.activeCandidate) return sessionRecord.activeCandidate
        if (sessionRecord.mediaRejected && options.exhaustAfterMediaError) {
          sessionRecord.state = 'failed'
          releaseSession(sessionRecord)
          throw makeSourceError('session', 'request')
        }
        let candidate
        if (sessionRecord.cachePending) {
          sessionRecord.cachePending = false
          candidate = makeCandidate(
            sessionRecord,
            'cache',
            options.cachedUrl,
            undefined,
            clock.now() + 10_000,
          )
        } else {
          const apiId = sessionRecord.sourceIds[
            Math.min(sessionRecord.sourceIndex, sessionRecord.sourceIds.length - 1)
          ] ?? 'primary'
          requestedSourceIds.push(apiId)
          sessionRecord.sourceDeadlineAt ??= clock.now() + 10_000
          candidate = makeCandidate(
            sessionRecord,
            'source',
            getSourceUrl(apiId),
            apiId,
            sessionRecord.sourceDeadlineAt,
          )
        }
        sessionRecord.activeCandidate = candidate
        if (options.blockCandidateNumber == candidateOrdinal) {
          let gate = candidateGates.get(candidateOrdinal)
          if (!gate) candidateGates.set(candidateOrdinal, gate = deferred())
          await gate.promise
          if (sessionRecord.state != 'active') throw makeSourceError('session', 'cancelled')
        }
        return candidate
      },
      accept(candidateId) {
        const candidate = sessionRecord.activeCandidate
        if (sessionRecord.state != 'active' || candidate?.candidateId != candidateId) return 'stale'
        if (clock.now() >= candidate.deadlineAt) return expire(candidate)
        sessionRecord.activeCandidate = null
        sessionRecord.state = 'accepted'
        cacheCommitCount++
        releaseSession(sessionRecord)
        return 'accepted'
      },
      rejectMedia(candidateId) {
        const candidate = sessionRecord.activeCandidate
        if (sessionRecord.state != 'active' || candidate?.candidateId != candidateId) return 'stale'
        if (clock.now() >= candidate.deadlineAt) return expire(candidate)
        sessionRecord.activeCandidate = null
        sessionRecord.mediaRejected = true
        if (candidate.origin == 'cache') deletedCacheKeys.push(candidate.cacheKey)
        else if (sessionRecord.sourceIds.length > 1) sessionRecord.sourceIndex++
        return 'resumed'
      },
      expireCandidate(candidateId) {
        const candidate = sessionRecord.activeCandidate
        if (sessionRecord.state != 'active' || candidate?.candidateId != candidateId) return 'stale'
        return expire(candidate)
      },
      cancel(reason) {
        if (sessionRecord.state != 'active') return
        sessionRecord.state = 'cancelled'
        sessionRecord.activeCandidate = null
        sessionCancelReasons.push(reason)
        releaseSession(sessionRecord)
      },
    }
  }

  class FakePreloadAudio {
    constructor() {
      this.listeners = new Map()
      this.bindings = new Map()
      this.boundUrls = []
      this.bound = false
      this.detached = false
      this.muted = false
      this._src = ''
    }

    addEventListener(name, handler) {
      this.listeners.set(name, handler)
    }

    removeEventListener(name, handler) {
      if (this.listeners.get(name) == handler) this.listeners.delete(name)
    }

    pause() {}

    removeAttribute(name) {
      if (name != 'src') return
      this._src = ''
      this.bound = false
      this.detached = true
    }

    load() {}

    set src(url) {
      this._src = url
      this.bound = true
      this.detached = false
      this.boundUrls.push(url)
      this.bindings.set(url, {
        canplay: this.listeners.get('canplay'),
        error: this.listeners.get('error'),
      })
      const candidate = candidateByUrl.get(url)
      if (candidate) lastPreloadCandidate = candidate
    }

    get src() {
      return this._src
    }

    emitFor(resource, name) {
      return this.bindings.get(resource.url)?.[name]?.() ?? 'stale'
    }

    emit(name) {
      return this.listeners.get(name)?.() ?? 'stale'
    }
  }

  const preloadAudios = []
  const createPreloadAudio = () => {
    const audio = new FakePreloadAudio()
    preloadAudios.push(audio)
    return audio
  }
  const emitPreloadFor = (resource, name) => (
    [...preloadAudios].reverse().find(audio => audio.bindings.has(resource.url))?.emitFor(resource, name) ?? 'stale'
  )
  const getDefaultSession = () => lazySession ??= createFakeSession(options.musicInfo ?? song)
  const createRequest = async input => {
    createRequestCount++
    createdReasons.push(input.reason)
    notifyPreloadPhase('resolving')
    if (options.createRequest) return options.createRequest(input)
    if (options.directUrl) {
      return {
        kind: 'direct',
        resource: {
          kind: 'direct',
          songIdentity: `${input.musicInfo.source}:${input.musicInfo.id}`,
          url: options.directUrl,
        },
      }
    }
    return {
      kind: 'session',
      session: createFakeSession(input.musicInfo, [...futureSourceIds]),
    }
  }
  const coordinator = coordinatorModule.createPlaybackResolutionCoordinator({
    createRequest,
    createPreloadAudio,
    detachForegroundResource(resource) {
      detachedForegroundUrls.push(resource.url)
      foregroundLifecycle.push(`detach:${resource.url}`)
    },
    clock,
  })
  coordinator.setForegroundHandlers({
    resource(resource) {
      lastForegroundCandidate = resource
      publishedForegroundUrls.push(resource.url)
      foregroundCandidates.push(resource)
      foregroundCandidateWaiters.shift()?.resolve(resource)
    },
    failure({ error }) {
      foregroundFailures.push(error)
      foregroundLifecycle.push('failure')
      foregroundFailureWaiters.shift()?.resolve(error)
    },
  })

  const identity = musicInfo => `${musicInfo.source}:${musicInfo.id}`
  return {
    async startForeground(musicInfo = song, reason = 'initial') {
      const resource = await coordinator.startForeground({ musicInfo, reason })
      if (resource.kind == 'candidate') lastForegroundCandidate = resource
      return resource
    },
    async startPreload(musicInfo = song) {
      const resource = await coordinator.startPreload(musicInfo)
      if (resource.kind == 'candidate') lastPreloadCandidate = resource
      preloadPhaseEvents.length = 0
      return resource
    },
    async promote(musicInfo = song) {
      const resource = await coordinator.promotePreload(identity(musicInfo))
      if (resource?.kind == 'candidate') lastForegroundCandidate = resource
      return resource
    },
    handleForegroundCanplay: resource => coordinator.handleForegroundCanplay(resource),
    handleForegroundError: resource => coordinator.handleForegroundError(resource),
    cancelForeground: reason => coordinator.cancelForeground(reason),
    cancelPreload: reason => coordinator.cancelPreload(reason),
    dispose: () => coordinator.dispose(),
    preloadCanplay: resource => emitPreloadFor(resource, 'canplay'),
    preloadError: resource => emitPreloadFor(resource, 'error'),
    queuePreloadEvent(name) {
      const audio = preloadAudios.at(-1)
      return () => audio?.emit(name) ?? 'stale'
    },
    currentCandidate: () => lastForegroundCandidate,
    currentPreloadCandidate: () => lastPreloadCandidate,
    waitForForegroundCandidate() {
      if (foregroundCandidates.length) return Promise.resolve(foregroundCandidates.shift())
      const gate = deferred()
      foregroundCandidateWaiters.push(gate)
      return gate.promise
    },
    waitForForegroundFailure() {
      if (foregroundFailures.length) return Promise.resolve(foregroundFailures[0])
      const gate = deferred()
      foregroundFailureWaiters.push(gate)
      return gate.promise
    },
    waitForPreloadPhase(phase) {
      const eventIndex = preloadPhaseEvents.indexOf(phase)
      if (eventIndex >= 0) {
        preloadPhaseEvents.splice(eventIndex, 1)
        return Promise.resolve()
      }
      const gate = deferred()
      preloadPhaseWaiters.push({ phase, gate })
      return gate.promise
    },
    releaseCandidate(number) {
      let gate = candidateGates.get(number)
      if (!gate) candidateGates.set(number, gate = deferred())
      gate.resolve()
    },
    changeFutureSourceIds(ids) {
      futureSourceIds = [...ids]
    },
    async flush() {
      await clock.flush()
      await new Promise(resolve => setImmediate(resolve))
      await clock.flush()
    },
    get session() { return getDefaultSession() },
    get createRequestCount() { return createRequestCount },
    get nextCandidateCount() { return nextCandidateCount },
    get sessionCreateCount() { return sessionCreateCount },
    get cacheCommitCount() { return cacheCommitCount },
    get releaseSourcesCount() { return releaseSourcesCount },
    sessionCancelReasons,
    publishedForegroundUrls,
    foregroundFailures,
    foregroundLifecycle,
    detachedForegroundUrls,
    deletedCacheKeys,
    requestedSourceIds,
    createdReasons,
    get preloadValidator() {
      return preloadAudios.at(-1) ?? { bound: false, detached: true, boundUrls: [] }
    },
    visibleErrorCount: 0,
  }
}

const loadPlayerIntegrationFactories = () => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const errorModule = loadTsModule(
    path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
  )
  const cacheModule = loadPlaybackCache()
  const candidatesModule = loadCandidates()
  const coordinatorModule = loadPlaybackCoordinator()
  const sessionModule = loadPlaybackSession()
  const identity = musicInfo => {
    const target = 'progress' in musicInfo ? musicInfo.metadata.musicInfo : musicInfo
    return `${target.source}:${target.id}`
  }
  const noop = () => {}
  const appSetting = {
    'player.autoSkipOnError': false,
    'player.togglePlayMethod': 'listLoop',
    'player.playQuality': 'flac',
  }
  const playerState = {
    isPlay: { value: false },
    playedList: [],
    playInfo: {},
    playMusicInfo: { musicInfo: onlineMusic, listId: null, isTempPlay: false },
    tempPlayList: [],
    musicInfo: { id: onlineMusic.id },
  }
  const playerActions = new Proxy({ setAllStatus: noop }, { get: target => target.setAllStatus })
  const playbackMocks = {
    getPlaybackSongIdentity: identity,
    playbackResolutionCoordinator: {},
  }
  const baseMocks = {
    '@common/utils': { log: { debug: noop, error: noop } },
    '@common/utils/vueTools': { onBeforeUnmount: noop, watch: noop },
    '@common/utils/playbackSourceError': errorModule,
    '@renderer/plugins/i18n': { useI18n: () => value => value },
    '@renderer/plugins/player': {},
    '@renderer/store/player/state': playerState,
    '@renderer/store/player/action': playerActions,
    '@renderer/store/player/playProgress': { playProgress: { nowPlayTime: 0, maxPlayTime: 0 } },
    '@renderer/store/setting': { appSetting },
    '@renderer/store/party': { party: {} },
    '@renderer/core/music/playback': playbackMocks,
    '@renderer/core/music/playback/coordinator': { getPlaybackSongIdentity: identity },
    '@renderer/core/music/playback/cache': {
      observePlaybackCachePersistence: cacheModule.observePlaybackCachePersistence,
      playbackUrlCache: {},
    },
    '@renderer/core/player': {},
    '@renderer/core/music': { getMusicUrl: async() => ({ url: '' }) },
    '../music/index': { getMusicUrl: async() => ({ url: '' }), getPicPath: async() => '', getLyricInfo: async() => ({}) },
    './utils': { filterList: async() => ({ filteredList: [], playerIndex: -1 }) },
    '@renderer/utils/message': { requestMsg: {} },
    '@renderer/utils/index': { getRandom: () => 0, toNewMusicInfo: value => value },
    '@renderer/store/list/action': { addListMusics: noop, removeListMusics: noop },
    '@renderer/store/list/state': { loveList: { id: 'love' } },
    '@renderer/core/dislikeList': { addDislikeInfo: async() => {} },
    '@renderer/utils/musicSdk': { default: { findMusic: async() => [] } },
    '@renderer/store/utils': { assertApiSupport: () => true },
  }
  const loadWithImportMeta = (relativePath, mocks = {}) => {
    const fs = require('node:fs')
    const Module = require('node:module')
    const babel = require('@babel/core')
    const { pathToFileURL } = require('node:url')
    const filename = path.join(__dirname, `../../${relativePath}`)
    const importMetaUrl = pathToFileURL(filename).href
    const { code } = babel.transformSync(fs.readFileSync(filename, 'utf8'), {
      babelrc: false,
      configFile: false,
      filename,
      presets: [[require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }]],
      plugins: [
        ({ types }) => ({
          visitor: {
            MetaProperty(metaPath) {
              metaPath.replaceWith(types.objectExpression([
                types.objectProperty(types.identifier('url'), types.stringLiteral(importMetaUrl)),
              ]))
            },
          },
        }),
        require.resolve('@babel/plugin-transform-modules-commonjs'),
      ],
    })
    const loadedModule = new Module(filename, module)
    loadedModule.filename = filename
    loadedModule.paths = Module._nodeModulePaths(path.dirname(filename))
    const originalLoad = Module._load
    Module._load = (request, parent, isMain) => Object.prototype.hasOwnProperty.call(mocks, request)
      ? mocks[request]
      : originalLoad(request, parent, isMain)
    try {
      loadedModule._compile(code, filename)
    } finally {
      Module._load = originalLoad
    }
    return loadedModule.exports
  }
  const load = (relativePath, mocks = {}) => loadTsModule(
    path.join(__dirname, `../../${relativePath}`),
    { ...baseMocks, ...mocks },
  )
  const playbackAdapter = {
    retainSources: noop,
    releaseSources: noop,
    async getCapabilities() { return { sources: {} } },
    async getMusicUrl() { throw new Error('not used') },
    async getLocalMusicUrl() { throw new Error('not used') },
  }
  const originalWindow = global.window
  global.window = {
    ...(originalWindow ?? {}),
    setTimeout,
    clearTimeout,
  }
  let playback
  let playbackCoordinatorDeps
  try {
    playback = load('src/renderer/core/music/playback/index.ts', {
      '@common/utils': { encodePath: value => value, log: { debug: noop, error: noop } },
      '@renderer/store/setting': {
        appSetting: {
          ...appSetting,
          'common.apiSource': 'primary',
          'common.apiFallbackSources': ['fallback'],
        },
      },
      '@renderer/store/download/utils': { buildSavePath: () => '' },
      '@renderer/plugins/player': { clearResourceIf: noop },
      '@renderer/utils/music': {
        getDownloadFilePath: async() => null,
        getLocalFilePath: async() => null,
      },
      '../webdav': { getMusicUrl: async() => '' },
      './cache': { ...cacheModule, playbackUrlCache: {} },
      './candidates': candidatesModule,
      './coordinator': {
        ...coordinatorModule,
        createPlaybackResolutionCoordinator: deps => {
          playbackCoordinatorDeps = deps
          return {}
        },
      },
      './session': sessionModule,
      './sourceAdapter': { playbackSourceAdapter: playbackAdapter },
    })
  } finally {
    global.window = originalWindow
  }
  return {
    player: loadWithImportMeta('src/renderer/plugins/player/index.ts', baseMocks),
    media: load('src/renderer/core/useApp/usePlayer/usePlayerEvent.ts'),
    play: load('src/renderer/core/useApp/usePlayer/usePlayEvent.ts'),
    action: load('src/renderer/core/player/action.ts'),
    preload: load('src/renderer/core/useApp/usePlayer/usePreloadNextMusic.ts'),
    playback,
    coordinator: coordinatorModule,
    cache: cacheModule,
    error: errorModule,
    identity,
    createProductionPreloadAudio: () => playbackCoordinatorDeps.createPreloadAudio(),
  }
}

const createPlaybackPreloadAudioHarness = () => {
  const factories = loadPlayerIntegrationFactories()
  const originalAudio = global.Audio
  class FakeAudio {
    constructor() {
      this.muted = false
      this.preload = ''
      this.crossOrigin = null
    }
  }
  global.Audio = FakeAudio
  try {
    return factories.createProductionPreloadAudio()
  } finally {
    global.Audio = originalAudio
  }
}

const requireProductionFactory = (module, name) => {
  if (typeof module[name] != 'function') throw new Error(`Missing production factory: ${name}`)
  return module[name]
}

class FakePlayerAudio {
  constructor(operations, currentTimeWrites) {
    this.operations = operations
    this.currentTimeWrites = currentTimeWrites
    this.listeners = new Map()
    this.bindings = []
    this.latestBinding = null
    this._src = ''
    this._currentSrc = ''
    this._autoplay = true
    this._currentTime = 0
    this.error = null
    this.controls = false
    this.preload = 'auto'
    this.crossOrigin = 'anonymous'
  }

  addEventListener(name, handler) {
    let listeners = this.listeners.get(name)
    if (!listeners) this.listeners.set(name, listeners = new Set())
    listeners.add(handler)
  }

  removeEventListener(name, handler) {
    this.listeners.get(name)?.delete(handler)
  }

  set autoplay(value) {
    this._autoplay = value
    this.operations.push(`autoplay:${value}`)
  }

  get autoplay() { return this._autoplay }

  set src(value) {
    this._src = value
    this._currentSrc = value
    this.operations.push(`src:${value}`)
    const binding = {
      context: null,
      listeners: new Map(
        [...this.listeners].map(([name, listeners]) => [name, [...listeners]]),
      ),
    }
    this.bindings.push(binding)
    this.latestBinding = binding
  }

  get src() { return this._src }
  get currentSrc() { return this._currentSrc }

  set currentTime(value) {
    this._currentTime = value
    this.currentTimeWrites.push(value)
  }

  get currentTime() { return this._currentTime }

  play() {
    this.operations.push('play')
    return Promise.resolve()
  }

  pause() { this.operations.push('pause') }

  removeAttribute(name) {
    if (name == 'src') {
      this._src = ''
      this._currentSrc = ''
    }
  }

  load() {}

  attachContext(context) {
    if (this.latestBinding) this.latestBinding.context = context
  }

  emitFor(context, name, code) {
    const binding = this.bindings.find(item => item.context?.resourceGeneration == context.resourceGeneration)
    if (!binding) return
    if (code !== undefined) this.error = { code }
    this._currentSrc = context.url
    for (const listener of binding.listeners.get(name) ?? []) listener()
  }
}

class FakeCoordinatorPreloadAudio {
  constructor(onBind) {
    this.listeners = new Map()
    this.bindings = new Map()
    this.onBind = onBind
    this._src = ''
    this.muted = false
    this.preload = 'auto'
  }

  addEventListener(name, handler) { this.listeners.set(name, handler) }
  removeEventListener(name, handler) {
    if (this.listeners.get(name) == handler) this.listeners.delete(name)
  }
  pause() {}
  load() {}
  removeAttribute(name) { if (name == 'src') this._src = '' }
  set src(value) {
    this._src = value
    this.bindings.set(value, {
      canplay: this.listeners.get('canplay'),
      error: this.listeners.get('error'),
    })
    this.onBind?.(value)
  }
  get src() { return this._src }
  emitFor(resource, name) { return this.bindings.get(resource.url)?.[name]?.() ?? 'stale' }
}

const createPlayerHarness = (options = {}) => {
  const factories = loadPlayerIntegrationFactories()
  const createPlayerResourceController = requireProductionFactory(factories.player, 'createPlayerResourceController')
  const createPlayerMediaEventHandlers = requireProductionFactory(factories.media, 'createPlayerMediaEventHandlers')
  const createValidationAwarePlayEventHandlers = requireProductionFactory(factories.play, 'createValidationAwarePlayEventHandlers')
  const createPlaybackActionController = requireProductionFactory(factories.action, 'createPlaybackActionController')
  const createNextMusicPreloadController = requireProductionFactory(factories.preload, 'createNextMusicPreloadController')
  const clock = options.clock ?? createFakeClock(0)
  const audioOperations = []
  const currentTimeWrites = []
  const setResourceUrls = []
  const dispatchedResourceKinds = []
  const playerMediaEvents = []
  const committedCacheKeys = []
  const tombstonedKeys = []
  const refreshRequests = []
  const refreshedApiIds = []
  const postCommitCacheHits = []
  const invalidatedQualities = []
  const invalidatedCacheKeys = []
  const preloadLoadingTransitions = []
  const boundContexts = []
  const boundWaiters = []
  const candidateMetadata = new Map()
  const deferredForegroundCalls = []
  const queuedSessionUrls = []
  const sessionCreationGates = []
  const sessionFactorySnapshots = []
  let currentMusicInfo = onlineMusic
  let playedStop = false
  let createRequestCount = 0
  let sessionCreateCount = 0
  let cacheCommitCount = 0
  let persistenceErrorCount = 0
  let visibleErrorCount = 0
  let finalResolutionFailureCount = 0
  let coordinatorMediaErrors = 0
  let legacyRefreshCalls = 0
  let playerErrorEvents = 0
  let playerCanplayEvents = 0
  let playerLoadeddataEvents = 0
  let autoSkipCalls = 0
  let loadingWatchdogCount = 0
  let preloadFailureRecords = 0
  let coordinatorDisposeCount = 0
  let sessionOrdinal = 0
  let candidateOrdinal = 0

  const mainAudio = new FakePlayerAudio(audioOperations, currentTimeWrites)
  const preloadAudio = new FakeCoordinatorPreloadAudio()
  const baseResource = createPlayerResourceController({
    audio: mainAudio,
    canonicalizeUrl: value => value,
  })
  const resource = {
    ...baseResource,
    setResource(url, input) {
      const context = baseResource.setResource(url, input)
      mainAudio.attachContext(context)
      setResourceUrls.push(url)
      dispatchedResourceKinds.push(context.kind)
      boundContexts.push(context)
      const waiterIndex = boundWaiters.findIndex(waiter => waiter.url == url)
      if (waiterIndex >= 0) boundWaiters.splice(waiterIndex, 1)[0].gate.resolve(context)
      return context
    },
    replaceResourceContext(expected, replacement) {
      const replaced = baseResource.replaceResourceContext(expected, replacement)
      if (replaced) dispatchedResourceKinds.push(replacement.kind)
      return replaced
    },
  }

  const reportPersistenceFailure = () => {
    persistenceErrorCount++
    if (options.throwPersistenceReporter) throw new Error('reporter failed')
  }
  const realPlayerCache = factories.cache.createPlaybackUrlCache({
    async read() { return null },
    async save() {
      if (options.rejectCacheSave) {
        throw Object.assign(new Error('save failed'), { code: 'SQLITE_BUSY' })
      }
    },
    async remove(key) {
      invalidatedCacheKeys.push(structuredClone(key))
      invalidatedQualities.push(key.quality)
      if (options.rejectCacheDelete) {
        throw Object.assign(new Error('delete failed'), { code: 'SQLITE_BUSY' })
      }
    },
  })
  const playerCache = {
    ...realPlayerCache,
    commit(key, url) {
      cacheCommitCount++
      committedCacheKeys.push(structuredClone(key))
      return realPlayerCache.commit(key, url)
    },
    tombstoneKey(key) {
      tombstonedKeys.push(key)
      return realPlayerCache.tombstoneKey(key)
    },
  }
  const observePersistence = (promise, operation) => factories.cache.observePlaybackCachePersistence(
    promise,
    operation,
    reportPersistenceFailure,
  )
  const makeSession = input => {
    sessionCreateCount++
    const id = `player-session-${++sessionOrdinal}`
    const identity = factories.identity(input.musicInfo)
    const configuredUrls = queuedSessionUrls.shift() ?? options.sourceUrls ?? [
      options.winner ? `https://${options.winner}` : `https://${input.sourceIds[0]}`,
    ]
    const urls = [...configuredUrls]
    let index = 0
    let activeCandidate = null
    let state = 'active'
    let rejected = false
    let cacheLookupDone = input.cacheMode != 'lookup'
    const expire = () => {
      activeCandidate = null
      index++
      return 'expired'
    }
    return {
      id,
      songIdentity: identity,
      sourceIds: Object.freeze([...input.sourceIds]),
      async nextCandidate() {
        if (state != 'active') throw playbackError('session', 'cancelled')
        if (!cacheLookupDone) {
          cacheLookupDone = true
          await input.cache.lookup(musicUrlKey(input.musicInfo, input.requestedQuality))
        }
        if (options.allSourcesFail || options.allPreloadSourcesFail) {
          state = 'failed'
          throw playbackError('source', 'request', input.sourceIds[0])
        }
        if (rejected && index >= urls.length && options.exhaustAfterMediaError) {
          state = 'failed'
          throw playbackError('session', 'request')
        }
        const url = urls[index] ?? `https://fallback-${id}-${index}`
        const quality = options.winnerQuality ?? '128k'
        const apiId = options.winner ?? input.sourceIds[Math.min(index, input.sourceIds.length - 1)]
        const candidateMusicInfo = options.winnerMusicInfo ?? (
          options.winnerPlatform == 'tx' ? matchedTx : input.musicInfo
        )
        activeCandidate = {
          sessionId: id,
          candidateId: `${id}:candidate:${++candidateOrdinal}`,
          songIdentity: identity,
          origin: 'source',
          apiId,
          ...(options.winnerPlatform ? { platform: options.winnerPlatform } : {}),
          quality,
          url,
          cacheKey: musicUrlKey(candidateMusicInfo, quality),
          deadlineAt: clock.now() + 10_000,
        }
        candidateMetadata.set(url, activeCandidate)
        return activeCandidate
      },
      accept(candidateId) {
        if (state != 'active' || activeCandidate?.candidateId != candidateId) return 'stale'
        if (clock.now() >= activeCandidate.deadlineAt) return expire()
        state = 'accepted'
        let committing
        try {
          committing = input.cache.commit(activeCandidate.cacheKey, activeCandidate.url)
        } catch (error) {
          committing = Promise.reject(error)
        }
        void observePersistence(committing, 'commit')
        activeCandidate = null
        return 'accepted'
      },
      rejectMedia(candidateId) {
        if (state != 'active' || activeCandidate?.candidateId != candidateId) return 'stale'
        if (clock.now() >= activeCandidate.deadlineAt) return expire()
        activeCandidate = null
        rejected = true
        index++
        return 'resumed'
      },
      expireCandidate(candidateId) {
        if (state != 'active' || activeCandidate?.candidateId != candidateId) return 'stale'
        return expire()
      },
      cancel() {
        if (state == 'active') state = 'cancelled'
        activeCandidate = null
      },
    }
  }

  const sessionFactories = factories.playback.createPlaybackSessionFactories({
    readSettings: () => ({
      primaryId: options.primary ?? 'primary',
      fallbackIds: [...(options.fallbacks ?? ['fallback'])],
      requestedQuality: 'flac',
    }),
    cache: playerCache,
    adapter: {
      retainSources() {},
      releaseSources() {},
      async getCapabilities() { return { sources: {} } },
      async authorizeMusicUrl({ musicInfo, quality }) { return musicUrlKey(musicInfo, quality) },
      async getMusicUrl() { throw new Error('not used') },
      async getLocalMusicUrl() { throw new Error('not used') },
    },
    clock,
    createId: () => `player-session-factory-${sessionCreateCount + 1}`,
    diagnostics: { record() {} },
    reportPersistenceFailure,
    createResolveSession(input) {
      sessionFactorySnapshots.push({
        sourceIds: [...input.sourceIds],
        requestedQuality: input.requestedQuality,
        cacheMode: input.cacheMode,
      })
      if (input.cacheMode == 'bypass') refreshedApiIds.push(input.sourceIds[0])
      const session = makeSession(input)
      const gate = sessionCreationGates.find(item => !item.used)
      if (!gate) return session
      gate.used = true
      return gate.promise.then(() => session)
    },
    createOnlineCandidateProvider: musicInfo => ({ musicInfo }),
    createLocalCandidateProvider: musicInfo => ({ musicInfo }),
  })
  const facade = factories.playback.createPlaybackMusicFacade({
    getDownloadFilePath: async() => null,
    buildSavePath: () => '',
    getLocalFilePath: async musicInfo => musicInfo.source == 'local'
      ? options.directPreloadUrl ?? null
      : null,
    encodePath: value => value,
    getWebDAVMusicUrl: async() => 'https://webdav/song.mp3',
    ...sessionFactories,
  })
  const createRequest = async input => {
    createRequestCount++
    if (input.reason != 'initial' && input.reason != 'preload') refreshRequests.push({ reason: input.reason })
    if (options.deferredForeground && input.reason != 'preload') {
      const call = deferredForegroundCalls.find(item => !item.used)
      if (!call) throw new Error('No deferred foreground call was prepared')
      call.used = true
      return call.gate.promise
    }
    return facade.createPlaybackRequest(input)
  }
  const realCoordinator = factories.coordinator.createPlaybackResolutionCoordinator({
    createRequest,
    createPreloadAudio: () => preloadAudio,
    detachForegroundResource: expected => resource.clearResourceIf(expected),
    clock,
  })
  const coordinator = {
    ...realCoordinator,
    setForegroundHandlers(handlers) {
      realCoordinator.setForegroundHandlers({
        resource: handlers.resource,
        failure(input) {
          finalResolutionFailureCount++
          handlers.failure(input)
        },
      })
    },
    handleForegroundError(candidate) {
      const before = realCoordinator.isForegroundValidating()
      const result = realCoordinator.handleForegroundError(candidate)
      if (before && result != 'stale') coordinatorMediaErrors++
      return result
    },
    dispose() {
      coordinatorDisposeCount++
      realCoordinator.dispose()
    },
  }
  const action = createPlaybackActionController({
    coordinator,
    resource,
    getCurrentMusicInfo: () => currentMusicInfo,
    isPlayedStop: () => playedStop,
    autoSkipOnError: () => options.autoSkip ?? false,
    setAllStatus() {},
    emitVisibleError: () => { visibleErrorCount++ },
    scheduleAutoSkip: () => { autoSkipCalls++ },
    clearLoadTimeout() {},
  })
  const pendingRefreshes = []
  const playHandlers = createValidationAwarePlayEventHandlers({
    coordinator,
    isPlayedStop: () => playedStop,
    currentMusicId: () => currentMusicInfo?.id ?? '',
    currentMusicInfo: () => currentMusicInfo,
    autoSkipOnError: () => options.autoSkip ?? false,
    isDocumentHidden: () => false,
    isPlayerEmpty: () => resource.getResourceContext() == null,
    setStop: () => resource.setStop(),
    setMusicUrl(info, input) {
      legacyRefreshCalls++
      const pending = action.setMusicUrl(info, input)
      pendingRefreshes.push(pending)
      void pending.catch(() => {})
    },
    playNext: async() => { autoSkipCalls++ },
    setAllStatus() {},
    translate: key => key,
    clock: {
      ...clock,
      setTimeout(handler, delay) {
        if (delay == 25_000) loadingWatchdogCount++
        return clock.setTimeout(handler, delay)
      },
    },
  })
  const appEvent = {
    error() { visibleErrorCount++ },
    playerError(code) { playerErrorEvents++; playHandlers.error(code) },
    playerCanplay() { playerCanplayEvents++; playerMediaEvents.push('canplay') },
    playerLoadstart() { playHandlers.loadstart() },
    playerLoadeddata() { playerLoadeddataEvents++; playerMediaEvents.push('loadeddata'); playHandlers.loadeddata() },
    playerWaiting() { playHandlers.waiting() },
  }
  const mediaHandlers = createPlayerMediaEventHandlers({
    resource,
    coordinator,
    cache: playerCache,
    getErrorCode: () => mainAudio.error?.code,
    setLoadedMusicIdentity: identity => action.setLoadedMusicIdentity(identity),
    appEvent,
    reportPersistenceFailure,
  })
  resource.onCanplay(mediaHandlers.canplay)
  resource.onError(mediaHandlers.error)
  resource.onLoadstart(mediaHandlers.loadstart)
  resource.onLoadeddata(mediaHandlers.loadeddata)
  resource.onWaiting(mediaHandlers.waiting)
  const preloadController = createNextMusicPreloadController({
    coordinator,
    setLoading: value => preloadLoadingTransitions.push(value),
    recordFailure: () => { preloadFailureRecords++ },
  })

  const bindResource = (playbackResource, input = {}) => resource.setResource(playbackResource.url, {
    startTime: input.startTime ?? 0,
    shouldPlay: input.shouldPlay ?? true,
    resource: playbackResource,
  })
  const setMusicUrl = async(info, input = {}) => {
    currentMusicInfo = info
    playedStop = false
    await action.setMusicUrl(info, input)
  }
  const waitForBoundCandidate = url => {
    const found = [...boundContexts].reverse().find(context => context.url == url)
    if (found) return Promise.resolve(found)
    const gate = deferred()
    boundWaiters.push({ url, gate })
    return gate.promise
  }
  const flush = async() => {
    for (const gate of sessionCreationGates.splice(0)) gate.resolve()
    await clock.flush()
    for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve))
    await clock.flush()
  }

  return {
    bindCandidate: async url => {
      queuedSessionUrls.push(options.sourceUrls ?? [url])
      await setMusicUrl(onlineMusic, { reason: 'initial' })
      return resource.getResourceContext()
    },
    bindResource,
    async start() {
      await setMusicUrl(onlineMusic, { reason: 'initial' })
      return resource.getResourceContext()
    },
    forceRefresh: () => setMusicUrl(onlineMusic, { reason: 'forceRefresh' }),
    setMusicUrl,
    cancelPlayback(reason) { action.cancel(reason) },
    disposePlayback() { action.dispose() },
    emitCanplay(listener) { mainAudio.emitFor(listener, 'canplay') },
    emitLoadeddata(listener) { mainAudio.emitFor(listener, 'loadeddata') },
    async emitError(listener, code) {
      if (resource.getResourceContext()?.kind == 'validated') {
        sessionCreationGates.push({ ...deferred(), used: false })
      }
      mainAudio.emitFor(listener, 'error', code)
    },
    emitLoadedmetadata(listener) { mainAudio.emitFor(listener, 'loadedmetadata') },
    rejectCurrentCandidate() {
      const current = resource.getResourceContext()
      if (current?.kind == 'candidate') coordinator.handleForegroundError(current)
    },
    waitForBoundCandidate,
    currentResource: () => resource.getResourceContext(),
    isValidating: () => coordinator.isForegroundValidating(),
    async startDirectPreload(info) { return realCoordinator.startPreload(info) },
    async promotePreloadToPlayer(info) {
      await setMusicUrl(info, { reason: 'initial' })
      return resource.getResourceContext()
    },
    emitPreloadCanplay(listener) { return preloadAudio.emitFor(listener, 'canplay') },
    deferNextForeground() {
      const gate = deferred()
      const call = deferredForegroundCalls.length
      deferredForegroundCalls.push({ gate, used: false })
      return call
    },
    resolveForeground(call, playbackResource) {
      deferredForegroundCalls[call].gate.resolve({ kind: 'direct', resource: playbackResource })
    },
    rejectForeground(call, error) { deferredForegroundCalls[call].gate.reject(error) },
    preloadNext: info => preloadController.start(info),
    flush,
    get coordinatorMediaErrors() { return coordinatorMediaErrors },
    get legacyRefreshCalls() { return legacyRefreshCalls },
    get playerErrorEvents() { return playerErrorEvents },
    get playerCanplayEvents() { return playerCanplayEvents },
    get playerLoadeddataEvents() { return playerLoadeddataEvents },
    get autoSkipCalls() { return autoSkipCalls },
    get loadingWatchdogCount() { return loadingWatchdogCount },
    get cacheCommitCount() { return cacheCommitCount },
    committedCacheKeys,
    dispatchedResourceKinds,
    tombstonedKeys,
    refreshRequests,
    refreshedApiIds,
    postCommitCacheHits,
    invalidatedQualities,
    invalidatedCacheKeys,
    sessionFactorySnapshots,
    get loadedMusicIdentity() { return action.getLoadedMusicIdentity() },
    get createRequestCount() { return createRequestCount },
    get persistenceErrorCount() { return persistenceErrorCount },
    get visibleErrorCount() { return visibleErrorCount },
    get finalResolutionFailureCount() { return finalResolutionFailureCount },
    get sessionCreateCount() { return sessionCreateCount },
    setResourceUrls,
    preloadLoadingTransitions,
    get preloadFailureRecords() { return preloadFailureRecords },
    get coordinatorDisposeCount() { return coordinatorDisposeCount },
    audioOperations,
    currentTimeWrites,
    playerMediaEvents,
  }
}

const createPreloadSchedulingHarness = () => {
  const factories = loadPlayerIntegrationFactories()
  const createNextMusicPreloadController = requireProductionFactory(factories.preload, 'createNextMusicPreloadController')
  const createNextMusicPreloadScheduler = requireProductionFactory(factories.preload, 'createNextMusicPreloadScheduler')
  const selections = []
  const selectionWaiters = []
  const coordinatorStartIdentities = []
  const coordinatorCancelReasons = []
  let selectorCallCount = 0
  let selectionFailureCount = 0
  let unhandledRejectionCount = 0
  const handleUnhandled = () => { unhandledRejectionCount++ }
  process.on('unhandledRejection', handleUnhandled)
  const coordinator = {
    async startPreload(info) {
      coordinatorStartIdentities.push(factories.identity(info))
      return { kind: 'direct', songIdentity: factories.identity(info), url: 'file:///preload.mp3' }
    },
    cancelPreload(reason) { coordinatorCancelReasons.push(reason) },
  }
  const controller = createNextMusicPreloadController({
    coordinator,
    setLoading() {},
    recordFailure() {},
  })
  const scheduler = createNextMusicPreloadScheduler({
    selectNext() {
      const occurrence = ++selectorCallCount
      const gate = deferred()
      selections[occurrence] = gate
      selectionWaiters[occurrence]?.resolve()
      return gate.promise
    },
    controller,
    resetRandomNextMusicInfo() {},
    getCurrentProgress: () => 0,
    recordSelectionFailure: () => { selectionFailureCount++ },
  })
  return {
    tick: (time, duration) => scheduler.tick(time, duration),
    setProgress: time => scheduler.setProgress(time),
    musicToggled: () => scheduler.musicToggled(),
    toggleModeChanged: () => scheduler.toggleModeChanged(),
    waitForSelection(occurrence) {
      if (selections[occurrence]) return Promise.resolve()
      const gate = deferred()
      selectionWaiters[occurrence] = gate
      return gate.promise
    },
    resolveSelection(occurrence, info) {
      selections[occurrence].resolve(info ? { musicInfo: info, listId: null, isTempPlay: false } : null)
    },
    rejectSelection(occurrence) { selections[occurrence].reject(new Error('selection failed')) },
    startControllerAfterDispose: info => controller.start(info),
    dispose() { scheduler.dispose() },
    async flush() {
      for (let index = 0; index < 4; index++) await new Promise(resolve => setImmediate(resolve))
    },
    get selectorCallCount() { return selectorCallCount },
    coordinatorStartIdentities,
    coordinatorCancelReasons,
    get selectionFailureCount() { return selectionFailureCount },
    get unhandledRejectionCount() { return unhandledRejectionCount },
  }
}

let integrationFactoryCache
const loadIntegrationFactories = () => {
  if (integrationFactoryCache) return integrationFactoryCache
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const runtimeError = loadTsModule(
    path.join(__dirname, '../../src/main/modules/userApi/runtimeError.ts'),
  )
  const runtimeWindow = loadTsModule(
    path.join(__dirname, '../../src/main/modules/userApi/runtimeWindow.ts'),
    {
      electron: { BrowserWindow: class {}, session: { fromPartition() {} } },
      '@common/mainIpc': { mainSend() {} },
      '@common/projectIdentity': { PROJECT_IDENTITY: { userApiPartition: 'starky-lx-user-api' } },
      '@common/utils': { log: { error() {} } },
      './main': { getProxy: () => ({ host: '127.0.0.1', port: '1080' }) },
      './utils': { getScript: async id => `script:${id}` },
    },
  )
  const runtimePool = loadTsModule(
    path.join(__dirname, '../../src/main/modules/userApi/runtimePool.ts'),
    {
      './runtimeWindow': runtimeWindow,
      './runtimeError': runtimeError,
      './rendererEvent/name': {
        initEnv: 'userApi_initEnv',
        request: 'userApi_request',
        proxyUpdate: 'userApi_proxyUpdate',
      },
    },
  )
  integrationFactoryCache = {
    player: loadPlayerIntegrationFactories(),
    sourceAdapter: loadPlaybackSourceAdapter(),
    candidates: loadCandidates(),
    runtimePool,
    runtimeWindow,
    sourceSetting: loadTsModule(
      path.join(__dirname, '../../src/common/utils/playbackSourceSetting.ts'),
    ),
  }
  return integrationFactoryCache
}

const createIntegrationObserver = () => {
  const values = []
  const waiters = []
  const find = (predicate, occurrence) => values.filter(predicate)[occurrence - 1]
  return {
    values,
    emit(value) {
      values.push(value)
      for (let index = waiters.length - 1; index >= 0; index--) {
        const waiter = waiters[index]
        const found = find(waiter.predicate, waiter.occurrence)
        if (found === undefined) continue
        waiters.splice(index, 1)
        waiter.resolve(found)
      }
    },
    wait(predicate, occurrence = 1) {
      const found = find(predicate, occurrence)
      if (found !== undefined) return Promise.resolve(found)
      return new Promise(resolve => { waiters.push({ predicate, occurrence, resolve }) })
    },
  }
}

const createIntegrationHarness = (options = {}) => {
  const factories = loadIntegrationFactories()
  const clock = createFakeClock(0)
  const sourceIds = [...(options.sourceIds ?? ['primary', 'fallback'])]
  const settings = {
    'common.apiSource': sourceIds[0],
    'common.apiFallbackSources': sourceIds.slice(1),
    'common.apiFallbackMode': 'serial',
    'player.playQuality': options.requestedQuality ?? 'flac',
  }
  const registry = new Map()
  const ensureRegistryEntry = apiId => {
    if (!registry.has(apiId)) {
      registry.set(apiId, {
        id: apiId,
        name: apiId,
        description: '',
        allowShowUpdateAlert: false,
        sources: {},
      })
    }
  }
  for (const apiId of sourceIds) ensureRegistryEntry(apiId)

  const sourceOrder = []
  const adapterRequestOrder = []
  const cancelledRequests = []
  const foregroundBoundUrls = []
  const preloadBoundUrls = []
  const sessionSourceSnapshots = []
  const sessionQualitySnapshots = []
  const invalidatedQualities = []
  const invalidatedCacheKeys = []
  const requestObserver = createIntegrationObserver()
  const initializationObserver = createIntegrationObserver()
  const foregroundObserver = createIntegrationObserver()
  const preloadObserver = createIntegrationObserver()
  const cacheInvalidationObserver = createIntegrationObserver()
  const requestMetadata = new WeakMap()
  const runtimesByApiId = new Map()
  const urlIdentities = new Map()
  const runtimeSessions = new Map()
  const proxyListeners = new Set()
  const durableCache = new Map()
  let authorizationCallCount = 0
  let persistentReadCount = 0
  let persistentWriteCount = 0
  const cacheInvalidationGate = deferred()
  let pool
  let currentMusicInfo = onlineMusic
  let playedStop = false
  let visibleErrorCount = 0
  let autoSkipCalls = 0
  let sessionCreateCount = 0
  let nextId = 0
  let playHandlers
  const audioOperations = []
  const currentTimeWrites = []
  const mainAudio = new FakePlayerAudio(audioOperations, currentTimeWrites)
  const preloadAudio = new FakeCoordinatorPreloadAudio(url => {
    const songIdentity = urlIdentities.get(url)
    if (!songIdentity) return
    const binding = { songIdentity, url }
    preloadBoundUrls.push(url)
    preloadObserver.emit(binding)
  })

  const createEventTarget = () => {
    const listeners = new Map()
    return {
      on(name, listener) {
        let entries = listeners.get(name)
        if (!entries) listeners.set(name, entries = new Set())
        entries.add(listener)
      },
      removeListener(name, listener) { listeners.get(name)?.delete(listener) },
      emit(name, ...args) {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
      },
    }
  }
  let nextWebContentsId = 100
  class FakeIntegrationWindow {
    constructor(windowOptions) {
      this.destroyed = false
      this.events = createEventTarget()
      this.webContents = {
        id: ++nextWebContentsId,
        ...createEventTarget(),
        session: windowOptions.webPreferences.session,
        setWindowOpenHandler() {},
      }
    }

    on(name, listener) { this.events.on(name, listener) }
    removeListener(name, listener) { this.events.removeListener(name, listener) }
    async loadURL() {}
    isDestroyed() { return this.destroyed }
    destroy() {
      if (this.destroyed) return
      this.destroyed = true
      this.events.emit('closed')
    }
  }
  const getRuntimeSession = partition => {
    let session = runtimeSessions.get(partition)
    if (session) return session
    session = {
      async clearAuthCache() {},
      async clearStorageData() {},
      async clearCache() {},
      async clearCodeCaches() {},
      setPermissionRequestHandler(handler) { this.permissionHandler = handler },
    }
    runtimeSessions.set(partition, session)
    return session
  }
  const capabilities = {
    wy: { actions: ['musicUrl'], qualitys: ['flac', '320k', '128k'] },
    tx: { actions: ['musicUrl'], qualitys: ['flac', '320k', '128k'] },
    kg: { actions: ['musicUrl'], qualitys: ['flac', '320k', '128k'] },
    local: { actions: ['musicUrl'], qualitys: ['128k'] },
  }
  const settleInitialization = (entry, status, message) => {
    if (!entry || entry.settled) return false
    const accepted = pool.acceptInit(entry.runtime.webContentsId, {
      identity: entry.envelope.identity,
      status,
      ...(status
        ? { data: { sources: capabilities } }
        : { message, data: { sources: {} } }),
    })
    if (accepted) entry.settled = true
    return accepted
  }
  const runtimeWindowDeps = {
    createWindow: windowOptions => new FakeIntegrationWindow(windowOptions),
    fromPartition: getRuntimeSession,
    readRuntimeHtml: async() => '<html></html>',
    getScript: async apiId => `script:${apiId}`,
    getProxy: () => ({ host: '127.0.0.1', port: '1080' }),
    send(runtime, name, payload) {
      if (runtime.window.isDestroyed()) return false
      if (name == 'userApi_initEnv') {
        const entry = { apiId: payload.identity.apiId, generation: payload.identity.generation, runtime, envelope: payload, settled: false }
        initializationObserver.emit(entry)
        if (options.autoInitialize !== false) queueMicrotask(() => settleInitialization(entry, true))
      } else if (name == 'userApi_request') {
        const musicInfo = payload.data.info.musicInfo
        const token = Object.freeze({
          apiId: payload.apiId,
          requestId: payload.requestId,
          songIdentity: `${musicInfo.source}:${musicInfo.songmid}`,
          platform: payload.data.source,
        })
        adapterRequestOrder.push(`${token.apiId}:${token.platform}`)
        requestMetadata.set(token, { runtime, payload })
        requestObserver.emit(token)
      }
      return true
    },
    logError() {},
    sessionRegistry: {
      register() { return { ready: Promise.resolve(), unregister() {} } },
    },
  }
  const poolDeps = {
    async createRuntimeWindow(input) {
      const runtime = await factories.runtimeWindow.createRuntimeWindow({ ...input, deps: runtimeWindowDeps })
      runtimesByApiId.set(input.apiInfo.id, runtime)
      return runtime
    },
    initializeRuntimeWindow: (runtime, apiInfo) => factories.runtimeWindow.initializeRuntimeWindow(runtime, apiInfo, runtimeWindowDeps),
    disposeRuntimeWindow: (runtime, input) => factories.runtimeWindow.disposeRuntimeWindow(runtime, input, runtimeWindowDeps),
    clearRuntimeSession: apiId => factories.runtimeWindow.clearRuntimeSession(apiId, runtimeWindowDeps),
    getApiInfo: apiId => registry.get(apiId),
    send: runtimeWindowDeps.send,
    onProxyUpdate(handler) {
      proxyListeners.add(handler)
      return () => { proxyListeners.delete(handler) }
    },
    getProxy: runtimeWindowDeps.getProxy,
    openDevTools() {},
    showUpdateAlert() {},
    publishStatus() {},
    initialConfiguredApiIds: new Set(sourceIds),
    logError() {},
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }
  pool = factories.runtimePool.createUserApiRuntimePool(poolDeps)

  const adapter = factories.sourceAdapter.createPlaybackSourceAdapter({
    isCustomApi: apiId => registry.has(apiId),
    async ensureUserApi(apiId) {
      if (!sourceOrder.includes(apiId)) sourceOrder.push(apiId)
      try {
        const apiInfo = await pool.ensure(apiId)
        return { ok: true, value: { apiId, status: true, apiInfo } }
      } catch (error) {
        return { ok: false, error }
      }
    },
    requestUserApi: params => pool.request(params, 1),
    cancelUserApi(params) {
      cancelledRequests.push(structuredClone(params))
      pool.cancel(params, 1)
    },
    acquireRuntime: params => pool.acquireLease(params, 1),
    releaseRuntime: params => { void pool.releaseLease(params, 1) },
    getBuiltinCapabilities: () => undefined,
    getBuiltinApi() { throw new Error('integration sources are custom') },
    getMusicUrlCacheKey: async() => {
      authorizationCallCount++
      throw new Error('custom playback must not request provider authorization')
    },
    serverBusyMessages: new Set(),
  })
  const cache = factories.player.cache.createPlaybackUrlCache({
    read: async key => {
      persistentReadCount++
      return durableCache.get(musicUrlKeyLabel(key)) ?? null
    },
    save: async(key, url) => {
      persistentWriteCount++
      durableCache.set(musicUrlKeyLabel(key), url)
    },
    remove: async key => {
      invalidatedCacheKeys.push(key)
      invalidatedQualities.push(key.slice(key.lastIndexOf('_') + 1))
      cacheInvalidationObserver.emit(key)
      if (options.holdCacheInvalidation) await cacheInvalidationGate.promise
      durableCache.delete(key)
    },
  })
  const observedCreateResolveSession = input => {
    sessionCreateCount++
    sessionSourceSnapshots.push([...input.sourceIds])
    sessionQualitySnapshots.push(input.requestedQuality)
    return factories.player.playback.createPlaybackResolveSession(input)
  }
  const sessionFactories = factories.player.playback.createPlaybackSessionFactories({
    readSettings: () => ({
      primaryId: settings['common.apiSource'],
      fallbackIds: [...settings['common.apiFallbackSources']],
      requestedQuality: settings['player.playQuality'],
    }),
    cache,
    adapter,
    clock,
    createId: () => `integration-${++nextId}`,
    diagnostics: { record() {} },
    reportPersistenceFailure() {},
    createResolveSession: observedCreateResolveSession,
    createOnlineCandidateProvider: info => factories.candidates.createOnlineCandidateProvider(
      info,
      async() => [...(options.matchedCandidates ?? [])],
    ),
    createLocalCandidateProvider: info => factories.candidates.createLocalCandidateProvider(
      info,
      async() => [...(options.matchedCandidates ?? [])],
    ),
  })
  const facade = factories.player.playback.createPlaybackMusicFacade({
    getDownloadFilePath: async() => null,
    buildSavePath: () => '',
    getLocalFilePath: async() => null,
    encodePath: value => value,
    getWebDAVMusicUrl: async() => 'https://webdav/song.mp3',
    ...sessionFactories,
  })

  const baseResource = factories.player.player.createPlayerResourceController({
    audio: mainAudio,
    canonicalizeUrl: value => value,
  })
  const resource = {
    ...baseResource,
    setResource(url, input) {
      const context = baseResource.setResource(url, input)
      mainAudio.attachContext(context)
      foregroundBoundUrls.push(url)
      foregroundObserver.emit(context)
      return context
    },
  }
  const coordinator = factories.player.coordinator.createPlaybackResolutionCoordinator({
    createRequest: facade.createPlaybackRequest,
    createPreloadAudio: () => preloadAudio,
    detachForegroundResource: expected => resource.clearResourceIf(expected),
    clock,
  })
  const action = factories.player.action.createPlaybackActionController({
    coordinator,
    resource,
    getCurrentMusicInfo: () => currentMusicInfo,
    isPlayedStop: () => playedStop,
    autoSkipOnError: () => options.autoSkip ?? false,
    setAllStatus() {},
    emitVisibleError: () => { visibleErrorCount++ },
    scheduleAutoSkip: () => { autoSkipCalls++ },
    clearLoadTimeout() {},
  })
  const mediaHandlers = factories.player.media.createPlayerMediaEventHandlers({
    resource,
    coordinator,
    cache,
    getErrorCode: () => mainAudio.error?.code,
    setLoadedMusicIdentity: identity => action.setLoadedMusicIdentity(identity),
    appEvent: {
      error() { visibleErrorCount++ },
      playerError(code) { playHandlers?.error(code) },
      playerCanplay() {},
      playerLoadstart() { playHandlers?.loadstart() },
      playerLoadeddata() { playHandlers?.loadeddata() },
      playerWaiting() { playHandlers?.waiting() },
    },
    reportPersistenceFailure() {},
  })
  resource.onCanplay(mediaHandlers.canplay)
  resource.onError(mediaHandlers.error)
  resource.onLoadstart(mediaHandlers.loadstart)
  resource.onLoadeddata(mediaHandlers.loadeddata)
  resource.onWaiting(mediaHandlers.waiting)
  playHandlers = factories.player.play.createValidationAwarePlayEventHandlers({
    coordinator,
    isPlayedStop: () => playedStop,
    currentMusicId: () => currentMusicInfo?.id ?? '',
    currentMusicInfo: () => currentMusicInfo,
    autoSkipOnError: () => options.autoSkip ?? false,
    isDocumentHidden: () => false,
    isPlayerEmpty: () => resource.getResourceContext() == null,
    setStop: () => resource.setStop(),
    setMusicUrl(info, input) { void action.setMusicUrl(info, input) },
    playNext: async() => { autoSkipCalls++ },
    setAllStatus() {},
    translate: key => key,
    clock,
  })
  const preloadController = factories.player.preload.createNextMusicPreloadController({
    coordinator,
    setLoading() {},
    recordFailure() {},
  })

  const settleResponse = (request, status, value) => {
    const metadata = requestMetadata.get(request)
    if (!metadata) return false
    return pool.acceptResponse(metadata.runtime.webContentsId, {
      identity: metadata.runtime.identity,
      status,
      ...(status
        ? { data: { requestId: request.requestId, result: value } }
        : { message: value, data: { requestId: request.requestId, result: null } }),
    })
  }
  const play = async(info = onlineMusic, input = {}) => {
    currentMusicInfo = info
    playedStop = false
    await action.setMusicUrl(info, input)
  }
  const flush = async() => {
    await clock.flush()
    await new Promise(resolve => setImmediate(resolve))
    await clock.flush()
  }
  const changeSettings = async value => {
    ensureRegistryEntry(value.primary)
    for (const apiId of value.fallbacks) ensureRegistryEntry(apiId)
    const candidate = {
      ...settings,
      'common.apiSource': value.primary,
      'common.apiFallbackSources': [...value.fallbacks],
      ...(value.requestedQuality == null ? {} : { 'player.playQuality': value.requestedQuality }),
    }
    Object.assign(
      settings,
      candidate,
      factories.sourceSetting.normalizePlaybackSourceSetting(candidate),
    )
    await pool.markConfigured(new Set([
      settings['common.apiSource'],
      ...settings['common.apiFallbackSources'],
    ]))
  }

  return {
    play,
    playAnother: play,
    flush,
    preload: info => preloadController.start(info),
    waitForRequest(input) {
      return requestObserver.wait(request => (
        request.apiId == input.apiId &&
        (input.songIdentity == null || request.songIdentity == input.songIdentity) &&
        (input.platform == null || request.platform == input.platform)
      ), input.occurrence ?? 1)
    },
    waitForInitialization(apiId, generation) {
      return initializationObserver.wait(entry => (
        entry.apiId == apiId && (generation == null || entry.generation == generation)
      )).then(() => {})
    },
    async acceptInitialization(apiId) {
      const entry = [...initializationObserver.values].reverse().find(item => item.apiId == apiId && !item.settled)
      return settleInitialization(entry, true)
    },
    async failInitialization(apiId, message) {
      const entry = [...initializationObserver.values].reverse().find(item => item.apiId == apiId && !item.settled)
      return settleInitialization(entry, false, message)
    },
    succeed(request, url, quality) {
      const metadata = requestMetadata.get(request)
      if (!metadata) return false
      urlIdentities.set(url, request.songIdentity)
      return settleResponse(request, true, {
        source: request.platform,
        action: 'musicUrl',
        data: { type: quality ?? metadata.payload.data.info.type, url },
      })
    },
    fail(request, error = new Error('request failed')) {
      const message = error instanceof Error ? error.message : String(error)
      return settleResponse(request, false, message)
    },
    crash(apiId) {
      const runtime = runtimesByApiId.get(apiId)
      runtime?.window.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    },
    async deleteSource(apiId) {
      registry.delete(apiId)
      await pool.dispose(apiId, { clearSession: true })
      await changeSettings({
        primary: settings['common.apiSource'],
        fallbacks: factories.sourceSetting.removePlaybackFallback(
          settings['common.apiFallbackSources'],
          apiId,
        ),
      })
    },
    changeSettings,
    async advance(ms) {
      clock.advance(ms)
      await flush()
    },
    waitForBoundForeground(url, occurrence = 1) {
      return foregroundObserver.wait(context => url == null || context.url == url, occurrence)
    },
    emitForegroundCanplay() {
      const context = resource.getResourceContext()
      if (context) mainAudio.emitFor(context, 'canplay')
    },
    emitForegroundError(code = 4) {
      const context = resource.getResourceContext()
      if (context) mainAudio.emitFor(context, 'error', code)
    },
    waitForBoundPreload(songIdentity, url) {
      return preloadObserver.wait(binding => (
        binding.songIdentity == songIdentity && (url == null || binding.url == url)
      )).then(() => {})
    },
    emitPreloadCanplay(songIdentity) {
      const binding = [...preloadObserver.values].reverse().find(item => item.songIdentity == songIdentity)
      if (binding) preloadAudio.emitFor({ url: binding.url }, 'canplay')
    },
    waitForCacheInvalidation: () => cacheInvalidationObserver.wait(() => true).then(() => {}),
    releaseCacheInvalidation: () => cacheInvalidationGate.resolve(),
    cancelForeground: reason => action.cancel(reason),
    get sourceOrder() { return [...sourceOrder] },
    get adapterRequestOrder() { return [...adapterRequestOrder] },
    get cancelledRequests() { return structuredClone(cancelledRequests) },
    get foregroundBoundUrls() { return [...foregroundBoundUrls] },
    get preloadBoundUrls() { return [...preloadBoundUrls] },
    get persistedPrimary() { return settings['common.apiSource'] },
    get persistedFallbackIds() { return [...settings['common.apiFallbackSources']] },
    get sessionSourceSnapshots() { return sessionSourceSnapshots.map(ids => [...ids]) },
    get sessionQualitySnapshots() { return [...sessionQualitySnapshots] },
    get invalidatedQualities() { return [...invalidatedQualities] },
    get invalidatedCacheKeys() { return [...invalidatedCacheKeys] },
    get sessionCreateCount() { return sessionCreateCount },
    get visibleErrorCount() { return visibleErrorCount },
    get autoSkipCalls() { return autoSkipCalls },
    get authorizationCallCount() { return authorizationCallCount },
    get persistentReadCount() { return persistentReadCount },
    get persistentWriteCount() { return persistentWriteCount },
  }
}

const createCacheHarness = ({ rows = new Map(), read, save, remove } = {}) => {
  const path = require('node:path')
  const loadTsModule = require('../../scripts/test-utils/load-ts-module')
  const durableRows = rows
  const memoryRows = new Map()
  const removed = []
  const saveCalls = []
  const persistenceMutations = []
  const persistenceErrors = []
  const cacheModule = loadTsModule(
    path.join(__dirname, '../../src/renderer/core/music/playback/cache.ts'),
    {
      '@renderer/utils/ipc': {
        getMusicUrl: async key => durableRows.get(musicUrlKeyLabel(key)) ?? null,
        saveMusicUrl: async(key, value) => { durableRows.set(musicUrlKeyLabel(key), value) },
        removeMusicUrl: async key => { durableRows.delete(musicUrlKeyLabel(key)) },
      },
    },
  )
  const cache = cacheModule.createPlaybackUrlCache({
    read: async key => read ? read(key) : durableRows.get(musicUrlKeyLabel(key)) ?? null,
    save: async(key, value) => {
      const label = musicUrlKeyLabel(key)
      saveCalls.push({ key: structuredClone(key), value: structuredClone(value) })
      persistenceMutations.push(`save:${label}:${value.url}`)
      try {
        if (save) return await save(key, value)
        durableRows.set(label, value)
      } catch (error) {
        persistenceErrors.push(error)
        throw error
      }
    },
    remove: async key => {
      const label = musicUrlKeyLabel(key)
      removed.push(structuredClone(key))
      persistenceMutations.push(`remove:${label}`)
      try {
        if (remove) return await remove(key)
        durableRows.delete(label)
      } catch (error) {
        persistenceErrors.push(error)
        throw error
      }
    },
    memory: memoryRows,
  })

  const legacyCacheApi = cache.lookup.length >= 2
  const keyMusicInfo = key => ({
    id: key.sourceTrackId,
    source: key.authorization.provider,
  })
  const cacheApi = legacyCacheApi
    ? {
        ...cache,
        lookup(keyOrMusicInfo, quality) {
          return keyOrMusicInfo?.authorization
            ? cache.lookup(keyMusicInfo(keyOrMusicInfo), keyOrMusicInfo.quality)
            : cache.lookup(keyOrMusicInfo, quality)
        },
        commit(keyOrMusicInfo, qualityOrUrl, url) {
          return keyOrMusicInfo?.authorization
            ? cache.commit(keyMusicInfo(keyOrMusicInfo), keyOrMusicInfo.quality, qualityOrUrl)
            : cache.commit(keyOrMusicInfo, qualityOrUrl, url)
        },
        tombstoneKey(key) {
          return cache.tombstoneKey(musicUrlKeyLabel(key))
        },
      }
    : cache

  return Object.assign(cacheApi, {
    memoryRows,
    durableRows,
    removed,
    saveCalls,
    persistenceMutations,
    persistenceErrors,
  })
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
  musicUrlAuthorization,
  musicUrlKey,
  createRuntimeWindowHarness,
  createPoolHarness,
  createRuntimePreloadFailureHarness,
  createAdapterHarness,
  createColdUserApiRegistryHarness,
  createPrimaryCapabilityHarness,
  createColdPrimaryMusicEntryHarness,
  createCacheHarness,
  canStartPlaybackWithRegistry,
  canOpenPrimaryDownloadWithRegistry,
  deriveQualityListFromCapabilities,
  createOnlineProvider,
  createLocalProvider,
  createSessionHarness,
  createLocalSessionHarness,
  createMusicFacadeHarness,
  resolvePolicyForReason,
  createCoordinatorHarness,
  createPlaybackPreloadAudioHarness,
  createPlayerHarness,
  createIntegrationHarness,
  createPreloadSchedulingHarness,
  selectPlaybackQuality,
  cancelReasonForResolveReason: (...args) => loadPlaybackCoordinator().cancelReasonForResolveReason(...args),
  toPlaybackCachePersistenceFailure: (...args) => {
    const path = require('node:path')
    const loadTsModule = require('../../scripts/test-utils/load-ts-module')
    return loadTsModule(path.join(__dirname, '../../src/renderer/core/music/playback/cache.ts'), {
      '@renderer/utils/ipc': {},
    }).toPlaybackCachePersistenceFailure(...args)
  },
  observePlaybackCachePersistence: (...args) => {
    const path = require('node:path')
    const loadTsModule = require('../../scripts/test-utils/load-ts-module')
    return loadTsModule(path.join(__dirname, '../../src/renderer/core/music/playback/cache.ts'), {
      '@renderer/utils/ipc': {},
    }).observePlaybackCachePersistence(...args)
  },
}
