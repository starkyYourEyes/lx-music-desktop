const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// Storage coordinator tests run source TypeScript directly so they can inject
// process boundaries without starting Electron or a worker thread.
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
const runStatePath = '../../src/main/startup/runState.ts'
const recoveryPath = '../../src/main/startup/recovery.ts'
const workerAdapterPath = '../../src/main/worker/dbService/index.ts'
const tempDirectories = []

const compileCoordinatorTypeFixture = source => {
  const fixturePath = path.resolve(__dirname, 'storage-coordinator-type-fixture.ts')
  const compilerOptions = {
    target: typescript.ScriptTarget.ESNext,
    module: typescript.ModuleKind.CommonJS,
    moduleResolution: typescript.ModuleResolutionKind.Node10,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    types: ['node'],
  }
  const host = typescript.createCompilerHost(compilerOptions)
  const originalFileExists = host.fileExists.bind(host)
  const originalReadFile = host.readFile.bind(host)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const isFixture = filename => path.resolve(filename) == fixturePath
  host.fileExists = filename => isFixture(filename) || originalFileExists(filename)
  host.readFile = filename => isFixture(filename) ? source : originalReadFile(filename)
  host.getSourceFile = (filename, languageVersion, onError, shouldCreateNewSourceFile) => isFixture(filename)
    ? typescript.createSourceFile(filename, source, languageVersion, true)
    : originalGetSourceFile(filename, languageVersion, onError, shouldCreateNewSourceFile)

  const program = typescript.createProgram({ rootNames: [fixturePath], options: compilerOptions, host })
  return typescript.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.file != null && isFixture(diagnostic.file.fileName))
    .map(diagnostic => typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

const tempDirectory = prefix => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirectories.push(directory)
  return directory
}

afterEach(() => {
  try { delete require.cache[require.resolve(coordinatorPath)] } catch {}
  try { delete require.cache[require.resolve(runStatePath)] } catch {}
  try { delete require.cache[require.resolve(recoveryPath)] } catch {}
  try { delete require.cache[require.resolve(workerAdapterPath)] } catch {}
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

const readyResult = {
  status: 'ready',
  existed: true,
  schemaVersion: 3,
  migratedVersions: [],
  backupPath: null,
}

const recoveryResult = {
  status: 'recovery',
  reason: 'schema_invalid',
  databasePath: 'C:\\profiles\\alice\\LxDatas\\lx.data.db',
  backupPath: 'C:\\profiles\\alice\\LxDatas\\backups\\migration.backup',
  diagnostics: ['schema.table_missing:my_list'],
}

const createDeps = (overrides = {}) => {
  const calls = []
  const deps = {
    runState: {
      begin: async() => {
        calls.push('run-state:unclean')
        return true
      },
      markClean: async() => { calls.push('run-state:clean') },
    },
    initDatabase: async() => {
      calls.push('db:init')
      return readyResult
    },
    closeDatabase: async() => { calls.push('db:close') },
    runMigrationHooks: async() => { calls.push('migration-hooks') },
    initSettings: async() => { calls.push('settings:init') },
    registerModules: () => { calls.push('modules:register') },
    appInited: () => { calls.push('app:inited') },
    showRecovery: async() => { calls.push('recovery:show') },
    flushStores: async() => { calls.push('stores:flush') },
    reportShutdownFailure: () => { calls.push('shutdown:reported') },
    ...overrides,
  }
  return { calls, deps }
}

const createCoordinator = deps => require(coordinatorPath).createStorageCoordinator(deps)

const loadWorkerAdapter = databaseInit => {
  const originalLoad = Module._load
  let exposed = null
  Module._load = function(request, parent, isMain) {
    if (request == './db') {
      return {
        init: databaseInit,
        close: () => {},
        getDatabaseHealth: () => ({ status: 'closed' }),
      }
    }
    if (request == '../utils/worker') return { exposeWorker: value => { exposed = value } }
    if (request == './modules/index') return {}
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    return { adapter: require(workerAdapterPath), exposed }
  } finally {
    Module._load = originalLoad
  }
}

describe('storage startup coordinator', () => {
  it('accepts a branch-dependent migration hook returning recovery or undefined', () => {
    const diagnostics = compileCoordinatorTypeFixture(`
      import type {
        StorageCoordinatorDependencies,
        StorageStartupOutcome,
      } from '../../src/main/startup/storageCoordinator'

      type RecoveryOutcome = Extract<StorageStartupOutcome, { status: 'recovery' }>

      const hook: StorageCoordinatorDependencies['runMigrationHooks'] = async(): Promise<RecoveryOutcome | undefined> => {
        if (Date.now() > 0) return undefined
        return {
          status: 'recovery',
          reason: 'fixture_recovery',
          target: {
            kind: 'external-migration',
            component: 'credentials',
            affectedPath: 'fixture-path',
            diagnostics: [],
          },
        }
      }

      void hook
    `)

    assert.deepEqual(diagnostics, [])
  })

  it('prevents module registration before database readiness and reuses concurrent start work', async() => {
    const { calls, deps } = createDeps()
    let releaseDatabase
    const databaseStarted = new Promise(resolve => { deps.databaseStarted = resolve })
    const databaseGate = new Promise(resolve => { releaseDatabase = resolve })
    deps.initDatabase = async() => {
      calls.push('db:init')
      deps.databaseStarted()
      await databaseGate
      return readyResult
    }
    const coordinator = createCoordinator(deps)

    const first = coordinator.start()
    await databaseStarted
    const second = coordinator.start()
    assert.strictEqual(second, first)
    assert.deepEqual(calls, ['run-state:unclean', 'db:init'])

    releaseDatabase()
    assert.deepEqual(await first, { status: 'ready', schemaVersion: 3 })
    assert.deepEqual(calls, [
      'run-state:unclean', 'db:init', 'migration-hooks', 'settings:init', 'modules:register', 'app:inited',
    ])

    assert.strictEqual(await coordinator.start(), await first)
    assert.equal(calls.filter(call => call == 'db:init').length, 1)
  })

  it('cancels blocked startup before shutdown can write a clean marker', async() => {
    const { calls, deps } = createDeps()
    let releaseDatabase
    let signalDatabaseStarted
    const databaseStarted = new Promise(resolve => { signalDatabaseStarted = resolve })
    const databaseGate = new Promise(resolve => { releaseDatabase = resolve })
    deps.initDatabase = async() => {
      calls.push('db:init')
      signalDatabaseStarted()
      await databaseGate
      return readyResult
    }
    const coordinator = createCoordinator(deps)

    const startup = coordinator.start()
    await databaseStarted
    const shutdown = coordinator.shutdown()
    const shutdownIsStillWaiting = await Promise.race([
      shutdown.then(() => false),
      new Promise(resolve => setImmediate(() => resolve(true))),
    ])
    assert.equal(shutdownIsStillWaiting, true)

    releaseDatabase()
    assert.deepEqual(await startup, { status: 'fatal', reason: 'storage_startup_cancelled' })
    await shutdown
    assert.deepEqual(calls, ['run-state:unclean', 'db:init', 'stores:flush', 'db:close', 'run-state:clean'])
  })

  it('leaves the run unclean when blocked startup exceeds the shutdown bound', async() => {
    const { calls, deps } = createDeps({ shutdownTimeoutMs: 20 })
    let signalDatabaseStarted
    const databaseStarted = new Promise(resolve => { signalDatabaseStarted = resolve })
    deps.initDatabase = async() => {
      calls.push('db:init')
      signalDatabaseStarted()
      await new Promise(() => {})
      return readyResult
    }
    const coordinator = createCoordinator(deps)

    // This startup is intentionally left pending to exercise the shutdown bound.
    // eslint-disable-next-line no-void
    void coordinator.start()
    await databaseStarted
    await assert.rejects(coordinator.shutdown(), /shutdown_startup_timeout/)

    assert.deepEqual(calls, ['run-state:unclean', 'db:init', 'stores:flush', 'db:close'])
  })

  it('isolates a database recovery result before migration hooks or business registration', async() => {
    const { calls, deps } = createDeps({
      initDatabase: async() => {
        calls.push('db:init')
        return recoveryResult
      },
    })
    const coordinator = createCoordinator(deps)

    const result = await coordinator.start()

    assert.deepEqual(result, {
      status: 'recovery',
      reason: 'schema_invalid',
      target: {
        kind: 'database',
        databasePath: 'C:\\profiles\\alice\\LxDatas\\lx.data.db',
        backupPath: 'C:\\profiles\\alice\\LxDatas\\backups\\migration.backup',
        diagnostics: ['schema.table_missing:my_list'],
      },
    })
    assert.deepEqual(calls, ['run-state:unclean', 'db:init', 'recovery:show'])
  })

  it('marks a run clean only after every flusher, stores, and database close succeeds', async() => {
    const { calls, deps } = createDeps()
    const coordinator = createCoordinator(deps)
    await coordinator.start()
    calls.length = 0
    coordinator.registerShutdownFlusher('activity', async() => { calls.push('activity:flush') })

    const firstShutdown = coordinator.shutdown()
    const secondShutdown = coordinator.shutdown()
    assert.strictEqual(secondShutdown, firstShutdown)
    await firstShutdown

    assert.deepEqual(calls, ['activity:flush', 'stores:flush', 'db:close', 'run-state:clean'])
  })

  it('keeps the run unclean when a shutdown flusher times out without reporting payloads', async() => {
    const { calls, deps } = createDeps()
    const diagnostics = []
    deps.reportShutdownFailure = diagnostic => diagnostics.push(diagnostic)
    const coordinator = createCoordinator({ ...deps, shutdownTimeoutMs: 20 })
    await coordinator.start()
    calls.length = 0
    coordinator.registerShutdownFlusher('activity', async() => new Promise(() => {}))

    await assert.rejects(coordinator.shutdown(), /shutdown_flush_timeout/)

    assert.deepEqual(calls, ['stores:flush', 'db:close'])
    assert.deepEqual(diagnostics, [{ code: 'shutdown_flush_timeout', flusherNames: ['activity'] }])
    assert.equal(JSON.stringify(diagnostics).includes('payload'), false)
  })

  it('keeps the run unclean when stores cannot flush', async() => {
    const { calls, deps } = createDeps({
      flushStores: async() => {
        calls.push('stores:flush')
        throw new Error('store_flush_failed')
      },
    })
    const coordinator = createCoordinator(deps)
    await coordinator.start()
    calls.length = 0

    await assert.rejects(coordinator.shutdown(), /store_flush_failed/)

    assert.deepEqual(calls, ['stores:flush', 'db:close'])
  })
})

describe('database worker startup surface', () => {
  it('exposes the object/result database init contract without a legacy string adapter', async() => {
    const received = []
    const { adapter, exposed } = loadWorkerAdapter(async options => {
      received.push(options)
      return readyResult
    })
    const options = {
      dataPath: 'C:\\profiles\\alice\\LxDatas',
      backupDir: 'C:\\profiles\\alice\\LxDatas\\backups',
      previousShutdownWasClean: true,
    }

    assert.deepEqual(await adapter.init(options), readyResult)
    assert.strictEqual(exposed.init, adapter.init)
    assert.deepEqual(received, [options])
    assert.equal(typeof adapter.initForWorker, 'undefined')
  })
})

describe('storage run state', () => {
  it('records unclean startup before database initialization and clean completion after shutdown', async() => {
    const runtimeRoot = tempDirectory('lx-run-state-')
    let now = 100
    const { createRunState } = require(runStatePath)
    const first = createRunState({ runtimeRoot, now: () => now })

    assert.equal(await first.begin(), false)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'run-state.v1.json'), 'utf8')), {
      version: 1,
      clean: false,
      startedAtMs: 100,
      completedAtMs: 0,
    })

    now = 200
    await first.markClean()
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'run-state.v1.json'), 'utf8')), {
      version: 1,
      clean: true,
      startedAtMs: 100,
      completedAtMs: 200,
    })

    now = 300
    const nextRun = createRunState({ runtimeRoot, now: () => now })
    assert.equal(await nextRun.begin(), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'run-state.v1.json'), 'utf8')), {
      version: 1,
      clean: false,
      startedAtMs: 300,
      completedAtMs: 200,
    })
  })

  it('serializes concurrent begin and markClean calls in invocation order', async() => {
    const runtimeRoot = tempDirectory('lx-run-state-concurrent-')
    let now = 100
    const { createRunState } = require(runStatePath)
    const runState = createRunState({
      runtimeRoot,
      now: () => {
        const timestamp = now
        now += 100
        return timestamp
      },
    })

    const begin = runState.begin()
    const markClean = runState.markClean()

    assert.equal(await begin, false)
    await markClean
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'run-state.v1.json'), 'utf8')), {
      version: 1,
      clean: true,
      startedAtMs: 100,
      completedAtMs: 200,
    })
  })
})

describe('storage recovery dialog', () => {
  it('offers data-folder recovery without reading or disclosing affected file contents', async() => {
    const openedPaths = []
    const messages = []
    let quitCalls = 0
    const originalLoad = Module._load
    Module._load = function(request, parent, isMain) {
      if (request == 'electron') {
        return {
          app: { quit: () => { quitCalls++ } },
          dialog: {
            showMessageBox: async options => {
              messages.push(options)
              return { response: 0 }
            },
          },
          shell: { openPath: async target => { openedPaths.push(target) } },
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      const { showStorageRecovery } = require(recoveryPath)
      await showStorageRecovery({
        status: 'recovery',
        reason: 'schema_invalid',
        target: {
          kind: 'database',
          databasePath: 'C:\\profiles\\alice\\LxDatas\\lx.data.db',
          backupPath: null,
          diagnostics: ['schema.table_missing:my_list'],
        },
      })
    } finally {
      Module._load = originalLoad
    }

    assert.deepEqual(messages[0].buttons, ['Open data folder', 'Quit'])
    assert.equal(messages[0].detail.includes('schema.table_missing:my_list'), true)
    assert.equal(messages[0].detail.includes('file payload'), false)
    assert.deepEqual(openedPaths, ['C:\\profiles\\alice\\LxDatas'])
    assert.equal(quitCalls, 1)
  })
})
