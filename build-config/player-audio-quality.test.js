const assert = require('node:assert/strict')
const { execFile } = require('node:child_process')
const fs = require('node:fs/promises')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root')
const path = require('node:path')
const { promisify } = require('node:util')
const { before, after, test } = require('node:test')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
let fixture
let outputPath
let results

before(async() => {
  fixture = createTestStorageRoot('lx-player-audio-test-')
  outputPath = fixture.path
  const source = await fs.readFile(path.join(root, 'src/renderer/plugins/player/index.ts'), 'utf8')
  // The worklet is not used here; CommonJS cannot parse its import.meta URL.
  const { outputText } = ts.transpileModule(source.replaceAll('import.meta.url', "'file:///unused-worklet.js'"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  })
  await fs.writeFile(path.join(outputPath, 'player.js'), outputText)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  await promisify(execFile)(require('electron'), [
    path.join(__dirname, 'test-utils/render-player-audio.js'), outputPath,
  ], { env, windowsHide: true, timeout: 60000 })
  results = JSON.parse(await fs.readFile(path.join(outputPath, 'results.json'), 'utf8'))
}, { timeout: 65000 })

after(async() => {
  if (outputPath) {
    assert.ok(path.basename(outputPath).startsWith('lx-player-audio-test-'))
    fixture.cleanup()
  }
})

for (const [scenario, description] of [
  ['flat', 'opening the analyser preserves unprocessed stereo samples and dynamics'],
  ['disabled', 'disabling convolution restores unprocessed audio'],
  ['reset', 'repeatedly clearing convolution keeps the dry signal at unity gain'],
  ['during-playback', 'disabling convolution during rendering restores the dry signal'],
  ['enabled', 'enabled convolution retains the existing wet/dry compressed sound'],
  ['reenabled', 'replacing and re-enabling convolution does not duplicate the dry path'],
  ['eq', 'EQ without convolution is not subject to hidden compression'],
  ['original', 'original mode bypasses saved EQ and convolution even before graph initialization'],
  ['restore-effects', 'returning to effects restores the saved equalizer'],
  ['boost', 'boosted equalizer includes automatic input headroom'],
  ['eq-reset', 'resetting boosted EQ restores unity gain'],
  ['mode-live', 'rapid mode changes settle on original audio without clicks'],
  ['eq-live', 'rapid equalizer changes safely settle on the latest curve'],
  ['policy-off', 'disabled optional policies preserve original audio after effects were initialized'],
  ['visualization-off', 'turning visualization off leaves the active equalizer audible'],
  ['effects-off-live', 'turning effects off during playback restores original output'],
]) {
  test(description, () => {
    const cases = results.filter(result => result.scenario == scenario)
    assert.equal(cases.length, 4)
    for (const result of cases) {
      assert.ok(result.maxError < 0.00001, JSON.stringify(result))
      if (scenario == 'mode-live') assert.ok(result.switchStep < 0.04, JSON.stringify(result))
      if (scenario == 'eq-live') assert.ok(result.peak < 0.96, JSON.stringify(result))
    }
  })
}

test('overlapping EQ boosts stay below full scale without muting the music', () => {
  const cases = results.filter(result => result.scenario == 'overlap')
  assert.equal(cases.length, 4)
  for (const result of cases) {
    assert.ok(result.peak < 0.91, JSON.stringify(result))
    assert.ok(result.peak > result.amplitude * 0.1, JSON.stringify(result))
  }
})
