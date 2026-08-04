const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const loadTsModule = require('../../scripts/test-utils/load-ts-module.js')
const {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
} = require('../../src/main/storage/directDirectory.js')
const {
  isolateOwnedPath,
  reclaimIsolatedPayload,
} = require('../../src/main/storage/exclusiveIsolation.js')
const {
  acquireMigrationLease,
  releaseMigrationLease,
} = require('../../src/main/migration/migrationLease.js')

const EXPECTED_FILESYSTEMS = new Set(['ntfs', 'fat32', 'exfat'])
const DISPOSABLE_ROOT_NAME = /^lx-portable-fs-smoke-[a-z0-9_-]+$/
const RUN_ROOT_NAME = /^lx-portable-smoke-run-[a-f0-9]{32}$/
const FORBIDDEN_STORAGE_BASENAMES = new Set(['lxdatas', 'profile', 'cache', 'portable', 'backups'])
const projectRoot = path.resolve(__dirname, '../..')
const directDirectoryPath = require.resolve('../../src/main/storage/directDirectory.js')
const exclusiveArtifactPath = require.resolve('../../src/main/storage/exclusiveArtifact.js')
const exclusiveIsolationPath = require.resolve('../../src/main/storage/exclusiveIsolation.js')
const databaseBackupPath = path.resolve(__dirname, '../../src/main/worker/dbService/databaseBackup.ts')
const storagePathsPath = path.resolve(__dirname, '../../src/main/utils/storagePaths.ts')
const tempLifecyclePath = path.resolve(__dirname, '../../src/main/utils/tempLifecycle.ts')
const themeManagerPath = path.resolve(__dirname, '../../src/main/services/themeAssetManager.ts')
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex')

const smokeError = (code, cause) => Object.assign(new Error(code), {
  code,
  ...(cause == null ? {} : { cause }),
})
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const pathKey = (value, platform = process.platform) => {
  const normalized = path.normalize(path.resolve(value))
  return platform == 'win32' ? normalized.toLowerCase() : normalized
}
const isContained = (root, candidate, platform = process.platform) => {
  const relative = path.relative(pathKey(root, platform), pathKey(candidate, platform))
  return relative == '' || (relative != '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

const verifyDirectFile = (filePath, expectedIdentity, expectedBytes) => {
  const stat = fs.lstatSync(filePath, { bigint: true })
  assert.equal(stat.isSymbolicLink(), false)
  assert.equal(stat.isFile(), true)
  assert.equal(stat.nlink, 1n)
  assert.deepEqual(identityOf(stat), expectedIdentity)
  assert.deepEqual(fs.readFileSync(filePath), expectedBytes)
}

const runLeaseFlow = async runRoot => {
  const leaseRoot = path.join(runRoot, 'lease-root')
  fs.mkdirSync(leaseRoot)
  const rootIdentity = identityOf(fs.lstatSync(leaseRoot, { bigint: true }))
  const lockPath = path.join(leaseRoot, '.portable-profile-migration.lock')
  let lease
  try {
    lease = await acquireMigrationLease({
      rootPath: leaseRoot,
      lockPath,
      logger: { info() {}, warn() {}, error() {} },
    })
    lease.assertHeld()
    assert.deepEqual(lease.rootIdentity, rootIdentity)
    const lockStat = fs.lstatSync(lockPath, { bigint: true })
    assert.equal(lockStat.isSymbolicLink(), false)
    assert.equal(lockStat.isDirectory(), true)
    assert.deepEqual(fs.readdirSync(lockPath), [])
    assert.deepEqual(identityOf(lockStat), lease.lockIdentity)
  } finally {
    if (lease != null) await releaseMigrationLease(lease)
  }
  assert.deepEqual(identityOf(fs.lstatSync(leaseRoot, { bigint: true })), rootIdentity)
  assert.equal(fs.existsSync(lockPath), false)
  return 'passed'
}

const runProductionBackupFlow = (runRoot, fsApi) => {
  const Database = require('better-sqlite3')
  const sourcePath = path.join(runRoot, 'portable-source.db')
  const backupsRoot = path.join(runRoot, 'portable-backup-artifacts')
  const sourceSchemaVersion = 6
  const knownId = 'portable-known-row'
  const knownValue = 'verified portable backup bytes'

  // The nested loader hook can inject the adapter only when these CommonJS dependencies are reloaded.
  delete require.cache[exclusiveArtifactPath]
  delete require.cache[directDirectoryPath]
  const backupModule = loadTsModule(databaseBackupPath, { 'node:fs': fsApi })

  const source = new Database(path.toNamespacedPath(sourcePath))
  let guard
  try {
    source.exec(`
      CREATE TABLE db_info (
        field_name TEXT PRIMARY KEY NOT NULL,
        field_value TEXT NOT NULL
      );
      CREATE TABLE portable_evidence (
        id TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      INSERT INTO db_info(field_name, field_value) VALUES ('version', '${sourceSchemaVersion}');
      INSERT INTO portable_evidence(id, value) VALUES ('${knownId}', '${knownValue}');
    `)
    source.pragma('foreign_keys = ON')
    const reservation = backupModule.reserveOnlineBackup({
      backupsRoot,
      basenamePrefix: 'lx.data.db.portable',
      sourceSchemaVersion,
    })
    guard = backupModule.completeOnlineBackup(source, reservation, {}, verificationDb => {
      assert.equal(verificationDb.pragma('quick_check', { simple: true }), 'ok')
      assert.deepEqual(verificationDb.pragma('foreign_key_check'), [])
      assert.equal(verificationDb.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").pluck().get(), String(sourceSchemaVersion))
      assert.deepEqual(verificationDb.prepare('SELECT id, value FROM portable_evidence').get(), {
        id: knownId,
        value: knownValue,
      })
    })
    assert.equal(guard.sourceSchemaVersion, sourceSchemaVersion)
    assert.match(guard.basename, /^lx\.data\.db\.portable\.[a-f0-9]{32}\.backup$/)
    assert.equal(path.resolve(guard.path), path.join(backupsRoot, guard.basename))
    const artifactBytes = fsApi.readFileSync(guard.path)
    assert.equal(guard.byteLength, artifactBytes.length)
    assert.equal(guard.sha256, sha256(artifactBytes))
    const artifactStat = fsApi.lstatSync(guard.path, { bigint: true })
    assert.equal(artifactStat.isSymbolicLink(), false)
    assert.equal(artifactStat.isFile(), true)
    assert.equal(artifactStat.nlink, 1n)
    guard.revalidate()

    const restored = new Database(path.toNamespacedPath(guard.path), { readonly: true, fileMustExist: true })
    try {
      assert.equal(restored.pragma('quick_check', { simple: true }), 'ok')
      assert.deepEqual(restored.pragma('foreign_key_check'), [])
      assert.equal(restored.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").pluck().get(), String(sourceSchemaVersion))
      assert.deepEqual(restored.prepare('SELECT id, value FROM portable_evidence').get(), {
        id: knownId,
        value: knownValue,
      })
    } finally {
      restored.close()
    }
    guard.revalidate()
    return 'passed'
  } finally {
    try { guard?.close() } finally { source.close() }
  }
}

const loadThemeProductionModules = () => {
  delete require.cache[exclusiveIsolationPath]
  delete require.cache[exclusiveArtifactPath]
  delete require.cache[directDirectoryPath]
  const storagePaths = loadTsModule(storagePathsPath)
  return {
    lifecycle: loadTsModule(tempLifecyclePath, {
      '@main/utils/storagePaths': storagePaths,
    }),
    theme: loadTsModule(themeManagerPath, {
      '@main/utils/storagePaths': storagePaths,
    }),
  }
}

const runSyntheticThemeFlow = async runRoot => {
  const profileRoot = path.join(runRoot, 'theme-profile')
  const tempRoot = path.join(runRoot, 'theme-temp')
  const sourcePath = path.join(runRoot, 'theme-source.png')
  fs.mkdirSync(profileRoot)
  fs.mkdirSync(tempRoot)
  fs.writeFileSync(sourcePath, pngBytes, { flag: 'wx' })
  const { lifecycle, theme } = loadThemeProductionModules()
  const reservation = await lifecycle.prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
  const runTemp = await lifecycle.createRunTempHandle({ reservation })
  try {
    const manager = theme.createThemeAssetManager({ profileRoot, runTemp })
    const staged = await manager.stageThemeImage({ sourcePath })
    const promoted = await manager.promoteThemeImage(staged, async publication => {
      const stat = fs.lstatSync(publication.previewPath, { bigint: true })
      verifyDirectFile(publication.previewPath, identityOf(stat), pngBytes)
      return { ...publication, identity: identityOf(stat) }
    })
    const finalPath = path.join(profileRoot, 'assets', 'theme-images', promoted.fileName)
    assert.equal(path.resolve(promoted.previewPath), finalPath)
    verifyDirectFile(finalPath, promoted.identity, pngBytes)
    return 'passed'
  } finally {
    await runTemp.cleanup()
  }
}

const runFileIsolationFlow = async runRoot => {
  const root = validateDirectDirectory(runRoot)
  try {
    const basename = 'portable-file-isolation'
    const sourcePath = path.join(root.path, basename)
    const expectedBytes = Buffer.from('portable file isolation bytes')
    fs.writeFileSync(sourcePath, expectedBytes, { flag: 'wx' })
    const identity = identityOf(fs.lstatSync(sourcePath, { bigint: true }))
    const result = await isolateOwnedPath({
      source: { root, path: sourcePath, basename, identity, kind: 'file' },
      prefix: '.portable-file-isolation-',
      verifySource: async payloadPath => verifyDirectFile(payloadPath, identity, expectedBytes),
    })
    assert.equal(result.state, 'isolated')
    verifyDirectFile(result.guard.payloadPath, identity, expectedBytes)
    const reclaimed = await reclaimIsolatedPayload({
      guard: result.guard,
      verifyPayload: async payloadPath => verifyDirectFile(payloadPath, identity, expectedBytes),
    })
    assert.equal(reclaimed.state, 'reclaimed')
    assert.equal(fs.existsSync(sourcePath), false)
    assert.equal(fs.existsSync(result.guard.isolationPath), false)
    revalidateDirectDirectory(root)
    return 'passed'
  } finally {
    closeDirectDirectory(root)
  }
}

const runDirectoryIsolationFlow = async runRoot => {
  const root = validateDirectDirectory(runRoot)
  try {
    const basename = 'portable-directory-isolation'
    const sourcePath = path.join(root.path, basename)
    const markerBytes = Buffer.from('portable directory isolation bytes')
    fs.mkdirSync(sourcePath)
    fs.writeFileSync(path.join(sourcePath, 'marker'), markerBytes, { flag: 'wx' })
    const identity = identityOf(fs.lstatSync(sourcePath, { bigint: true }))
    const verifyDirectory = async payloadPath => {
      const stat = fs.lstatSync(payloadPath, { bigint: true })
      assert.equal(stat.isSymbolicLink(), false)
      assert.equal(stat.isDirectory(), true)
      assert.deepEqual(identityOf(stat), identity)
      assert.deepEqual(fs.readdirSync(payloadPath), ['marker'])
      assert.deepEqual(fs.readFileSync(path.join(payloadPath, 'marker')), markerBytes)
    }
    const result = await isolateOwnedPath({
      source: { root, path: sourcePath, basename, identity, kind: 'directory' },
      prefix: '.portable-directory-isolation-',
      verifySource: verifyDirectory,
    })
    assert.equal(result.state, 'isolated')
    await verifyDirectory(result.guard.payloadPath)
    const reclaimed = await reclaimIsolatedPayload({ guard: result.guard, verifyPayload: verifyDirectory })
    assert.equal(reclaimed.state, 'reclaimed')
    assert.equal(fs.existsSync(sourcePath), false)
    assert.equal(fs.existsSync(result.guard.isolationPath), false)
    revalidateDirectDirectory(root)
    return 'passed'
  } finally {
    closeDirectDirectory(root)
  }
}

const normalizeFilesystem = value => String(value).trim().toLowerCase()

const runSyntheticPortableFlows = async({ root, expectedFs, probeFilesystem, fsApi }) => {
  if (!EXPECTED_FILESYSTEMS.has(expectedFs) || typeof probeFilesystem != 'function' || fsApi == null) {
    throw smokeError('smoke_arguments_invalid')
  }
  const actualFilesystem = normalizeFilesystem(await probeFilesystem(root))
  if (actualFilesystem != expectedFs) throw smokeError('smoke_filesystem_mismatch')
  return {
    filesystem: actualFilesystem,
    flows: {
      lock: await runLeaseFlow(root),
      uniqueBackup: runProductionBackupFlow(root, fsApi),
      themePublication: await runSyntheticThemeFlow(root),
      fileIsolation: await runFileIsolationFlow(root),
      directoryIsolation: await runDirectoryIsolationFlow(root),
    },
  }
}

const validateSmokeRoot = ({ root, repositoryRoot, platform }) => {
  if (typeof root != 'string' || !path.isAbsolute(root)) throw smokeError('smoke_root_refused')
  const resolved = path.resolve(root)
  if (!DISPOSABLE_ROOT_NAME.test(path.basename(resolved)) ||
    isContained(path.resolve(repositoryRoot), resolved, platform)) throw smokeError('smoke_root_refused')
  for (let current = resolved; ; current = path.dirname(current)) {
    if (FORBIDDEN_STORAGE_BASENAMES.has(path.basename(current).toLowerCase())) throw smokeError('smoke_root_refused')
    if (path.dirname(current) == current) break
  }

  let guard
  try {
    const stat = fs.lstatSync(resolved, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory() ||
      pathKey(fs.realpathSync.native?.(resolved) ?? fs.realpathSync(resolved), platform) != pathKey(resolved, platform) ||
      fs.readdirSync(resolved).length != 0) throw smokeError('smoke_root_refused')
    guard = validateDirectDirectory(resolved)
    revalidateDirectDirectory(guard)
    return resolved
  } catch (error) {
    if (error?.code == 'smoke_root_refused') throw error
    throw smokeError('smoke_root_refused', error)
  } finally {
    if (guard != null) {
      try { closeDirectDirectory(guard) } catch {}
    }
  }
}

const probeWindowsFilesystem = root => {
  try {
    return normalizeFilesystem(childProcess.execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$ErrorActionPreference = 'Stop'; (Get-Volume -FilePath $env:LX_PORTABLE_SMOKE_PROBE_ROOT).FileSystem",
    ], {
      encoding: 'utf8',
      env: { ...process.env, LX_PORTABLE_SMOKE_PROBE_ROOT: root },
      windowsHide: true,
    }))
  } catch (error) {
    throw smokeError('smoke_filesystem_probe_failed', error)
  }
}

const createRunChild = root => {
  const rootGuard = validateDirectDirectory(root)
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      revalidateDirectDirectory(rootGuard)
      const basename = `lx-portable-smoke-run-${crypto.randomBytes(16).toString('hex')}`
      assert.match(basename, RUN_ROOT_NAME)
      const runRoot = path.join(rootGuard.path, basename)
      try {
        fs.mkdirSync(runRoot, { mode: 0o700 })
      } catch (error) {
        revalidateDirectDirectory(rootGuard)
        if (error?.code == 'EEXIST') continue
        throw error
      }
      revalidateDirectDirectory(rootGuard)
      const runGuard = validateDirectDirectory(runRoot)
      revalidateDirectDirectory(runGuard)
      return { rootGuard, runGuard, runRoot }
    }
    throw smokeError('smoke_run_collision')
  } catch (error) {
    closeDirectDirectory(rootGuard)
    throw error
  }
}

const runSmoke = async({
  root,
  expectedFs,
  platform = process.platform,
  repositoryRoot = projectRoot,
  probeFilesystem = probeWindowsFilesystem,
} = {}) => {
  if (!EXPECTED_FILESYSTEMS.has(expectedFs)) throw smokeError('smoke_arguments_invalid')
  if (platform != 'win32') throw smokeError('smoke_platform_unsupported')
  const disposableRoot = validateSmokeRoot({ root, repositoryRoot, platform })
  const actualFilesystem = normalizeFilesystem(await probeFilesystem(disposableRoot))
  if (actualFilesystem != expectedFs) throw smokeError('smoke_filesystem_mismatch')

  const owned = createRunChild(disposableRoot)
  let passed = false
  try {
    const report = await runSyntheticPortableFlows({
      root: owned.runRoot,
      expectedFs,
      probeFilesystem: async() => actualFilesystem,
      fsApi: fs,
    })
    assert.deepEqual(new Set(Object.values(report.flows)), new Set(['passed']))
    revalidateDirectDirectory(owned.rootGuard)
    revalidateDirectDirectory(owned.runGuard)
    passed = true
    closeDirectDirectory(owned.runGuard)
    fs.rmSync(owned.runRoot, { recursive: true, force: false })
    revalidateDirectDirectory(owned.rootGuard)
    if (fs.existsSync(owned.runRoot)) throw smokeError('smoke_cleanup_failed')
    return report
  } finally {
    if (!passed) {
      try { closeDirectDirectory(owned.runGuard) } catch {}
    }
    try { closeDirectDirectory(owned.rootGuard) } catch {}
  }
}

const parseArguments = argv => {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = argv[index + 1]
    if ((option != '--root' && option != '--expected-fs') || value == null || values.has(option)) {
      throw smokeError('smoke_arguments_invalid')
    }
    values.set(option, value)
  }
  if (values.size != 2 || argv.length != 4) throw smokeError('smoke_arguments_invalid')
  return { root: values.get('--root'), expectedFs: values.get('--expected-fs') }
}

const canonicalize = value => Array.isArray(value)
  ? value.map(canonicalize)
  : value != null && typeof value == 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
    : value
const canonicalJson = value => JSON.stringify(canonicalize(value))

const runCli = async() => {
  try {
    const report = await runSmoke(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${canonicalJson(report)}\n`)
  } catch (error) {
    process.stdout.write(`${canonicalJson({ error: error?.code ?? 'smoke_failed' })}\n`)
    process.exitCode = 1
  }
}

const forwardCliToElectron = () => {
  const result = childProcess.spawnSync(require('electron'), [__filename, ...process.argv.slice(2)], {
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  })
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error != null && !result.stdout) {
    process.stdout.write(`${canonicalJson({ error: 'smoke_runtime_unavailable' })}\n`)
  }
  process.exitCode = result.status ?? 1
}

if (require.main == module && process.platform == 'win32' && typeof process.versions.electron != 'string') {
  forwardCliToElectron()
} else if (require.main == module) {
  ;(async() => {
    await runCli()
  })()
}

module.exports = {
  DISPOSABLE_ROOT_NAME,
  EXPECTED_FILESYSTEMS,
  parseArguments,
  probeWindowsFilesystem,
  runProductionBackupFlow,
  runSmoke,
  runSyntheticPortableFlows,
}
