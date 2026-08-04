const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')

const {
  validateDirectDirectory,
  closeDirectDirectory,
} = require('../../src/main/storage/directDirectory')
const {
  reserveExclusiveIsolation,
  reopenExclusiveIsolation,
  isolateOwnedPath,
  reclaimIsolatedPayload,
} = require('../../src/main/storage/exclusiveIsolation')

const testRoot = process.env.LX_TEST_STORAGE_ROOT
if (testRoot == null) throw new Error('LX_TEST_STORAGE_ROOT is required')

const fixtures = []
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })

const createFixture = () => {
  const rootPath = fs.mkdtempSync(path.join(testRoot, 'lx-exclusive-isolation-'))
  const root = validateDirectDirectory(rootPath)
  fixtures.push({ rootPath, root })
  return { rootPath, root }
}

const captureOwnedFile = (root, basename) => {
  const sourcePath = path.join(root.path, basename)
  fs.writeFileSync(sourcePath, 'owned', { flag: 'wx' })
  return {
    root,
    path: sourcePath,
    basename,
    identity: identityOf(fs.lstatSync(sourcePath, { bigint: true })),
    kind: 'file',
  }
}

const isolateFixtureDirectory = async() => {
  const fixture = createFixture()
  const sourcePath = path.join(fixture.root.path, 'cache')
  fs.mkdirSync(sourcePath)
  fs.writeFileSync(path.join(sourcePath, 'marker'), 'owned')
  const result = await isolateOwnedPath({
    source: {
      root: fixture.root,
      path: sourcePath,
      basename: 'cache',
      identity: identityOf(fs.lstatSync(sourcePath, { bigint: true })),
      kind: 'directory',
    },
    prefix: '.lx-isolation-',
  })
  assert.equal(result.state, 'isolated')
  return { fixture, guard: result.guard }
}

const verifyPayload = async payloadPath => {
  assert.equal(fs.readFileSync(path.join(payloadPath, 'marker'), 'utf8'), 'owned')
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try { closeDirectDirectory(fixture.root) } catch {}
    fs.rmSync(fixture.rootPath, { recursive: true, force: true })
  }
})

describe('exclusive isolation', () => {
  it('reserves an unpredictable empty direct-child isolation directory exclusively', async() => {
    const fixture = createFixture()
    const reservation = await reserveExclusiveIsolation({
      root: fixture.root,
      prefix: '.lx-isolation-',
      randomBytes: () => Buffer.alloc(16, 7),
    })

    assert.equal(reservation.isolationBasename, `.lx-isolation-${'07'.repeat(16)}`)
    assert.equal(path.dirname(reservation.isolationPath), fixture.root.path)
    assert.equal(reservation.payloadPath, path.join(reservation.isolationPath, 'payload'))
    assert.deepEqual(fs.readdirSync(reservation.isolationPath), [])
    assert.deepEqual(reservation.isolationIdentity, identityOf(fs.lstatSync(reservation.isolationPath, { bigint: true })))
    assert.equal(fs.statSync(reservation.isolationPath).mode & 0o777, process.platform == 'win32' ? 0o666 : 0o700)

    const reopened = await reopenExclusiveIsolation({
      root: fixture.root,
      isolationBasename: reservation.isolationBasename,
      isolationIdentity: reservation.isolationIdentity,
    })
    assert.deepEqual(reopened, reservation)
  })

  it('retries EEXIST without adopting or replacing the existing node', async() => {
    const fixture = createFixture()
    const collision = `.lx-isolation-${'01'.repeat(16)}`
    fs.mkdirSync(path.join(fixture.root.path, collision))
    const tokens = [Buffer.alloc(16, 1), Buffer.alloc(16, 2)]
    const reservation = await reserveExclusiveIsolation({
      root: fixture.root,
      prefix: '.lx-isolation-',
      randomBytes: () => tokens.shift(),
    })

    assert.equal(reservation.isolationBasename, `.lx-isolation-${'02'.repeat(16)}`)
    assert.equal(fs.existsSync(path.join(fixture.root.path, collision)), true)
    assert.deepEqual(fs.readdirSync(path.join(fixture.root.path, collision)), [])
  })

  it('reports conflict and preserves both payload and stable-path replacement', async() => {
    const fixture = createFixture()
    const source = captureOwnedFile(fixture.root, 'cache.db')
    const isolation = await reserveExclusiveIsolation({
      root: source.root,
      prefix: '.lx-isolation-',
    })
    const result = await isolateOwnedPath({
      source,
      reservation: isolation,
      beforeStableAbsenceCheck: () => fs.writeFileSync(source.path, 'replacement', { flag: 'wx' }),
    })

    assert.equal(result.state, 'conflict')
    assert.equal(fs.readFileSync(source.path, 'utf8'), 'replacement')
    assert.equal(fs.readFileSync(isolation.payloadPath, 'utf8'), 'owned')
  })

  it('does not overwrite a foreign payload created before the move boundary', async() => {
    const fixture = createFixture()
    const source = captureOwnedFile(fixture.root, 'cache.db')
    const isolation = await reserveExclusiveIsolation({ root: fixture.root, prefix: '.lx-isolation-' })
    const originalLstat = fs.lstatSync
    let sourceReads = 0
    let injected = false
    fs.lstatSync = (target, ...args) => {
      if (target == source.path) sourceReads++
      if (!injected && target == source.path && sourceReads == 3) {
        injected = true
        fs.writeFileSync(isolation.payloadPath, 'foreign', { flag: 'wx' })
      }
      return originalLstat(target, ...args)
    }
    try {
      await assert.rejects(isolateOwnedPath({ source, reservation: isolation }), /isolation_changed/)
    } finally {
      fs.lstatSync = originalLstat
    }

    assert.equal(fs.readFileSync(source.path, 'utf8'), 'owned')
    assert.equal(fs.readFileSync(isolation.payloadPath, 'utf8'), 'foreign')
  })

  it('reports absent when the source disappears during its final revalidation', async() => {
    const fixture = createFixture()
    const source = captureOwnedFile(fixture.root, 'cache.db')
    const isolation = await reserveExclusiveIsolation({ root: fixture.root, prefix: '.lx-isolation-' })
    const originalLstat = fs.lstatSync
    let sourceReads = 0
    fs.lstatSync = (target, ...args) => {
      if (target == source.path && ++sourceReads == 3) fs.unlinkSync(source.path)
      return originalLstat(target, ...args)
    }
    try {
      const result = await isolateOwnedPath({ source, reservation: isolation })
      assert.deepEqual(result, { state: 'absent' })
    } finally {
      fs.lstatSync = originalLstat
    }

    assert.equal(fs.existsSync(source.path), false)
    assert.equal(fs.existsSync(isolation.payloadPath), false)
  })

  it('reports conflict when a stable-path replacement appears after its first absence check', async() => {
    const fixture = createFixture()
    const source = captureOwnedFile(fixture.root, 'cache.db')
    const isolation = await reserveExclusiveIsolation({ root: fixture.root, prefix: '.lx-isolation-' })
    const originalLstat = fs.lstatSync
    let sourceReads = 0
    let sawStableAbsence = false
    let injected = false
    fs.lstatSync = (target, ...args) => {
      if (target == source.path && ++sourceReads == 4) {
        try {
          originalLstat(target, ...args)
        } catch (error) {
          if (error?.code == 'ENOENT') sawStableAbsence = true
          else throw error
        }
      }
      if (sawStableAbsence && !injected && target == isolation.payloadPath) {
        injected = true
        fs.writeFileSync(source.path, 'replacement', { flag: 'wx' })
      }
      return originalLstat(target, ...args)
    }
    try {
      const result = await isolateOwnedPath({ source, reservation: isolation })
      assert.equal(result.state, 'conflict')
    } finally {
      fs.lstatSync = originalLstat
    }

    assert.equal(fs.readFileSync(source.path, 'utf8'), 'replacement')
    assert.equal(fs.readFileSync(isolation.payloadPath, 'utf8'), 'owned')
  })

  it('retains the moved payload when its marker verification fails', async() => {
    const fixture = createFixture()
    const source = captureOwnedFile(fixture.root, 'cache.db')
    const isolation = await reserveExclusiveIsolation({ root: fixture.root, prefix: '.lx-isolation-' })

    await assert.rejects(
      isolateOwnedPath({
        source,
        reservation: isolation,
        verifySource: async sourcePath => {
          assert.equal(sourcePath, isolation.payloadPath)
          throw new Error('marker mismatch')
        },
      }),
      /marker mismatch/,
    )
    assert.equal(fs.existsSync(source.path), false)
    assert.equal(fs.readFileSync(isolation.payloadPath, 'utf8'), 'owned')
  })

  it('reclaims only an exactly verified payload with no unexpected siblings', async() => {
    const isolated = await isolateFixtureDirectory()
    fs.writeFileSync(path.join(isolated.guard.isolationPath, 'unexpected'), 'keep')

    const result = await reclaimIsolatedPayload({ guard: isolated.guard, verifyPayload })

    assert.equal(result.state, 'retained')
    assert.equal(fs.existsSync(isolated.guard.payloadPath), true)
    assert.equal(fs.existsSync(isolated.guard.isolationPath), true)
  })

  it('retains a payload replaced after the exact directory check', async() => {
    const isolated = await isolateFixtureDirectory()
    const originalReaddir = fs.readdirSync
    let payloadReads = 0
    fs.readdirSync = (target, ...args) => {
      const entries = originalReaddir(target, ...args)
      if (target == isolated.guard.isolationPath && entries.length == 1 && entries[0] == 'payload') {
        payloadReads++
        if (payloadReads == 2) {
          fs.renameSync(isolated.guard.payloadPath, path.join(isolated.guard.isolationPath, 'owned-payload'))
          fs.writeFileSync(isolated.guard.payloadPath, 'replacement', { flag: 'wx' })
        }
      }
      return entries
    }
    try {
      const result = await reclaimIsolatedPayload({ guard: isolated.guard, verifyPayload })
      assert.equal(result.state, 'retained')
    } finally {
      fs.readdirSync = originalReaddir
    }

    assert.equal(fs.readFileSync(isolated.guard.payloadPath, 'utf8'), 'replacement')
    assert.equal(fs.existsSync(path.join(isolated.guard.isolationPath, 'owned-payload')), true)
  })

  it('reclaims an exactly verified payload and its owned empty private directory', async() => {
    const isolated = await isolateFixtureDirectory()

    const result = await reclaimIsolatedPayload({ guard: isolated.guard, verifyPayload })

    assert.deepEqual(result, { state: 'reclaimed' })
    assert.equal(fs.existsSync(isolated.guard.payloadPath), false)
    assert.equal(fs.existsSync(isolated.guard.isolationPath), false)
  })

  it('retains an isolation directory replaced after its empty check', async() => {
    const isolated = await isolateFixtureDirectory()
    const originalReaddir = fs.readdirSync
    const displacedPath = `${isolated.guard.isolationPath}-displaced`
    let injected = false
    fs.readdirSync = (target, ...args) => {
      const entries = originalReaddir(target, ...args)
      if (!injected && target == isolated.guard.isolationPath && entries.length == 0) {
        injected = true
        fs.renameSync(isolated.guard.isolationPath, displacedPath)
        fs.mkdirSync(isolated.guard.isolationPath)
      }
      return entries
    }
    try {
      const result = await reclaimIsolatedPayload({ guard: isolated.guard, verifyPayload })
      assert.equal(result.state, 'retained')
    } finally {
      fs.readdirSync = originalReaddir
    }

    assert.equal(fs.existsSync(isolated.guard.isolationPath), true)
    assert.equal(fs.existsSync(displacedPath), true)
  })

  it('rejects incomplete reservation identities as invalid', async() => {
    const fixture = createFixture()
    await assert.rejects(
      reopenExclusiveIsolation({
        root: fixture.root,
        isolationBasename: 'missing',
        isolationIdentity: { dev: '1' },
      }),
      error => error?.code == 'isolation_invalid',
    )
  })

  it('retains the private directory when identity marker or removal verification fails', async() => {
    const markerFailure = await isolateFixtureDirectory()
    const markerResult = await reclaimIsolatedPayload({
      guard: markerFailure.guard,
      verifyPayload: async() => { throw new Error('marker mismatch') },
    })
    assert.equal(markerResult.state, 'retained')
    assert.equal(fs.existsSync(markerFailure.guard.payloadPath), true)

    const removalFailure = await isolateFixtureDirectory()
    const originalRm = fs.rmSync
    fs.rmSync = () => { throw new Error('injected removal failure') }
    try {
      const removalResult = await reclaimIsolatedPayload({ guard: removalFailure.guard, verifyPayload })
      assert.equal(removalResult.state, 'retained')
    } finally {
      fs.rmSync = originalRm
    }
    assert.equal(fs.existsSync(removalFailure.guard.payloadPath), true)
    assert.equal(fs.existsSync(removalFailure.guard.isolationPath), true)
  })
})
