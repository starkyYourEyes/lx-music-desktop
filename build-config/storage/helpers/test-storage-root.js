const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const ownershipMarkerName = '.lx-test-storage-root-owner'

const sameNode = (left, right) => left.dev == right.dev && left.ino == right.ino

const requireFixtureBase = () => {
  const configured = process.env.LX_TEST_STORAGE_ROOT
  if (typeof configured != 'string' || configured.length == 0) {
    throw new Error('LX_TEST_STORAGE_ROOT is required')
  }
  const basePath = fs.realpathSync(configured)
  const identity = fs.lstatSync(basePath)
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error('LX_TEST_STORAGE_ROOT must be a direct non-link directory')
  }
  return { basePath, identity }
}

const assertOwnedChild = (ownership, verifyMarker) => {
  const currentBase = fs.realpathSync(ownership.basePath)
  const currentBaseIdentity = fs.lstatSync(currentBase)
  if (currentBase != ownership.basePath || !sameNode(currentBaseIdentity, ownership.baseIdentity) ||
    path.dirname(ownership.path) != ownership.basePath) {
    throw new Error('Test storage root containment changed')
  }
  const childIdentity = fs.lstatSync(ownership.path)
  if (childIdentity.isSymbolicLink() || !childIdentity.isDirectory() || !sameNode(childIdentity, ownership.childIdentity)) {
    throw new Error('Test storage root ownership changed')
  }
  if (!verifyMarker) return
  const markerIdentity = fs.lstatSync(ownership.ownershipMarkerPath)
  if (markerIdentity.isSymbolicLink() || !markerIdentity.isFile() || !sameNode(markerIdentity, ownership.markerIdentity) ||
    fs.readFileSync(ownership.ownershipMarkerPath, 'utf8') != ownership.nonce) {
    throw new Error('Test storage root ownership marker changed')
  }
}

const createTestStorageRoot = prefix => {
  if (typeof prefix != 'string' || !/^[a-z0-9_-]+$/i.test(prefix)) {
    throw new Error('Test storage root prefix is invalid')
  }
  const { basePath, identity: baseIdentity } = requireFixtureBase()
  const rootPath = fs.mkdtempSync(path.join(basePath, `${prefix}-`))
  const childIdentity = fs.lstatSync(rootPath)
  if (path.dirname(rootPath) != basePath || childIdentity.isSymbolicLink() || !childIdentity.isDirectory()) {
    throw new Error('Test storage root must be a direct non-link child')
  }
  const ownershipMarkerPath = path.join(rootPath, ownershipMarkerName)
  const nonce = crypto.randomUUID()
  fs.writeFileSync(ownershipMarkerPath, nonce, { encoding: 'utf8', flag: 'wx' })
  const markerIdentity = fs.lstatSync(ownershipMarkerPath)
  const ownership = { basePath, baseIdentity, path: rootPath, childIdentity, ownershipMarkerPath, markerIdentity, nonce }
  let cleaned = false

  return {
    path: rootPath,
    ownershipMarkerPath,
    cleanup: () => {
      if (cleaned) return
      assertOwnedChild(ownership, true)
      assertOwnedChild(ownership, true)
      fs.rmSync(rootPath, { recursive: true, force: false })
      cleaned = true
    },
  }
}

module.exports = { createTestStorageRoot }
