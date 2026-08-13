const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const loadLayout = () => loadTsModule(path.join(root, 'src/common/utils/playBarLayout.ts'))

test('play bar height normalization defaults, clamps, and rounds user input', () => {
  const { normalizePlayBarHeight } = loadLayout()

  assert.equal(normalizePlayBarHeight(undefined), 74)
  assert.equal(normalizePlayBarHeight(null), 74)
  assert.equal(normalizePlayBarHeight(''), 74)
  assert.equal(normalizePlayBarHeight('invalid'), 74)
  assert.equal(normalizePlayBarHeight(55), 56)
  assert.equal(normalizePlayBarHeight(65.6), 66)
  assert.equal(normalizePlayBarHeight(75), 74)
})

test('play bar layout scales artwork and keeps it vertically centered', () => {
  const { getPlayBarLayout } = loadLayout()

  assert.deepEqual(getPlayBarLayout(56), { height: 56, artworkSize: 42, paddingY: 7 })
  assert.deepEqual(getPlayBarLayout(65), { height: 65, artworkSize: 48, paddingY: 8.5 })
  assert.deepEqual(getPlayBarLayout(74), { height: 74, artworkSize: 54, paddingY: 10 })
})

test('application settings preserve the existing 74px play bar by default', () => {
  const defaults = loadTsModule(path.join(root, 'src/common/defaultSetting.ts'), {
    './constants': { RECOMMEND_HOME_SECTION_IDS: [] },
    './projectIdentity': { PROJECT_IDENTITY: { defaultWebdavUrl: '' } },
    './utils/playBarLayout': loadLayout(),
  }).default

  assert.equal(defaults['common.playBarHeight'], 74)
})
