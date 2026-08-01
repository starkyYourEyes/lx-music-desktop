const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ownershipMarkerName = '.lx-test-storage-root-owner'

const inspect = targetPath => fs.lstatSync(targetPath, { bigint: true })
const sameNode = (left, right) => left.dev === right.dev && left.ino === right.ino

const requireFixtureBase = () => {
  const configured = process.env.LX_TEST_STORAGE_ROOT
  if (typeof configured != 'string' || configured.length == 0) {
    throw new Error('LX_TEST_STORAGE_ROOT is required')
  }
  const configuredIdentity = inspect(configured)
  if (configuredIdentity.isSymbolicLink() || !configuredIdentity.isDirectory()) {
    throw new Error('LX_TEST_STORAGE_ROOT must be a direct non-link directory')
  }
  const basePath = fs.realpathSync(configured)
  const identity = inspect(basePath)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error('LX_TEST_STORAGE_ROOT must be a direct non-link directory')
  }
  return { basePath, identity }
}

const assertOwnedChild = (ownership, childPath, verifyMarker) => {
  const currentBase = fs.realpathSync(ownership.basePath)
  const currentBaseIdentity = inspect(currentBase)
  if (currentBase != ownership.basePath || !sameNode(currentBaseIdentity, ownership.baseIdentity) ||
    path.dirname(childPath) != ownership.basePath) {
    throw new Error('Test storage root containment changed')
  }
  const childIdentity = inspect(childPath)
  if (childIdentity.isSymbolicLink() || !childIdentity.isDirectory() || !sameNode(childIdentity, ownership.childIdentity)) {
    throw new Error('Test storage root ownership changed')
  }
  if (!verifyMarker) return
  const markerPath = path.join(childPath, ownershipMarkerName)
  const markerIdentity = inspect(markerPath)
  if (markerIdentity.isSymbolicLink() || !markerIdentity.isFile() || !sameNode(markerIdentity, ownership.markerIdentity) ||
    fs.readFileSync(markerPath, 'utf8') != ownership.nonce) {
    throw new Error('Test storage root ownership marker changed')
  }
}

const createTestStorageRoot = prefix => {
  if (typeof prefix != 'string' || !/^[a-z0-9_-]+$/i.test(prefix)) {
    throw new Error('Test storage root prefix is invalid')
  }
  const { basePath, identity: baseIdentity } = requireFixtureBase()
  const rootPath = fs.mkdtempSync(path.join(basePath, `${prefix}-`))
  const childIdentity = inspect(rootPath)
  if (path.dirname(rootPath) != basePath || childIdentity.isSymbolicLink() || !childIdentity.isDirectory()) {
    throw new Error('Test storage root must be a direct non-link child')
  }
  const ownershipMarkerPath = path.join(rootPath, ownershipMarkerName)
  const nonce = crypto.randomUUID()
  fs.writeFileSync(ownershipMarkerPath, nonce, { encoding: 'utf8', flag: 'wx' })
  const markerIdentity = inspect(ownershipMarkerPath)
  const ownership = { basePath, baseIdentity, path: rootPath, childIdentity, ownershipMarkerPath, markerIdentity, nonce }
  let cleaned = false

  return {
    path: rootPath,
    ownershipMarkerPath,
    cleanup: () => {
      if (cleaned) return
      assertOwnedChild(ownership, rootPath, true)
      const quarantinePath = path.join(basePath, `.${path.basename(rootPath)}.quarantine-${crypto.randomUUID()}`)
      if (path.dirname(quarantinePath) != basePath || fs.existsSync(quarantinePath)) {
        throw new Error('Test storage root quarantine path is invalid')
      }
      fs.renameSync(rootPath, quarantinePath)
      assertOwnedChild(ownership, quarantinePath, true)
      fs.rmSync(quarantinePath, { recursive: true, force: false })
      cleaned = true
    },
  }
}

module.exports = { createTestStorageRoot }
