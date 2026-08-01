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
  canStartPlaybackWithRegistry,
  canOpenPrimaryDownloadWithRegistry,
  deriveQualityListFromCapabilities,
}
