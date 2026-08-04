const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { revalidateDirectDirectory } = require('./directDirectory')

const payloadBasename = 'payload'
const isolationError = code => Object.assign(new Error(code), { code })
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left, right) => left.dev == right.dev && left.ino == right.ino
const isIdentity = identity => identity != null && typeof identity == 'object' &&
  typeof identity.dev == 'string' && identity.dev.length > 0 &&
  typeof identity.ino == 'string' && identity.ino.length > 0
const isMissing = error => error != null && typeof error == 'object' && error.code == 'ENOENT'
const isCollision = error => error != null && typeof error == 'object' && error.code == 'EEXIST'
const isDirectBasename = basename => typeof basename == 'string' && basename.length > 0 &&
  basename != '.' && basename != '..' && path.basename(basename) == basename

const randomToken = randomBytes => {
  const token = (randomBytes ?? crypto.randomBytes)(16)
  if (!Buffer.isBuffer(token) || token.length != 16) throw isolationError('isolation_invalid')
  return token.toString('hex')
}

const samePath = (left, right) => path.resolve(left) == path.resolve(right)

const inspectOwnedNode = ({ path: nodePath, identity, kind }) => {
  try {
    const stat = fs.lstatSync(nodePath, { bigint: true })
    if (stat.isSymbolicLink() || (kind == 'file' && !stat.isFile()) ||
      (kind == 'directory' && !stat.isDirectory()) || !sameIdentity(identityOf(stat), identity)) {
      throw isolationError('isolation_changed')
    }
    return stat
  } catch (error) {
    if (error?.code == 'isolation_changed') throw error
    if (isMissing(error)) return null
    throw isolationError('isolation_changed')
  }
}

const validateReservation = reservation => {
  if (reservation == null || typeof reservation != 'object' ||
    !isDirectBasename(reservation.isolationBasename) ||
    !samePath(reservation.isolationPath, path.join(reservation.root?.path ?? '', reservation.isolationBasename)) ||
    !samePath(reservation.payloadPath, path.join(reservation.isolationPath, payloadBasename)) ||
    !isIdentity(reservation.isolationIdentity)) {
    throw isolationError('isolation_invalid')
  }
  try {
    revalidateDirectDirectory(reservation.root)
    const stat = fs.lstatSync(reservation.isolationPath, { bigint: true })
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(identityOf(stat), reservation.isolationIdentity)) {
      throw isolationError('isolation_changed')
    }
    revalidateDirectDirectory(reservation.root)
  } catch (error) {
    if (error?.code == 'isolation_changed') throw error
    throw isolationError('isolation_changed')
  }
}

const validateSource = source => {
  if (source == null || typeof source != 'object' ||
    !isDirectBasename(source.basename) || (source.kind != 'file' && source.kind != 'directory') ||
    !samePath(source.path, path.join(source.root?.path ?? '', source.basename)) ||
    !isIdentity(source.identity)) {
    throw isolationError('isolation_invalid')
  }
  revalidateDirectDirectory(source.root)
  const stat = inspectOwnedNode(source)
  revalidateDirectDirectory(source.root)
  return stat
}

const assertPayloadAbsent = reservation => {
  try {
    fs.lstatSync(reservation.payloadPath, { bigint: true })
    throw isolationError('isolation_changed')
  } catch (error) {
    if (error?.code == 'isolation_changed') throw error
    if (!isMissing(error)) throw isolationError('isolation_changed')
  }
}

const reservationFor = ({ root, isolationBasename, isolationIdentity }) => {
  if (!isDirectBasename(isolationBasename) || !isIdentity(isolationIdentity)) {
    throw isolationError('isolation_invalid')
  }
  const isolationPath = path.join(root?.path ?? '', isolationBasename)
  const reservation = Object.freeze({
    root,
    isolationPath,
    isolationBasename,
    isolationIdentity: Object.freeze({ dev: String(isolationIdentity.dev), ino: String(isolationIdentity.ino) }),
    payloadPath: path.join(isolationPath, payloadBasename),
  })
  validateReservation(reservation)
  return reservation
}

const reserveExclusiveIsolation = async input => {
  if (input == null || typeof input != 'object' || typeof input.prefix != 'string') throw isolationError('isolation_invalid')
  for (let attempt = 0; attempt < 8; attempt++) {
    const isolationBasename = `${input.prefix}${randomToken(input.randomBytes)}`
    if (!isDirectBasename(isolationBasename)) throw isolationError('isolation_invalid')
    const isolationPath = path.join(input.root?.path ?? '', isolationBasename)
    try {
      revalidateDirectDirectory(input.root)
      fs.mkdirSync(isolationPath, { mode: 0o700 })
    } catch (error) {
      revalidateDirectDirectory(input.root)
      if (isCollision(error)) continue
      throw error
    }
    try {
      revalidateDirectDirectory(input.root)
      const stat = fs.lstatSync(isolationPath, { bigint: true })
      if (stat.isSymbolicLink() || !stat.isDirectory() || fs.readdirSync(isolationPath).length != 0) {
        throw isolationError('isolation_changed')
      }
      return reservationFor({ root: input.root, isolationBasename, isolationIdentity: identityOf(stat) })
    } catch (error) {
      throw error?.code == 'isolation_changed' ? error : isolationError('isolation_changed')
    }
  }
  throw isolationError('isolation_collision')
}

const reopenExclusiveIsolation = async input => {
  if (input == null || typeof input != 'object') throw isolationError('isolation_invalid')
  return reservationFor(input)
}

const sameRoot = (left, right) => samePath(left.path, right.path) && sameIdentity(left.identity, right.identity)

const isolateOwnedPath = async input => {
  if (input == null || typeof input != 'object') throw isolationError('isolation_invalid')
  const source = input.source
  const initialSource = validateSource(source)
  if (initialSource == null) return { state: 'absent' }

  const reservation = input.reservation ?? await reserveExclusiveIsolation({ root: source.root, prefix: input.prefix })
  if (!sameRoot(source.root, reservation.root)) throw isolationError('isolation_invalid')
  validateReservation(reservation)
  if (input.onReserved != null) {
    await input.onReserved(reservation)
    validateReservation(reservation)
  }

  const sourceBeforeMove = validateSource(source)
  if (sourceBeforeMove == null) return { state: 'absent' }
  validateReservation(reservation)
  const sourceAtMove = validateSource(source)
  if (sourceAtMove == null) return { state: 'absent' }
  validateReservation(reservation)
  assertPayloadAbsent(reservation)
  fs.renameSync(source.path, reservation.payloadPath)

  const moved = inspectOwnedNode({
    path: reservation.payloadPath,
    identity: source.identity,
    kind: source.kind,
  })
  if (moved == null) throw isolationError('isolation_changed')
  if (input.verifySource != null) await input.verifySource(reservation.payloadPath)
  validateReservation(reservation)
  if (inspectOwnedNode({ path: reservation.payloadPath, identity: source.identity, kind: source.kind }) == null) {
    throw isolationError('isolation_changed')
  }
  if (input.beforeStableAbsenceCheck != null) await input.beforeStableAbsenceCheck()

  try {
    fs.lstatSync(source.path, { bigint: true })
    return { state: 'conflict', reservation, error: isolationError('isolation_conflict') }
  } catch (error) {
    if (!isMissing(error)) throw isolationError('isolation_changed')
  }
  validateReservation(reservation)
  const finalPayload = inspectOwnedNode({
    path: reservation.payloadPath,
    identity: source.identity,
    kind: source.kind,
  })
  if (finalPayload == null) throw isolationError('isolation_changed')
  try {
    fs.lstatSync(source.path, { bigint: true })
    return { state: 'conflict', reservation, error: isolationError('isolation_conflict') }
  } catch (error) {
    if (!isMissing(error)) throw isolationError('isolation_changed')
  }
  const payloadIdentity = identityOf(finalPayload)
  return {
    state: 'isolated',
    guard: Object.freeze({
      ...reservation,
      sourcePath: source.path,
      expectedIdentity: Object.freeze({ ...source.identity }),
      payloadIdentity: Object.freeze(payloadIdentity),
      kind: source.kind,
    }),
  }
}

const reclaimIsolatedPayload = async input => {
  try {
    if (input == null || typeof input != 'object' || input.guard == null ||
      (input.guard.kind != 'file' && input.guard.kind != 'directory')) {
      throw isolationError('isolation_invalid')
    }
    const guard = input.guard
    validateReservation(guard)
    const payload = inspectOwnedNode({
      path: guard.payloadPath,
      identity: guard.payloadIdentity,
      kind: guard.kind,
    })
    if (payload == null) throw isolationError('isolation_changed')
    if (input.verifyPayload != null) await input.verifyPayload(guard.payloadPath)
    validateReservation(guard)
    if (inspectOwnedNode({ path: guard.payloadPath, identity: guard.payloadIdentity, kind: guard.kind }) == null ||
      fs.readdirSync(guard.isolationPath).length != 1 || fs.readdirSync(guard.isolationPath)[0] != payloadBasename) {
      throw isolationError('isolation_changed')
    }
    if (inspectOwnedNode({ path: guard.payloadPath, identity: guard.payloadIdentity, kind: guard.kind }) == null) {
      throw isolationError('isolation_changed')
    }

    fs.rmSync(guard.payloadPath, { recursive: guard.kind == 'directory', force: false })
    try {
      fs.lstatSync(guard.payloadPath, { bigint: true })
      throw isolationError('isolation_changed')
    } catch (error) {
      if (error?.code == 'isolation_changed') throw error
      if (!isMissing(error)) throw isolationError('isolation_changed')
    }
    validateReservation(guard)
    if (fs.readdirSync(guard.isolationPath).length != 0) throw isolationError('isolation_changed')
    validateReservation(guard)
    fs.rmdirSync(guard.isolationPath)
    try {
      fs.lstatSync(guard.isolationPath, { bigint: true })
      throw isolationError('isolation_changed')
    } catch (error) {
      if (error?.code == 'isolation_changed') throw error
      if (!isMissing(error)) throw isolationError('isolation_changed')
    }
    revalidateDirectDirectory(guard.root)
    return { state: 'reclaimed' }
  } catch (error) {
    return { state: 'retained', error: error instanceof Error ? error : isolationError('isolation_changed') }
  }
}

module.exports = {
  reserveExclusiveIsolation,
  reopenExclusiveIsolation,
  isolateOwnedPath,
  reclaimIsolatedPayload,
}
