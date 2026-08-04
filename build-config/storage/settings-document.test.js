const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { after, beforeEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const sourceRoot = path.resolve(__dirname, '../../src')
const originalResolveFilename = Module._resolveFilename
const originalLoad = Module._load
let storeState = {}
let storeOverrides = []
let legacyConfig
let migrateUserApiCalls = 0
let migrateDataJsonCalls = 0

const testStore = {
  get(key) {
    return storeState[key]
  },
  has(key) {
    return Object.hasOwn(storeState, key)
  },
  override(value) {
    storeState = structuredClone(value)
    storeOverrides.push(structuredClone(value))
  },
}

Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) {
    request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  }
  if (request.startsWith('@common/')) {
    request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

Module._load = function(request, parent, isMain) {
  if (request == 'electron') {
    return {
      nativeTheme: {},
      powerSaveBlocker: {},
    }
  }
  if (request == '@main/utils/store') return () => testStore
  if (request == './migrate' && parent?.filename.endsWith(path.join('main', 'utils', 'index.ts'))) {
    return {
      migrateDataJson: async() => { migrateDataJsonCalls++ },
      migrateHotKey: async() => null,
      migrateUserApi: async() => { migrateUserApiCalls++ },
      parseDataFile: async() => legacyConfig,
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

after(() => {
  Module._resolveFilename = originalResolveFilename
  Module._load = originalLoad
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const {
  parseSettingsDocument,
  replaceCatalogPreferences,
  replaceOrdinarySettings,
} = require('../../src/main/storage/settings/document.ts')

const defaultCatalogPreferences = {
  version: 1,
  leaderboard: { source: 'kw', boardId: 'kw__16' },
  songList: { source: 'kw', sortId: 'new', tagId: '' },
  search: { temp_source: 'kw', source: 'all', type: 'music' },
}

const ordinarySetting = {
  version: '2.11.0',
  'theme.id': 'green',
  'localMusic.dirs': ['D:/music'],
}

const customCatalogPreferences = {
  version: 1,
  leaderboard: { source: 'kg', boardId: 'kg__1' },
  songList: { source: 'tx', sortId: 'hot', tagId: 'rock' },
  search: { temp_source: 'wy', source: 'mg', type: 'songlist' },
}

const makeDocument = () => ({
  storageSchemaVersion: 1,
  version: ordinarySetting.version,
  setting: structuredClone(ordinarySetting),
  catalogPreferences: structuredClone(customCatalogPreferences),
})

describe('settings document', () => {
  it('upgrades an old settings document with default catalog preferences and no credential fields', () => {
    const result = parseSettingsDocument({
      version: '2.11.0',
      setting: {
        ...ordinarySetting,
        'webdav.username': 'USER_SENTINEL',
        'webdav.password': 'PASS_SENTINEL',
      },
    })

    assert.deepEqual(Object.keys(result), ['storageSchemaVersion', 'version', 'setting', 'catalogPreferences'])
    assert.equal(result.storageSchemaVersion, 1)
    assert.deepEqual(result.catalogPreferences, defaultCatalogPreferences)
    assert.equal(Object.hasOwn(result.setting, 'webdav.username'), false)
    assert.equal(Object.hasOwn(result.setting, 'webdav.password'), false)
    assert.doesNotMatch(JSON.stringify(result), /(?:USER|PASS)_SENTINEL/)
  })

  it('validates exact document shape, versions, and bounded catalog values without echoing input', () => {
    const valid = makeDocument()
    assert.deepEqual(parseSettingsDocument(valid), valid)

    const invalidDocuments = [
      { ...valid, storageSchemaVersion: 2 },
      { ...valid, version: '' },
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { version: valid.version, setting: valid.setting, extra: true },
      { ...valid, setting: [] },
      {
        ...valid,
        catalogPreferences: {
          ...valid.catalogPreferences,
          leaderboard: { source: 'kw', boardId: 'SECRET_VALUE_SENTINEL'.repeat(20) },
        },
      },
      {
        ...valid,
        setting: { ...valid.setting, 'webdav.password': 'SECRET_VALUE_SENTINEL' },
      },
    ]

    for (const value of invalidDocuments) {
      assert.throws(
        () => parseSettingsDocument(value),
        error => !error.message.includes('SECRET_VALUE_SENTINEL'),
      )
    }
  })

  it('returns deeply isolated parsed documents', () => {
    const input = makeDocument()
    const result = parseSettingsDocument(input)

    assert.notStrictEqual(result, input)
    assert.notStrictEqual(result.setting, input.setting)
    assert.notStrictEqual(result.setting['localMusic.dirs'], input.setting['localMusic.dirs'])
    assert.notStrictEqual(result.catalogPreferences, input.catalogPreferences)
    assert.notStrictEqual(result.catalogPreferences.leaderboard, input.catalogPreferences.leaderboard)

    input.setting['localMusic.dirs'][0] = 'D:/changed'
    input.catalogPreferences.leaderboard.boardId = 'changed'
    assert.deepEqual(result.setting['localMusic.dirs'], ['D:/music'])
    assert.equal(result.catalogPreferences.leaderboard.boardId, 'kg__1')
  })

  it('preserves catalog preferences while replacing ordinary settings and drops empty credential fields', () => {
    const current = makeDocument()
    const nextSetting = {
      ...ordinarySetting,
      version: '3.0.0',
      'theme.id': 'black',
      'webdav.username': '',
      'webdav.password': '',
    }
    const next = replaceOrdinarySettings(current, nextSetting)

    assert.equal(next.version, '3.0.0')
    assert.equal(next.setting['theme.id'], 'black')
    assert.equal(Object.hasOwn(next.setting, 'webdav.username'), false)
    assert.equal(Object.hasOwn(next.setting, 'webdav.password'), false)
    assert.deepEqual(next.catalogPreferences, current.catalogPreferences)
    assert.notStrictEqual(next.setting, nextSetting)
    assert.notStrictEqual(next.catalogPreferences, current.catalogPreferences)
    assert.notStrictEqual(next.catalogPreferences.search, current.catalogPreferences.search)
  })

  it('rejects either non-empty WebDAV credential setting without echoing it', () => {
    for (const key of ['webdav.username', 'webdav.password']) {
      assert.throws(
        () => replaceOrdinarySettings(makeDocument(), {
          ...ordinarySetting,
          [key]: `${key}_SECRET_SENTINEL`,
        }),
        error => /WebDAV credentials/i.test(error.message) && !error.message.includes('SECRET_SENTINEL'),
      )
    }
  })

  it('replaces only catalog preferences and deeply isolates both document sections', () => {
    const current = makeDocument()
    const preferences = structuredClone(defaultCatalogPreferences)
    const next = replaceCatalogPreferences(current, preferences)

    assert.equal(next.version, current.version)
    assert.deepEqual(next.setting, current.setting)
    assert.deepEqual(next.catalogPreferences, preferences)
    assert.notStrictEqual(next.setting, current.setting)
    assert.notStrictEqual(next.setting['localMusic.dirs'], current.setting['localMusic.dirs'])
    assert.notStrictEqual(next.catalogPreferences, preferences)
    assert.notStrictEqual(next.catalogPreferences.songList, preferences.songList)

    assert.throws(() => replaceCatalogPreferences(current, {
      ...preferences,
      search: { ...preferences.search, type: 'album' },
    }))
  })
})

describe('settings Store integration', () => {
  const defaultSetting = require('../../src/common/defaultSetting.ts').default
  const initialDocument = () => parseSettingsDocument({
    version: defaultSetting.version,
    setting: {
      ...defaultSetting,
      'webdav.username': 'LEGACY_USER_SENTINEL',
      'webdav.password': 'LEGACY_PASS_SENTINEL',
    },
  })

  beforeEach(() => {
    storeState = initialDocument()
    storeState.catalogPreferences = structuredClone(customCatalogPreferences)
    storeOverrides = []
    legacyConfig = undefined
    migrateUserApiCalls = 0
    migrateDataJsonCalls = 0
    global.envParams = { cmdParams: {} }
    global.lx = {
      appSetting: {
        ...defaultSetting,
        'webdav.username': '',
        'webdav.password': '',
      },
    }
  })

  it('ordinary and catalog updates reread one Store and preserve the other document section', () => {
    const { updateCatalogPreferences, updateSetting } = require('../../src/main/utils/index.ts')

    updateSetting({ 'theme.id': 'black' })
    assert.deepEqual(storeState.catalogPreferences, customCatalogPreferences)
    assert.deepEqual(Object.keys(storeOverrides[0]), ['storageSchemaVersion', 'version', 'setting', 'catalogPreferences'])

    const latestPreferences = {
      ...defaultCatalogPreferences,
      leaderboard: { source: 'mg', boardId: 'mg__latest' },
    }
    updateCatalogPreferences(latestPreferences)
    assert.equal(storeState.setting['theme.id'], 'black')
    assert.deepEqual(storeState.catalogPreferences, latestPreferences)

    global.lx.appSetting['theme.id'] = 'black'
    updateSetting({ 'common.fontSize': 18 })
    assert.deepEqual(storeState.catalogPreferences, latestPreferences)
    assert.equal(storeOverrides.length, 3)
  })

  it('initializes from legacy config without invoking the retired data migration', async() => {
    const { initSetting } = require('../../src/main/utils/index.ts')
    storeState = {}
    legacyConfig = {
      setting: {
        ...defaultSetting,
        'theme.id': 'pink',
        'webdav.username': 'LEGACY_USER_SENTINEL',
        'webdav.password': 'LEGACY_PASS_SENTINEL',
      },
    }

    const result = await initSetting()

    assert.equal(result.setting['theme.id'], 'pink')
    assert.equal(result.setting['webdav.username'], '')
    assert.equal(result.setting['webdav.password'], '')
    assert.equal(migrateUserApiCalls, 1)
    assert.equal(migrateDataJsonCalls, 0)
    assert.deepEqual(storeState.catalogPreferences, defaultCatalogPreferences)
    assert.equal(Object.hasOwn(storeState.setting, 'webdav.username'), false)
    assert.equal(Object.hasOwn(storeState.setting, 'webdav.password'), false)
  })
})
