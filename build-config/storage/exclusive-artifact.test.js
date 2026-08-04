const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')

const {
  validateDirectDirectory,
  closeDirectDirectory,
} = require('../../src/main/storage/directDirectory')
const {
  reserveExclusiveArtifact,
  completeExclusiveArtifact,
  closeArtifactReservation,
  revalidateImmutableArtifact,
  closeArtifactGuard,
} = require('../../src/main/storage/exclusiveArtifact')

const testRoot = process.env.LX_TEST_STORAGE_ROOT
if (testRoot == null) throw new Error('LX_TEST_STORAGE_ROOT is required')
const fixtures = []
const sha256 = input => crypto.createHash('sha256').update(input).digest('hex')
const sourceOf = bytes => ({
  byteLength: bytes.length,
  read(offset, maximumBytes) {
    return bytes.subarray(offset, offset + maximumBytes)
  },
})

const createFixture = () => {
  const root = fs.mkdtempSync(path.join(testRoot, 'lx-exclusive-artifact-'))
  fixtures.push(root)
  return { root }
}

const completeFixtureArtifact = (bytes, options = {}) => {
  const fixture = createFixture()
  const root = validateDirectDirectory(fixture.root)
  const reservation = reserveExclusiveArtifact(root, {
    prefix: '.lx-artifact-',
    suffix: '.attempt',
    artifactKind: 'test-v1',
    randomBytes: () => Buffer.alloc(16, 7),
  })
  const guard = completeExclusiveArtifact(reservation, sourceOf(bytes), options)
  return { fixture, root, guard }
}

afterEach(() => {
  for (const root of fixtures.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe('exclusive immutable artifact', () => {
  it('reserves a zero-length same-root regular file with O_EXCL and mode 0600', () => {
    const fixture = createFixture()
    const root = validateDirectDirectory(fixture.root)
    const reservation = reserveExclusiveArtifact(root, {
      prefix: '.lx-artifact-',
      suffix: '.attempt',
      artifactKind: 'test-v1',
      randomBytes: () => Buffer.alloc(16, 1),
    })

    assert.equal(fs.fstatSync(reservation.descriptor).size, 0)
    assert.equal(fs.fstatSync(reservation.descriptor).isFile(), true)
    assert.equal(path.dirname(reservation.path), path.resolve(fixture.root))
    assert.equal(fs.statSync(reservation.path).mode & 0o777, process.platform == 'win32' ? 0o666 : 0o600)

    closeArtifactReservation(reservation)
    closeDirectDirectory(root)
  })

  it('completes bounded chunks without link rename or a staging alias', () => {
    const { fixture, root, guard } = completeFixtureArtifact(Buffer.from('verified bytes'), { chunkBytes: 3 })

    assert.equal(guard.byteLength, 14)
    assert.equal(guard.sha256, sha256(Buffer.from('verified bytes')))
    assert.deepEqual(fs.readdirSync(fixture.root), [guard.basename])

    closeArtifactGuard(guard)
    closeDirectDirectory(root)
  })

  it('retains a partial attempt after write sync or semantic verification failure', () => {
    const fixture = createFixture()
    const root = validateDirectDirectory(fixture.root)
    const reservation = reserveExclusiveArtifact(root, {
      prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
    })

    assert.throws(() => completeExclusiveArtifact(reservation, sourceOf(Buffer.from('partial')), {
      verifyReadOnly: () => { throw new Error('injected semantic failure') },
    }), error => error.code == 'artifact_verification_failed')
    assert.equal(fs.readdirSync(fixture.root).length, 1)

    closeArtifactReservation(reservation)
    closeDirectDirectory(root)
  })

  it('closes retained attempts after write and fsync failures', () => {
    for (const operation of ['write', 'fsync']) {
      const fixture = createFixture()
      const root = validateDirectDirectory(fixture.root)
      const reservation = reserveExclusiveArtifact(root, {
        prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
      })
      const original = operation == 'write' ? fs.writeSync : fs.fsyncSync
      fs[operation == 'write' ? 'writeSync' : 'fsyncSync'] = () => { throw new Error(`injected ${operation} failure`) }
      try {
        assert.throws(() => completeExclusiveArtifact(reservation, sourceOf(Buffer.from('partial'))),
          error => error.code == 'artifact_verification_failed')
      } finally {
        fs[operation == 'write' ? 'writeSync' : 'fsyncSync'] = original
      }
      assert.equal(fs.readdirSync(fixture.root).length, 1)
      assert.throws(() => fs.fstatSync(reservation.descriptor), error => error.code == 'EBADF')
      closeArtifactReservation(reservation)
      closeDirectDirectory(root)
    }
  })

  it('rejects bounded sources that are short, long, or make zero progress', () => {
    const invalidSources = [
      { byteLength: 4, read: () => Buffer.from('abc') },
      { byteLength: 3, read: () => Buffer.from('toolong') },
      { byteLength: 3, read: () => Buffer.alloc(0) },
    ]
    for (const source of invalidSources) {
      const fixture = createFixture()
      const root = validateDirectDirectory(fixture.root)
      const reservation = reserveExclusiveArtifact(root, {
        prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
      })
      assert.throws(() => completeExclusiveArtifact(reservation, source),
        error => error.code == 'artifact_verification_failed')
      assert.equal(fs.readdirSync(fixture.root).length, 1)
      assert.throws(() => fs.fstatSync(reservation.descriptor), error => error.code == 'EBADF')
      closeArtifactReservation(reservation)
      closeDirectDirectory(root)
    }
  })

  it('closes a retained reservation when chunkBytes is invalid', () => {
    const fixture = createFixture()
    const root = validateDirectDirectory(fixture.root)
    const reservation = reserveExclusiveArtifact(root, {
      prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
    })

    assert.throws(() => completeExclusiveArtifact(reservation, sourceOf(Buffer.from('bytes')), { chunkBytes: 0 }),
      error => error.code == 'artifact_invalid')
    assert.equal(fs.readdirSync(fixture.root).length, 1)
    assert.throws(() => fs.fstatSync(reservation.descriptor), error => error.code == 'EBADF')

    closeArtifactReservation(reservation)
    closeDirectDirectory(root)
  })

  it('closing an abandoned reservation retains its zero-length attempt', () => {
    const fixture = createFixture()
    const root = validateDirectDirectory(fixture.root)
    const reservation = reserveExclusiveArtifact(root, {
      prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
    })

    closeArtifactReservation(reservation)
    closeArtifactReservation(reservation)
    assert.equal(fs.statSync(reservation.path).size, 0)

    closeDirectDirectory(root)
  })

  it('closes a completed guard idempotently while retaining its artifact', () => {
    const { fixture, root, guard } = completeFixtureArtifact(Buffer.from('complete'))

    closeArtifactGuard(guard)
    closeArtifactGuard(guard)
    assert.equal(fs.readFileSync(guard.path, 'utf8'), 'complete')
    assert.throws(() => fs.fstatSync(guard.descriptor), error => error.code == 'EBADF')

    assert.deepEqual(fs.readdirSync(fixture.root), [guard.basename])
    closeDirectDirectory(root)
  })

  it('rejects an artifact kind outside the declared union before reserving', () => {
    const fixture = createFixture()
    const root = validateDirectDirectory(fixture.root)

    assert.throws(() => reserveExclusiveArtifact(root, {
      prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'unknown-v1',
    }), error => error.code == 'artifact_invalid')
    assert.deepEqual(fs.readdirSync(fixture.root), [])

    closeDirectDirectory(root)
  })

  it('rejects a root replacement immediately before and after O_EXCL reservation', () => {
    for (const phase of ['before', 'after']) {
      const fixture = createFixture()
      let changed = phase == 'before'
      let guardedDescriptor
      const fsApi = {
        ...fs,
        fstatSync(descriptor, options) {
          const stat = fs.fstatSync(descriptor, options)
          if (changed && descriptor == guardedDescriptor) return { ...stat, dev: stat.dev, ino: BigInt(stat.ino) + 1n }
          return stat
        },
      }
      const root = validateDirectDirectory(fixture.root, { fsApi })
      guardedDescriptor = root.descriptor
      if (phase == 'after') {
        const originalOpen = fs.openSync
        fs.openSync = (...args) => {
          const descriptor = originalOpen(...args)
          changed = true
          return descriptor
        }
        try {
          assert.throws(() => reserveExclusiveArtifact(root, {
            prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
          }), error => error.code == 'direct_directory_changed')
        } finally {
          fs.openSync = originalOpen
        }
      } else {
        assert.throws(() => reserveExclusiveArtifact(root, {
          prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
        }), error => error.code == 'direct_directory_changed')
      }
      closeDirectDirectory(root)
    }
  })

  it('revalidates after random generation and after the final collision', () => {
    const fixture = createFixture()
    let changed = false
    let guardedDescriptor
    const fsApi = {
      ...fs,
      fstatSync(descriptor, options) {
        const stat = fs.fstatSync(descriptor, options)
        return changed && descriptor == guardedDescriptor
          ? { dev: stat.dev, ino: BigInt(stat.ino) + 1n }
          : stat
      },
    }
    const root = validateDirectDirectory(fixture.root, { fsApi })
    guardedDescriptor = root.descriptor
    let openCalls = 0
    const originalOpen = fs.openSync
    fs.openSync = (...args) => {
      openCalls++
      return originalOpen(...args)
    }
    try {
      assert.throws(() => reserveExclusiveArtifact(root, {
        prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
        randomBytes: () => {
          changed = true
          return Buffer.alloc(16, 3)
        },
      }), error => error.code == 'direct_directory_changed')
    } finally {
      fs.openSync = originalOpen
    }
    assert.equal(openCalls, 0)
    closeDirectDirectory(root)

    const collisionFixture = createFixture()
    changed = false
    const collisionRoot = validateDirectDirectory(collisionFixture.root, { fsApi })
    guardedDescriptor = collisionRoot.descriptor
    const token = Buffer.alloc(16, 4).toString('hex')
    fs.writeFileSync(path.join(collisionFixture.root, `.lx-artifact-${token}.attempt`), 'retained')
    let attempts = 0
    fs.openSync = (...args) => {
      try {
        return originalOpen(...args)
      } finally {
        attempts++
        if (attempts == 8) changed = true
      }
    }
    try {
      assert.throws(() => reserveExclusiveArtifact(collisionRoot, {
        prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
        randomBytes: () => Buffer.alloc(16, 4),
      }), error => error.code == 'direct_directory_changed')
    } finally {
      fs.openSync = originalOpen
    }
    assert.equal(attempts, 8)
    assert.deepEqual(fs.readdirSync(collisionFixture.root), [`.lx-artifact-${token}.attempt`])
    closeDirectDirectory(collisionRoot)
  })

  it('rejects pathname and root replacement at final guard revalidation', () => {
    const { root, guard } = completeFixtureArtifact(Buffer.from('verified bytes'))

    fs.renameSync(guard.path, `${guard.path}.retained`)
    fs.writeFileSync(guard.path, 'replacement', { mode: 0o600 })
    assert.throws(() => revalidateImmutableArtifact(guard), error => error.code == 'artifact_changed')

    closeArtifactGuard(guard)
    closeDirectDirectory(root)

    const fixture = createFixture()
    let changed = false
    let guardedDescriptor
    const fsApi = {
      ...fs,
      fstatSync(descriptor, options) {
        const stat = fs.fstatSync(descriptor, options)
        return changed && descriptor == guardedDescriptor
          ? { dev: stat.dev, ino: BigInt(stat.ino) + 1n }
          : stat
      },
    }
    const guardedRoot = validateDirectDirectory(fixture.root, { fsApi })
    guardedDescriptor = guardedRoot.descriptor
    const reservation = reserveExclusiveArtifact(guardedRoot, {
      prefix: '.lx-artifact-', suffix: '.attempt', artifactKind: 'test-v1',
    })
    const rootGuard = completeExclusiveArtifact(reservation, sourceOf(Buffer.from('verified bytes')))
    changed = true
    assert.throws(() => revalidateImmutableArtifact(rootGuard), error => error.code == 'direct_directory_changed')

    closeArtifactGuard(rootGuard)
    closeDirectDirectory(guardedRoot)
  })

  it('works with an adapter that exposes no link and no directory fsync', () => {
    const originalLink = fs.linkSync
    const originalFsync = fs.fsyncSync
    fs.linkSync = undefined
    fs.fsyncSync = descriptor => {
      if (fs.fstatSync(descriptor).isDirectory()) throw new Error('directory fsync is unavailable')
      return originalFsync(descriptor)
    }
    try {
      const { root, guard } = completeFixtureArtifact(Buffer.from('adapter bytes'))
      assert.equal(guard.byteLength, 13)
      revalidateImmutableArtifact(guard)
      closeArtifactGuard(guard)
      closeDirectDirectory(root)
    } finally {
      fs.linkSync = originalLink
      fs.fsyncSync = originalFsync
    }
  })
})
