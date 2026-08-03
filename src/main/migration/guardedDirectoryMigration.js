const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  closeDirectDirectory,
  revalidateDirectDirectory,
  validateDirectDirectory,
} = require('../storage/directDirectory')
const {
  isolateOwnedPath,
  reclaimIsolatedPayload,
} = require('../storage/exclusiveIsolation')

const HASH_BUFFER_SIZE = 64 * 1024
const STAGE_MARKER_FILE = '.guarded-directory-migration-owner.json'
const STAGE_PAYLOAD_BASENAME = 'payload'
const STAGE_ISOLATION_PREFIX = '.guarded-directory-migration-isolation-'

class DirectorySourceChangedError extends Error {}
class UnsupportedDirectoryEntryError extends Error {}

const safeLog = (logger, method, ...args) => {
  try {
    logger[method]?.(...args)
  } catch {}
}

const isSameNode = (left, right) => left.dev == right.dev && left.ino == right.ino
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left, right) => left.dev == right.dev && left.ino == right.ino

const assertDirectChild = (rootPath, candidatePath) => {
  const root = path.resolve(rootPath)
  const candidate = path.resolve(candidatePath)
  if (path.dirname(candidate) != root || candidate == root) {
    throw new Error(`Migration path must be a direct child: ${candidate}`)
  }
  return candidate
}

const callbackResult = (invoke, multiple = false) => new Promise((resolve, reject) => {
  invoke((error, ...values) => {
    if (error != null) reject(error)
    else resolve(multiple ? values : values[0])
  })
})

const lstatAsync = (fsApi, targetPath) => callbackResult(callback => {
  fsApi.lstat(targetPath, { bigint: true }, callback)
})
const fstatAsync = (fsApi, descriptor) => callbackResult(callback => {
  fsApi.fstat(descriptor, { bigint: true }, callback)
})
const readdirAsync = (fsApi, targetPath) => callbackResult(callback => {
  fsApi.readdir(targetPath, callback)
})
const openAsync = (fsApi, targetPath, flags, mode) => callbackResult(callback => {
  if (mode == null) fsApi.open(targetPath, flags, callback)
  else fsApi.open(targetPath, flags, mode, callback)
})
const closeAsync = (fsApi, descriptor) => callbackResult(callback => {
  fsApi.close(descriptor, callback)
})
const mkdirAsync = (fsApi, targetPath, options) => callbackResult(callback => {
  fsApi.mkdir(targetPath, options, callback)
})
const writeFileAsync = (fsApi, targetPath, value, options) => callbackResult(callback => {
  fsApi.writeFile(targetPath, value, options, callback)
})
const readAsync = (fsApi, descriptor, buffer) => callbackResult(callback => {
  fsApi.read(descriptor, buffer, 0, buffer.length, null, callback)
}, true)
const writeAsync = (fsApi, descriptor, buffer, offset, length) => callbackResult(callback => {
  fsApi.write(descriptor, buffer, offset, length, null, callback)
}, true)

const awaitWithLease = async(promise, lease) => {
  const result = await promise
  lease?.assertHeld()
  return result
}

const stableFileHash = async(fsApi, filePath, expectedIdentity, lease) => {
  lease?.assertHeld()
  const descriptor = await openAsync(fsApi, filePath, 'r')
  try {
    lease?.assertHeld()
    const opened = await awaitWithLease(fstatAsync(fsApi, descriptor), lease)
    if (!opened.isFile() || !isSameNode(expectedIdentity, opened)) {
      throw new DirectorySourceChangedError(`Migration file changed before hashing: ${filePath}`)
    }
    const hash = crypto.createHash('sha256')
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
    while (true) {
      lease?.assertHeld()
      const [bytesRead] = await awaitWithLease(readAsync(fsApi, descriptor, buffer), lease)
      if (bytesRead == 0) break
      hash.update(buffer.subarray(0, bytesRead))
    }
    const final = await awaitWithLease(fstatAsync(fsApi, descriptor), lease)
    lease?.assertHeld()
    const linked = await awaitWithLease(lstatAsync(fsApi, filePath), lease)
    if (!final.isFile() || linked.isSymbolicLink() || !linked.isFile() ||
      !isSameNode(opened, final) || !isSameNode(final, linked) || final.size != opened.size) {
      throw new DirectorySourceChangedError(`Migration file changed while hashing: ${filePath}`)
    }
    return hash.digest('hex')
  } finally {
    await closeAsync(fsApi, descriptor)
    lease?.assertHeld()
  }
}

const createDirectoryManifestInternal = async(fsApi, rootPath, lease) => {
  const manifest = []

  const visit = async(entryPath, relativePath) => {
    lease?.assertHeld()
    const before = await awaitWithLease(lstatAsync(fsApi, entryPath), lease)
    if (before.isSymbolicLink()) {
      throw new UnsupportedDirectoryEntryError(`Migration does not support linked data: ${relativePath}`)
    }
    if (before.isDirectory()) {
      manifest.push({ path: relativePath, type: 'directory' })
      lease?.assertHeld()
      const entries = await awaitWithLease(readdirAsync(fsApi, entryPath), lease)
      entries.sort()
      for (const entry of entries) {
        await visit(path.join(entryPath, entry), relativePath == '.' ? entry : path.join(relativePath, entry))
        lease?.assertHeld()
      }
      lease?.assertHeld()
      const after = await awaitWithLease(lstatAsync(fsApi, entryPath), lease)
      if (after.isSymbolicLink() || !after.isDirectory() || !isSameNode(before, after)) {
        throw new DirectorySourceChangedError(`Migration directory changed while inspected: ${relativePath}`)
      }
      return
    }
    if (before.isFile()) {
      manifest.push({
        path: relativePath,
        type: 'file',
        size: Number(before.size),
        hash: await stableFileHash(fsApi, entryPath, before, lease),
      })
      lease?.assertHeld()
      return
    }
    throw new UnsupportedDirectoryEntryError(`Migration does not support this data type: ${relativePath}`)
  }

  await visit(rootPath, '.')
  lease?.assertHeld()
  return manifest
}

const createDirectoryManifest = (fsApi, rootPath) => createDirectoryManifestInternal(fsApi, rootPath)

const manifestEntriesMatch = (entry, candidate) => entry.path == candidate?.path &&
  entry.type == candidate.type && entry.size == candidate.size && entry.hash == candidate.hash

const manifestsMatch = (left, right) => left.length == right.length &&
  left.every((entry, index) => manifestEntriesMatch(entry, right[index]))

const manifestContains = (manifest, expectedEntries) => {
  const entriesByPath = new Map(manifest.map(entry => [entry.path, entry]))
  return expectedEntries.every(entry => manifestEntriesMatch(entry, entriesByPath.get(entry.path)))
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

const verifyStageDirectory = (fsApi, rootGuard, stagePath, identity, expectedChildren) => {
  revalidateDirectDirectory(rootGuard)
  assertDirectChild(rootGuard.path, stagePath)
  const before = fsApi.lstatSync(stagePath, { bigint: true })
  const childrenBefore = fsApi.readdirSync(stagePath).sort()
  const after = fsApi.lstatSync(stagePath, { bigint: true })
  const childrenAfter = fsApi.readdirSync(stagePath).sort()
  if (before.isSymbolicLink() || !before.isDirectory() || !sameIdentity(identityOf(before), identity) ||
    !sameIdentity(identityOf(before), identityOf(after)) ||
    childrenBefore.length != expectedChildren.length ||
    childrenBefore.some((name, index) => name != expectedChildren[index]) ||
    childrenBefore.length != childrenAfter.length ||
    childrenBefore.some((name, index) => name != childrenAfter[index])) {
    throw new Error('Migration stage contents changed')
  }
  revalidateDirectDirectory(rootGuard)
}

const createOwnedStage = async({ fsApi, rootGuard, stagePrefix, runId, lease }) => {
  lease.assertHeld()
  revalidateDirectDirectory(rootGuard)
  lease.assertHeld()
  const stagePath = fsApi.mkdtempSync(stagePrefix)
  revalidateDirectDirectory(rootGuard)
  assertDirectChild(rootGuard.path, stagePath)
  if (!path.basename(stagePath).startsWith(path.basename(stagePrefix))) {
    throw new Error(`Unexpected migration stage path: ${stagePath}`)
  }
  const stageStat = fsApi.lstatSync(stagePath, { bigint: true })
  if (stageStat.isSymbolicLink() || !stageStat.isDirectory()) {
    throw new Error(`Migration stage must be a non-link directory: ${stagePath}`)
  }
  const identity = Object.freeze(identityOf(stageStat))
  verifyStageDirectory(fsApi, rootGuard, stagePath, identity, [])
  const marker = {
    version: 1,
    nonce: crypto.randomBytes(16).toString('hex'),
    runId,
    directoryIdentity: identity,
  }
  const markerRaw = JSON.stringify(marker)
  const markerPath = path.join(stagePath, STAGE_MARKER_FILE)
  lease.assertHeld()
  verifyStageDirectory(fsApi, rootGuard, stagePath, identity, [])
  lease.assertHeld()
  await awaitWithLease(writeFileAsync(fsApi, markerPath, markerRaw, { flag: 'wx' }), lease)
  revalidateDirectDirectory(rootGuard)
  const markerStat = fsApi.lstatSync(markerPath, { bigint: true })
  const stageAfter = fsApi.lstatSync(stagePath, { bigint: true })
  if (markerStat.isSymbolicLink() || !markerStat.isFile() || stageAfter.isSymbolicLink() ||
    !stageAfter.isDirectory() || !sameIdentity(identity, identityOf(stageAfter))) {
    throw new Error('Migration stage ownership changed during creation')
  }
  const ownership = Object.freeze({
    rootGuard,
    stagePath,
    stageBasename: path.basename(stagePath),
    identity,
    markerIdentity: Object.freeze(identityOf(markerStat)),
    markerRaw,
  })
  verifyOwnedStageAtRoot(fsApi, ownership)
  lease.assertHeld()
  return ownership
}

const verifyOwnedStage = (fsApi, ownership, currentPath, expectedChildren) => {
  const directoryBefore = fsApi.lstatSync(currentPath, { bigint: true })
  const markerPath = path.join(currentPath, STAGE_MARKER_FILE)
  const markerBefore = fsApi.lstatSync(markerPath, { bigint: true })
  const childrenBefore = fsApi.readdirSync(currentPath).sort()
  if (directoryBefore.isSymbolicLink() || !directoryBefore.isDirectory() ||
    !sameIdentity(identityOf(directoryBefore), ownership.identity) ||
    markerBefore.isSymbolicLink() || !markerBefore.isFile() ||
    !sameIdentity(identityOf(markerBefore), ownership.markerIdentity)) {
    throw new Error('Migration stage ownership changed')
  }
  const markerRaw = fsApi.readFileSync(markerPath, 'utf8')
  const markerAfter = fsApi.lstatSync(markerPath, { bigint: true })
  const directoryAfter = fsApi.lstatSync(currentPath, { bigint: true })
  const childrenAfter = fsApi.readdirSync(currentPath).sort()
  if (markerRaw != ownership.markerRaw ||
    !sameIdentity(identityOf(markerBefore), identityOf(markerAfter)) ||
    !sameIdentity(identityOf(directoryBefore), identityOf(directoryAfter)) ||
    (expectedChildren != null && (childrenBefore.length != expectedChildren.length ||
      childrenBefore.some((name, index) => name != expectedChildren[index]))) ||
    childrenBefore.length != childrenAfter.length ||
    childrenBefore.some((name, index) => name != childrenAfter[index])) {
    throw new Error('Migration stage ownership changed')
  }
}

const payloadStageChildren = [STAGE_MARKER_FILE, STAGE_PAYLOAD_BASENAME].sort()
const markerStageChildren = [STAGE_MARKER_FILE]

const verifyOwnedPayload = (fsApi, ownership, payloadOwnership, currentStagePath = ownership.stagePath) => {
  verifyOwnedStage(fsApi, ownership, currentStagePath, payloadStageChildren)
  const payloadPath = path.join(currentStagePath, STAGE_PAYLOAD_BASENAME)
  const before = fsApi.lstatSync(payloadPath, { bigint: true })
  if (before.isSymbolicLink() || !before.isDirectory() ||
    !sameIdentity(identityOf(before), payloadOwnership.identity)) {
    throw new Error('Migration payload ownership changed')
  }
  const after = fsApi.lstatSync(payloadPath, { bigint: true })
  verifyOwnedStage(fsApi, ownership, currentStagePath, payloadStageChildren)
  if (!sameIdentity(identityOf(before), identityOf(after))) {
    throw new Error('Migration payload ownership changed')
  }
  return payloadPath
}

const verifyOwnedStageAtRoot = (fsApi, ownership, payloadOwnership) => {
  revalidateDirectDirectory(ownership.rootGuard)
  assertDirectChild(ownership.rootGuard.path, ownership.stagePath)
  if (payloadOwnership == null) {
    verifyOwnedStage(fsApi, ownership, ownership.stagePath, markerStageChildren)
  } else {
    verifyOwnedPayload(fsApi, ownership, payloadOwnership)
  }
  revalidateDirectDirectory(ownership.rootGuard)
}

const createOwnedPayload = ({ fsApi, ownership, lease }) => {
  lease.assertHeld()
  verifyOwnedStageAtRoot(fsApi, ownership)
  const payloadPath = path.join(ownership.stagePath, STAGE_PAYLOAD_BASENAME)
  lease.assertHeld()
  fsApi.mkdirSync(payloadPath)
  revalidateDirectDirectory(ownership.rootGuard)
  const payloadStat = fsApi.lstatSync(payloadPath, { bigint: true })
  if (payloadStat.isSymbolicLink() || !payloadStat.isDirectory()) {
    throw new Error('Migration payload must be a non-link directory')
  }
  const payloadOwnership = Object.freeze({
    identity: Object.freeze(identityOf(payloadStat)),
  })
  verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
  lease.assertHeld()
  return Object.freeze({ ...payloadOwnership, path: payloadPath })
}

const copyFileBounded = async({
  fsApi,
  sourcePath,
  destinationPath,
  lease,
  beforeDestinationMutation,
}) => {
  lease.assertHeld()
  const sourceBefore = await awaitWithLease(lstatAsync(fsApi, sourcePath), lease)
  if (sourceBefore.isSymbolicLink() || !sourceBefore.isFile()) {
    throw new DirectorySourceChangedError(`Migration file changed before copy: ${sourcePath}`)
  }
  lease.assertHeld()
  const sourceDescriptor = await openAsync(fsApi, sourcePath, 'r')
  let destinationDescriptor
  let operationError
  try {
    lease.assertHeld()
    const openedSource = await awaitWithLease(fstatAsync(fsApi, sourceDescriptor), lease)
    if (!openedSource.isFile() || !isSameNode(sourceBefore, openedSource)) {
      throw new DirectorySourceChangedError(`Migration file changed before copy: ${sourcePath}`)
    }
    lease.assertHeld()
    const mode = typeof sourceBefore.mode == 'bigint'
      ? Number(sourceBefore.mode & 0o777n)
      : sourceBefore.mode & 0o777
    beforeDestinationMutation()
    lease.assertHeld()
    destinationDescriptor = await openAsync(fsApi, destinationPath, 'wx', mode)
    lease.assertHeld()
    const buffer = Buffer.allocUnsafe(HASH_BUFFER_SIZE)
    while (true) {
      lease.assertHeld()
      const [bytesRead] = await awaitWithLease(readAsync(fsApi, sourceDescriptor, buffer), lease)
      if (bytesRead == 0) break
      let offset = 0
      while (offset < bytesRead) {
        lease.assertHeld()
        beforeDestinationMutation()
        lease.assertHeld()
        const [bytesWritten] = await awaitWithLease(
          writeAsync(fsApi, destinationDescriptor, buffer, offset, bytesRead - offset),
          lease,
        )
        if (bytesWritten <= 0) throw new Error(`Migration copy made no progress: ${destinationPath}`)
        offset += bytesWritten
      }
    }
    const finalSource = await awaitWithLease(fstatAsync(fsApi, sourceDescriptor), lease)
    lease.assertHeld()
    const linkedSource = await awaitWithLease(lstatAsync(fsApi, sourcePath), lease)
    if (!finalSource.isFile() || linkedSource.isSymbolicLink() || !linkedSource.isFile() ||
      !isSameNode(openedSource, finalSource) || !isSameNode(finalSource, linkedSource) ||
      finalSource.size != openedSource.size) {
      throw new DirectorySourceChangedError(`Migration file changed during copy: ${sourcePath}`)
    }
  } catch (error) {
    operationError = error
  }
  let closeError
  if (destinationDescriptor != null) {
    try { await closeAsync(fsApi, destinationDescriptor) } catch (error) { closeError = error }
  }
  try { await closeAsync(fsApi, sourceDescriptor) } catch (error) { if (closeError == null) closeError = error }
  lease.assertHeld()
  if (operationError != null) throw operationError
  if (closeError != null) throw closeError
}

const copyManifestEntries = async({
  fsApi,
  sourcePath,
  payloadPath,
  manifest,
  lease,
  beforeDestinationMutation,
}) => {
  for (const entry of manifest) {
    if (entry.path == '.') {
      if (entry.type != 'directory') throw new Error('Migration manifest root must be a directory')
      continue
    }
    const destinationEntry = entry.path == '.' ? payloadPath : path.join(payloadPath, entry.path)
    if (entry.type == 'directory') {
      lease.assertHeld()
      beforeDestinationMutation()
      lease.assertHeld()
      await awaitWithLease(mkdirAsync(fsApi, destinationEntry, { recursive: false }), lease)
    } else {
      await copyFileBounded({
        fsApi,
        sourcePath: path.join(sourcePath, entry.path),
        destinationPath: destinationEntry,
        lease,
        beforeDestinationMutation,
      })
    }
    lease.assertHeld()
  }
}

const verifyCleanupStage = async({
  fsApi,
  ownership,
  currentStagePath,
  payloadOwnership,
  trustedPayloadManifest,
  lease,
}) => {
  lease.assertHeld()
  if (payloadOwnership == null) {
    verifyOwnedStage(fsApi, ownership, currentStagePath, markerStageChildren)
  } else {
    const payloadPath = verifyOwnedPayload(fsApi, ownership, payloadOwnership, currentStagePath)
    if (trustedPayloadManifest != null) {
      const currentManifest = await createDirectoryManifestInternal(fsApi, payloadPath, lease)
      lease.assertHeld()
      verifyOwnedPayload(fsApi, ownership, payloadOwnership, currentStagePath)
      if (!manifestsMatch(trustedPayloadManifest, currentManifest)) {
        throw new Error('Migration payload changed before stage cleanup')
      }
    }
  }
  lease.assertHeld()
}

const isolateAndReclaimStage = async({
  fsApi,
  ownership,
  payloadOwnership,
  trustedPayloadManifest,
  lease,
  logger,
}) => {
  try {
    lease.assertHeld()
    const isolation = await isolateOwnedPath({
      source: {
        root: ownership.rootGuard,
        path: ownership.stagePath,
        basename: ownership.stageBasename,
        identity: ownership.identity,
        kind: 'directory',
      },
      prefix: STAGE_ISOLATION_PREFIX,
      onReserved: async() => { lease.assertHeld() },
      verifySource: async isolatedStagePath => {
        await verifyCleanupStage({
          fsApi,
          ownership,
          currentStagePath: isolatedStagePath,
          payloadOwnership,
          trustedPayloadManifest,
          lease,
        })
      },
    })
    lease.assertHeld()
    if (isolation.state == 'conflict') return { reclaimed: false, error: isolation.error }
    if (isolation.state != 'isolated') {
      return { reclaimed: false, error: new Error('Migration stage disappeared before isolation') }
    }
    lease.assertHeld()
    const reclamation = await reclaimIsolatedPayload({
      guard: isolation.guard,
      verifyPayload: async isolatedStagePath => {
        await verifyCleanupStage({
          fsApi,
          ownership,
          currentStagePath: isolatedStagePath,
          payloadOwnership,
          trustedPayloadManifest,
          lease,
        })
      },
    })
    lease.assertHeld()
    if (reclamation.state == 'retained') return { reclaimed: false, error: reclamation.error }
    return { reclaimed: true }
  } catch (error) {
    safeLog(logger, 'warn', 'Could not isolate guarded migration stage', error)
    return { reclaimed: false, error }
  }
}

const copyDirectoryWithManifestPromotion = async({
  fsApi = fs,
  rootPath,
  sourcePath,
  destinationPath,
  stagePrefix,
  runId,
  lease,
  logger = console,
  writePayloadMarker,
  beforePromotion,
}) => {
  assertDirectChild(rootPath, destinationPath)
  assertDirectChild(rootPath, stagePrefix)
  if (lease == null || typeof lease.assertHeld != 'function') throw new Error('Migration lease is required')
  let rootGuard
  let ownership
  let payloadOwnership
  let trustedPayloadManifest
  let payloadPromoted = false
  let result
  try {
    lease.assertHeld()
    rootGuard = validateDirectDirectory(rootPath, { fsApi })
    revalidateDirectDirectory(rootGuard)
    let sourceManifest
    try {
      lease.assertHeld()
      sourceManifest = await createDirectoryManifestInternal(fsApi, sourcePath, lease)
      lease.assertHeld()
    } catch (error) {
      if (error instanceof UnsupportedDirectoryEntryError || error instanceof DirectorySourceChangedError) throw error
      throw new DirectorySourceChangedError(`Migration source changed during initial scan: ${error.message}`)
    }
    revalidateDirectDirectory(rootGuard)
    lease.assertHeld()
    ownership = await createOwnedStage({ fsApi, rootGuard, stagePrefix, runId, lease })
    lease.assertHeld()
    payloadOwnership = createOwnedPayload({ fsApi, ownership, lease })
    const payloadPath = payloadOwnership.path
    const beforePayloadMutation = () => verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    await copyManifestEntries({
      fsApi,
      sourcePath,
      payloadPath,
      manifest: sourceManifest,
      lease,
      beforeDestinationMutation: beforePayloadMutation,
    })
    lease.assertHeld()
    verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    const copiedManifest = await createDirectoryManifestInternal(fsApi, payloadPath, lease)
    lease.assertHeld()
    verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    trustedPayloadManifest = copiedManifest
    let finalSourceManifest
    try {
      lease.assertHeld()
      finalSourceManifest = await createDirectoryManifestInternal(fsApi, sourcePath, lease)
      lease.assertHeld()
    } catch (error) {
      throw new DirectorySourceChangedError(`Migration source changed during copy: ${error.message}`)
    }
    if (!manifestsMatch(sourceManifest, finalSourceManifest)) {
      throw new DirectorySourceChangedError('Migration source changed during copy; close other app instances and retry')
    }
    if (!manifestsMatch(sourceManifest, copiedManifest)) {
      throw new Error('Migration verification failed: recursive manifests do not match')
    }
    lease.assertHeld()
    beforePayloadMutation()
    lease.assertHeld()
    await writePayloadMarker?.({ payloadPath, sourceManifest, copiedManifest })
    lease.assertHeld()
    verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    const markedPayloadManifest = await createDirectoryManifestInternal(fsApi, payloadPath, lease)
    lease.assertHeld()
    verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    if (!manifestContains(markedPayloadManifest, copiedManifest)) {
      throw new Error('Migration payload changed while writing its marker')
    }
    trustedPayloadManifest = markedPayloadManifest
    const sourceManifestHash = hashManifest(sourceManifest)
    const destinationManifestHash = hashManifest(copiedManifest)
    lease.assertHeld()
    await beforePromotion?.({
      payloadPath,
      sourceManifest,
      destinationManifest: copiedManifest,
      sourceManifestHash,
      destinationManifestHash,
    })
    lease.assertHeld()
    verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    const promotionManifest = await createDirectoryManifestInternal(fsApi, payloadPath, lease)
    lease.assertHeld()
    verifyOwnedStageAtRoot(fsApi, ownership, payloadOwnership)
    if (!manifestsMatch(markedPayloadManifest, promotionManifest)) {
      throw new Error('Migration payload changed before promotion')
    }
    trustedPayloadManifest = promotionManifest
    if (fsApi.existsSync(destinationPath)) {
      result = { status: 'destination-exists', stagePath: ownership.stagePath }
    } else {
      lease.assertHeld()
      beforePayloadMutation()
      lease.assertHeld()
      fsApi.renameSync(payloadPath, destinationPath)
      payloadPromoted = true
      result = {
        status: 'promoted',
        stagePath: ownership.stagePath,
        sourceManifest,
        destinationManifest: copiedManifest,
        sourceManifestHash,
        destinationManifestHash,
      }
    }
  } catch (error) {
    result = { status: 'failed', stagePath: ownership?.stagePath, error }
  }

  if (ownership != null) {
    const cleanup = await isolateAndReclaimStage({
      fsApi,
      ownership,
      payloadOwnership: payloadPromoted ? undefined : payloadOwnership,
      trustedPayloadManifest: payloadPromoted ? undefined : trustedPayloadManifest,
      lease,
      logger,
    })
    if (!cleanup.reclaimed) {
      result = { status: 'failed', stagePath: ownership.stagePath, error: cleanup.error }
    }
  }
  if (rootGuard != null) {
    try {
      closeDirectDirectory(rootGuard)
    } catch (error) {
      result = { status: 'failed', stagePath: ownership?.stagePath, error }
    }
  }
  return result
}

module.exports = {
  DirectorySourceChangedError,
  UnsupportedDirectoryEntryError,
  STAGE_MARKER_FILE,
  assertDirectChild,
  copyDirectoryWithManifestPromotion,
  createDirectoryManifest,
  ensureDirectory,
  getUsableDirectory,
  hashManifest,
  isSameNode,
  manifestsMatch,
  safeLog,
}
