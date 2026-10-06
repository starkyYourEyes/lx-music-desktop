const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const originalLoad = Module._load
const storeLogEntries = []
const storeDialogEntries = []
const storeShownPaths = []
Module._load = function(request, parent, isMain) {
  if (request == 'electron') {
    return {
      dialog: { showMessageBoxSync: options => { storeDialogEntries.push(options) } },
      shell: { showItemInFolder: target => { storeShownPaths.push(target) } },
    }
  }
  if (request == '@common/utils') return { log: { error: error => { storeLogEntries.push(error) } } }
  return originalLoad.call(this, request, parent, isMain)
}

const { createAtomicJsonFile } = require('../../src/main/storage/atomicJsonFile.ts')
const { default: getStore, flushStores, Store } = require('../../src/main/utils/store.ts')

const tempDirs = []

const createFixture = async(name) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `lx-atomic-${name}-`))
  tempDirs.push(dir)
  return { dir, target: path.join(dir, 'settings.json') }
}

const exists = async(filePath) => {
  try {
    await fsp.access(filePath)
    return true
  } catch (err) {
    if (err.code == 'ENOENT') return false
    throw err
  }
}

const isValue = value => value != null && typeof value == 'object' && !Array.isArray(value) && Number.isInteger(value.value)
const isCounter = value => value != null && typeof value == 'object' && !Array.isArray(value) && Number.isInteger(value.n)
const withFailingTempSync = (syncError = new Error('injected fsync failure')) => ({
  ...fsp,
  async open(filePath, flags, mode) {
    const handle = await fsp.open(filePath, flags, mode)
    if (!String(filePath).includes('.owned-tmp-')) return handle
    return {
      writeFile: handle.writeFile.bind(handle),
      async sync() {
        throw syncError
      },
      close: handle.close.bind(handle),
    }
  },
})

const withTempHandleFailures = ({ syncError, closeError }) => ({
  ...fsp,
  async open(filePath, flags, mode) {
    const handle = await fsp.open(filePath, flags, mode)
    if (!String(filePath).includes('.owned-tmp-')) return handle
    return {
      writeFile: handle.writeFile.bind(handle),
      async sync() {
        if (syncError != null) throw syncError
        await handle.sync()
      },
      async close() {
        await handle.close()
        if (closeError != null) throw closeError
      },
    }
  },
})

afterEach(async() => {
  storeLogEntries.length = 0
  storeDialogEntries.length = 0
  storeShownPaths.length = 0
  await Promise.all(tempDirs.splice(0).map(async dir => fsp.rm(dir, { recursive: true, force: true })))
})

describe('atomic JSON file', () => {
  it('does not replace the destination when temp fsync fails', async() => {
    const { target } = await createFixture('fsync')
    await fsp.writeFile(target, '{"value":1}')
    const file = createAtomicJsonFile({ filePath: target, validate: isValue, fs: withFailingTempSync() })

    await assert.rejects(file.replace({ value: 2 }), /injected fsync failure/)

    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { value: 1 })
  })

  it('preserves the primary write failure when closing the failed handle also fails', async() => {
    const { target } = await createFixture('write-close-errors')
    const syncError = new Error('primary sync failure')
    const closeError = new Error('secondary close failure')
    const file = createAtomicJsonFile({
      filePath: target,
      validate: isValue,
      fs: withTempHandleFailures({ syncError, closeError }),
    })

    await assert.rejects(file.replace({ value: 1 }), error => error === syncError)
  })

  it('propagates a close-only failure from a durable temporary write', async() => {
    const { target } = await createFixture('close-error')
    const closeError = new Error('close-only failure')
    const file = createAtomicJsonFile({
      filePath: target,
      validate: isValue,
      fs: withTempHandleFailures({ closeError }),
    })

    await assert.rejects(file.replace({ value: 1 }), error => error === closeError)
  })

  it('coalesces queued snapshots and resolves every waiter after the newest write', async() => {
    const { target } = await createFixture('queue')
    const delayedFs = {
      ...fsp,
      replacements: 0,
      async rename(source, destination) {
        if (destination == target) {
          this.replacements++
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        return fsp.rename(source, destination)
      },
    }
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: delayedFs })
    const observed = []

    const first = file.replace({ n: 1 })
    const second = file.replace({ n: 2 })
    const third = file.replace({ n: 3 })
    assert.strictEqual(second, first)
    assert.strictEqual(third, first)
    await Promise.all([first, second, third].map(async write => {
      await write
      observed.push(JSON.parse(await fsp.readFile(target, 'utf8')).n)
    }))

    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 3 })
    assert.equal(delayedFs.replacements, 2)
    assert.deepEqual(observed, [3, 3, 3])
  })

  it('retains the last parsed valid document and removes only exact owned stale temps', async() => {
    const { dir, target } = await createFixture('cleanup')
    await fsp.writeFile(target, '{"n":1}')
    await fsp.writeFile(`${target}.unowned`, 'keep')
    await fsp.writeFile(`${target}.next`, '{"n":9}')
    await fsp.writeFile(path.join(dir, 'settings.json.other.owned-tmp-1-1'), 'keep')
    const ownedTemp = path.join(dir, `settings.json.owned-tmp-${process.pid}-999`)
    await fsp.writeFile(ownedTemp, 'stale')
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })

    await file.replace({ n: 2 })
    assert.deepEqual(JSON.parse(await fsp.readFile(`${target}.previous`, 'utf8')), { n: 1 })
    await file.cleanupOwnedTemps()

    assert.equal(await exists(ownedTemp), false)
    assert.equal(await exists(`${target}.unowned`), true)
    assert.equal(await exists(`${target}.next`), true)
    assert.equal(await exists(path.join(dir, 'settings.json.other.owned-tmp-1-1')), true)
  })

  it('preserves and verifies the previous version by default', async() => {
    const { target } = await createFixture('previous-default')
    await fsp.writeFile(target, '{"n":1}')
    await fsp.writeFile(`${target}.previous`, '{"n":0}')
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })

    await file.replace({ n: 2 })

    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 2 })
    assert.deepEqual(JSON.parse(await fsp.readFile(`${target}.previous`, 'utf8')), { n: 1 })
  })

  it('omits the previous version when the parsed destination opts out', async() => {
    for (const hasExistingPrevious of [false, true]) {
      const { target } = await createFixture(`previous-opt-out-${hasExistingPrevious}`)
      await fsp.writeFile(target, '{"n":1}')
      if (hasExistingPrevious) await fsp.writeFile(`${target}.previous`, '{"n":0}')
      const file = createAtomicJsonFile({
        filePath: target,
        validate: isCounter,
        shouldPreservePrevious: current => current.n != 1,
      })

      await file.replace({ n: 2 })

      assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 2 })
      assert.equal(await exists(`${target}.previous`), false)
    }
  })

  it('aborts before primary replacement when opted-out previous removal fails', async() => {
    const { target } = await createFixture('previous-remove-failure')
    const previousPath = `${target}.previous`
    await fsp.writeFile(target, '{"n":1}')
    await fsp.writeFile(previousPath, '{"n":0}')
    const unlinkError = Object.assign(new Error('injected previous unlink failure'), { code: 'EACCES' })
    let primaryReplacements = 0
    const faultFs = {
      ...fsp,
      async unlink(filePath) {
        if (filePath == previousPath) throw unlinkError
        return fsp.unlink(filePath)
      },
      async rename(source, destination) {
        if (destination == target) primaryReplacements++
        return fsp.rename(source, destination)
      },
    }
    const file = createAtomicJsonFile({
      filePath: target,
      validate: isCounter,
      shouldPreservePrevious: () => false,
      fs: faultFs,
    })

    await assert.rejects(file.replace({ n: 2 }), error => error === unlinkError)

    assert.equal(primaryReplacements, 0)
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 1 })
    assert.deepEqual(JSON.parse(await fsp.readFile(previousPath, 'utf8')), { n: 0 })
  })

  it('does not interpret or remove unknown predecessor-shaped files', async() => {
    const { target } = await createFixture('unknown-predecessor')
    const unknown = `${target}.${['expected', 'previous'].join('-')}-${'0'.repeat(64)}-404-17`
    await fsp.writeFile(target, '{"n":1}')
    await fsp.writeFile(unknown, 'preserve')
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })

    await file.cleanupOwnedTemps()

    assert.equal(await fsp.readFile(unknown, 'utf8'), 'preserve')
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 1 })
  })

  it('runs one owned-temp cleanup before concurrent first read and write operations', async() => {
    const { dir, target } = await createFixture('first-operation-cleanup')
    await fsp.writeFile(target, '{"n":0}')
    const staleTemp = `${target}.owned-tmp-404-17`
    const nextFile = `${target}.next`
    const previousFile = `${target}.previous`
    const otherWriterTemp = path.join(dir, 'other.json.owned-tmp-404-17')
    await Promise.all([
      fsp.writeFile(staleTemp, 'stale'),
      fsp.writeFile(nextFile, '{"n":8}'),
      fsp.writeFile(previousFile, '{"n":7}'),
      fsp.writeFile(otherWriterTemp, 'keep'),
    ])
    const events = []
    const trackingFs = {
      ...fsp,
      async readdir(...args) {
        events.push('cleanup')
        await new Promise(resolve => setImmediate(resolve))
        return fsp.readdir(...args)
      },
      async open(filePath, flags, mode) {
        if (flags == 'wx') events.push('stage')
        return fsp.open(filePath, flags, mode)
      },
    }
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: trackingFs })

    await Promise.all([file.read(), file.replace({ n: 1 })])

    assert.equal(events.filter(event => event == 'cleanup').length, 1)
    assert.equal(events.indexOf('cleanup') < events.indexOf('stage'), true)
    assert.equal(await exists(staleTemp), false)
    assert.equal(await exists(nextFile), true)
    assert.equal(await exists(previousFile), true)
    assert.equal(await exists(otherWriterTemp), true)
  })

  it('rescans for later writer instances while preserving another instance active stage', async() => {
    const { target } = await createFixture('cross-instance-cleanup')
    await fsp.writeFile(target, '{"n":0}')
    const newlyStaleTemp = `${target}.owned-tmp-407-21`
    let stagedPath
    let releaseStageStat
    let signalStageStat
    const stageStatStarted = new Promise(resolve => { signalStageStat = resolve })
    const stageStatBarrier = new Promise(resolve => { releaseStageStat = resolve })
    const firstFileSystem = {
      ...fsp,
      async stat(filePath) {
        if (String(filePath).includes('.owned-tmp-') && stagedPath == null) {
          stagedPath = String(filePath)
          signalStageStat()
          await stageStatBarrier
        }
        return fsp.stat(filePath)
      },
    }
    const first = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: firstFileSystem })
    let secondCleanupCalls = 0
    const secondFileSystem = {
      ...fsp,
      async readdir(...args) {
        secondCleanupCalls++
        return fsp.readdir(...args)
      },
    }
    const second = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: secondFileSystem })

    const pendingStage = first.stage({ n: 1 })
    await stageStatStarted
    await fsp.writeFile(newlyStaleTemp, 'stale')
    assert.deepEqual(await second.read(), { n: 0 })
    const stageWasPreserved = await exists(stagedPath)
    const staleWasRemoved = !await exists(newlyStaleTemp)
    releaseStageStat()
    let stage = null
    let stageError = null
    try {
      stage = await pendingStage
    } catch (error) {
      stageError = error
    }

    assert.equal(secondCleanupCalls, 1)
    assert.equal(stageWasPreserved, true)
    assert.equal(staleWasRemoved, true)
    assert.equal(stageError, null)
    await first.commit(stage)
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { n: 1 })
  })

  it('records the canonical stage hash and rejects a replaced stage identity', async() => {
    const { target } = await createFixture('identity')
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })
    const stage = await file.stage({ n: 1 })
    const bytes = await fsp.readFile(stage.filePath)

    assert.equal(stage.fileSha256, '2bfd14f43d17fc7cea24e0917a8879b4b2f880b8baeec1b9d90fbaad655e71bd')
    await fsp.rename(stage.filePath, `${stage.filePath}.swapped`)
    await fsp.writeFile(stage.filePath, bytes)
    await assert.rejects(file.commit(stage), /identity/)
    assert.equal(await exists(target), false)
  })

  it('rejects a changed stage hash and a corrupted destination read-back', async() => {
    const { target } = await createFixture('readback')
    await fsp.writeFile(target, '{"n":0}')
    const corruptingFs = {
      ...fsp,
      async rename(source, destination) {
        await fsp.rename(source, destination)
        if (destination == target) await fsp.writeFile(destination, '{"n":999}')
      },
    }
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: corruptingFs })
    const stage = await file.stage({ n: 1 }, 'next')

    assert.equal(stage.filePath, `${target}.next`)
    await assert.rejects(file.commit({ ...stage, fileSha256: '0'.repeat(64) }), /stage/)
    await assert.rejects(file.commit(stage), /read-back/)
    assert.deepEqual(JSON.parse(await fsp.readFile(`${target}.previous`, 'utf8')), { n: 0 })
  })

  it('surfaces an invalid durable document instead of replacing it', async() => {
    const { dir, target } = await createFixture('invalid')
    await fsp.writeFile(target, '{"wrong":true}')
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })

    await assert.rejects(file.replace({ n: 1 }), /valid/)
    assert.equal(await fsp.readFile(target, 'utf8'), '{"wrong":true}')
    await file.cleanupOwnedTemps()
    assert.deepEqual((await fsp.readdir(dir)).filter(name => name.includes('.owned-tmp-')), [])
  })

  it('does not retain raw JSON parser diagnostics as an error cause', async() => {
    const { target } = await createFixture('invalid-json-diagnostic')
    const secret = 'cookie=MUSIC_U_ATOMIC_SECRET_91AF'
    await fsp.writeFile(target, `{"credential":"${secret}","broken":}`)
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })

    await assert.rejects(file.read(), error => {
      assert.equal(error.message, 'Atomic JSON destination is not valid JSON')
      assert.equal('cause' in error, false)
      assert.equal(String(error).includes(secret), false)
      return true
    })
  })

  it('sanitizes validator and serializer exceptions from caller-controlled values', async() => {
    const secret = 'cookie=ATOMIC_VALIDATION_SECRET_17D2'
    const throwingValue = Object.defineProperty({}, 'credential', {
      enumerable: true,
      get() {
        throw new Error(secret)
      },
    })
    const cases = [
      {
        label: 'validator',
        value: { n: 1 },
        validate: () => { throw new Error(secret) },
      },
      {
        label: 'serializer',
        value: throwingValue,
        validate: () => true,
      },
    ]

    for (const fixture of cases) {
      const { target } = await createFixture(`atomic-${fixture.label}-exception`)
      const file = createAtomicJsonFile({ filePath: target, validate: fixture.validate })

      await assert.rejects(file.replace(fixture.value), error => {
        assert.equal(error.message, 'Atomic JSON value is not valid')
        assert.equal('cause' in error, false)
        assert.equal(String(error).includes(secret), false)
        return true
      })
    }
  })
})

describe('Store atomic persistence', () => {
  it('rebases durable transforms over synchronous writes made during atomic persistence', async() => {
    const { target } = await createFixture('store-durable-rebase')
    await fsp.writeFile(target, '{"feature":"onDemand","volume":1}')
    let release
    let entered
    const held = new Promise(resolve => { release = resolve })
    const paused = new Promise(resolve => { entered = resolve })
    let intercepted = false
    const fileSystem = {
      ...fsp,
      async open(filePath, flags, mode) {
        const handle = await fsp.open(filePath, flags, mode)
        if (!String(filePath).includes('.owned-tmp-') || intercepted) return handle
        intercepted = true
        return {
          writeFile: handle.writeFile.bind(handle),
          async sync() { entered(); await held; await handle.sync() },
          close: handle.close.bind(handle),
        }
      },
    }
    const store = new Store(target, false, fileSystem)
    const saved = store.updateDurable(snapshot => ({ ...snapshot, feature: 'off' }))
    await paused
    assert.equal(store.get('feature'), 'onDemand')
    store.set('volume', 2)
    release()
    await saved
    await store.flush()
    assert.equal(store.get('feature'), 'off')
    assert.equal(store.get('volume'), 2)
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { feature: 'off', volume: 2 })
  })

  it('serializes concurrent durable transforms without losing independent changes', async() => {
    const { target } = await createFixture('store-durable-serial')
    await fsp.writeFile(target, '{"feature":"onDemand","volume":1}')
    const store = new Store(target)
    await Promise.all([
      store.updateDurable(snapshot => ({ ...snapshot, feature: 'off' })),
      store.updateDurable(snapshot => ({ ...snapshot, volume: 3 })),
    ])
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { feature: 'off', volume: 3 })
  })

  it('publishes a durable value only after atomic replacement succeeds', async() => {
    // Catches an awaitable Store API that mutates observable memory before a failed durable write.
    const { target } = await createFixture('store-durable-failure')
    await fsp.writeFile(target, '{"value":1}')
    const store = new Store(target, false, withFailingTempSync())

    await assert.rejects(store.setDurable('value', 2), /Store persistence failed/)

    assert.equal(store.get('value'), 1)
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { value: 1 })
  })

  it('updates memory immediately, queues a cloned snapshot, and flushes it', async() => {
    const { target } = await createFixture('store-clone')
    const store = new Store(target)
    const value = { nested: { count: 1 } }

    store.set('value', value)
    value.nested.count = 2

    assert.equal(store.get('value').nested.count, 2)
    await store.flush()
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { value: { nested: { count: 1 } } })
  })

  it('overrides the complete in-memory record synchronously and persists that snapshot', async() => {
    const { target } = await createFixture('store-override')
    const store = new Store(target)
    store.set('old', true)

    store.override({ next: 2 })

    assert.equal(store.has('old'), false)
    assert.equal(store.has('next'), true)
    assert.equal(store.get('next'), 2)
    await store.flush()
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { next: 2 })
  })

  it('keeps the synchronous update and sanitizes asynchronous persistence errors from flush', async() => {
    const { target } = await createFixture('store-failure')
    await fsp.writeFile(target, '{"value":1}')
    const secret = 'webdav-password=STORE_FSYNC_SECRET_C981'
    const persistenceError = new Error(secret)
    const store = new Store(target, false, withFailingTempSync(persistenceError))

    assert.doesNotThrow(() => store.set('value', 2))
    assert.equal(store.get('value'), 2)
    await assert.rejects(store.flush(), error => {
      assert.notStrictEqual(error, persistenceError)
      assert.equal(error.message, 'Store persistence failed')
      assert.equal('cause' in error, false)
      assert.equal(String(error).includes(secret), false)
      return true
    })
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { value: 1 })
  })

  it('sanitizes non-Error persistence rejections without echoing their payload', async() => {
    const { target } = await createFixture('store-non-error')
    const rejectedPayload = { secret: 'credential payload' }
    const store = new Store(target, false, withFailingTempSync(rejectedPayload))

    store.set('value', 2)

    await assert.rejects(store.flush(), error => {
      assert.equal(error instanceof Error, true)
      assert.equal(error.message, 'Store persistence failed')
      assert.equal(JSON.stringify(error).includes('credential payload'), false)
      return true
    })
  })

  it('registers a recovered Store so global flush surfaces its persistence error', async() => {
    const { dir } = await createFixture('store-recovery-registry')
    const name = `recovery-${Date.now()}-${Math.random()}`
    const target = path.join(dir, `${name}.json`)
    await fsp.writeFile(target, '[]')
    global.lxDataPath = dir

    const store = getStore(name, true, false)
    // Recovery has quarantined the malformed original. Inject a new invalid
    // destination to exercise a genuine post-recovery atomic persistence error.
    await fsp.writeFile(target, '[]')
    store.set('value', 2)

    await assert.rejects(flushStores(), error => error.message == 'Store persistence failed')
    assert.equal(await fsp.readFile(target, 'utf8'), '[]')
  })

  it('cleans a lazy Store owned temp before its first persisted use', async() => {
    const { dir } = await createFixture('store-lazy-cleanup')
    const name = `lazy-${Date.now()}-${Math.random()}`
    const target = path.join(dir, `${name}.json`)
    const staleTemp = `${target}.owned-tmp-812-3`
    const nextFile = `${target}.next`
    await fsp.writeFile(target, '{"value":1}')
    await fsp.writeFile(staleTemp, 'stale')
    await fsp.writeFile(nextFile, '{"value":9}')
    global.lxDataPath = dir

    const store = getStore(name, true, false)
    store.set('value', 2)
    await store.flush()

    assert.equal(await exists(staleTemp), false)
    assert.equal(await exists(nextFile), true)
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { value: 2 })
  })

  it('cleans a lazy Store owned temp before synchronous read-only use', async() => {
    const { dir } = await createFixture('store-read-only-cleanup')
    const name = `read-only-${Date.now()}-${Math.random()}`
    const target = path.join(dir, `${name}.json`)
    const staleTemp = `${target}.owned-tmp-913-7`
    const nextFile = `${target}.next`
    await fsp.writeFile(target, '{"value":1}')
    await fsp.writeFile(staleTemp, 'stale')
    await fsp.writeFile(nextFile, '{"value":9}')
    global.lxDataPath = dir

    const store = getStore(name, true, false)

    assert.equal(store.get('value'), 1)
    assert.equal(await exists(staleTemp), false)
    assert.equal(await exists(nextFile), true)
    assert.deepEqual(JSON.parse(await fsp.readFile(target, 'utf8')), { value: 1 })
  })

  it('completes synchronous lazy Store cleanup while another writer cleanup is pending', async() => {
    const { dir } = await createFixture('store-pending-cleanup')
    const name = `pending-${Date.now()}-${Math.random()}`
    const target = path.join(dir, `${name}.json`)
    const staleTemp = `${target}.owned-tmp-915-8`
    await fsp.writeFile(target, '{"n":1}')
    await fsp.writeFile(staleTemp, 'stale')
    let releaseCleanup
    let signalCleanup
    const cleanupStarted = new Promise(resolve => { signalCleanup = resolve })
    const cleanupBarrier = new Promise(resolve => { releaseCleanup = resolve })
    const delayedFileSystem = {
      ...fsp,
      async readdir(...args) {
        signalCleanup()
        await cleanupBarrier
        return fsp.readdir(...args)
      },
    }
    const first = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: delayedFileSystem })
    const pendingRead = first.read()
    await cleanupStarted
    global.lxDataPath = dir

    const store = getStore(name, true, false)
    const staleWasRemovedBeforeRead = !await exists(staleTemp)
    releaseCleanup()
    await pendingRead

    assert.equal(store.get('n'), 1)
    assert.equal(staleWasRemovedBeforeRead, true)
  })

  for (const fixture of [
    {
      label: 'malformed JSON',
      contents: '{"cookie":"MUSIC_U_STORE_SECRET_2F6C","broken":}',
      secret: 'MUSIC_U_STORE_SECRET_2F6C',
    },
    {
      label: 'a scalar document',
      contents: '"webdav-password=STORE_SCALAR_SECRET_A431"',
      secret: 'STORE_SCALAR_SECRET_A431',
    },
    {
      label: 'an array document',
      contents: '["cookie=STORE_ARRAY_SECRET_B729"]',
      secret: 'STORE_ARRAY_SECRET_B729',
    },
  ]) {
    it(`sanitizes ${fixture.label} in thrown, logged, and dialog diagnostics`, async() => {
      const { dir } = await createFixture(`store-diagnostic-${fixture.label.replaceAll(' ', '-')}`)
      const name = `diagnostic-${Date.now()}-${Math.random()}`
      const target = path.join(dir, `${name}.json`)
      await fsp.writeFile(target, fixture.contents)

      assert.throws(() => new Store(target), error => {
        assert.equal(error.message, 'Store data load failed')
        assert.equal('cause' in error, false)
        assert.equal(String(error).includes(fixture.secret), false)
        return true
      })

      global.lxDataPath = dir
      const recovered = getStore(name, true, true)
      assert.equal(recovered.has('cookie'), false)
      assert.equal(storeLogEntries.length, 1)
      assert.equal(storeDialogEntries.length, 1)
      assert.equal(storeShownPaths.length, 1)
      assert.notEqual(storeShownPaths[0], target)
      assert.equal(await fsp.readFile(storeShownPaths[0], 'utf8'), fixture.contents)
      assert.equal(storeDialogEntries[0].detail.includes(storeShownPaths[0]), true)
      const diagnosticText = [
        storeLogEntries[0]?.stack ?? String(storeLogEntries[0]),
        JSON.stringify(storeDialogEntries[0]),
      ].join('\n')
      assert.equal(diagnosticText.includes(fixture.secret), false)
      assert.equal(diagnosticText.includes('Unexpected token'), false)
      assert.equal(storeDialogEntries[0].detail.includes('Error detail: Store data load failed'), true)
    })
  }
})
