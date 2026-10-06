const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root')
const path = require('node:path')
const test = require('node:test')
const { discoverUnitTests } = require('../scripts/run-unit-tests')

test('discovers nested Node tests while keeping explicitly separate integration suites out', () => {
  const fixture = createTestStorageRoot('runner-test')
  const root = fixture.path
  try {
    fs.mkdirSync(path.join(root, 'nested'))
    fs.mkdirSync(path.join(root, 'storage-electron'))
    for (const name of ['new.test.js', 'nested/another.test.js', 'helper.js', 'storage-electron/db.test.js', 'packaged-app.test.js']) {
      fs.writeFileSync(path.join(root, name), '')
    }
    assert.deepEqual(discoverUnitTests(root).map(file => path.relative(root, file).replaceAll('\\', '/')), ['nested/another.test.js', 'new.test.js'])
  } finally {
    fixture.cleanup()
  }
})
