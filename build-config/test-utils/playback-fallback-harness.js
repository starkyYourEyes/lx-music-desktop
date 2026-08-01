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
  meta: { albumName: 'Album', filePath: '/Song.mp3', picPath: '/cover.jpg', _qualitys: {} },
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
    const runtimes = new Map()
    const proxyListeners = new Set()
    const createWaiters = new Map()
    const runtimeWaiters = new Map()
    const initializeWaiters = new Map()
    const pendingWaiters = new Map()
    const disposeWaiters = new Map()
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
        if (options.createGate) await options.createGate
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
      async disposeRuntimeWindow(runtime, { clearSession }) {
        lifecycle.push(`dispose:${runtime.identity.apiId}:${runtime.identity.generation}`)
        disposedIds.push(runtime.identity.apiId)
        disposedGenerations.push(runtime.identity.generation)
        notify(disposeWaiters, runtime.identity.apiId, runtime.identity.generation)
        if (options.disposeRejectIds?.includes(runtime.identity.apiId)) throw new Error(`dispose ${runtime.identity.apiId} failed`)
        if (clearSession) {
          lifecycle.push(`clearSession:${runtime.identity.apiId}`)
          clearedSessionIds.push(runtime.identity.apiId)
        }
      },
      async clearRuntimeSession(apiId) {
        lifecycle.push(`clearSession:${apiId}`)
        clearedSessionIds.push(apiId)
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
      waitForCreateCall: apiId => wait(createWaiters, apiId),
      waitForRuntimeCreated: (apiId, generation) => wait(runtimeWaiters, apiId, generation),
      waitForInitializeCall: (apiId, generation) => wait(initializeWaiters, apiId, generation),
      waitForPending: (apiId, requestId) => wait(pendingWaiters, apiId, requestId),
      waitForDisposed: (apiId, generation) => wait(disposeWaiters, apiId, generation),
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
      '@common/utils/playbackSourceError': loadTsModule(
        path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
      ),
      '@renderer/utils/ipc': {},
      '@renderer/utils/message': { requestMsg: {} },
      '@renderer/utils/musicSdk/api-source': {},
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
      '@renderer/worker': () => ({}),
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
      '@renderer/store': { qualityList: { value: {} } },
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
      '@common/utils/playbackSourceError': loadTsModule(
        path.join(__dirname, '../../src/common/utils/playbackSourceError.ts'),
      ),
      '@renderer/utils/ipc': {},
      '@renderer/utils/message': { requestMsg: {} },
      '@renderer/utils/musicSdk/api-source': {},
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
    if (options.request) return options.request(request)
    if (Object.prototype.hasOwnProperty.call(options.urls ?? {}, request.apiId)) {
      return Promise.resolve({
        url: options.urls[request.apiId],
        quality: request.quality ?? '128k',
      })
    }
    return getSourceGate(request.apiId).promise.then(url => ({
      url,
      quality: request.quality ?? '128k',
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
  if (options.cachedUrl) rows.set(`${musicInfo.id}_${options.requestedQuality ?? '128k'}`, options.cachedUrl)
  const cache = createCacheHarness({
    rows,
    read: options.cacheRead,
    save: options.cacheCommit,
    remove: options.cacheDelete,
  })
  const observedCache = {
    ...cache,
    commit(originalMusic, quality, url) {
      cacheCommits.push({ musicInfo: originalMusic, quality, url })
      return cache.commit(originalMusic, quality, url)
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
    cacheMode: options.cacheMode ?? (options.cachedUrl ? 'lookup' : 'bypass'),
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
      './coordinator': coordinatorModule,
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
        async getMusicUrl(musicInfo, quality) {
          cacheLookups.push(`${musicInfo.id}_${quality}`)
          return null
        },
      },
      './utils': {
        buildLyricInfo: value => value,
        getPlayQuality: quality => quality,
        getCachedLyricInfo: async() => null,
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
  }

  const preloadAudio = new FakePreloadAudio()
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
    createPreloadAudio: () => preloadAudio,
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
    preloadCanplay: resource => preloadAudio.emitFor(resource, 'canplay'),
    preloadError: resource => preloadAudio.emitFor(resource, 'error'),
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
    preloadValidator: preloadAudio,
    visibleErrorCount: 0,
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
        getMusicUrl: async(musicInfo, quality) => durableRows.get(`${musicInfo.id}_${quality}`) ?? '',
        saveMusicUrl: async(musicInfo, quality, url) => {
          durableRows.set(`${musicInfo.id}_${quality}`, url)
        },
        removeMusicUrlByKey: async key => {
          durableRows.delete(key)
        },
      },
    },
  )
  const cache = cacheModule.createPlaybackUrlCache({
    read: async key => read ? read(key) : durableRows.get(key) ?? '',
    save: async(musicInfo, quality, url) => {
      const key = `${musicInfo.id}_${quality}`
      saveCalls.push({ key, url })
      persistenceMutations.push(`save:${key}:${url}`)
      try {
        if (save) return await save(musicInfo, quality, url)
        durableRows.set(key, url)
      } catch (error) {
        persistenceErrors.push(error)
        throw error
      }
    },
    remove: async key => {
      removed.push(key)
      persistenceMutations.push(`remove:${key}`)
      try {
        if (remove) return await remove(key)
        durableRows.delete(key)
      } catch (error) {
        persistenceErrors.push(error)
        throw error
      }
    },
    memory: memoryRows,
  })

  return Object.assign(cache, {
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
  createRuntimeWindowHarness,
  createPoolHarness,
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
