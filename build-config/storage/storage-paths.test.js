const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
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

const storagePathsModule = '../../src/main/utils/storagePaths.ts'
const bootstrapModule = '../../src/main/bootstrap.ts'
const { PROJECT_IDENTITY } = require('../../src/common/projectIdentity.js')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')
const fixtures = []

const createFixture = prefix => {
  const fixture = createTestStorageRoot(prefix)
  fixtures.push(fixture)
  return fixture.path
}

afterEach(() => {
  delete global.storagePaths
  delete global.lxDataPath
  delete global.lxOldDataPath
  try { delete require.cache[require.resolve(storagePathsModule)] } catch {}
  try { delete require.cache[require.resolve(bootstrapModule)] } catch {}
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

describe('storage path contract', () => {
  it('builds distinct installed roots and keeps backups under the durable profile', () => {
    const { resolveStoragePaths } = require(storagePathsModule)
    const profileRoot = 'C:\\Users\\Alice\\AppData\\Roaming\\starky-lx-music-desktop\\LxDatas'

    assert.deepEqual(resolveStoragePaths({
      profileRoot,
      applicationCacheRoot: 'C:\\Users\\Alice\\AppData\\Local\\starky-lx-music-desktop',
      tempBase: 'C:\\Windows\\Temp',
      portableRoot: null,
    }), {
      portableRoot: null,
      profileRoot,
      cacheRoot: 'C:\\Users\\Alice\\AppData\\Local\\starky-lx-music-desktop\\cache',
      runtimeRoot: 'C:\\Users\\Alice\\AppData\\Local\\starky-lx-music-desktop\\runtime',
      sessionDataRoot: 'C:\\Users\\Alice\\AppData\\Local\\starky-lx-music-desktop\\runtime\\session-data',
      tempRoot: `C:\\Windows\\Temp\\${PROJECT_IDENTITY.appId}`,
      backupsRoot: `${profileRoot}\\backups`,
    })
  })

  it('builds explicit portable siblings beside the executable', () => {
    const { resolveStoragePaths } = require(storagePathsModule)
    const executablePath = 'D:\\Player\\app.exe'
    const portableRoot = path.win32.join(path.win32.dirname(executablePath), 'portable')

    assert.deepEqual(resolveStoragePaths({
      profileRoot: 'C:\\ignored\\profile',
      applicationCacheRoot: 'C:\\ignored\\cache',
      tempBase: 'C:\\ignored\\temp',
      portableRoot,
    }), {
      portableRoot: 'D:\\Player\\portable',
      profileRoot: 'D:\\Player\\portable\\profile',
      cacheRoot: 'D:\\Player\\portable\\cache',
      runtimeRoot: 'D:\\Player\\portable\\runtime',
      sessionDataRoot: 'D:\\Player\\portable\\runtime\\session-data',
      tempRoot: 'D:\\Player\\portable\\temp',
      backupsRoot: 'D:\\Player\\portable\\backups',
    })
  })

  it('initializes one immutable per-run temp root without creating the cache root', () => {
    const root = createFixture('storage-path-init')
    const profileRoot = path.join(root, 'profile')
    const applicationCacheRoot = path.join(root, 'application-cache')
    const tempBase = path.join(root, 'os-temp')
    const { initializeStoragePaths } = require(storagePathsModule)

    const paths = initializeStoragePaths({
      profileRoot,
      applicationCacheRoot,
      tempBase,
      portableRoot: null,
    })

    assert.equal(Object.isFrozen(paths), true)
    assert.equal(path.dirname(paths.runTempRoot), paths.tempRoot)
    assert.equal(fs.statSync(paths.runTempRoot).isDirectory(), true)
    assert.equal(fs.statSync(paths.profileRoot).isDirectory(), true)
    assert.equal(fs.existsSync(paths.cacheRoot), false)
    const originalCacheRoot = paths.cacheRoot
    paths.cacheRoot = path.join(root, 'replacement')
    assert.equal(paths.cacheRoot, originalCacheRoot)
  })

  it('rejects traversal and linked ancestors when asserting containment', t => {
    const root = createFixture('storage-path-containment')
    const child = path.join(root, 'child')
    const outside = createFixture('storage-path-outside')
    fs.mkdirSync(child)
    const { assertContainedPath } = require(storagePathsModule)

    assert.equal(assertContainedPath(root, path.join(child, 'file.tmp')), path.join(child, 'file.tmp'))
    assert.throws(() => assertContainedPath(root, path.join(root, '..', 'escaped.tmp')), /path_outside_root/)

    const linked = path.join(root, 'linked')
    try {
      fs.symlinkSync(outside, linked, process.platform == 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform == 'win32' && error.code == 'EPERM') {
        t.skip('Directory links require privileges on this Windows host')
        return
      }
      throw error
    }
    assert.throws(() => assertContainedPath(root, path.join(linked, 'file.tmp')), /path_link_not_allowed/)
  })
})

describe('early Electron bootstrap', () => {
  it('sets userData and sessionData before loading application modules', async() => {
    const root = createFixture('storage-bootstrap')
    const appData = path.join(root, 'roaming')
    const applicationCacheRoot = path.join(root, 'application-cache')
    const tempBase = path.join(root, 'temp')
    fs.mkdirSync(appData)
    fs.mkdirSync(applicationCacheRoot)
    fs.mkdirSync(tempBase)
    const calls = []
    const fakeElectron = {
      getPath(name) {
        calls.push(`getPath:${name}`)
        return {
          appData,
          sessionData: applicationCacheRoot,
          temp: tempBase,
          exe: path.join(root, 'app.exe'),
        }[name]
      },
      setPath(name, value) {
        calls.push(`setPath:${name}`)
        assert.equal(path.isAbsolute(value), true)
      },
      exit() { calls.push('exit') },
    }
    const importApplication = async() => { calls.push('import:application') }
    const { bootstrap } = require(bootstrapModule)

    await bootstrap(fakeElectron, importApplication)

    const relevantCalls = calls.filter(call => call.startsWith('setPath:') || call.startsWith('import:'))
    assert.deepEqual(relevantCalls.slice(0, 3), [
      'setPath:userData',
      'setPath:sessionData',
      'import:application',
    ])
    assert.equal(global.lxDataPath, global.storagePaths.profileRoot)
    assert.equal(global.lxOldDataPath, path.dirname(global.storagePaths.profileRoot))
    assert.equal(Object.isFrozen(global.storagePaths), true)
  })
})
