const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
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
  it('resolves application-local cache parents for supported installed platforms', () => {
    const { resolveApplicationCacheRoot } = require(storagePathsModule)
    const appDirectory = PROJECT_IDENTITY.userDataDirName

    assert.equal(resolveApplicationCacheRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'D:\\LocalData' },
      homePath: 'C:\\Users\\Alice',
    }), `D:\\LocalData\\${appDirectory}`)
    assert.equal(resolveApplicationCacheRoot({
      platform: 'win32',
      env: { LOCALAPPDATA: 'relative-local-data' },
      homePath: 'C:\\Users\\Alice',
    }), `C:\\Users\\Alice\\AppData\\Local\\${appDirectory}`)
    assert.equal(resolveApplicationCacheRoot({
      platform: 'darwin',
      env: {},
      homePath: '/Users/alice',
    }), `/Users/alice/Library/Caches/${appDirectory}`)
    assert.equal(resolveApplicationCacheRoot({
      platform: 'linux',
      env: { XDG_CACHE_HOME: '/var/cache/alice' },
      homePath: '/home/alice',
    }), `/var/cache/alice/${appDirectory}`)
    assert.equal(resolveApplicationCacheRoot({
      platform: 'linux',
      env: { XDG_CACHE_HOME: 'relative-cache' },
      homePath: '/home/alice',
    }), `/home/alice/.cache/${appDirectory}`)
  })

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

  it('creates runtime and sessionData before publication while leaving cache and backups absent', async() => {
    const root = createFixture('storage-path-init')
    const profileRoot = path.join(root, 'profile')
    const applicationCacheRoot = path.join(root, 'application-cache')
    const tempBase = path.join(root, 'os-temp')
    const { initializeStoragePaths } = require(storagePathsModule)

    const initialized = await initializeStoragePaths({
      profileRoot,
      applicationCacheRoot,
      tempBase,
      portableRoot: null,
    })

    const { paths, runTempReservation } = initialized
    assert.equal(Object.isFrozen(paths), true)
    assert.equal(path.dirname(paths.runTempRoot), paths.tempRoot)
    assert.equal(fs.statSync(paths.runTempRoot).isDirectory(), true)
    assert.equal(fs.statSync(paths.profileRoot).isDirectory(), true)
    assert.equal(fs.statSync(paths.runtimeRoot).isDirectory(), true)
    assert.equal(fs.statSync(paths.sessionDataRoot).isDirectory(), true)
    assert.equal(fs.existsSync(paths.cacheRoot), false)
    assert.equal(fs.existsSync(paths.backupsRoot), false)
    assert.equal(fs.existsSync(path.join(paths.runTempRoot, '.owner.v1.json')), true)
    assert.equal(runTempReservation.runTempRoot, paths.runTempRoot)
    const originalCacheRoot = paths.cacheRoot
    paths.cacheRoot = path.join(root, 'replacement')
    assert.equal(paths.cacheRoot, originalCacheRoot)
  })

  it('rejects a required root replacement after reservation preparation', async() => {
    const root = createFixture('storage-path-publication-revalidation')
    const profileRoot = path.join(root, 'profile')
    const parkedProfile = path.join(root, 'parked-profile')
    const applicationCacheRoot = path.join(root, 'application-cache')
    const tempBase = path.join(root, 'os-temp')
    fs.mkdirSync(profileRoot)
    fs.mkdirSync(applicationCacheRoot)
    fs.mkdirSync(tempBase)
    const originalMkdir = fsp.mkdir
    let swapped = false
    fsp.mkdir = async(targetPath, options) => {
      const result = await originalMkdir(targetPath, options)
      if (!swapped && path.basename(String(targetPath)).startsWith('run-')) {
        swapped = true
        fs.renameSync(profileRoot, parkedProfile)
        fs.mkdirSync(profileRoot)
      }
      return result
    }
    const { initializeStoragePaths } = require(storagePathsModule)
    try {
      await assert.rejects(
        initializeStoragePaths({ profileRoot, applicationCacheRoot, tempBase, portableRoot: null }),
        /direct_directory_changed/,
      )
      assert.equal(swapped, true)
    } finally {
      fsp.mkdir = originalMkdir
    }
  })

  it('rejects a parent identity swap during direct-child creation', () => {
    const root = createFixture('direct-directory-parent-swap')
    const parentPath = path.join(root, 'parent')
    const replacementPath = path.join(root, 'replacement')
    fs.mkdirSync(parentPath)
    const { validateDirectDirectory, createDirectChildDirectory, closeDirectDirectory } = require('../../src/main/storage/directDirectory.js')
    const parent = validateDirectDirectory(parentPath)
    fs.renameSync(parentPath, replacementPath)
    fs.mkdirSync(parentPath)
    try {
      assert.throws(
        () => createDirectChildDirectory(parent, 'child', { mode: 0o700 }),
        error => error.code == 'direct_directory_changed',
      )
    } finally {
      closeDirectDirectory(parent)
    }
  })

  it('rejects existing linked cache and backups roots before publication', async(t) => {
    const root = createFixture('storage-optional-linked-roots')
    const outside = createFixture('storage-optional-linked-outside')
    const profileRoot = path.join(root, 'profile')
    const applicationCacheRoot = path.join(root, 'application-cache')
    const tempBase = path.join(root, 'temp-base')
    fs.mkdirSync(profileRoot, { recursive: true })
    fs.mkdirSync(applicationCacheRoot)
    fs.mkdirSync(tempBase)
    const { initializeStoragePaths, resolveStoragePaths } = require(storagePathsModule)
    const resolved = resolveStoragePaths({ profileRoot, applicationCacheRoot, tempBase, portableRoot: null })
    for (const targetPath of [resolved.cacheRoot, resolved.backupsRoot]) {
      try {
        fs.symlinkSync(outside, targetPath, process.platform == 'win32' ? 'junction' : 'dir')
      } catch (error) {
        if (process.platform == 'win32' && error.code == 'EPERM') return t.skip('Directory links require privileges on this Windows host')
        throw error
      }
    }
    await assert.rejects(initializeStoragePaths({ profileRoot, applicationCacheRoot, tempBase, portableRoot: null }), /direct_directory_invalid/)
  })

  it('rejects a Windows reparse directory even when it reports as a directory', () => {
    const root = createFixture('storage-reparse-adapter')
    const { validateDirectDirectory } = require('../../src/main/storage/directDirectory.js')
    const realpathSync = targetPath => path.resolve(targetPath) == path.resolve(root)
      ? path.join(root, 'reparse-target')
      : fs.realpathSync(targetPath)
    realpathSync.native = realpathSync
    const fsApi = { ...fs, realpathSync }

    assert.throws(() => validateDirectDirectory(root, { fsApi }), /direct_directory_invalid/)
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

  it('accepts Windows root casing variations for the same contained path', t => {
    if (process.platform != 'win32') return t.skip('Windows paths are case-insensitive')
    const root = createFixture('storage-path-case')
    const child = path.join(root, 'child')
    fs.mkdirSync(child)
    const differentlyCasedRoot = `${root[0] == root[0].toUpperCase() ? root[0].toLowerCase() : root[0].toUpperCase()}${root.slice(1)}`
    const { assertContainedPath } = require(storagePathsModule)

    assert.equal(assertContainedPath(differentlyCasedRoot, path.join(child, 'file.tmp')), path.join(child, 'file.tmp'))
  })
})

describe('early Electron bootstrap', () => {
  it('creates launcher-local storage on a true portable first launch without consulting AppData', async() => {
    const root = createFixture('portable-wrapper-first-launch')
    const launcherRoot = path.join(root, 'launcher')
    const extractedRoot = path.join(root, 'nsis-temp')
    fs.mkdirSync(launcherRoot)
    fs.mkdirSync(extractedRoot)
    const calls = []
    const fakeElectron = {
      getPath(name) {
        calls.push(`getPath:${name}`)
        if (name == 'exe') return path.join(extractedRoot, 'app.exe')
        if (name == 'temp') return path.join(root, 'os-temp')
        throw new Error(`installed path consulted: ${name}`)
      },
      setPath(name, value) { calls.push(`setPath:${name}:${value}`) },
      exit(code) { calls.push(`exit:${code}`) },
    }
    const { bootstrap } = require(bootstrapModule)

    await bootstrap(fakeElectron, async() => { calls.push('application') }, {
      platform: 'win32',
      env: { PORTABLE_EXECUTABLE_DIR: launcherRoot },
    })

    const portableRoot = path.join(launcherRoot, 'portable')
    assert.equal(global.storagePaths.portableRoot, portableRoot)
    assert.equal(global.storagePaths.profileRoot, path.join(portableRoot, 'profile'))
    assert.equal(fs.statSync(global.storagePaths.sessionDataRoot).isDirectory(), true)
    assert.equal(fs.existsSync(global.storagePaths.cacheRoot), false)
    assert.equal(fs.existsSync(global.storagePaths.backupsRoot), false)
    assert.equal(calls.some(call => call == 'getPath:appData' || call == 'getPath:home'), false)
    assert.equal(calls.at(-1), 'application')
  })

  it('exits before installed startup for invalid portable launcher values', async() => {
    for (const portableExecutableDir of ['', 'relative-launcher']) {
      const calls = []
      const fakeElectron = {
        getPath(name) {
          calls.push(`getPath:${name}`)
          if (name == 'exe') return 'D:\\portable-wrapper\\app.exe'
          throw new Error(`installed path consulted: ${name}`)
        },
        setPath(name) { calls.push(`setPath:${name}`) },
        exit(code) { calls.push(`exit:${code}`) },
      }
      const { bootstrap } = require(bootstrapModule)

      const originalConsoleError = console.error
      try {
        console.error = () => {}
        await bootstrap(fakeElectron, async() => { calls.push('application') }, {
          platform: 'win32',
          env: { PORTABLE_EXECUTABLE_DIR: portableExecutableDir },
        })
      } finally {
        console.error = originalConsoleError
      }

      assert.deepEqual(calls, ['getPath:exe', 'exit:1'])
    }
  })

  it('rejects profile, temp, and portable junction roots before any app.setPath call', async(t) => {
    for (const linkedRoot of ['profile', 'temp', 'portable']) {
      await t.test(linkedRoot, async() => {
        const root = createFixture(`storage-portable-linked-${linkedRoot}`)
        const portableRoot = path.join(root, 'portable')
        const outside = createFixture(`storage-portable-linked-${linkedRoot}-outside`)
        const calls = []
        if (linkedRoot == 'portable') {
          fs.symlinkSync(outside, portableRoot, process.platform == 'win32' ? 'junction' : 'dir')
        } else {
          fs.mkdirSync(portableRoot)
          fs.symlinkSync(outside, path.join(portableRoot, linkedRoot), process.platform == 'win32' ? 'junction' : 'dir')
        }
        const fakeElectron = {
          getPath(name) { return { exe: path.join(root, 'app.exe'), temp: path.join(root, 'temp') }[name] },
          setPath(name) { calls.push(name) },
          exit(code) { calls.push(`exit:${code}`) },
        }
        const { bootstrap } = require(bootstrapModule)

        await bootstrap(fakeElectron, async() => { calls.push('application') }, { platform: 'win32', env: {} })

        assert.deepEqual(calls, ['exit:1'])
      })
    }
  })

  it('rejects existing linked portable profile when no legacy source exists', async(t) => {
    const root = createFixture('storage-portable-linked-profile')
    const portableRoot = path.join(root, 'portable')
    const outside = createFixture('storage-portable-linked-outside')
    const calls = []
    fs.mkdirSync(portableRoot)
    try {
      fs.symlinkSync(outside, path.join(portableRoot, 'profile'), process.platform == 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (process.platform == 'win32' && error.code == 'EPERM') return t.skip('Directory links require privileges on this Windows host')
      throw error
    }
    const fakeElectron = {
      getPath(name) {
        return { exe: path.join(root, 'app.exe'), temp: path.join(root, 'temp') }[name]
      },
      setPath(name) { calls.push(name) },
      exit(code) { calls.push(`exit:${code}`) },
    }
    const { bootstrap } = require(bootstrapModule)

    await bootstrap(fakeElectron, async() => { calls.push('application') }, { platform: 'win32', env: {} })

    assert.deepEqual(calls, ['exit:1'])
  })

  it('sets userData and sessionData before loading application modules', async() => {
    const root = createFixture('storage-bootstrap')
    const appData = path.join(root, 'roaming')
    const sessionDataTrap = path.join(appData, 'stale-session-data')
    const cacheBase = path.join(root, 'local-cache')
    const applicationCacheRoot = path.join(cacheBase, PROJECT_IDENTITY.userDataDirName)
    const homePath = path.join(root, 'home')
    const tempBase = path.join(root, 'temp')
    fs.mkdirSync(appData)
    fs.mkdirSync(cacheBase)
    fs.mkdirSync(tempBase)
    const calls = []
    const fakeElectron = {
      getPath(name) {
        calls.push(`getPath:${name}`)
        if (name == 'cache') throw new Error('unsupported cache path name')
        return {
          appData,
          home: homePath,
          sessionData: sessionDataTrap,
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

    await bootstrap(fakeElectron, importApplication, {
      platform: 'win32',
      env: { LOCALAPPDATA: cacheBase },
    })

    const relevantCalls = calls.filter(call => call.startsWith('setPath:') || call.startsWith('import:'))
    assert.deepEqual(relevantCalls.slice(0, 3), [
      'setPath:userData',
      'setPath:sessionData',
      'import:application',
    ])
    assert.equal(global.lxDataPath, global.storagePaths.profileRoot)
    assert.equal(global.lxOldDataPath, path.dirname(global.storagePaths.profileRoot))
    assert.equal(Object.isFrozen(global.storagePaths), true)
    assert.equal(calls.includes('getPath:home'), true)
    assert.equal(calls.includes('getPath:cache'), false)
    assert.equal(calls.includes('getPath:sessionData'), false)
    assert.equal(global.storagePaths.cacheRoot, path.join(applicationCacheRoot, 'cache'))
    assert.equal(global.storagePaths.runtimeRoot, path.join(applicationCacheRoot, 'runtime'))
    assert.equal(global.storagePaths.sessionDataRoot, path.join(applicationCacheRoot, 'runtime', 'session-data'))
    assert.equal(fs.existsSync(global.storagePaths.cacheRoot), false)
  })
})
