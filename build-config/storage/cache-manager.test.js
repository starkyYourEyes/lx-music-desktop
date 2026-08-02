const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '../..')
const managerPath = path.join(root, 'src/main/services/cacheManager.ts')
const inventoryPath = path.join(root, 'src/main/services/cacheArtifactInventory.ts')
const musicUtilsPath = path.join(root, 'src/renderer/core/music/utils.ts')
const rendererIpcPath = path.join(root, 'src/renderer/utils/ipc.ts')

const temporaryRoots = []
afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    fs.rmSync(temporaryRoot, { recursive: true, force: true })
  }
})

const temporaryRoot = () => {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-cache-manager-'))
  temporaryRoots.push(value)
  return value
}

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const write = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, value)
}

const loadInventory = () => loadTsModule(inventoryPath)
const loadManager = () => loadTsModule(managerPath, { './cacheArtifactInventory': loadInventory() })

const createManagerHarness = ({
  rootPath = temporaryRoot(),
  reopenResult = { status: 'created', schemaVersion: 1, diagnostic: null },
  sessionResults = [
    { key: 'main:win-main', category: 'cache', status: 'cleared' },
    { key: 'main:win-main', category: 'cache-storage', status: 'cleared' },
    { key: 'main:win-main', category: 'code-cache', status: 'cleared' },
  ],
  begin,
  finish,
  clearSessions,
  publish,
  fileSystem = fs,
} = {}) => {
  const cacheRoot = path.join(rootPath, 'cache')
  fs.mkdirSync(cacheRoot, { recursive: true })
  for (const name of ['cache.db', 'cache.db-wal', 'cache.db-shm']) write(path.join(cacheRoot, name), name)
  const events = []
  const worker = {
    async beginCacheReset() {
      events.push('worker:begin-reset')
      if (begin) return begin()
      return { resetId: 'lease-1' }
    },
    async finishCacheReset(lease) {
      events.push('worker:finish-reset')
      if (finish) return finish(lease)
      return reopenResult
    },
  }
  const registry = {
    async clearRegisteredCaches() {
      events.push('sessions:clear-registered')
      return clearSessions ? clearSessions() : sessionResults
    },
  }
  const recordingFileSystem = new Proxy(fileSystem, {
    get(target, property, receiver) {
      if (property != 'unlinkSync') return Reflect.get(target, property, receiver)
      return targetPath => {
        events.push(`delete:${path.basename(targetPath)}`)
        return target.unlinkSync(targetPath)
      }
    },
  })
  const broadcasts = []
  const { createCacheManager } = loadManager()
  const manager = createCacheManager({
    cacheRoot,
    worker,
    sessionRegistry: registry,
    fileSystem: recordingFileSystem,
    publishGeneration(generation) {
      events.push(`broadcast:generation:${generation}`)
      broadcasts.push(generation)
      return publish?.(generation)
    },
  })
  return { broadcasts, cacheRoot, events, manager, rootPath }
}

describe('protected main-only cache manager', () => {
  it('uses only the owned DB inventory and registered Chromium categories in reset order', async() => {
    const harness = createManagerHarness()

    const result = await harness.manager.clearAll()

    assert.deepEqual(harness.events, [
      'worker:begin-reset',
      'delete:cache.db', 'delete:cache.db-wal', 'delete:cache.db-shm',
      'sessions:clear-registered',
      'worker:finish-reset',
      'broadcast:generation:1',
    ])
    assert.deepEqual(result, {
      status: 'cleared',
      generation: 1,
      components: [
        { component: 'cache-db', key: 'cache.db', status: 'cleared' },
        { component: 'chromium-http', key: 'main:win-main', status: 'cleared' },
        { component: 'chromium-cache-storage', key: 'main:win-main', status: 'cleared' },
        { component: 'chromium-code', key: 'main:win-main', status: 'cleared' },
      ],
    })
    assert.equal(harness.events.some(value => /artwork|audio|session-data|download/.test(value)), false)
  })

  it('returns the exact same in-flight clear to concurrent callers', async() => {
    const gate = deferred()
    const harness = createManagerHarness({ clearSessions: async() => gate.promise })

    const first = harness.manager.clearAll()
    const second = harness.manager.clearAll()
    assert.strictEqual(first, second)
    gate.resolve([])
    assert.strictEqual(await first, await second)
    assert.equal(harness.events.filter(value => value == 'worker:begin-reset').length, 1)
  })

  it('always finishes an acquired reset lease after delete and session failures', async() => {
    let unlinkCalls = 0
    const failingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property != 'unlinkSync') return Reflect.get(target, property, receiver)
        return targetPath => {
          unlinkCalls++
          if (path.basename(targetPath) == 'cache.db') throw Object.assign(new Error('private delete failure'), { code: 'EPERM' })
          return target.unlinkSync(targetPath)
        }
      },
    })
    const harness = createManagerHarness({
      fileSystem: failingFs,
      sessionResults: [
        { key: 'user-api:one', category: 'cache', status: 'failed', code: 'session_cache_clear_failed' },
        { key: 'user-api:one', category: 'cache-storage', status: 'cleared' },
        { key: 'user-api:one', category: 'code-cache', status: 'cleared' },
      ],
      reopenResult: { status: 'ready', schemaVersion: 1, diagnostic: null },
    })

    const result = await harness.manager.clearAll()

    assert.equal(unlinkCalls, 3)
    assert.equal(harness.events.includes('sessions:clear-registered'), true)
    assert.equal(harness.events.at(-1), 'worker:finish-reset')
    assert.deepEqual(harness.broadcasts, [])
    assert.deepEqual(result, {
      status: 'degraded',
      generation: 0,
      components: [
        { component: 'cache-db', key: 'cache.db', status: 'failed', code: 'cache_delete_failed' },
        { component: 'chromium-http', key: 'user-api:one', status: 'failed', code: 'session_cache_clear_failed' },
        { component: 'chromium-cache-storage', key: 'user-api:one', status: 'cleared' },
        { component: 'chromium-code', key: 'user-api:one', status: 'cleared' },
      ],
    })
  })

  it('does not delete or clear sessions when reset lease acquisition fails', async() => {
    const harness = createManagerHarness({ begin: async() => { throw new Error('private close failure') } })

    const result = await harness.manager.clearAll()

    assert.deepEqual(harness.events, ['worker:begin-reset'])
    assert.deepEqual(result, {
      status: 'degraded', generation: 0,
      components: [{ component: 'cache-db', key: 'cache.db', status: 'failed', code: 'cache_close_failed' }],
    })
  })

  it('publishes a fresh generation after session failure but not after unavailable or ready reopen', async() => {
    const sessionFailure = createManagerHarness({
      sessionResults: [{ key: 'main:win-main', category: 'cache', status: 'failed', code: 'session_cache_clear_failed' }],
      reopenResult: { status: 'recreated', schemaVersion: 1, diagnostic: null },
    })
    const unavailable = createManagerHarness({
      reopenResult: { status: 'unavailable', schemaVersion: null, diagnostic: 'cache_reopen_failed' },
    })
    const ready = createManagerHarness({ reopenResult: { status: 'ready', schemaVersion: 1, diagnostic: null } })

    const failedSessionResult = await sessionFailure.manager.clearAll()
    const unavailableResult = await unavailable.manager.clearAll()
    const readyResult = await ready.manager.clearAll()

    assert.equal(failedSessionResult.status, 'degraded')
    assert.equal(failedSessionResult.generation, 1)
    assert.deepEqual(sessionFailure.broadcasts, [1])
    assert.equal(unavailableResult.status, 'degraded')
    assert.equal(unavailableResult.generation, 0)
    assert.deepEqual(unavailable.broadcasts, [])
    assert.equal(readyResult.generation, 0)
    assert.deepEqual(ready.broadcasts, [])
  })

  it('keeps its fresh generation when the best-effort publisher throws', async() => {
    const harness = createManagerHarness({ publish: () => { throw new Error('renderer unavailable') } })
    const result = await harness.manager.clearAll()
    assert.equal(result.generation, 1)
    assert.equal(result.status, 'cleared')
  })

  it('preserves durable and non-owned fixtures on success and every injected component failure', async() => {
    for (const failure of ['none', 'delete', 'sessions', 'reopen']) {
      const fixtureRoot = temporaryRoot()
      const fixtures = new Map([
        ['profile/config_v2.json', 'settings'], ['profile/app.db', 'app-db'],
        ['profile/credentials.v1.json', 'vault'], ['profile/edited-lyric.json', 'edited-lyric'],
        ['profile/themes/custom.css', 'theme'], ['profile/user-api/source.js', 'user-api'],
        ['downloads/completed.mp3', 'completed'], ['downloads/partial.tmp', 'partial'],
        ['backups/app.db.bak', 'backup'], ['runtime/session-data/Cookies', 'cookies'],
        ['runtime/session-data/Local Storage/state', 'local-storage'], ['profile/download_list.json', 'download-list'],
        ['cache/artwork/cover.jpg', 'artwork'], ['cache/audio/song.mp3', 'audio'],
      ])
      for (const [relative, bytes] of fixtures) write(path.join(fixtureRoot, relative), bytes)
      const failingFs = failure == 'delete' ? new Proxy(fs, {
        get(target, property, receiver) {
          if (property != 'unlinkSync') return Reflect.get(target, property, receiver)
          return targetPath => { throw Object.assign(new Error('delete failed'), { code: 'EPERM', targetPath }) }
        },
      }) : fs
      const harness = createManagerHarness({
        rootPath: fixtureRoot,
        fileSystem: failingFs,
        clearSessions: failure == 'sessions' ? async() => { throw new Error('sessions failed') } : undefined,
        finish: failure == 'reopen'
          ? async() => { throw new Error('reopen failed') }
          : undefined,
      })

      await harness.manager.clearAll()

      for (const [relative, bytes] of fixtures) {
        assert.equal(fs.readFileSync(path.join(fixtureRoot, relative), 'utf8'), bytes, `${failure}: ${relative}`)
      }
    }
  })
})

describe('owned cache artifact inventory', () => {
  it('captures ownership when clearing after startup creates the cache root', () => {
    const fixtureRoot = temporaryRoot()
    const cacheRoot = path.join(fixtureRoot, 'cache')
    const { createCacheArtifactInventory } = loadInventory()
    const inventory = createCacheArtifactInventory({ cacheRoot })
    fs.mkdirSync(cacheRoot)
    for (const name of ['cache.db', 'cache.db-wal', 'cache.db-shm']) write(path.join(cacheRoot, name), name)

    assert.deepEqual(inventory.clearOwnedArtifacts(), { status: 'cleared' })
    assert.deepEqual(fs.readdirSync(cacheRoot), [])
  })

  it('rejects a linked cache root and linked or non-file direct children without touching their targets', () => {
    const fixtureRoot = temporaryRoot()
    const externalRoot = path.join(fixtureRoot, 'external')
    fs.mkdirSync(externalRoot)
    const externalFile = path.join(externalRoot, 'outside.db')
    write(externalFile, 'outside')
    const linkedRoot = path.join(fixtureRoot, 'linked-cache')
    fs.symlinkSync(externalRoot, linkedRoot, 'junction')
    const { createCacheArtifactInventory } = loadInventory()
    assert.deepEqual(createCacheArtifactInventory({ cacheRoot: linkedRoot }).clearOwnedArtifacts(), {
      status: 'failed', code: 'cache_target_invalid', failedArtifact: null,
    })
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'outside')

    const cacheRoot = path.join(fixtureRoot, 'cache')
    fs.mkdirSync(cacheRoot)
    fs.linkSync(externalFile, path.join(cacheRoot, 'cache.db'))
    fs.mkdirSync(path.join(cacheRoot, 'cache.db-wal'))
    assert.deepEqual(createCacheArtifactInventory({ cacheRoot }).clearOwnedArtifacts(), {
      status: 'failed', code: 'cache_target_invalid', failedArtifact: 'cache.db',
    })
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'outside')
  })

  it('rejects a target identity race at destructive revalidation and preserves the replacement', () => {
    const fixtureRoot = temporaryRoot()
    const cacheRoot = path.join(fixtureRoot, 'cache')
    fs.mkdirSync(cacheRoot)
    const databasePath = path.join(cacheRoot, 'cache.db')
    write(databasePath, 'original')
    let targetInspections = 0
    const racingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property != 'lstatSync') return Reflect.get(target, property, receiver)
        return targetPath => {
          if (path.resolve(targetPath) == path.resolve(databasePath) && ++targetInspections == 2) {
            fs.renameSync(databasePath, `${databasePath}.old`)
            write(databasePath, 'replacement')
          }
          return target.lstatSync(targetPath)
        }
      },
    })
    const { createCacheArtifactInventory } = loadInventory()

    const result = createCacheArtifactInventory({ cacheRoot, fileSystem: racingFs }).clearOwnedArtifacts()

    assert.deepEqual(result, { status: 'failed', code: 'cache_target_invalid', failedArtifact: 'cache.db' })
    assert.equal(fs.readFileSync(databasePath, 'utf8'), 'replacement')
  })

  it('revalidates target identity immediately before unlink', () => {
    const fixtureRoot = temporaryRoot()
    const cacheRoot = path.join(fixtureRoot, 'cache')
    fs.mkdirSync(cacheRoot)
    const databasePath = path.join(cacheRoot, 'cache.db')
    write(databasePath, 'original')
    let targetInspections = 0
    const racingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property != 'lstatSync') return Reflect.get(target, property, receiver)
        return targetPath => {
          if (path.resolve(targetPath) == path.resolve(databasePath) && ++targetInspections == 3) {
            fs.renameSync(databasePath, `${databasePath}.old`)
            write(databasePath, 'replacement')
          }
          return target.lstatSync(targetPath)
        }
      },
    })
    const { createCacheArtifactInventory } = loadInventory()

    const result = createCacheArtifactInventory({ cacheRoot, fileSystem: racingFs }).clearOwnedArtifacts()

    assert.deepEqual(result, { status: 'failed', code: 'cache_target_invalid', failedArtifact: 'cache.db' })
    assert.equal(fs.readFileSync(databasePath, 'utf8'), 'replacement')
  })

  it('rejects a cache-root identity race before deleting a direct child', () => {
    const fixtureRoot = temporaryRoot()
    const cacheRoot = path.join(fixtureRoot, 'cache')
    fs.mkdirSync(cacheRoot)
    write(path.join(cacheRoot, 'cache.db'), 'owned')
    let rootInspections = 0
    const racingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property != 'lstatSync') return Reflect.get(target, property, receiver)
        return targetPath => {
          if (path.resolve(targetPath) == path.resolve(cacheRoot) && ++rootInspections > 1) {
            fs.renameSync(cacheRoot, `${cacheRoot}.old`)
            fs.mkdirSync(cacheRoot)
            write(path.join(cacheRoot, 'cache.db'), 'replacement')
          }
          return target.lstatSync(targetPath)
        }
      },
    })
    const { createCacheArtifactInventory } = loadInventory()
    const result = createCacheArtifactInventory({ cacheRoot, fileSystem: racingFs }).clearOwnedArtifacts()
    assert.deepEqual(result, { status: 'failed', code: 'cache_target_invalid', failedArtifact: 'cache.db' })
    assert.equal(fs.readFileSync(path.join(cacheRoot, 'cache.db'), 'utf8'), 'replacement')
    assert.equal(fs.readFileSync(path.join(`${cacheRoot}.old`, 'cache.db'), 'utf8'), 'owned')
  })
})

const music = id => ({
  id, name: `name-${id}`, singer: `singer-${id}`, source: 'local', interval: null,
  meta: { songId: id, albumName: `album-${id}`, qualitys: [], _qualitys: {} },
})

const loadMusicGenerationHarness = findMusic => {
  const writes = []
  const utils = loadTsModule(musicUtilsPath, {
    '@renderer/store': { apiSource: { value: 'official' }, qualityList: { value: {} } },
    '@renderer/store/netease': { profile: { value: null }, isLoggedIn: { value: false } },
    '@renderer/store/qqMusic': { profile: { value: null }, isLoggedIn: { value: false } },
    '@common/storage/cacheValidation': { neteaseAccountScope: () => null, qqMusicAccountScope: () => null },
    '@renderer/store/utils': { assertApiSupport: () => true },
    '@renderer/utils/musicSdk': { findMusic },
    '@renderer/utils/ipc': {
      getOtherSourcesFromCache: async() => [],
      putOtherSourcesInCache: async(identity, candidates) => { writes.push({ identity, candidates }) },
      getMusicUrl: async() => '', getPlayerLyric: async() => ({ lyric: '' }),
    },
    '@renderer/store/setting': { appSetting: { 'player.isS2t': false } },
    '@renderer/utils': { langS2T: async value => value, toNewMusicInfo: value => value, toOldMusicInfo: value => value },
    '@renderer/utils/message': { requestMsg: {} },
    '@renderer/utils/musicSdk/api-source': { apis: () => ({}) },
  })
  return { utils, writes }
}

describe('renderer cache generation adaptation', () => {
  it('advances only for a strictly newer generation and prevents an old completion deleting a newer same-key request', async() => {
    const searches = []
    const harness = loadMusicGenerationHarness(() => {
      const request = deferred()
      searches.push(request)
      return request.promise
    })
    assert.equal(typeof harness.utils.adoptCacheGeneration, 'function')
    const track = music('same-key')
    const oldRequest = harness.utils.getOtherSource(track)
    await new Promise(resolve => setImmediate(resolve))
    harness.utils.adoptCacheGeneration(1)
    harness.utils.adoptCacheGeneration(1)
    harness.utils.adoptCacheGeneration(0)
    const newRequest = harness.utils.getOtherSource(track)
    await new Promise(resolve => setImmediate(resolve))
    searches[0].resolve([music('old-result')])
    assert.deepEqual(await oldRequest, [music('old-result')])
    const deduplicatedNewRequest = harness.utils.getOtherSource(track)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(searches.length, 2)
    searches[1].resolve([music('new-result')])
    assert.deepEqual(await Promise.all([newRequest, deduplicatedNewRequest]), [
      [music('new-result')], [music('new-result')],
    ])
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(harness.writes, [{
      identity: { originalProvider: 'local', originalTrackId: 'same-key' },
      candidates: [music('new-result')],
    }])
  })

  it('subscribes to the exact receive-only event and returns a matching disposer', () => {
    const calls = []
    const hotKeyGroup = new Proxy({}, { get: (_target, key) => ({ name: String(key), action: String(key) }) })
    const names = loadTsModule(path.join(root, 'src/common/storage/cache.ts'))
    const ipc = loadTsModule(rendererIpcPath, {
      '@common/ipcNames': {
        CMMON_EVENT_NAME: new Proxy({}, { get: (_target, key) => String(key) }),
        HOTKEY_RENDERER_EVENT_NAME: new Proxy({}, { get: (_target, key) => String(key) }),
        WIN_MAIN_RENDERER_EVENT_NAME: new Proxy({}, { get: (_target, key) => String(key) }),
      },
      '@common/storage/cache': names,
      '@common/rendererIpc': {
        rendererOn: (name, listener) => calls.push(['on', name, listener]),
        rendererOff: (name, listener) => calls.push(['off', name, listener]),
        rendererInvoke: async() => {}, rendererSend: () => {},
      },
      '@common/utils/vueTools': { markRaw: value => value, toRaw: value => value },
      '@common/utils': { log: { error: () => {} } },
      '@common/hotKey': {
        HOTKEY_COMMON: hotKeyGroup,
        HOTKEY_DESKTOP_LYRIC: hotKeyGroup,
        HOTKEY_PLAYER: hotKeyGroup,
      },
      '@common/constants': { APP_EVENT_NAMES: {}, DATA_KEYS: {} },
      './storageState': { getLocalState: async() => {}, setLocalState: async() => {} },
      './shutdown': { registerShutdownFlusher: () => {} },
    })
    const listener = () => {}
    const dispose = ipc.onStorageCacheGeneration(listener)
    dispose()
    assert.deepEqual(calls, [
      ['on', 'storage_cache_generation_v1', listener],
      ['off', 'storage_cache_generation_v1', listener],
    ])
  })
})
