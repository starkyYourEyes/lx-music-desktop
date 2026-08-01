const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// This test exercises the shared verifier without starting Electron or a worker.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const cachePhasePath = '../../src/common/storage/cachePhase.ts'
const phase3WorkerPath = '../../src/main/worker/dbService/modules/phase3/index.ts'
const dbService = require('../../src/main/worker/dbService/db.ts')
const testStorageRootPath = './helpers/test-storage-root.js'
const workerFixtures = []
const supportsWorkerDatabase = typeof process.versions.electron == 'string'

const runElectronChild = () => {
  const result = childProcess.spawnSync(require('electron'), ['--test', __filename], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = value => crypto.createHash('sha256').update(value, 'utf8').digest('hex')
const hashes = Object.fromEntries('abcdef0'.split('').map(letter => [letter, letter.repeat(64)]))

const completeManifest = () => ({
  version: 1,
  checks: [
    { name: 'credentials', version: 1, state: 'complete', evidenceSha256: hashes.a },
    { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: hashes.b },
    { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: hashes.c },
    { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: hashes.d },
    { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: hashes.e },
    { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: hashes.f },
    { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: hashes['0'] },
  ],
})

const completeMarker = (manifest = completeManifest()) => {
  const detailsJson = canonical(manifest)
  return {
    name: 'legacy_data_v1.cross_artifact_complete',
    sourceSha256: sha256(detailsJson),
    completedAtMs: 1,
    detailsJson,
  }
}

const markerWith = update => {
  const marker = completeMarker()
  const manifest = JSON.parse(marker.detailsJson)
  update(manifest, marker)
  if (marker.detailsJson == canonical(completeManifest())) {
    marker.detailsJson = canonical(manifest)
    marker.sourceSha256 = sha256(marker.detailsJson)
  }
  return marker
}

afterEach(() => {
  try { dbService.close() } catch {}
  for (const fixture of workerFixtures.splice(0)) fixture.cleanup()
  try { delete require.cache[require.resolve(cachePhasePath)] } catch {}
  try { delete require.cache[require.resolve(phase3WorkerPath)] } catch {}
  try { delete require.cache[require.resolve(testStorageRootPath)] } catch {}
})

const createWorkerStore = async() => {
  const { createTestStorageRoot } = require(testStorageRootPath)
  const fixture = createTestStorageRoot('cache-worker')
  workerFixtures.push(fixture)
  const result = await dbService.init({
    dataPath: fixture.path,
    cacheRoot: path.join(fixture.path, 'cache'),
    backupsRoot: path.join(fixture.path, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(result.status, 'ready')
  return dbService.getDB()
}

const writeRawCrossMarker = (db, marker) => db.prepare(`
  INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
  VALUES (?, ?, ?, ?)
`).run(marker.name, marker.sourceSha256, marker.completedAtMs, marker.detailsJson)

describe('cache Phase 3 prerequisite', () => {
  it('accepts only a canonical marker with complete typed playback checks', () => {
    const { getCachePhasePrerequisite } = require(cachePhasePath)

    const result = getCachePhasePrerequisite(completeMarker())

    assert.equal(result.markerName, 'legacy_data_v1.cross_artifact_complete')
    assert.equal(result.sourceSha256, completeMarker().sourceSha256)
    assert.throws(() => getCachePhasePrerequisite(markerWith(manifest => {
      manifest.checks[6].state = 'not-applicable'
    })), /cache_phase3_prerequisite_invalid/)
  })

  it('rejects malformed JSON, noncanonical details, unexpected manifest fields or order, and hash mismatches', () => {
    const { getCachePhasePrerequisite } = require(cachePhasePath)
    const malformed = completeMarker()
    malformed.detailsJson = '{'
    const noncanonical = completeMarker()
    noncanonical.detailsJson = JSON.stringify(JSON.parse(noncanonical.detailsJson), null, 2)
    const unexpectedField = markerWith(manifest => { manifest.unexpected = true })
    const reordered = markerWith(manifest => { [manifest.checks[5], manifest.checks[6]] = [manifest.checks[6], manifest.checks[5]] })
    const hashMismatch = completeMarker()
    hashMismatch.sourceSha256 = hashes.f
    const unexpectedMarkerField = { ...completeMarker(), extra: true }

    for (const marker of [malformed, noncanonical, unexpectedField, reordered, hashMismatch, unexpectedMarkerField]) {
      assert.throws(() => getCachePhasePrerequisite(marker), /cache_phase3_prerequisite_invalid/)
    }
  })

  it('rejects incomplete writer and reader evidence and preserves a valid marker replay', () => {
    const { getCachePhasePrerequisite } = require(cachePhasePath)
    const marker = completeMarker()
    const before = structuredClone(marker)
    const writerIncomplete = markerWith(manifest => { manifest.checks[5].state = 'not-applicable' })
    const readerIncomplete = markerWith(manifest => { manifest.checks[6].state = 'not-applicable' })

    assert.deepEqual(getCachePhasePrerequisite(marker), getCachePhasePrerequisite(marker))
    assert.deepEqual(marker, before)
    assert.throws(() => getCachePhasePrerequisite(writerIncomplete), /cache_phase3_prerequisite_invalid/)
    assert.throws(() => getCachePhasePrerequisite(readerIncomplete), /cache_phase3_prerequisite_invalid/)
  })

  it('creates and removes only an owned direct child of the supplied fixture root', () => {
    const { createTestStorageRoot } = require(testStorageRootPath)
    const fixture = createTestStorageRoot('cache-phase')
    try {
      const baseRoot = fs.realpathSync(process.env.LX_TEST_STORAGE_ROOT)

      assert.equal(path.dirname(fixture.path), baseRoot)
      assert.equal(fs.lstatSync(fixture.path).isSymbolicLink(), false)
      assert.equal(fs.existsSync(fixture.ownershipMarkerPath), true)
      fixture.cleanup()
      assert.equal(fs.existsSync(fixture.path), false)
      assert.equal(fs.existsSync(baseRoot), true)
    } finally {
      fixture.cleanup()
    }
  })

  it('rejects caller-supplied worker values before reading the fixed marker', () => {
    const { getCachePhasePrerequisite } = require(phase3WorkerPath)

    assert.throws(() => getCachePhasePrerequisite('legacy_data_v1.local_state'), /cache_phase3_prerequisite_invalid/)
  })

  it('reads raw worker marker bytes instead of normalized migration marker details', async() => {
    if (!supportsWorkerDatabase) return runElectronChild()
    const db = await createWorkerStore()
    const repository = require(phase3WorkerPath)
    const canonicalMarker = completeMarker()
    const prettyDetails = JSON.stringify(JSON.parse(canonicalMarker.detailsJson), null, 2)
    const duplicateKeyDetails = canonicalMarker.detailsJson.replace(
      /,"version":1}$/, ',"version":1,"version":1}',
    )

    writeRawCrossMarker(db, canonicalMarker)
    assert.equal(repository.getCachePhasePrerequisite().sourceSha256, canonicalMarker.sourceSha256)

    for (const detailsJson of [prettyDetails, duplicateKeyDetails]) {
      db.prepare(`UPDATE migration_markers SET details_json = ?, source_sha256 = ? WHERE name = ?`).run(
        detailsJson,
        canonicalMarker.sourceSha256,
        canonicalMarker.name,
      )
      assert.throws(() => repository.getCachePhasePrerequisite(), /cache_phase3_prerequisite_invalid/)
    }

    db.prepare(`UPDATE migration_markers SET details_json = ?, source_sha256 = ? WHERE name = ?`).run(
      canonicalMarker.detailsJson,
      canonicalMarker.sourceSha256,
      canonicalMarker.name,
    )
    assert.equal(repository.getCachePhasePrerequisite().sourceSha256, canonicalMarker.sourceSha256)
  })

  it('rejects a reparse-point fixture root instead of resolving it as the supplied root', () => {
    const { createTestStorageRoot } = require(testStorageRootPath)
    const baseRoot = fs.realpathSync(process.env.LX_TEST_STORAGE_ROOT)
    const target = createTestStorageRoot('reparse-target')
    const alias = path.join(baseRoot, 'cache-phase-reparse-root')
    let created = null
    try {
      fs.symlinkSync(target.path, alias, process.platform == 'win32' ? 'junction' : 'dir')
      const previous = process.env.LX_TEST_STORAGE_ROOT
      process.env.LX_TEST_STORAGE_ROOT = alias
      try {
        assert.throws(() => { created = createTestStorageRoot('reparse-rejected') }, /non-link/)
      } finally {
        process.env.LX_TEST_STORAGE_ROOT = previous
      }
    } finally {
      created?.cleanup()
      fs.rmSync(alias, { recursive: true, force: true })
      target.cleanup()
    }
  })

  it('rejects child and marker replacement without deleting the replacement', () => {
    const { createTestStorageRoot } = require(testStorageRootPath)
    const baseRoot = fs.realpathSync(process.env.LX_TEST_STORAGE_ROOT)
    const child = createTestStorageRoot('replacement-child')
    const parkedChild = path.join(baseRoot, 'replacement-owned-child')
    try {
      fs.renameSync(child.path, parkedChild)
      fs.mkdirSync(child.path)
      fs.writeFileSync(path.join(child.path, 'unowned.txt'), 'keep')
      assert.throws(() => child.cleanup(), /ownership changed/)
      assert.equal(fs.readFileSync(path.join(child.path, 'unowned.txt'), 'utf8'), 'keep')
    } finally {
      fs.rmSync(child.path, { recursive: true, force: true })
      fs.rmSync(parkedChild, { recursive: true, force: true })
    }

    const marker = createTestStorageRoot('replacement-marker')
    const parkedMarker = path.join(marker.path, 'original-owner-marker')
    try {
      fs.renameSync(marker.ownershipMarkerPath, parkedMarker)
      fs.writeFileSync(marker.ownershipMarkerPath, 'replacement')
      assert.throws(() => marker.cleanup(), /ownership marker changed/)
      assert.equal(fs.readFileSync(marker.ownershipMarkerPath, 'utf8'), 'replacement')
    } finally {
      fs.rmSync(marker.ownershipMarkerPath, { force: true })
      if (fs.existsSync(parkedMarker)) fs.renameSync(parkedMarker, marker.ownershipMarkerPath)
      marker.cleanup()
    }
  })

  it('restores a target swapped after verification and never deletes the replacement', () => {
    const { createTestStorageRoot } = require(testStorageRootPath)
    const baseRoot = fs.realpathSync(process.env.LX_TEST_STORAGE_ROOT)
    const fixture = createTestStorageRoot('swap-owned')
    const replacement = createTestStorageRoot('swap-replacement')
    const ownedParking = path.join(baseRoot, `.${path.basename(fixture.path)}.parking`)
    assert.equal(fs.existsSync(ownedParking), false)
    fs.writeFileSync(path.join(replacement.path, 'unowned.txt'), 'keep')
    const fixtureMarker = fs.readFileSync(fixture.ownershipMarkerPath, 'utf8')
    const replacementMarker = fs.readFileSync(replacement.ownershipMarkerPath, 'utf8')
    const rename = fs.renameSync
    let swapped = false
    try {
      fs.renameSync = (source, target) => {
        if (!swapped && source == fixture.path) {
          swapped = true
          rename(source, ownedParking)
          rename(replacement.path, source)
        }
        return rename(source, target)
      }
      assert.throws(() => fixture.cleanup(), /ownership changed/)
      assert.equal(fs.readFileSync(path.join(fixture.path, 'unowned.txt'), 'utf8'), 'keep')
    } finally {
      fs.renameSync = rename
      if (swapped) {
        assert.equal(fs.existsSync(ownedParking), true)
        assert.equal(fs.existsSync(replacement.path), false)
        rename(fixture.path, replacement.path)
        rename(ownedParking, fixture.path)
        assert.equal(fs.readFileSync(fixture.ownershipMarkerPath, 'utf8'), fixtureMarker)
        assert.equal(fs.readFileSync(replacement.ownershipMarkerPath, 'utf8'), replacementMarker)
      }
      fixture.cleanup()
      replacement.cleanup()
    }
  })
})
