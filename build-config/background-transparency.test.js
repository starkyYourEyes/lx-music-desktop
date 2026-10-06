const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const transparency = loadTsModule(path.join(root, 'src/common/utils/backgroundTransparency.ts'))

test('background transparency normalization defaults, clamps, and rounds user input', () => {
  assert.equal(transparency.normalizeBackgroundTransparency(undefined), 40)
  assert.equal(transparency.normalizeBackgroundTransparency(null), 40)
  assert.equal(transparency.normalizeBackgroundTransparency(''), 40)
  assert.equal(transparency.normalizeBackgroundTransparency('invalid'), 40)
  assert.equal(transparency.normalizeBackgroundTransparency(false), 40)
  assert.equal(transparency.normalizeBackgroundTransparency(-1), 0)
  assert.equal(transparency.normalizeBackgroundTransparency(42.6), 43)
  assert.equal(transparency.normalizeBackgroundTransparency(101), 100)
})

test('layout background opacity changes continuously across the full range', () => {
  assert.equal(transparency.getLayoutBackgroundOpacity(0), 1)
  assert.equal(transparency.getLayoutBackgroundOpacity(25), 0.75)
  assert.equal(transparency.getLayoutBackgroundOpacity(50), 0.5)
  assert.equal(transparency.getLayoutBackgroundOpacity(75), 0.25)
  assert.equal(transparency.getLayoutBackgroundOpacity(100), 0)
})

test('layout backgrounds use unified continuously composited layers', () => {
  const app = fs.readFileSync(path.join(root, 'src/renderer/App.vue'), 'utf8')
  const styles = fs.readFileSync(path.join(root, 'src/renderer/assets/styles/index.less'), 'utf8')
  const toolbar = fs.readFileSync(path.join(root, 'src/renderer/components/layout/Toolbar/index.vue'), 'utf8')
  const playBar = fs.readFileSync(path.join(root, 'src/renderer/components/layout/PlayBar/ModernBar.vue'), 'utf8')

  assert.match(app, /--layout-background-opacity/)
  assert.doesNotMatch(app, /background-clear/)
  assert.match(app, /#container\s*\{[\s\S]*?&::before\s*\{[\s\S]*?opacity:\s*var\(--layout-background-opacity\)/)
  assert.match(app, /#left::before,\s*#right::before\s*\{[\s\S]*?background-color:\s*var\(--color-main-background\);[\s\S]*?opacity:\s*var\(--layout-background-opacity\)/)
  assert.doesNotMatch(app, /#left\s*\{[\s\S]*?background-color:\s*var\(--color-layout-background\)/)
  assert.doesNotMatch(styles, /--color-layout-background/)
  assert.doesNotMatch(toolbar, /background-color:\s*var\(--color-surface-background\)/)
  assert.doesNotMatch(playBar, /background-color:\s*var\(--color-surface-background\)/)
})

test('application settings preserve the current visual density by default', () => {
  const defaults = loadTsModule(path.join(root, 'src/common/defaultSetting.ts'), {
    './performance/featurePolicy': loadTsModule(path.join(__dirname, '../src/common/performance/featurePolicy.ts')),
    './constants': { RECOMMEND_HOME_SECTION_IDS: [] },
    './projectIdentity': { PROJECT_IDENTITY: { defaultWebdavUrl: '' } },
    './utils/playBarLayout': { PLAY_BAR_HEIGHT_DEFAULT: 74 },
    './utils/backgroundTransparency': transparency,
  }).default

  assert.equal(defaults['common.backgroundTransparency'], 40)
})
