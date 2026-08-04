const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')

const properLockfile = require('proper-lockfile')
const { getLocks } = require('proper-lockfile/lib/lockfile')
const {
  acquireMigrationLease,
  releaseMigrationLease,
} = require('../../src/main/migration/migrationLease')

const testRoot = process.env.LX_TEST_STORAGE_ROOT
if (testRoot == null) throw new Error('LX_TEST_STORAGE_ROOT is required')

const cleanupPaths = new Set()
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })

const createFixture = (lockBasename = 'profile.migration.lock') => {
  const rootPath = fs.mkdtempSync(path.join(testRoot, 'lx-migration-lease-'))
  const lockPath = path.join(rootPath, lockBasename)
  cleanupPaths.add(rootPath)
  return {
    rootPath,
    lockPath,
    options: { rootPath, lockPath, logger: { info() {}, warn() {}, error() {} } },
  }
}

const captureLeaseAdapter = async action => {
  const originalLock = properLockfile.lock
  let captured
  properLockfile.lock = async(file, options) => {
    captured = { file, options }
    return originalLock(file, options)
  }
  try {
    const result = await action()
    assert.ok(captured)
    return { result, ...captured }
  } finally {
    properLockfile.lock = originalLock
  }
}

const callAdapter = (method, ...args) => new Promise((resolve, reject) => {
  method(...args, (error, result) => error == null ? resolve(result) : reject(error))
})

afterEach(() => {
  for (const cleanupPath of cleanupPaths) {
    fs.rmSync(cleanupPath, { recursive: true, force: true })
  }
  cleanupPaths.clear()
})

describe('migration lease', () => {
  // Catches a regression that creates a regular-file/hard-link lock or removes a node it did not identify as its lease.
  it('acquires without hard links and releases only the owned empty lease directory', async() => {
    const fixture = createFixture()
    const rootIdentity = identityOf(fs.lstatSync(fixture.rootPath, { bigint: true }))

    const lease = await acquireMigrationLease(fixture.options)

    assert.equal(fs.lstatSync(fixture.lockPath).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
    assert.equal(lease.rootPath, fixture.rootPath)
    assert.equal(lease.lockPath, fixture.lockPath)
    assert.deepEqual(lease.rootIdentity, rootIdentity)
    assert.deepEqual(lease.lockIdentity, identityOf(fs.lstatSync(fixture.lockPath, { bigint: true })))
    lease.assertHeld()

    await releaseMigrationLease(lease)

    assert.equal(fs.existsSync(fixture.lockPath), false)
    assert.equal(fs.existsSync(fixture.rootPath), true)
  })

  // Catches accepting an arbitrary basename, a nested suffix match, or a lock path outside the validated root.
  it('accepts only existing migration lock names as direct children of rootPath', async() => {
    const fixture = createFixture()
    const outsidePath = path.join(testRoot, `outside-${path.basename(fixture.rootPath)}.migration.lock`)
    cleanupPaths.add(outsidePath)
    const invalidPaths = [
      path.join(fixture.rootPath, 'not-a-migration-lock'),
      path.join(fixture.rootPath, 'nested', 'profile.migration.lock'),
      outsidePath,
    ]

    for (const lockPath of invalidPaths) {
      await assert.rejects(
        acquireMigrationLease({ ...fixture.options, lockPath }),
        /migration_lease_invalid/,
      )
      assert.equal(fs.existsSync(lockPath), false)
    }

    const portable = createFixture('.portable-profile-migration.lock')
    const lease = await acquireMigrationLease(portable.options)
    assert.equal(fs.lstatSync(portable.lockPath).isDirectory(), true)
    await releaseMigrationLease(lease)
  })

  // Catches stale recovery that recursively deletes an unknown entry or adopts a linked/file lock node.
  it('preserves and rejects a non-empty or linked lease path', async() => {
    const nonEmpty = createFixture()
    fs.mkdirSync(nonEmpty.lockPath)
    fs.writeFileSync(path.join(nonEmpty.lockPath, 'unknown'), 'keep')

    await assert.rejects(acquireMigrationLease(nonEmpty.options), /migration_lease_invalid/)
    assert.equal(fs.readFileSync(path.join(nonEmpty.lockPath, 'unknown'), 'utf8'), 'keep')

    const linked = createFixture()
    const externalFile = path.join(linked.rootPath, 'external-lock-owner')
    fs.writeFileSync(externalFile, 'keep-linked')
    fs.linkSync(externalFile, linked.lockPath)

    await assert.rejects(acquireMigrationLease(linked.options), /migration_lease_invalid/)
    assert.equal(fs.readFileSync(linked.lockPath, 'utf8'), 'keep-linked')
    assert.equal(fs.readFileSync(externalFile, 'utf8'), 'keep-linked')
  })

  // Catches a post-mkdir crash becoming unrecoverable, or stale recovery replacing a changed/non-empty directory.
  it('recovers an unchanged stale empty directory left by a crash before the first heartbeat', async() => {
    const fixture = createFixture()
    const originalLock = properLockfile.lock
    properLockfile.lock = async(_file, options) => {
      await callAdapter(options.fs.mkdir.bind(options.fs), options.lockfilePath)
      throw new Error('injected_crash_after_mkdir')
    }
    try {
      await assert.rejects(acquireMigrationLease(fixture.options), /injected_crash_after_mkdir/)
    } finally {
      properLockfile.lock = originalLock
    }

    assert.equal(fs.lstatSync(fixture.lockPath).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
    const crashedIdentity = identityOf(fs.lstatSync(fixture.lockPath, { bigint: true }))
    const staleTime = new Date(Date.now() - 31_000)
    fs.utimesSync(fixture.lockPath, staleTime, staleTime)

    const lease = await acquireMigrationLease(fixture.options)

    assert.notDeepEqual(lease.lockIdentity, crashedIdentity)
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
    await releaseMigrationLease(lease)
  })

  // Catches stale reclaim deleting the same lease after its owner refreshed mtime between the stale stat and rmdir.
  it('preserves a stale candidate that receives a heartbeat before reclaim', async() => {
    const fixture = createFixture()
    fs.mkdirSync(fixture.lockPath)
    const staleTime = new Date(Date.now() - 31_000)
    fs.utimesSync(fixture.lockPath, staleTime, staleTime)
    const candidateIdentity = identityOf(fs.lstatSync(fixture.lockPath, { bigint: true }))
    const originalLock = properLockfile.lock
    let heartbeatTime
    properLockfile.lock = (file, options) => {
      const controlledRmdir = options.fs.rmdir.bind(options.fs)
      options.fs.rmdir = (targetPath, callback) => {
        heartbeatTime = new Date()
        fs.utimesSync(targetPath, heartbeatTime, heartbeatTime)
        controlledRmdir(targetPath, callback)
      }
      return originalLock(file, options)
    }
    try {
      await assert.rejects(acquireMigrationLease(fixture.options), /migration_lease_invalid|already being held/)
    } finally {
      properLockfile.lock = originalLock
    }

    assert.ok(heartbeatTime)
    assert.deepEqual(identityOf(fs.lstatSync(fixture.lockPath, { bigint: true })), candidateIdentity)
    assert.equal(fs.statSync(fixture.lockPath).mtimeMs, heartbeatTime.getTime())
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
  })

  // Catches retry adopting and deleting a stale replacement after the first candidate identity check rejects it.
  it('poisons acquisition after a stale candidate identity replacement', async() => {
    const fixture = createFixture()
    const movedCandidate = `${fixture.lockPath}.first-candidate`
    fs.mkdirSync(fixture.lockPath)
    const staleTime = new Date(Date.now() - 31_000)
    fs.utimesSync(fixture.lockPath, staleTime, staleTime)
    const originalLock = properLockfile.lock
    let replacementIdentity
    properLockfile.lock = (file, options) => {
      const controlledRmdir = options.fs.rmdir.bind(options.fs)
      let injected = false
      options.fs.rmdir = (targetPath, callback) => {
        if (!injected) {
          injected = true
          fs.renameSync(targetPath, movedCandidate)
          fs.mkdirSync(targetPath)
          const replacementStaleTime = new Date(Date.now() - 40_000)
          fs.utimesSync(targetPath, replacementStaleTime, replacementStaleTime)
          replacementIdentity = identityOf(fs.lstatSync(targetPath, { bigint: true }))
        }
        controlledRmdir(targetPath, callback)
      }
      return originalLock(file, options)
    }
    try {
      await assert.rejects(acquireMigrationLease(fixture.options), /migration_lease_invalid/)
    } finally {
      properLockfile.lock = originalLock
    }

    assert.deepEqual(identityOf(fs.lstatSync(fixture.lockPath, { bigint: true })), replacementIdentity)
    assert.equal(fs.lstatSync(movedCandidate).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
  })

  // Catches retry rebinding and deleting the same stale inode after its observed stale mtime changes.
  it('poisons acquisition after a stale candidate changes to another stale mtime', async() => {
    const fixture = createFixture()
    fs.mkdirSync(fixture.lockPath)
    const staleTime = new Date(Date.now() - 31_000)
    fs.utimesSync(fixture.lockPath, staleTime, staleTime)
    const candidateIdentity = identityOf(fs.lstatSync(fixture.lockPath, { bigint: true }))
    const originalLock = properLockfile.lock
    let changedStaleTime
    properLockfile.lock = (file, options) => {
      const controlledRmdir = options.fs.rmdir.bind(options.fs)
      let injected = false
      options.fs.rmdir = (targetPath, callback) => {
        if (!injected) {
          injected = true
          changedStaleTime = new Date(Date.now() - 45_000)
          fs.utimesSync(targetPath, changedStaleTime, changedStaleTime)
        }
        controlledRmdir(targetPath, callback)
      }
      return originalLock(file, options)
    }
    try {
      await assert.rejects(acquireMigrationLease(fixture.options), /migration_lease_invalid/)
    } finally {
      properLockfile.lock = originalLock
    }

    assert.deepEqual(identityOf(fs.lstatSync(fixture.lockPath, { bigint: true })), candidateIdentity)
    assert.equal(fs.statSync(fixture.lockPath).mtimeMs, changedStaleTime.getTime())
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
  })

  // Catches an adapter that does not permit the package heartbeat or lets a fresh live lease be reclaimed as stale.
  it('keeps a live heartbeat lease blocking competing acquisition', async() => {
    const fixture = createFixture()
    const { result: lease, file, options } = await captureLeaseAdapter(() => acquireMigrationLease(fixture.options))
    const heartbeatTime = new Date(Date.now() + 5_000)

    const stat = await callAdapter(options.fs.stat.bind(options.fs), fixture.lockPath)
    await callAdapter(options.fs.utimes.bind(options.fs), fixture.lockPath, heartbeatTime, heartbeatTime)

    assert.equal(file, fixture.rootPath)
    assert.equal(options.lockfilePath, fixture.lockPath)
    assert.equal(options.realpath, false)
    assert.equal(options.stale, 30_000)
    assert.equal(options.update, 10_000)
    assert.deepEqual(options.retries, {
      retries: 3,
      factor: 1,
      minTimeout: 250,
      maxTimeout: 250,
      randomize: false,
    })
    assert.deepEqual(identityOf(stat), lease.lockIdentity)
    assert.equal(fs.statSync(fixture.lockPath).mtimeMs, heartbeatTime.getTime())
    await assert.rejects(acquireMigrationLease(fixture.options), error => error?.code == 'ELOCKED')
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])

    await releaseMigrationLease(lease)
  })

  // Catches compromise being transient, exposing the dependency error, or allowing release to mutate the directory afterward.
  it('rejects every mutation after the compromise callback fires', async() => {
    const fixture = createFixture()
    const { result: lease, options } = await captureLeaseAdapter(() => acquireMigrationLease(fixture.options))

    options.onCompromised(new Error('injected'))

    let firstError
    assert.throws(() => lease.assertHeld(), error => {
      firstError = error
      return error?.code == 'migration_lease_compromised' && error.message == 'migration_lease_compromised'
    })
    assert.throws(() => lease.assertHeld(), error => error === firstError)
    const mutationErrors = []
    for (const mutation of [
      () => callAdapter(options.fs.mkdir.bind(options.fs), fixture.lockPath),
      () => callAdapter(options.fs.utimes.bind(options.fs), fixture.lockPath, new Date(), new Date()),
      () => callAdapter(options.fs.rmdir.bind(options.fs), fixture.lockPath),
    ]) {
      mutationErrors.push(await mutation().then(() => null, error => error))
    }
    assert.deepEqual(mutationErrors, [firstError, firstError, firstError])
    assert.equal(fs.lstatSync(fixture.lockPath).isDirectory(), true)
    await assert.rejects(releaseMigrationLease(lease), error => error === firstError)
    assert.equal(getLocks()[fixture.rootPath], undefined)
    assert.throws(() => lease.assertHeld(), /migration_lease_invalid/)
    assert.equal(fs.lstatSync(fixture.lockPath).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
  })

  // Catches post-acquisition validation failure leaking the package heartbeat and in-process ownership entry.
  it('clears package lifecycle after post-acquisition identity compromise', async() => {
    const fixture = createFixture()
    const movedOwnedLock = `${fixture.lockPath}.owned`
    const originalLock = properLockfile.lock
    properLockfile.lock = async(file, options) => {
      const packageRelease = await originalLock(file, options)
      assert.ok(getLocks()[fixture.rootPath])
      fs.renameSync(fixture.lockPath, movedOwnedLock)
      fs.mkdirSync(fixture.lockPath)
      fs.writeFileSync(path.join(fixture.lockPath, 'replacement'), 'keep-post-acquire')
      return packageRelease
    }
    try {
      await assert.rejects(acquireMigrationLease(fixture.options), /migration_lease_compromised/)
    } finally {
      properLockfile.lock = originalLock
    }

    assert.equal(getLocks()[fixture.rootPath], undefined)
    assert.equal(fs.readFileSync(path.join(fixture.lockPath, 'replacement'), 'utf8'), 'keep-post-acquire')
    assert.equal(fs.lstatSync(movedOwnedLock).isDirectory(), true)
  })

  // Catches a root identity swap that would let heartbeat or release act in an attacker-controlled replacement root.
  it('rejects a root identity change and preserves the replacement root', async() => {
    const fixture = createFixture()
    const movedRoot = `${fixture.rootPath}-owned`
    cleanupPaths.add(movedRoot)
    const lease = await acquireMigrationLease(fixture.options)
    fs.renameSync(fixture.rootPath, movedRoot)
    fs.mkdirSync(fixture.rootPath)
    fs.writeFileSync(path.join(fixture.rootPath, 'replacement'), 'keep-root')

    assert.throws(() => lease.assertHeld(), /migration_lease_compromised/)
    await assert.rejects(releaseMigrationLease(lease), /migration_lease_compromised/)
    assert.equal(fs.readFileSync(path.join(fixture.rootPath, 'replacement'), 'utf8'), 'keep-root')
    assert.equal(fs.lstatSync(path.join(movedRoot, path.basename(fixture.lockPath))).isDirectory(), true)
  })

  // Catches a lock identity race between assertHeld and package release that could remove a replacement directory.
  it('rejects a lock identity change and preserves both the owned and replacement directories', async() => {
    const fixture = createFixture()
    const movedLockPath = `${fixture.lockPath}.owned`
    const lease = await acquireMigrationLease(fixture.options)
    fs.renameSync(fixture.lockPath, movedLockPath)
    fs.mkdirSync(fixture.lockPath)
    fs.writeFileSync(path.join(fixture.lockPath, 'replacement'), 'keep-lock')

    assert.throws(() => lease.assertHeld(), /migration_lease_compromised/)
    await assert.rejects(releaseMigrationLease(lease), /migration_lease_compromised/)
    assert.equal(fs.readFileSync(path.join(fixture.lockPath, 'replacement'), 'utf8'), 'keep-lock')
    assert.equal(fs.lstatSync(movedLockPath).isDirectory(), true)
  })

  // Catches release swallowing an rmdir failure or recursively cleaning the retained lease path.
  it('surfaces release failure and retains the owned empty lease directory', async() => {
    const fixture = createFixture()
    const lease = await acquireMigrationLease(fixture.options)
    const originalRmdir = fs.rmdir
    fs.rmdir = (targetPath, callback) => {
      if (path.resolve(targetPath) == fixture.lockPath) {
        return process.nextTick(callback, Object.assign(new Error('injected_release_failure'), { code: 'EACCES' }))
      }
      return originalRmdir(targetPath, callback)
    }
    try {
      await assert.rejects(releaseMigrationLease(lease), /injected_release_failure/)
    } finally {
      fs.rmdir = originalRmdir
    }

    assert.equal(fs.lstatSync(fixture.lockPath).isDirectory(), true)
    assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
  })
})
