const assert = require('node:assert/strict')
const test = require('node:test')
const path = require('node:path')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const sourceSetting = loadTsModule(path.join(__dirname, '../src/common/utils/playbackSourceSetting.ts'))

test('normalizes fallback IDs without inserting or reordering sources', () => {
  const normalized = sourceSetting.normalizePlaybackSourceSetting({
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['b', 'primary', 'b', '', 1, 'missing', 'c'],
    'common.apiFallbackMode': 'parallel',
  })
  assert.deepEqual(normalized, {
    'common.apiFallbackSources': ['b', 'missing', 'c'],
    'common.apiFallbackMode': 'serial',
  })
})

test('uses an authoritative registry only when one is supplied', () => {
  const setting = {
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['saved', 'installed'],
    'common.apiFallbackMode': 'serial',
  }
  assert.deepEqual(sourceSetting.normalizePlaybackSourceSetting(setting)['common.apiFallbackSources'], ['saved', 'installed'])
  assert.deepEqual(
    sourceSetting.normalizePlaybackSourceSetting(setting, new Set(['primary', 'installed']))['common.apiFallbackSources'],
    ['installed'],
  )
})

test('changing primary removes the new primary and never adds the old one', () => {
  assert.deepEqual(sourceSetting.changePrimaryPlaybackSource({
    'common.apiSource': 'old',
    'common.apiFallbackSources': ['new', 'backup'],
    'common.apiFallbackMode': 'serial',
  }, 'new'), {
    'common.apiSource': 'new',
    'common.apiFallbackSources': ['backup'],
    'common.apiFallbackMode': 'serial',
  })
})

test('add move and remove preserve explicit user order', () => {
  assert.deepEqual(sourceSetting.addPlaybackFallback(['b'], 'c'), ['b', 'c'])
  assert.deepEqual(sourceSetting.addPlaybackFallback(['b'], 'b'), ['b'])
  assert.deepEqual(sourceSetting.movePlaybackFallback(['b', 'c', 'd'], 'd', -1), ['b', 'd', 'c'])
  assert.deepEqual(sourceSetting.removePlaybackFallback(['b', 'c'], 'b'), ['c'])
})

test('default setting starts with no fallbacks and serial mode', () => {
  const defaults = loadTsModule(path.join(__dirname, '../src/common/defaultSetting.ts'), {
    'node:path': require('node:path'),
    'node:os': require('node:os'),
    './constants': { RECOMMEND_HOME_SECTION_IDS: [] },
    './projectIdentity': { PROJECT_IDENTITY: {} },
  }).default
  assert.deepEqual(defaults['common.apiFallbackSources'], [])
  assert.equal(defaults['common.apiFallbackMode'], 'serial')
})

test('upgrade initializes an empty list instead of deriving installed sources', () => {
  const migrate = loadTsModule(path.join(__dirname, '../src/common/utils/migrateSetting.ts'), {
    './index': { compareVer: (a, b) => a.localeCompare(b, undefined, { numeric: true }) },
  }).default
  const migrated = migrate({ version: '2.1.0', 'common.apiSource': 'primary' })
  assert.deepEqual(migrated['common.apiFallbackSources'], [])
  assert.equal(migrated['common.apiFallbackMode'], 'serial')
})
