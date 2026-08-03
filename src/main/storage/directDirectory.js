const fs = require('node:fs')
const path = require('node:path')

const guardMetadata = new WeakMap()

const directError = code => Object.assign(new Error(code), { code })
const isMissing = error => error != null && typeof error == 'object' && error.code == 'ENOENT'
const identityOf = stat => ({ dev: String(stat.dev), ino: String(stat.ino) })
const sameIdentity = (left, right) => left.dev == right.dev && left.ino == right.ino
const pathKey = (pathApi, value) => {
  const normalized = pathApi.normalize(pathApi.resolve(value))
  return process.platform == 'win32' ? normalized.toLowerCase() : normalized
}
const samePath = (pathApi, left, right) => pathKey(pathApi, left) == pathKey(pathApi, right)
const realpath = (fsApi, value) => {
  const native = fsApi.realpathSync.native ?? fsApi.realpathSync
  return native(value)
}
const directBasename = (pathApi, basename) =>
  typeof basename == 'string' && basename.length > 0 && basename != '.' && basename != '..' &&
  pathApi.basename(basename) == basename

const inspectDirectory = (fsApi, directoryPath) => {
  const stat = fsApi.lstatSync(directoryPath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw directError('direct_directory_invalid')
  return stat
}

const validateAncestry = (fsApi, pathApi, directoryPath) => {
  const ancestry = []
  let current = directoryPath
  while (true) {
    const stat = inspectDirectory(fsApi, current)
    ancestry.unshift({ path: current, identity: identityOf(stat) })
    const parent = pathApi.dirname(current)
    if (parent == current) return ancestry
    current = parent
  }
}

const metadataFor = guard => {
  const metadata = guardMetadata.get(guard)
  if (metadata == null) throw directError('direct_directory_invalid')
  return metadata
}

const validateGuard = guard => {
  const { fsApi, pathApi } = metadataFor(guard)
  const resolved = pathApi.resolve(guard.path)
  if (!samePath(pathApi, resolved, guard.path)) throw directError('direct_directory_changed')
  let stat
  let descriptorStat
  try {
    const ancestry = validateAncestry(fsApi, pathApi, resolved)
    stat = ancestry.at(-1)?.identity
    descriptorStat = identityOf(fsApi.fstatSync(guard.descriptor, { bigint: true }))
    const resolvedRealPath = realpath(fsApi, resolved)
    if (stat == null || !sameIdentity(stat, guard.identity) ||
      !sameIdentity(descriptorStat, guard.identity) ||
      !samePath(pathApi, resolvedRealPath, resolved) ||
      ancestry.length != guard.ancestry.length ||
      ancestry.some((entry, index) => !samePath(pathApi, entry.path, guard.ancestry[index].path) ||
        !sameIdentity(entry.identity, guard.ancestry[index].identity))) {
      throw directError('direct_directory_changed')
    }
  } catch (error) {
    if (error?.code == 'direct_directory_changed') throw error
    throw directError('direct_directory_changed')
  }
}

const validateDirectDirectory = (directoryPath, options = {}) => {
  const fsApi = options.fsApi ?? fs
  const pathApi = options.pathApi ?? path
  const resolved = pathApi.resolve(directoryPath)
  let descriptor
  try {
    const ancestry = validateAncestry(fsApi, pathApi, resolved)
    const stat = ancestry.at(-1)?.identity
    const resolvedRealPath = realpath(fsApi, resolved)
    if (stat == null || !samePath(pathApi, resolvedRealPath, resolved)) throw directError('direct_directory_invalid')
    descriptor = fsApi.openSync(resolved, 'r')
    const descriptorIdentity = identityOf(fsApi.fstatSync(descriptor, { bigint: true }))
    if (!sameIdentity(stat, descriptorIdentity)) throw directError('direct_directory_changed')
    const guard = Object.freeze({
      path: resolved,
      realPath: resolvedRealPath,
      descriptor,
      identity: Object.freeze({ ...stat }),
      ancestry: Object.freeze(ancestry.map(entry => Object.freeze({
        path: entry.path,
        identity: Object.freeze({ ...entry.identity }),
      }))),
    })
    guardMetadata.set(guard, { fsApi, pathApi })
    return guard
  } catch (error) {
    if (descriptor != null) {
      try { fsApi.closeSync(descriptor) } catch {}
    }
    if (error?.code == 'direct_directory_changed' || error?.code == 'direct_directory_invalid') throw error
    throw directError('direct_directory_invalid')
  }
}

const observeDirectChild = (parent, basename) => {
  if (!directBasename(path, basename)) throw directError('direct_directory_invalid')
  const { fsApi, pathApi } = metadataFor(parent)
  if (!directBasename(pathApi, basename)) throw directError('direct_directory_invalid')
  validateGuard(parent)
  const childPath = pathApi.join(parent.path, basename)
  try {
    fsApi.lstatSync(childPath, { bigint: true })
  } catch (error) {
    if (!isMissing(error)) throw directError('direct_directory_invalid')
    revalidateDirectDirectory(parent)
    return Object.freeze({ status: 'absent', parent, path: childPath, basename })
  }
  const guard = validateDirectDirectory(childPath, { fsApi, pathApi })
  revalidateDirectDirectory(parent)
  return Object.freeze({ status: 'present', guard })
}

const createDirectChildDirectory = (parent, basename, options = {}) => {
  const { fsApi, pathApi } = metadataFor(parent)
  const observed = observeDirectChild(parent, basename)
  if (observed.status == 'present') return observed.guard
  try {
    fsApi.mkdirSync(observed.path, { mode: options.mode })
  } catch (error) {
    if (!error || error.code != 'EEXIST') throw error
  }
  revalidateDirectDirectory(parent)
  const child = validateDirectDirectory(observed.path, { fsApi, pathApi })
  try {
    revalidateDirectDirectory(parent)
    revalidateDirectDirectory(child)
    return child
  } catch (error) {
    closeDirectDirectory(child)
    throw error
  }
}

const revalidateDirectDirectory = guard => validateGuard(guard)

const closeDirectDirectory = guard => {
  const { fsApi } = metadataFor(guard)
  guardMetadata.delete(guard)
  fsApi.closeSync(guard.descriptor)
}

module.exports = {
  validateDirectDirectory,
  observeDirectChild,
  createDirectChildDirectory,
  revalidateDirectDirectory,
  closeDirectDirectory,
}
