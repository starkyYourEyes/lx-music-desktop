const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')
const { createTestStorageRoot } = require('./helpers/test-storage-root.js')

const fixtureBase = path.join(__dirname, '../../.superpowers/t')
fs.mkdirSync(fixtureBase, { recursive: true })
process.env.LX_TEST_STORAGE_ROOT = fixtureBase
process.env.TEMP = fixtureBase
process.env.TMP = fixtureBase

const modulePath = path.join(__dirname, '../../src/main/services/themeAssetManager.ts')
const loadManager = () => loadTsModule(modulePath, {
  '@main/utils/storagePaths': loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts')),
})
const sha256 = async(targetPath) => crypto.createHash('sha256').update(await fsp.readFile(targetPath)).digest('hex')
const exists = async(targetPath) => await fsp.lstat(targetPath).then(() => true, () => false)
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex')

const createManager = async(fixture) => {
  const profileRoot = path.join(fixture.path, 'profile')
  const runTempRoot = path.join(fixture.path, 'temp', 'run-current')
  await fsp.mkdir(runTempRoot, { recursive: true })
  const { createThemeAssetManager } = loadManager()
  return { manager: createThemeAssetManager({ profileRoot, runTempRoot }), profileRoot, runTempRoot }
}

test('copies an external image into opaque owned staging and preserves the source', async() => {
  // Catches staging that moves, deletes, or returns the renderer-selected external path.
  const fixture = createTestStorageRoot('theme-stage')
  try {
    const externalImage = path.join(fixture.path, 'external', 'cover.png')
    await fsp.mkdir(path.dirname(externalImage), { recursive: true })
    await fsp.writeFile(externalImage, pngBytes)
    const originalHash = await sha256(externalImage)
    const { manager, runTempRoot } = await createManager(fixture)

    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    const stagedOwnedPath = path.join(runTempRoot, 'theme-editor', staged.stagingId)
    await manager.discardThemeImage({ stagingId: staged.stagingId })

    assert.equal(await sha256(externalImage), originalHash)
    assert.equal(path.dirname(staged.previewPath), path.join(runTempRoot, 'theme-editor'))
    assert.equal(await exists(stagedOwnedPath), false)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a replaced staged link before promotion', async() => {
  // Catches promotion that follows a replacement link and copies bytes from outside main-owned staging.
  const fixture = createTestStorageRoot('theme-link')
  try {
    const externalImage = path.join(fixture.path, 'external.png')
    const outsideDirectory = path.join(fixture.path, 'outside')
    const outsideFile = path.join(outsideDirectory, 'sentinel.txt')
    await fsp.writeFile(externalImage, pngBytes)
    await fsp.mkdir(outsideDirectory)
    await fsp.writeFile(outsideFile, 'preserve')
    const { manager, runTempRoot } = await createManager(fixture)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    const stagedOwnedPath = path.join(runTempRoot, 'theme-editor', staged.stagingId)
    await fsp.unlink(stagedOwnedPath)
    await fsp.symlink(process.platform == 'win32' ? outsideDirectory : outsideFile, stagedOwnedPath, process.platform == 'win32' ? 'junction' : 'file')

    await assert.rejects(manager.promoteThemeImage(staged), /theme_stage_invalid/)
    await assert.rejects(manager.discardThemeImage({ stagingId: staged.stagingId }), /theme_stage_invalid/)
    assert.equal(await fsp.readFile(outsideFile, 'utf8'), 'preserve')
  } finally {
    fixture.cleanup()
  }
})

test('promotion survives duplicate source basenames and migrates readable legacy images', async() => {
  // Catches basename collisions and a migration that changes image bytes or leaves legacy filenames unreadable.
  const fixture = createTestStorageRoot('theme-promote')
  try {
    const { manager, profileRoot } = await createManager(fixture)
    const first = path.join(fixture.path, 'one', 'cover.png')
    const second = path.join(fixture.path, 'two', 'cover.png')
    const legacy = path.join(profileRoot, 'theme_images', 'old.png')
    await fsp.mkdir(path.dirname(first), { recursive: true })
    await fsp.mkdir(path.dirname(second), { recursive: true })
    await fsp.mkdir(path.dirname(legacy), { recursive: true })
    await fsp.writeFile(first, pngBytes)
    await fsp.writeFile(second, Buffer.concat([pngBytes, Buffer.from('second')]))
    await fsp.writeFile(legacy, pngBytes)

    const promotedFirst = await manager.promoteThemeImage(await manager.stageThemeImage({ sourcePath: first }))
    const promotedSecond = await manager.promoteThemeImage(await manager.stageThemeImage({ sourcePath: second }))
    await manager.prepareThemeAssetStorage()

    assert.notEqual(promotedFirst.fileName, promotedSecond.fileName)
    assert.equal(await sha256(path.join(profileRoot, 'assets', 'theme-images', 'old.png')), await sha256(legacy))
    assert.deepEqual(await fsp.readFile(path.join(profileRoot, 'assets', 'theme-images', 'old.png')), pngBytes)
  } finally {
    fixture.cleanup()
  }
})

test('rejects invalid and oversized image input without creating durable assets', async() => {
  // Catches content validation that trusts a filename or accepts unbounded inputs.
  const fixture = createTestStorageRoot('theme-invalid')
  try {
    const { manager, profileRoot } = await createManager(fixture)
    const invalid = path.join(fixture.path, 'invalid.png')
    const oversized = path.join(fixture.path, 'large.png')
    await fsp.writeFile(invalid, 'not an image')
    await fsp.writeFile(oversized, Buffer.alloc(8 * 1024 * 1024 + 1, 0))

    await assert.rejects(manager.stageThemeImage({ sourcePath: invalid }), /theme_image_invalid/)
    await assert.rejects(manager.stageThemeImage({ sourcePath: oversized }), /theme_image_too_large/)
    assert.equal(await exists(path.join(profileRoot, 'assets', 'theme-images')), false)
  } finally {
    fixture.cleanup()
  }
})
