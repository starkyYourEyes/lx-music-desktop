const fs = require('node:fs')
const path = require('node:path')
const properLockfile = require('proper-lockfile')
const {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
} = require('../storage/directDirectory')

const PRODUCTION_LEASE_OPTIONS = Object.freeze({
  stale: 30_000,
  update: 10_000,
  realpath: false,
  retries: Object.freeze({
    retries: 3,
    factor: 1,
    minTimeout: 250,
    maxTimeout: 250,
    randomize: false,
  }),
})

const leaseMetadata = new WeakMap()

const leaseError = (code, cause) => Object.assign(new Error(code), {
  code,
  ...(cause == null ? {} : { cause }),
})
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left, right) => left.dev == right.dev && left.ino == right.ino
const pathKey = value => {
  const normalized = path.normalize(path.resolve(value))
  return process.platform == 'win32' ? normalized.toLowerCase() : normalized
}
const samePath = (left, right) => pathKey(left) == pathKey(right)
const isMissing = error => error != null && typeof error == 'object' && error.code == 'ENOENT'
const isMigrationLockBasename = basename =>
  basename == '.portable-profile-migration.lock' ||
  (basename.length > '.migration.lock'.length && basename.endsWith('.migration.lock'))

const resolveLeasePaths = input => {
  if (input == null || typeof input != 'object' ||
    typeof input.rootPath != 'string' || typeof input.lockPath != 'string') {
    throw leaseError('migration_lease_invalid')
  }
  let rootPath
  let lockPath
  try {
    rootPath = path.resolve(input.rootPath)
    lockPath = path.resolve(input.lockPath)
  } catch (error) {
    throw leaseError('migration_lease_invalid', error)
  }
  const basename = path.basename(lockPath)
  if (!samePath(path.dirname(lockPath), rootPath) ||
    path.basename(basename) != basename || !isMigrationLockBasename(basename)) {
    throw leaseError('migration_lease_invalid')
  }
  return { rootPath, lockPath }
}

const markCompromised = (state, cause) => {
  if (state.compromised == null) {
    state.compromised = leaseError('migration_lease_compromised', cause)
    try { state.logger?.error?.('Migration lease compromised', cause) } catch {}
  }
  return state.compromised
}

const assertRoot = (state, owned = state.ownedIdentity != null) => {
  try {
    revalidateDirectDirectory(state.rootGuard)
  } catch (error) {
    if (owned) throw markCompromised(state, error)
    throw leaseError('migration_lease_invalid', error)
  }
}

const inspectLockSync = state => {
  const stat = fs.lstatSync(state.lockPath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(state.lockPath).length != 0) {
    throw leaseError('migration_lease_invalid')
  }
  const confirmed = fs.lstatSync(state.lockPath, { bigint: true })
  if (!sameIdentity(identityOf(stat), identityOf(confirmed))) throw leaseError('migration_lease_invalid')
  return confirmed
}

const assertOwnedLock = state => {
  if (state.compromised != null) throw state.compromised
  try {
    assertRoot(state, true)
    const stat = inspectLockSync(state)
    if (state.ownedIdentity == null || !sameIdentity(identityOf(stat), state.ownedIdentity)) {
      throw leaseError('migration_lease_invalid')
    }
    assertRoot(state, true)
    return stat
  } catch (error) {
    if (error === state.compromised) throw error
    throw markCompromised(state, error)
  }
}

const inspectLock = (state, callback) => {
  try {
    assertRoot(state)
  } catch (error) {
    return process.nextTick(callback, error)
  }
  fs.lstat(state.lockPath, { bigint: true }, (error, firstStat) => {
    if (error != null) return callback(error)
    if (firstStat.isSymbolicLink() || !firstStat.isDirectory()) {
      return callback(leaseError('migration_lease_invalid'))
    }
    fs.readdir(state.lockPath, (error, entries) => {
      if (error != null) return callback(error)
      if (entries.length != 0) return callback(leaseError('migration_lease_invalid'))
      fs.lstat(state.lockPath, { bigint: true }, (error, confirmedStat) => {
        if (error != null) return callback(error)
        try {
          assertRoot(state)
          const identity = identityOf(confirmedStat)
          if (confirmedStat.isSymbolicLink() || !confirmedStat.isDirectory() ||
            !sameIdentity(identityOf(firstStat), identity)) {
            throw leaseError('migration_lease_invalid')
          }
          if (state.ownedIdentity != null && !sameIdentity(identity, state.ownedIdentity)) {
            throw markCompromised(state, leaseError('migration_lease_invalid'))
          }
          callback(null, confirmedStat)
        } catch (error) {
          callback(error)
        }
      })
    })
  })
}

const validateAdapterPath = (state, targetPath) => {
  if (typeof targetPath != 'string' || !samePath(targetPath, state.lockPath)) {
    throw state.ownedIdentity == null
      ? leaseError('migration_lease_invalid')
      : markCompromised(state, leaseError('migration_lease_invalid'))
  }
}

const createControlledFs = state => ({
  mkdir(targetPath, callback) {
    try {
      validateAdapterPath(state, targetPath)
      assertRoot(state)
    } catch (error) {
      return process.nextTick(callback, error)
    }
    fs.mkdir(state.lockPath, error => {
      if (error != null) return callback(error)
      try {
        assertRoot(state, true)
        const stat = inspectLockSync(state)
        state.ownedIdentity = Object.freeze(identityOf(stat))
        state.candidateIdentity = null
        state.candidateMtimeMs = null
        assertRoot(state, true)
        callback(null)
      } catch (error) {
        callback(markCompromised(state, error))
      }
    })
  },

  stat(targetPath, callback) {
    try {
      validateAdapterPath(state, targetPath)
    } catch (error) {
      return process.nextTick(callback, error)
    }
    inspectLock(state, (error, stat) => {
      if (error != null) {
        if (state.ownedIdentity != null && isMissing(error)) markCompromised(state, error)
        return callback(error)
      }
      if (state.ownedIdentity == null) {
        state.candidateIdentity = Object.freeze(identityOf(stat))
        state.candidateMtimeMs = stat.mtime.getTime()
      }
      callback(null, stat)
    })
  },

  lstat(targetPath, callback) {
    this.stat(targetPath, callback)
  },

  readdir(targetPath, callback) {
    try {
      validateAdapterPath(state, targetPath)
    } catch (error) {
      return process.nextTick(callback, error)
    }
    inspectLock(state, (error) => callback(error, error == null ? [] : undefined))
  },

  utimes(targetPath, atime, mtime, callback) {
    try {
      validateAdapterPath(state, targetPath)
      assertOwnedLock(state)
    } catch (error) {
      return process.nextTick(callback, error)
    }
    fs.utimes(state.lockPath, atime, mtime, error => {
      if (error != null) return callback(error)
      try {
        assertOwnedLock(state)
        callback(null)
      } catch (error) {
        callback(error)
      }
    })
  },

  rmdir(targetPath, callback) {
    try {
      validateAdapterPath(state, targetPath)
      assertRoot(state)
      const stat = inspectLockSync(state)
      const expectedIdentity = state.ownedIdentity ?? state.candidateIdentity
      if (expectedIdentity == null || !sameIdentity(identityOf(stat), expectedIdentity)) {
        throw state.ownedIdentity == null
          ? leaseError('migration_lease_invalid')
          : markCompromised(state, leaseError('migration_lease_invalid'))
      }
      if (state.ownedIdentity == null &&
        (stat.mtime.getTime() != state.candidateMtimeMs ||
          stat.mtime.getTime() >= Date.now() - PRODUCTION_LEASE_OPTIONS.stale)) {
        throw leaseError('migration_lease_invalid')
      }
      assertRoot(state)
    } catch (error) {
      if (isMissing(error)) {
        if (state.ownedIdentity != null) markCompromised(state, error)
        state.candidateIdentity = null
        state.candidateMtimeMs = null
      }
      return process.nextTick(callback, error)
    }
    fs.rmdir(state.lockPath, error => {
      if (error != null) {
        if (isMissing(error) && state.ownedIdentity != null) markCompromised(state, error)
        return callback(error)
      }
      try {
        assertRoot(state)
        state.removedIdentity = state.ownedIdentity ?? state.candidateIdentity
        state.ownedIdentity = null
        state.candidateIdentity = null
        state.candidateMtimeMs = null
        callback(null)
      } catch (error) {
        callback(error)
      }
    })
  },
})

const acquireMigrationLease = async input => {
  const { rootPath, lockPath } = resolveLeasePaths(input)
  let rootGuard
  try {
    rootGuard = validateDirectDirectory(rootPath)
  } catch (error) {
    throw leaseError('migration_lease_invalid', error)
  }
  const state = {
    rootGuard,
    lockPath,
    logger: input.logger,
    ownedIdentity: null,
    candidateIdentity: null,
    candidateMtimeMs: null,
    removedIdentity: null,
    compromised: null,
  }
  const controlledFs = createControlledFs(state)
  let packageRelease
  try {
    packageRelease = await properLockfile.lock(rootPath, {
      ...PRODUCTION_LEASE_OPTIONS,
      retries: { ...PRODUCTION_LEASE_OPTIONS.retries },
      lockfilePath: lockPath,
      fs: controlledFs,
      onCompromised: error => { markCompromised(state, error) },
    })
    assertOwnedLock(state)
  } catch (error) {
    closeDirectDirectory(rootGuard)
    throw error
  }

  const lease = {
    rootPath,
    rootIdentity: Object.freeze({ ...rootGuard.identity }),
    lockPath,
    lockIdentity: Object.freeze({ ...state.ownedIdentity }),
    assertHeld() {
      if (leaseMetadata.get(lease) == null) throw leaseError('migration_lease_invalid')
      assertOwnedLock(state)
    },
  }
  leaseMetadata.set(lease, { state, packageRelease })
  return Object.freeze(lease)
}

const releaseMigrationLease = async lease => {
  const metadata = leaseMetadata.get(lease)
  if (metadata == null) throw leaseError('migration_lease_invalid')
  let releaseError
  try {
    lease.assertHeld()
    await metadata.packageRelease()
    if (metadata.state.compromised != null) throw metadata.state.compromised
  } catch (error) {
    releaseError = error
  } finally {
    leaseMetadata.delete(lease)
    try {
      closeDirectDirectory(metadata.state.rootGuard)
    } catch (error) {
      if (releaseError == null) releaseError = error
    }
  }
  if (releaseError != null) throw releaseError
}

module.exports = {
  acquireMigrationLease,
  releaseMigrationLease,
}
