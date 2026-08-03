const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const {
  revalidateDirectDirectory,
} = require('./directDirectory')

const reservations = new WeakMap()
const maximumChunkBytes = 1024 * 1024

const artifactError = code => Object.assign(new Error(code), { code })
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left, right) => left.dev == right.dev && left.ino == right.ino
const isDirectBasename = basename => typeof basename == 'string' && basename.length > 0 &&
  basename != '.' && basename != '..' && path.basename(basename) == basename
const isCollision = error => error != null && typeof error == 'object' && error.code == 'EEXIST'

const artifactMetadata = artifact => {
  const metadata = reservations.get(artifact)
  if (metadata == null) throw artifactError('artifact_invalid')
  return metadata
}

const closeDescriptor = metadata => {
  if (metadata.closed) return
  metadata.closed = true
  fs.closeSync(metadata.descriptor)
}

const validateArtifact = (artifact, metadata) => {
  revalidateDirectDirectory(artifact.root)
  if (!isDirectBasename(artifact.basename) ||
    path.resolve(path.dirname(artifact.path)) != artifact.root.path ||
    path.resolve(artifact.path) != path.join(artifact.root.path, artifact.basename)) {
    throw artifactError('artifact_changed')
  }
  try {
    const descriptorStat = fs.fstatSync(metadata.descriptor, { bigint: true })
    const pathnameStat = fs.lstatSync(artifact.path, { bigint: true })
    if (!descriptorStat.isFile() || !pathnameStat.isFile() ||
      descriptorStat.nlink != 1n || pathnameStat.nlink != 1n ||
      !sameIdentity(identityOf(descriptorStat), metadata.identity) ||
      !sameIdentity(identityOf(pathnameStat), metadata.identity)) {
      throw artifactError('artifact_changed')
    }
  } catch (error) {
    if (error?.code == 'artifact_changed') throw error
    throw artifactError('artifact_changed')
  }
}

const randomToken = randomBytes => {
  const token = (randomBytes ?? crypto.randomBytes)(16)
  if (!Buffer.isBuffer(token) || token.length != 16) throw artifactError('artifact_invalid')
  return token.toString('hex')
}

const artifactBasename = (prefix, suffix, randomBytes) => {
  if (typeof prefix != 'string' || typeof suffix != 'string') throw artifactError('artifact_invalid')
  const basename = `${prefix}${randomToken(randomBytes)}${suffix}`
  if (!isDirectBasename(basename)) throw artifactError('artifact_invalid')
  return basename
}

const reservationOptions = options => {
  if (options == null || typeof options != 'object' || typeof options.artifactKind != 'string') {
    throw artifactError('artifact_invalid')
  }
  return options
}

const reserveExclusiveArtifact = (root, options) => {
  const settings = reservationOptions(options)
  for (let attempt = 0; attempt < 8; attempt++) {
    revalidateDirectDirectory(root)
    const basename = artifactBasename(settings.prefix, settings.suffix, settings.randomBytes)
    const artifactPath = path.join(root.path, basename)
    let descriptor
    try {
      descriptor = fs.openSync(artifactPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600)
    } catch (error) {
      if (isCollision(error)) continue
      throw error
    }
    try {
      const stat = fs.fstatSync(descriptor, { bigint: true })
      if (!stat.isFile() || stat.nlink != 1n) throw artifactError('artifact_changed')
      const reservation = Object.freeze({
        root,
        path: artifactPath,
        basename,
        descriptor,
        identity: Object.freeze(identityOf(stat)),
        artifactKind: settings.artifactKind,
      })
      const metadata = { descriptor, identity: reservation.identity, closed: false, complete: false }
      reservations.set(reservation, metadata)
      validateArtifact(reservation, metadata)
      return reservation
    } catch (error) {
      try { fs.closeSync(descriptor) } catch {}
      throw error
    }
  }
  throw artifactError('artifact_collision')
}

const verifiedFailure = error => {
  if (error?.code == 'direct_directory_changed' || error?.code == 'artifact_changed') return error
  return artifactError('artifact_verification_failed')
}

const writeBoundedSource = (descriptor, source, chunkBytes) => {
  if (source == null || typeof source != 'object' || !Number.isSafeInteger(source.byteLength) || source.byteLength < 0 ||
    typeof source.read != 'function') throw artifactError('artifact_verification_failed')
  let offset = 0
  while (offset < source.byteLength) {
    const maximumBytes = Math.min(chunkBytes, source.byteLength - offset)
    const chunk = source.read(offset, maximumBytes)
    if (!Buffer.isBuffer(chunk) || chunk.length == 0 || chunk.length > maximumBytes) {
      throw artifactError('artifact_verification_failed')
    }
    let written = 0
    while (written < chunk.length) {
      const count = fs.writeSync(descriptor, chunk, written, chunk.length - written)
      if (!Number.isSafeInteger(count) || count <= 0) throw artifactError('artifact_verification_failed')
      written += count
    }
    offset += chunk.length
  }
}

const hashReadDescriptor = (descriptor, expectedLength) => {
  const stat = fs.fstatSync(descriptor, { bigint: true })
  if (!stat.isFile() || stat.size != BigInt(expectedLength) || stat.nlink != 1n) throw artifactError('artifact_changed')
  const hash = crypto.createHash('sha256')
  const chunk = Buffer.allocUnsafe(maximumChunkBytes)
  let readLength = 0
  while (readLength < expectedLength) {
    const count = fs.readSync(descriptor, chunk, 0, Math.min(chunk.length, expectedLength - readLength), readLength)
    if (!Number.isSafeInteger(count) || count <= 0) throw artifactError('artifact_verification_failed')
    hash.update(chunk.subarray(0, count))
    readLength += count
  }
  if (fs.readSync(descriptor, chunk, 0, 1, readLength) != 0) throw artifactError('artifact_verification_failed')
  return hash.digest('hex')
}

const completeExclusiveArtifact = (reservation, source, options = {}) => {
  const metadata = artifactMetadata(reservation)
  if (metadata.closed || metadata.complete) throw artifactError('artifact_invalid')
  const chunkBytes = options.chunkBytes ?? maximumChunkBytes
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0 || chunkBytes > maximumChunkBytes) throw artifactError('artifact_invalid')
  let readDescriptor
  try {
    validateArtifact(reservation, metadata)
    writeBoundedSource(metadata.descriptor, source, chunkBytes)
    fs.fsyncSync(metadata.descriptor)
    validateArtifact(reservation, metadata)
    readDescriptor = fs.openSync(reservation.path, fs.constants.O_RDONLY)
    const readStat = fs.fstatSync(readDescriptor, { bigint: true })
    if (!readStat.isFile() || readStat.nlink != 1n || !sameIdentity(identityOf(readStat), metadata.identity)) {
      throw artifactError('artifact_changed')
    }
    const byteLength = source.byteLength
    const sha256 = hashReadDescriptor(readDescriptor, byteLength)
    validateArtifact(reservation, metadata)
    options.verifyReadOnly?.({ path: reservation.path, readDescriptor, sha256, byteLength })
    validateArtifact(reservation, metadata)
    const guard = Object.freeze({ ...reservation, sha256, byteLength })
    reservations.set(guard, metadata)
    metadata.complete = true
    return guard
  } catch (error) {
    try { closeDescriptor(metadata) } catch {}
    throw verifiedFailure(error)
  } finally {
    if (readDescriptor != null) {
      try { fs.closeSync(readDescriptor) } catch {}
    }
  }
}

const closeArtifactReservation = reservation => {
  const metadata = artifactMetadata(reservation)
  closeDescriptor(metadata)
}

const revalidateImmutableArtifact = guard => {
  const metadata = artifactMetadata(guard)
  if (!metadata.complete || metadata.closed) throw artifactError('artifact_invalid')
  validateArtifact(guard, metadata)
}

const closeArtifactGuard = guard => {
  const metadata = artifactMetadata(guard)
  if (!metadata.complete) throw artifactError('artifact_invalid')
  closeDescriptor(metadata)
}

module.exports = {
  reserveExclusiveArtifact,
  completeExclusiveArtifact,
  closeArtifactReservation,
  revalidateImmutableArtifact,
  closeArtifactGuard,
}
