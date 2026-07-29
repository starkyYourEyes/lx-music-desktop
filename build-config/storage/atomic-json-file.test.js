const assert = require('node:assert/strict')
const crypto = require('node:crypto')
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
Module._load = function(request, parent, isMain) {
  if (request == 'electron') return { dialog: {}, shell: {} }
  if (request == '@common/utils') return { log: { error() {} } }
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

  it('records the canonical stage hash and rejects a replaced stage identity', async() => {
    const { target } = await createFixture('identity')
    const file = createAtomicJsonFile({ filePath: target, validate: isCounter })
    const stage = await file.stage({ n: 1 })
    const bytes = await fsp.readFile(stage.filePath)

    assert.equal(stage.fileSha256, crypto.createHash('sha256').update('{"n":1}').digest('hex'))
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
})

describe('Store atomic persistence', () => {
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

  it('keeps the synchronous update and reports asynchronous persistence errors from flush', async() => {
    const { target } = await createFixture('store-failure')
    await fsp.writeFile(target, '{"value":1}')
    const persistenceError = new Error('injected fsync failure')
    const store = new Store(target, false, withFailingTempSync(persistenceError))

    assert.doesNotThrow(() => store.set('value', 2))
    assert.equal(store.get('value'), 2)
    await assert.rejects(store.flush(), error => error === persistenceError)
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
    store.set('value', 2)

    await assert.rejects(flushStores(), /valid/)
    assert.equal(await fsp.readFile(target, 'utf8'), '[]')
  })
})
