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

const modulePath = path.join(__dirname, '../../src/main/utils/tempLifecycle.ts')
const loadLifecycle = (fsPromises = fsp) => loadTsModule(modulePath, {
  '@main/utils/storagePaths': loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts')),
  'node:fs/promises': fsPromises,
})

const exists = async(targetPath) => await fsp.lstat(targetPath).then(() => true, () => false)

test('adopts only the bootstrap-created run directory and owner marker', async() => {
  const fixture = createTestStorageRoot('temp-reservation-adoption')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const foreign = path.join(fixture.path, 'foreign')
    await fsp.mkdir(tempRoot, { recursive: true })
    await fsp.mkdir(foreign)
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle()
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })

    await assert.rejects(
      createRunTempHandle({ reservation: { ...reservation, runTempRoot: foreign } }),
      /run_temp_owner_invalid/,
    )
  } finally {
    fixture.cleanup()
  }
})

test('run cleanup removes only the owned direct child and preserves neighboring content', async() => {
  // Catches a cleanup implementation that recursively deletes tempRoot or accepts an unmarked sibling.
  const fixture = createTestStorageRoot('temp-lifecycle')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const neighboringRun = path.join(tempRoot, 'run-neighbor')
    await fsp.mkdir(tempRoot, { recursive: true })
    await fsp.mkdir(neighboringRun, { recursive: true })
    await fsp.writeFile(path.join(neighboringRun, 'keep.txt'), 'preserve')

    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle()
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    const runTempRoot = reservation.runTempRoot
    const handle = await createRunTempHandle({ reservation })
    const artwork = await handle.createChild('local-artwork')
    await fsp.writeFile(path.join(artwork, 'cover.png'), 'image')
    await handle.cleanup()

    assert.equal(await exists(runTempRoot), false)
    assert.equal(await fsp.readFile(path.join(neighboringRun, 'keep.txt'), 'utf8'), 'preserve')
  } finally {
    fixture.cleanup()
  }
})

test('startup scavenging removes a marked stale run but refuses an unmarked directory', async() => {
  // Catches a scavenger that trusts a run-* name instead of the exclusive ownership marker.
  const fixture = createTestStorageRoot('temp-scavenge')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const foreignRun = path.join(tempRoot, 'run-foreign')
    await fsp.mkdir(tempRoot, { recursive: true })
    await fsp.mkdir(foreignRun, { recursive: true })
    await fsp.writeFile(path.join(foreignRun, 'keep.txt'), 'preserve')

    const { prepareRunTempLifecycle, scavengeRunTempRoots } = loadLifecycle()
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: 'stale' })
    const staleRun = reservation.runTempRoot
    await scavengeRunTempRoots(tempRoot)

    assert.equal(await exists(staleRun), false)
    assert.equal(await fsp.readFile(path.join(foreignRun, 'keep.txt'), 'utf8'), 'preserve')
  } finally {
    fixture.cleanup()
  }
})

test('local artwork child is contained in its main-owned run directory', async() => {
  // Catches a child allocator that accepts traversal or creates local artwork outside the owned run root.
  const fixture = createTestStorageRoot('temp-artwork')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    await fsp.mkdir(tempRoot, { recursive: true })
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle()
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    const runTempRoot = reservation.runTempRoot
    const handle = await createRunTempHandle({ reservation })
    const artwork = await handle.createChild('local-artwork')

    assert.equal(path.dirname(artwork), runTempRoot)
    assert.equal((await fsp.lstat(artwork)).isDirectory(), true)
    await assert.rejects(handle.createChild('artwork'), /run_temp_child_invalid/)
  } finally {
    fixture.cleanup()
  }
})

test('cleanup refuses a replacement directory with copied owner bytes', async() => {
  // Catches cleanup that trusts copied marker contents instead of the run and marker node identities.
  const fixture = createTestStorageRoot('temp-replaced-run')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const originalRun = path.join(tempRoot, 'original-run-node')
    await fsp.mkdir(tempRoot, { recursive: true })
    let runTempRoot
    let replacementSentinel
    let armReplacement = false
    let replaced = false
    const injectedFs = {
      ...fsp,
      async readFile(targetPath, ...args) {
        const bytes = await fsp.readFile(targetPath, ...args)
        if (armReplacement && !replaced && path.basename(String(targetPath)) == '.owner.v1.json') {
          replaced = true
          await fsp.rename(runTempRoot, originalRun)
          await fsp.mkdir(runTempRoot)
          await fsp.writeFile(path.join(runTempRoot, '.owner.v1.json'), bytes)
          await fsp.writeFile(replacementSentinel, 'preserve replacement')
        }
        return bytes
      },
    }
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle(injectedFs)
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    runTempRoot = reservation.runTempRoot
    replacementSentinel = path.join(runTempRoot, 'replacement.txt')
    const handle = await createRunTempHandle({ reservation })
    armReplacement = true

    await assert.rejects(handle.cleanup(), /run_temp_(root|owner)_invalid/)

    assert.equal(await fsp.readFile(replacementSentinel, 'utf8'), 'preserve replacement')
    assert.equal(await exists(originalRun), true)
  } finally {
    fixture.cleanup()
  }
})

test('cleanup quarantines the owned run before recursive removal', async() => {
  // Catches cleanup that recursively removes the published run path after another node appears there.
  const fixture = createTestStorageRoot('temp-quarantine')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    await fsp.mkdir(tempRoot, { recursive: true })
    let runTempRoot
    let replacementSentinel
    let injectedReplacement = false
    const injectedFs = {
      ...fsp,
      async rename(source, target) {
        await fsp.rename(source, target)
        if (!injectedReplacement && path.resolve(String(source)) == path.resolve(runTempRoot)) {
          injectedReplacement = true
          await fsp.mkdir(runTempRoot)
          await fsp.writeFile(replacementSentinel, 'preserve replacement')
        }
      },
    }
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle(injectedFs)
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    runTempRoot = reservation.runTempRoot
    replacementSentinel = path.join(runTempRoot, 'replacement.txt')
    const handle = await createRunTempHandle({ reservation })

    await handle.cleanup()

    assert.equal(injectedReplacement, true)
    assert.equal(await fsp.readFile(replacementSentinel, 'utf8'), 'preserve replacement')
    const quarantineEntries = (await fsp.readdir(tempRoot)).filter(name => name.includes('quarantine'))
    assert.deepEqual(quarantineEntries, [])
  } finally {
    fixture.cleanup()
  }
})

test('cleanup restores a replacement moved by the quarantine rename race', async() => {
  // Catches quarantine that strands an unowned replacement after it wins the validation-to-rename race.
  const fixture = createTestStorageRoot('temp-quarantine-replacement')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const parkedOriginal = path.join(tempRoot, 'parked-original')
    await fsp.mkdir(tempRoot, { recursive: true })
    let runTempRoot
    let replacementSentinel
    let swapped = false
    const injectedFs = {
      ...fsp,
      async rename(source, target) {
        if (!swapped && path.resolve(String(source)) == path.resolve(runTempRoot)) {
          swapped = true
          const markerBytes = await fsp.readFile(path.join(runTempRoot, '.owner.v1.json'))
          await fsp.rename(runTempRoot, parkedOriginal)
          await fsp.mkdir(runTempRoot)
          await fsp.writeFile(path.join(runTempRoot, '.owner.v1.json'), markerBytes)
          await fsp.writeFile(replacementSentinel, 'preserve replacement')
        }
        return fsp.rename(source, target)
      },
    }
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle(injectedFs)
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    runTempRoot = reservation.runTempRoot
    replacementSentinel = path.join(runTempRoot, 'replacement.txt')
    const handle = await createRunTempHandle({ reservation })

    await assert.rejects(handle.cleanup(), /run_temp_(root|owner)_invalid/)

    assert.equal(swapped, true)
    assert.equal(await fsp.readFile(replacementSentinel, 'utf8'), 'preserve replacement')
    assert.equal(await exists(parkedOriginal), true)
  } finally {
    fixture.cleanup()
  }
})
