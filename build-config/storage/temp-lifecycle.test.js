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
const retainedRunIsolations = async(tempRoot) => (await fsp.readdir(tempRoot))
  .filter(name => name.startsWith('.lx-run-retained-'))

const writeRunMarker = async(runPath, runId) => {
  const stat = await fsp.lstat(runPath, { bigint: true })
  await fsp.writeFile(path.join(runPath, '.owner.v1.json'), JSON.stringify({
    version: 1,
    runId,
    directoryIdentity: { dev: String(stat.dev), ino: String(stat.ino) },
  }))
}

test('rejects adoption after the prepared temp ancestry is replaced around the same run node', async() => {
  const fixture = createTestStorageRoot('temp-reservation-ancestry')
  try {
    const container = path.join(fixture.path, 'container')
    const parked = path.join(fixture.path, 'parked-container')
    const tempRoot = path.join(container, 'temp')
    await fsp.mkdir(tempRoot, { recursive: true })
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle()
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    await fsp.rename(container, parked)
    await fsp.mkdir(container)
    await fsp.rename(path.join(parked, 'temp'), tempRoot)

    await assert.rejects(createRunTempHandle({ reservation }), /run_temp_owner_invalid/)
  } finally {
    fixture.cleanup()
  }
})

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
    assert.equal(await exists(path.join(artwork, 'cover.png')), false)
    assert.deepEqual(await retainedRunIsolations(tempRoot), [])
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

test('startup scavenging ignores retained isolation and legacy quarantine names', async() => {
  // Catches re-adoption of creation-bound isolation or legacy quarantine paths by pathname convention.
  const fixture = createTestStorageRoot('temp-scavenge-retained')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const seededNames = [
      '.lx-run-retained-seeded',
      '.run-legacy.quarantine-00000000-0000-0000-0000-000000000000',
      '.lx-profile-stage-seeded',
      'arbitrary-directory',
    ]
    await fsp.mkdir(tempRoot, { recursive: true })
    for (const name of seededNames) {
      const seededPath = path.join(tempRoot, name)
      await fsp.mkdir(seededPath)
      await writeRunMarker(seededPath, name)
      await fsp.writeFile(path.join(seededPath, 'keep.txt'), name)
    }
    const { scavengeRunTempRoots } = loadLifecycle()

    await scavengeRunTempRoots(tempRoot)

    assert.deepEqual((await fsp.readdir(tempRoot)).sort(), seededNames.sort())
    for (const name of seededNames) {
      assert.equal(await fsp.readFile(path.join(tempRoot, name, 'keep.txt'), 'utf8'), name)
    }
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

test('retains the isolated run when recursive reclamation fails', async() => {
  // Catches cleanup that loses the only owned payload reference after recursive removal fails.
  const fixture = createTestStorageRoot('temp-retained-removal-failure')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    await fsp.mkdir(tempRoot, { recursive: true })
    const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle()
    const reservation = await prepareRunTempLifecycle({ tempRoot, runId: crypto.randomUUID() })
    const handle = await createRunTempHandle({ reservation })
    const child = await handle.createChild('local-artwork')
    await fsp.writeFile(path.join(child, 'cover.png'), 'retain payload')
    const originalRm = fs.rmSync
    fs.rmSync = (targetPath, ...args) => {
      if (path.basename(path.dirname(String(targetPath))).startsWith('.lx-run-retained-')) {
        throw new Error('injected removal failure')
      }
      return originalRm(targetPath, ...args)
    }

    try {
      await assert.rejects(handle.cleanup(), /run_temp_cleanup_failed/)
    } finally {
      fs.rmSync = originalRm
    }

    assert.equal((await retainedRunIsolations(tempRoot)).length, 1)
  } finally {
    fixture.cleanup()
  }
})

test('preserves a replacement raced into the stable run pathname', async() => {
  // Catches cleanup that restores the isolated payload over a stable-path replacement after a move race.
  const fixture = createTestStorageRoot('temp-isolation-replacement')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    await fsp.mkdir(tempRoot, { recursive: true })
    let runTempRoot
    let replacementSentinel
    let replaced = false
    const injectedFs = {
      ...fsp,
      async readFile(targetPath, ...args) {
        const bytes = await fsp.readFile(targetPath, ...args)
        const markerParent = path.basename(path.dirname(String(targetPath)))
        if (!replaced && path.basename(String(targetPath)) == '.owner.v1.json' &&
          markerParent == 'payload' && path.basename(path.dirname(path.dirname(String(targetPath))))
          .startsWith('.lx-run-retained-')) {
          replaced = true
          await fsp.mkdir(runTempRoot)
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

    await assert.rejects(handle.cleanup(), /run_temp_owner_invalid/)

    assert.equal(replaced, true)
    assert.equal(await fsp.readFile(replacementSentinel, 'utf8'), 'preserve replacement')
    assert.equal((await retainedRunIsolations(tempRoot)).length, 1)
  } finally {
    fixture.cleanup()
  }
})
