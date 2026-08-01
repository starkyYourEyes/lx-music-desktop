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
const lifecyclePath = path.join(__dirname, '../../src/main/utils/tempLifecycle.ts')
const storagePaths = loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts'))
const loadManager = (fsPromises = fsp) => loadTsModule(modulePath, {
  '@main/utils/storagePaths': storagePaths,
  'node:fs/promises': fsPromises,
})
const loadLifecycle = () => loadTsModule(lifecyclePath, {
  '@main/utils/storagePaths': loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts')),
})
const sha256 = async(targetPath) => crypto.createHash('sha256').update(await fsp.readFile(targetPath)).digest('hex')
const exists = async(targetPath) => await fsp.lstat(targetPath).then(() => true, () => false)
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex')

const createManager = async(fixture, fsPromises = fsp) => {
  const profileRoot = path.join(fixture.path, 'profile')
  const tempRoot = path.join(fixture.path, 'temp')
  const runTempRoot = path.join(tempRoot, 'run-current')
  await fsp.mkdir(runTempRoot, { recursive: true })
  const { createRunTempHandle } = loadLifecycle()
  const runTemp = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
  const { createThemeAssetManager } = loadManager(fsPromises)
  return {
    manager: createThemeAssetManager({ profileRoot, runTemp, runTempRoot }),
    profileRoot,
    runTempRoot,
    runTemp,
  }
}

const promote = async(manager, staged) => manager.promoteThemeImage(staged, async promoted => promoted)

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

    const promotedFirst = await promote(manager, await manager.stageThemeImage({ sourcePath: first }))
    const promotedSecond = await promote(manager, await manager.stageThemeImage({ sourcePath: second }))
    await manager.prepareThemeAssetStorage()

    assert.notEqual(promotedFirst.fileName, promotedSecond.fileName)
    assert.equal(await sha256(path.join(profileRoot, 'assets', 'theme-images', 'old.png')), await sha256(legacy))
    assert.deepEqual(await fsp.readFile(path.join(profileRoot, 'assets', 'theme-images', 'old.png')), pngBytes)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a replaced regular staged file and preserves the replacement', async() => {
  // Catches discard or promotion that reconstructs ownership from an opaque-looking path instead of tracked identity.
  const fixture = createTestStorageRoot('theme-regular-replacement')
  try {
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const { manager, runTempRoot, profileRoot } = await createManager(fixture)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    const stagedPath = path.join(runTempRoot, 'theme-editor', staged.stagingId)
    const replacementBytes = Buffer.concat([pngBytes, Buffer.from('replacement')])
    await fsp.unlink(stagedPath)
    await fsp.writeFile(stagedPath, replacementBytes, { flag: 'wx' })

    await assert.rejects(promote(manager, staged), /theme_stage_invalid/)
    await assert.rejects(manager.discardThemeImage({ stagingId: staged.stagingId }), /theme_stage_invalid/)

    assert.deepEqual(await fsp.readFile(stagedPath), replacementBytes)
    assert.equal(await exists(path.join(profileRoot, 'assets', 'theme-images')), false)
  } finally {
    fixture.cleanup()
  }
})

test('caps reads from one source handle when the external image grows during staging', async() => {
  // Catches staging that performs an unbounded path read or accepts bytes after the selected file grows past 8 MiB.
  const fixture = createTestStorageRoot('theme-growing-source')
  try {
    const externalImage = path.join(fixture.path, 'growing.png')
    await fsp.writeFile(externalImage, pngBytes)
    let grew = false
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        const handle = await fsp.open(targetPath, flags, mode)
        if (path.resolve(String(targetPath)) != path.resolve(externalImage) || !String(flags).includes('r')) return handle
        return {
          stat: handle.stat.bind(handle),
          async read(...args) {
            const result = await handle.read(...args)
            if (!grew) {
              grew = true
              await fsp.appendFile(externalImage, Buffer.alloc(8 * 1024 * 1024 + 1))
            }
            return result
          },
          close: handle.close.bind(handle),
        }
      },
    }
    const { manager, runTempRoot } = await createManager(fixture, injectedFs)

    await assert.rejects(manager.stageThemeImage({ sourcePath: externalImage }), /theme_image_too_large/)

    assert.equal(grew, true)
    assert.equal(await exists(path.join(runTempRoot, 'theme-editor')), true)
    assert.deepEqual(await fsp.readdir(path.join(runTempRoot, 'theme-editor')), [])
  } finally {
    fixture.cleanup()
  }
})

test('publishes only a complete durable asset and rolls it back when the commit fails', async() => {
  // Catches direct final writes and promotion that cannot reclaim its newly owned final after persistence rejects.
  const fixture = createTestStorageRoot('theme-atomic-promotion')
  try {
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const { manager, profileRoot, runTempRoot } = await createManager(fixture)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    const failure = new Error('injected_theme_store_failure')
    let commitObserved = false

    await assert.rejects(
      manager.promoteThemeImage(staged, async promoted => {
        commitObserved = true
        const assetRoot = path.join(profileRoot, 'assets', 'theme-images')
        assert.deepEqual(await fsp.readdir(assetRoot), [promoted.fileName])
        assert.deepEqual(await fsp.readFile(path.join(assetRoot, promoted.fileName)), pngBytes)
        throw failure
      }),
      error => error === failure,
    )

    assert.equal(commitObserved, true)
    assert.deepEqual(await fsp.readdir(path.join(profileRoot, 'assets', 'theme-images')), [])
    assert.equal(await exists(path.join(runTempRoot, 'theme-editor', staged.stagingId)), true)
  } finally {
    fixture.cleanup()
  }
})

test('reclaims the final when publication temp retirement fails before commit', async() => {
  // Catches a final link orphaned when publishAsset throws before returning its rollback identity to the transaction.
  const fixture = createTestStorageRoot('theme-publication-cleanup-failure')
  try {
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const retirementFailure = new Error('injected_publication_temp_retirement_failure')
    let failedRetirement = false
    const injectedFs = {
      ...fsp,
      async rename(source, target) {
        if (!failedRetirement && path.basename(String(source)).startsWith('.owned-theme-') &&
          String(target).includes('.quarantine-')) {
          failedRetirement = true
          throw retirementFailure
        }
        return fsp.rename(source, target)
      },
    }
    const { manager, profileRoot, runTempRoot } = await createManager(fixture, injectedFs)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })

    await assert.rejects(promote(manager, staged), error => error === retirementFailure)

    assert.equal(failedRetirement, true)
    assert.deepEqual(await fsp.readdir(path.join(profileRoot, 'assets', 'theme-images')), [])
    assert.equal(await exists(path.join(runTempRoot, 'theme-editor', staged.stagingId)), true)
  } finally {
    fixture.cleanup()
  }
})

test('fails closed when an existing legacy destination has different bytes', async() => {
  // Catches migration that treats any EEXIST destination as a successful copy without hash/read-back equality.
  const fixture = createTestStorageRoot('theme-legacy-conflict')
  try {
    const { manager, profileRoot } = await createManager(fixture)
    const source = path.join(profileRoot, 'theme_images', 'old.png')
    const destination = path.join(profileRoot, 'assets', 'theme-images', 'old.png')
    const conflictingBytes = Buffer.concat([pngBytes, Buffer.from('conflict')])
    await fsp.mkdir(path.dirname(source), { recursive: true })
    await fsp.mkdir(path.dirname(destination), { recursive: true })
    await fsp.writeFile(source, pngBytes)
    await fsp.writeFile(destination, conflictingBytes)

    await assert.rejects(manager.prepareThemeAssetStorage(), /theme_asset_migration_conflict/)

    assert.deepEqual(await fsp.readFile(source), pngBytes)
    assert.deepEqual(await fsp.readFile(destination), conflictingBytes)
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
