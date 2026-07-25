const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const loadTsModule = require('./test-utils/load-ts-module')

const { Store } = loadTsModule(
  path.join(__dirname, '../src/main/utils/store.ts'),
  {
    electron: { dialog: {}, shell: {} },
    '@common/utils': { log: { error() {} } },
  },
)

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-store-validation-'))

try {
  for (const [name, value] of [['null', null], ['array', []]]) {
    const filePath = path.join(tempDir, `${name}.json`)
    fs.writeFileSync(filePath, JSON.stringify(value), 'utf8')

    assert.throws(
      () => new Store(filePath, false),
      /parse data error/,
      `${name} JSON roots should be rejected`,
    )

    const recovered = new Store(filePath, true)
    recovered.set('valid', true)
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(filePath, 'utf8')), { valid: true })
  }

  const rollbackFilePath = path.join(tempDir, 'rollback.json')
  const rollbackStore = new Store(rollbackFilePath)
  rollbackStore.set('value', 'before')
  const originalRenameSync = fs.renameSync
  try {
    fs.renameSync = () => {
      throw new Error('simulated write failure')
    }
    assert.throws(
      () => rollbackStore.set('value', 'after'),
      /simulated write failure/,
    )
    assert.throws(
      () => rollbackStore.set('new-key', 'new-value'),
      /simulated write failure/,
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
    assert.throws(
      () => rollbackStore.set('descriptor-key', 'descriptor-after'),
      /simulated write failure/,
    )
    assert.deepStrictEqual(
      Object.getOwnPropertyDescriptor(rollbackStore.store, 'descriptor-key'),
      previousDescriptor,
    )
  } finally {
    fs.renameSync = originalRenameSync
  }
  assert.strictEqual(rollbackStore.get('value'), 'before')

  const originalBackingPrototype = Object.getPrototypeOf(rollbackStore.store)
  const protoValue = { safe: true }
  rollbackStore.set('__proto__', protoValue)
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
  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log('store validation tests passed')
