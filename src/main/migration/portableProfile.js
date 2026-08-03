const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  assertDirectChild,
  copyDirectoryWithManifestPromotion,
  createDirectoryManifest,
  hashManifest,
  isSameNode,
  safeLog,
} = require('./guardedDirectoryMigration')
const { acquireMigrationLease, releaseMigrationLease } = require('./migrationLease')
const {
  isolateOwnedPath,
  reopenExclusiveIsolation,
  reserveExclusiveIsolation,
} = require('../storage/exclusiveIsolation')
const { closeDirectDirectory, validateDirectDirectory } = require('../storage/directDirectory')

const PORTABLE_PROFILE_LOCK_FILE = '.portable-profile-migration.lock'
const PORTABLE_PROFILE_JOURNAL_FILE = '.portable-profile-migration.json'
const PORTABLE_PROFILE_RECEIPT_FILE = '.portable-profile-migration.pending.json'
const PORTABLE_PROFILE_STAGE_PREFIX = '.portable-profile-migration-stage-'
const PORTABLE_PROFILE_RETIREMENT_PREFIX = '.lx-portable-retired-'
const PORTABLE_PROFILE_RETIREMENT_PATTERN = /^\.lx-portable-retired-[a-f0-9]{32}$/
const JOURNAL_VERSION = 2
const RECEIPT_VERSION = 1
const TOKEN_VERSION = 1
const RUN_ID_PATTERN = /^[a-z0-9._-]{1,100}$/i
const LEGACY_JOURNAL_V1_KEYS = 'acknowledgementRunId,destinationIdentity,destinationManifestHash,preparationRunId,promotionRunId,sourceManifestHash,state,version'
const IDENTITY_BOUND_JOURNAL_V1_KEYS = 'acknowledgementRunId,destinationIdentity,destinationManifestHash,preparationRunId,promotionRunId,sourceIdentity,sourceManifestHash,state,userDataIdentity,version'
const JOURNAL_V2_KEYS = 'acknowledgementRunId,destinationIdentity,destinationManifestHash,preparationRunId,promotionRunId,retirement,sourceIdentity,sourceManifestHash,state,userDataIdentity,version'
const RETIREMENT_EVIDENCE_V2_KEYS = 'destinationManifestHash,isolationBasename,isolationIdentity,sourceIdentity,sourceManifestHash'
const LEGACY_RECEIPT_KEYS = 'destinationIdentity,destinationManifestHash,nonce,preparationRunId,promotionRunId,sourceManifestHash,version'
const IDENTITY_BOUND_RECEIPT_KEYS = 'destinationIdentity,destinationManifestHash,nonce,preparationRunId,promotionRunId,sourceIdentity,sourceManifestHash,userDataIdentity,version'
const RETIREMENT_STATES = ['retirement-intent', 'retirement-isolated', 'retired', 'retired-retained']

const assertRunId = (runId, name) => {
  if (typeof runId != 'string' || !RUN_ID_PATTERN.test(runId)) throw new Error(`${name} is invalid`)
  return runId
}

const getPaths = (portableRootPath, fsApi = fs) => {
  const portableRoot = path.resolve(portableRootPath)
  const portableIdentity = fsApi.lstatSync(portableRoot, { bigint: true })
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

const assertUserDataAncestry = (fsApi, paths) => {
  const portableIdentity = fsApi.lstatSync(paths.portableRoot, { bigint: true })
  if (portableIdentity.isSymbolicLink() || !portableIdentity.isDirectory() ||
    !isSameNode(paths.portableIdentity, portableIdentity)) {
    throw new Error('Portable root identity changed')
  }
  const userDataIdentity = fsApi.lstatSync(paths.userDataPath, { bigint: true })
  if (userDataIdentity.isSymbolicLink() || !userDataIdentity.isDirectory()) {
    throw new Error('Portable userData must be a non-link directory')
  }
  return userDataIdentity
}

const assertSourceAncestry = (fsApi, paths) => {
  const userDataIdentity = assertUserDataAncestry(fsApi, paths)
  const sourceIdentity = fsApi.lstatSync(paths.sourcePath, { bigint: true })
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

const hasSourceIdentityBinding = record =>
  isRecordedNodeIdentity(record.userDataIdentity) && isRecordedNodeIdentity(record.sourceIdentity)

const sameRecordedIdentity = (left, right) =>
  isRecordedNodeIdentity(left) && isRecordedNodeIdentity(right) && left.dev == right.dev && left.ino == right.ino

const isDirectBasename = basename => typeof basename == 'string' && basename.length > 0 &&
  basename != '.' && basename != '..' && path.basename(basename) == basename

const isRetirementEvidenceV2 = (retirement, journal) => {
  if (retirement == null || Array.isArray(retirement) || typeof retirement != 'object' ||
    Object.keys(retirement).sort().join(',') != RETIREMENT_EVIDENCE_V2_KEYS ||
    !isDirectBasename(retirement.isolationBasename) ||
    !PORTABLE_PROFILE_RETIREMENT_PATTERN.test(retirement.isolationBasename) ||
    !isRecordedNodeIdentity(retirement.isolationIdentity) ||
    !sameRecordedIdentity(retirement.sourceIdentity, journal.sourceIdentity) ||
    retirement.sourceManifestHash != journal.sourceManifestHash ||
    retirement.destinationManifestHash != journal.destinationManifestHash) return false
  return true
}

const parseJournal = raw => {
  const journal = parseJsonObject(raw, 'Portable profile migration journal is invalid')
  const keys = Object.keys(journal ?? {}).sort().join(',')
  const commonValid =
    typeof journal.sourceManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(journal.sourceManifestHash) ||
    typeof journal.destinationManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(journal.destinationManifestHash) ||
    !isRecordedNodeIdentity(journal.destinationIdentity) ||
    !RUN_ID_PATTERN.test(journal.preparationRunId) ||
    !RUN_ID_PATTERN.test(journal.promotionRunId)
  if (commonValid) throw new Error('Portable profile migration journal is invalid')

  if (journal.version == 1) {
    const hasLegacySchema = keys == LEGACY_JOURNAL_V1_KEYS
    const hasIdentityBoundSchema = keys == IDENTITY_BOUND_JOURNAL_V1_KEYS
    if ((!hasLegacySchema && !hasIdentityBoundSchema) ||
      (hasIdentityBoundSchema && !hasSourceIdentityBinding(journal)) ||
      !['promoted', 'typed-only-acknowledged'].includes(journal.state) ||
      (journal.state == 'promoted' && journal.acknowledgementRunId !== null) ||
      (journal.state == 'typed-only-acknowledged' && !RUN_ID_PATTERN.test(journal.acknowledgementRunId))) {
      throw new Error('Portable profile migration journal is invalid')
    }
    return journal
  }

  if (journal.version != JOURNAL_VERSION || keys != JOURNAL_V2_KEYS || !hasSourceIdentityBinding(journal) ||
    !['promoted', 'typed-only-acknowledged', ...RETIREMENT_STATES].includes(journal.state) ||
    (journal.state == 'promoted' && (journal.acknowledgementRunId !== null || journal.retirement !== null)) ||
    (journal.state == 'typed-only-acknowledged' &&
      (!RUN_ID_PATTERN.test(journal.acknowledgementRunId) || journal.retirement !== null)) ||
    (RETIREMENT_STATES.includes(journal.state) &&
      (!RUN_ID_PATTERN.test(journal.acknowledgementRunId) || !isRetirementEvidenceV2(journal.retirement, journal)))) {
    throw new Error('Portable profile migration journal is invalid')
  }
  return journal
}

const parseReceipt = raw => {
  const receipt = parseJsonObject(raw, 'Portable profile migration receipt is invalid')
  const keys = Object.keys(receipt).sort().join(',')
  const hasLegacySchema = keys == LEGACY_RECEIPT_KEYS
  const hasIdentityBoundSchema = keys == IDENTITY_BOUND_RECEIPT_KEYS
  if (
    (!hasLegacySchema && !hasIdentityBoundSchema) ||
    receipt.version != RECEIPT_VERSION ||
    typeof receipt.sourceManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(receipt.sourceManifestHash) ||
    typeof receipt.destinationManifestHash != 'string' || !/^[a-f0-9]{64}$/.test(receipt.destinationManifestHash) ||
    (hasIdentityBoundSchema && !hasSourceIdentityBinding(receipt)) ||
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
  const before = fsApi.lstatSync(journalPath, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Portable profile migration journal must be a regular file')
  }
  const raw = fsApi.readFileSync(journalPath, 'utf8')
  const journal = parseJournal(raw)
  const after = fsApi.lstatSync(journalPath, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || !isSameNode(before, after)) {
    throw new Error('Portable profile migration journal changed while inspected')
  }
  return { journal, identity: after, raw }
}

const readReceipt = (fsApi, receiptPath) => {
  const before = fsApi.lstatSync(receiptPath, { bigint: true })
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Portable profile migration receipt must be a regular file')
  }
  const raw = fsApi.readFileSync(receiptPath, 'utf8')
  const receipt = parseReceipt(raw)
  const after = fsApi.lstatSync(receiptPath, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || !isSameNode(before, after)) {
    throw new Error('Portable profile migration receipt changed while inspected')
  }
  return { receipt, identity: after, raw }
}

const removeOwnedFile = (fsApi, candidatePath, identity, lease) => {
  try {
    lease.assertHeld()
    const current = fsApi.lstatSync(candidatePath, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() || !isSameNode(identity, current)) return
    lease.assertHeld()
    fsApi.unlinkSync(candidatePath)
  } catch {}
}

const writeAtomicRecord = ({ fsApi, paths, targetPath, value, parse, read, label, lease }) => {
  parse(JSON.stringify(value))
  const candidatePath = `${targetPath}.${crypto.randomBytes(16).toString('hex')}.candidate`
  assertDirectChild(paths.portableRoot, candidatePath)
  let fd
  let identity
  try {
    lease.assertHeld()
    fd = fsApi.openSync(candidatePath, 'wx')
    identity = fsApi.fstatSync(fd, { bigint: true })
    if (!identity.isFile()) throw new Error(`Portable profile ${label} candidate must be a regular file`)
    const serialized = Buffer.from(JSON.stringify(value, null, 2))
    let offset = 0
    while (offset < serialized.length) {
      lease.assertHeld()
      const written = fsApi.writeSync(fd, serialized, offset, serialized.length - offset)
      if (written <= 0) throw new Error(`Could not write portable profile migration ${label}`)
      offset += written
    }
    lease.assertHeld()
    fsApi.fsyncSync(fd)
    fsApi.closeSync(fd)
    fd = undefined
    const candidateIdentity = fsApi.lstatSync(candidatePath, { bigint: true })
    if (!candidateIdentity.isFile() || candidateIdentity.isSymbolicLink() || !isSameNode(identity, candidateIdentity)) {
      throw new Error(`Portable profile ${label} candidate changed before promotion`)
    }
    if (fsApi.existsSync(targetPath)) read(fsApi, targetPath)
    lease.assertHeld()
    fsApi.renameSync(candidatePath, targetPath)
  } finally {
    if (fd != null) {
      try { fsApi.closeSync(fd) } catch {}
    }
    if (identity != null) removeOwnedFile(fsApi, candidatePath, identity, lease)
  }
}

const writeJournal = async(fsApi, paths, journal, lease, afterJournalWrite) => {
  writeAtomicRecord({
    fsApi,
    paths,
    targetPath: paths.journalPath,
    value: journal,
    parse: parseJournal,
    read: readJournal,
    label: 'journal',
    lease,
  })
  await afterJournalWrite?.(journal)
}

const writeReceipt = async(fsApi, paths, receipt, lease) => writeAtomicRecord({
  fsApi,
  paths,
  targetPath: paths.receiptPath,
  value: receipt,
  parse: parseReceipt,
  read: readReceipt,
  label: 'receipt',
  lease,
})

const removeOwnedReceipt = (fsApi, paths, snapshot, lease) => {
  try {
    const current = readReceipt(fsApi, paths.receiptPath)
    if (!isSameNode(snapshot.identity, current.identity) ||
      snapshot.receipt.nonce != current.receipt.nonce || snapshot.raw != current.raw) return false
    lease.assertHeld()
    fsApi.unlinkSync(paths.receiptPath)
    return true
  } catch {
    return false
  }
}

const hashDirectory = async(fsApi, directoryPath) => hashManifest(await createDirectoryManifest(fsApi, directoryPath))

const sourceIsAbsent = (fsApi, sourcePath) => {
  try {
    fsApi.lstatSync(sourcePath)
    return false
  } catch (error) {
    if (error?.code == 'ENOENT') return true
    throw error
  }
}

const assertRecordedTrees = async(fsApi, paths, journal, {
  sourceRequired = true,
  destinationHashRequired = true,
  sourceIdentityRequired = true,
} = {}) => {
  const destinationIdentity = fsApi.lstatSync(paths.destinationPath, { bigint: true })
  if (destinationIdentity.isSymbolicLink() || !destinationIdentity.isDirectory()) {
    throw new Error('Portable profile destination must be a non-link directory')
  }
  if (!recordedIdentityMatches(journal.destinationIdentity, destinationIdentity)) {
    throw new Error('Portable profile destination identity does not match the migration record')
  }
  const destinationManifestHash = await hashDirectory(fsApi, paths.destinationPath)
  if (destinationHashRequired && destinationManifestHash != journal.destinationManifestHash) {
    throw new Error('Portable profile destination manifest does not match the journal')
  }
  const destinationAfter = fsApi.lstatSync(paths.destinationPath, { bigint: true })
  if (destinationAfter.isSymbolicLink() || !destinationAfter.isDirectory() ||
    !isSameNode(destinationIdentity, destinationAfter) ||
    !recordedIdentityMatches(journal.destinationIdentity, destinationAfter)) {
    throw new Error('Portable profile destination identity changed while it was verified')
  }
  if (sourceIsAbsent(fsApi, paths.sourcePath)) {
    if (sourceRequired) throw new Error('Portable profile source is missing before retirement')
    if (!sourceIdentityRequired) return { destinationIdentity: destinationAfter, destinationManifestHash }
    const userDataIdentity = assertUserDataAncestry(fsApi, paths)
    if (!recordedIdentityMatches(journal.userDataIdentity, userDataIdentity)) {
      throw new Error('Portable profile userData identity does not match the migration record')
    }
    const userDataAfter = assertUserDataAncestry(fsApi, paths)
    if (!isSameNode(userDataIdentity, userDataAfter)) {
      throw new Error('Portable profile userData ownership changed while it was verified')
    }
    return { destinationIdentity: destinationAfter, destinationManifestHash, userDataIdentity: userDataAfter }
  }
  const sourceIdentities = assertSourceAncestry(fsApi, paths)
  if (sourceIdentityRequired && !recordedIdentityMatches(journal.userDataIdentity, sourceIdentities.userDataIdentity)) {
    throw new Error('Portable profile userData identity does not match the migration record')
  }
  if (sourceIdentityRequired && !recordedIdentityMatches(journal.sourceIdentity, sourceIdentities.sourceIdentity)) {
    throw new Error('Portable profile source identity does not match the migration record')
  }
  if (await hashDirectory(fsApi, paths.sourcePath) != journal.sourceManifestHash) {
    throw new Error('Portable profile source manifest does not match the journal')
  }
  const sourceAfter = assertSourceAncestry(fsApi, paths)
  if (!isSameNode(sourceIdentities.userDataIdentity, sourceAfter.userDataIdentity) ||
    !isSameNode(sourceIdentities.sourceIdentity, sourceAfter.sourceIdentity)) {
    throw new Error('Portable profile source ownership changed while it was verified')
  }
  return { destinationIdentity: destinationAfter, destinationManifestHash, ...sourceAfter }
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

const receiptMatchesJournal = (receipt, journal) => {
  const receiptIsBound = hasSourceIdentityBinding(receipt)
  const journalIsBound = hasSourceIdentityBinding(journal)
  return receiptIsBound == journalIsBound &&
  receipt.promotionRunId == journal.promotionRunId &&
  receipt.sourceManifestHash == journal.sourceManifestHash &&
  receipt.destinationManifestHash == journal.destinationManifestHash &&
  (!receiptIsBound || (
    recordedIdentityMatches(receipt.userDataIdentity, journal.userDataIdentity) &&
    recordedIdentityMatches(receipt.sourceIdentity, journal.sourceIdentity)
  )) &&
  recordedIdentityMatches(receipt.destinationIdentity, journal.destinationIdentity)
}

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
  retirement: null,
})

const legacyJournalFromReceipt = (receipt, preparationRunId) => ({
  version: 1,
  sourceManifestHash: receipt.sourceManifestHash,
  destinationManifestHash: receipt.destinationManifestHash,
  destinationIdentity: { ...receipt.destinationIdentity },
  promotionRunId: receipt.promotionRunId,
  preparationRunId,
  state: 'promoted',
  acknowledgementRunId: null,
})

const upgradeIdentityBoundJournalV1 = journal => ({
  ...journal,
  version: JOURNAL_VERSION,
  retirement: null,
})

const withRetirement = (journal, state, reservation) => ({
  ...journal,
  state,
  retirement: {
    isolationBasename: reservation.isolationBasename,
    isolationIdentity: { ...reservation.isolationIdentity },
    sourceIdentity: { ...journal.sourceIdentity },
    sourceManifestHash: journal.sourceManifestHash,
    destinationManifestHash: journal.destinationManifestHash,
  },
})

const withRetirementState = (journal, state) => ({ ...journal, state })

const acquirePortableLease = async(paths, logger) => await acquireMigrationLease({
  rootPath: paths.portableRoot,
  lockPath: paths.lockPath,
  logger,
})

const runResultWithLease = async({ paths, logger, createResult }, operation) => {
  let lease
  try {
    lease = await acquirePortableLease(paths, logger)
  } catch (error) {
    return createResult('failed', { error })
  }
  let result
  try {
    lease.assertHeld()
    result = await operation(lease)
  } catch (error) {
    result = createResult('failed', { error })
  }
  try {
    await releaseMigrationLease(lease)
  } catch (error) {
    return createResult('failed', { error })
  }
  return result
}

const preparePortableProfile = async({
  portableRoot,
  runId = crypto.randomUUID(),
  fsApi = fs,
  logger = console,
}) => {
  assertRunId(runId, 'Portable startup run ID')
  const paths = getPaths(portableRoot, fsApi)
  const createResult = (state, extra = {}) => ({ state, ...paths, ...extra })
  return await runResultWithLease({ paths, logger, createResult }, async lease => {
    const sourceExists = fsApi.existsSync(paths.sourcePath)
    const journalExists = fsApi.existsSync(paths.journalPath)
    const receiptExists = fsApi.existsSync(paths.receiptPath)
    if (!sourceExists && !journalExists && !receiptExists) return createResult('source-missing')

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
        !removeOwnedReceipt(fsApi, paths, receiptSnapshot, lease)) {
        return createResult('failed', { error: new Error('Portable profile migration receipt conflicts with the journal') })
      }
      receiptSnapshot = undefined
    }

    if (journalSnapshot == null && receiptSnapshot != null) {
      if (hasDestination) {
        try {
          const receiptIsBound = hasSourceIdentityBinding(receiptSnapshot.receipt)
          await assertRecordedTrees(fsApi, paths, receiptSnapshot.receipt, {
            sourceRequired: true,
            destinationHashRequired: true,
            sourceIdentityRequired: receiptIsBound,
          })
          const promotedJournal = receiptIsBound
            ? journalFromReceipt(receiptSnapshot.receipt, runId)
            : legacyJournalFromReceipt(receiptSnapshot.receipt, runId)
          await writeJournal(fsApi, paths, promotedJournal, lease)
          if (!removeOwnedReceipt(fsApi, paths, receiptSnapshot, lease)) {
            throw new Error('Portable profile migration receipt could not be retired after journal promotion')
          }
          return createResult('already-promoted', receiptIsBound
            ? { token: createToken(paths, promotedJournal, runId) }
            : {})
        } catch (error) {
          return createResult('failed', { error })
        }
      }
      if (fsApi.existsSync(paths.destinationPath) || !removeOwnedReceipt(fsApi, paths, receiptSnapshot, lease)) {
        return createResult('failed', { error: new Error('Portable profile pending promotion could not be reset safely') })
      }
      receiptSnapshot = undefined
    }

    if (hasDestination) {
      if (journalSnapshot == null) {
        const destinationIdentity = fsApi.lstatSync(paths.destinationPath, { bigint: true })
        if (destinationIdentity.isSymbolicLink() || !destinationIdentity.isDirectory()) {
          return createResult('failed', { error: new Error('Portable profile destination is invalid') })
        }
        if (fsApi.readdirSync(paths.destinationPath).length != 0) {
          return createResult('failed', { error: new Error('Portable profile destination collision is not journalled') })
        }
        const after = fsApi.lstatSync(paths.destinationPath, { bigint: true })
        if (!isSameNode(destinationIdentity, after)) {
          return createResult('failed', { error: new Error('Portable profile destination changed before migration') })
        }
        lease.assertHeld()
        fsApi.rmdirSync(paths.destinationPath)
      } else {
        if (journalSnapshot.journal.version == JOURNAL_VERSION &&
          RETIREMENT_STATES.includes(journalSnapshot.journal.state)) {
          return journalSnapshot.journal.state == 'retired'
            ? createResult('already-acknowledged')
            : createResult('failed', { error: new Error('Portable profile retirement must be resolved before preparation') })
        }
        let verifiedTrees
        try {
          const journalIsBound = hasSourceIdentityBinding(journalSnapshot.journal)
          verifiedTrees = await assertRecordedTrees(fsApi, paths, journalSnapshot.journal, {
            sourceRequired: journalSnapshot.journal.state == 'promoted',
            destinationHashRequired: journalSnapshot.journal.version == 1 ||
              journalSnapshot.journal.state == 'typed-only-acknowledged',
            sourceIdentityRequired: journalIsBound,
          })
        } catch (error) {
          return createResult('failed', { error })
        }
        let verifiedJournal = journalSnapshot.journal
        if (verifiedJournal.version == 1 && hasSourceIdentityBinding(verifiedJournal) &&
          verifiedTrees.sourceIdentity != null) {
          verifiedJournal = upgradeIdentityBoundJournalV1(verifiedJournal)
        }
        if (verifiedJournal.state == 'typed-only-acknowledged') {
          if (verifiedJournal !== journalSnapshot.journal) {
            await writeJournal(fsApi, paths, verifiedJournal, lease)
          }
          return createResult('already-acknowledged')
        }
        if (!hasSourceIdentityBinding(verifiedJournal)) {
          return createResult('already-promoted')
        }
        const refreshedJournal = {
          ...verifiedJournal,
          preparationRunId: runId,
        }
        await writeJournal(fsApi, paths, refreshedJournal, lease)
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
    lease.assertHeld()
    const migration = await copyDirectoryWithManifestPromotion({
      fsApi,
      rootPath: paths.portableRoot,
      sourcePath: paths.sourcePath,
      destinationPath: paths.destinationPath,
      stagePrefix: paths.stagePrefix,
      runId: promotionRunId,
      lease,
      logger,
      async beforePromotion({ payloadPath, sourceManifestHash, destinationManifestHash }) {
        const payloadIdentity = fsApi.lstatSync(payloadPath, { bigint: true })
        if (payloadIdentity.isSymbolicLink() || !payloadIdentity.isDirectory()) {
          throw new Error('Portable profile staged payload must be a non-link directory')
        }
        const receipt = {
          version: RECEIPT_VERSION,
          sourceManifestHash,
          destinationManifestHash,
          userDataIdentity: recordNodeIdentity(promotionSourceIdentities.userDataIdentity),
          sourceIdentity: recordNodeIdentity(promotionSourceIdentities.sourceIdentity),
          destinationIdentity: recordNodeIdentity(payloadIdentity),
          promotionRunId,
          preparationRunId: runId,
          nonce: crypto.randomBytes(16).toString('hex'),
        }
        await writeReceipt(fsApi, paths, receipt, lease)
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
      await assertRecordedTrees(fsApi, paths, receiptSnapshotForPromotion.receipt, {
        sourceRequired: true,
        destinationHashRequired: true,
      })
      promotedJournal = journalFromReceipt(receiptSnapshotForPromotion.receipt, runId)
      await writeJournal(fsApi, paths, promotedJournal, lease)
      if (!removeOwnedReceipt(fsApi, paths, receiptSnapshotForPromotion, lease)) {
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
  })
}

const acknowledgePortableProfileStartup = async(rawToken, {
  fsApi = fs,
  logger = console,
} = {}) => {
  const token = validateToken(rawToken)
  const paths = getPaths(token.portableRoot, fsApi)
  const lease = await acquirePortableLease(paths, logger)
  let result
  let operationError
  try {
    lease.assertHeld()
    const { journal } = readJournal(fsApi, paths.journalPath)
    if (!hasSourceIdentityBinding(journal)) {
      throw new Error('Legacy portable profile records are not eligible for acknowledgement')
    }
    if (journal.state != 'promoted' ||
      journal.promotionRunId != token.promotionRunId ||
      journal.preparationRunId != token.startupRunId ||
      !recordedIdentityMatches(journal.destinationIdentity, token.destinationIdentity)) {
      throw new Error('Portable profile acknowledgement token does not match the promoted journal')
    }
    const trees = await assertRecordedTrees(fsApi, paths, journal, {
      sourceRequired: true,
      destinationHashRequired: journal.version == 1,
    })
    const acknowledgedJournal = {
      ...(journal.version == 1 ? upgradeIdentityBoundJournalV1(journal) : journal),
      destinationManifestHash: trees.destinationManifestHash,
      state: 'typed-only-acknowledged',
      acknowledgementRunId: token.startupRunId,
    }
    await writeJournal(fsApi, paths, acknowledgedJournal, lease)
    result = { state: 'typed-only-acknowledged' }
  } catch (error) {
    operationError = error
  }
  let releaseError
  try {
    await releaseMigrationLease(lease)
  } catch (error) {
    releaseError = error
  }
  if (releaseError != null) throw releaseError
  if (operationError != null) throw operationError
  return result
}

const assertRetirementContext = async(fsApi, paths, journal) => {
  const portableIdentity = fsApi.lstatSync(paths.portableRoot, { bigint: true })
  if (portableIdentity.isSymbolicLink() || !portableIdentity.isDirectory() ||
    !isSameNode(paths.portableIdentity, portableIdentity)) {
    throw new Error('Portable root identity changed during retirement')
  }
  const userDataIdentity = fsApi.lstatSync(paths.userDataPath, { bigint: true })
  if (userDataIdentity.isSymbolicLink() || !userDataIdentity.isDirectory() ||
    !recordedIdentityMatches(journal.userDataIdentity, userDataIdentity)) {
    throw new Error('Portable profile userData identity does not match the retirement journal')
  }
  const destinationIdentity = fsApi.lstatSync(paths.destinationPath, { bigint: true })
  if (destinationIdentity.isSymbolicLink() || !destinationIdentity.isDirectory() ||
    !recordedIdentityMatches(journal.destinationIdentity, destinationIdentity) ||
    await hashDirectory(fsApi, paths.destinationPath) != journal.destinationManifestHash) {
    throw new Error('Portable profile destination does not match the retirement journal')
  }
  const portableAfter = fsApi.lstatSync(paths.portableRoot, { bigint: true })
  const destinationAfter = fsApi.lstatSync(paths.destinationPath, { bigint: true })
  const userDataAfter = fsApi.lstatSync(paths.userDataPath, { bigint: true })
  if (!isSameNode(portableIdentity, portableAfter) || !isSameNode(destinationIdentity, destinationAfter) ||
    !isSameNode(userDataIdentity, userDataAfter)) {
    throw new Error('Portable profile retirement context changed while verified')
  }
  return { portableIdentity: portableAfter, destinationIdentity: destinationAfter, userDataIdentity: userDataAfter }
}

const assertRetirementPayload = async(fsApi, paths, journal, payloadPath) => {
  const context = await assertRetirementContext(fsApi, paths, journal)
  const payloadIdentity = fsApi.lstatSync(payloadPath, { bigint: true })
  if (payloadIdentity.isSymbolicLink() || !payloadIdentity.isDirectory() ||
    !recordedIdentityMatches(journal.retirement.sourceIdentity, payloadIdentity) ||
    await hashDirectory(fsApi, payloadPath) != journal.retirement.sourceManifestHash) {
    throw new Error('Portable profile retirement payload does not match the journal')
  }
  const payloadAfter = fsApi.lstatSync(payloadPath, { bigint: true })
  const destinationAfter = fsApi.lstatSync(paths.destinationPath, { bigint: true })
  const userDataAfter = fsApi.lstatSync(paths.userDataPath, { bigint: true })
  const portableAfter = fsApi.lstatSync(paths.portableRoot, { bigint: true })
  if (!isSameNode(payloadIdentity, payloadAfter) ||
    !isSameNode(context.portableIdentity, portableAfter) ||
    !isSameNode(context.destinationIdentity, destinationAfter) ||
    !isSameNode(context.userDataIdentity, userDataAfter)) {
    throw new Error('Portable profile retirement ownership changed while verified')
  }
}

const reopenRetirementIsolation = async(root, retirement) => await reopenExclusiveIsolation({
  root,
  isolationBasename: retirement.isolationBasename,
  isolationIdentity: retirement.isolationIdentity,
})

const assertEmptyRetirementIsolation = async(fsApi, root, retirement) => {
  let reservation = await reopenRetirementIsolation(root, retirement)
  if (fsApi.readdirSync(reservation.isolationPath).length != 0) {
    throw new Error('Portable profile retirement isolation is not empty')
  }
  reservation = await reopenRetirementIsolation(root, retirement)
  if (fsApi.readdirSync(reservation.isolationPath).length != 0) {
    throw new Error('Portable profile retirement isolation changed while it was verified')
  }
  return await reopenRetirementIsolation(root, retirement)
}

const assertRetirementSourceAbsent = (fsApi, paths) => {
  if (!sourceIsAbsent(fsApi, paths.sourcePath)) {
    throw new Error('Portable profile source was replaced during retirement')
  }
}

const assertExactRetirementPayloadEntry = (fsApi, reservation, retirement) => {
  const entries = fsApi.readdirSync(reservation.isolationPath)
  const payloadIdentity = fsApi.lstatSync(reservation.payloadPath, { bigint: true })
  if (entries.length != 1 || entries[0] != 'payload' ||
    payloadIdentity.isSymbolicLink() || !payloadIdentity.isDirectory() ||
    !recordedIdentityMatches(retirement.sourceIdentity, payloadIdentity)) {
    throw new Error('Portable profile retirement payload changed before removal')
  }
}

const reclaimRetirementPayload = async({ fsApi, paths, journal, root, lease }) => {
  try {
    let reservation = await reopenRetirementIsolation(root, journal.retirement)
    assertExactRetirementPayloadEntry(fsApi, reservation, journal.retirement)
    await assertRetirementPayload(fsApi, paths, journal, reservation.payloadPath)

    reservation = await reopenRetirementIsolation(root, journal.retirement)
    assertExactRetirementPayloadEntry(fsApi, reservation, journal.retirement)
    reservation = await reopenRetirementIsolation(root, journal.retirement)

    assertRetirementSourceAbsent(fsApi, paths)
    lease.assertHeld()
    fsApi.rmSync(reservation.payloadPath, { recursive: true, force: false })
    await assertEmptyRetirementIsolation(fsApi, root, journal.retirement)
    return { state: 'reclaimed' }
  } catch (error) {
    return {
      state: 'retained',
      error: error instanceof Error ? error : new Error('Portable profile retirement payload could not be reclaimed'),
    }
  }
}

const retireAcknowledgedPortableSource = async({
  portableRoot,
  runId = crypto.randomUUID(),
  fsApi = fs,
  logger = console,
  beforeSourceRetirement,
  beforeSourceRename,
  afterRetirementPayloadRemoval,
  afterJournalWrite,
}) => {
  assertRunId(runId, 'Portable startup run ID')
  const paths = getPaths(portableRoot, fsApi)
  const createResult = (state, extra = {}) => ({ state, ...paths, ...extra })
  return await runResultWithLease({ paths, logger, createResult }, async lease => {
    if (!fsApi.existsSync(paths.journalPath)) return createResult('not-acknowledged')
    let journal
    try {
      journal = readJournal(fsApi, paths.journalPath).journal
    } catch (error) {
      return createResult('failed', { error })
    }
    if (!hasSourceIdentityBinding(journal) || journal.state == 'promoted') {
      return createResult('not-acknowledged')
    }
    if (journal.version == JOURNAL_VERSION && journal.state == 'retired') {
      return createResult('already-retired')
    }
    if (journal.acknowledgementRunId == runId) return createResult('same-startup')

    if (journal.version == 1) {
      if (journal.state != 'typed-only-acknowledged') return createResult('not-acknowledged')
      try {
        await assertRecordedTrees(fsApi, paths, journal, {
          sourceRequired: true,
          destinationHashRequired: true,
          sourceIdentityRequired: true,
        })
        journal = upgradeIdentityBoundJournalV1(journal)
        await writeJournal(fsApi, paths, journal, lease)
      } catch (error) {
        return createResult('failed', { error })
      }
    }

    let userDataGuard
    try {
      lease.assertHeld()
      userDataGuard = validateDirectDirectory(paths.userDataPath, { fsApi })

      let reservation
      if (RETIREMENT_STATES.includes(journal.state)) {
        lease.assertHeld()
        reservation = await reopenExclusiveIsolation({
          root: userDataGuard,
          isolationBasename: journal.retirement.isolationBasename,
          isolationIdentity: journal.retirement.isolationIdentity,
        })
        const entries = fsApi.readdirSync(reservation.isolationPath)
        const hasSource = !sourceIsAbsent(fsApi, paths.sourcePath)
        const hasExactPayload = entries.length == 1 && entries[0] == 'payload'
        const isEmpty = entries.length == 0

        if (journal.state == 'retirement-intent' && hasSource && isEmpty) {
          await assertRecordedTrees(fsApi, paths, journal, {
            sourceRequired: true,
            destinationHashRequired: true,
            sourceIdentityRequired: true,
          })
        } else if (journal.state == 'retirement-intent' && !hasSource && hasExactPayload) {
          await assertRetirementPayload(fsApi, paths, journal, reservation.payloadPath)
          journal = withRetirementState(journal, 'retired-retained')
          await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
          return createResult('failed', { error: new Error('Portable profile retirement payload was retained after interruption') })
        } else if (['retirement-isolated', 'retired-retained'].includes(journal.state) && !hasSource && isEmpty) {
          await assertRetirementContext(fsApi, paths, journal)
          await assertEmptyRetirementIsolation(fsApi, userDataGuard, journal.retirement)
          assertRetirementSourceAbsent(fsApi, paths)
          journal = withRetirementState(journal, 'retired')
          await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
          return createResult('retired')
        } else if (['retirement-isolated', 'retired-retained'].includes(journal.state) && !hasSource && hasExactPayload) {
          await assertRetirementPayload(fsApi, paths, journal, reservation.payloadPath)
          if (journal.state != 'retired-retained') {
            journal = withRetirementState(journal, 'retired-retained')
            await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
          }
          return createResult('failed', { error: new Error('Portable profile retirement payload is retained for operator review') })
        } else {
          throw new Error('Portable profile retirement isolation is ambiguous and was retained')
        }
      } else {
        if (journal.state != 'typed-only-acknowledged') return createResult('not-acknowledged')
        const identities = await assertRecordedTrees(fsApi, paths, journal, {
          sourceRequired: true,
          destinationHashRequired: true,
          sourceIdentityRequired: true,
        })
        lease.assertHeld()
        reservation = await reserveExclusiveIsolation({
          root: userDataGuard,
          prefix: PORTABLE_PROFILE_RETIREMENT_PREFIX,
        })
        journal = withRetirement(journal, 'retirement-intent', reservation)
        await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
        if (!recordedIdentityMatches(journal.sourceIdentity, identities.sourceIdentity)) {
          throw new Error('Portable profile source identity changed before retirement isolation')
        }
      }

      await beforeSourceRetirement?.()
      await beforeSourceRename?.()
      await assertRecordedTrees(fsApi, paths, journal, {
        sourceRequired: true,
        destinationHashRequired: true,
        sourceIdentityRequired: true,
      })
      const source = Object.freeze({
        root: userDataGuard,
        path: paths.sourcePath,
        basename: path.basename(paths.sourcePath),
        identity: Object.freeze({ ...journal.retirement.sourceIdentity }),
        kind: 'directory',
      })
      lease.assertHeld()
      const isolation = await isolateOwnedPath({
        source,
        reservation,
        async verifySource(payloadPath) {
          await assertRetirementPayload(fsApi, paths, journal, payloadPath)
        },
      })
      if (isolation.state != 'isolated') {
        return createResult('failed', { error: isolation.error ?? new Error('Portable profile source was absent before isolation') })
      }
      journal = withRetirementState(journal, 'retirement-isolated')
      await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
      lease.assertHeld()
      const reclaimed = await reclaimRetirementPayload({
        fsApi,
        paths,
        journal,
        root: userDataGuard,
        lease,
      })
      if (reclaimed.state == 'retained') {
        lease.assertHeld()
        journal = withRetirementState(journal, 'retired-retained')
        await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
        return createResult('failed', { error: reclaimed.error })
      }
      await afterRetirementPayloadRemoval?.()
      await assertRetirementContext(fsApi, paths, journal)
      await assertEmptyRetirementIsolation(fsApi, userDataGuard, journal.retirement)
      assertRetirementSourceAbsent(fsApi, paths)
      lease.assertHeld()
      journal = withRetirementState(journal, 'retired')
      await writeJournal(fsApi, paths, journal, lease, afterJournalWrite)
      safeLog(logger, 'info', `Retired portable profile source ${paths.sourcePath}`)
      return createResult('retired')
    } finally {
      if (userDataGuard != null) closeDirectDirectory(userDataGuard)
    }
  })
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
