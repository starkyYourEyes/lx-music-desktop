const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')

const testRoot = process.env.LX_TEST_STORAGE_ROOT
if (testRoot == null) throw new Error('LX_TEST_STORAGE_ROOT is required')
const supportsDatabase = typeof process.versions.electron == 'string'
const integrationChild = process.env.LX_PORTABLE_FS_INTEGRATION_CHILD == '1'

const loadSmoke = () => require('./portable-filesystem-smoke.js')

const withoutLinkAndDirectoryFsync = fsApi => {
  const unsupported = () => Object.assign(new Error('portable_operation_unsupported'), {
    code: 'portable_operation_unsupported',
  })
  const promises = new Proxy(fsApi.promises, {
    get(target, property, receiver) {
      if (property == 'link') return async() => { throw unsupported() }
      if (property == 'open') {
        return async(...args) => {
          const handle = await Reflect.apply(target.open, target, args)
          return new Proxy(handle, {
            get(fileHandle, handleProperty) {
              if (handleProperty == 'sync') {
                return async() => {
                  if ((await fileHandle.stat()).isDirectory()) throw unsupported()
                  return await fileHandle.sync()
                }
              }
              const value = Reflect.get(fileHandle, handleProperty, fileHandle)
              return typeof value == 'function' ? value.bind(fileHandle) : value
            },
          })
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
  return new Proxy(fsApi, {
    get(target, property, receiver) {
      if (property == 'linkSync') return () => { throw unsupported() }
      if (property == 'link') return (...args) => process.nextTick(args.at(-1), unsupported())
      if (property == 'promises') return promises
      if (property == 'fsyncSync') {
        return descriptor => {
          if (target.fstatSync(descriptor).isDirectory()) throw unsupported()
          return target.fsyncSync(descriptor)
        }
      }
      if (property == 'fsync') {
        return (descriptor, callback) => {
          target.fstat(descriptor, (error, stat) => {
            if (error != null) return callback(error)
            if (stat.isDirectory()) return callback(unsupported())
            target.fsync(descriptor, callback)
          })
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
}

const trackFilesystemPaths = (fsApi, observedPaths) => {
  const track = args => {
    if (typeof args[0] == 'string') observedPaths.add(path.resolve(args[0]))
  }
  const trackMethods = target => new Proxy(target, {
    get(innerTarget, property, receiver) {
      const value = Reflect.get(innerTarget, property, receiver)
      if (typeof value != 'function') return value
      return (...args) => {
        track(args)
        return Reflect.apply(value, innerTarget, args)
      }
    },
  })
  const promises = trackMethods(fsApi.promises)
  return new Proxy(fsApi, {
    get(target, property, receiver) {
      if (property == 'promises') return promises
      const value = Reflect.get(target, property, receiver)
      if (typeof value != 'function') return value
      return (...args) => {
        track(args)
        return Reflect.apply(value, target, args)
      }
    },
  })
}

const createFixture = () => {
  const fixture = createTestStorageRoot('portable-filesystem')
  const runRoot = path.join(fixture.path, 'synthetic-run')
  const disposableRoot = path.join(fixture.path, 'lx-portable-fs-smoke-unit')
  const repositoryRoot = path.join(fixture.path, 'repository')
  fs.mkdirSync(runRoot)
  fs.mkdirSync(disposableRoot)
  fs.mkdirSync(repositoryRoot)
  return { ...fixture, runRoot, disposableRoot, repositoryRoot }
}

if (supportsDatabase) {
  test('rejects every hard-link and directory-fsync surface in the portable adapter', async() => {
    const fixture = createFixture()
    const fsApi = withoutLinkAndDirectoryFsync(fs)
    const sourcePath = path.join(fixture.path, 'adapter-source')
    const targetPath = path.join(fixture.path, 'adapter-target')
    let descriptor
    let handle
    try {
      fs.writeFileSync(sourcePath, 'source')
      assert.throws(() => fsApi.linkSync(sourcePath, targetPath), /portable_operation_unsupported/)
      await assert.rejects(new Promise((resolve, reject) => {
        fsApi.link(sourcePath, targetPath, error => error == null ? resolve() : reject(error))
      }), /portable_operation_unsupported/)
      await assert.rejects(fsApi.promises.link(sourcePath, targetPath), /portable_operation_unsupported/)

      descriptor = fs.openSync(fixture.runRoot, 'r')
      await assert.rejects(new Promise((resolve, reject) => {
        fsApi.fsync(descriptor, error => error == null ? resolve() : reject(error))
      }), /portable_operation_unsupported/)
      handle = await fsApi.promises.open(fixture.runRoot, 'r')
      await assert.rejects(handle.sync(), /portable_operation_unsupported/)
    } finally {
      if (handle != null) await handle.close()
      if (descriptor != null) fs.closeSync(descriptor)
      fixture.cleanup()
    }
  })

  test('runs lock backup theme file-isolation and directory-isolation flows without link support', async() => {
    const fixture = createFixture()
    try {
      const { runSyntheticPortableFlows } = loadSmoke()
      const observedPaths = new Set()
      const fsApi = withoutLinkAndDirectoryFsync(trackFilesystemPaths(fs, observedPaths))
      const report = await runSyntheticPortableFlows({
        root: fixture.runRoot,
        expectedFs: 'ntfs',
        probeFilesystem: async() => 'ntfs',
        fsApi,
      })
      assert.deepEqual(report.flows, {
        directoryIsolation: 'passed',
        fileIsolation: 'passed',
        lock: 'passed',
        themePublication: 'passed',
        uniqueBackup: 'passed',
      })
      for (const expectedPath of [
        'lease-root',
        'portable-backup-artifacts',
        'theme-profile',
        'portable-file-isolation',
        'portable-directory-isolation',
      ]) {
        assert.equal([...observedPaths].some(candidate => candidate.includes(expectedPath)), true, expectedPath)
      }
    } finally {
      fixture.cleanup()
    }
  })

  test('runs the guarded smoke in one unpredictable child and removes it only after every flow passes', async() => {
    const fixture = createFixture()
    try {
      const { runSmoke } = loadSmoke()
      const report = await runSmoke({
        root: fixture.disposableRoot,
        expectedFs: 'exfat',
        platform: 'win32',
        repositoryRoot: fixture.repositoryRoot,
        probeFilesystem: async() => 'exfat',
      })
      assert.deepEqual(report, {
        filesystem: 'exfat',
        flows: {
          directoryIsolation: 'passed',
          fileIsolation: 'passed',
          lock: 'passed',
          themePublication: 'passed',
          uniqueBackup: 'passed',
        },
      })
      assert.deepEqual(fs.readdirSync(fixture.disposableRoot), [])
    } finally {
      fixture.cleanup()
    }
  })
} else {
  test('runs SQLite portable integrations under the installed Electron ABI', () => {
    const environment = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      LX_PORTABLE_FS_INTEGRATION_CHILD: '1',
    }
    delete environment.NODE_TEST_CONTEXT
    const result = require('node:child_process').spawnSync(require('electron'), ['--test', __filename], {
      encoding: 'utf8',
      env: environment,
      windowsHide: true,
    })
    const tap = `${result.stdout}${result.stderr}`
    assert.equal(result.status, 0, tap)
    assert.match(tap, /# fail 0(?:\r?\n|$)/, tap)
    assert.doesNotMatch(tap, /(?:^|\r?\n)not ok /, tap)
  })
}

if (!integrationChild) {
  test('refuses real storage roots and filesystem-type mismatches', async() => {
    const fixture = createFixture()
    try {
      const { runSmoke } = loadSmoke()
      const profileRoot = path.join(fixture.path, 'profile', 'lx-portable-fs-smoke-profile')
      fs.mkdirSync(profileRoot, { recursive: true })
      await assert.rejects(runSmoke({
        root: profileRoot,
        expectedFs: 'ntfs',
        platform: 'win32',
        repositoryRoot: fixture.repositoryRoot,
        probeFilesystem: async() => 'ntfs',
      }), /smoke_root_refused/)
      await assert.rejects(runSmoke({
        root: fixture.disposableRoot,
        expectedFs: 'fat32',
        platform: 'win32',
        repositoryRoot: fixture.repositoryRoot,
        probeFilesystem: async() => 'ntfs',
      }), /smoke_filesystem_mismatch/)
    } finally {
      fixture.cleanup()
    }
  })
}

if (!integrationChild) {
  test('requires a supported platform and a named empty disposable root outside the repository', async() => {
    const fixture = createFixture()
    try {
      const { runSmoke } = loadSmoke()
      const options = {
        expectedFs: 'ntfs',
        platform: 'win32',
        repositoryRoot: fixture.repositoryRoot,
        probeFilesystem: async() => 'ntfs',
      }
      const relativeRoot = path.relative(process.cwd(), fixture.disposableRoot)
      const wrongName = path.join(fixture.path, 'portable-smoke')
      const nonEmpty = path.join(fixture.path, 'lx-portable-fs-smoke-nonempty')
      const repositoryChild = path.join(fixture.repositoryRoot, 'lx-portable-fs-smoke-repository')
      fs.mkdirSync(wrongName)
      fs.mkdirSync(nonEmpty)
      fs.writeFileSync(path.join(nonEmpty, 'keep'), 'retained')
      fs.mkdirSync(repositoryChild)

      await assert.rejects(runSmoke({ ...options, root: relativeRoot }), /smoke_root_refused/)
      await assert.rejects(runSmoke({ ...options, root: path.join(fixture.path, 'lx-portable-fs-smoke-missing') }), /smoke_root_refused/)
      await assert.rejects(runSmoke({ ...options, root: wrongName }), /smoke_root_refused/)
      await assert.rejects(runSmoke({ ...options, root: nonEmpty }), /smoke_root_refused/)
      await assert.rejects(runSmoke({ ...options, root: repositoryChild }), /smoke_root_refused/)
      await assert.rejects(runSmoke({ ...options, root: fixture.disposableRoot, platform: 'linux' }), /smoke_platform_unsupported/)
    } finally {
      fixture.cleanup()
    }
  })
}
