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

const lifecyclePath = path.join(__dirname, '../../src/main/utils/tempLifecycle.ts')
const workerPath = path.join(__dirname, '../../src/renderer/worker/main/music.ts')
const globalDataPath = path.join(__dirname, '../../src/renderer/core/globalData.ts')
const storagePaths = loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts'))
const loadLifecycle = () => loadTsModule(lifecyclePath, { '@main/utils/storagePaths': storagePaths })

const identityOf = async(targetPath) => {
  const stat = await fsp.lstat(targetPath, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

const createOwnedArtworkConfig = async(fixture) => {
  const tempRoot = path.join(fixture.path, 'temp')
  const runTempRoot = path.join(tempRoot, 'run-current')
  await fsp.mkdir(runTempRoot, { recursive: true })
  const { createRunTempHandle } = loadLifecycle()
  const handle = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
  const childPath = await handle.createChild('local-artwork')
  return {
    handle,
    config: {
      runTempRoot,
      runTempIdentity: await identityOf(runTempRoot),
      childPath,
      childIdentity: await identityOf(childPath),
    },
  }
}

const createPicture = byte => ({
  data: Buffer.alloc(400_001, byte),
  format: 'image/png',
})

const loadWorker = (pictureForPath, fsPromises = fsp) => loadTsModule(workerPath, {
  '@renderer/utils/music': {
    getLocalMusicFilePic: async filePath => pictureForPath(filePath),
    getLocalMusicFileLyric: async() => null,
  },
  'node:fs/promises': fsPromises,
})

test('a large artwork request waits for one-time owned-child configuration before writing', async() => {
  // Catches fire-and-forget worker setup that lets an early request fall back before configuration arrives.
  const fixture = createTestStorageRoot('worker-ordering')
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    const worker = loadWorker(() => createPicture(0x31))
    const outputPromise = worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))
    let settled = false
    const observedOutput = outputPromise.then(output => {
      settled = true
      return output
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)

    await worker.configureRunTempRoot(config)
    const output = await observedOutput

    if (process.platform == 'linux') {
      assert.equal(path.dirname(output), config.childPath)
      assert.deepEqual(await fsp.readFile(output), createPicture(0x31).data)
    } else {
      assert.match(output, /^data:image\/png;base64,/)
      assert.deepEqual(await fsp.readdir(config.childPath), [])
    }
  } finally {
    fixture.cleanup()
  }
})

test('a failed configuration signal releases early artwork into inline fallback', async() => {
  // Catches a rejected setup path that leaves the worker configuration promise pending forever.
  const worker = loadWorker(() => createPicture(0x30))
  const outputPromise = worker.getMusicFilePic('song.mp3')

  await worker.configureRunTempRoot(null)
  const output = await outputPromise

  assert.match(output, /^data:image\/png;base64,/)
})

test('renderer startup settles worker configuration when owned-child IPC rejects', async() => {
  // Catches renderer bootstrap that logs getRunTempRoot failure without releasing queued worker calls.
  const configured = []
  const originalWindow = global.window
  const originalConsoleError = console.error
  global.window = { dt: false }
  console.error = () => {}
  try {
    loadTsModule(globalDataPath, {
      '@renderer/worker': () => ({
        main: {
          configureRunTempRoot: async ownership => { configured.push(ownership) },
        },
      }),
      '@renderer/utils/ipc': {
        getRunTempRoot: async() => { throw new Error('run_temp_ipc_failed') },
      },
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(configured, [null])
  } finally {
    console.error = originalConsoleError
    if (originalWindow === undefined) delete global.window
    else global.window = originalWindow
  }
})

test('renderer startup does not configure twice when worker validation rejects', async() => {
  // Catches one catch-handler treating a terminal worker rejection as an IPC acquisition failure.
  const configured = []
  const originalWindow = global.window
  const originalConsoleError = console.error
  global.window = { dt: false }
  console.error = () => {}
  try {
    loadTsModule(globalDataPath, {
      '@renderer/worker': () => ({
        main: {
          configureRunTempRoot: async ownership => {
            configured.push(ownership)
            if (ownership != null) throw new Error('worker_descriptor_invalid')
          },
        },
      }),
      '@renderer/utils/ipc': {
        getRunTempRoot: async() => ({ invalid: true }),
      },
    })
    await new Promise(resolve => setImmediate(resolve))

    assert.deepEqual(configured, [{ invalid: true }])
  } finally {
    console.error = originalConsoleError
    if (originalWindow === undefined) delete global.window
    else global.window = originalWindow
  }
})

test('worker configuration is immutable and keeps writes in the first owned child', async() => {
  // Catches repeated configuration that redirects later renderer-worker writes to an arbitrary directory.
  const fixture = createTestStorageRoot('worker-immutable')
  try {
    const first = await createOwnedArtworkConfig(fixture)
    const secondPath = path.join(fixture.path, 'foreign-artwork')
    await fsp.mkdir(secondPath)
    const second = {
      ...first.config,
      childPath: secondPath,
      childIdentity: await identityOf(secondPath),
    }
    const worker = loadWorker(() => createPicture(0x32))
    await worker.configureRunTempRoot(first.config)

    await assert.rejects(Promise.resolve(worker.configureRunTempRoot(second)), /run_temp_root_already_configured/)
    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    if (process.platform == 'linux') assert.equal(path.dirname(output), first.config.childPath)
    else assert.match(output, /^data:image\/png;base64,/)
    assert.deepEqual(await fsp.readdir(secondPath), [])
  } finally {
    fixture.cleanup()
  }
})

test('worker creates opaque exclusive files for colliding source basenames', {
  skip: process.platform != 'linux',
}, async() => {
  // Catches basename-derived artwork output that overwrites an earlier file from another source directory.
  const fixture = createTestStorageRoot('worker-collision')
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    const worker = loadWorker(filePath => createPicture(filePath.includes(`${path.sep}one${path.sep}`) ? 0x41 : 0x42))
    await worker.configureRunTempRoot(config)

    const first = await worker.getMusicFilePic(path.join(fixture.path, 'one', 'song.mp3'))
    const second = await worker.getMusicFilePic(path.join(fixture.path, 'two', 'song.mp3'))

    assert.notEqual(first, second)
    assert.match(path.basename(first), /^[a-f0-9]{32}\.img$/)
    assert.match(path.basename(second), /^[a-f0-9]{32}\.img$/)
    assert.deepEqual(await fsp.readFile(first), createPicture(0x41).data)
    assert.deepEqual(await fsp.readFile(second), createPicture(0x42).data)
  } finally {
    fixture.cleanup()
  }
})

test('worker retries exclusive name collisions and stops at the eighth collision', async() => {
  // Catches unbounded collision loops and retry branches that never reach a later exclusive name.
  const fixture = createTestStorageRoot('worker-exclusive-collision')
  const originalPlatform = process.platform
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    Object.defineProperty(process, 'platform', { value: 'linux' })
    let attempts = 0
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (String(flags) == 'wx' && attempts++ < 2) {
          const error = new Error('collision')
          error.code = 'EEXIST'
          throw error
        }
        if (String(flags) == 'wx') {
          return fsp.open(path.join(config.childPath, path.basename(String(targetPath))), flags, mode)
        }
        return fsp.open(targetPath, flags, mode)
      },
    }
    const worker = loadWorker(() => createPicture(0x42), injectedFs)
    await worker.configureRunTempRoot(config)

    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    assert.equal(attempts, 3)
    assert.equal(path.dirname(output), config.childPath)
    assert.deepEqual(await fsp.readFile(output), createPicture(0x42).data)

    let exhaustedAttempts = 0
    const exhaustedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (String(flags) == 'wx') {
          exhaustedAttempts++
          const error = new Error('collision')
          error.code = 'EEXIST'
          throw error
        }
        return fsp.open(targetPath, flags, mode)
      },
    }
    const exhaustedWorker = loadWorker(() => createPicture(0x43), exhaustedFs)
    await exhaustedWorker.configureRunTempRoot(config)

    const fallback = await exhaustedWorker.getMusicFilePic(path.join(fixture.path, 'other.mp3'))

    assert.equal(exhaustedAttempts, 8)
    assert.match(fallback, /^data:image\/png;base64,/)
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('worker rejects a replaced local-artwork child without writing into it', {
  skip: process.platform != 'linux',
}, async() => {
  // Catches live writes that follow a replacement directory after configuration identity was validated.
  const fixture = createTestStorageRoot('worker-child-replacement')
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    const originalChild = `${config.childPath}.original`
    const worker = loadWorker(() => createPicture(0x43))
    await worker.configureRunTempRoot(config)
    const beforeReplacement = await worker.getMusicFilePic(path.join(fixture.path, 'before.mp3'))
    assert.equal(path.dirname(beforeReplacement), config.childPath)
    await fsp.rename(config.childPath, originalChild)
    await fsp.mkdir(config.childPath)
    await fsp.writeFile(path.join(config.childPath, 'sentinel.txt'), 'preserve')

    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    assert.match(output, /^data:image\/png;base64,/)
    assert.deepEqual(await fsp.readdir(config.childPath), ['sentinel.txt'])
    assert.equal(await fsp.readFile(path.join(config.childPath, 'sentinel.txt'), 'utf8'), 'preserve')
  } finally {
    fixture.cleanup()
  }
})

test('worker reclaims an exclusive output when the owned child is swapped during open', {
  skip: process.platform != 'linux',
}, async() => {
  // Catches validation-before-open that creates or writes an artwork file in a replacement directory.
  const fixture = createTestStorageRoot('worker-open-race')
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    const originalChild = `${config.childPath}.original`
    let swapped = false
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (!swapped && String(flags) == 'wx') {
          swapped = true
          await fsp.rename(config.childPath, originalChild)
          await fsp.mkdir(config.childPath)
        }
        return fsp.open(targetPath, flags, mode)
      },
    }
    const worker = loadWorker(() => createPicture(0x44), injectedFs)
    await worker.configureRunTempRoot(config)

    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    assert.equal(swapped, true)
    assert.match(output, /^data:image\/png;base64,/)
    assert.deepEqual(await fsp.readdir(config.childPath), [])
    assert.deepEqual(await fsp.readdir(originalChild), [])
  } finally {
    fixture.cleanup()
  }
})

test('Windows falls back before pathname creation when an open child can be junction-swapped', {
  skip: process.platform != 'win32',
}, async() => {
  // Catches treating an open Windows directory handle as an openat-style ownership boundary.
  const fixture = createTestStorageRoot('worker-windows-junction-race')
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    const originalChild = `${config.childPath}.original`
    const outside = path.join(fixture.path, 'outside-artwork')
    await fsp.mkdir(outside)
    let guardProbeRan = false
    let exclusiveOpens = 0
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (!guardProbeRan && String(targetPath) == config.childPath && String(flags) == 'r') {
          const directoryHandle = await fsp.open(targetPath, flags, mode)
          return {
            fd: directoryHandle.fd,
            async stat(options) {
              const stat = await directoryHandle.stat(options)
              await fsp.rename(config.childPath, originalChild)
              await fsp.symlink(outside, config.childPath, 'junction')
              await fsp.rmdir(config.childPath)
              await fsp.rename(originalChild, config.childPath)
              guardProbeRan = true
              return stat
            },
            close: async() => directoryHandle.close(),
          }
        }
        if (String(flags) == 'wx') {
          exclusiveOpens++
          await fsp.rename(config.childPath, originalChild)
          await fsp.symlink(outside, config.childPath, 'junction')
          const handle = await fsp.open(targetPath, flags, mode)
          await fsp.rmdir(config.childPath)
          await fsp.rename(originalChild, config.childPath)
          return handle
        }
        return fsp.open(targetPath, flags, mode)
      },
    }
    const worker = loadWorker(() => createPicture(0x46), injectedFs)
    await worker.configureRunTempRoot(config)

    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    assert.equal(guardProbeRan, true)
    assert.equal(exclusiveOpens, 0)
    assert.match(output, /^data:image\/png;base64,/)
    assert.deepEqual(await fsp.readdir(outside), [])
    assert.deepEqual(await fsp.readdir(config.childPath), [])
  } finally {
    fixture.cleanup()
  }
})

test('non-Linux workers fall back before exclusive pathname creation', async() => {
  // Catches unsupported directory-FD paths reaching a pathname create on macOS or Windows.
  const fixture = createTestStorageRoot('worker-non-linux-fallback')
  const originalPlatform = process.platform
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    let exclusiveOpens = 0
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (String(flags) == 'wx') exclusiveOpens++
        return fsp.open(targetPath, flags, mode)
      },
    }
    const worker = loadWorker(() => createPicture(0x47), injectedFs)
    await worker.configureRunTempRoot(config)

    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    assert.equal(exclusiveOpens, 0)
    assert.match(output, /^data:image\/png;base64,/)
    assert.deepEqual(await fsp.readdir(config.childPath), [])
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})

test('worker pins Linux output creation to the owned child across a swap and restore', async() => {
  // Catches pathname creation that leaves an orphan in a replacement parent restored before open returns.
  const fixture = createTestStorageRoot('worker-open-restore-race')
  const originalPlatform = process.platform
  try {
    const { config } = await createOwnedArtworkConfig(fixture)
    const originalChild = `${config.childPath}.original`
    const replacementChild = `${config.childPath}.replacement`
    Object.defineProperty(process, 'platform', { value: 'linux' })
    let swapped = false
    const injectedFs = {
      ...fsp,
      async open(targetPath, flags, mode) {
        if (!swapped && path.dirname(String(targetPath)) == config.childPath && String(flags) == 'wx') {
          swapped = true
          await fsp.rename(config.childPath, originalChild)
          await fsp.mkdir(config.childPath)
          const handle = await fsp.open(targetPath, flags, mode)
          const opened = await handle.stat({ bigint: true })
          await handle.close()
          await fsp.rename(config.childPath, replacementChild)
          await fsp.rename(originalChild, config.childPath)
          const strandedPath = path.join(replacementChild, path.basename(String(targetPath)))
          return {
            stat: async() => opened,
            writeFile: async data => fsp.writeFile(strandedPath, data),
            close: async() => {},
          }
        }
        if (!swapped && String(flags) == 'wx' && /[\\/]proc[\\/]self[\\/]fd[\\/]\d+[\\/]/.test(String(targetPath))) {
          swapped = true
          await fsp.rename(config.childPath, originalChild)
          await fsp.mkdir(config.childPath)
          const outputName = path.basename(String(targetPath))
          const pinnedPath = path.join(originalChild, outputName)
          const handle = await fsp.open(pinnedPath, flags, mode)
          const opened = await handle.stat({ bigint: true })
          await handle.close()
          await fsp.rename(config.childPath, replacementChild)
          await fsp.rename(originalChild, config.childPath)
          const restoredPath = path.join(config.childPath, outputName)
          return {
            stat: async() => opened,
            writeFile: async data => fsp.writeFile(restoredPath, data),
            close: async() => {},
          }
        }
        return fsp.open(targetPath, flags, mode)
      },
    }
    const worker = loadWorker(() => createPicture(0x45), injectedFs)
    await worker.configureRunTempRoot(config)

    const output = await worker.getMusicFilePic(path.join(fixture.path, 'song.mp3'))

    assert.equal(swapped, true)
    assert.equal(path.dirname(output), config.childPath)
    assert.match(path.basename(output), /^[a-f0-9]{32}\.img$/)
    assert.deepEqual(await fsp.readFile(output), createPicture(0x45).data)
    assert.deepEqual(await fsp.readdir(replacementChild), [])
  } finally {
    Object.defineProperty(process, 'platform', { value: originalPlatform })
    fixture.cleanup()
  }
})
