const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  acquireMigrationLock,
  assertDirectChild,
  copyDirectoryWithManifestPromotion,
  createDirectoryManifest,
  defaultIsProcessAlive,
  hashManifest,
  isSameNode,
  removeStaleOwnedStages,
  releaseMigrationLock,
  safeLog,
} = require('./guardedDirectoryMigration')

const PORTABLE_PROFILE_LOCK_FILE = '.portable-profile-migration.lock'
const PORTABLE_PROFILE_JOURNAL_FILE = '.portable-profile-migration.json'
const PORTABLE_PROFILE_RECEIPT_FILE = '.portable-profile-migration.pending.json'
const PORTABLE_PROFILE_STAGE_PREFIX = '.portable-profile-migration-stage-'
const JOURNAL_VERSION = 1
const TOKEN_VERSION = 1
const RUN_ID_PATTERN = /^[a-z0-9._-]{1,100}$/i

const assertRunId = (runId, name) => {
  if (typeof runId != 'string' || !RUN_ID_PATTERN.test(runId)) throw new Error(`${name} is invalid`)
  return runId
}

const getPaths = (portableRootPath, fsApi = fs) => {
  const portableRoot = path.resolve(portableRootPath)
  const portableIdentity = fsApi.lstatSync(portableRoot)
  if (portableIdentity.isSymbolicLink() || !portableIdentity.isDirectory()) {
    throw new Error(`Portable root must be a non-link directory: ${portableRoot}`)
  }
  const userDataPath = path.join(portableRoot, 'userData')
  const sourcePath = path.join(userDataPath, 'LxDatas')
  const destinationPath = path.join(portableRoot, 'profile')
  const lockPath = path.join(portableRoot, PORTABLE_PROFILE_LOCK_FILE)
  const journalPath = path.join(portableRoot, PORTABLE_PROFILE_JOURNAL_FILE)
  const receiptPath = path.join(portableRoot, PORTABLE_PROFILE_RECEIPT_FILE)
  const stagePrefix = path.join(portableRoot, PORTABLE_PROFILE_STAGE_PREFIX)
  assertDirectChild(portableRoot, userDataPath)
  assertDirectChild(userDataPath, sourcePath)
  assertDirectChild(portableRoot, destinationPath)
  assertDirectChild(portableRoot, lockPath)
  assertDirectChild(portableRoot, journalPath)
  assertDirectChild(portableRoot, receiptPath)
  assertDirectChild(portableRoot, stagePrefix)
  return {
    portableRoot,
    portableIdentity,
    userDataPath,
    sourcePath,
    destinationPath,
    lockPath,
    journalPath,
    receiptPath,
    stagePrefix,
  }
}

const assertSourceAncestry = (fsApi, paths) => {
  const portableIdentity = fsApi.lstatSync(paths.portableRoot)
  if (portableIdentity.isSymbolicLink() || !portableIdentity.isDirectory() ||
    !isSameNode(paths.portableIdentity, portableIdentity)) {
    throw new Error('Portable root identity changed')
  }
  const userDataIdentity = fsApi.lstatSync(paths.userDataPath)
  if (userDataIdentity.isSymbolicLink() || !userDataIdentity.isDirectory()) {
    throw new Error('Portable userData must be a non-link directory')
  }
  const sourceIdentity = fsApi.lstatSync(paths.sourcePath)
  if (sourceIdentity.isSymbolicLink() || !sourceIdentity.isDirectory()) {
    throw new Error('Portable LxDatas source must be a non-link directory')
  }
  return { userDataIdentity, sourceIdentity }
}

const parseJsonObject = (raw, invalidMessage) => {
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(invalidMessage)
  }
  if (value == null || Array.isArray(value) || Object.getPrototypeOf(value) != Object.prototype) {
    throw new Error(invalidMessage)
  }
  return value
}

const isRecordedNodeIdentity = identity => {
  const keys = Object.keys(identity ?? {}).sort()
  return identity != null && !Array.isArray(identity) && typeof identity == 'object' &&
    keys.join(',') == 'dev,ino' &&
    typeof identity.dev == 'string' && /^\d+$/.test(identity.dev) &&
    typeof identity.ino == 'string' && /^\d+$/.test(identity.ino)
}

const recordNodeIdentity = identity => ({ dev: String(identity.dev), ino: String(identity.ino) })

const recordedIdentityMatches = (recorded, current) =>
  recorded.dev == String(current.dev) && recorded.ino == String(current.ino)

const parseJournal = raw => {
  const journal = parseJsonObject(raw, 'Portable profile migration journal is invalid')
  const keys = Object.keys(journal ?? {}).sort()
  if (
    keys.join(',') != 'acknowledgementRunId,destinationIdentity,destinationManifestHash,preparationRunId,promotionRunId,sourceIdentity,sourceManifestHash,state,userDataIdentity,version' ||
    journal.version != JOURNAL_VERSION ||
    typeof journal.sourceManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(journal.sourceManifestHash) ||
    typeof journal.destinationManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(journal.destinationManifestHash) ||
    !isRecordedNodeIdentity(journal.userDataIdentity) ||
    !isRecordedNodeIdentity(journal.sourceIdentity) ||
    !isRecordedNodeIdentity(journal.destinationIdentity) ||
    !RUN_ID_PATTERN.test(journal.preparationRunId) ||
    !RUN_ID_PATTERN.test(journal.promotionRunId) ||
    !['promoted', 'typed-only-acknowledged'].includes(journal.state) ||
    (journal.state == 'promoted' && journal.acknowledgementRunId !== null) ||
    (journal.state == 'typed-only-acknowledged' && !RUN_ID_PATTERN.test(journal.acknowledgementRunId))
  ) {
    throw new Error('Portable profile migration journal is invalid')
  }
  return journal
}

const parseReceipt = raw => {
  const receipt = parseJsonObject(raw, 'Portable profile migration receipt is invalid')
  const keys = Object.keys(receipt).sort()
  if (
    keys.join(',') != 'destinationIdentity,destinationManifestHash,nonce,preparationRunId,promotionRunId,sourceIdentity,sourceManifestHash,userDataIdentity,version' ||
    receipt.version != JOURNAL_VERSION ||
    typeof receipt.sourceManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(receipt.sourceManifestHash) ||
    typeof receipt.destinationManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(receipt.destinationManifestHash) ||
    !isRecordedNodeIdentity(receipt.userDataIdentity) ||
    !isRecordedNodeIdentity(receipt.sourceIdentity) ||
    !isRecordedNodeIdentity(receipt.destinationIdentity) ||
    !RUN_ID_PATTERN.test(receipt.preparationRunId) ||
    !RUN_ID_PATTERN.test(receipt.promotionRunId) ||
    typeof receipt.nonce != 'string' || !/^[a-f0-9]{32}$/.test(receipt.nonce)
  ) {
    throw new Error('Portable profile migration receipt is invalid')
  }
  return receipt
}

const readJournal = (fsApi, journalPath) => {
  const before = fsApi.lstatSync(journalPath)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Portable profile migration journal must be a regular file')
  }
  const journal = parseJournal(fsApi.readFileSync(journalPath, 'utf8'))
  const after = fsApi.lstatSync(journalPath)
  if (!after.isFile() || after.isSymbolicLink() || !isSameNode(before, after)) {
    throw new Error('Portable profile migration journal changed while inspected')
  }
  return { journal, identity: after }
}

const readReceipt = (fsApi, receiptPath) => {
  const before = fsApi.lstatSync(receiptPath)
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Portable profile migration receipt must be a regular file')
  }
  const raw = fsApi.readFileSync(receiptPath, 'utf8')
  const receipt = parseReceipt(raw)
  const after = fsApi.lstatSync(receiptPath)
  if (!after.isFile() || after.isSymbolicLink() || !isSameNode(before, after)) {
    throw new Error('Portable profile migration receipt changed while inspected')
  }
  return { receipt, identity: after, raw }
}

const removeOwnedFile = (fsApi, candidatePath, identity) => {
  try {
    const current = fsApi.lstatSync(candidatePath)
    if (!current.isFile() || current.isSymbolicLink() || !isSameNode(identity, current)) return
    fsApi.unlinkSync(candidatePath)
  } catch {}
}

const writeAtomicRecord = ({ fsApi, paths, targetPath, value, parse, read, label }) => {
  parse(JSON.stringify(value))
  const candidatePath = `${targetPath}.${crypto.randomBytes(16).toString('hex')}.candidate`
  assertDirectChild(paths.portableRoot, candidatePath)
  let fd
  let identity
  try {
    fd = fsApi.openSync(candidatePath, 'wx')
    identity = fsApi.fstatSync(fd)
    if (!identity.isFile()) throw new Error(`Portable profile ${label} candidate must be a regular file`)
    const serialized = Buffer.from(JSON.stringify(value, null, 2))
    let offset = 0
    while (offset < serialized.length) {
      const written = fsApi.writeSync(fd, serialized, offset, serialized.length - offset)
      if (written <= 0) throw new Error(`Could not write portable profile migration ${label}`)
      offset += written
    }
    fsApi.fsyncSync(fd)
    fsApi.closeSync(fd)
    fd = undefined
    const candidateIdentity = fsApi.lstatSync(candidatePath)
    if (!candidateIdentity.isFile() || candidateIdentity.isSymbolicLink() || !isSameNode(identity, candidateIdentity)) {
      throw new Error(`Portable profile ${label} candidate changed before promotion`)
    }
    if (fsApi.existsSync(targetPath)) read(fsApi, targetPath)
    fsApi.renameSync(candidatePath, targetPath)
  } finally {
    if (fd != null) {
      try { fsApi.closeSync(fd) } catch {}
    }
    if (identity != null) removeOwnedFile(fsApi, candidatePath, identity)
  }
}

const writeJournal = (fsApi, paths, journal) => writeAtomicRecord({
  fsApi,
  paths,
  targetPath: paths.journalPath,
  value: journal,
  parse: parseJournal,
  read: readJournal,
  label: 'journal',
})

const writeReceipt = (fsApi, paths, receipt) => writeAtomicRecord({
  fsApi,
  paths,
  targetPath: paths.receiptPath,
  value: receipt,
  parse: parseReceipt,
  read: readReceipt,
  label: 'receipt',
})

const removeOwnedReceipt = (fsApi, paths, snapshot) => {
  try {
    const current = readReceipt(fsApi, paths.receiptPath)
    if (!isSameNode(snapshot.identity, current.identity) ||
      snapshot.receipt.nonce != current.receipt.nonce || snapshot.raw != current.raw) return false
    fsApi.unlinkSync(paths.receiptPath)
    return true
  } catch {
    return false
  }
}

const hashDirectory = (fsApi, directoryPath) => hashManifest(createDirectoryManifest(fsApi, directoryPath))

const assertRecordedTrees = (fsApi, paths, journal, {
  sourceRequired = true,
  destinationHashRequired = true,
} = {}) => {
  const destinationIdentity = fsApi.lstatSync(paths.destinationPath)
  if (destinationIdentity.isSymbolicLink() || !destinationIdentity.isDirectory()) {
    throw new Error('Portable profile destination must be a non-link directory')
  }
  if (!recordedIdentityMatches(journal.destinationIdentity, destinationIdentity)) {
    throw new Error('Portable profile destination identity does not match the migration record')
  }
  const destinationManifestHash = hashDirectory(fsApi, paths.destinationPath)
  if (destinationHashRequired && destinationManifestHash != journal.destinationManifestHash) {
    throw new Error('Portable profile destination manifest does not match the journal')
  }
  if (!fsApi.existsSync(paths.sourcePath)) {
    if (sourceRequired) throw new Error('Portable profile source is missing before retirement')
    return { destinationIdentity, destinationManifestHash }
  }
  const sourceIdentities = assertSourceAncestry(fsApi, paths)
  if (!recordedIdentityMatches(journal.userDataIdentity, sourceIdentities.userDataIdentity)) {
    throw new Error('Portable profile userData identity does not match the migration record')
  }
  if (!recordedIdentityMatches(journal.sourceIdentity, sourceIdentities.sourceIdentity)) {
    throw new Error('Portable profile source identity does not match the migration record')
  }
  if (hashDirectory(fsApi, paths.sourcePath) != journal.sourceManifestHash) {
    throw new Error('Portable profile source manifest does not match the journal')
  }
  return { destinationIdentity, destinationManifestHash, ...sourceIdentities }
}

const createToken = (paths, journal, startupRunId) => Object.freeze({
  version: TOKEN_VERSION,
  portableRoot: paths.portableRoot,
  promotionRunId: journal.promotionRunId,
  startupRunId,
  destinationIdentity: Object.freeze({ ...journal.destinationIdentity }),
})

const validateToken = token => {
  const keys = Object.keys(token ?? {}).sort()
  if (
    token == null || Array.isArray(token) || typeof token != 'object' ||
    keys.join(',') != 'destinationIdentity,portableRoot,promotionRunId,startupRunId,version' ||
    token.version != TOKEN_VERSION || typeof token.portableRoot != 'string' || !path.isAbsolute(token.portableRoot) ||
    !RUN_ID_PATTERN.test(token.promotionRunId) || !RUN_ID_PATTERN.test(token.startupRunId) ||
    !isRecordedNodeIdentity(token.destinationIdentity)
  ) {
    throw new Error('Portable profile acknowledgement token is invalid')
  }
  return token
}

const receiptMatchesJournal = (receipt, journal) =>
  receipt.promotionRunId == journal.promotionRunId &&
  receipt.sourceManifestHash == journal.sourceManifestHash &&
  receipt.destinationManifestHash == journal.destinationManifestHash &&
  recordedIdentityMatches(receipt.userDataIdentity, journal.userDataIdentity) &&
  recordedIdentityMatches(receipt.sourceIdentity, journal.sourceIdentity) &&
  recordedIdentityMatches(receipt.destinationIdentity, journal.destinationIdentity)

const journalFromReceipt = (receipt, preparationRunId) => ({
  version: JOURNAL_VERSION,
  sourceManifestHash: receipt.sourceManifestHash,
  destinationManifestHash: receipt.destinationManifestHash,
  userDataIdentity: { ...receipt.userDataIdentity },
  sourceIdentity: { ...receipt.sourceIdentity },
  destinationIdentity: { ...receipt.destinationIdentity },
  promotionRunId: receipt.promotionRunId,
  preparationRunId,
  state: 'promoted',
  acknowledgementRunId: null,
})

const preparePortableProfile = ({
  portableRoot,
  runId = crypto.randomUUID(),
  fsApi = fs,
  isProcessAlive = defaultIsProcessAlive,
  logger = console,
}) => {
  assertRunId(runId, 'Portable startup run ID')
  const paths = getPaths(portableRoot, fsApi)
  const createResult = (state, extra = {}) => ({ state, ...paths, ...extra })
  const sourceExists = fsApi.existsSync(paths.sourcePath)
  const journalExists = fsApi.existsSync(paths.journalPath)
  const receiptExists = fsApi.existsSync(paths.receiptPath)
  if (!sourceExists && !journalExists && !receiptExists) return createResult('source-missing')

  const lock = acquireMigrationLock({ fsApi, rootPath: paths.portableRoot, lockPath: paths.lockPath, isProcessAlive, logger })
  if ('error' in lock) return createResult('failed', { error: lock.error })
  try {
    const hasSource = fsApi.existsSync(paths.sourcePath)
    const hasDestination = fsApi.existsSync(paths.destinationPath)
    let journalSnapshot
    let receiptSnapshot
    if (fsApi.existsSync(paths.journalPath)) {
      try {
        journalSnapshot = readJournal(fsApi, paths.journalPath)
      } catch (error) {
        return createResult('failed', { error })
      }
    }
    if (fsApi.existsSync(paths.receiptPath)) {
      try {
        receiptSnapshot = readReceipt(fsApi, paths.receiptPath)
      } catch (error) {
        return createResult('failed', { error })
      }
    }

    if (journalSnapshot != null && receiptSnapshot != null) {
      if (!receiptMatchesJournal(receiptSnapshot.receipt, journalSnapshot.journal) ||
        !removeOwnedReceipt(fsApi, paths, receiptSnapshot)) {
        return createResult('failed', { error: new Error('Portable profile migration receipt conflicts with the journal') })
      }
      receiptSnapshot = undefined
    }

    if (journalSnapshot == null && receiptSnapshot != null) {
      if (hasDestination) {
        try {
          assertRecordedTrees(fsApi, paths, receiptSnapshot.receipt, {
            sourceRequired: true,
            destinationHashRequired: true,
          })
          const promotedJournal = journalFromReceipt(receiptSnapshot.receipt, runId)
          writeJournal(fsApi, paths, promotedJournal)
          removeStaleOwnedStages({ fsApi, rootPath: paths.portableRoot, stagePrefix: paths.stagePrefix, logger })
          if (!removeOwnedReceipt(fsApi, paths, receiptSnapshot)) {
            throw new Error('Portable profile migration receipt could not be retired after journal promotion')
          }
          return createResult('already-promoted', { token: createToken(paths, promotedJournal, runId) })
        } catch (error) {
          return createResult('failed', { error })
        }
      }
      removeStaleOwnedStages({ fsApi, rootPath: paths.portableRoot, stagePrefix: paths.stagePrefix, logger })
      if (fsApi.existsSync(paths.destinationPath) || !removeOwnedReceipt(fsApi, paths, receiptSnapshot)) {
        return createResult('failed', { error: new Error('Portable profile pending promotion could not be reset safely') })
      }
      receiptSnapshot = undefined
    }

    if (hasDestination) {
      if (journalSnapshot == null) {
        const destinationIdentity = fsApi.lstatSync(paths.destinationPath)
        if (destinationIdentity.isSymbolicLink() || !destinationIdentity.isDirectory()) {
          return createResult('failed', { error: new Error('Portable profile destination is invalid') })
        }
        if (fsApi.readdirSync(paths.destinationPath).length != 0) {
          return createResult('failed', { error: new Error('Portable profile destination collision is not journalled') })
        }
        const after = fsApi.lstatSync(paths.destinationPath)
        if (!isSameNode(destinationIdentity, after)) {
          return createResult('failed', { error: new Error('Portable profile destination changed before migration') })
        }
        fsApi.rmdirSync(paths.destinationPath)
      } else {
        try {
          assertRecordedTrees(fsApi, paths, journalSnapshot.journal, {
            sourceRequired: journalSnapshot.journal.state == 'promoted',
            destinationHashRequired: journalSnapshot.journal.state == 'typed-only-acknowledged',
          })
        } catch (error) {
          return createResult('failed', { error })
        }
        if (journalSnapshot.journal.state == 'typed-only-acknowledged') {
          return createResult('already-acknowledged')
        }
        const refreshedJournal = {
          ...journalSnapshot.journal,
          preparationRunId: runId,
        }
        writeJournal(fsApi, paths, refreshedJournal)
        return createResult('already-promoted', {
          token: createToken(paths, refreshedJournal, runId),
        })
      }
    }

    if (!hasSource) {
      return createResult('failed', { error: new Error('Portable profile source is missing before promotion') })
    }
    let promotionSourceIdentities
    try {
      promotionSourceIdentities = assertSourceAncestry(fsApi, paths)
    } catch (error) {
      return createResult('failed', { error })
    }

    const promotionRunId = crypto.randomUUID()
    let receiptSnapshotForPromotion
    const migration = copyDirectoryWithManifestPromotion({
      fsApi,
      rootPath: paths.portableRoot,
      sourcePath: paths.sourcePath,
      destinationPath: paths.destinationPath,
      stagePrefix: paths.stagePrefix,
      runId: promotionRunId,
      logger,
      beforePromotion({ payloadPath, sourceManifestHash, destinationManifestHash }) {
        const payloadIdentity = fsApi.lstatSync(payloadPath)
        if (payloadIdentity.isSymbolicLink() || !payloadIdentity.isDirectory()) {
          throw new Error('Portable profile staged payload must be a non-link directory')
        }
        const receipt = {
          version: JOURNAL_VERSION,
          sourceManifestHash,
          destinationManifestHash,
          userDataIdentity: recordNodeIdentity(promotionSourceIdentities.userDataIdentity),
          sourceIdentity: recordNodeIdentity(promotionSourceIdentities.sourceIdentity),
          destinationIdentity: recordNodeIdentity(payloadIdentity),
          promotionRunId,
          preparationRunId: runId,
          nonce: crypto.randomBytes(16).toString('hex'),
        }
        writeReceipt(fsApi, paths, receipt)
        receiptSnapshotForPromotion = readReceipt(fsApi, paths.receiptPath)
      },
    })
    if (migration.status == 'destination-exists') {
      return createResult('failed', { stagePath: migration.stagePath, error: new Error('Portable profile destination appeared during promotion') })
    }
    if (migration.status == 'failed') {
      return createResult('failed', { stagePath: migration.stagePath, error: migration.error })
    }
    let promotedJournal
    try {
      if (receiptSnapshotForPromotion == null) throw new Error('Portable profile promotion receipt is missing')
      assertRecordedTrees(fsApi, paths, receiptSnapshotForPromotion.receipt, {
        sourceRequired: true,
        destinationHashRequired: true,
      })
      promotedJournal = journalFromReceipt(receiptSnapshotForPromotion.receipt, runId)
      writeJournal(fsApi, paths, promotedJournal)
      if (!removeOwnedReceipt(fsApi, paths, receiptSnapshotForPromotion)) {
        throw new Error('Portable profile migration receipt could not be retired after journal promotion')
      }
    } catch (error) {
      return createResult('failed', { stagePath: migration.stagePath, error })
    }
    safeLog(logger, 'info', `Migrated portable profile to ${paths.destinationPath}`)
    return createResult('promoted', {
      stagePath: migration.stagePath,
      token: createToken(paths, promotedJournal, runId),
    })
  } finally {
    releaseMigrationLock({ fsApi, lock, logger })
  }
}

const acknowledgePortableProfileStartup = async(rawToken, {
  fsApi = fs,
  isProcessAlive = defaultIsProcessAlive,
  logger = console,
} = {}) => {
  const token = validateToken(rawToken)
  const paths = getPaths(token.portableRoot, fsApi)
  const lock = acquireMigrationLock({ fsApi, rootPath: paths.portableRoot, lockPath: paths.lockPath, isProcessAlive, logger })
  if ('error' in lock) throw lock.error
  try {
    const { journal } = readJournal(fsApi, paths.journalPath)
    if (journal.state != 'promoted' ||
      journal.promotionRunId != token.promotionRunId ||
      journal.preparationRunId != token.startupRunId ||
      !recordedIdentityMatches(journal.destinationIdentity, token.destinationIdentity)) {
      throw new Error('Portable profile acknowledgement token does not match the promoted journal')
    }
    const trees = assertRecordedTrees(fsApi, paths, journal, {
      sourceRequired: true,
      destinationHashRequired: false,
    })
    writeJournal(fsApi, paths, {
      ...journal,
      destinationManifestHash: trees.destinationManifestHash,
      state: 'typed-only-acknowledged',
      acknowledgementRunId: token.startupRunId,
    })
    return { state: 'typed-only-acknowledged' }
  } finally {
    releaseMigrationLock({ fsApi, lock, logger })
  }
}

const retireAcknowledgedPortableSource = ({
  portableRoot,
  runId = crypto.randomUUID(),
  fsApi = fs,
  isProcessAlive = defaultIsProcessAlive,
  logger = console,
  beforeSourceRetirement,
}) => {
  assertRunId(runId, 'Portable startup run ID')
  const paths = getPaths(portableRoot, fsApi)
  const createResult = (state, extra = {}) => ({ state, ...paths, ...extra })
  if (!fsApi.existsSync(paths.journalPath)) return createResult('not-acknowledged')
  const lock = acquireMigrationLock({ fsApi, rootPath: paths.portableRoot, lockPath: paths.lockPath, isProcessAlive, logger })
  if ('error' in lock) return createResult('failed', { error: lock.error })
  try {
    let journal
    try {
      journal = readJournal(fsApi, paths.journalPath).journal
    } catch (error) {
      return createResult('failed', { error })
    }
    if (journal.state != 'typed-only-acknowledged') return createResult('not-acknowledged')
    if (journal.acknowledgementRunId == runId) return createResult('same-startup')
    try {
      const identities = assertRecordedTrees(fsApi, paths, journal, { sourceRequired: false })
      if (!fsApi.existsSync(paths.sourcePath)) return createResult('already-retired')
      beforeSourceRetirement?.()
      const portableNow = fsApi.lstatSync(paths.portableRoot)
      const userDataNow = fsApi.lstatSync(paths.userDataPath)
      const sourceNow = fsApi.lstatSync(paths.sourcePath)
      const destinationNow = fsApi.lstatSync(paths.destinationPath)
      if (portableNow.isSymbolicLink() || !portableNow.isDirectory() || !isSameNode(paths.portableIdentity, portableNow) ||
        userDataNow.isSymbolicLink() || !userDataNow.isDirectory() || !isSameNode(identities.userDataIdentity, userDataNow) ||
        sourceNow.isSymbolicLink() || !sourceNow.isDirectory() || !isSameNode(identities.sourceIdentity, sourceNow) ||
        destinationNow.isSymbolicLink() || !destinationNow.isDirectory() ||
        !isSameNode(identities.destinationIdentity, destinationNow) ||
        !recordedIdentityMatches(journal.destinationIdentity, destinationNow) ||
        hashDirectory(fsApi, paths.sourcePath) != journal.sourceManifestHash ||
        hashDirectory(fsApi, paths.destinationPath) != journal.destinationManifestHash) {
        throw new Error('Portable profile ownership or manifests changed before retirement')
      }
      assertDirectChild(paths.userDataPath, paths.sourcePath)
      fsApi.rmSync(paths.sourcePath, { recursive: true, force: false })
      safeLog(logger, 'info', `Retired portable profile source ${paths.sourcePath}`)
      return createResult('retired')
    } catch (error) {
      return createResult('failed', { error })
    }
  } finally {
    releaseMigrationLock({ fsApi, lock, logger })
  }
}

module.exports = {
  PORTABLE_PROFILE_JOURNAL_FILE,
  PORTABLE_PROFILE_LOCK_FILE,
  PORTABLE_PROFILE_RECEIPT_FILE,
  PORTABLE_PROFILE_STAGE_PREFIX,
  acknowledgePortableProfileStartup,
  preparePortableProfile,
  retireAcknowledgedPortableSource,
}
