const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')

const fixtureBase = path.join(__dirname, '../../.superpowers/t')
fs.mkdirSync(fixtureBase, { recursive: true })
process.env.LX_TEST_STORAGE_ROOT = fixtureBase
process.env.TEMP = fixtureBase
process.env.TMP = fixtureBase

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
let activeThemeStore

Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

Module._load = function(request, parent, isMain) {
  if (request == 'electron') {
    return {
      dialog: { showMessageBoxSync() {} },
      shell: { showItemInFolder() {} },
      nativeTheme: { shouldUseDarkColors: false },
      powerSaveBlocker: { isStarted: () => false, start: () => 1, stop() {} },
    }
  }
  if (request == '@common/utils') {
    return {
      encodePath: value => value,
      isUrl: () => false,
      log: { error() {} },
      throttle: callback => callback,
    }
  }
  if (request == '@main/utils/store' && parent?.filename.endsWith(path.join('main', 'utils', 'index.ts'))) {
    return () => activeThemeStore
  }
  if (request == '@common/constants') {
    return { STORE_NAMES: { THEME: 'theme' }, URL_SCHEME_RXP: /^$/ }
  }
  if (request == '@common/defaultSetting') return { version: 'test' }
  if (request == '@common/defaultHotKey') return { local: {}, global: {} }
  if (request == '@common/utils/migrateSetting') return value => value
  if (request == '@common/utils/nodejs') return { joinPath: path.join }
  if (request == '@common/theme/index.json') return []
  if (request == '@common/utils/webdavUrl') return { normalizeWebDAVRootUrl() {} }
  if (request == '@common/utils/playbackSourceSetting') return { normalizePlaybackSourceSetting: value => value }
  if (request == '@main/storage/settings/document') {
    return {
      parseSettingsDocument: value => value,
      replaceCatalogPreferences: value => value,
      replaceOrdinarySettings: value => value,
    }
  }
  if (request == './migrate' && parent?.filename.endsWith(path.join('main', 'utils', 'index.ts'))) {
    return {
      migrateHotKey: async() => null,
      migrateUserApi: async() => {},
      parseDataFile: async() => null,
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

test.after(() => {
  Module._resolveFilename = originalResolveFilename
  Module._load = originalLoad
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex')

const createTheme = (id, background) => ({
  id,
  name: id,
  isDark: false,
  isDarkFont: false,
  isCustom: true,
  config: {
    themeColors: {},
    extInfo: { '--background-image': background },
  },
})

const failingStoreFileSystem = () => ({
  ...fsp,
  async open(targetPath, flags, mode) {
    const handle = await fsp.open(targetPath, flags, mode)
    if (!String(targetPath).includes('.owned-tmp-')) return handle
    return {
      writeFile: handle.writeFile.bind(handle),
      async sync() { throw new Error('injected theme Store fsync failure') },
      close: handle.close.bind(handle),
    }
  },
})

test('failed durable theme save preserves disk and published state and reclaims only its new final', async() => {
  // Catches promotion/store code that publishes caches early, or leaves an orphan final after Store persistence fails.
  const fixture = createTestStorageRoot('theme-store-transaction')
  let store
  try {
    const profileRoot = path.join(fixture.path, 'profile')
    const tempRoot = path.join(fixture.path, 'temp')
    const runTempRoot = path.join(tempRoot, 'run-current')
    const storePath = path.join(fixture.path, 'theme.json')
    const externalImage = path.join(fixture.path, 'external.png')
    const assetRoot = path.join(profileRoot, 'assets', 'theme-images')
    const unrelatedAsset = path.join(assetRoot, 'existing.img')
    const priorTheme = createTheme('prior', 'existing.img')
    await fsp.mkdir(runTempRoot, { recursive: true })
    await fsp.mkdir(assetRoot, { recursive: true })
    await fsp.writeFile(unrelatedAsset, 'unrelated durable asset')
    await fsp.writeFile(externalImage, pngBytes)
    await fsp.writeFile(storePath, JSON.stringify({ themes: [priorTheme] }))

    const { Store } = require('../../src/main/utils/store.ts')
    store = activeThemeStore = new Store(storePath, false, failingStoreFileSystem())
    const storagePaths = loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts'))
    const { createRunTempHandle } = loadTsModule(path.join(__dirname, '../../src/main/utils/tempLifecycle.ts'), {
      '@main/utils/storagePaths': storagePaths,
    })
    const runTemp = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
    const { createThemeAssetManager } = loadTsModule(path.join(__dirname, '../../src/main/services/themeAssetManager.ts'), {
      '@main/utils/storagePaths': storagePaths,
    })
    const manager = createThemeAssetManager({ profileRoot, runTemp, runTempRoot })
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    global.storagePaths = { profileRoot }
    const utilsPath = require.resolve('../../src/main/utils/index.ts')
    delete require.cache[utilsPath]
    const utils = require(utilsPath)
    const beforePublished = utils.getAllThemes().userThemes
    const nextTheme = createTheme('next', 'none')

    await assert.rejects(
      Promise.resolve(utils.saveTheme({ theme: nextTheme, stagingId: staged.stagingId }, manager)),
      /Store persistence failed/,
    )

    assert.strictEqual(utils.getAllThemes().userThemes, beforePublished)
    assert.deepEqual(utils.getAllThemes().userThemes, [priorTheme])
    assert.deepEqual(store.get('themes'), [priorTheme])
    assert.deepEqual(JSON.parse(await fsp.readFile(storePath, 'utf8')), { themes: [priorTheme] })
    assert.equal(await fsp.readFile(unrelatedAsset, 'utf8'), 'unrelated durable asset')
    assert.deepEqual(await fsp.readdir(assetRoot), ['existing.img'])
    assert.equal(
      fs.existsSync(path.join(runTempRoot, 'theme-editor', staged.stagingId)),
      process.platform == 'linux',
    )
    assert.deepEqual(await fsp.readFile(externalImage), pngBytes)
    await manager.discardThemeImage({ stagingId: staged.stagingId })
    await assert.rejects(manager.discardThemeImage({ stagingId: staged.stagingId }), /theme_stage_invalid/)
  } finally {
    await store?.flush().catch(() => {})
    activeThemeStore = undefined
    fixture.cleanup()
  }
})
