const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

const taskRoot = path.resolve(__dirname, '../../.superpowers/sdd/2026-07-29-playback-activity/tmp/task-11')
fs.mkdirSync(taskRoot, { recursive: true })
process.env.TEMP = taskRoot
process.env.TMP = taskRoot

// Electron ABI tests transpile source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const dbService = require('../../src/main/worker/dbService/db.ts')
const playback = require('../../src/main/worker/dbService/modules/playback/index.ts')
const coordinatorPath = '../../src/main/startup/storageCoordinator.ts'
const phase3Path = '../../src/main/worker/dbService/modules/phase3/index.ts'
const inputPath = '../../src/main/startup/phase3Attestation.ts'

const tempDirs = []
const hashes = Object.fromEntries('abcdef0123456789'.split('').map(value => [value, value.repeat(64)]))

afterEach(() => {
  try { dbService.close() } catch {}
  for (const root of tempDirs.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  for (const filename of [coordinatorPath, phase3Path, inputPath]) {
    try { delete require.cache[require.resolve(filename)] } catch {}
  }
})

const createStore = async() => {
  const root = fs.mkdtempSync(path.join(taskRoot, 'phase3-'))
  tempDirs.push(root)
  const result = await dbService.init({
    dataPath: root,
    backupDir: path.join(root, 'backups'),
    previousShutdownWasClean: true,
  })
  assert.equal(result.status, 'ready')
  return dbService.getDB()
}

const putMarker = (db, name, sourceSha256, details = { version: 1 }) => db.prepare(`
  INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
  VALUES (?, ?, 100, ?)
`).run(name, sourceSha256, JSON.stringify(details))

const seedPrerequisites = db => {
  putMarker(db, 'legacy_data_v1.account_profiles', hashes.a)
  putMarker(db, 'legacy_data_v1.phase2_complete', hashes.b)
  putMarker(db, 'legacy_data_v1.playback_activity', hashes.c)
}

const completeChecks = () => ({
  credentials: { state: 'complete', evidenceSha256: hashes.d },
  accountProfile: { state: 'complete', evidenceSha256: hashes.a },
  phase2: { state: 'complete', evidenceSha256: hashes.b },
  playbackActivity: { state: 'complete', evidenceSha256: hashes.c },
  quarantine: { state: 'complete', evidenceSha256: hashes.e },
  playbackWriter: { state: 'complete', evidenceSha256: hashes.f },
  playbackReader: { state: 'complete', evidenceSha256: hashes['0'] },
})

const command = (overrides = {}) => ({
  version: 1,
  completedAtMs: 900,
  checks: completeChecks(),
  ...overrides,
})

const markerRow = db => db.prepare(`
  SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs,
    details_json AS detailsJson
  FROM migration_markers WHERE name = 'legacy_data_v1.cross_artifact_complete'
`).get() ?? null

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex')
const notApplicableEvidence = name => sha256(canonical({ version: 1, name, state: 'not-applicable' }))
const credentialHealth = {
  version: 1,
  status: 'ready',
  vaultReadable: true,
  profileRepositoryReadable: true,
  plaintextSourcesAbsent: true,
}

const activityTables = [
  'track_snapshots',
  'playback_sessions',
  'playback_events',
  'recent_tracks',
  'listening_daily',
  'listening_tracks',
  'activity_totals',
  'projection_state',
  'playback_resume_state',
]

const snapshot = db => Object.fromEntries(activityTables.map(table => [
  table,
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
]))

describe('Phase 3 scoped attestation worker', () => {
  it('reads only the fixed prerequisite identities and rejects arbitrary marker envelopes', async() => {
    const db = await createStore()
    seedPrerequisites(db)
    const repository = require(phase3Path)

    assert.deepEqual(repository.getPhase3AttestationPrerequisites(), {
      version: 1,
      accountProfile: { markerName: 'legacy_data_v1.account_profiles', state: 'complete', evidenceSha256: hashes.a },
      phase2: { markerName: 'legacy_data_v1.phase2_complete', state: 'complete', evidenceSha256: hashes.b },
      playbackActivity: { markerName: 'legacy_data_v1.playback_activity', state: 'complete', evidenceSha256: hashes.c },
    })
    assert.throws(() => repository.getPhase3AttestationPrerequisites('legacy_data_v1.local_state'), /phase.?3.*request/i)
    assert.throws(() => repository.completePhase3Attestation({ ...command(), markerName: 'arbitrary' }), /phase.?3.*attestation/i)
    assert.equal(markerRow(db), null)
  })

  it('writes the exact canonical ordered manifest last and replays without rewriting its timestamp', async() => {
    const db = await createStore()
    seedPrerequisites(db)
    const repository = require(phase3Path)
    const expectedManifest = {
      version: 1,
      checks: [
        { name: 'credentials', version: 1, state: 'complete', evidenceSha256: hashes.d },
        { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: hashes.a },
        { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: hashes.b },
        { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: hashes.c },
        { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: hashes.e },
        { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: hashes.f },
        { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: hashes['0'] },
      ],
    }
    const expectedDetails = canonical(expectedManifest)

    const first = repository.completePhase3Attestation(command())
    assert.deepEqual(first, {
      name: 'legacy_data_v1.cross_artifact_complete',
      sourceSha256: sha256(expectedDetails),
      completedAtMs: 900,
      detailsJson: expectedDetails,
    })
    const before = markerRow(db)
    const replay = repository.completePhase3Attestation(command({ completedAtMs: 999 }))
    assert.deepEqual(replay, before)
    assert.deepEqual(markerRow(db), before)
  })

  it('fails closed for every missing prerequisite and never leaves the final marker', async() => {
    for (const missing of ['accountProfile', 'phase2', 'playbackActivity', 'credentials', 'quarantine', 'playbackWriter', 'playbackReader']) {
      dbService.close()
      const db = await createStore()
      seedPrerequisites(db)
      const repository = require(phase3Path)
      const value = command()
      if (missing == 'accountProfile' || missing == 'phase2' || missing == 'playbackActivity') {
        value.checks[missing] = { state: 'not-applicable', evidenceSha256: hashes['1'] }
      } else {
        value.checks[missing] = { state: 'complete', evidenceSha256: 'bad' }
      }
      assert.throws(() => repository.completePhase3Attestation(value), new RegExp(missing.replace(/[A-Z]/g, c => `.?${c.toLowerCase()}`), 'i'))
      assert.equal(markerRow(db), null, missing)
    }
  })

  it('attests a clean install as not-applicable without inventing prerequisite markers', async() => {
    const db = await createStore()
    const repository = require(phase3Path)
    const prerequisites = repository.getPhase3AttestationPrerequisites()
    assert.equal(prerequisites.accountProfile.state, 'not-applicable')
    assert.equal(prerequisites.phase2.state, 'not-applicable')
    assert.equal(prerequisites.playbackActivity.state, 'not-applicable')

    const checks = completeChecks()
    checks.credentials = { state: 'not-applicable', evidenceSha256: notApplicableEvidence('credentials') }
    checks.accountProfile = { state: prerequisites.accountProfile.state, evidenceSha256: prerequisites.accountProfile.evidenceSha256 }
    checks.phase2 = { state: prerequisites.phase2.state, evidenceSha256: prerequisites.phase2.evidenceSha256 }
    checks.playbackActivity = { state: prerequisites.playbackActivity.state, evidenceSha256: prerequisites.playbackActivity.evidenceSha256 }
    checks.quarantine = { state: 'not-applicable', evidenceSha256: notApplicableEvidence('quarantine') }
    const result = repository.completePhase3Attestation(command({ checks }))
    assert.equal(result.name, 'legacy_data_v1.cross_artifact_complete')
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_markers WHERE name != 'legacy_data_v1.cross_artifact_complete'").get().count, 0)
  })

  it('rejects a changed or corrupt immutable marker instead of overwriting it', async() => {
    const db = await createStore()
    seedPrerequisites(db)
    const repository = require(phase3Path)
    repository.completePhase3Attestation(command())
    const original = markerRow(db)

    db.prepare('UPDATE migration_markers SET details_json = ? WHERE name = ?').run(
      JSON.stringify({ version: 1, checks: [] }),
      original.name,
    )
    assert.throws(() => repository.completePhase3Attestation(command()), /phase.?3.*(conflict|corrupt|verification)/i)
    assert.equal(markerRow(db).completedAtMs, original.completedAtMs)
    assert.equal(markerRow(db).sourceSha256, original.sourceSha256)
  })

  it('rejects byte-noncanonical immutable marker replay even when parsed details are equivalent', async() => {
    const db = await createStore()
    seedPrerequisites(db)
    const repository = require(phase3Path)
    repository.completePhase3Attestation(command())
    const original = markerRow(db)
    const parsed = JSON.parse(original.detailsJson)
    const noncanonicalDetails = [
      JSON.stringify({ version: parsed.version, checks: parsed.checks }),
      JSON.stringify(parsed, null, 2),
    ]

    for (const detailsJson of noncanonicalDetails) {
      assert.notEqual(detailsJson, original.detailsJson)
      db.prepare('UPDATE migration_markers SET details_json = ? WHERE name = ?').run(detailsJson, original.name)
      assert.throws(() => repository.completePhase3Attestation(command()), /phase.?3.*conflict/i)
      assert.equal(markerRow(db).detailsJson, detailsJson)
    }
  })

  it('rolls back a newly inserted marker when raw readback mismatches the requested timestamp', async() => {
    const db = await createStore()
    seedPrerequisites(db)
    db.exec(`
      CREATE TEMP TRIGGER phase3_inject_readback_mismatch
      AFTER INSERT ON migration_markers
      WHEN NEW.name = 'legacy_data_v1.cross_artifact_complete'
      BEGIN
        UPDATE migration_markers SET completed_at_ms = completed_at_ms + 1 WHERE name = NEW.name;
      END
    `)
    const repository = require(phase3Path)

    assert.throws(() => repository.completePhase3Attestation(command()), /phase.?3.*verification/i)
    assert.equal(markerRow(db), null)
  })

  it('rolls back a newly inserted marker when raw details readback is corrupt', async() => {
    const db = await createStore()
    seedPrerequisites(db)
    db.exec(`
      CREATE TEMP TRIGGER phase3_inject_readback_failure
      AFTER INSERT ON migration_markers
      WHEN NEW.name = 'legacy_data_v1.cross_artifact_complete'
      BEGIN
        UPDATE migration_markers SET details_json = '{"version":2}' WHERE name = NEW.name;
      END
    `)
    const repository = require(phase3Path)

    assert.throws(() => repository.completePhase3Attestation(command()), /phase.?3.*(verification|conflict|corrupt)/i)
    assert.equal(markerRow(db), null)
  })
})

describe('rollback-safe typed playback smoke', () => {
  it('exercises every writer and reader through a forced rollback and leaves all tables unchanged', async() => {
    const db = await createStore()
    const before = snapshot(db)
    const result = playback.playbackRunTypedSmoke()

    assert.deepEqual(Object.keys(result).sort(), ['readerEvidenceSha256', 'version', 'writerEvidenceSha256'])
    assert.equal(result.version, 1)
    assert.match(result.writerEvidenceSha256, /^[a-f0-9]{64}$/)
    assert.match(result.readerEvidenceSha256, /^[a-f0-9]{64}$/)
    assert.deepEqual(snapshot(db), before)
    assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }])
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })

  it('rejects malformed requests and reports parser, result, and rollback failures without residue', async() => {
    const db = await createStore()
    const before = snapshot(db)
    assert.throws(() => playback.playbackRunTypedSmoke({ version: 1, excess: true }), /typed.*smoke/i)
    assert.deepEqual(snapshot(db), before)

    const core = require('../../src/main/worker/dbService/modules/playback/repository.ts')
    for (const failAt of ['parser', 'result', 'rollback']) {
      assert.throws(() => core.runPlaybackTypedSmokeForTest({ failAt }), new RegExp(failAt, 'i'))
      assert.deepEqual(snapshot(db), before, failAt)
    }
  })
})

describe('Phase 3 startup ordering and sanitized inputs', () => {
  const readyDb = { status: 'ready', existed: true, schemaVersion: 6, migratedVersions: [], backupPath: null }
  const credentialCheck = { vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [] }

  const dependencies = calls => ({
    runState: { begin: async() => { calls.push('run-state'); return true }, markClean: async() => {} },
    preflightLegacyData: async() => { calls.push('legacy'); return { status: 'absent' } },
    initDatabase: async() => { calls.push('database'); return readyDb },
    closeDatabase: () => {},
    runMigrationHooks: async() => { calls.push('migrations') },
    runPlaybackActivityMigration: async() => { calls.push('activity') },
    checkCredentials: async() => { calls.push('credentials'); return credentialCheck },
    verifyPhase2Storage: async() => { calls.push('phase2') },
    now: () => 1_000,
    interruptStalePlaybackSessions: async value => { assert.deepEqual(value, { nowMs: 1_000 }); calls.push('stale') },
    runPlaybackTypedSmoke: async() => { calls.push('smoke'); return { version: 1, writerEvidenceSha256: hashes.f, readerEvidenceSha256: hashes['0'] } },
    getPhase3AttestationPrerequisites: async() => { calls.push('prerequisites'); return { version: 1 } },
    completePhase3Attestation: async value => {
      assert.equal(value.completedAtMs, 1_000)
      assert.equal(value.legacySourceState, 'not-applicable')
      assert.equal('legacyData' in value, false)
      calls.push('attestation')
    },
    initSettings: async() => { calls.push('settings') },
    registerModules: () => { calls.push('modules') },
    appInited: () => { calls.push('app-inited') },
    showRecovery: async() => {},
    flushStores: async() => {},
  })

  it('interrupts stale sessions, rolls back smoke, and writes attestation before any activation', async() => {
    const calls = []
    const { createStorageCoordinator } = require(coordinatorPath)
    const outcome = await createStorageCoordinator(dependencies(calls)).start()
    assert.deepEqual(outcome, { status: 'ready', schemaVersion: 6 })
    assert.deepEqual(calls, [
      'run-state', 'legacy', 'database', 'migrations', 'activity', 'credentials', 'phase2',
      'stale', 'smoke', 'prerequisites', 'attestation', 'settings', 'modules', 'app-inited',
    ])
  })

  it('passes only fixed credential health to the Phase 3 gate', async() => {
    const calls = []
    const rawSource = 'PRIVATE-credential-source-path'
    const deps = dependencies(calls)
    deps.checkCredentials = async() => ({
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: [],
      recoveryPath: rawSource,
      rawSource,
    })
    deps.completePhase3Attestation = async value => {
      assert.equal('credentialCheck' in value, false)
      assert.deepEqual(value.credentialHealth, {
        version: 1,
        status: 'ready',
        vaultReadable: true,
        profileRepositoryReadable: true,
        plaintextSourcesAbsent: true,
      })
      assert.equal(JSON.stringify(value).includes(rawSource), false)
      calls.push('attestation')
    }

    const { createStorageCoordinator } = require(coordinatorPath)
    assert.deepEqual(await createStorageCoordinator(deps).start(), { status: 'ready', schemaVersion: 6 })
  })

  it('fails with a stable code and starts no settings or modules after every gate failure', async() => {
    for (const failed of ['interruptStalePlaybackSessions', 'runPlaybackTypedSmoke', 'getPhase3AttestationPrerequisites', 'completePhase3Attestation']) {
      const calls = []
      const deps = dependencies(calls)
      deps[failed] = async() => { calls.push(`failed:${failed}`); throw Object.assign(new Error('secret payload'), { code: 'phase3_gate_failed' }) }
      const { createStorageCoordinator } = require(coordinatorPath)
      const outcome = await createStorageCoordinator(deps).start()
      assert.deepEqual(outcome, { status: 'fatal', reason: 'phase3_gate_failed' })
      assert.equal(calls.includes('settings'), false)
      assert.equal(calls.includes('modules'), false)
      assert.equal(calls.includes('app-inited'), false)
      delete require.cache[require.resolve(coordinatorPath)]
    }
  })

  it('rejects memory-only, missing, and mismatched quarantine evidence without secret output', () => {
    const { createPhase3AttestationCommand } = require(inputPath)
    const base = {
      completedAtMs: 1_000,
      credential: { state: 'not-applicable', encrypted: false, health: credentialHealth },
      prerequisites: {
        version: 1,
        accountProfile: { markerName: 'legacy_data_v1.account_profiles', state: 'not-applicable', evidenceSha256: hashes['1'] },
        phase2: { markerName: 'legacy_data_v1.phase2_complete', state: 'not-applicable', evidenceSha256: hashes['2'] },
        playbackActivity: { markerName: 'legacy_data_v1.playback_activity', state: 'complete', evidenceSha256: hashes.c },
      },
      activity: {
        sourceState: 'complete',
        legacySourceSha256: hashes.c,
        quarantineRequired: true,
        quarantineSourceSha256: hashes.c,
        quarantineEncrypted: true,
        quarantineVerified: true,
      },
      smoke: { version: 1, writerEvidenceSha256: hashes.f, readerEvidenceSha256: hashes['0'] },
    }
    assert.doesNotThrow(() => createPhase3AttestationCommand(base))

    for (const activity of [
      { ...base.activity, quarantineEncrypted: false },
      { ...base.activity, quarantineVerified: false },
      { ...base.activity, quarantineSourceSha256: hashes.d },
    ]) {
      let error
      try { createPhase3AttestationCommand({ ...base, activity }) } catch (value) { error = value }
      assert.ok(error instanceof Error)
      assert.doesNotMatch(String(error), /PRIVATE|quarantine.*(key|value)|payload/i)
    }
  })

  it('requires complete source hashes and rejects contradictory not-applicable evidence', () => {
    const { createPhase3AttestationCommand } = require(inputPath)
    const base = {
      completedAtMs: 1_000,
      credential: { state: 'not-applicable', encrypted: false, health: credentialHealth },
      prerequisites: {
        version: 1,
        accountProfile: { markerName: 'legacy_data_v1.account_profiles', state: 'not-applicable', evidenceSha256: hashes['1'] },
        phase2: { markerName: 'legacy_data_v1.phase2_complete', state: 'not-applicable', evidenceSha256: hashes['2'] },
        playbackActivity: { markerName: 'legacy_data_v1.playback_activity', state: 'complete', evidenceSha256: hashes.c },
      },
      activity: {
        sourceState: 'complete',
        legacySourceSha256: hashes.c,
        quarantineRequired: false,
        quarantineSourceSha256: null,
        quarantineEncrypted: false,
        quarantineVerified: false,
      },
      smoke: { version: 1, writerEvidenceSha256: hashes.f, readerEvidenceSha256: hashes['0'] },
    }
    assert.doesNotThrow(() => createPhase3AttestationCommand(base))
    assert.throws(() => createPhase3AttestationCommand({
      ...base,
      activity: { ...base.activity, legacySourceSha256: null },
    }), /legacy source/i)
    assert.throws(() => createPhase3AttestationCommand({
      ...base,
      activity: { ...base.activity, legacySourceSha256: 'not-a-hash' },
    }), /legacy source/i)
    assert.throws(() => createPhase3AttestationCommand({
      ...base,
      prerequisites: {
        ...base.prerequisites,
        playbackActivity: {
          ...base.prerequisites.playbackActivity,
          state: 'not-applicable',
          evidenceSha256: notApplicableEvidence('playback-activity'),
        },
      },
      activity: { ...base.activity, sourceState: 'not-applicable', legacySourceSha256: hashes.c },
    }), /legacy source/i)
  })
})
