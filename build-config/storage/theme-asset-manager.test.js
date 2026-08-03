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
const loadManager = (fsPromises = fsp, fsSync = fs) => loadTsModule(modulePath, {
  '@main/utils/storagePaths': storagePaths,
  'node:fs': fsSync,
  'node:fs/promises': fsPromises,
})
const loadLifecycle = (fsPromises = fsp) => loadTsModule(lifecyclePath, {
  '@main/utils/storagePaths': loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts')),
  'node:fs/promises': fsPromises,
})
const sha256 = async(targetPath) => crypto.createHash('sha256').update(await fsp.readFile(targetPath)).digest('hex')
const exists = async(targetPath) => await fsp.lstat(targetPath).then(() => true, () => false)
const pngBytes = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc000000301010018dd8db10000000049454e44ae426082', 'hex')
const linuxDescriptorFd = targetPath => {
  const match = String(targetPath).match(/[\\/]proc[\\/]self[\\/]fd[\\/](\d+)[\\/]/)
  return match == null ? null : Number(match[1])
}
const isLinuxDescriptorPath = targetPath => linuxDescriptorFd(targetPath) != null
const mapLinuxDescriptorPath = (targetPath, ownedChild, descriptorState) => {
  const descriptorFd = linuxDescriptorFd(targetPath)
  if (descriptorFd == null) return targetPath
  if (descriptorState != null) {
    assert.equal(descriptorFd, descriptorState.fd)
    assert.equal(descriptorState.closed, false)
  }
  return path.join(ownedChild, path.basename(String(targetPath)))
}
const trackDirectoryHandle = (handle, descriptorState) => {
  descriptorState.fd = handle.fd
  descriptorState.closed = false
  return {
    fd: handle.fd,
    stat: handle.stat.bind(handle),
    async close() {
      descriptorState.closed = true
      await handle.close()
    },
  }
}

const createLinuxStageAdapter = (hooks = {}) => {
  let stagingChild
  const directoryDescriptor = { fd: null, closed: true }
  const stageDescriptor = { path: null, closed: true }
  const isStagePath = targetPath => stagingChild != null &&
    path.dirname(String(targetPath)) == stagingChild && /^[a-f0-9]{32}$/i.test(path.basename(String(targetPath)))
  const fileSystem = {
    ...fsp,
    async open(targetPath, flags, mode) {
      if (!isLinuxDescriptorPath(targetPath) && path.basename(String(targetPath)) == 'theme-editor' &&
        String(flags) == 'r') {
        stagingChild = String(targetPath)
        return trackDirectoryHandle(await fsp.open(targetPath, flags, mode), directoryDescriptor)
      }
      const actualPath = mapLinuxDescriptorPath(targetPath, stagingChild, directoryDescriptor)
      const handle = await fsp.open(actualPath, flags, mode)
      if (!isStagePath(actualPath) || String(flags) != 'r') return handle
      stageDescriptor.path = String(actualPath)
      stageDescriptor.closed = false
      await hooks.afterStageDescriptorOpen?.({ stagePath: String(actualPath), handle })
      return {
        fd: handle.fd,
        stat: handle.stat.bind(handle),
        read: handle.read.bind(handle),
        async close() {
          stageDescriptor.closed = true
          await handle.close()
        },
      }
    },
    async lstat(targetPath, options) {
      const actualPath = mapLinuxDescriptorPath(targetPath, stagingChild, directoryDescriptor)
      if (isStagePath(actualPath)) {
        await hooks.beforeStagePathInspect?.({
          stagePath: String(actualPath),
          descriptorOpen: stageDescriptor.path == String(actualPath) && !stageDescriptor.closed,
        })
      }
      return fsp.lstat(actualPath, options)
    },
  }
  return { fileSystem, stageDescriptor }
}

const createManager = async(fixture, fsPromises = fsp, fsSync = fs) => {
  const profileRoot = path.join(fixture.path, 'profile')
  const tempRoot = path.join(fixture.path, 'temp')
  await fsp.mkdir(tempRoot, { recursive: true })
  const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle(fsPromises)
  const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
  const runTempRoot = reservation.runTempRoot
  const runTemp = await createRunTempHandle({ reservation })
  const { createThemeAssetManager } = loadManager(fsPromises, fsSync)
  return {
    manager: createThemeAssetManager({ profileRoot, runTemp, runTempRoot }),
    profileRoot,
    runTempRoot,
    runTemp,
  }
}

test('prepares and adopts run temp through the manager injected filesystem', async() => {
  const fixture = createTestStorageRoot('theme-lifecycle-injected-fs')
  try {
    let runDirectoryCreates = 0
    const injectedFs = {
      ...fsp,
      async mkdir(targetPath, options) {
        if (path.basename(String(targetPath)).startsWith('run-')) runDirectoryCreates++
        return fsp.mkdir(targetPath, options)
      },
    }
    await createManager(fixture, injectedFs)

    assert.equal(runDirectoryCreates, 1)
  } finally {
    fixture.cleanup()
  }
})

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
    if (process.platform == 'linux') {
      assert.equal(path.dirname(staged.previewPath), path.join(runTempRoot, 'theme-editor'))
    } else {
      assert.match(staged.previewPath, /^data:image\/png;base64,/)
    }
    assert.equal(await exists(stagedOwnedPath), false)
  } finally {
    fixture.cleanup()
  }
})

test('rejects a replaced staged link before promotion', {
  skip: process.platform != 'linux',
}, async() => {
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

test('rejects a replaced regular staged file and preserves the replacement', {
  skip: process.platform != 'linux',
}, async() => {
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

test('copies a disk stage only from its retained read descriptor', async() => {
  // Catches promotion that closes the stage descriptor before proving the pathname still names that descriptor.
  const fixture = createTestStorageRoot('theme-descriptor-replacement')
  const originalPlatform = process.platform
  const parkedStage = path.join(fixture.path, 'parked-stage')
  const replacementBytes = Buffer.concat([pngBytes, Buffer.from('replacement')])
  let replaced = false
  let checkedWhileDescriptorOpen = false
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const adapter = createLinuxStageAdapter({
      async afterStageDescriptorOpen({ stagePath }) {
        if (replaced) return
        replaced = true
        await fsp.rename(stagePath, parkedStage)
        await fsp.writeFile(stagePath, replacementBytes, { flag: 'wx' })
      },
      async beforeStagePathInspect({ descriptorOpen }) {
        if (replaced && descriptorOpen) checkedWhileDescriptorOpen = true
      },
    })
    const { manager } = await createManager(fixture, adapter.fileSystem)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })

    await assert.rejects(promote(manager, staged), /theme_stage_invalid/)

    assert.equal(replaced, true)
    assert.equal(checkedWhileDescriptorOpen, true)
    assert.deepEqual(await fsp.readFile(staged.previewPath), replacementBytes)
    assert.deepEqual(await fsp.readFile(parkedStage), pngBytes)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('revalidates the stage pathname before and after durable copy', async() => {
  // Catches publication that verifies the stage only before reserving the durable artifact.
  const fixture = createTestStorageRoot('theme-stage-copy-revalidation')
  const originalPlatform = process.platform
  let profileRoot
  let beforeCopyChecks = 0
  let afterCopyChecks = 0
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const adapter = createLinuxStageAdapter({
      async beforeStagePathInspect({ descriptorOpen }) {
        if (!descriptorOpen || profileRoot == null) return
        const assetRoot = path.join(profileRoot, 'assets', 'theme-images')
        const durableExists = await fsp.readdir(assetRoot).then(entries => entries.some(name => name.endsWith('.img')), () => false)
        if (durableExists) afterCopyChecks++
        else beforeCopyChecks++
      },
    })
    const created = await createManager(fixture, adapter.fileSystem)
    profileRoot = created.profileRoot
    const staged = await created.manager.stageThemeImage({ sourcePath: externalImage })

    await promote(created.manager, staged)

    assert.ok(beforeCopyChecks > 0)
    assert.ok(afterCopyChecks > 0)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('preserves a stage replacement and never invokes settings commit', async() => {
  // Catches a stage pathname race after durable publication but before stage retirement.
  const fixture = createTestStorageRoot('theme-stage-replacement-before-settings')
  const originalPlatform = process.platform
  const replacementBytes = Buffer.concat([pngBytes, Buffer.from('replacement')])
  let profileRoot
  let replaced = false
  let commitCalled = false
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    const parkedStage = path.join(fixture.path, 'parked-stage')
    await fsp.writeFile(externalImage, pngBytes)
    const adapter = createLinuxStageAdapter({
      async beforeStagePathInspect({ stagePath, descriptorOpen }) {
        if (!descriptorOpen || profileRoot == null) return
        const assetRoot = path.join(profileRoot, 'assets', 'theme-images')
        const durableExists = await fsp.readdir(assetRoot).then(entries => entries.some(name => name.endsWith('.img')), () => false)
        if (replaced || !durableExists) return
        replaced = true
        await fsp.rename(stagePath, parkedStage)
        await fsp.writeFile(stagePath, replacementBytes, { flag: 'wx' })
      },
    })
    const created = await createManager(fixture, adapter.fileSystem)
    profileRoot = created.profileRoot
    const staged = await created.manager.stageThemeImage({ sourcePath: externalImage })

    await assert.rejects(
      created.manager.promoteThemeImage(staged, async promoted => {
        commitCalled = true
        return promoted
      }),
      /theme_stage_invalid/,
    )

    assert.equal(replaced, true)
    assert.equal(commitCalled, false)
    assert.deepEqual(await fsp.readFile(staged.previewPath), replacementBytes)
    assert.deepEqual(await fsp.readdir(path.join(profileRoot, 'assets', 'theme-images')), [])
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('retires the disk stage before invoking the settings commit', async() => {
  // Catches commit-before-retirement ordering that leaves a retryable stage after settings failure.
  const fixture = createTestStorageRoot('theme-retire-before-settings')
  const originalPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const adapter = createLinuxStageAdapter()
    const { manager } = await createManager(fixture, adapter.fileSystem)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    const events = []

    await manager.promoteThemeImage(staged, async promoted => {
      events.push('settings')
      assert.equal(await exists(staged.previewPath), false)
      assert.equal(await exists(promoted.previewPath), true)
      return promoted
    })

    assert.deepEqual(events, ['settings'])
    await assert.rejects(promote(manager, staged), /theme_stage_invalid/)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
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
    const stagingChild = path.join(runTempRoot, 'theme-editor')
    if (process.platform == 'linux') {
      assert.equal(await exists(stagingChild), true)
      assert.deepEqual(await fsp.readdir(stagingChild), [])
    } else {
      assert.equal(await exists(stagingChild), false)
    }
  } finally {
    fixture.cleanup()
  }
})

test('pins Linux staging creation to the owned child across a parent swap and restore', async() => {
  // Catches validation-before-open that writes image bytes through a replacement theme-editor pathname.
  const fixture = createTestStorageRoot('theme-stage-parent-race')
  const originalPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    let stagingChild
    let parkedChild
    const outsideChild = path.join(fixture.path, 'outside-theme-editor')
    let parkedSentinel
    const outsideSentinel = path.join(outsideChild, 'outside-sentinel.txt')
    await fsp.writeFile(externalImage, pngBytes)
    await fsp.mkdir(outsideChild)
    await fsp.writeFile(outsideSentinel, 'preserve-outside')
    let swapped = false
    let transientOutsideCreates = 0
    let transientOutsideWriteBytes = 0
    const descriptorState = { fd: null, closed: true }
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (String(targetPath) == stagingChild && String(flags) == 'r') {
          return trackDirectoryHandle(await fsp.open(targetPath, flags, mode), descriptorState)
        }
        if (!swapped && stagingChild != null && String(flags) == 'wx') {
          swapped = true
          await fsp.rename(stagingChild, parkedChild)
          await fsp.symlink(outsideChild, stagingChild, originalPlatform == 'win32' ? 'junction' : 'dir')
          let handle
          let stablePath
          let descriptorCreate = false
          try {
            descriptorCreate = isLinuxDescriptorPath(targetPath)
            const outputName = path.basename(String(targetPath))
            const openPath = descriptorCreate
              ? mapLinuxDescriptorPath(targetPath, parkedChild, descriptorState)
              : targetPath
            stablePath = path.join(descriptorCreate ? stagingChild : outsideChild, outputName)
            const realHandle = await fsp.open(openPath, flags, mode)
            if (!descriptorCreate) transientOutsideCreates++
            await realHandle.close()
          } finally {
            if (originalPlatform == 'win32') await fsp.rmdir(stagingChild)
            else await fsp.unlink(stagingChild)
            await fsp.rename(parkedChild, stagingChild)
          }
          handle = {
            stat: async() => await fsp.lstat(stablePath, { bigint: true }),
            writeFile: async data => {
              if (!descriptorCreate) transientOutsideWriteBytes += data.length
              await fsp.writeFile(stablePath, data)
            },
            sync: async() => {
              const syncHandle = await fsp.open(stablePath, 'r+')
              try { await syncHandle.sync() } finally { await syncHandle.close() }
            },
            close: async() => {},
          }
          return handle
        }
        return fsp.open(targetPath, flags, mode)
      },
    }
    const created = await createManager(fixture, injectedFs)
    stagingChild = path.join(created.runTempRoot, 'theme-editor')
    parkedChild = `${stagingChild}.parked`
    parkedSentinel = path.join(stagingChild, 'parked-sentinel.txt')
    await created.runTemp.createChild('theme-editor')
    await fsp.writeFile(parkedSentinel, 'preserve-parked')

    const outcome = await created.manager.stageThemeImage({ sourcePath: externalImage })
      .then(staged => ({ staged }), error => ({ error }))
    const outsideEntries = await fsp.readdir(outsideChild)

    assert.equal(swapped, true)
    assert.equal(descriptorState.closed, true)
    assert.equal(transientOutsideCreates, 0)
    assert.equal(transientOutsideWriteBytes, 0)
    assert.deepEqual(outsideEntries, ['outside-sentinel.txt'])
    assert.equal(await fsp.readFile(outsideSentinel, 'utf8'), 'preserve-outside')
    assert.equal(await fsp.readFile(parkedSentinel, 'utf8'), 'preserve-parked')
    if (outcome.error) throw outcome.error
    assert.deepEqual(await fsp.readFile(path.join(stagingChild, outcome.staged.stagingId)), pngBytes)
    await created.manager.discardThemeImage({ stagingId: outcome.staged.stagingId })
    assert.deepEqual(await fsp.readdir(stagingChild), ['parked-sentinel.txt'])
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('uses a Linux directory descriptor path instead of a lexical staging create', async() => {
  // Catches implementations that open theme-editor but still create through its mutable published pathname.
  const fixture = createTestStorageRoot('theme-stage-linux-descriptor')
  const originalPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    let stagingChild
    await fsp.writeFile(externalImage, pngBytes)
    let descriptorCreates = 0
    let lexicalCreates = 0
    const descriptorState = { fd: null, closed: true }
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (String(targetPath) == stagingChild && String(flags) == 'r') {
          return trackDirectoryHandle(await fsp.open(targetPath, flags, mode), descriptorState)
        }
        if (String(flags) == 'wx') {
          if (isLinuxDescriptorPath(targetPath)) descriptorCreates++
          else if (path.dirname(String(targetPath)) == stagingChild) lexicalCreates++
        }
        return fsp.open(mapLinuxDescriptorPath(targetPath, stagingChild, descriptorState), flags, mode)
      },
    }
    const { manager, runTempRoot } = await createManager(fixture, injectedFs)
    stagingChild = path.join(runTempRoot, 'theme-editor')

    const staged = await manager.stageThemeImage({ sourcePath: externalImage })

    assert.equal(descriptorCreates, 1)
    assert.equal(lexicalCreates, 0)
    assert.equal(descriptorState.closed, true)
    assert.equal(path.dirname(staged.previewPath), stagingChild)
    assert.deepEqual(await fsp.readFile(staged.previewPath), pngBytes)
    await manager.discardThemeImage({ stagingId: staged.stagingId })
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('keeps Windows and Darwin stages in bounded main memory without staging files', async() => {
  // Catches non-Linux staging that reaches a lexical wx or exposes the selected external source path.
  const originalPlatform = process.platform
  const fixtures = []
  try {
    for (const platform of ['win32', 'darwin']) {
      Object.defineProperty(process, 'platform', { value: platform })
      const fixture = createTestStorageRoot(`theme-stage-memory-${platform}`)
      fixtures.push(fixture)
      const externalImage = path.join(fixture.path, 'external.png')
      const stagingChild = path.join(fixture.path, 'temp', 'run-current', 'theme-editor')
      await fsp.writeFile(externalImage, pngBytes)
      let staging = false
      let stagingExclusiveCreates = 0
      const injectedFs = {
        ...fsp,
        async open(targetPath, flags, mode) {
          if (staging && String(flags) == 'wx') stagingExclusiveCreates++
          return fsp.open(targetPath, flags, mode)
        },
      }
      const { manager, profileRoot } = await createManager(fixture, injectedFs)

      staging = true
      const cancelled = await manager.stageThemeImage({ sourcePath: externalImage })
      const promotedStage = await manager.stageThemeImage({ sourcePath: externalImage })
      staging = false

      assert.equal(stagingExclusiveCreates, 0)
      assert.match(cancelled.stagingId, /^[a-f0-9]{32}$/i)
      assert.match(cancelled.previewPath, /^data:image\/png;base64,/)
      assert.equal(cancelled.previewPath.includes(externalImage), false)
      assert.deepEqual(await fsp.readFile(externalImage), pngBytes)
      assert.deepEqual(await exists(stagingChild) ? await fsp.readdir(stagingChild) : [], [])

      await manager.discardThemeImage({ stagingId: cancelled.stagingId })
      await assert.rejects(promote(manager, cancelled), /theme_stage_invalid/)
      const promoted = await promote(manager, promotedStage)
      assert.deepEqual(await fsp.readFile(path.join(profileRoot, 'assets', 'theme-images', promoted.fileName)), pngBytes)
      assert.deepEqual(await exists(stagingChild) ? await fsp.readdir(stagingChild) : [], [])
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    for (const fixture of fixtures) fixture.cleanup()
  }
})

test('bounds non-Linux memory stages and releases capacity on discard', async() => {
  const fixture = createTestStorageRoot('theme-stage-memory-capacity')
  const originalPlatform = process.platform
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const { manager } = await createManager(fixture)
    const staged = []
    for (let index = 0; index < 8; index++) {
      staged.push(await manager.stageThemeImage({ sourcePath: externalImage }))
    }

    await assert.rejects(manager.stageThemeImage({ sourcePath: externalImage }), /theme_stage_capacity/)
    await manager.discardThemeImage({ stagingId: staged[0].stagingId })
    const replacement = await manager.stageThemeImage({ sourcePath: externalImage })

    assert.match(replacement.previewPath, /^data:image\/png;base64,/)
    assert.deepEqual(await fsp.readFile(externalImage), pngBytes)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
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
    assert.equal(await exists(path.join(runTempRoot, 'theme-editor', staged.stagingId)), false)
    await assert.rejects(promote(manager, staged), /theme_stage_invalid/)
    await assert.rejects(manager.discardThemeImage({ stagingId: staged.stagingId }), /theme_stage_invalid/)
  } finally {
    fixture.cleanup()
  }
})

test('rolls back the exact durable target through isolation', async() => {
  // Catches rollback that unlinks a stable pathname instead of moving and reclaiming the captured artifact.
  const fixture = createTestStorageRoot('theme-exact-durable-rollback')
  const originalRenameSync = fs.renameSync
  let promotedPath
  let isolatedPath
  try {
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    fs.renameSync = function(source, target) {
      if (promotedPath != null && path.resolve(String(source)) == path.resolve(promotedPath)) isolatedPath = String(target)
      return originalRenameSync.call(this, source, target)
    }
    const { manager, profileRoot } = await createManager(fixture)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    const failure = new Error('injected_settings_failure')

    await assert.rejects(
      manager.promoteThemeImage(staged, async promoted => {
        promotedPath = promoted.previewPath
        throw failure
      }),
      error => error === failure,
    )

    assert.match(isolatedPath, /\.isolate-[a-f0-9]{32}[\\/]payload$/i)
    assert.deepEqual(await fsp.readdir(path.join(profileRoot, 'assets', 'theme-images')), [])
    assert.equal(await exists(path.dirname(isolatedPath)), false)
    await assert.rejects(promote(manager, staged), /theme_stage_invalid/)
  } finally {
    fs.renameSync = originalRenameSync
    fixture.cleanup()
  }
})

test('retains an ambiguous durable rollback target without unlinking it', async() => {
  // Catches rollback that deletes a replacement raced into the durable artifact pathname.
  const fixture = createTestStorageRoot('theme-ambiguous-durable-rollback')
  const originalRenameSync = fs.renameSync
  const replacementBytes = Buffer.from('durable replacement')
  let promotedPath
  let isolationPath
  try {
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    fs.renameSync = function(source, target) {
      const result = originalRenameSync.call(this, source, target)
      if (promotedPath != null && path.resolve(String(source)) == path.resolve(promotedPath)) {
        isolationPath = path.dirname(String(target))
        fs.writeFileSync(source, replacementBytes, { flag: 'wx' })
      }
      return result
    }
    const { manager } = await createManager(fixture)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })

    await assert.rejects(
      manager.promoteThemeImage(staged, async promoted => {
        promotedPath = promoted.previewPath
        throw new Error('injected_settings_failure')
      }),
      /theme_asset_invalid/,
    )

    assert.deepEqual(await fsp.readFile(promotedPath), replacementBytes)
    assert.deepEqual(await fsp.readFile(path.join(isolationPath, 'payload')), pngBytes)
    assert.deepEqual(await fsp.readdir(isolationPath), ['payload'])
  } finally {
    fs.renameSync = originalRenameSync
    fixture.cleanup()
  }
})

test('publishes and rolls back when the filesystem adapter has no link method', async() => {
  // Catches durable publication or legacy migration that still depends on hard-link support.
  const fixture = createTestStorageRoot('theme-no-link-adapter')
  try {
    const fileSystem = { ...fsp }
    const syncFileSystem = { ...fs }
    delete fileSystem.link
    delete syncFileSystem.link
    delete syncFileSystem.linkSync
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    const { manager, profileRoot } = await createManager(fixture, fileSystem, syncFileSystem)
    const legacy = path.join(profileRoot, 'theme_images', 'old.png')
    await fsp.mkdir(path.dirname(legacy), { recursive: true })
    await fsp.writeFile(legacy, pngBytes)

    await manager.prepareThemeAssetStorage()
    const promoted = await promote(manager, await manager.stageThemeImage({ sourcePath: externalImage }))
    const failedStage = await manager.stageThemeImage({ sourcePath: externalImage })
    const failure = new Error('injected_settings_failure')
    await assert.rejects(
      manager.promoteThemeImage(failedStage, async() => { throw failure }),
      error => error === failure,
    )

    assert.deepEqual(await fsp.readFile(path.join(profileRoot, 'assets', 'theme-images', 'old.png')), pngBytes)
    assert.deepEqual(await fsp.readFile(promoted.previewPath), pngBytes)
    assert.deepEqual(
      (await fsp.readdir(path.join(profileRoot, 'assets', 'theme-images'))).sort(),
      ['old.png', promoted.fileName].sort(),
    )
    await assert.rejects(promote(manager, failedStage), /theme_stage_invalid/)
  } finally {
    fixture.cleanup()
  }
})

test('discard isolates and reclaims the exact disk stage', async() => {
  // Catches discard that directly renames/unlinks the stable stage pathname.
  const fixture = createTestStorageRoot('theme-discard-exact-stage')
  const originalPlatform = process.platform
  const originalRenameSync = fs.renameSync
  let stagedPath
  let isolatedPath
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    fs.renameSync = function(source, target) {
      if (stagedPath != null && path.resolve(String(source)) == path.resolve(stagedPath)) isolatedPath = String(target)
      return originalRenameSync.call(this, source, target)
    }
    const adapter = createLinuxStageAdapter()
    const { manager } = await createManager(fixture, adapter.fileSystem)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    stagedPath = staged.previewPath

    await manager.discardThemeImage({ stagingId: staged.stagingId })

    assert.match(isolatedPath, /\.isolate-[a-f0-9]{32}[\\/]payload$/i)
    assert.equal(await exists(staged.previewPath), false)
    assert.equal(await exists(path.dirname(isolatedPath)), false)
    await assert.rejects(manager.discardThemeImage({ stagingId: staged.stagingId }), /theme_stage_invalid/)
  } finally {
    fs.renameSync = originalRenameSync
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('discard preserves a replacement raced into stage isolation', async() => {
  // Catches discard that restores over or unlinks a replacement after isolating the exact stage.
  const fixture = createTestStorageRoot('theme-discard-stage-replacement')
  const originalPlatform = process.platform
  const originalRenameSync = fs.renameSync
  const replacementBytes = Buffer.from('stage replacement')
  let stagedPath
  let isolationPath
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    const externalImage = path.join(fixture.path, 'external.png')
    await fsp.writeFile(externalImage, pngBytes)
    fs.renameSync = function(source, target) {
      const result = originalRenameSync.call(this, source, target)
      if (stagedPath != null && path.resolve(String(source)) == path.resolve(stagedPath)) {
        isolationPath = path.dirname(String(target))
        fs.writeFileSync(source, replacementBytes, { flag: 'wx' })
      }
      return result
    }
    const adapter = createLinuxStageAdapter()
    const { manager } = await createManager(fixture, adapter.fileSystem)
    const staged = await manager.stageThemeImage({ sourcePath: externalImage })
    stagedPath = staged.previewPath

    await assert.rejects(manager.discardThemeImage({ stagingId: staged.stagingId }), /theme_stage_invalid/)

    assert.deepEqual(await fsp.readFile(stagedPath), replacementBytes)
    assert.deepEqual(await fsp.readFile(path.join(isolationPath, 'payload')), pngBytes)
    assert.deepEqual(await fsp.readdir(isolationPath), ['payload'])
  } finally {
    fs.renameSync = originalRenameSync
    Object.defineProperty(process, 'platform', { value: originalPlatform })
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
