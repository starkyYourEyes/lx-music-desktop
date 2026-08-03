const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// Electron ABI tests transpile source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const {
  assertFixturePathsOwned,
  createPhase4DurableFixture,
  putPhase3Marker,
  seedDurableDatabase,
  seedDurableFiles,
  snapshotDurableFixture,
} = require('../storage/helpers/phase4-durable-fixture.js')
const dbService = require('../../src/main/worker/dbService/db.ts')
const cacheDb = require('../../src/main/worker/dbService/cacheDb.ts')
const phase4 = require('../../src/main/worker/dbService/modules/phase4/index.ts')
const editedLyrics = require('../../src/main/worker/dbService/modules/lyric/edited/repository.ts')
const { createCacheManager } = require('../../src/main/services/cacheManager.ts')
const { createSessionRegistry } = require('../../src/main/services/sessionRegistry.ts')
const {
  acknowledgePortableProfileStartup,
  preparePortableProfile,
  retireAcknowledgedPortableSource,
} = require('../../src/main/migration/portableProfile.js')

const fixtures = []
const registrations = []
const silentLogger = { info() {}, warn() {}, error() {} }

const closeServices = async() => {
  try { await cacheDb.closeCacheDatabase() } catch {}
  try { dbService.close() } catch {}
}

afterEach(async() => {
  for (const registration of registrations.splice(0)) registration.unregister()
  await closeServices()
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
})

const initializeSchema6 = async(fixture, profileRoot = fixture.profileRoot) => {
  const startup = await dbService.init({
    dataPath: profileRoot,
    cacheRoot: fixture.cacheRoot,
    backupsRoot: fixture.backupsRoot,
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(startup.status, 'ready')
  assert.equal(startup.schemaVersion, 6)
  putPhase3Marker(dbService.getAppDB())
  seedDurableDatabase(dbService.getAppDB())
  return startup
}

const createCacheManagerHarness = (fixture, { failCategory } = {}) => {
  const calls = []
  const session = {
    async clearCache() {
      calls.push(['cache'])
      if (failCategory == 'cache') throw new Error('injected named HTTP cache failure')
    },
    async clearStorageData(options) {
      calls.push(['cache-storage', structuredClone(options)])
      if (failCategory == 'cache-storage') throw new Error('injected named CacheStorage failure')
    },
    async clearCodeCaches(options) {
      calls.push(['code-cache', structuredClone(options)])
      if (failCategory == 'code-cache') throw new Error('injected named code cache failure')
    },
  }
  const registry = createSessionRegistry()
  const registration = registry.register({ key: 'main', session })
  registrations.push(registration)
  const generations = []
  const manager = createCacheManager({
    cacheRoot: fixture.cacheRoot,
    worker: cacheDb,
    sessionRegistry: registry,
    publishGeneration: generation => generations.push(generation),
  })
  return { calls, generations, manager, registration }
}

const assertLiteralDurableRows = snapshot => {
  assert.deepEqual(snapshot.database.myList, [{
    id: 'phase4-list',
    name: 'Phase 4 playlist',
    source: 'local',
    sourceListId: 'source-list-1',
    position: 0,
    locationUpdateTime: 1700000000000,
  }])
  assert.deepEqual(snapshot.database.editedLyrics, [
    { id: 'phase4-track', source: 'edited', type: 'lyric', text: 'WzAwOjAwLjAwXVBsYXlsaXN0IGVkaXRlZA==' },
    { id: 'phase4-track', source: 'edited', type: 'tlyric', text: 'WzAwOjAwLjAwXVRyYW5zbGF0ZWQ=' },
  ])
  assert.deepEqual(snapshot.database.localState, [{
    key: 'view_prev_state', version: 1, valueJson: '{"route":"/song-list"}', updatedAtMs: 1700000000001,
  }])
  assert.equal(Buffer.from(snapshot.files['profile/settings.json'], 'base64').toString(), '{"theme":"phase4","volume":0.75}\n')
  assert.equal(Buffer.from(snapshot.files['profile/user-api/phase4.js'], 'base64').toString(), 'module.exports = { name: "phase4-user-api" }\n')
  assert.equal(Buffer.from(snapshot.files['runtime/session-data/Cookies'], 'base64').toString(), 'fake-cookie-db\0phase4')
  assert.equal(Buffer.from(snapshot.files['runtime/session-data/Local Storage/leveldb/000003.log'], 'base64').toString(), 'fake-local-storage\0phase4')
}

describe('fixture-only Phase 4 durability acceptance', () => {
  it('preserves a corrupt installed cache as unavailable, serves durable rows, and replaces only cache on explicit reset', async() => {
    const fixture = createPhase4DurableFixture({ layout: 'installed' })
    fixtures.push(fixture)
    seedDurableFiles(fixture)
    await initializeSchema6(fixture)
    assertFixturePathsOwned(fixture)

    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    assert.deepEqual(await cacheDb.runCacheWrite(db => db.exec(`
      INSERT INTO raw_lyric_groups(provider, source_track_id, byte_size, created_at_ms, last_accessed_at_ms)
      VALUES ('tx', 'cache-only', 5, 1, 1);
      INSERT INTO raw_lyrics(provider, source_track_id, lyric_type, text, byte_size)
      VALUES ('tx', 'cache-only', 'lyric', 'cache', 5);
    `)), { status: 'stored' })
    await cacheDb.closeCacheDatabase()

    const corruptBytes = Buffer.from('phase4-corrupt-cache\0preserve-in-place')
    fs.writeFileSync(fixture.cachePath, corruptBytes)
    const before = snapshotDurableFixture(fixture, dbService.getAppDB())
    assertLiteralDurableRows(before)

    assert.deepEqual(await phase4.initializePhase4(), { schemaVersion: 6, typedOwnershipVerified: false })
    assert.deepEqual(fs.readFileSync(fixture.cachePath), corruptBytes)
    assert.deepEqual(editedLyrics.getEditedLyric('phase4-track'), {
      lyric: '[00:00.00]Playlist edited',
      tlyric: '[00:00.00]Translated',
    })
    assert.equal(dbService.getAppDB().prepare("SELECT name FROM my_list WHERE id = 'phase4-list'").get().name, 'Phase 4 playlist')
    assert.equal(dbService.getAppDB().prepare("SELECT status FROM download_list WHERE id = 'phase4-partial'").get().status, 'paused')

    const harness = createCacheManagerHarness(fixture)
    await harness.registration.ready
    const cleared = await harness.manager.clearAll()
    assert.equal(cleared.status, 'cleared')
    assert.equal(cleared.generation, 1)
    assert.deepEqual(harness.generations, [1])
    assert.deepEqual(harness.calls, [
      ['cache'],
      ['cache-storage', { storages: ['cachestorage'] }],
      ['code-cache', {}],
    ])
    assert.deepEqual(await cacheDb.runCacheRead(db => db.prepare('SELECT count(*) count FROM raw_lyric_groups').get().count), {
      status: 'hit', value: 0,
    })
    assert.deepEqual(snapshotDurableFixture(fixture, dbService.getAppDB()), before)
  })

  it('publishes a cache generation when reset succeeds and only a named Chromium category fails', async() => {
    const fixture = createPhase4DurableFixture({ layout: 'installed' })
    fixtures.push(fixture)
    await initializeSchema6(fixture)
    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    const harness = createCacheManagerHarness(fixture, { failCategory: 'code-cache' })
    await harness.registration.ready

    const cleared = await harness.manager.clearAll()

    assert.equal(cleared.status, 'degraded')
    assert.equal(cleared.generation, 1)
    assert.deepEqual(harness.generations, [1])
    assert.deepEqual(cleared.components.find(component => component.component == 'chromium-code'), {
      component: 'chromium-code',
      key: 'main',
      status: 'failed',
      code: 'session_cache_clear_failed',
    })
  })

  it('composes interrupted portable promotion, schema-7 cutover, reset, acknowledgement, relaunch, and later retirement', async() => {
    const fixture = createPhase4DurableFixture({ layout: 'portable' })
    fixtures.push(fixture)
    seedDurableFiles(fixture, { profileRoot: fixture.legacyProfileRoot })
    fs.mkdirSync(path.join(fixture.portableRoot, 'userData', 'Session Storage'), { recursive: true })
    fs.writeFileSync(path.join(fixture.portableRoot, 'userData', 'outside.txt'), 'must-not-copy')
    await initializeSchema6(fixture, fixture.legacyProfileRoot)
    await closeServices()

    let interrupted = true
    const fsApi = {
      ...fs,
      write(descriptor, buffer, offset, length, position, callback) {
        fs.write(descriptor, buffer, offset, length, position, (error, bytesWritten, writtenBuffer) => {
          if (error == null && interrupted) {
            interrupted = false
            callback(new Error('phase4 injected portable interruption'))
            return
          }
          callback(error, bytesWritten, writtenBuffer)
        })
      },
    }
    const first = await preparePortableProfile({
      portableRoot: fixture.portableRoot, runId: 'phase4-startup-1', fsApi, logger: silentLogger,
    })
    assert.equal(first.state, 'failed')
    assert.equal(fs.existsSync(first.stagePath), false)
    const promoted = await preparePortableProfile({
      portableRoot: fixture.portableRoot, runId: 'phase4-startup-1', logger: silentLogger,
    })
    assert.equal(promoted.state, 'promoted')
    assert.equal(fs.existsSync(fixture.legacyProfileRoot), true)
    assert.equal(fs.existsSync(path.join(fixture.profileRoot, 'outside.txt')), false)

    const startup = await dbService.init({
      dataPath: fixture.profileRoot,
      cacheRoot: fixture.cacheRoot,
      backupsRoot: fixture.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(startup.schemaVersion, 6)
    const beforeCutover = snapshotDurableFixture(fixture, dbService.getAppDB())
    assertLiteralDurableRows(beforeCutover)
    assert.deepEqual(await phase4.initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    assert.equal(dbService.getDatabaseInitialization().schemaVersion, 7)
    assert.deepEqual(snapshotDurableFixture(fixture, dbService.getAppDB()), beforeCutover)

    const backupNames = fs.readdirSync(fixture.backupsRoot)
    const finalName = backupNames.find(name => /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{64}\.backup$/.test(name))
    const stageName = backupNames.find(name => /^\.lx-backup-[a-f0-9]{32}\.stage$/.test(name))
    assert.equal(typeof finalName, 'string')
    assert.equal(typeof stageName, 'string')
    const finalStats = fs.lstatSync(path.join(fixture.backupsRoot, finalName), { bigint: true })
    const stageStats = fs.lstatSync(path.join(fixture.backupsRoot, stageName), { bigint: true })
    assert.equal(finalStats.ino, stageStats.ino)
    assert.equal(finalStats.dev, stageStats.dev)
    assert.equal(finalStats.nlink, 2n)

    const harness = createCacheManagerHarness(fixture)
    const cleared = await harness.manager.clearAll()
    assert.equal(cleared.status, 'cleared')
    assert.deepEqual(harness.generations, [1])
    assert.deepEqual(snapshotDurableFixture(fixture, dbService.getAppDB()), beforeCutover)

    await closeServices()
    assert.deepEqual(await acknowledgePortableProfileStartup(promoted.token, { logger: silentLogger }), {
      state: 'typed-only-acknowledged',
    })
    assert.equal((await retireAcknowledgedPortableSource({
      portableRoot: fixture.portableRoot, runId: 'phase4-startup-1', logger: silentLogger,
    })).state, 'same-startup')
    assert.equal(fs.existsSync(fixture.legacyProfileRoot), true)

    assert.equal((await retireAcknowledgedPortableSource({
      portableRoot: fixture.portableRoot, runId: 'phase4-startup-2', logger: silentLogger,
    })).state, 'retired')
    assert.equal(fs.existsSync(fixture.legacyProfileRoot), false)
    assert.equal(fs.readFileSync(path.join(fixture.portableRoot, 'userData', 'outside.txt'), 'utf8'), 'must-not-copy')

    const relaunched = await dbService.init({
      dataPath: fixture.profileRoot,
      cacheRoot: fixture.cacheRoot,
      backupsRoot: fixture.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.schemaVersion, 7)
    assert.deepEqual(await phase4.initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    assert.deepEqual(snapshotDurableFixture(fixture, dbService.getAppDB()), beforeCutover)
    assertFixturePathsOwned(fixture)
  })
})
