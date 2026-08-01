const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const LOCK_VERSION = 1
const LOCK_ACQUIRE_ATTEMPTS = 3
const HASH_BUFFER_SIZE = 64 * 1024
const STAGE_MARKER_FILE = '.guarded-directory-migration-owner.json'

class DirectorySourceChangedError extends Error {}
class UnsupportedDirectoryEntryError extends Error {}

const safeLog = (logger, method, ...args) => {
  try {
    logger[method]?.(...args)
  } catch {}
}

const isSameNode = (left, right) => left.dev == right.dev && left.ino == right.ino

const assertDirectChild = (rootPath, candidatePath) => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (path.dirname(candidate) != root || candidate == root) {
    throw new Error(`Migration path must be a direct child: ${candidate}`)
  }
  return candidate
}

const closeDescriptor = (fsApi, fd, logger) => {
  try {
    fsApi.closeSync(fd)
  } catch (error) {
    safeLog(logger, 'warn', 'Could not close migration file', error)
  }
}

const parseLockOwner = raw => {
  let owner
  try {
    owner = JSON.parse(raw)
  } catch {
    throw new Error('Migration lock metadata is invalid')
  }
  if (
    owner?.version != LOCK_VERSION ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    typeof owner.nonce != 'string' ||
    !/^[a-f0-9]{32}$/.test(owner.nonce) ||
    typeof owner.createdAt != 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt))
  ) {
    throw new Error('Migration lock metadata is invalid')
  }
  return owner
}

const readLockSnapshot = (fsApi, lockPath) => {
  const before = fsApi.lstatSync(lockPath)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Migration lock must be a regular file: ${lockPath}`)
  }
  const raw = fsApi.readFileSync(lockPath, 'utf8')
  const after = fsApi.lstatSync(lockPath)
  if (!isSameNode(before, after)) throw new Error('Migration lock changed while it was inspected')
  return { identity: after, owner: parseLockOwner(raw), raw }
}

const removeOwnedLockFile = (fsApi, lockPath, expectedIdentity, expectedOwner, logger) => {
  try {
    const snapshot = readLockSnapshot(fsApi, lockPath)
    if (!isSameNode(expectedIdentity, snapshot.identity) || snapshot.owner.nonce != expectedOwner.nonce) return false
    fsApi.unlinkSync(lockPath)
    return true
  } catch (error) {
    if (error?.code != 'ENOENT') safeLog(logger, 'warn', `Could not remove owned migration file: ${lockPath}`, error)
    return false
  }
}

const removeOwnedCandidate = (fsApi, candidatePath, expectedIdentity, logger) => {
  try {
    const identity = fsApi.lstatSync(candidatePath)
    if (identity.isSymbolicLink() || !identity.isFile() || !isSameNode(expectedIdentity, identity)) return false
    fsApi.unlinkSync(candidatePath)
    return true
  } catch (error) {
    if (error?.code != 'ENOENT') safeLog(logger, 'warn', `Could not remove owned migration file: ${candidatePath}`, error)
    return false
  }
}

const defaultIsProcessAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code != 'ESRCH'
  }
}

const reclaimDeadLock = (fsApi, lockPath, isProcessAlive, logger) => {
  let first
  try {
    first = readLockSnapshot(fsApi, lockPath)
  } catch (error) {
    return { reclaimed: false, error }
  }

  try {
    if (isProcessAlive(first.owner.pid)) {
      return { reclaimed: false, error: new Error(`Migration is active in process ${first.owner.pid}`) }
    }
  } catch (error) {
    return { reclaimed: false, error: new Error(`Could not verify migration lock owner: ${error.message}`) }
  }

  try {
    const current = readLockSnapshot(fsApi, lockPath)
    if (!isSameNode(first.identity, current.identity) || first.raw != current.raw) {
      return { reclaimed: false, error: new Error('Migration lock changed before stale-lock recovery') }
    }
    // The app lock and this file lock serialize cooperating processes. Node has
    // no portable unlink-by-handle primitive for arbitrary filesystem writers.
    fsApi.unlinkSync(lockPath)
    const candidatePath = `${lockPath}.${first.owner.nonce}.candidate`
    removeOwnedLockFile(fsApi, candidatePath, first.identity, first.owner, logger)
    safeLog(logger, 'info', `Recovered stale migration lock from process ${first.owner.pid}`)
    return { reclaimed: true }
  } catch (error) {
    if (error?.code == 'ENOENT') return { reclaimed: true }
    return { reclaimed: false, error }
  }
}

const writeAll = (fsApi, fd, value) => {
  const data = Buffer.from(value)
  let offset = 0
  while (offset < data.length) {
    const written = fsApi.writeSync(fd, data, offset, data.length - offset)
    if (written <= 0) throw new Error('Could not write migration lock metadata')
    offset += written
  }
}

const acquireMigrationLock = ({
  fsApi = fs,
  rootPath,
  lockPath,
  isProcessAlive = defaultIsProcessAlive,
  logger = console,
}) => {
  assertDirectChild(rootPath, lockPath)
  let lastError = new Error('Could not acquire migration lock')

  for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt++) {
    const owner = {
      version: LOCK_VERSION,
      pid: process.pid,
      nonce: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date().toISOString(),
    }
    const candidatePath = `${lockPath}.${owner.nonce}.candidate`
    assertDirectChild(rootPath, candidatePath)
    let fd
    let identity
    let metadataWritten = false
    let linkAttempted = false

    try {
      fd = fsApi.openSync(candidatePath, 'wx')
      identity = fsApi.fstatSync(fd)
      if (!identity.isFile()) throw new Error('Migration lock candidate must be a regular file')
      writeAll(fsApi, fd, JSON.stringify(owner))
      metadataWritten = true
      fsApi.fsyncSync(fd)
      linkAttempted = true
      fsApi.linkSync(candidatePath, lockPath)
      removeOwnedLockFile(fsApi, candidatePath, identity, owner, logger)
      return { fd, identity, lockPath, owner }
    } catch (error) {
      lastError = error
      if (identity != null) {
        if (metadataWritten) removeOwnedLockFile(fsApi, candidatePath, identity, owner, logger)
        else removeOwnedCandidate(fsApi, candidatePath, identity, logger)
      }
      if (fd != null) closeDescriptor(fsApi, fd, logger)

      if (!linkAttempted && error?.code == 'EEXIST') continue
      if (!linkAttempted || error?.code != 'EEXIST') break
      const recovery = reclaimDeadLock(fsApi, lockPath, isProcessAlive, logger)
      if (!recovery.reclaimed) return { error: recovery.error ?? error }
    }
  }
  return { error: lastError }
}

const releaseMigrationLock = ({ fsApi = fs, lock, logger = console }) => {
  removeOwnedLockFile(fsApi, lock.lockPath, lock.identity, lock.owner, logger)
  closeDescriptor(fsApi, lock.fd, logger)
}

const stableFileHash = (fsApi, filePath, expectedIdentity) => {
  const hash = crypto.createHash('sha256')
  const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
  const fd = fsApi.openSync(filePath, 'r')
  try {
    const opened = fsApi.fstatSync(fd)
    if (!opened.isFile() || !isSameNode(expectedIdentity, opened)) {
      throw new DirectorySourceChangedError(`Migration file changed before hashing: ${filePath}`)
    }
    let bytesRead
    while ((bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead))
    }
    const final = fsApi.fstatSync(fd)
    const linked = fsApi.lstatSync(filePath)
    if (!final.isFile() || linked.isSymbolicLink() || !linked.isFile() ||
      !isSameNode(opened, final) || !isSameNode(final, linked) || final.size != opened.size) {
      throw new DirectorySourceChangedError(`Migration file changed while hashing: ${filePath}`)
    }
    return hash.digest('hex')
  } finally {
    fsApi.closeSync(fd)
  }
}

const createDirectoryManifest = (fsApi, rootPath) => {
  const manifest = []

  const visit = (entryPath, relativePath) => {
    const before = fsApi.lstatSync(entryPath)
    if (before.isSymbolicLink()) {
      throw new UnsupportedDirectoryEntryError(`Migration does not support linked data: ${relativePath}`)
    }
    if (before.isDirectory()) {
      manifest.push({ path: relativePath, type: 'directory' })
      const entries = fsApi.readdirSync(entryPath).sort()
      for (const entry of entries) {
        visit(path.join(entryPath, entry), relativePath == '.' ? entry : path.join(relativePath, entry))
      }
      const after = fsApi.lstatSync(entryPath)
      if (after.isSymbolicLink() || !after.isDirectory() || !isSameNode(before, after)) {
        throw new DirectorySourceChangedError(`Migration directory changed while inspected: ${relativePath}`)
      }
      return
    }
    if (before.isFile()) {
      manifest.push({
        path: relativePath,
        type: 'file',
        size: before.size,
        hash: stableFileHash(fsApi, entryPath, before),
      })
      return
    }
    throw new UnsupportedDirectoryEntryError(`Migration does not support this data type: ${relativePath}`)
  }

  visit(rootPath, '.')
  return manifest
}

const manifestsMatch = (left, right) => {
  if (left.length != right.length) return false
  return left.every((entry, index) => {
    const candidate = right[index]
    return entry.path == candidate.path && entry.type == candidate.type &&
      entry.size == candidate.size && entry.hash == candidate.hash
  })
}

const hashManifest = manifest => crypto.createHash('sha256').update(JSON.stringify(manifest)).digest('hex')

const getUsableDirectory = (fsApi, directoryPath) => {
  try {
    const stats = fsApi.lstatSync(directoryPath)
    return stats.isDirectory() && !stats.isSymbolicLink()
  } catch {
    return false
  }
}

const ensureDirectory = (fsApi, directoryPath, logger = console) => {
  try {
    fsApi.mkdirSync(directoryPath)
  } catch (error) {
    if (error?.code != 'EEXIST') safeLog(logger, 'error', `Could not create migration directory: ${directoryPath}`, error)
  }
  return getUsableDirectory(fsApi, directoryPath)
}

const serializeIdentity = identity => ({ dev: String(identity.dev), ino: String(identity.ino) })

const createOwnedStage = ({ fsApi, rootPath, stagePrefix, runId }) => {
  assertDirectChild(rootPath, stagePrefix)
  const stagePath = fsApi.mkdtempSync(stagePrefix)
  assertDirectChild(rootPath, stagePath)
  if (!path.resolve(stagePath).startsWith(path.resolve(stagePrefix))) {
    throw new Error(`Unexpected migration stage path: ${stagePath}`)
  }
  const identity = fsApi.lstatSync(stagePath)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`Migration stage must be a non-link directory: ${stagePath}`)
  }
  const markerPath = path.join(stagePath, STAGE_MARKER_FILE)
  const nonce = crypto.randomBytes(16).toString('hex')
  const marker = {
    version: 1,
    nonce,
    runId,
    directoryIdentity: serializeIdentity(identity),
  }
  fsApi.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx' })
  const markerIdentity = fsApi.lstatSync(markerPath)
  if (markerIdentity.isSymbolicLink() || !markerIdentity.isFile()) {
    throw new Error(`Migration stage marker must be a regular file: ${markerPath}`)
  }
  return { rootPath, stagePath, identity, markerPath, markerIdentity, marker }
}

const parseStageMarker = raw => {
  let marker
  try {
    marker = JSON.parse(raw)
  } catch {
    throw new Error('Migration stage marker is invalid')
  }
  if (marker?.version != 1 || typeof marker.nonce != 'string' || !/^[a-f0-9]{32}$/.test(marker.nonce) ||
    typeof marker.runId != 'string' || marker.runId.length == 0 ||
    typeof marker.directoryIdentity?.dev != 'string' || typeof marker.directoryIdentity?.ino != 'string') {
    throw new Error('Migration stage marker is invalid')
  }
  return marker
}

const inspectOwnedStage = (fsApi, rootPath, stagePath) => {
  assertDirectChild(rootPath, stagePath)
  const identity = fsApi.lstatSync(stagePath)
  if (identity.isSymbolicLink() || !identity.isDirectory()) throw new Error('Migration stage is not an owned directory')
  const markerPath = path.join(stagePath, STAGE_MARKER_FILE)
  const markerBefore = fsApi.lstatSync(markerPath)
  if (markerBefore.isSymbolicLink() || !markerBefore.isFile()) throw new Error('Migration stage marker is not a regular file')
  const marker = parseStageMarker(fsApi.readFileSync(markerPath, 'utf8'))
  const markerAfter = fsApi.lstatSync(markerPath)
  const directoryAfter = fsApi.lstatSync(stagePath)
  if (!isSameNode(markerBefore, markerAfter) || directoryAfter.isSymbolicLink() || !directoryAfter.isDirectory() ||
    !isSameNode(identity, directoryAfter) || marker.directoryIdentity.dev != String(identity.dev) ||
    marker.directoryIdentity.ino != String(identity.ino)) {
    throw new Error('Migration stage ownership changed while inspected')
  }
  return { rootPath, stagePath, identity: directoryAfter, markerPath, markerIdentity: markerAfter, marker }
}

const removeOwnedStage = ({
  fsApi,
  ownership,
  logger = console,
  warning = 'Could not verify owned migration stage',
}) => {
  if (ownership == null) return false
  try {
    const current = inspectOwnedStage(fsApi, ownership.rootPath, ownership.stagePath)
    if (!isSameNode(ownership.identity, current.identity) ||
      !isSameNode(ownership.markerIdentity, current.markerIdentity) ||
      ownership.marker.nonce != current.marker.nonce) {
      throw new Error('Migration stage ownership changed')
    }
    fsApi.rmSync(ownership.stagePath, { recursive: true, force: false })
    return true
  } catch (error) {
    safeLog(logger, 'warn', warning, error)
    return false
  }
}

const removeStaleOwnedStages = ({ fsApi, rootPath, stagePrefix, logger = console }) => {
  assertDirectChild(rootPath, stagePrefix)
  const prefixName = path.basename(stagePrefix)
  for (const name of fsApi.readdirSync(rootPath).sort()) {
    if (!name.startsWith(prefixName) || name == prefixName) continue
    const stagePath = path.join(rootPath, name)
    try {
      const ownership = inspectOwnedStage(fsApi, rootPath, stagePath)
      removeOwnedStage({ fsApi, ownership, logger })
    } catch (error) {
      if (error?.code != 'ENOENT') safeLog(logger, 'warn', `Could not verify stale migration stage: ${stagePath}`, error)
    }
  }
}

const copyDirectoryWithManifestPromotion = ({
  fsApi = fs,
  rootPath,
  sourcePath,
  destinationPath,
  stagePrefix,
  runId,
  logger = console,
  writePayloadMarker,
  beforePromotion,
  cleanupWarning,
}) => {
  assertDirectChild(rootPath, destinationPath)
  assertDirectChild(rootPath, stagePrefix)
  removeStaleOwnedStages({ fsApi, rootPath, stagePrefix, logger })
  let ownership
  try {
    let sourceManifest
    try {
      sourceManifest = createDirectoryManifest(fsApi, sourcePath)
    } catch (error) {
      if (error instanceof UnsupportedDirectoryEntryError || error instanceof DirectorySourceChangedError) throw error
      throw new DirectorySourceChangedError(`Migration source changed during initial scan: ${error.message}`)
    }
    ownership = createOwnedStage({ fsApi, rootPath, stagePrefix, runId })
    const payloadPath = path.join(ownership.stagePath, 'payload')
    fsApi.cpSync(sourcePath, payloadPath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
    })
    const copiedManifest = createDirectoryManifest(fsApi, payloadPath)
    let finalSourceManifest
    try {
      finalSourceManifest = createDirectoryManifest(fsApi, sourcePath)
    } catch (error) {
      throw new DirectorySourceChangedError(`Migration source changed during copy: ${error.message}`)
    }
    if (!manifestsMatch(sourceManifest, finalSourceManifest)) {
      throw new DirectorySourceChangedError('Migration source changed during copy; close other app instances and retry')
    }
    if (!manifestsMatch(sourceManifest, copiedManifest)) {
      throw new Error('Migration verification failed: recursive manifests do not match')
    }
    writePayloadMarker?.({ payloadPath, sourceManifest, copiedManifest })
    beforePromotion?.({
      payloadPath,
      sourceManifest,
      destinationManifest: copiedManifest,
      sourceManifestHash: hashManifest(sourceManifest),
      destinationManifestHash: hashManifest(copiedManifest),
    })
    if (fsApi.existsSync(destinationPath)) {
      return { status: 'destination-exists', stagePath: ownership.stagePath }
    }
    // The process lock excludes cooperating creators. Node has no portable
    // RENAME_NOREPLACE primitive for arbitrary writers.
    fsApi.renameSync(payloadPath, destinationPath)
    return {
      status: 'promoted',
      stagePath: ownership.stagePath,
      sourceManifest,
      destinationManifest: copiedManifest,
      sourceManifestHash: hashManifest(sourceManifest),
      destinationManifestHash: hashManifest(copiedManifest),
    }
  } catch (error) {
    return { status: 'failed', stagePath: ownership?.stagePath, error }
  } finally {
    removeOwnedStage({ fsApi, ownership, logger, warning: cleanupWarning })
  }
}

module.exports = {
  DirectorySourceChangedError,
  UnsupportedDirectoryEntryError,
  STAGE_MARKER_FILE,
  acquireMigrationLock,
  assertDirectChild,
  copyDirectoryWithManifestPromotion,
  createDirectoryManifest,
  defaultIsProcessAlive,
  ensureDirectory,
  getUsableDirectory,
  hashManifest,
  isSameNode,
  manifestsMatch,
  releaseMigrationLock,
  removeStaleOwnedStages,
  safeLog,
}
