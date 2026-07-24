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
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true })
}

console.log('store validation tests passed')
