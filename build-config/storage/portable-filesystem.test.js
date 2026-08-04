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

const withoutLinkAndDirectoryFsync = fsApi => new Proxy(fsApi, {
  get(target, property, receiver) {
    if (property == 'link' || property == 'linkSync') return undefined
    if (property == 'fsyncSync') {
      return descriptor => {
        if (target.fstatSync(descriptor).isDirectory()) throw new Error('directory_fsync_unsupported')
        return target.fsyncSync(descriptor)
      }
    }
    return Reflect.get(target, property, receiver)
  },
})

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
  test('runs lock backup theme file-isolation and directory-isolation flows without link support', async() => {
    const fixture = createFixture()
    try {
      const { runSyntheticPortableFlows } = loadSmoke()
      const fsApi = withoutLinkAndDirectoryFsync(fs)
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
    const result = require('node:child_process').spawnSync(require('electron'), ['--test', __filename], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        LX_PORTABLE_FS_INTEGRATION_CHILD: '1',
      },
      windowsHide: true,
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
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
