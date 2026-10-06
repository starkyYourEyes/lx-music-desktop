const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTs = require('../../scripts/test-utils/load-ts-module')
const loadPolicy = () => loadTs(path.join(__dirname, '../../src/common/performance/featurePolicy.ts'))

test('legacy disabled capabilities stay disabled while recommendations are on demand', () => {
  const p = loadPolicy()
  const migrated = p.migratePerformanceSettings({ 'download.enable': false, 'desktopLyric.enable': false, 'player.soundEffect.mode': 'original', 'tray.enable': false })
  for (const feature of ['download', 'desktopLyric', 'soundEffects', 'audioVisualization', 'customTrayMenu']) {
    assert.equal(p.getFeatureMode(migrated, feature), 'off')
  }
  assert.equal(p.getFeatureMode(migrated, 'neteaseRecommend'), 'onDemand')
  assert.equal(migrated['performance.simplifyVisuals'], false)
  assert.equal(migrated['performance.sourceIdleMinutes'], 5)
})

test('existing explicit policy takes precedence and migration is idempotent', () => {
  const p = loadPolicy()
  const original = { 'download.enable': false, 'performance.features.download': 'resident', 'performance.cacheProfile': 'balanced', 'performance.simplifyVisuals': true }
  const once = p.migratePerformanceSettings(original)
  assert.equal(p.getFeatureMode(once, 'download'), 'resident')
  assert.equal(once['performance.cacheProfile'], 'balanced')
  assert.equal(once['performance.simplifyVisuals'], true)
  assert.deepEqual(p.migratePerformanceSettings({ ...original, ...once }), once)
})

test('either visualization location preserves demand and original mode preserves presets', () => {
  const p = loadPolicy()
  const original = { 'desktopLyric.audioVisualization': true, 'player.soundEffect.mode': 'original', 'player.soundEffect.biquadFilter.hz1000': 6 }
  assert.equal(p.getFeatureMode(original, 'audioVisualization'), 'onDemand')
  assert.equal(p.getFeatureMode(original, 'soundEffects'), 'off')
  assert.equal(original['player.soundEffect.biquadFilter.hz1000'], 6)
})

test('apply rejects unknown or invalid performance values without mutating inputs', () => {
  const p = loadPolicy()
  for (const patch of [
    { 'performance.features.download': 'invalid' }, { 'performance.cacheProfile': 'unlimited' },
    { 'performance.sourceIdleMinutes': -1 }, { 'performance.simplifyVisuals': 'false' },
    { 'performance.features.music': 'off' },
  ]) assert.throws(() => p.normalizePerformancePatch({}, patch), /Invalid performance setting/)
  const current = { 'download.enable': true }
  const patch = { 'performance.features.download': 'off' }
  const result = p.normalizePerformancePatch(current, patch)
  assert.equal(result['download.enable'], false)
  assert.deepEqual(current, { 'download.enable': true })
  assert.deepEqual(patch, { 'performance.features.download': 'off' })
})

test('policy changes preserve independent display and sound preferences', () => {
  const p = loadPolicy()
  const result = p.normalizePerformancePatch({ 'desktopLyric.enable': true, 'player.soundEffect.mode': 'effects' }, {
    'performance.features.desktopLyric': 'off', 'performance.features.soundEffects': 'off',
  })
  assert.equal(Object.hasOwn(result, 'desktopLyric.enable'), false)
  assert.equal(Object.hasOwn(result, 'player.soundEffect.mode'), false)
})

test('legacy download updates map to one authoritative policy without losing resident preference', () => {
  const p = loadPolicy()
  assert.equal(p.normalizePerformancePatch({}, { 'download.enable': true })['performance.features.download'], 'onDemand')
  assert.equal(p.normalizePerformancePatch({ 'performance.features.download': 'resident' }, { 'download.enable': true })['performance.features.download'], 'resident')
})
