const assert = require('node:assert/strict')
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
const testStorageRootPath = './helpers/test-storage-root.js'

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
  try { delete require.cache[require.resolve(cachePhasePath)] } catch {}
  try { delete require.cache[require.resolve(phase3WorkerPath)] } catch {}
  try { delete require.cache[require.resolve(testStorageRootPath)] } catch {}
})

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
})
