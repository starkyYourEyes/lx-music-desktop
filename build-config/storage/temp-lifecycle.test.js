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
const loadLifecycle = () => loadTsModule(modulePath, {
  '@main/utils/storagePaths': loadTsModule(path.join(__dirname, '../../src/main/utils/storagePaths.ts')),
})

const exists = async(targetPath) => await fsp.lstat(targetPath).then(() => true, () => false)

test('run cleanup removes only the owned direct child and preserves neighboring content', async() => {
  // Catches a cleanup implementation that recursively deletes tempRoot or accepts an unmarked sibling.
  const fixture = createTestStorageRoot('temp-lifecycle')
  try {
    const tempRoot = path.join(fixture.path, 'temp')
    const runTempRoot = path.join(tempRoot, 'run-current')
    const neighboringRun = path.join(tempRoot, 'run-neighbor')
    await fsp.mkdir(runTempRoot, { recursive: true })
    await fsp.mkdir(neighboringRun, { recursive: true })
    await fsp.writeFile(path.join(neighboringRun, 'keep.txt'), 'preserve')

    const { createRunTempHandle } = loadLifecycle()
    const handle = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
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
    const staleRun = path.join(tempRoot, 'run-stale')
    const foreignRun = path.join(tempRoot, 'run-foreign')
    await fsp.mkdir(staleRun, { recursive: true })
    await fsp.writeFile(path.join(staleRun, '.owner.v1.json'), JSON.stringify({ version: 1, runId: 'stale' }))
    await fsp.mkdir(foreignRun, { recursive: true })
    await fsp.writeFile(path.join(foreignRun, 'keep.txt'), 'preserve')

    const { scavengeRunTempRoots } = loadLifecycle()
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
    const runTempRoot = path.join(tempRoot, 'run-current')
    await fsp.mkdir(runTempRoot, { recursive: true })
    const { createRunTempHandle } = loadLifecycle()
    const handle = await createRunTempHandle({ tempRoot, runTempRoot, runId: crypto.randomUUID() })
    const artwork = await handle.createChild('local-artwork')

    assert.equal(path.dirname(artwork), runTempRoot)
    assert.equal((await fsp.lstat(artwork)).isDirectory(), true)
    await assert.rejects(handle.createChild('artwork'), /run_temp_child_invalid/)
  } finally {
    fixture.cleanup()
  }
})
