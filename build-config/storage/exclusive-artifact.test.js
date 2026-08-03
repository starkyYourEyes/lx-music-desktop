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
