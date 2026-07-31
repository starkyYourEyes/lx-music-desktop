const assert = require('node:assert/strict')
const fs = require('node:fs')
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
const tempDirectories = []
const originalLxDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'lx')
const originalLxDataPathDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'lxDataPath')

const restoreGlobal = (name, descriptor) => {
  if (descriptor == null) delete globalThis[name]
  else Object.defineProperty(globalThis, name, descriptor)
}

afterEach(() => {
  try { delete require.cache[require.resolve(coordinatorPath)] } catch {}
  restoreGlobal('lx', originalLxDescriptor)
  restoreGlobal('lxDataPath', originalLxDataPathDescriptor)
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

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
          listPrevSelectId: '',
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
    const settingsPath = path.join(directory, 'settings.json')
    const originalSettings = '{"catalog":"original"}'
    fs.writeFileSync(settingsPath, originalSettings)
    const typedState = { localState: 'original', playlistMetadata: 'original', searchHistory: 'original' }
    const verifyPhase2Storage = async() => {
      const originalState = { ...typedState }
      try {
        typedState.localState = 'smoke'
        typedState.playlistMetadata = 'smoke'
        typedState.searchHistory = 'smoke'
        fs.writeFileSync(settingsPath, '{"catalog":"smoke"}')
        assert.deepEqual(typedState, { localState: 'smoke', playlistMetadata: 'smoke', searchHistory: 'smoke' })
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{"catalog":"smoke"}')
      } finally {
        Object.assign(typedState, originalState)
        fs.writeFileSync(settingsPath, originalSettings)
      }
      calls.push('phase2:typed-write-smoke')
    }
    const dependencies = createDependencies(calls, {
      verifyPhase2Storage,
      registerModules: () => {
        assert.deepEqual(typedState, { localState: 'original', playlistMetadata: 'original', searchHistory: 'original' })
        assert.equal(fs.readFileSync(settingsPath, 'utf8'), originalSettings)
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
    const legacyWriterState = {
      playInfo: 'enabled',
      recentPlayList: 'enabled',
      listeningTimeStats: 'enabled',
    }
    installProductionRepository(directory)
    const { createStorageCoordinator } = require(coordinatorPath)

    await createStorageCoordinator(createDependencies(calls, { verifyPhase2Storage: undefined })).start()

    assert.deepEqual(legacyWriterState, {
      playInfo: 'enabled',
      recentPlayList: 'enabled',
      listeningTimeStats: 'enabled',
    })
    assert.equal(fs.readFileSync(dataJsonPath, 'utf8'), dataJson)
    assert.equal(fs.readFileSync(listeningTimePath, 'utf8'), '{"today":19}')
    assert.equal(fs.readFileSync(listeningTimeBackupPath, 'utf8'), '{"today":18}')
  })
})
