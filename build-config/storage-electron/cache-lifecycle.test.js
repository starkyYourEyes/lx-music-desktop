const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// Electron ABI tests transpile the source modules in-process.
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

const Database = require('better-sqlite3')
const dbService = require('../../src/main/worker/dbService/db.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const cacheModulePath = '../../src/main/worker/dbService/cacheDb.ts'
const workerIndexPath = '../../src/main/worker/dbService/index.ts'
const coordinatorPath = '../../src/main/startup/storageCoordinator.ts'
const fixtures = []
const cacheServices = []
let originalGlobalLx

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const marker = () => {
  const detailsJson = canonical({
    version: 1,
    checks: [
      { name: 'credentials', version: 1, state: 'complete', evidenceSha256: 'a'.repeat(64) },
      { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: 'b'.repeat(64) },
      { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: 'c'.repeat(64) },
      { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: 'd'.repeat(64) },
      { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: 'e'.repeat(64) },
      { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: 'f'.repeat(64) },
      { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: '0'.repeat(64) },
    ],
  })
  return {
    name: 'legacy_data_v1.cross_artifact_complete',
    sourceSha256: crypto.createHash('sha256').update(detailsJson).digest('hex'),
    completedAtMs: 1,
    detailsJson,
  }
}

const loadCacheModule = () => {
  try {
    return require(cacheModulePath)
  } catch (error) {
    if (error?.code == 'MODULE_NOT_FOUND' && String(error.message).includes('cacheDb')) {
      assert.fail('serialized cache lifecycle module is not implemented')
    }
    throw error
  }
}

const createService = options => {
  const service = loadCacheModule().createCacheDatabaseService(options)
  cacheServices.push(service)
  return service
}

const createFixture = async(prefix = 'cache-lifecycle') => {
  const fixture = createTestStorageRoot(prefix)
  fixtures.push(fixture)
  const profileRoot = path.join(fixture.path, 'profile')
  const cacheRoot = path.join(fixture.path, 'cache')
  const appDbPath = path.join(profileRoot, 'lx.data.db')
  const startup = await dbService.init({
    dataPath: profileRoot,
    cacheRoot,
    backupsRoot: path.join(fixture.path, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(startup.status, 'ready', JSON.stringify(startup))
  const value = marker()
  dbService.getAppDB().prepare(`
    INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(value.name, value.sourceSha256, value.completedAtMs, value.detailsJson)
  return { fixture, cacheRoot, cachePath: path.join(cacheRoot, 'cache.db'), appDbPath }
}

const isSettled = async promise => {
  const unsettled = Symbol('unsettled')
  return await Promise.race([
    promise.then(() => true, () => true),
    new Promise(resolve => setImmediate(() => resolve(unsettled))),
  ]) !== unsettled
}

afterEach(async() => {
  for (const service of cacheServices.splice(0).reverse()) {
    try { await service.closeCacheDatabase() } catch {}
  }
  try { dbService.close() } catch {}
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
  try { delete require.cache[require.resolve(cacheModulePath)] } catch {}
  try { delete require.cache[require.resolve(workerIndexPath)] } catch {}
  try { delete require.cache[require.resolve(coordinatorPath)] } catch {}
  if (originalGlobalLx === undefined) delete globalThis.lx
  else globalThis.lx = originalGlobalLx
  originalGlobalLx = undefined
})

const seedRawLyric = db => {
  db.prepare(`
    INSERT INTO raw_lyric_groups(
      provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
    ) VALUES ('tx', 'track-1', 5, 1, 1)
  `).run()
  db.prepare(`
    INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size)
    VALUES ('tx', 'track-1', 'lyric', 'hello', 5)
  `).run()
}

const createProductionCoordinator = (overrides = {}) => {
  const { createStorageCoordinator } = require(coordinatorPath)
  return createStorageCoordinator({
    runState: { begin: async() => true, markClean: async() => {} },
    initDatabase: async() => ({
      status: 'ready', existed: true, schemaVersion: 6, migratedVersions: [], backupPath: null,
    }),
    closeDatabase: async() => {},
    runMigrationHooks: async() => undefined,
    checkCredentials: async() => ({
      vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [],
    }),
    verifyPhase2Storage: async() => {},
    interruptStalePlaybackSessions: async() => 0,
    runPlaybackTypedSmoke: async() => ({
      version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64),
    }),
    getPhase3AttestationPrerequisites: async() => ({ version: 1 }),
    completePhase3Attestation: async() => {},
    initSettings: async() => {},
    registerModules: () => {},
    appInited: () => {},
    showRecovery: async() => {},
    flushStores: async() => {},
    ...overrides,
  })
}

describe('serialized cache lifecycle', () => {
  it('maps only nullish reads to misses and completes writes and immediate transactions inside the FIFO gate', async() => {
    await createFixture()
    const service = createService()
    assert.equal((await service.openCacheDatabase()).status, 'created')
    const order = []

    const write = service.runCacheWrite(db => {
      order.push('write')
      seedRawLyric(db)
    })
    const read = service.runCacheRead(db => {
      order.push('read')
      return db.prepare(`
        SELECT text FROM raw_lyrics
        WHERE provider = ? AND source_track_id = ? AND lyric_type = ?
      `).get('tx', 'track-1', 'lyric')?.text
    })
    const immediate = service.runCacheImmediate(db => {
      order.push('prune')
      return db.prepare('DELETE FROM raw_lyric_groups WHERE provider = ?').run('tx').changes
    })

    assert.deepEqual(await write, { status: 'stored' })
    assert.deepEqual(await read, { status: 'hit', value: 'hello' })
    assert.deepEqual(await immediate, { status: 'completed', value: 1 })
    assert.deepEqual(order, ['write', 'read', 'prune'])
    assert.deepEqual(await service.runCacheRead(() => null), { status: 'miss' })
    assert.deepEqual(await service.runCacheRead(() => undefined), { status: 'miss' })
    assert.deepEqual(await service.runCacheRead(() => 0), { status: 'hit', value: 0 })
    assert.deepEqual(await service.runCacheRead(() => false), { status: 'hit', value: false })
    assert.deepEqual(await service.runCacheRead(() => ''), { status: 'hit', value: '' })
  })

  it('queues cache RPC behind one reset lease and rejects foreign, stale, and reused leases', async() => {
    await createFixture()
    const service = createService({ randomUUID: () => '11111111-1111-4111-8111-111111111111' })
    assert.equal((await service.openCacheDatabase()).status, 'created')
    const lease = await service.beginCacheReset()
    assert.deepEqual(lease, { resetId: '11111111-1111-4111-8111-111111111111' })
    assert.equal(await service.getCacheLifecycleState(), 'resetting')
    const pendingRead = service.runCacheRead(db => db.prepare(`
      SELECT text FROM raw_lyrics
      WHERE provider = ? AND source_track_id = ? AND lyric_type = ?
    `).get('tx', 'missing', 'lyric')?.text)

    assert.equal(await isSettled(pendingRead), false)
    await assert.rejects(
      service.finishCacheReset({ resetId: '22222222-2222-4222-8222-222222222222' }),
      error => error?.code == 'cache_operation_failed' && error?.message == 'cache_operation_failed',
    )
    assert.equal(await isSettled(pendingRead), false)
    assert.equal((await service.finishCacheReset(lease)).status, 'ready')
    assert.deepEqual(await pendingRead, { status: 'miss' })
    await assert.rejects(service.finishCacheReset(lease), error => error?.code == 'cache_operation_failed')
    await assert.rejects(
      service.finishCacheReset({ resetId: '11111111-1111-4111-8111-111111111111', extra: true }),
      error => error?.code == 'cache_operation_failed',
    )
  })

  it('serializes concurrent open, reset, read, write, and prune work in call order', async() => {
    await createFixture()
    const service = createService()
    const firstOpen = service.openCacheDatabase()
    const secondOpen = service.openCacheDatabase()
    const reset = service.beginCacheReset()

    assert.equal((await firstOpen).status, 'created')
    assert.equal((await secondOpen).status, 'ready')
    const lease = await reset
    const order = []
    const write = service.runCacheWrite(() => { order.push('write') })
    const read = service.runCacheRead(() => { order.push('read'); return 'value' })
    const prune = service.runCacheImmediate(() => { order.push('prune'); return 3 })
    assert.equal(await isSettled(write), false)
    assert.equal(await isSettled(read), false)
    assert.equal(await isSettled(prune), false)

    assert.equal((await service.finishCacheReset(lease)).status, 'ready')
    assert.deepEqual(await Promise.all([write, read, prune]), [
      { status: 'stored' },
      { status: 'hit', value: 'value' },
      { status: 'completed', value: 3 },
    ])
    assert.deepEqual(order, ['write', 'read', 'prune'])
  })

  it('aborts only the exact active reset lease, releases queued work, and never opens a fresh database', async() => {
    await createFixture('cache-abort-reset')
    let opens = 0
    class CountingDatabase {
      constructor(filename, options) {
        opens++
        return new Database(filename, options)
      }
    }
    const service = createService({
      DatabaseImplementation: CountingDatabase,
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
    })
    assert.equal((await service.openCacheDatabase()).status, 'created')
    const lease = await service.beginCacheReset()
    const queued = service.runCacheRead(() => assert.fail('queued callback ran after reset abort'))
    assert.equal(await isSettled(queued), false)
    assert.equal(typeof service.abortCacheReset, 'function')

    await assert.rejects(
      service.abortCacheReset({ resetId: '22222222-2222-4222-8222-222222222222' }),
      error => error?.code == 'cache_operation_failed' && error?.message == 'cache_operation_failed',
    )
    assert.equal(await isSettled(queued), false)
    await service.abortCacheReset(lease)

    assert.equal(opens, 1)
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
    assert.deepEqual(await queued, { status: 'unavailable', code: 'cache_delete_failed' })
    await assert.rejects(service.abortCacheReset(lease), error => error?.code == 'cache_operation_failed')
  })

  it('maps repository callback errors to fixed diagnostics, closes the handle, and disables later work', async(t) => {
    const cases = [
      { code: 'PRIVATE_CALLBACK_6F10', expected: 'cache_operation_failed' },
      { code: 'SQLITE_FULL', expected: 'cache_capacity_unavailable' },
      { code: 'SQLITE_CORRUPT', expected: 'cache_integrity_failed' },
      { code: 'cache_schema_invalid', expected: 'cache_schema_invalid' },
    ]
    for (const testCase of cases) {
      await t.test(testCase.code, async() => {
        const { cachePath } = await createFixture('cache-callback')
        const destructiveCalls = []
        const guardedFs = {
          ...fs,
          renameSync(source, destination) {
            destructiveCalls.push(['rename', path.resolve(source), path.resolve(destination)])
            return fs.renameSync(source, destination)
          },
          unlinkSync(filename) {
            destructiveCalls.push(['unlink', path.resolve(filename)])
            return fs.unlinkSync(filename)
          },
          chmodSync(filename, mode) {
            destructiveCalls.push(['chmod', path.resolve(filename)])
            return fs.chmodSync(filename, mode)
          },
        }
        const service = createService({ fileSystem: guardedFs })
        assert.equal((await service.openCacheDatabase()).status, 'created')
        destructiveCalls.length = 0
        const before = fs.lstatSync(cachePath, { bigint: true })
        const result = await service.runCacheRead(() => {
          throw Object.assign(new Error(`music-url-secret-${testCase.code}`), { code: testCase.code })
        })

        assert.deepEqual(result, { status: 'unavailable', code: testCase.expected })
        assert.deepEqual(destructiveCalls, [])
        const after = fs.lstatSync(cachePath, { bigint: true })
        assert.deepEqual({ dev: after.dev, ino: after.ino }, { dev: before.dev, ino: before.ino })
        assert.equal(JSON.stringify(result).includes('music-url-secret'), false)
        assert.equal(await service.getCacheLifecycleState(), 'unavailable')
        assert.deepEqual(await service.runCacheWrite(() => assert.fail('disabled write ran')), {
          status: 'unavailable', code: testCase.expected,
        })

        await service.closeCacheDatabase()
        dbService.close()
      })
    }
  })

  it('rolls back an immediate callback before entering unavailable', async() => {
    const { cachePath } = await createFixture('cache-immediate-rollback')
    const service = createService()
    assert.equal((await service.openCacheDatabase()).status, 'created')

    assert.deepEqual(await service.runCacheImmediate(db => {
      seedRawLyric(db)
      throw Object.assign(new Error('rollback-private-payload'), { code: 'ROLLBACK_INJECTED' })
    }), { status: 'unavailable', code: 'cache_operation_failed' })

    const inspection = new Database(cachePath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(inspection.prepare('SELECT count(*) count FROM raw_lyric_groups').get().count, 0)
      assert.equal(inspection.prepare('SELECT count(*) count FROM raw_lyrics').get().count, 0)
    } finally {
      inspection.close()
    }
  })

  it('rolls back synchronous writes when an immediate callback returns a thenable', async() => {
    const { cachePath } = await createFixture('cache-immediate-thenable-rollback')
    class CommitThenableDatabase {
      constructor(filename, options) {
        const db = new Database(filename, options)
        const nativeTransaction = db.transaction.bind(db)
        db.transaction = operation => {
          const run = mode => (...args) => {
            let value
            nativeTransaction((...operationArgs) => {
              value = operation(...operationArgs)
            })[mode](...args)
            return value
          }
          const transaction = run('default')
          transaction.deferred = run('deferred')
          transaction.immediate = run('immediate')
          transaction.exclusive = run('exclusive')
          return transaction
        }
        return db
      }
    }
    const service = createService({ DatabaseImplementation: CommitThenableDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')

    assert.deepEqual(await service.runCacheImmediate(async db => {
      db.prepare(`
        INSERT INTO raw_lyric_groups(
          provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms
        ) VALUES ('async-tx', 'must-roll-back', 0, 1, 1)
      `).run()
      await Promise.resolve()
      return 'unexpected'
    }), { status: 'unavailable', code: 'cache_operation_failed' })

    const inspection = new Database(cachePath, { readonly: true, fileMustExist: true })
    try {
      assert.equal(inspection.prepare(`
        SELECT count(*) count FROM raw_lyric_groups
        WHERE provider = 'async-tx' AND source_track_id = 'must-roll-back'
      `).get().count, 0)
    } finally {
      inspection.close()
    }
  })

  it('detects target replacement before a repository callback and never deletes the replacement', async() => {
    const { fixture, cachePath } = await createFixture('cache-callback-swap')
    let activeDb
    class CapturingDatabase {
      constructor(filename, options) {
        activeDb = new Database(filename, options)
        return activeDb
      }
    }
    const service = createService({ DatabaseImplementation: CapturingDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')
    const parked = path.join(fixture.path, 'parked.db')
    const external = path.join(fixture.path, 'external.db')
    fs.copyFileSync(cachePath, external)
    const before = crypto.createHash('sha256').update(fs.readFileSync(external)).digest('hex')
    // Windows does not permit replacing an open SQLite file. Closing only the captured
    // test handle leaves the lifecycle's recorded identity stale and exercises the same guard.
    if (process.platform == 'win32') activeDb.close()
    fs.renameSync(cachePath, parked)
    fs.linkSync(external, cachePath)

    assert.deepEqual(await service.runCacheRead(() => assert.fail('callback ran after target swap')), {
      status: 'unavailable', code: 'cache_target_invalid',
    })
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(external)).digest('hex'), before)
    assert.equal(fs.existsSync(parked), true)
  })

  it('revalidates target ownership on an already-ready open', async() => {
    const { fixture, cachePath } = await createFixture('cache-ready-open-swap')
    let activeDb
    class CapturingDatabase {
      constructor(filename, options) {
        activeDb = new Database(filename, options)
        return activeDb
      }
    }
    const service = createService({ DatabaseImplementation: CapturingDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')
    const parked = path.join(fixture.path, 'parked-ready.db')
    const external = path.join(fixture.path, 'external-ready.db')
    fs.copyFileSync(cachePath, external)
    const before = crypto.createHash('sha256').update(fs.readFileSync(external)).digest('hex')
    if (process.platform == 'win32') activeDb.close()
    fs.renameSync(cachePath, parked)
    fs.linkSync(external, cachePath)

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_target_invalid',
    })
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(external)).digest('hex'), before)
    assert.equal(fs.existsSync(parked), true)
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
  })

  it('retains a failed-open handle until a later lifecycle close succeeds', async() => {
    await createFixture('cache-open-close-fault')
    let nativeDb
    let closeCalls = 0
    let failConfiguration = true
    class OpenThenFailDatabase {
      constructor(filename, options) {
        nativeDb = new Database(filename, options)
        return new Proxy(nativeDb, {
          get(target, property) {
            if (property == 'pragma') {
              return (...args) => {
                if (failConfiguration && args[0] == 'foreign_keys = ON') {
                  failConfiguration = false
                  throw Object.assign(new Error('private-open-config-failure'), { code: 'EIO' })
                }
                return target.pragma(...args)
              }
            }
            if (property == 'close') {
              return () => {
                closeCalls++
                if (closeCalls == 1) {
                  throw Object.assign(new Error('private-open-close-failure'), { code: 'EIO' })
                }
                return target.close()
              }
            }
            const value = Reflect.get(target, property)
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const service = createService({ DatabaseImplementation: OpenThenFailDatabase })

    try {
      assert.deepEqual(await service.openCacheDatabase(), {
        status: 'unavailable', schemaVersion: null, diagnostic: 'cache_close_failed',
      })
      assert.equal(nativeDb.open, true)

      await service.closeCacheDatabase()

      assert.equal(closeCalls, 2)
      assert.equal(nativeDb.open, false)
      assert.equal(await service.getCacheLifecycleState(), 'closed')
    } finally {
      if (nativeDb?.open) nativeDb.close()
    }
  })

  it('reports a close error without retaining a handle that became closed', async() => {
    await createFixture('cache-closed-then-throw')
    let nativeDb
    let closeCalls = 0
    class CloseThenThrowDatabase {
      constructor(filename, options) {
        nativeDb = new Database(filename, options)
        return new Proxy(nativeDb, {
          get(target, property) {
            if (property == 'close') {
              return () => {
                closeCalls++
                target.close()
                throw Object.assign(new Error('private-post-close-error'), { code: 'EIO' })
              }
            }
            const value = Reflect.get(target, property)
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const service = createService({ DatabaseImplementation: CloseThenThrowDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')

    await assert.rejects(service.closeCacheDatabase(), error =>
      error?.code == 'cache_close_failed' && error?.message == 'cache_close_failed')
    assert.equal(nativeDb.open, false)
    assert.equal(closeCalls, 1)
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')

    await service.closeCacheDatabase()
    assert.equal(closeCalls, 1)
    assert.equal(await service.getCacheLifecycleState(), 'closed')
  })

  it('does not replace an active handle that remains open after close failure', async() => {
    await createFixture('cache-active-close-retry')
    let constructions = 0
    let closeCalls = 0
    let allowClose = false
    class RetryableCloseDatabase {
      constructor(filename, options) {
        constructions++
        const db = new Database(filename, options)
        return new Proxy(db, {
          get(target, property) {
            if (property == 'close') {
              return () => {
                closeCalls++
                if (!allowClose) throw Object.assign(new Error('private-active-close-error'), { code: 'EIO' })
                return target.close()
              }
            }
            const value = Reflect.get(target, property)
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const service = createService({ DatabaseImplementation: RetryableCloseDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')
    assert.deepEqual(await service.runCacheRead(() => {
      throw Object.assign(new Error('private-operation-error'), { code: 'EIO' })
    }), { status: 'unavailable', code: 'cache_close_failed' })
    assert.equal(constructions, 1)
    assert.equal(closeCalls, 1)

    assert.deepEqual(await service.openCacheDatabase(), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_close_failed',
    })
    assert.equal(constructions, 1)
    assert.equal(closeCalls, 2)

    allowClose = true
    const reopened = await service.openCacheDatabase()
    assert.equal(['ready', 'recreated'].includes(reopened.status), true)
    assert.equal(reopened.schemaVersion, 1)
    assert.equal(reopened.diagnostic, null)
  })

  it('releases queued work as unavailable when cache close fails during reset', async() => {
    await createFixture('cache-close-fault')
    let closeCalls = 0
    class CloseOnceDatabase {
      constructor(filename, options) {
        const db = new Database(filename, options)
        return new Proxy(db, {
          get(target, property) {
            if (property == 'close') {
              return () => {
                closeCalls++
                if (closeCalls == 1) throw Object.assign(new Error('private-close-secret'), { code: 'EIO' })
                return target.close()
              }
            }
            const value = Reflect.get(target, property)
            return typeof value == 'function' ? value.bind(target) : value
          },
        })
      }
    }
    const service = createService({ DatabaseImplementation: CloseOnceDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')

    await assert.rejects(service.beginCacheReset(), error =>
      error?.code == 'cache_close_failed' && !String(error.message).includes('private-close'))
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
    assert.deepEqual(await service.runCacheRead(() => 'not-run'), {
      status: 'unavailable', code: 'cache_close_failed',
    })
    await service.closeCacheDatabase()
    assert.equal(closeCalls, 2)
  })

  it('reopens in the reset finally path and releases queued work after reopen failure', async() => {
    await createFixture('cache-reopen-fault')
    let opens = 0
    class ReopenFailureDatabase {
      constructor(filename, options) {
        opens++
        if (opens == 2) throw Object.assign(new Error('private-reopen-secret'), { code: 'EIO' })
        return new Database(filename, options)
      }
    }
    const service = createService({ DatabaseImplementation: ReopenFailureDatabase })
    assert.equal((await service.openCacheDatabase()).status, 'created')
    const lease = await service.beginCacheReset()
    const queued = service.runCacheRead(() => 'not-run')
    assert.equal(await isSettled(queued), false)

    assert.deepEqual(await service.finishCacheReset(lease), {
      status: 'unavailable', schemaVersion: null, diagnostic: 'cache_reopen_failed',
    })
    assert.deepEqual(await queued, { status: 'unavailable', code: 'cache_reopen_failed' })
    assert.equal(await service.getCacheLifecycleState(), 'unavailable')
  })

  it('exposes lifecycle methods through the worker without exposing handles or callback gates', () => {
    loadCacheModule()
    const cacheLifecycle = require('../../src/main/worker/dbService/modules/cacheLifecycle/index.ts')
    const indexPath = require.resolve(workerIndexPath)
    delete require.cache[indexPath]
    const originalLoad = Module._load
    let exposed
    Module._load = function(request, parent, isMain) {
      if (request == '../utils/worker') return { exposeWorker: value => { exposed = value } }
      if (request == './modules/index') return { cacheLifecycle }
      return originalLoad.call(this, request, parent, isMain)
    }
    try {
      require(indexPath)
    } finally {
      Module._load = originalLoad
      delete require.cache[indexPath]
    }

    for (const method of [
      'openCacheDatabase', 'beginCacheReset', 'finishCacheReset', 'abortCacheReset', 'getCacheLifecycleState',
    ]) {
      assert.equal(typeof exposed[method], 'function')
    }
    for (const privateName of [
      'runCacheRead', 'runCacheWrite', 'runCacheImmediate', 'closeCacheDatabase',
      'createCacheDatabaseService', 'getCacheDatabaseHandle',
    ]) {
      assert.equal(exposed[privateName], undefined)
    }
  })

  it('initializes production Phase 4 after the coordinator gate and keeps degraded cache startup authoritative-ready', async() => {
    originalGlobalLx = globalThis.lx
    const calls = []
    globalThis.lx = {
      worker: {
        dbService: {
          getCachePhasePrerequisite: async() => {
            calls.push('cache:prerequisite')
            return {
              version: 1,
              markerName: 'legacy_data_v1.cross_artifact_complete',
              sourceSha256: 'f'.repeat(64),
              completedAtMs: 1,
            }
          },
          initializePhase4: async function() {
            assert.equal(arguments.length, 0)
            calls.push('cache:initialize')
            return { schemaVersion: 6, typedOwnershipVerified: false }
          },
        },
      },
    }
    const { createStorageCoordinator } = require(coordinatorPath)
    const coordinator = createStorageCoordinator({
      runState: { begin: async() => true, markClean: async() => {} },
      initDatabase: async() => ({
        status: 'ready', existed: true, schemaVersion: 6, migratedVersions: [], backupPath: null,
      }),
      closeDatabase: async() => {},
      runMigrationHooks: async() => undefined,
      checkCredentials: async() => ({
        vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [],
      }),
      verifyPhase2Storage: async() => {},
      interruptStalePlaybackSessions: async() => 0,
      runPlaybackTypedSmoke: async() => ({
        version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64),
      }),
      getPhase3AttestationPrerequisites: async() => ({ version: 1 }),
      completePhase3Attestation: async() => { calls.push('phase3:complete') },
      initSettings: async() => { calls.push('settings:init') },
      registerModules: () => {},
      appInited: () => {},
      showRecovery: async() => {},
      flushStores: async() => {},
    })

    assert.deepEqual(await coordinator.start(), { status: 'ready', schemaVersion: 6 })
    assert.deepEqual(calls, [
      'phase3:complete', 'cache:prerequisite', 'cache:initialize', 'settings:init',
    ])
  })

  it('rejects an unknown production Phase 4 payload at the coordinator boundary', async() => {
    originalGlobalLx = globalThis.lx
    let settingsCalls = 0
    globalThis.lx = {
      worker: {
        dbService: {
          getCachePhasePrerequisite: async() => ({
            version: 1,
            markerName: 'legacy_data_v1.cross_artifact_complete',
            sourceSha256: 'f'.repeat(64),
            completedAtMs: 1,
          }),
          initializePhase4: async() => ({
            status: 'unavailable', code: 'private-cache-worker-payload',
          }),
        },
      },
    }
    const { createStorageCoordinator } = require(coordinatorPath)
    const coordinator = createStorageCoordinator({
      runState: { begin: async() => true, markClean: async() => {} },
      initDatabase: async() => ({
        status: 'ready', existed: true, schemaVersion: 6, migratedVersions: [], backupPath: null,
      }),
      closeDatabase: async() => {},
      runMigrationHooks: async() => undefined,
      checkCredentials: async() => ({
        vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [],
      }),
      verifyPhase2Storage: async() => {},
      interruptStalePlaybackSessions: async() => 0,
      runPlaybackTypedSmoke: async() => ({
        version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64),
      }),
      getPhase3AttestationPrerequisites: async() => ({ version: 1 }),
      completePhase3Attestation: async() => {},
      initSettings: async() => { settingsCalls++ },
      registerModules: () => {},
      appInited: () => {},
      showRecovery: async() => {},
      flushStores: async() => {},
    })

    assert.deepEqual(await coordinator.start(), {
      status: 'fatal', reason: 'cache_phase4_result_invalid',
    })
    assert.equal(settingsCalls, 0)
  })

  it('rejects a prerequisite-fatal worker payload returned as a degraded Phase 4 result', async() => {
    originalGlobalLx = globalThis.lx
    let settingsCalls = 0
    globalThis.lx = {
      worker: {
        dbService: {
          getCachePhasePrerequisite: async() => ({
            version: 1,
            markerName: 'legacy_data_v1.cross_artifact_complete',
            sourceSha256: 'f'.repeat(64),
            completedAtMs: 1,
          }),
          initializePhase4: async() => ({
            status: 'unavailable', code: 'cache_phase3_prerequisite_invalid',
          }),
        },
      },
    }

    const result = await createProductionCoordinator({
      initSettings: async() => { settingsCalls++ },
    }).start()

    assert.deepEqual(result, { status: 'fatal', reason: 'cache_phase4_result_invalid' })
    assert.equal(settingsCalls, 0)
  })

  it('rejects an incomplete production cache lifecycle instead of skipping Phase 4', async(t) => {
    const prerequisite = async() => ({
      version: 1,
      markerName: 'legacy_data_v1.cross_artifact_complete',
      sourceSha256: 'f'.repeat(64),
      completedAtMs: 1,
    })
    const initialize = async() => ({ schemaVersion: 6, typedOwnershipVerified: false })
    const cases = [
      { name: 'missing prerequisite reader', dbService: { initializePhase4: initialize } },
      { name: 'missing Phase 4 initializer', dbService: { getCachePhasePrerequisite: prerequisite } },
    ]

    for (const testCase of cases) {
      await t.test(testCase.name, async() => {
        originalGlobalLx = globalThis.lx
        let settingsCalls = 0
        globalThis.lx = { worker: { dbService: testCase.dbService } }

        const result = await createProductionCoordinator({
          initSettings: async() => { settingsCalls++ },
        }).start()

        assert.deepEqual(result, { status: 'fatal', reason: 'cache_phase4_result_invalid' })
        assert.equal(settingsCalls, 0)
      })
    }
  })
})
