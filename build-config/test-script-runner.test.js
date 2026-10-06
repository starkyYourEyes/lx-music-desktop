const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root')
const path = require('node:path')
const test = require('node:test')
const { runTestScripts } = require('../scripts/run-test-scripts')

test('runs every matching script in a separate process and reports each failure', () => {
  const fixture = createTestStorageRoot('runner-test')
  const root = fixture.path
  try {
    fs.writeFileSync(path.join(root, 'test-a.js'), 'global.leaked = true; process.exitCode = 7')
    fs.writeFileSync(path.join(root, 'test-b.js'), 'require("node:assert/strict").equal(global.leaked, undefined); require("node:fs").writeFileSync(__dirname + "/ran-b", "yes")')
    fs.writeFileSync(path.join(root, 'test-c.js'), 'throw new Error("fixture failure")')
    fs.writeFileSync(path.join(root, 'helper.js'), 'throw new Error("must not run")')
    const messages = []
    const result = runTestScripts({ directory: root, stdio: 'ignore', report: message => messages.push(message) })
    assert.equal(result, 1)
    assert.equal(fs.readFileSync(path.join(root, 'ran-b'), 'utf8'), 'yes')
    assert.ok(messages.some(message => message.includes('FAIL test-a.js')))
    assert.ok(messages.some(message => message.includes('FAIL test-c.js')))
    assert.ok(messages.some(message => message.includes('PASS test-b.js')))
  } finally {
    fixture.cleanup()
  }
})

test('returns success only when all scripts exit zero', () => {
  const fixture = createTestStorageRoot('runner-test')
  const root = fixture.path
  try {
    fs.writeFileSync(path.join(root, 'test-pass.js'), 'process.exitCode = 0')
    assert.equal(runTestScripts({ directory: root, stdio: 'ignore', report() {} }), 0)
    assert.equal(runTestScripts({ directory: root, executable: path.join(root, 'missing-node'), stdio: 'ignore', report() {} }), 1)
  } finally {
    fixture.cleanup()
  }
})

const { spawnSync } = require('node:child_process')
test('integration CLI supplies an owned fixture root and propagates child failure', () => {
  const fixture = createTestStorageRoot('integration-runner')
  try {
    const child = path.join(fixture.path, 'child.js')
    const resultPath = path.join(fixture.path, 'result.json')
    fs.writeFileSync(child, 'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ root: process.env.LX_TEST_STORAGE_ROOT, args: process.argv.slice(3) })); process.exitCode = Number(process.argv[3])')
    for (const status of [0, 7]) {
      const result = spawnSync(process.execPath, ['scripts/run-test-environment.js', child, resultPath, String(status), 'space argument'], { encoding: 'utf8', windowsHide: true })
      assert.equal(result.status, status)
      const saved = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
      assert.notEqual(saved.root, process.env.LX_TEST_STORAGE_ROOT)
      assert.deepEqual(saved.args, [String(status), 'space argument'])
      assert.equal(fs.existsSync(saved.root), status !== 0)
      if (status !== 0) {
        assert.ok(result.stderr.includes(saved.root))
        fs.rmdirSync(saved.root) // The synthetic child created no content.
      }
    }
  } finally { fixture.cleanup() }
})
