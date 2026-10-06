const assert = require('node:assert')
const fs = require('node:fs')
const { createTestStorageRoot } = require('../build-config/storage/helpers/test-storage-root')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const { Store } = loadTsModule(
  path.join(__dirname, '../src/main/utils/store.ts'),
  {
    '../storage/atomicJsonFile': loadTsModule(path.join(__dirname, '../src/main/storage/atomicJsonFile.ts'), { '../../common/storage/canonicalJson': loadTsModule(path.join(__dirname, '../src/common/storage/canonicalJson.ts')) }),
    electron: { dialog: {}, shell: {} },
    '@common/utils': { log: { error() {} } },
  },
)

const fixture = createTestStorageRoot('store-validation')
const tempDir = fixture.path

;(async() => {
  try {
    const originalDataPath = global.lxDataPath
    global.lxDataPath = tempDir
    const invalidBytes = '{"credential":"synthetic-secret",invalid'
    const recoveryPath = path.join(tempDir, 'dialog-recovery.json')
    fs.writeFileSync(recoveryPath, invalidBytes)
    let dialogDetails
    let revealed
    const getStore = loadTsModule(path.join(__dirname, '../src/main/utils/store.ts'), {
      '../storage/atomicJsonFile': loadTsModule(path.join(__dirname, '../src/main/storage/atomicJsonFile.ts'), { '../../common/storage/canonicalJson': loadTsModule(path.join(__dirname, '../src/common/storage/canonicalJson.ts')) }),
      electron: { dialog: { showMessageBoxSync: options => { dialogDetails = options.detail } }, shell: { showItemInFolder: value => { revealed = value } } },
      '@common/utils': { log: { error: error => { assert.ok(!error.message.includes('synthetic-secret')) } } },
    }).default
    try {
      getStore('dialog-recovery')
      assert.notStrictEqual(revealed, recoveryPath, 'reveal the successful quarantine, not the moved source')
      assert.strictEqual(fs.readFileSync(revealed, 'utf8'), invalidBytes)
      assert.ok(dialogDetails.includes(revealed))
      assert.ok(!dialogDetails.includes('synthetic-secret'))
    } finally { global.lxDataPath = originalDataPath }
    for (const [name, value] of [['null', 'null'], ['array', '[]'], ['syntax', '{invalid']]) {
      const filePath = path.join(tempDir, `${name}.json`)
      fs.writeFileSync(filePath, value, 'utf8')

      assert.throws(
        () => new Store(filePath, false),
        /Store data load failed/,
      `${name} JSON roots should be rejected`,
      )

      assert.strictEqual(fs.readFileSync(filePath, 'utf8'), value, 'strict rejection preserves invalid bytes')
      const previousQuarantine = fs.mkdtempSync(filePath + '.invalid-')
      fs.writeFileSync(path.join(previousQuarantine, 'original.json'), 'older evidence')
      const recovered = new Store(filePath, true)
      const quarantines = fs.readdirSync(tempDir).filter(file => file.startsWith(name + '.json.invalid-'))
      assert.strictEqual(quarantines.length, 2, 'invalid original must be retained, not overwritten')
      assert.strictEqual(fs.readFileSync(path.join(tempDir, quarantines.find(name => path.join(tempDir, name) !== previousQuarantine), 'original.json'), 'utf8'), value)
      assert.strictEqual(fs.readFileSync(path.join(previousQuarantine, 'original.json'), 'utf8'), 'older evidence')
      await recovered.setDurable('valid', true)
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { valid: true })
      assert.strictEqual(new Store(filePath, false).get('valid'), true, 'a fresh reader must observe durable recovery')
    }

    const failurePath = path.join(tempDir, 'inaccessible.json')
    fs.writeFileSync(failurePath, '{invalid', 'utf8')
    for (const operation of ['readFileSync', 'renameSync']) {
      const guardedFs = new Proxy(fs, {
        get(target, property) {
          if (property === operation) return () => { throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' }) }
          return Reflect.get(target, property)
        },
      })
      const { Store: GuardedStore } = loadTsModule(path.join(__dirname, '../src/main/utils/store.ts'), {
        'node:fs': guardedFs,
        '../storage/atomicJsonFile': { cleanupAtomicJsonOwnedTempsSync() {}, createAtomicJsonFile: () => ({}) },
        electron: { dialog: {}, shell: {} },
        '@common/utils': { log: { error() {} } },
      })
      assert.throws(() => new GuardedStore(failurePath, true), operation === 'readFileSync' ? /Store data load failed/ : /Store data recovery failed/)
      assert.strictEqual(fs.readFileSync(failurePath, 'utf8'), '{invalid')
    }

    const rollbackFilePath = path.join(tempDir, 'rollback.json')
    let failRename = false
    const rollbackStore = new Store(rollbackFilePath, false, {
      ...fs.promises,
      rename: async(...args) => { if (failRename) throw new Error('simulated write failure'); return fs.promises.rename(...args) },
    })
    await rollbackStore.setDurable('value', 'before')
    try {
      failRename = true
      await assert.rejects(
        () => rollbackStore.setDurable('value', 'after'),
        /Store persistence failed/,
      )
      await assert.rejects(
        () => rollbackStore.setDurable('new-key', 'new-value'),
        /Store persistence failed/,
      )
      assert.strictEqual(rollbackStore.has('new-key'), false)

      Object.defineProperty(rollbackStore.store, 'descriptor-key', {
        value: 'descriptor-before',
        enumerable: false,
        writable: false,
        configurable: true,
      })
      const previousDescriptor = Object.getOwnPropertyDescriptor(
        rollbackStore.store,
        'descriptor-key',
      )
      await assert.rejects(
        () => rollbackStore.setDurable('descriptor-key', 'descriptor-after'),
        /Store persistence failed/,
      )
      assert.deepStrictEqual(
        Object.getOwnPropertyDescriptor(rollbackStore.store, 'descriptor-key'),
        previousDescriptor,
      )
    } finally {
      failRename = false
    }
    assert.strictEqual(rollbackStore.get('value'), 'before')

    const originalBackingPrototype = Object.getPrototypeOf(rollbackStore.store)
    const protoValue = { safe: true }
    await rollbackStore.setDurable('__proto__', protoValue)
    const persistedProtoStore = JSON.parse(fs.readFileSync(rollbackFilePath, 'utf8'))
    assert.strictEqual(
      Object.prototype.hasOwnProperty.call(persistedProtoStore, '__proto__'),
      true,
    )
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(persistedProtoStore, '__proto__').value,
      protoValue,
    )
    assert.strictEqual(Object.getPrototypeOf(rollbackStore.store), originalBackingPrototype)
  } finally {
    fixture.cleanup()
  }

  console.log('store validation tests passed')
})().catch(error => { console.error(error); process.exitCode = 1 })
