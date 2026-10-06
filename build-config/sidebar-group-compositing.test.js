const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root')
const path = require('node:path')
const { promisify } = require('node:util')
const { before, after, test } = require('node:test')

let fixture
let outputPath
let results

before(async() => {
  fixture = createTestStorageRoot('lx-sidebar-render-')
  outputPath = fixture.path
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(require('electron'), [
    path.join(__dirname, 'test-utils/render-sidebar-groups.js'), outputPath,
  ], { env, windowsHide: true, timeout: 60000 })
  results = JSON.parse(await fs.readFile(path.join(outputPath, 'results.json'), 'utf8'))
}, { timeout: 65000 })

after(async() => {
  if (!outputPath) return
  assert.ok(path.basename(outputPath).startsWith('lx-sidebar-render-'))
  fixture.cleanup()
})

const groups = ['mine', 'external', ...['netease', 'qq_music', 'kugou'].flatMap(provider => [
  `platform-${provider}`, `${provider}:created`, `${provider}:collected`,
])]

for (const group of groups) {
  test(`${group} toggles without repainting the main page or moving its layout`, () => {
    const cases = results.filter(result => result.group == group)
    assert.equal(cases.length, 4, 'expand and collapse with visible and hidden scrollbars')
    for (const result of cases) {
      assert.notEqual(result.expandedBefore, result.expandedAfter, 'the real group heading must toggle')
      assert.deepEqual(result.after, result.before, 'main page geometry must remain stable')
      assert.deepEqual(result.sharedLayerPaints, [], `${group}: sidebar updates repainted a page-wide layer`)
      assert.ok(result.paintCount > 0, 'the renderer must actually paint the changed sidebar')
    }
  })
}
