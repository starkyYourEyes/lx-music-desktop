const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const coordinatorPath = '../../src/main/startup/storageCoordinator.ts'
const storageStatePath = '../../src/main/modules/winMain/rendererEvent/storageState.ts'
const dataHandlerPath = '../../src/main/modules/winMain/rendererEvent/data.ts'
const atomicJsonPath = '../../src/main/storage/atomicJsonFile.ts'
const settingsDocumentPath = '../../src/main/storage/settings/document.ts'
const storePath = '../../src/main/utils/store.ts'
const commonRoot = path.resolve(__dirname, '../../src/common')
const tempDirectories = []
const originalLxDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'lx')
const originalLxDataPathDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'lxDataPath')

const restoreGlobal = (name, descriptor) => {
  if (descriptor == null) delete globalThis[name]
  else Object.defineProperty(globalThis, name, descriptor)
}

afterEach(() => {
  for (const modulePath of [coordinatorPath, storageStatePath, dataHandlerPath, atomicJsonPath, settingsDocumentPath, storePath]) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
  restoreGlobal('lx', originalLxDescriptor)
  restoreGlobal('lxDataPath', originalLxDataPathDescriptor)
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const loadSourceModule = modulePath => {
  const originalLoad = Module._load
  Module._load = function(request, parent, isMain) {
    if (request == 'electron') return { dialog: {}, shell: {} }
    if (request == '@common/mainIpc') return { mainHandle: () => {}, mainOn: () => {} }
    if (request == '@common/utils') return { log: { error: () => {} } }
    if (request == '@main/utils') return { updateCatalogPreferences: () => { throw new Error('unexpected global settings write') } }
    if (request == '@main/utils/store') return () => { throw new Error('unexpected global Store access') }
    if (request.startsWith('@common/')) {
      return originalLoad.call(this, path.join(commonRoot, `${request.slice('@common/'.length)}.ts`), parent, isMain)
    }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return require(modulePath)
  } finally {
    Module._load = originalLoad
  }
}

const availableLegacyData = {
  status: 'available',
  snapshot: {
    sourcePath: 'C:\\fixtures\\data.json',
    parsed: {},
    fileSha256: 'b'.repeat(64),
    fileIdentity: { dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5, birthtimeMs: 6 },
  },
}

const createTransactionalRepository = () => {
  let state = {
    localState: {
      version: 1,
      viewPrevState: { url: '/', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    },
    playlistMetadata: {},
    searchHistory: [],
  }
  const snapshot = () => structuredClone(state)
  return {
    snapshot,
    rollback: saved => { state = structuredClone(saved) },
    getLocalState: () => structuredClone(state.localState),
    setLocalState: update => {
      const fields = {
        view_prev_state: 'viewPrevState',
        list_scroll_positions: 'listScrollPosition',
        list_prev_select_id: 'listPrevSelectId',
      }
      state.localState[fields[update.key]] = structuredClone(update.value)
      return structuredClone(state.localState)
    },
    getPlaylistMetadata: () => structuredClone(state.playlistMetadata),
    applyPlaylistMetadata: command => {
      if (command.action == 'upsert') state.playlistMetadata[command.playlistId] = structuredClone(command.value)
      else if (command.action == 'remove') delete state.playlistMetadata[command.playlistId]
      else {
        state.playlistMetadata = Object.fromEntries(
          Object.entries(state.playlistMetadata).filter(([id]) => command.playlistIds.includes(id)),
        )
      }
      return structuredClone(state.playlistMetadata)
    },
    getSearchHistory: () => [...state.searchHistory],
    applySearchHistory: command => {
      if (command.action == 'clear') state.searchHistory = []
      else if (command.action == 'remove') state.searchHistory = state.searchHistory.filter(term => term != command.term)
      else state.searchHistory = [command.term, ...state.searchHistory.filter(term => term != command.term)]
      return [...state.searchHistory]
    },
  }
}

const installProductionRepository = (directory, overrides = {}) => {
  globalThis.lxDataPath = directory
  globalThis.lx = {
    worker: {
      dbService: {
        getNonActivityMigrationMarker: async() => ({
          name: 'legacy_data_v1.phase2_complete',
          sourceSha256: 'a'.repeat(64),
          completedAtMs: 1,
          detailsJson: '{"version":1}',
        }),
        getLocalState: async() => ({
          version: 1,
          viewPrevState: { url: '/', query: {} },
          listScrollPosition: {},
          listPrevSelectId: 'default',
        }),
        setLocalState: async() => {},
        getPlaylistMetadata: async() => ({}),
        applyPlaylistMetadata: async() => {},
        getSearchHistory: async() => [],
        applySearchHistory: async() => {},
        ...overrides,
      },
    },
  }
}

const createDependencies = (calls, overrides = {}) => ({
  runState: {
    begin: async() => { calls.push('run-state:begin'); return true },
    markClean: async() => {},
  },
  preflightLegacyData: async() => ({ status: 'absent' }),
  initDatabase: async() => {
    calls.push('database:init')
    return { status: 'ready', existed: true, schemaVersion: 5, migratedVersions: [], backupPath: null }
  },
  closeDatabase: async() => {},
  runMigrationHooks: async() => { calls.push('migration:run') },
  checkCredentials: async() => {
    calls.push('credentials:check')
    return { vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [] }
  },
  verifyPhase2Storage: async() => { calls.push('phase2:typed-write-smoke') },
  initSettings: async() => { calls.push('settings:init') },
  registerModules: () => { calls.push('modules:register') },
  appInited: () => { calls.push('window:create') },
  showRecovery: async() => { calls.push('recovery:show') },
  flushStores: async() => {},
  ...overrides,
})

describe('non-activity startup gate', () => {
  it('activates typed Phase 2 writers after credentials and before renderer consumers', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-writer-smoke-'))
    tempDirectories.push(directory)
    const settingsPath = path.join(directory, 'config_v2.json')
    const originalSettings = {
      storageSchemaVersion: 1,
      version: '3.0.0',
      setting: { version: '3.0.0' },
      catalogPreferences: {
        version: 1,
        leaderboard: { source: 'kw', boardId: 'kw__16' },
        songList: { source: 'kw', sortId: 'new', tagId: '' },
        search: { temp_source: 'kw', source: 'all', type: 'music' },
      },
    }
    const repository = createTransactionalRepository()
    const originalRepositoryState = repository.snapshot()
    const { parseSettingsDocument } = loadSourceModule(settingsDocumentPath)
    const { createAtomicJsonFile } = require(atomicJsonPath)
    const settingsFile = createAtomicJsonFile({
      filePath: settingsPath,
      validate: value => {
        try { parseSettingsDocument(value); return true } catch { return false }
      },
    })
    await settingsFile.replace(originalSettings)
    const { createStorageStateDispatcher } = loadSourceModule(storageStatePath)
    const dispatch = createStorageStateDispatcher({
      ...repository,
      getCatalogPreferences: async() => (await settingsFile.read()).catalogPreferences,
      updateCatalogPreferences: async catalogPreferences => {
        const current = await settingsFile.read()
        await settingsFile.replace({ ...current, catalogPreferences })
        return { catalogPreferences: (await settingsFile.read()).catalogPreferences }
      },
    })
    let stateAtModuleRegistration
    let settingsAtModuleRegistration
    const verifyPhase2Storage = async() => {
      const transaction = repository.snapshot()
      const originalDocument = await settingsFile.read()
      try {
        assert.equal((await dispatch({
          type: 'local_state.set',
          update: { version: 1, key: 'list_prev_select_id', value: 'smoke-list', updatedAtMs: 1 },
        })).listPrevSelectId, 'smoke-list')
        assert.deepEqual(await dispatch({
          type: 'playlist_metadata.mutate',
          command: {
            version: 1,
            action: 'upsert',
            playlistId: 'smoke-list',
            value: { updateTime: 1, isAutoUpdate: true },
            updatedAtMs: 1,
          },
        }), { 'smoke-list': { updateTime: 1, isAutoUpdate: true } })
        assert.deepEqual(await dispatch({
          type: 'search_history.mutate',
          command: { version: 1, action: 'record', term: 'smoke-search', usedAtMs: 1 },
        }), ['smoke-search'])
        const catalog = await dispatch({
          type: 'catalog_preference.set',
          section: 'leaderboard',
          value: { source: 'kg', boardId: 'kg__1' },
        })
        assert.deepEqual(catalog.leaderboard, { source: 'kg', boardId: 'kg__1' })
      } finally {
        repository.rollback(transaction)
        await settingsFile.replace(originalDocument)
      }
      calls.push('phase2:typed-write-smoke')
    }
    const dependencies = createDependencies(calls, {
      verifyPhase2Storage,
      registerModules: () => {
        stateAtModuleRegistration = repository.snapshot()
        settingsAtModuleRegistration = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
        calls.push('modules:register')
      },
    })
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(dependencies).start()

    assert.deepEqual(outcome, { status: 'ready', schemaVersion: 5 })
    assert.ok(calls.includes('phase2:typed-write-smoke'))
    assert.ok(calls.indexOf('credentials:check') < calls.indexOf('phase2:typed-write-smoke'))
    assert.ok(calls.indexOf('phase2:typed-write-smoke') < calls.indexOf('settings:init'))
    assert.ok(calls.indexOf('phase2:typed-write-smoke') < calls.indexOf('modules:register'))
    assert.ok(calls.indexOf('phase2:typed-write-smoke') < calls.indexOf('window:create'))
    assert.deepEqual(stateAtModuleRegistration, originalRepositoryState)
    assert.deepEqual(settingsAtModuleRegistration, originalSettings)
  })

  it('fails closed before settings, modules, or windows when Phase 2 storage is unhealthy', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-unhealthy-'))
    tempDirectories.push(directory)
    installProductionRepository(directory, { applySearchHistory: undefined })
    const dependencies = createDependencies(calls, {
      verifyPhase2Storage: undefined,
    })
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(dependencies).start()

    assert.deepEqual(outcome, { status: 'fatal', reason: 'phase2_storage_unavailable' })
    assert.deepEqual(calls.slice(-1), ['credentials:check'])
    assert.equal(calls.includes('settings:init'), false)
    assert.equal(calls.includes('modules:register'), false)
    assert.equal(calls.includes('window:create'), false)
  })

  it('requires the Phase 2 completion marker when legacy data was available', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-marker-required-'))
    tempDirectories.push(directory)
    installProductionRepository(directory, { getNonActivityMigrationMarker: async() => null })
    const dependencies = createDependencies(calls, {
      preflightLegacyData: async() => availableLegacyData,
      verifyPhase2Storage: undefined,
    })
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(dependencies).start()

    assert.deepEqual(outcome, { status: 'fatal', reason: 'phase2_storage_unavailable' })
    assert.equal(calls.includes('settings:init'), false)
    assert.equal(calls.includes('modules:register'), false)
    assert.equal(calls.includes('window:create'), false)
  })

  it('allows a missing Phase 2 completion marker for a true no-source startup', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-marker-absent-'))
    tempDirectories.push(directory)
    installProductionRepository(directory, { getNonActivityMigrationMarker: async() => null })
    const dependencies = createDependencies(calls, { verifyPhase2Storage: undefined })
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(dependencies).start()

    assert.deepEqual(outcome, { status: 'ready', schemaVersion: 5 })
    assert.equal(calls.includes('settings:init'), true)
    assert.equal(calls.includes('modules:register'), true)
    assert.equal(calls.includes('window:create'), true)
  })

  it('rejects a malformed Phase 2 completion marker when legacy data was available', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-marker-invalid-'))
    tempDirectories.push(directory)
    installProductionRepository(directory, {
      getNonActivityMigrationMarker: async() => ({
        name: 'legacy_data_v1.phase2_complete',
        sourceSha256: 'not-a-sha256',
        completedAtMs: 1,
        detailsJson: '{"version":1}',
      }),
    })
    const dependencies = createDependencies(calls, {
      preflightLegacyData: async() => availableLegacyData,
      verifyPhase2Storage: undefined,
    })
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(dependencies).start()

    assert.deepEqual(outcome, { status: 'fatal', reason: 'phase2_storage_unavailable' })
    assert.equal(calls.includes('settings:init'), false)
  })

  it('normalizes repository errors at the Phase 2 gate', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-error-'))
    tempDirectories.push(directory)
    const sqliteError = new Error('database is busy')
    sqliteError.code = 'SQLITE_BUSY'
    installProductionRepository(directory, {
      getNonActivityMigrationMarker: async() => { throw sqliteError },
    })
    const dependencies = createDependencies(calls, { verifyPhase2Storage: undefined })
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(dependencies).start()

    assert.deepEqual(outcome, { status: 'fatal', reason: 'phase2_storage_unavailable' })
    assert.equal(calls.includes('settings:init'), false)
    assert.equal(calls.includes('modules:register'), false)
    assert.equal(calls.includes('window:create'), false)
  })

  it('does not redact or disable legacy activity keys or files in Phase 2', async() => {
    const calls = []
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-phase2-activity-'))
    tempDirectories.push(directory)
    const dataJsonPath = path.join(directory, 'data.json')
    const listeningTimePath = path.join(directory, 'listening_time.json')
    const listeningTimeBackupPath = path.join(directory, 'listening_time.backup.json')
    const dataJson = JSON.stringify({
      playInfo: { id: 'current-song' },
      recentPlayList: [{ id: 'recent-song' }],
      listeningTimeStats: { totalSeconds: 19 },
    })
    fs.writeFileSync(dataJsonPath, dataJson)
    fs.writeFileSync(listeningTimePath, '{"today":19}')
    fs.writeFileSync(listeningTimeBackupPath, '{"today":18}')
    installProductionRepository(directory)
    const { createStorageCoordinator } = require(coordinatorPath)

    const outcome = await createStorageCoordinator(createDependencies(calls, { verifyPhase2Storage: undefined })).start()
    assert.deepEqual(outcome, { status: 'ready', schemaVersion: 5 })

    const { Store } = loadSourceModule(storePath)
    const { createDataHandlers } = loadSourceModule(dataHandlerPath)
    const store = new Store(dataJsonPath)
    const handlers = createDataHandlers(store)
    const expectedActivity = {
      playInfo: { id: 'next-song', progress: 12 },
      recentPlayList: [{ id: 'recent-next' }],
      listeningTimeStats: { totalSeconds: 20 },
    }
    for (const [activityKey, value] of Object.entries(expectedActivity)) {
      handlers.set({ path: activityKey, data: value })
    }
    await store.flush()

    for (const [activityKey, value] of Object.entries(expectedActivity)) {
      assert.deepEqual(handlers.get(activityKey), value)
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(dataJsonPath, 'utf8')), expectedActivity)
    assert.equal(fs.readFileSync(listeningTimePath, 'utf8'), '{"today":19}')
    assert.equal(fs.readFileSync(listeningTimeBackupPath, 'utf8'), '{"today":18}')
  })
})
