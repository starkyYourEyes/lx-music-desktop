const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

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
const portableMigrationPath = '../../src/main/migration/portableProfile.js'
const runStatePath = '../../src/main/startup/runState.ts'
const recoveryPath = '../../src/main/startup/recovery.ts'
const workerAdapterPath = '../../src/main/worker/dbService/index.ts'
const workerDbService = require('../../src/main/worker/dbService/db.ts')
const phase3Worker = require('../../src/main/worker/dbService/modules/phase3/index.ts')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')
const tempDirectories = []
const appDbFixtures = []
const supportsWorkerDatabase = typeof process.versions.electron == 'string'
const hadOriginalLx = Object.prototype.hasOwnProperty.call(globalThis, 'lx')
const originalLx = globalThis.lx

const runElectronChild = () => {
  const result = childProcess.spawnSync(require('electron'), ['--test', __filename], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

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
  const fixture = createTestStorageRoot(prefix)
  tempDirectories.push(fixture)
  return fixture.path
}

afterEach(() => {
  try { workerDbService.close() } catch {}
  try { delete require.cache[require.resolve(coordinatorPath)] } catch {}
  try { delete require.cache[require.resolve(portableMigrationPath)] } catch {}
  try { delete require.cache[require.resolve(runStatePath)] } catch {}
  try { delete require.cache[require.resolve(recoveryPath)] } catch {}
  try { delete require.cache[require.resolve(workerAdapterPath)] } catch {}
  for (const fixture of tempDirectories.splice(0)) {
    fixture.cleanup()
  }
  for (const fixture of appDbFixtures.splice(0)) fixture.cleanup()
  if (hadOriginalLx) globalThis.lx = originalLx
  else delete globalThis.lx
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

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sqliteFingerprint = databasePath => Object.fromEntries([
  databasePath,
  `${databasePath}-wal`,
  `${databasePath}-shm`,
].map(filename => [filename, fs.existsSync(filename)
  ? crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
  : null]))
const checkpointAndClose = db => {
  db.pragma('wal_checkpoint(TRUNCATE)')
  workerDbService.close()
}
const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const cacheChecks = () => [
  { name: 'credentials', version: 1, state: 'complete', evidenceSha256: 'a'.repeat(64) },
  { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: 'b'.repeat(64) },
  { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: 'c'.repeat(64) },
  { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: 'd'.repeat(64) },
  { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: 'e'.repeat(64) },
  { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: 'f'.repeat(64) },
  { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: '0'.repeat(64) },
]

const cacheMarker = checks => {
  const detailsJson = canonical({ version: 1, checks })
  return {
    name: 'legacy_data_v1.cross_artifact_complete',
    sourceSha256: sha256(detailsJson),
    completedAtMs: 1,
    detailsJson,
  }
}

const createAppDbFixture = async() => {
  const fixture = createTestStorageRoot('cache-coordinator')
  appDbFixtures.push(fixture)
  const options = {
    dataPath: fixture.path,
    cacheRoot: path.join(fixture.path, 'cache'),
    backupsRoot: path.join(fixture.path, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  }
  const startup = await workerDbService.init(options)
  assert.equal(startup.status, 'ready')
  return {
    db: workerDbService.getAppDB(),
    options,
    appDbPath: path.join(fixture.path, 'lx.data.db'),
  }
}

const insertRawCacheMarker = (db, marker, allowInvalidJson = false) => {
  if (allowInvalidJson) db.pragma('ignore_check_constraints = ON')
  try {
    db.prepare(`
      INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
      VALUES (?, ?, ?, ?)
    `).run(marker.name, marker.sourceSha256, marker.completedAtMs, marker.detailsJson)
  } finally {
    if (allowInvalidJson) db.pragma('ignore_check_constraints = OFF')
  }
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
    checkCredentials: async() => {
      calls.push('credentials:check')
      return { vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [] }
    },
    now: () => 1,
    interruptStalePlaybackSessions: async() => 0,
    runPlaybackTypedSmoke: async() => ({ version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64) }),
    getPhase3AttestationPrerequisites: async() => ({
      version: 1,
      accountProfile: { markerName: 'legacy_data_v1.account_profiles', state: 'not-applicable', evidenceSha256: 'a'.repeat(64) },
      phase2: { markerName: 'legacy_data_v1.phase2_complete', state: 'not-applicable', evidenceSha256: 'b'.repeat(64) },
      playbackActivity: { markerName: 'legacy_data_v1.playback_activity', state: 'not-applicable', evidenceSha256: 'c'.repeat(64) },
    }),
    completePhase3Attestation: async() => {},
    getCachePhasePrerequisite: async() => ({
      version: 1,
      markerName: 'legacy_data_v1.cross_artifact_complete',
      sourceSha256: 'f'.repeat(64),
      completedAtMs: 1,
    }),
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

const installProductionCache = repository => {
  globalThis.lx = { worker: { dbService: repository } }
}

const seedPortableProfile = rootPath => {
  const portableRoot = path.join(rootPath, 'portable')
  const sourceRoot = path.join(portableRoot, 'userData', 'LxDatas')
  const profileRoot = path.join(portableRoot, 'profile')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceRoot, 'lx.data.db'), 'legacy-database')
  return { portableRoot, sourceRoot, profileRoot }
}

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
  it('rejects invalid raw worker markers before Phase 4 can mutate the app database', async() => {
    if (!supportsWorkerDatabase) return runElectronChild()
    const valid = cacheMarker(cacheChecks())
    const incompleteWriter = cacheChecks()
    incompleteWriter[5].state = 'not-applicable'
    const incompleteReader = cacheChecks()
    incompleteReader[6].state = 'not-applicable'
    const cases = [
      { name: 'missing', marker: null, allowInvalidJson: false },
      { name: 'malformed JSON', marker: { ...valid, detailsJson: '{' }, allowInvalidJson: true },
      { name: 'hash mismatch', marker: { ...valid, sourceSha256: 'f'.repeat(64) }, allowInvalidJson: false },
      { name: 'incomplete writer', marker: cacheMarker(incompleteWriter), allowInvalidJson: false },
      { name: 'incomplete reader', marker: cacheMarker(incompleteReader), allowInvalidJson: false },
    ]

    for (const testCase of cases) {
      const { db, options, appDbPath } = await createAppDbFixture()
      if (testCase.marker != null) insertRawCacheMarker(db, testCase.marker, testCase.allowInvalidJson)
      checkpointAndClose(db)
      const beforeFingerprint = sqliteFingerprint(appDbPath)
      const { calls, deps } = createDeps({
        initDatabase: async() => workerDbService.init(options),
        getCachePhasePrerequisite: () => phase3Worker.getCachePhasePrerequisite(),
        initializePhase4: async() => {
          calls.push('phase4:initialize')
          db.exec('CREATE TABLE phase4_mutation_sentinel(value TEXT)')
          return { schemaVersion: 7, typedOwnershipVerified: true }
        },
      })

      const result = await createCoordinator(deps).start()

      assert.deepEqual(result, { status: 'fatal', reason: 'cache_phase3_prerequisite_invalid' }, testCase.name)
      assert.equal(calls.includes('phase4:initialize'), false, testCase.name)
      workerDbService.close()
      assert.deepEqual(sqliteFingerprint(appDbPath), beforeFingerprint, testCase.name)
    }

    const { db, options, appDbPath } = await createAppDbFixture()
    insertRawCacheMarker(db, valid)
    checkpointAndClose(db)
    const beforeFingerprint = sqliteFingerprint(appDbPath)
    const { calls, deps } = createDeps({
      initDatabase: async() => workerDbService.init(options),
      getCachePhasePrerequisite: () => phase3Worker.getCachePhasePrerequisite(),
      initializePhase4: async() => {
        calls.push('phase4:initialize')
        workerDbService.getAppDB().exec('CREATE TABLE phase4_mutation_sentinel(value TEXT)')
        return { schemaVersion: 7, typedOwnershipVerified: true }
      },
    })

    assert.deepEqual(await createCoordinator(deps).start(), { status: 'ready', schemaVersion: 7 })
    assert.equal(calls.includes('phase4:initialize'), true)
    workerDbService.close()
    assert.notDeepEqual(sqliteFingerprint(appDbPath), beforeFingerprint)
  })

  it('runs the cache prerequisite after Phase 3 and propagates the Phase 4 schema version', async() => {
    const { calls, deps } = createDeps({
      completePhase3Attestation: async() => { calls.push('phase3:attestation') },
      getCachePhasePrerequisite: async() => {
        calls.push('cache:prerequisite')
        return { version: 1, markerName: 'legacy_data_v1.cross_artifact_complete', sourceSha256: 'f'.repeat(64), completedAtMs: 1 }
      },
      initializePhase4: async function() {
        assert.equal(arguments.length, 0)
        calls.push('phase4:initialize')
        return { schemaVersion: 7, typedOwnershipVerified: true }
      },
    })

    const result = await createCoordinator(deps).start()

    assert.deepEqual(result, { status: 'ready', schemaVersion: 7 })
    assert.ok(calls.indexOf('phase3:attestation') < calls.indexOf('cache:prerequisite'))
    assert.ok(calls.indexOf('cache:prerequisite') < calls.indexOf('phase4:initialize'))
  })

  it('requires the exact Phase 4 result contract', async t => {
    const cases = [
      { name: 'missing ownership', value: { schemaVersion: 7 } },
      { name: 'extra field', value: { schemaVersion: 7, typedOwnershipVerified: true, extra: true } },
      { name: 'invalid ownership type', value: { schemaVersion: 7, typedOwnershipVerified: 'true' } },
      { name: 'schema 6 cannot be verified', value: { schemaVersion: 6, typedOwnershipVerified: true } },
      { name: 'non-plain object', value: Object.assign(Object.create(null), { schemaVersion: 7, typedOwnershipVerified: true }) },
    ]
    for (const testCase of cases) await t.test(testCase.name, async() => {
      const { deps } = createDeps({ initializePhase4: async() => testCase.value })
      assert.deepEqual(await createCoordinator(deps).start(), {
        status: 'fatal', reason: 'cache_phase4_result_invalid',
      })
    })
  })

  it('arms portable acknowledgement only for verified schema 7', async t => {
    const cases = [
      { name: 'schema 6 degraded', phase4: { schemaVersion: 6, typedOwnershipVerified: false }, acknowledgements: 0 },
      { name: 'schema 7 degraded', phase4: { schemaVersion: 7, typedOwnershipVerified: false }, acknowledgements: 0 },
      { name: 'schema 7 verified', phase4: { schemaVersion: 7, typedOwnershipVerified: true }, acknowledgements: 1 },
    ]
    for (const testCase of cases) await t.test(testCase.name, async() => {
      let acknowledgements = 0
      const { deps } = createDeps({ initializePhase4: async() => testCase.phase4 })
      deps.portableProfileToken = Object.freeze({
        version: 1,
        portableRoot: 'C:\\portable-fixture',
        promotionRunId: 'promotion-run',
        startupRunId: 'startup-run',
        destinationIdentity: Object.freeze({ dev: '1', ino: '2' }),
      })
      deps.acknowledgePortableProfileStartup = async() => {
        acknowledgements++
        return { state: 'typed-only-acknowledged' }
      }
      const coordinator = createCoordinator(deps)
      assert.deepEqual(await coordinator.start(), {
        status: 'ready', schemaVersion: testCase.phase4.schemaVersion,
      })
      await coordinator.shutdown()
      assert.equal(acknowledgements, testCase.acknowledgements)
    })
  })

  it('runs the default Phase 4 worker in prerequisite-initialize-settings order', async() => {
    const { calls, deps } = createDeps({
      initDatabase: async() => ({ ...readyResult, schemaVersion: 6 }),
      verifyPhase2Storage: async() => {},
      completePhase3Attestation: async() => { calls.push('phase3:attestation') },
    })
    delete deps.getCachePhasePrerequisite
    installProductionCache({
      getCachePhasePrerequisite: async() => {
        calls.push('cache:prerequisite')
        return { version: 1, markerName: 'legacy_data_v1.cross_artifact_complete', sourceSha256: 'f'.repeat(64), completedAtMs: 1 }
      },
      initializePhase4: async function() {
        assert.equal(arguments.length, 0)
        calls.push('cache:initialize')
        return { schemaVersion: 6, typedOwnershipVerified: false }
      },
    })

    assert.deepEqual(await createCoordinator(deps).start(), { status: 'ready', schemaVersion: 6 })
    assert.deepEqual(calls.filter(call => [
      'phase3:attestation', 'cache:prerequisite', 'cache:initialize',
      'settings:init', 'modules:register', 'app:inited',
    ].includes(call)), [
      'phase3:attestation', 'cache:prerequisite', 'cache:initialize',
      'settings:init', 'modules:register', 'app:inited',
    ])
  })

  it('keeps authoritative startup ready when the Phase 4 worker reports degraded schema 6', async() => {
    const { calls, deps } = createDeps({
      initDatabase: async() => ({ ...readyResult, schemaVersion: 6 }),
      verifyPhase2Storage: async() => {},
    })
    delete deps.getCachePhasePrerequisite
    installProductionCache({
      getCachePhasePrerequisite: async() => {
        calls.push('cache:prerequisite')
        return { version: 1, markerName: 'legacy_data_v1.cross_artifact_complete', sourceSha256: 'f'.repeat(64), completedAtMs: 1 }
      },
      initializePhase4: async() => {
        calls.push('cache:initialize:degraded')
        return { schemaVersion: 6, typedOwnershipVerified: false }
      },
    })

    assert.deepEqual(await createCoordinator(deps).start(), { status: 'ready', schemaVersion: 6 })
    assert.deepEqual(calls.filter(call => call.startsWith('cache:') || call == 'settings:init'), [
      'cache:prerequisite', 'cache:initialize:degraded', 'settings:init',
    ])
  })

  it('propagates schema 7 when the Phase 4 worker reports degraded typed ownership', async() => {
    const { calls, deps } = createDeps({
      initDatabase: async() => ({ ...readyResult, schemaVersion: 6 }),
      verifyPhase2Storage: async() => {},
    })
    delete deps.getCachePhasePrerequisite
    installProductionCache({
      getCachePhasePrerequisite: async() => {
        calls.push('cache:prerequisite')
        return { version: 1, markerName: 'legacy_data_v1.cross_artifact_complete', sourceSha256: 'f'.repeat(64), completedAtMs: 1 }
      },
      initializePhase4: async() => {
        calls.push('cache:initialize:degraded-schema7')
        return { schemaVersion: 7, typedOwnershipVerified: false }
      },
    })

    assert.deepEqual(await createCoordinator(deps).start(), { status: 'ready', schemaVersion: 7 })
    assert.deepEqual(calls.filter(call => call.startsWith('cache:') || call == 'settings:init'), [
      'cache:prerequisite', 'cache:initialize:degraded-schema7', 'settings:init',
    ])
  })

  it('maps malformed production Phase 4 results to a fixed fatal code', async() => {
    const cases = [
      { name: 'malformed', result: { status: 'complete' } },
      { name: 'missing ownership', result: { schemaVersion: 6 } },
      { name: 'impossible ownership', result: { schemaVersion: 6, typedOwnershipVerified: true } },
      { name: 'extra field', result: { schemaVersion: 7, typedOwnershipVerified: true, provider: 'legacy' } },
    ]
    for (const testCase of cases) {
      const { calls, deps } = createDeps({
        initDatabase: async() => ({ ...readyResult, schemaVersion: 6 }),
        verifyPhase2Storage: async() => {},
      })
      delete deps.getCachePhasePrerequisite
      installProductionCache({
        getCachePhasePrerequisite: async() => ({ version: 1, markerName: 'legacy_data_v1.cross_artifact_complete', sourceSha256: 'f'.repeat(64), completedAtMs: 1 }),
        initializePhase4: async() => testCase.result,
      })

      assert.deepEqual(await createCoordinator(deps).start(), { status: 'fatal', reason: 'cache_phase4_result_invalid' }, testCase.name)
      assert.equal(calls.includes('settings:init'), false, testCase.name)
    }
  })

  it('leaves a custom Phase 4 override independent of absent or partial production composition', async() => {
    for (const production of ['absent', 'partial']) {
      if (production == 'absent') delete globalThis.lx
      else installProductionCache({})
      const { calls, deps } = createDeps({
        initDatabase: async() => ({ ...readyResult, schemaVersion: 6 }),
        verifyPhase2Storage: async() => {},
        initializePhase4: async function() {
          assert.equal(arguments.length, 0)
          calls.push('custom-phase4')
          return { schemaVersion: 7, typedOwnershipVerified: true }
        },
      })

      assert.deepEqual(await createCoordinator(deps).start(), { status: 'ready', schemaVersion: 7 }, production)
      assert.equal(calls.includes('custom-phase4'), true, production)
    }
  })

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
      'run-state:unclean', 'db:init', 'migration-hooks', 'credentials:check', 'settings:init', 'modules:register', 'app:inited',
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
    assert.deepEqual(calls, ['run-state:unclean', 'db:init', 'stores:flush', 'db:close'])
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

  for (const recoveryReason of ['quick_check_failed', 'foreign_key_check_failed']) {
    it(`keeps ${recoveryReason} unclean across orderly shutdown and restart`, async() => {
      const runtimeRoot = tempDirectory(`lx-run-state-${recoveryReason}-`)
      const { createRunState } = require(runStatePath)
      const firstDeps = createDeps({
        runState: createRunState({ runtimeRoot, now: () => 100 }),
        initDatabase: async() => ({
          ...recoveryResult,
          reason: recoveryReason,
          diagnostics: [`${recoveryReason}.stable`],
        }),
      }).deps
      const firstCoordinator = createCoordinator(firstDeps)

      assert.equal((await firstCoordinator.start()).status, 'recovery')
      await firstCoordinator.shutdown()

      const previousCleanValues = []
      const secondDeps = createDeps({
        runState: createRunState({ runtimeRoot, now: () => 200 }),
        initDatabase: async previousShutdownWasClean => {
          previousCleanValues.push(previousShutdownWasClean)
          return readyResult
        },
      }).deps
      const secondCoordinator = createCoordinator(secondDeps)

      assert.deepEqual(await secondCoordinator.start(), { status: 'ready', schemaVersion: 3 })
      assert.deepEqual(previousCleanValues, [false])
    })
  }

  it('keeps an external-migration recovery unclean after orderly shutdown', async() => {
    const { calls, deps } = createDeps({
      runMigrationHooks: async() => {
        calls.push('migration-hooks')
        return {
          status: 'recovery',
          reason: 'credentials_migration_failed',
          target: {
            kind: 'external-migration',
            component: 'credentials',
            affectedPath: null,
            diagnostics: ['credentials.write_failed'],
          },
        }
      },
    })
    const coordinator = createCoordinator(deps)

    assert.equal((await coordinator.start()).status, 'recovery')
    await coordinator.shutdown()

    assert.equal(calls.includes('run-state:clean'), false)
    assert.equal(calls.includes('modules:register'), false)
    assert.equal(calls.includes('app:inited'), false)
  })

  it('keeps a fatal startup unclean after orderly shutdown', async() => {
    const { calls, deps } = createDeps({
      initSettings: async() => {
        calls.push('settings:init')
        const error = new Error('setting-secret')
        error.code = 'settings_init_failed'
        throw error
      },
    })
    const coordinator = createCoordinator(deps)

    assert.deepEqual(await coordinator.start(), { status: 'fatal', reason: 'settings_init_failed' })
    await coordinator.shutdown()

    assert.equal(calls.includes('run-state:clean'), false)
    assert.equal(calls.includes('modules:register'), false)
    assert.equal(calls.includes('app:inited'), false)
  })

  it('checkpoints a portable profile after final writes and database close so the next startup can retire the source', async() => {
    const paths = seedPortableProfile(tempDirectory('portable-clean-lifecycle'))
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(portableMigrationPath)
    const prepared = preparePortableProfile({ ...paths, runId: 'startup-1', logger: { info() {}, warn() {}, error() {} } })
    assert.equal(prepared.state, 'promoted')
    const { calls, deps } = createDeps()
    deps.initializePhase4 = async() => {
      calls.push('phase4:initialize')
      fs.writeFileSync(path.join(paths.profileRoot, 'lx.data.db'), 'typed-database')
      return { schemaVersion: 7, typedOwnershipVerified: true }
    }
    deps.portableProfileToken = prepared.token
    deps.acknowledgePortableProfileStartup = async token => {
      calls.push('portable:acknowledge')
      return await acknowledgePortableProfileStartup(token, { logger: { info() {}, warn() {}, error() {} } })
    }
    const coordinator = createCoordinator(deps)

    assert.deepEqual(await coordinator.start(), { status: 'ready', schemaVersion: 7 })
    const journalPath = path.join(paths.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'promoted')
    fs.writeFileSync(path.join(paths.profileRoot, 'settings.json'), '{"volume":0.5}')
    await coordinator.shutdown()

    assert.ok(calls.indexOf('db:close') < calls.indexOf('run-state:clean'))
    assert.ok(calls.indexOf('run-state:clean') < calls.indexOf('portable:acknowledge'))
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'typed-only-acknowledged')
    assert.equal(retireAcknowledgedPortableSource({
      ...paths,
      runId: 'startup-2',
      logger: { info() {}, warn() {}, error() {} },
    }).state, 'retired')
    assert.equal(fs.existsSync(paths.sourceRoot), false)
    assert.equal(fs.readFileSync(path.join(paths.profileRoot, 'settings.json'), 'utf8'), '{"volume":0.5}')
  })

  it('keeps an unclean post-Phase-4 profile retryable until a later clean shutdown', async() => {
    const paths = seedPortableProfile(tempDirectory('portable-unclean-lifecycle'))
    const {
      acknowledgePortableProfileStartup,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(portableMigrationPath)
    const logger = { info() {}, warn() {}, error() {} }
    const firstPreparation = preparePortableProfile({ ...paths, runId: 'startup-1', logger })
    const first = createDeps()
    first.deps.initializePhase4 = async() => {
      fs.writeFileSync(path.join(paths.profileRoot, 'lx.data.db'), 'typed-after-unclean-startup')
      return { schemaVersion: 7, typedOwnershipVerified: true }
    }
    first.deps.portableProfileToken = firstPreparation.token
    first.deps.acknowledgePortableProfileStartup = token => acknowledgePortableProfileStartup(token, { logger })
    assert.equal((await createCoordinator(first.deps).start()).status, 'ready')
    fs.writeFileSync(path.join(paths.profileRoot, 'settings.json'), '{"unclean":true}')

    assert.equal(retireAcknowledgedPortableSource({ ...paths, runId: 'startup-2', logger }).state, 'not-acknowledged')
    assert.equal(fs.existsSync(paths.sourceRoot), true)
    const retry = preparePortableProfile({ ...paths, runId: 'startup-2', logger })
    assert.equal(retry.state, 'already-promoted')
    const second = createDeps()
    second.deps.initializePhase4 = async() => ({ schemaVersion: 7, typedOwnershipVerified: true })
    second.deps.portableProfileToken = retry.token
    second.deps.acknowledgePortableProfileStartup = token => acknowledgePortableProfileStartup(token, { logger })
    const retryCoordinator = createCoordinator(second.deps)
    assert.equal((await retryCoordinator.start()).status, 'ready')
    await retryCoordinator.shutdown()

    assert.equal(retireAcknowledgedPortableSource({ ...paths, runId: 'startup-3', logger }).state, 'retired')
    assert.equal(fs.readFileSync(path.join(paths.profileRoot, 'settings.json'), 'utf8'), '{"unclean":true}')
  })

  it('does not acknowledge a portable profile after any unclean startup or shutdown path', async t => {
    const scenarios = [
      {
        name: 'startup failure after Phase 4',
        configure(deps) {
          deps.initSettings = async() => { throw new Error('settings_failed') }
        },
        expectStartup: 'fatal',
      },
      {
        name: 'failed shutdown flusher',
        configure(_deps, coordinator) {
          coordinator.registerShutdownFlusher('failed', async() => { throw new Error('flusher_failed') })
        },
        shutdownRejects: true,
      },
      {
        name: 'timed-out shutdown flusher',
        configure(deps, coordinator) {
          deps.shutdownTimeoutMs = 20
          coordinator.registerShutdownFlusher('blocked', async() => await new Promise(() => {}))
        },
        shutdownRejects: true,
      },
      {
        name: 'store flush failure',
        configure(deps) {
          deps.flushStores = async() => { throw new Error('store_flush_failed') }
        },
        shutdownRejects: true,
      },
      {
        name: 'database close failure',
        configure(deps) {
          deps.closeDatabase = async() => { throw new Error('database_close_failed') }
        },
        shutdownRejects: true,
      },
      {
        name: 'clean-run marker failure',
        configure(deps) {
          deps.runState.markClean = async() => { throw new Error('run_state_clean_failed') }
        },
        shutdownRejects: true,
      },
    ]

    for (const scenario of scenarios) {
      await t.test(scenario.name, async() => {
        let acknowledgements = 0
        const { deps } = createDeps({ shutdownTimeoutMs: 20 })
        deps.initializePhase4 = async() => ({ schemaVersion: 7, typedOwnershipVerified: true })
        deps.portableProfileToken = Object.freeze({
          version: 1,
          portableRoot: 'C:\\portable-fixture',
          promotionRunId: 'promotion-run',
          startupRunId: 'startup-run',
          destinationIdentity: Object.freeze({ dev: '1', ino: '2' }),
        })
        deps.acknowledgePortableProfileStartup = async() => {
          acknowledgements++
          return { state: 'typed-only-acknowledged' }
        }
        const coordinator = createCoordinator(deps)
        scenario.configure(deps, coordinator)
        const outcome = await coordinator.start()
        assert.equal(outcome.status, scenario.expectStartup ?? 'ready')
        if (scenario.shutdownRejects) await assert.rejects(coordinator.shutdown())
        else await coordinator.shutdown()
        assert.equal(acknowledgements, 0)
      })
    }
  })

  it('keeps the portable journal retryable when acknowledgement fails after the clean marker', async() => {
    const paths = seedPortableProfile(tempDirectory('portable-ack-failure'))
    const {
      PORTABLE_PROFILE_JOURNAL_FILE,
      preparePortableProfile,
      retireAcknowledgedPortableSource,
    } = require(portableMigrationPath)
    const logger = { info() {}, warn() {}, error() {} }
    const prepared = preparePortableProfile({ ...paths, runId: 'startup-1', logger })
    const { calls, deps } = createDeps()
    deps.initializePhase4 = async() => ({ schemaVersion: 7, typedOwnershipVerified: true })
    deps.portableProfileToken = prepared.token
    deps.acknowledgePortableProfileStartup = async() => {
      calls.push('portable:acknowledge')
      throw new Error('portable_acknowledgement_failed')
    }
    const coordinator = createCoordinator(deps)
    assert.equal((await coordinator.start()).status, 'ready')

    await assert.rejects(coordinator.shutdown(), /portable_acknowledgement_failed/)

    assert.ok(calls.indexOf('db:close') < calls.indexOf('run-state:clean'))
    assert.ok(calls.indexOf('run-state:clean') < calls.indexOf('portable:acknowledge'))
    assert.equal(calls.filter(call => call == 'run-state:clean').length, 1)
    const journalPath = path.join(paths.portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
    assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).state, 'promoted')
    assert.equal(fs.existsSync(paths.sourceRoot), true)
    assert.equal(retireAcknowledgedPortableSource({ ...paths, runId: 'startup-2', logger }).state, 'not-acknowledged')
    assert.equal(preparePortableProfile({ ...paths, runId: 'startup-2', logger }).state, 'already-promoted')
  })

  it('uses the exact portable token and finalizer captured when startup reached ready', async() => {
    const originalToken = Object.freeze({
      version: 1,
      portableRoot: 'C:\\portable-fixture',
      promotionRunId: 'promotion-original',
      startupRunId: 'startup-original',
      destinationIdentity: Object.freeze({ dev: '1', ino: '2' }),
    })
    const replacementToken = Object.freeze({
      ...originalToken,
      promotionRunId: 'promotion-replacement',
    })
    const acknowledgements = []
    const { deps } = createDeps()
    deps.initializePhase4 = async() => ({ schemaVersion: 7, typedOwnershipVerified: true })
    deps.portableProfileToken = originalToken
    deps.acknowledgePortableProfileStartup = async token => {
      acknowledgements.push(['original', token])
      return { state: 'typed-only-acknowledged' }
    }
    const coordinator = createCoordinator(deps)
    assert.equal((await coordinator.start()).status, 'ready')
    deps.portableProfileToken = replacementToken
    deps.acknowledgePortableProfileStartup = async token => {
      acknowledgements.push(['replacement', token])
      return { state: 'typed-only-acknowledged' }
    }

    await coordinator.shutdown()

    assert.deepEqual(acknowledgements, [['original', originalToken]])
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

  it('cleans the owned run after database close while preserving the first shutdown failure', async() => {
    // Catches an early shutdown throw that skips temp cleanup, or cleanup that replaces the first failure.
    const fixtureRoot = tempDirectory('shutdown-temp-cleanup')
    const tempRoot = path.join(fixtureRoot, 'temp')
    const runTempRoot = path.join(tempRoot, 'run-current')
    await fsp.mkdir(runTempRoot, { recursive: true })
    const storagePathsModule = loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts'))
    const { createRunTempHandle } = loadTsModule(path.join(__dirname, '../../src/main/utils/tempLifecycle.ts'), {
      '@main/utils/storagePaths': storagePathsModule,
    })
    const handle = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
    const firstFailure = new Error('first_store_failure')
    const { calls, deps } = createDeps({
      flushStores: async() => {
        calls.push('stores:flush')
        throw firstFailure
      },
      closeDatabase: async() => {
        calls.push('db:close')
        throw new Error('later_database_failure')
      },
      cleanupTempLifecycle: async() => {
        calls.push('temp:cleanup')
        await handle.cleanup()
      },
    })
    const coordinator = createCoordinator(deps)
    await coordinator.start()
    calls.length = 0

    await assert.rejects(coordinator.shutdown(), error => error === firstFailure)

    assert.deepEqual(calls, ['stores:flush', 'db:close', 'temp:cleanup'])
    assert.equal(fs.existsSync(runTempRoot), false)
  })

  it('cleans the owned run when marking the run clean fails', async() => {
    // Catches a post-database markClean rejection that bypasses the temp lifecycle finally block.
    const fixtureRoot = tempDirectory('shutdown-mark-cleanup')
    const tempRoot = path.join(fixtureRoot, 'temp')
    const runTempRoot = path.join(tempRoot, 'run-current')
    await fsp.mkdir(runTempRoot, { recursive: true })
    const storagePathsModule = loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts'))
    const { createRunTempHandle } = loadTsModule(path.join(__dirname, '../../src/main/utils/tempLifecycle.ts'), {
      '@main/utils/storagePaths': storagePathsModule,
    })
    const handle = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
    const markFailure = new Error('run_state_clean_failed')
    const { calls, deps } = createDeps({
      cleanupTempLifecycle: async() => {
        calls.push('temp:cleanup')
        await handle.cleanup()
      },
    })
    deps.runState.markClean = async() => {
      calls.push('run-state:clean')
      throw markFailure
    }
    const coordinator = createCoordinator(deps)
    await coordinator.start()
    calls.length = 0

    await assert.rejects(coordinator.shutdown(), error => error === markFailure)

    assert.deepEqual(calls, ['stores:flush', 'db:close', 'run-state:clean', 'temp:cleanup'])
    assert.equal(fs.existsSync(runTempRoot), false)
  })

  it('rejects when temp cleanup is the only shutdown failure', async() => {
    // Catches cleanup errors that are recorded after the last throw check and then silently resolved.
    const cleanupFailure = new Error('shutdown_temp_cleanup_failed')
    const { calls, deps } = createDeps({
      cleanupTempLifecycle: async() => {
        calls.push('temp:cleanup')
        throw cleanupFailure
      },
    })
    const coordinator = createCoordinator(deps)
    await coordinator.start()
    calls.length = 0

    await assert.rejects(coordinator.shutdown(), error => error === cleanupFailure)

    assert.deepEqual(calls, ['stores:flush', 'db:close', 'run-state:clean', 'temp:cleanup'])
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
      cacheRoot: 'C:\\profiles\\alice-cache',
      backupsRoot: 'C:\\profiles\\alice\\LxDatas\\backups',
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    }

    assert.deepEqual(await adapter.init(options), readyResult)
    assert.strictEqual(exposed.init, adapter.init)
    assert.deepEqual(received, [options])
    assert.equal(typeof adapter.initForWorker, 'undefined')
  })
})

describe('storage run state', () => {
  it('cleans only exact stale run-state owned temps before its first read', async() => {
    const runtimeRoot = tempDirectory('lx-run-state-cleanup-')
    const target = path.join(runtimeRoot, 'run-state.v1.json')
    const staleTemp = `${target}.owned-tmp-712-4`
    const nextFile = `${target}.next`
    const previousFile = `${target}.previous`
    const otherWriterTemp = path.join(runtimeRoot, 'other.json.owned-tmp-712-4')
    fs.writeFileSync(staleTemp, 'stale')
    fs.writeFileSync(nextFile, '{"version":1}')
    fs.writeFileSync(previousFile, '{"version":1}')
    fs.writeFileSync(otherWriterTemp, 'keep')
    const { createRunState } = require(runStatePath)

    assert.equal(await createRunState({ runtimeRoot, now: () => 100 }).begin(), false)

    assert.equal(fs.existsSync(staleTemp), false)
    assert.equal(fs.existsSync(nextFile), true)
    assert.equal(fs.existsSync(previousFile), true)
    assert.equal(fs.existsSync(otherWriterTemp), true)
  })

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
  it('opens the changed sync metadata folder without disclosing replacement content', async() => {
    const openedPaths = []
    const messages = []
    let quitCalls = 0
    const affectedPath = path.join('C:\\profiles\\fixture', 'sync', 'client', 'servers.v1.json')
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
        reason: 'credential_startup_check_failed',
        target: {
          kind: 'external-migration',
          component: 'credentials',
          affectedPath,
          diagnostics: ['credentials.sync_metadata_changed_after_inventory'],
        },
      })
    } finally {
      Module._load = originalLoad
    }

    assert.deepEqual(messages[0].buttons, ['Open data folder', 'Quit'])
    assert.match(messages[0].detail, /credentials\.sync_metadata_changed_after_inventory/)
    assert.equal(messages[0].detail.includes('REPLACEMENT_KEY_SENTINEL'), false)
    assert.deepEqual(openedPaths, [path.dirname(affectedPath)])
    assert.equal(quitCalls, 1)
  })

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

  it('omits the data-folder action when the recovery target has no usable path', async() => {
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
        reason: 'credential_startup_check_failed',
        target: {
          kind: 'external-migration',
          component: 'credentials',
          affectedPath: null,
          diagnostics: ['credentials.vault_unreadable'],
        },
      })
    } finally {
      Module._load = originalLoad
    }

    assert.deepEqual(messages[0].buttons, ['Quit'])
    assert.equal(messages[0].defaultId, 0)
    assert.deepEqual(openedPaths, [])
    assert.equal(quitCalls, 1)
  })
})
