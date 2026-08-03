const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { after, describe, it } = require('node:test')
const { createTestStorageRoot } = require('./helpers/test-storage-root')
const {
  STAGE_MARKER_FILE,
  copyDirectoryWithManifestPromotion,
  createDirectoryManifest,
} = require('../../src/main/migration/guardedDirectoryMigration')

const ISOLATION_PREFIX = '.guarded-directory-migration-isolation-'
const fixtures = new Set()

const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const silentLogger = { info() {}, warn() {}, error() {} }

const createFixtureAt = (root, rootPath) => {
  const sourcePath = path.join(rootPath, 'source')
  const destinationPath = path.join(rootPath, 'destination')
  const stagePrefix = path.join(rootPath, '.destination-stage-')
  fs.mkdirSync(path.join(sourcePath, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(sourcePath, 'nested', 'value'), 'source-value')
  return { root, rootPath, sourcePath, destinationPath, stagePrefix }
}

const createFixture = () => {
  const root = createTestStorageRoot('guarded-directory-migration')
  fixtures.add(root)
  return createFixtureAt(root, root.path)
}

const createNestedRootFixture = () => {
  const root = createTestStorageRoot('guarded-directory-migration')
  fixtures.add(root)
  const rootPath = path.join(root.path, 'migration-root')
  fs.mkdirSync(rootPath)
  return createFixtureAt(root, rootPath)
}

const listIsolationNames = rootPath => fs.readdirSync(rootPath)
  .filter(name => name.startsWith(ISOLATION_PREFIX))

const fakeLease = (fixture, isCompromised = () => false) => ({
  rootPath: fixture.rootPath,
  rootIdentity: identityOf(fs.lstatSync(fixture.rootPath, { bigint: true })),
  lockPath: path.join(fixture.rootPath, '.guarded-directory.migration.lock'),
  lockIdentity: { dev: 'test', ino: 'test' },
  assertHeld() {
    if (isCompromised()) {
      throw Object.assign(new Error('migration_lease_compromised'), { code: 'migration_lease_compromised' })
    }
  },
})

const trackOpenDescriptors = onOpened => {
  const openDescriptors = new Set()
  return {
    openDescriptors,
    fsApi: {
      ...fs,
      open(targetPath, flags, ...args) {
        const callback = args.pop()
        fs.open(targetPath, flags, ...args, (error, descriptor) => {
          if (error == null) {
            openDescriptors.add(descriptor)
            onOpened?.({ targetPath, flags })
          }
          callback(error, descriptor)
        })
      },
      close(descriptor, callback) {
        fs.close(descriptor, error => {
          if (error == null) openDescriptors.delete(descriptor)
          callback(error)
        })
      },
    },
  }
}

const closeTrackedDescriptors = openDescriptors => {
  for (const descriptor of openDescriptors) fs.closeSync(descriptor)
  openDescriptors.clear()
}

const seedRetainedStage = fixture => {
  const stagePath = `${fixture.stagePrefix}unreferenced`
  fs.mkdirSync(stagePath)
  const identity = identityOf(fs.lstatSync(stagePath, { bigint: true }))
  fs.writeFileSync(path.join(stagePath, STAGE_MARKER_FILE), JSON.stringify({
    version: 1,
    nonce: '0123456789abcdef0123456789abcdef',
    runId: 'unreferenced',
    directoryIdentity: identity,
  }))
  fs.writeFileSync(path.join(stagePath, 'sentinel'), 'unreferenced')
  return stagePath
}

const migrateFixture = async(fixture, options = {}) => {
  let stagePath
  const originalMkdir = fs.mkdirSync
  const originalRename = fs.renameSync
  fs.mkdirSync = (targetPath, ...args) => {
    const result = originalMkdir(targetPath, ...args)
    if (path.basename(targetPath).startsWith(ISOLATION_PREFIX)) {
      options.beforeStageIsolation?.({ stagePath, isolationPath: targetPath })
    }
    return result
  }
  fs.renameSync = (sourcePath, destinationPath, ...args) => {
    const result = originalRename(sourcePath, destinationPath, ...args)
    if (stagePath != null && path.resolve(sourcePath) == path.resolve(stagePath) &&
      path.basename(destinationPath) == 'payload') {
      options.afterStageMovedToIsolation?.({ stagePath, isolatedPayloadPath: destinationPath })
    }
    return result
  }
  try {
    return await copyDirectoryWithManifestPromotion({
      fsApi: options.fsApi ?? fs,
      rootPath: fixture.rootPath,
      sourcePath: fixture.sourcePath,
      destinationPath: fixture.destinationPath,
      stagePrefix: fixture.stagePrefix,
      runId: 'focused-test-run',
      lease: options.lease ?? fakeLease(fixture, options.isCompromised),
      logger: silentLogger,
      writePayloadMarker({ payloadPath }) {
        return options.writePayloadMarker?.(payloadPath)
      },
      beforePromotion(input) {
        stagePath = path.dirname(input.payloadPath)
        return options.beforePromotion?.(input)
      },
    })
  } finally {
    fs.mkdirSync = originalMkdir
    fs.renameSync = originalRename
  }
}

after(() => {
  for (const fixture of fixtures) fixture.cleanup()
  fixtures.clear()
})

describe('guarded directory migration', () => {
  // Catches cleanup bypassing isolation or leaving a private isolation directory after exact reclamation.
  it('reclaims a successfully isolated guarded stage', async() => {
    const fixture = createFixture()

    const result = await migrateFixture(fixture)

    assert.equal(result.status, 'promoted')
    assert.equal(fs.existsSync(result.stagePath), false)
    assert.deepEqual(listIsolationNames(fixture.root.path), [])
  })

  // Catches cleanup recapturing the stable pathname after an isolation reservation instead of using creation identity.
  it('preserves a replacement raced into guarded-stage isolation', async() => {
    const fixture = createFixture()
    let displacedPath

    const result = await migrateFixture(fixture, {
      beforeStageIsolation({ stagePath }) {
        displacedPath = `${stagePath}.creation-bound`
        fs.renameSync(stagePath, displacedPath)
        fs.cpSync(displacedPath, stagePath, { recursive: true, errorOnExist: true })
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(fs.existsSync(result.stagePath), true)
    assert.equal(fs.readFileSync(path.join(result.stagePath, STAGE_MARKER_FILE), 'utf8'),
      fs.readFileSync(path.join(displacedPath, STAGE_MARKER_FILE), 'utf8'))
    assert.equal(listIsolationNames(fixture.root.path).length, 1)
  })

  // Catches retry cleanup scanning prefix-matching directories for marker-shaped content.
  it('never scans a retained or unreferenced stage directory on retry', async() => {
    const fixture = createFixture()
    const retainedPath = seedRetainedStage(fixture)

    const result = await migrateFixture(fixture)

    assert.equal(result.status, 'promoted')
    assert.equal(fs.readFileSync(path.join(retainedPath, 'sentinel'), 'utf8'), 'unreferenced')
  })

  // Catches pathname-based cleanup accepting identical bytes after the creation-bound node has moved.
  it('binds guarded-stage identity at exclusive creation and preserves a later same-content replacement', async() => {
    const fixture = createFixture()
    let isolatedPayloadPath

    const result = await migrateFixture(fixture, {
      afterStageMovedToIsolation({ stagePath, isolatedPayloadPath: payloadPath }) {
        isolatedPayloadPath = payloadPath
        fs.cpSync(payloadPath, stagePath, { recursive: true, errorOnExist: true })
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(fs.existsSync(result.stagePath), true)
    assert.equal(listIsolationNames(fixture.root.path).length, 1)
    assert.equal(fs.existsSync(isolatedPayloadPath), true)
    assert.deepEqual(identityOf(fs.lstatSync(isolatedPayloadPath, { bigint: true })),
      JSON.parse(fs.readFileSync(path.join(isolatedPayloadPath, STAGE_MARKER_FILE), 'utf8')).directoryIdentity)
    assert.notDeepEqual(identityOf(fs.lstatSync(result.stagePath, { bigint: true })),
      identityOf(fs.lstatSync(isolatedPayloadPath, { bigint: true })))
  })

  // Catches an awaited promotion callback being followed by destination mutation without reasserting the lease.
  it('blocks promotion after the lease is compromised and leaves source and destination unchanged', async() => {
    const fixture = createFixture()
    let compromised = false

    const result = await migrateFixture(fixture, {
      isCompromised: () => compromised,
      beforePromotion() { compromised = true },
    })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'migration_lease_compromised')
    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(fs.readFileSync(path.join(fixture.sourcePath, 'nested', 'value'), 'utf8'), 'source-value')
  })

  // Catches stage creation continuing under a replacement root after the source scan returns an original-root stat.
  it('does not mutate a replacement root after the asynchronous source scan', async() => {
    const fixture = createNestedRootFixture()
    const displacedRootPath = `${fixture.rootPath}.creation-bound`
    const replacementSentinelPath = path.join(fixture.rootPath, 'replacement-sentinel')
    let sourceRootStats = 0
    let stageCreations = 0
    const fsApi = {
      ...fs,
      lstat(targetPath, ...args) {
        const callback = args.pop()
        fs.lstat(targetPath, ...args, (error, stat) => {
          if (error == null && targetPath == fixture.sourcePath && ++sourceRootStats == 2) {
            fs.renameSync(fixture.rootPath, displacedRootPath)
            fs.cpSync(displacedRootPath, fixture.rootPath, { recursive: true, errorOnExist: true })
            fs.writeFileSync(replacementSentinelPath, 'replacement-root')
          }
          callback(error, stat)
        })
      },
      mkdtempSync(...args) {
        stageCreations++
        return fs.mkdtempSync(...args)
      },
    }

    const result = await migrateFixture(fixture, { fsApi })

    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(stageCreations, 0)
    assert.equal(result.status, 'failed')
    assert.equal(fs.readFileSync(replacementSentinelPath, 'utf8'), 'replacement-root')
    assert.equal(fs.existsSync(displacedRootPath), true)
  })

  // Catches promotion trusting the stable stage pathname after an awaited callback replaces its creation-bound node.
  it('does not expose a replacement stage payload after the promotion callback', async() => {
    const fixture = createFixture()
    let displacedStagePath

    const result = await migrateFixture(fixture, {
      beforePromotion({ payloadPath }) {
        const stagePath = path.dirname(payloadPath)
        displacedStagePath = `${stagePath}.creation-bound`
        fs.renameSync(stagePath, displacedStagePath)
        fs.cpSync(displacedStagePath, stagePath, { recursive: true, errorOnExist: true })
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(fs.existsSync(result.stagePath), true)
    assert.equal(fs.existsSync(displacedStagePath), true)
  })

  // Catches promotion recapturing a same-content payload replacement under an otherwise owned stage.
  it('does not expose a replacement payload after the promotion callback', async() => {
    const fixture = createFixture()
    let isolatedStagePath

    const result = await migrateFixture(fixture, {
      beforePromotion({ payloadPath }) {
        const displacedPayloadPath = `${payloadPath}.creation-bound`
        fs.renameSync(payloadPath, displacedPayloadPath)
        fs.cpSync(displacedPayloadPath, payloadPath, { recursive: true, errorOnExist: true })
      },
      afterStageMovedToIsolation({ isolatedPayloadPath }) {
        isolatedStagePath = isolatedPayloadPath
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(listIsolationNames(fixture.rootPath).length, 1)
    assert.equal(fs.existsSync(path.join(isolatedStagePath, 'payload')), true)
    assert.equal(fs.existsSync(path.join(isolatedStagePath, 'payload.creation-bound')), true)
  })

  // Catches promotion relying on a stale manifest after an awaited callback mutates the payload in place.
  it('does not expose payload bytes changed by the promotion callback', async() => {
    const fixture = createFixture()
    let isolatedStagePath

    const result = await migrateFixture(fixture, {
      beforePromotion({ payloadPath }) {
        fs.writeFileSync(path.join(payloadPath, 'nested', 'value'), 'replacement-value')
      },
      afterStageMovedToIsolation({ isolatedPayloadPath }) {
        isolatedStagePath = isolatedPayloadPath
      },
    })

    assert.equal(result.status, 'failed')
    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(listIsolationNames(fixture.rootPath).length, 1)
    assert.equal(fs.readFileSync(path.join(isolatedStagePath, 'payload', 'nested', 'value'), 'utf8'),
      'replacement-value')
  })

  // Catches recursive cleanup reclaiming a stage after an unexpected child appears beside its owned payload.
  it('retains an isolated stage with an unexpected child', async() => {
    const fixture = createFixture()
    let isolatedStagePath

    const result = await migrateFixture(fixture, {
      beforePromotion({ payloadPath }) {
        fs.writeFileSync(path.join(path.dirname(payloadPath), 'unexpected'), 'unowned')
      },
      afterStageMovedToIsolation({ isolatedPayloadPath }) {
        isolatedStagePath = isolatedPayloadPath
      },
    })

    assert.equal(listIsolationNames(fixture.rootPath).length, 1)
    assert.equal(fs.readFileSync(path.join(isolatedStagePath, 'unexpected'), 'utf8'), 'unowned')
    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(result.status, 'failed')
  })

  // Catches a source scan callback resuming after compromise without reasserting before further validation or mutation.
  it('blocks a compromised source revalidation callback before promotion', async() => {
    const fixture = createFixture()
    let compromised = false
    let sourceReads = 0
    const fsApi = {
      ...fs,
      readdir(targetPath, callback) {
        fs.readdir(targetPath, (error, entries) => {
          if (targetPath == fixture.sourcePath && ++sourceReads == 2) compromised = true
          callback(error, entries)
        })
      },
    }

    const result = await migrateFixture(fixture, { fsApi, isCompromised: () => compromised })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'migration_lease_compromised')
    assert.equal(fs.existsSync(fixture.destinationPath), false)
    assert.equal(fs.readFileSync(path.join(fixture.sourcePath, 'nested', 'value'), 'utf8'), 'source-value')
  })

  // Catches lease assertion failure hiding a newly opened source descriptor from cleanup.
  it('closes a source descriptor when the lease is compromised as open completes', async() => {
    const fixture = createFixture()
    let compromised = false
    const { fsApi, openDescriptors } = trackOpenDescriptors(({ flags }) => {
      if (flags == 'r') compromised = true
    })

    try {
      const result = await migrateFixture(fixture, { fsApi, isCompromised: () => compromised })

      assert.equal(result.status, 'failed')
      assert.equal(openDescriptors.size, 0)
    } finally {
      closeTrackedDescriptors(openDescriptors)
    }
  })

  // Catches lease assertion failure hiding a newly created destination descriptor from cleanup.
  it('closes a destination descriptor when the lease is compromised as open completes', async() => {
    const fixture = createFixture()
    let compromised = false
    const { fsApi, openDescriptors } = trackOpenDescriptors(({ flags }) => {
      if (flags == 'wx') compromised = true
    })

    try {
      const result = await migrateFixture(fixture, { fsApi, isCompromised: () => compromised })

      assert.equal(result.status, 'failed')
      assert.equal(openDescriptors.size, 0)
    } finally {
      closeTrackedDescriptors(openDescriptors)
    }
  })

  // Catches cleanup entering stage isolation after destination promotion has exposed a compromised lease.
  it('blocks guarded-stage isolation after the lease is compromised', async() => {
    const fixture = createFixture()
    let compromised = false
    const fsApi = {
      ...fs,
      renameSync(sourcePath, destinationPath) {
        fs.renameSync(sourcePath, destinationPath)
        if (destinationPath == fixture.destinationPath) compromised = true
      },
    }

    const result = await migrateFixture(fixture, { fsApi, isCompromised: () => compromised })

    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'migration_lease_compromised')
    assert.equal(fs.readFileSync(path.join(fixture.destinationPath, 'nested', 'value'), 'utf8'), 'source-value')
    assert.equal(fs.existsSync(result.stagePath), true)
    assert.deepEqual(listIsolationNames(fixture.root.path), [])
  })

  // Catches owner-marker creation after mkdtemp without reasserting the lease at that mutation boundary.
  it('does not write the guarded-stage marker after creation compromises the lease', async() => {
    const fixture = createFixture()
    let compromised = false
    let stagePath
    const fsApi = {
      ...fs,
      mkdtempSync(prefix, ...args) {
        stagePath = fs.mkdtempSync(prefix, ...args)
        compromised = true
        return stagePath
      },
    }

    const result = await migrateFixture(fixture, { fsApi, isCompromised: () => compromised })

    assert.equal(result.status, 'failed')
    assert.equal(fs.existsSync(path.join(stagePath, STAGE_MARKER_FILE)), false)
    assert.equal(fs.existsSync(fixture.destinationPath), false)
  })

  // Catches a synchronous recursive copy starving the lease heartbeat until promotion has already happened.
  it('uses asynchronous bounded file I/O before promotion', async() => {
    const fixture = createFixture()
    fs.writeFileSync(path.join(fixture.sourcePath, 'large.bin'), Buffer.alloc(2 * 1024 * 1024, 7))
    let timerRan = false
    setTimeout(() => { timerRan = true }, 0)

    const result = await migrateFixture(fixture, {
      beforePromotion() { assert.equal(timerRan, true) },
    })

    assert.equal(result.status, 'promoted')
  })

  // Catches the manifest API remaining synchronous, which would hide long scans from lease heartbeats.
  it('creates manifests asynchronously', async() => {
    const fixture = createFixture()

    const manifestPromise = createDirectoryManifest(fs, fixture.sourcePath)

    assert.equal(typeof manifestPromise?.then, 'function')
    assert.deepEqual(await manifestPromise, [
      { path: '.', type: 'directory' },
      { path: 'nested', type: 'directory' },
      { path: path.join('nested', 'value'), type: 'file', size: 12, hash: '16e22e8b1d6088f35463a3861974baf6717fc34ef65667736cfb5cff222f82fe' },
    ])
  })
})
