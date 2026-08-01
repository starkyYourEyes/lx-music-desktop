const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
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

test('changing primary returns only structured-clone-safe playback source fields', () => {
  const unrelated = new Proxy({}, {})
  assert.deepEqual(sourceSetting.changePrimaryPlaybackSource({
    'common.apiSource': 'old',
    'common.apiFallbackSources': ['new', 'backup'],
    'common.apiFallbackMode': 'serial',
    unrelated,
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

test('an empty non-authoritative startup registry preserves saved fallbacks', () => {
  const setting = {
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['saved'],
    'common.apiFallbackMode': 'serial',
  }
  assert.deepEqual(sourceSetting.normalizePlaybackSourceSetting(setting)['common.apiFallbackSources'], ['saved'])
})

test('authoritative deletion removes only missing IDs and inserts nothing', () => {
  const setting = {
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['removed', 'kept'],
    'common.apiFallbackMode': 'serial',
  }
  assert.deepEqual(
    sourceSetting.normalizePlaybackSourceSetting(setting, new Set(['primary', 'kept'])),
    { 'common.apiFallbackSources': ['kept'], 'common.apiFallbackMode': 'serial' },
  )
})

test('the primary ID cannot be added through the UI helper', () => {
  const primary = 'primary'
  const next = sourceSetting.normalizePlaybackSourceSetting({
    'common.apiSource': primary,
    'common.apiFallbackSources': sourceSetting.addPlaybackFallback([], primary),
    'common.apiFallbackMode': 'serial',
  })
  assert.deepEqual(next['common.apiFallbackSources'], [])
})

test('registry reconciliation cleans IDs only after authority is established', () => {
  const setting = {
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['saved', 'custom'],
    'common.apiFallbackMode': 'serial',
  }
  assert.deepEqual(
    sourceSetting.reconcilePlaybackSourceRegistry(setting, [], [], false)['common.apiFallbackSources'],
    ['saved', 'custom'],
  )
  assert.deepEqual(
    sourceSetting.reconcilePlaybackSourceRegistry(setting, [], ['custom'], true)['common.apiFallbackSources'],
    ['custom'],
  )
})

test('authoritative reconciliation reruns for imported settings and registry changes', () => {
  let setting = {
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['installed'],
    'common.apiFallbackMode': 'serial',
  }
  const apply = customIds => {
    setting = { ...setting, ...sourceSetting.reconcilePlaybackSourceRegistry(
      setting, ['primary'], customIds, true,
    ) }
  }
  setting = { ...setting, 'common.apiFallbackSources': ['missing', 'installed', 'primary'] }
  apply(['installed'])
  assert.deepEqual(setting['common.apiFallbackSources'], ['installed'])
  setting = { ...setting, 'common.apiFallbackSources': ['installed', 'later'] }
  apply(['installed', 'later'])
  assert.deepEqual(setting['common.apiFallbackSources'], ['installed', 'later'])
  apply(['later'])
  assert.deepEqual(setting['common.apiFallbackSources'], ['later'])
})

test('temporary runtime initialization failure does not remove a configured fallback', () => {
  const setting = {
    'common.apiSource': 'primary',
    'common.apiFallbackSources': ['fallback'],
    'common.apiFallbackMode': 'serial',
  }
  const installedCustomIds = ['fallback']
  const runtimeStates = new Map([['fallback', { status: true }]])
  runtimeStates.set('fallback', { status: false, message: 'temporary initialization failure' })
  assert.deepEqual(
    sourceSetting.reconcilePlaybackSourceRegistry(
      setting, ['primary'], installedCustomIds, true,
    )['common.apiFallbackSources'],
    ['fallback'],
  )
})

test('fallback normalization has no artificial item-count limit', () => {
  const fallbackIds = Array.from({ length: 25 }, (_, index) => `fallback-${index}`)
  assert.deepEqual(sourceSetting.normalizePlaybackSourceSetting({
    'common.apiSource': 'primary',
    'common.apiFallbackSources': fallbackIds,
    'common.apiFallbackMode': 'serial',
  })['common.apiFallbackSources'], fallbackIds)
})

test('Add choices exclude primary selected and install-disabled sources but keep runtime-failed installed sources', () => {
  const sources = [
    { id: 'primary', disabled: false },
    { id: 'selected', disabled: false },
    { id: 'runtime-failed', disabled: false, runtimeStatus: false },
    { id: 'install-disabled', disabled: true },
  ]
  assert.deepEqual(
    sourceSetting.getAddablePlaybackSources(sources, 'primary', ['selected']).map(({ id }) => id),
    ['runtime-failed'],
  )
})

test('the fallback add trigger cannot bubble into the document menu-close listener', () => {
  const component = fs.readFileSync(path.join(
    __dirname,
    '../src/renderer/views/Setting/components/ApiFallbackSources.vue',
  ), 'utf8')
  assert.match(component, /@click\.stop="showAddMenu"/)
})
