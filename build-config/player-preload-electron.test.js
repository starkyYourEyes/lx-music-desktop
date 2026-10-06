const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root')
const { test } = require('node:test')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const ts = require('typescript')

test('real Chromium audio reuses buffers, preserves output settings and delivers events through repeated handoffs', { timeout: 60000 }, async() => {
  const fixture = createTestStorageRoot('lx-preload-test')
  const output = fixture.path
  try {
    for (const [name, relative] of [
      ['player', 'src/renderer/plugins/player/index.ts'],
      ['coordinator', 'src/renderer/core/music/playback/coordinator.ts'],
    ]) {
      const source = await fs.readFile(path.join(__dirname, '..', relative), 'utf8')
      const { outputText } = ts.transpileModule(source.replaceAll('import.meta.url', "'file:///unused-worklet.js'"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      })
      await fs.writeFile(path.join(output, `${name}.js`), outputText)
    }
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    await promisify(execFile)(require('electron'), [path.join(__dirname, 'test-utils/check-player-preload.js'), output], {
      env, windowsHide: true, timeout: 50000,
    })
    const actual = JSON.parse(await fs.readFile(path.join(output, 'results.json'), 'utf8'))
    assert.equal(actual.results.length, 2)
    for (const result of actual.results) {
      assert.ok(result.bufferedBefore > 0)
      assert.equal(result.assignments, 0, 'handoff must not assign src again')
      assert.equal(result.volume, 0.4)
      assert.equal(result.rate, 1.25)
      assert.equal(result.muted, false)
      assert.ok(result.duration > 11)
      assert.ok(result.time > 0)
      assert.ok(result.peak > 0.001, 'audio must reach the existing analyser after graph handoff')
    }
    assert.ok(actual.mainCanplay >= 2)
    assert.ok(actual.playing >= 4)
    assert.ok(actual.paused >= 2)
    assert.ok(actual.updates >= 2)
  } finally {
    assert.ok(path.basename(output).startsWith('lx-preload-test-'))
    fixture.cleanup()
  }
})
