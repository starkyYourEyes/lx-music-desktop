const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const Database = require('better-sqlite3')
const typescript = require('typescript')

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

const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')
const dbService = require('../../src/main/worker/dbService/db.ts')
const cacheDb = require('../../src/main/worker/dbService/cacheDb.ts')
const databaseBackup = require('../../src/main/worker/dbService/databaseBackup.ts')

/**
 * Test-only aggregate assembled from the verified backup guard and persisted marker evidence.
 * @typedef {{
 *   backupBasename: string,
 *   backupByteLength: number,
 *   backupSha256: string,
 *   completedAtMs: number,
 *   path: string,
 *   rawLyricsDeletedRows: number,
 *   readWriteMarkerSha256: string,
 * }} CacheCutoverFixtureResult
 */

const fixtures = []
const modulePaths = [
  '../../src/main/worker/dbService/modules/phase4/index.ts',
  '../../src/main/migration/cache/cutover.ts',
  '../../src/main/worker/dbService/migrations/0007_cache_cleanup.ts',
  '../../src/main/worker/dbService/modules/lyric/raw/repository.ts',
  '../../src/main/migration/cache/rawLyrics.ts',
]

const canonical = value => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value != null && typeof value == 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const framedHash = (domain, payload) => {
  const domainBytes = Buffer.from(domain, 'utf8')
  const jsonBytes = Buffer.from(canonical(payload), 'utf8')
  const domainLength = Buffer.alloc(4)
  const jsonLength = Buffer.alloc(4)
  domainLength.writeUInt32BE(domainBytes.length)
  jsonLength.writeUInt32BE(jsonBytes.length)
  return crypto.createHash('sha256')
    .update(domainLength).update(domainBytes)
    .update(jsonLength).update(jsonBytes)
    .digest('hex')
}

const markerHash = row => framedHash('lx.storage.marker-row.v1', {
  completedAtMs: row.completedAtMs,
  detailsJson: row.detailsJson,
  name: row.name,
  sourceSha256: row.sourceSha256,
})

const markerRow = (db, name) => db.prepare(`
  SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs,
    details_json AS detailsJson
  FROM migration_markers WHERE name = ?
`).get(name) ?? null

const rebindRawMarkerChain = (db, mutateRawDetails) => {
  const rawMarker = markerRow(db, 'legacy_cache_v1.raw_lyrics')
  const rawDetails = JSON.parse(rawMarker.detailsJson)
  mutateRawDetails(rawDetails)
  rawMarker.detailsJson = canonical(rawDetails)
  rawMarker.sourceSha256 = rawDetails.sourceSha256
  db.prepare(`
    UPDATE migration_markers SET source_sha256 = ?, details_json = ? WHERE name = ?
  `).run(rawMarker.sourceSha256, rawMarker.detailsJson, rawMarker.name)

  const readWriteMarker = markerRow(db, 'legacy_cache_v1.read_write_verified')
  const readWriteDetails = JSON.parse(readWriteMarker.detailsJson)
  readWriteDetails.rawMarkerSha256 = markerHash(rawMarker)
  readWriteMarker.detailsJson = canonical(readWriteDetails)
  readWriteMarker.sourceSha256 = framedHash('lx.storage.phase4.read-write-details.v1', readWriteDetails)
  db.prepare(`
    UPDATE migration_markers SET source_sha256 = ?, details_json = ? WHERE name = ?
  `).run(readWriteMarker.sourceSha256, readWriteMarker.detailsJson, readWriteMarker.name)

  const cutoverMarker = markerRow(db, 'legacy_cache_v1.cutover')
  const cutoverDetails = JSON.parse(cutoverMarker.detailsJson)
  cutoverDetails.readWriteMarkerSha256 = markerHash(readWriteMarker)
  cutoverMarker.detailsJson = canonical(cutoverDetails)
  cutoverMarker.sourceSha256 = framedHash(
    `lx.storage.phase4.cutover-details.v${cutoverDetails.version}`,
    cutoverDetails,
  )
  db.prepare(`
    UPDATE migration_markers SET source_sha256 = ?, details_json = ? WHERE name = ?
  `).run(cutoverMarker.sourceSha256, cutoverMarker.detailsJson, cutoverMarker.name)
}

const phase3Marker = () => {
  const detailsJson = canonical({
    version: 1,
    checks: [
      { name: 'credentials', version: 1, state: 'complete', evidenceSha256: 'a'.repeat(64) },
      { name: 'account-profile', version: 1, state: 'complete', evidenceSha256: 'b'.repeat(64) },
      { name: 'phase2-storage', version: 1, state: 'complete', evidenceSha256: 'c'.repeat(64) },
      { name: 'playback-activity', version: 1, state: 'complete', evidenceSha256: 'd'.repeat(64) },
      { name: 'quarantine', version: 1, state: 'complete', evidenceSha256: 'e'.repeat(64) },
      { name: 'playback-writer', version: 1, state: 'complete', evidenceSha256: 'f'.repeat(64) },
      { name: 'playback-reader', version: 1, state: 'complete', evidenceSha256: '0'.repeat(64) },
    ],
  })
  return {
    name: 'legacy_data_v1.cross_artifact_complete',
    sourceSha256: crypto.createHash('sha256').update(detailsJson).digest('hex'),
    completedAtMs: 1,
    detailsJson,
  }
}

const putPhase3Marker = db => {
  const value = phase3Marker()
  db.prepare(`
    INSERT INTO migration_markers(name, source_sha256, completed_at_ms, details_json)
    VALUES (?, ?, ?, ?)
  `).run(value.name, value.sourceSha256, value.completedAtMs, value.detailsJson)
}

const createSchema6Fixture = async(prefix = 'cache-cutover') => {
  const fixture = createTestStorageRoot(prefix)
  fixtures.push(fixture)
  const profileRoot = path.join(fixture.path, 'profile')
  const cacheRoot = path.join(fixture.path, 'cache')
  const backupsRoot = path.join(fixture.path, 'backups')
  const result = await dbService.init({
    dataPath: profileRoot,
    cacheRoot,
    backupsRoot,
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(result.status, 'ready')
  assert.equal(result.schemaVersion, 6)
  putPhase3Marker(dbService.getAppDB())
  dbService.close()
  const relaunched = await dbService.init({
    dataPath: profileRoot,
    cacheRoot,
    backupsRoot,
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(relaunched.status, 'ready')
  assert.equal(relaunched.schemaVersion, 6)
  return {
    fixture,
    profileRoot,
    cacheRoot,
    backupsRoot,
    databasePath: path.join(profileRoot, 'lx.data.db'),
    cachePath: path.join(cacheRoot, 'cache.db'),
  }
}

const seedLyrics = db => {
  const insert = db.prepare('INSERT INTO lyric(id, source, type, text) VALUES (?, ?, ?, ?)')
  insert.run('raw-track', 'raw', 'lyric', Buffer.from('raw lyric').toString('base64'))
  insert.run('raw-track', 'raw', 'tlyric', Buffer.from('raw translation').toString('base64'))
  insert.run('edited-track', 'edited', 'lyric', Buffer.from('edited lyric').toString('base64'))
  return db.prepare("SELECT id, source, type, text FROM lyric WHERE source = 'edited' ORDER BY rowid").all()
}

const loadPhase4 = () => require('../../src/main/worker/dbService/modules/phase4/index.ts')
const loadRawMigration = () => require('../../src/main/migration/cache/rawLyrics.ts')
const loadRawRepository = () => require('../../src/main/worker/dbService/modules/lyric/raw/repository.ts')

let preparedFixture = null

const listPreparedCandidates = () => fs.readdirSync(preparedFixture.backupsRoot)
  .filter(name => /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$/.test(name))

const readPreparedMarker = () => {
  const row = markerRow(dbService.getAppDB(), 'legacy_cache_v1.backup_prepared')
  assert.notEqual(row, null)
  return { ...row, details: JSON.parse(row.detailsJson) }
}

const readCutoverDetails = () => {
  const row = markerRow(dbService.getAppDB(), 'legacy_cache_v1.cutover')
  assert.notEqual(row, null)
  return JSON.parse(row.detailsJson)
}

const readPreparedArtifact = () => {
  const marker = readPreparedMarker()
  const artifactPath = path.join(preparedFixture.backupsRoot, marker.details.backupBasename)
  return {
    basename: marker.details.backupBasename,
    byteLength: fs.statSync(artifactPath).size,
    bytes: fs.readFileSync(artifactPath),
    path: artifactPath,
  }
}

const readPrefix = (filePath, byteLength) => fs.readFileSync(filePath).subarray(0, byteLength)

const prepareExistingSchema6 = async(prefix = 'cache-cutover-prepared') => {
  const paths = await createSchema6Fixture(prefix)
  const db = dbService.getAppDB()
  seedLyrics(db)
  assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
  assert.equal((await loadRawMigration().migrateRawLyrics({ nowMs: 10 })).status, 'complete')
  const cutover = require('../../src/main/migration/cache/cutover.ts')
  assert.equal((await cutover.attestSchema6TypedOwnership(db, 20)).status, 'completed')
  loadRawRepository().enterRawLyricCutoverPending()
  preparedFixture = { ...paths, db }
  return preparedFixture
}

const fixtureAggregate = advanced => {
  const cutover = markerRow(dbService.getAppDB(), 'legacy_cache_v1.cutover')
  const cutoverDetails = JSON.parse(cutover.detailsJson)
  if (cutoverDetails.version == 2) {
    assert.equal(cutoverDetails.backupRequired, true)
    return {
      backupBasename: cutoverDetails.backupBasename,
      backupByteLength: cutoverDetails.backupByteLength,
      backupSha256: cutoverDetails.backupSha256,
      completedAtMs: cutoverDetails.completedAtMs,
      path: advanced.backupPath,
      rawLyricsDeletedRows: cutoverDetails.rawLyricsDeletedRows,
      readWriteMarkerSha256: cutoverDetails.readWriteMarkerSha256,
    }
  }

  const marker = readPreparedMarker()
  const artifact = readPreparedArtifact()
  const expectedSha256 = crypto.createHash('sha256').update(artifact.bytes).digest('hex')
  const guard = databaseBackup.verifyRecordedOnlineBackup({
    backupsRoot: preparedFixture.backupsRoot,
    basename: marker.details.backupBasename,
    expectedSha256,
    expectedByteLength: artifact.byteLength,
    expectedSourceSchemaVersion: 6,
    nativeOptions: {},
    verifier: backupDb => require('../../src/main/migration/cache/cutover.ts')
      .verifyCutoverBackup(backupDb, marker.details.readWriteMarkerSha256),
  })
  try {
    assert.equal(guard.path, advanced.backupPath)
    return {
      backupBasename: guard.basename,
      backupByteLength: guard.byteLength,
      backupSha256: guard.sha256,
      completedAtMs: marker.completedAtMs,
      path: guard.path,
      rawLyricsDeletedRows: cutoverDetails.rawLyricsDeletedRows,
      readWriteMarkerSha256: marker.details.readWriteMarkerSha256,
    }
  } finally {
    guard.close()
  }
}

/** @returns {Promise<CacheCutoverFixtureResult>} */
const advanceExistingSchema6 = async() => {
  const advanced = await dbService.advanceAppDatabase({
    targetSchemaVersion: 7,
    backupsRoot: preparedFixture.backupsRoot,
  })
  return fixtureAggregate(advanced)
}

/** @returns {Promise<CacheCutoverFixtureResult>} */
const advanceFixture = async({ events = [] } = {}) => {
  await prepareExistingSchema6('cache-cutover-prepared-order')
  const originalWriteSync = fs.writeSync
  let observedBackupWrite = false
  fs.writeSync = function(descriptor, buffer, ...args) {
    if (!observedBackupWrite && Buffer.isBuffer(buffer) && readPreparedMarker() != null) {
      observedBackupWrite = true
      events.push('prepared-marker.commit', 'backup.write')
    }
    return originalWriteSync.call(this, descriptor, buffer, ...args)
  }
  try {
    return await advanceExistingSchema6()
  } finally {
    fs.writeSync = originalWriteSync
  }
}

/** @returns {Promise<CacheCutoverFixtureResult>} */
const retryAdvance = async() => await advanceExistingSchema6()

const failFirstAdvanceAfterBytes = async(bytesWritten, code) => {
  await prepareExistingSchema6(`cache-cutover-prefix-${bytesWritten}`)
  const originalWriteSync = fs.writeSync
  let failed = false
  fs.writeSync = function(descriptor, buffer, offset, length, position) {
    if (!failed && Buffer.isBuffer(buffer) && markerRow(preparedFixture.db, 'legacy_cache_v1.backup_prepared') != null) {
      failed = true
      if (bytesWritten > 0) originalWriteSync.call(this, descriptor, buffer, offset, Math.min(length, bytesWritten), position)
      throw Object.assign(new Error(code), { code })
    }
    return originalWriteSync.apply(this, arguments)
  }
  try {
    await assert.rejects(advanceExistingSchema6(), error => error?.code == code || error?.message == 'artifact_verification_failed')
  } finally {
    fs.writeSync = originalWriteSync
  }
}

const createPreparedPrefix = async() => await failFirstAdvanceAfterBytes(4096, 'ENOSPC')
const mutatePreparedPrefixByte = () => {
  const artifact = readPreparedArtifact()
  const bytes = Buffer.from(artifact.bytes)
  bytes[Math.min(128, bytes.length - 1)] ^= 0xff
  fs.writeFileSync(artifact.path, bytes)
}

const crashAfterPreparedMarkerCommit = async({ bytesWritten }) =>
  await failFirstAdvanceAfterBytes(bytesWritten, 'injected_after_prepared_marker')

const mutateAuthoritativeRowOutOfBand = () => {
  preparedFixture.db.prepare("UPDATE lyric SET text = ? WHERE id = 'edited-track'").run('out-of-band-change')
}

const restartAndRetryAdvance = async() => await retryAdvance()

const advanceWithFinalGuardReplacement = async() => {
  await prepareExistingSchema6('cache-cutover-final-guard-rollback')
  const migration7 = require('../../src/main/worker/dbService/migrations/0007_cache_cleanup.ts').migration7
  const originalVerify = migration7.verify
  migration7.verify = function(database, context) {
    originalVerify.call(this, database, context)
    const details = context.cacheCleanup.cutover
    assert.equal(details.backupRequired, true)
    const backupPath = path.join(preparedFixture.backupsRoot, details.backupBasename)
    fs.appendFileSync(backupPath, Buffer.from([0]))
  }
  try {
    return await advanceExistingSchema6()
  } finally {
    migration7.verify = originalVerify
  }
}

const installHistoricalV1Cutover = () => {
  const db = dbService.getAppDB()
  const current = readCutoverDetails()
  assert.equal(current.version, 2)
  assert.equal(current.backupRequired, true)
  const readWriteMarker = markerRow(db, 'legacy_cache_v1.read_write_verified')
  const backupBasename = `lx.data.db.pre-migration-v6-to-v7.${markerHash(readWriteMarker)}.backup`
  const backupPath = path.join(preparedFixture.backupsRoot, backupBasename)
  fs.copyFileSync(path.join(preparedFixture.backupsRoot, current.backupBasename), backupPath)
  fs.unlinkSync(path.join(preparedFixture.backupsRoot, current.backupBasename))
  const historical = {
    completedAtMs: current.completedAtMs,
    fromSchemaVersion: 6,
    rawLyricsDeletedRows: current.rawLyricsDeletedRows,
    readWriteMarkerSha256: current.readWriteMarkerSha256,
    removedObjects: ['index_music_info_other_source', 'music_info_other_source', 'music_url'],
    toSchemaVersion: 7,
    version: 1,
  }
  db.prepare(`
    UPDATE migration_markers SET source_sha256 = ?, details_json = ?
    WHERE name = 'legacy_cache_v1.cutover'
  `).run(framedHash('lx.storage.phase4.cutover-details.v1', historical), canonical(historical))
  assert.equal(markerRow(db, 'legacy_cache_v1.backup_prepared'), null)
  return { backupBasename, backupPath }
}

const closeServices = async() => {
  try { await cacheDb.closeCacheDatabase() } catch {}
  try { dbService.close() } catch {}
}

afterEach(async() => {
  preparedFixture = null
  await closeServices()
  for (const fixture of fixtures.splice(0).reverse()) fixture.cleanup()
  for (const modulePath of modulePaths) {
    try { delete require.cache[require.resolve(modulePath)] } catch {}
  }
})

const rawEvidence = {
  identity: { provider: '__lx_phase4_smoke_v1__', sourceTrackId: 'raw' },
  read: { lyric: 'phase4-raw-lyric-v1', tlyric: 'phase4-raw-tlyric-v1' },
  written: { lyric: 'phase4-raw-lyric-v1', tlyric: 'phase4-raw-tlyric-v1' },
}

const urlEvidence = {
  expiredReadMiss: true,
  expiryGetNowMs: 1,
  freshGetNowMs: 0,
  freshReadMatched: true,
  identity: {
    accountScope: 'profile-v1:user-id:9007199254740991',
    provider: 'wy',
    quality: '128k',
    sourceTrackId: '__lx_phase4_smoke_v1__:url',
  },
  providerExpiresAtMs: 1,
  putNowMs: 0,
}

const firstCandidates = [{
  id: '__lx_phase4_smoke_v1__:old',
  interval: '00:01',
  meta: { albumName: 'phase4-old' },
  name: 'phase4-old',
  singer: 'phase4',
  source: 'wy',
}]

const replacementCandidates = [
  {
    id: '__lx_phase4_smoke_v1__:new-b',
    interval: '00:02',
    meta: { albumName: 'phase4-new-b' },
    name: 'phase4-new-b',
    singer: 'phase4',
    source: 'wy',
  },
  {
    id: '__lx_phase4_smoke_v1__:new-a',
    interval: '00:03',
    meta: { albumName: 'phase4-new-a' },
    name: 'phase4-new-a',
    singer: 'phase4',
    source: 'wy',
  },
]

const otherEvidence = {
  firstCandidates,
  identity: { originalProvider: '__lx_phase4_smoke_v1__', originalTrackId: 'other' },
  readCandidates: replacementCandidates,
  replacementCandidates,
  staleCandidatesAbsent: true,
}

describe('typed cache ownership and guarded schema-7 cutover', () => {
  it('accepts the structured music URL value in the typed cache smoke', async() => {
    await createSchema6Fixture('cache-cutover-structured-url-smoke')
    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    const result = await require('../../src/main/migration/cache/cutover.ts').runTypedCacheSmoke()
    assert.equal(result.status, 'completed')
    assert.equal(result.value.some(check => check.name == 'music-url-write-read-expiry'), true)
  })

  it('refuses direct target 7 before creating or mutating the authoritative database', async() => {
    const fixture = createTestStorageRoot('cache-cutover-direct-target')
    fixtures.push(fixture)
    const profileRoot = path.join(fixture.path, 'profile')
    await assert.rejects(dbService.init({
      dataPath: profileRoot,
      cacheRoot: path.join(fixture.path, 'cache'),
      backupsRoot: path.join(fixture.path, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 7,
    }), error => error?.code == 'database_direct_schema7_forbidden')
    assert.equal(fs.existsSync(profileRoot), false)
  })

  it('refuses omitted, stale, and future normal-init targets before creating storage', async() => {
    for (const targetSchemaVersion of [undefined, 5, 8, '6', '7']) {
      const fixture = createTestStorageRoot(`cache-cutover-invalid-init-target-${String(targetSchemaVersion)}`)
      fixtures.push(fixture)
      const profileRoot = path.join(fixture.path, 'profile')
      const options = {
        dataPath: profileRoot,
        cacheRoot: path.join(fixture.path, 'cache'),
        backupsRoot: path.join(fixture.path, 'backups'),
        previousShutdownWasClean: true,
        targetSchemaVersion,
      }
      if (targetSchemaVersion === undefined) delete options.targetSchemaVersion

      try {
        await assert.rejects(
          dbService.init(options),
          error => error?.code == 'database_initialization_invalid',
        )
        assert.equal(fs.existsSync(profileRoot), false)
      } finally {
        await closeServices()
      }
    }
  })

  it('attests exact typed evidence, advances the same handle, and commits the cutover atomically', async() => {
    const paths = await createSchema6Fixture('cache-cutover-success')
    const db = dbService.getAppDB()
    const editedBefore = seedLyrics(db)
    const connectionIdentity = dbService.getAppDB()
    const schema6Snapshot = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })

    assert.deepEqual(await loadPhase4().initializePhase4(), {
      schemaVersion: 7,
      typedOwnershipVerified: true,
    })

    assert.equal(dbService.getAppDB(), connectionIdentity)
    assert.equal(schema6Snapshot.schemaVersion, 6)
    assert.equal(dbService.getDatabaseHealth().schemaVersion, 7)
    assert.equal(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '7')
    assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 0)
    assert.deepEqual(db.prepare("SELECT id, source, type, text FROM lyric WHERE source = 'edited' ORDER BY rowid").all(), editedBefore)
    for (const name of ['index_music_info_other_source', 'music_info_other_source', 'music_url']) {
      assert.equal(db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name), undefined)
    }

    const rawMarker = markerRow(db, 'legacy_cache_v1.raw_lyrics')
    const readWriteMarker = markerRow(db, 'legacy_cache_v1.read_write_verified')
    const readWriteDetails = {
      cacheSchemaVersion: 1,
      checks: [
        {
          evidenceSha256: framedHash('lx.storage.phase4.smoke-evidence.v1/raw-lyric-write-read', rawEvidence),
          name: 'raw-lyric-write-read',
          version: 1,
        },
        {
          evidenceSha256: framedHash('lx.storage.phase4.smoke-evidence.v1/music-url-write-read-expiry', urlEvidence),
          name: 'music-url-write-read-expiry',
          version: 1,
        },
        {
          evidenceSha256: framedHash('lx.storage.phase4.smoke-evidence.v1/other-sources-atomic-replace-read', otherEvidence),
          name: 'other-sources-atomic-replace-read',
          version: 1,
        },
      ],
      completedAtMs: readWriteMarker.completedAtMs,
      rawMarkerSha256: markerHash(rawMarker),
      version: 1,
    }
    assert.equal(readWriteMarker.detailsJson, canonical(readWriteDetails))
    assert.equal(
      readWriteMarker.sourceSha256,
      framedHash('lx.storage.phase4.read-write-details.v1', readWriteDetails),
    )

    const cutoverMarker = markerRow(db, 'legacy_cache_v1.cutover')
    const backupArtifacts = fs.readdirSync(paths.backupsRoot)
    assert.equal(backupArtifacts.length, 1)
    const backupName = backupArtifacts[0]
    const backupPath = path.join(paths.backupsRoot, backupName)
    const backupBytes = fs.readFileSync(backupPath)
    const cutoverDetails = {
      backupBasename: backupName,
      backupByteLength: backupBytes.length,
      backupRequired: true,
      backupSha256: crypto.createHash('sha256').update(backupBytes).digest('hex'),
      backupSourceSchemaVersion: 6,
      completedAtMs: cutoverMarker.completedAtMs,
      fromSchemaVersion: 6,
      rawLyricsDeletedRows: 2,
      readWriteMarkerSha256: markerHash(readWriteMarker),
      removedObjects: ['index_music_info_other_source', 'music_info_other_source', 'music_url'],
      toSchemaVersion: 7,
      version: 2,
    }
    assert.equal(cutoverMarker.detailsJson, canonical(cutoverDetails))
    assert.equal(cutoverMarker.sourceSha256, framedHash('lx.storage.phase4.cutover-details.v2', cutoverDetails))
    assert.notEqual(cutoverMarker.sourceSha256, cutoverDetails.readWriteMarkerSha256)
    assert.equal(db.prepare('SELECT applied_at_ms AS appliedAtMs FROM schema_migrations WHERE version = 7').get().appliedAtMs, cutoverMarker.completedAtMs)

    assert.match(backupName, /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$/)
    assert.deepEqual(backupArtifacts, [backupName])
    const finalStat = fs.lstatSync(backupPath, { bigint: true })
    assert.equal(finalStat.nlink, 1n)
    assert.equal(markerRow(db, 'legacy_cache_v1.backup_prepared'), null)

    const smokeResidue = await cacheDb.runCacheRead(cache => ({
      raw: cache.prepare("SELECT count(*) AS count FROM raw_lyric_groups WHERE provider = '__lx_phase4_smoke_v1__'").get().count,
      urls: cache.prepare("SELECT count(*) AS count FROM music_urls WHERE source_track_id = '__lx_phase4_smoke_v1__:url'").get().count,
      other: cache.prepare("SELECT count(*) AS count FROM other_source_groups WHERE original_provider = '__lx_phase4_smoke_v1__'").get().count,
    }))
    assert.deepEqual(smokeResidue, { status: 'hit', value: { raw: 0, urls: 0, other: 0 } })
    const laterStartup = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(schema6Snapshot.schemaVersion, 6)
    assert.equal(laterStartup.schemaVersion, 7)
  })

  it('does not let SQLite planner statistics prevent backup source binding during schema-7 cutover', async() => {
    const paths = await createSchema6Fixture('cache-cutover-planner-statistics')
    const db = dbService.getAppDB()
    seedLyrics(db)
    db.exec('ANALYZE')
    const internalTables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'sqlite_stat%'
      ORDER BY name
    `).all().map(row => row.name)
    assert.equal(internalTables.includes('sqlite_stat1'), true)

    assert.deepEqual(await loadPhase4().initializePhase4(), {
      schemaVersion: 7,
      typedOwnershipVerified: true,
    })
    const backupNames = fs.readdirSync(paths.backupsRoot)
    assert.equal(backupNames.length, 1)
    const backupPath = path.join(paths.backupsRoot, backupNames[0])
    assert.match(backupNames[0], /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$/)
    assert.ok(fs.statSync(backupPath).size > 0)
    assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 0)
  })

  it('counts duplicate and invalid raw rows while schema 7 deletes every physical authoritative raw row', async() => {
    await createSchema6Fixture('cache-cutover-duplicate-invalid-raw')
    const db = dbService.getAppDB()
    const duplicateText = Buffer.from('duplicate lyric').toString('base64')
    const insert = db.prepare('INSERT INTO lyric(id, source, type, text) VALUES (?, ?, ?, ?)')
    insert.run('duplicate-track', 'raw', 'lyric', duplicateText)
    insert.run('duplicate-track', 'raw', 'lyric', duplicateText)
    insert.run('invalid-track', 'raw', 'unsupported', Buffer.from('ignored lyric').toString('base64'))

    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    const migration = await loadRawMigration().migrateRawLyrics({ nowMs: 10 })
    assert.equal(migration.status, 'complete')
    assert.equal(migration.sourceRows, 1)
    assert.equal(migration.sourceOwnerGroups, 1)
    assert.equal(migration.skippedInvalidRows, 2)
    assert.equal(migration.targetRows, 1)
    const rawMarker = markerRow(db, 'legacy_cache_v1.raw_lyrics')
    assert.notEqual(rawMarker, null)
    const rawDetails = JSON.parse(rawMarker.detailsJson)
    assert.equal(rawDetails.sourceRows, 1)
    assert.equal(rawDetails.sourceOwnerGroups, 1)
    assert.equal(rawDetails.skippedInvalidRows, 2)
    assert.equal(rawDetails.targetRows, 1)

    assert.deepEqual(await loadPhase4().initializePhase4(), {
      schemaVersion: 7,
      typedOwnershipVerified: true,
    })
    assert.equal(dbService.getDatabaseHealth().schemaVersion, 7)
    assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 0)
    assert.equal(readCutoverDetails().rawLyricsDeletedRows, 3)
  })

  it('writes cutover v2 with exact backup evidence and removes prepared marker atomically', async() => {
    await prepareExistingSchema6('cache-cutover-v2-evidence')
    const result = await advanceExistingSchema6()
    assert.deepEqual(readCutoverDetails(), {
      backupBasename: result.backupBasename,
      backupByteLength: result.backupByteLength,
      backupRequired: true,
      backupSha256: result.backupSha256,
      backupSourceSchemaVersion: 6,
      completedAtMs: result.completedAtMs,
      fromSchemaVersion: 6,
      rawLyricsDeletedRows: result.rawLyricsDeletedRows,
      readWriteMarkerSha256: result.readWriteMarkerSha256,
      removedObjects: ['index_music_info_other_source', 'music_info_other_source', 'music_url'],
      toSchemaVersion: 7,
      version: 2,
    })
    assert.equal(markerRow(preparedFixture.db, 'legacy_cache_v1.backup_prepared'), null)
  })

  it('rolls schema ledger and markers back when the final in-transaction guard changes', async() => {
    await assert.rejects(advanceWithFinalGuardReplacement(), /backup_evidence_changed/)
    const db = preparedFixture.db
    assert.equal(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '6')
    assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version = 7').get(), undefined)
    assert.equal(markerRow(db, 'legacy_cache_v1.cutover'), null)
    assert.notEqual(markerRow(db, 'legacy_cache_v1.backup_prepared'), null)
  })

  it('requires migration 7 cutover context and its exact completed timestamp', async() => {
    await prepareExistingSchema6('cache-cutover-migration-context')
    const migration7 = require('../../src/main/worker/dbService/migrations/0007_cache_cleanup.ts').migration7
    const originalUp = migration7.up
    const originalVerify = migration7.verify
    let upInspected = false
    let verifyInspected = false
    migration7.up = function(database, context) {
      upInspected = true
      assert.throws(
        () => originalUp.call(this, database, { appliedAtMs: context.appliedAtMs }),
        /phase4_cutover_marker_invalid/,
      )
      assert.throws(
        () => originalUp.call(this, database, { ...context, appliedAtMs: context.appliedAtMs + 1 }),
        /phase4_cutover_marker_invalid/,
      )
      return originalUp.call(this, database, context)
    }
    migration7.verify = function(database, context) {
      verifyInspected = true
      assert.throws(
        () => originalVerify.call(this, database, { appliedAtMs: context.appliedAtMs }),
        /phase4_cutover_marker_invalid/,
      )
      assert.throws(
        () => originalVerify.call(this, database, { ...context, appliedAtMs: context.appliedAtMs + 1 }),
        /phase4_cutover_marker_invalid/,
      )
      return originalVerify.call(this, database, context)
    }
    try {
      await advanceExistingSchema6()
    } finally {
      migration7.up = originalUp
      migration7.verify = originalVerify
    }
    assert.equal(upInspected, true)
    assert.equal(verifyInspected, true)
  })

  it('fresh database reaches schema 7 with backupRequired false and no backups root', async() => {
    const fixture = createTestStorageRoot('cache-cutover-fresh-v2')
    fixtures.push(fixture)
    const profileRoot = path.join(fixture.path, 'profile')
    const cacheRoot = path.join(fixture.path, 'cache')
    const backupsRoot = path.join(fixture.path, 'backups-never-created')
    const startup = await dbService.init({
      dataPath: profileRoot,
      cacheRoot,
      backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(startup.existed, false)
    putPhase3Marker(dbService.getAppDB())

    assert.deepEqual(await loadPhase4().initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    const db = dbService.getAppDB()
    const readWriteMarker = markerRow(db, 'legacy_cache_v1.read_write_verified')
    const cutoverMarker = markerRow(db, 'legacy_cache_v1.cutover')
    assert.deepEqual(JSON.parse(cutoverMarker.detailsJson), {
      backupRequired: false,
      completedAtMs: cutoverMarker.completedAtMs,
      fromSchemaVersion: 6,
      rawLyricsDeletedRows: 0,
      readWriteMarkerSha256: markerHash(readWriteMarker),
      removedObjects: ['index_music_info_other_source', 'music_info_other_source', 'music_url'],
      toSchemaVersion: 7,
      version: 2,
    })
    assert.equal(
      cutoverMarker.sourceSha256,
      framedHash('lx.storage.phase4.cutover-details.v2', JSON.parse(cutoverMarker.detailsJson)),
    )
    assert.equal(fs.existsSync(backupsRoot), false)
  })

  it('requires backup evidence for an existing empty-looking schema-6 database', async() => {
    const paths = await createSchema6Fixture('cache-cutover-existing-empty')
    const db = dbService.getAppDB()
    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    assert.equal((await loadRawMigration().migrateRawLyrics({ nowMs: 10 })).sourceRows, 0)
    const cutover = require('../../src/main/migration/cache/cutover.ts')
    assert.equal((await cutover.attestSchema6TypedOwnership(db, 20)).status, 'completed')
    loadRawRepository().enterRawLyricCutoverPending()
    preparedFixture = { ...paths, db }

    const result = await advanceExistingSchema6()
    assert.equal(readCutoverDetails().backupRequired, true)
    assert.equal(readCutoverDetails().backupBasename, result.backupBasename)
    assert.equal(readCutoverDetails().rawLyricsDeletedRows, 0)
    assert.equal(fs.existsSync(path.join(paths.backupsRoot, result.backupBasename)), true)
  })

  it('keeps schema 6 and the healthy cache ready for every logical typed smoke mismatch', async t => {
    const cases = [
      {
        name: 'raw lyric write/read',
        sql: `CREATE TRIGGER phase4_raw_mismatch AFTER INSERT ON raw_lyrics
          WHEN NEW.provider = '__lx_phase4_smoke_v1__'
          BEGIN UPDATE raw_lyrics SET text = 'mismatch' WHERE provider = NEW.provider AND source_track_id = NEW.source_track_id; END`,
      },
      {
        name: 'URL write/read/expiry',
        sql: `CREATE TRIGGER phase4_url_mismatch AFTER INSERT ON music_urls
          WHEN NEW.source_track_id = '__lx_phase4_smoke_v1__:url'
          BEGIN UPDATE music_urls SET url = 'https://phase4.invalid/mismatch' WHERE source_track_id = NEW.source_track_id; END`,
      },
      {
        name: 'alternate-source atomic replace/read',
        sql: `CREATE TRIGGER phase4_other_mismatch AFTER INSERT ON other_sources
          WHEN NEW.candidate_track_id = '__lx_phase4_smoke_v1__:new-b'
          BEGIN DELETE FROM other_sources WHERE original_provider = NEW.original_provider AND original_track_id = NEW.original_track_id AND rank = NEW.rank; END`,
      },
    ]

    for (const testCase of cases) await t.test(testCase.name, async() => {
      await createSchema6Fixture(`cache-cutover-smoke-${testCase.name.replace(/[^a-z]+/gi, '-')}`)
      const db = dbService.getAppDB()
      seedLyrics(db)
      assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
      assert.equal((await loadRawMigration().migrateRawLyrics({ nowMs: 10 })).status, 'complete')
      assert.equal((await cacheDb.runCacheWrite(cache => cache.exec(testCase.sql))).status, 'stored')

      await assert.rejects(
        loadPhase4().initializePhase4(),
        error => error?.code == 'phase4_cache_smoke_failed' && error?.message == 'phase4_cache_smoke_failed',
      )
      assert.equal(dbService.getDatabaseInitialization().schemaVersion, 6)
      assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 2)
      assert.equal(markerRow(db, 'legacy_cache_v1.read_write_verified'), null)
      assert.equal(await cacheDb.getCacheLifecycleState(), 'ready')

      await closeServices()
    })
  })

  it('rejects a conflicting raw marker before writing typed ownership', async() => {
    await createSchema6Fixture('cache-cutover-raw-marker-conflict')
    const db = dbService.getAppDB()
    seedLyrics(db)
    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    assert.equal((await loadRawMigration().migrateRawLyrics({ nowMs: 10 })).status, 'complete')
    db.prepare('INSERT INTO lyric(id, source, type, text) VALUES (?, ?, ?, ?)')
      .run('late-raw-track', 'raw', 'lyric', Buffer.from('late raw lyric').toString('base64'))

    await assert.rejects(
      loadPhase4().initializePhase4(),
      error => error?.code == 'raw_lyric_marker_conflict',
    )
    assert.equal(dbService.getDatabaseInitialization().schemaVersion, 6)
    assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 3)
    assert.equal(markerRow(db, 'legacy_cache_v1.read_write_verified'), null)
    assert.equal(markerRow(db, 'legacy_cache_v1.cutover'), null)
    assert.equal(await cacheDb.getCacheLifecycleState(), 'ready')
    assert.equal(loadRawRepository().getRawLyricFallbackState(), 'schema6-fallback')
  })

  it('rejects a malformed existing typed marker before opening or repairing the cache', async() => {
    const paths = await createSchema6Fixture('cache-cutover-malformed-existing-marker')
    const db = dbService.getAppDB()
    seedLyrics(db)
    const phase4 = loadPhase4()
    const originalAdvance = dbService.advanceAppDatabase
    dbService.advanceAppDatabase = async() => {
      throw Object.assign(new Error('stop-after-attestation'), { code: 'stop-after-attestation' })
    }
    try {
      await assert.rejects(phase4.initializePhase4(), /stop-after-attestation/)
    } finally {
      dbService.advanceAppDatabase = originalAdvance
    }
    assert.notEqual(markerRow(db, 'legacy_cache_v1.read_write_verified'), null)

    await cacheDb.closeCacheDatabase()
    const invalidCache = Buffer.from('preserve-cache-before-marker-validation')
    fs.writeFileSync(paths.cachePath, invalidCache)
    db.prepare(`
      UPDATE migration_markers SET details_json = ?
      WHERE name = 'legacy_cache_v1.read_write_verified'
    `).run('{"version":1}')

    await assert.rejects(
      phase4.initializePhase4(),
      error => error?.code == 'phase4_read_write_marker_invalid',
    )
    assert.equal(await cacheDb.getCacheLifecycleState(), 'closed')
    assert.deepEqual(fs.readFileSync(paths.cachePath), invalidCache)
    assert.equal(dbService.getDatabaseInitialization().schemaVersion, 6)
  })

  it('preserves an unavailable cache and retains schema-6 authoritative fallback', async() => {
    const paths = await createSchema6Fixture('cache-cutover-unavailable-schema6')
    const db = dbService.getAppDB()
    seedLyrics(db)
    fs.mkdirSync(paths.cacheRoot, { recursive: true })
    const invalidCache = Buffer.from('preserve-invalid-schema6-cache')
    fs.writeFileSync(paths.cachePath, invalidCache)

    assert.deepEqual(await loadPhase4().initializePhase4(), {
      schemaVersion: 6,
      typedOwnershipVerified: false,
    })
    assert.deepEqual(fs.readFileSync(paths.cachePath), invalidCache)
    assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 2)
    assert.equal(markerRow(db, 'legacy_cache_v1.raw_lyrics'), null)
    assert.equal(markerRow(db, 'legacy_cache_v1.read_write_verified'), null)
    assert.equal(await cacheDb.getCacheLifecycleState(), 'unavailable')
    assert.equal(loadRawRepository().getRawLyricFallbackState(), 'schema6-fallback')
    assert.deepEqual(await loadRawRepository().rawLyricGet({
      provider: 'tx', sourceTrackId: 'raw-track', nowMs: 100,
    }), {
      status: 'hit',
      value: { lyric: 'raw lyric', tlyric: 'raw translation' },
    })
  })

  it('commits backup-prepared before the first backup byte and binds one unique basename', async() => {
    const events = []
    const result = await advanceFixture({ events })
    assert.deepEqual(events.slice(0, 2), ['prepared-marker.commit', 'backup.write'])
    assert.match(result.backupBasename, /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$/)
    assert.equal(markerRow(preparedFixture.db, 'legacy_cache_v1.backup_prepared'), null)
  })

  it('resumes an ENOSPC prefix only after exact prefix verification', async() => {
    await failFirstAdvanceAfterBytes(4096, 'ENOSPC')
    const first = readPreparedArtifact()
    const second = await retryAdvance()
    assert.equal(second.backupBasename, first.basename)
    assert.equal(readPrefix(second.path, 4096).equals(first.bytes), true)
    assert.equal(listPreparedCandidates().length, 1)
  })

  it('retains and blocks a mismatched marker-bound prefix without allocating another attempt', async() => {
    await createPreparedPrefix()
    mutatePreparedPrefixByte()
    await assert.rejects(retryAdvance(), /backup_prepared_conflict/)
    assert.equal(listPreparedCandidates().length, 1)
  })

  it('rejects changed authoritative state before resuming even with a zero-length prefix', async() => {
    await crashAfterPreparedMarkerCommit({ bytesWritten: 0 })
    mutateAuthoritativeRowOutOfBand()
    await assert.rejects(restartAndRetryAdvance(), /backup_prepared_source_changed/)
    assert.equal(readPreparedArtifact().byteLength, 0)
    assert.equal(listPreparedCandidates().length, 1)
  })

  it('rejects a source mutation beyond an existing short prefix before serialization or append', async() => {
    await createPreparedPrefix()
    const first = readPreparedArtifact()
    mutateAuthoritativeRowOutOfBand()
    await assert.rejects(retryAdvance(), /backup_prepared_source_changed/)
    assert.equal(readPreparedArtifact().bytes.equals(first.bytes), true)
    assert.equal(listPreparedCandidates().length, 1)
  })

  it('rejects an added ordinary column before preparing a backup', async() => {
    await prepareExistingSchema6('cache-cutover-unknown-ordinary-column')
    preparedFixture.db.exec('ALTER TABLE local_state ADD COLUMN review_extra TEXT')

    await assert.rejects(advanceExistingSchema6(), /phase4_schema_invalid/)
    assert.equal(fs.existsSync(preparedFixture.backupsRoot), false)
    assert.equal(markerRow(preparedFixture.db, 'legacy_cache_v1.backup_prepared'), null)
  })

  it('rejects a generated column hidden from table_info before preparing a backup', async() => {
    await prepareExistingSchema6('cache-cutover-unknown-generated-column')
    preparedFixture.db.exec(`
      ALTER TABLE local_state ADD COLUMN review_generated TEXT
      GENERATED ALWAYS AS (value_json) VIRTUAL
    `)
    assert.equal(preparedFixture.db.pragma('table_info(local_state)').some(row => row.name == 'review_generated'), false)
    assert.equal(preparedFixture.db.pragma('table_xinfo(local_state)').some(row =>
      row.name == 'review_generated' && row.hidden != 0), true)

    await assert.rejects(advanceExistingSchema6(), /phase4_schema_invalid/)
    assert.equal(fs.existsSync(preparedFixture.backupsRoot), false)
    assert.equal(markerRow(preparedFixture.db, 'legacy_cache_v1.backup_prepared'), null)
  })

  it('retains an unreferenced zero-byte artifact when the prepared-marker commit fails', async() => {
    await prepareExistingSchema6('cache-cutover-prepared-commit-failure')
    const db = preparedFixture.db
    const originalPrepare = db.prepare
    db.prepare = function(sql) {
      const statement = originalPrepare.call(this, sql)
      if (!String(sql).includes('INSERT INTO migration_markers')) return statement
      return new Proxy(statement, {
        get(target, property, receiver) {
          if (property != 'run') return Reflect.get(target, property, receiver)
          return (...args) => {
            if (args[0] == 'legacy_cache_v1.backup_prepared') {
              throw Object.assign(new Error('prepared-marker-commit-failed'), { code: 'prepared-marker-commit-failed' })
            }
            return target.run(...args)
          }
        },
      })
    }
    try {
      await assert.rejects(advanceExistingSchema6(), /prepared-marker-commit-failed/)
    } finally {
      db.prepare = originalPrepare
    }
    assert.equal(markerRow(db, 'legacy_cache_v1.backup_prepared'), null)
    const artifacts = fs.readdirSync(preparedFixture.backupsRoot)
    assert.equal(artifacts.length, 1)
    assert.equal(fs.statSync(path.join(preparedFixture.backupsRoot, artifacts[0])).size, 0)
  })

  it('reuses one prepared attempt across write verification and cutover failures', async() => {
    await failFirstAdvanceAfterBytes(4096, 'ENOSPC')
    const basename = readPreparedMarker().details.backupBasename
    const cutover = require('../../src/main/migration/cache/cutover.ts')
    const originalVerifier = cutover.verifyCutoverBackup
    cutover.verifyCutoverBackup = () => { throw new Error('injected-backup-verification') }
    try {
      await assert.rejects(retryAdvance(), /injected-backup-verification|backup_verification_failed/)
    } finally {
      cutover.verifyCutoverBackup = originalVerifier
    }

    const migration7 = require('../../src/main/worker/dbService/migrations/0007_cache_cleanup.ts').migration7
    const originalUp = migration7.up
    migration7.up = function(database, context) {
      originalUp.call(this, database, context)
      throw new Error('injected-cutover-failure')
    }
    try {
      await assert.rejects(retryAdvance(), /injected-cutover-failure/)
    } finally {
      migration7.up = originalUp
    }

    const completed = await retryAdvance()
    assert.equal(completed.backupBasename, basename)
    assert.deepEqual(listPreparedCandidates(), [basename])
  })

  it('reuses immutable attestation after a pre-migration failure and rolls migration 7 back before one retry', async() => {
    const paths = await createSchema6Fixture('cache-cutover-retry')
    const db = dbService.getAppDB()
    seedLyrics(db)
    const phase4 = loadPhase4()
    const originalAdvance = dbService.advanceAppDatabase
    dbService.advanceAppDatabase = async() => { throw Object.assign(new Error('injected-before-advance'), { code: 'injected-before-advance' }) }
    await assert.rejects(phase4.initializePhase4(), /injected-before-advance/)
    const readWriteBefore = markerRow(db, 'legacy_cache_v1.read_write_verified')
    assert.notEqual(readWriteBefore, null)
    assert.equal(dbService.getDatabaseInitialization().schemaVersion, 6)
    dbService.advanceAppDatabase = originalAdvance

    const migration7 = require('../../src/main/worker/dbService/migrations/0007_cache_cleanup.ts').migration7
    const originalUp = migration7.up
    let attempts = 0
    migration7.up = function(database, context) {
      attempts++
      originalUp.call(this, database, context)
      throw new Error('injected-inside-migration-7')
    }
    await assert.rejects(phase4.initializePhase4(), /injected-inside-migration-7/)
    migration7.up = originalUp
    assert.equal(attempts, 1)
    assert.equal(dbService.getDatabaseInitialization().schemaVersion, 6)
    assert.equal(loadRawMigration().countAuthoritativeRawRows(db), 2)
    assert.equal(markerRow(db, 'legacy_cache_v1.cutover'), null)
    assert.deepEqual(markerRow(db, 'legacy_cache_v1.read_write_verified'), readWriteBefore)

    assert.deepEqual(await phase4.initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    assert.equal(attempts, 1)
    assert.equal(fs.readdirSync(paths.backupsRoot).length, 1)
    assert.deepEqual(markerRow(db, 'legacy_cache_v1.read_write_verified'), readWriteBefore)
  })

  it('authenticates a prepared schema-6 backup before publishing an already-committed schema 7', async() => {
    const paths = await createSchema6Fixture('cache-cutover-publication-retry')
    const db = dbService.getAppDB()
    seedLyrics(db)
    const phase4 = loadPhase4()
    const rawRepository = loadRawRepository()
    const originalPublishFallback = rawRepository.enterRawLyricSchema7CacheOnly
    let publicationAttempts = 0
    rawRepository.enterRawLyricSchema7CacheOnly = () => {
      publicationAttempts++
      if (publicationAttempts == 1) throw new Error('injected-after-migration-7-commit')
      return originalPublishFallback()
    }

    try {
      await assert.rejects(phase4.initializePhase4(), /injected-after-migration-7-commit/)
      assert.equal(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '7')
      assert.equal(rawRepository.getRawLyricFallbackState(), 'cutover-pending-cache-only')
      const ledgerAfterCommit = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all()
      const cutoverAfterCommit = markerRow(db, 'legacy_cache_v1.cutover')
      const backupsAfterCommit = fs.readdirSync(paths.backupsRoot)
      const backupName = backupsAfterCommit.find(name => name.endsWith('.backup'))
      assert.equal(typeof backupName, 'string')
      const backupPath = path.join(paths.backupsRoot, backupName)
      const originalPath = `${backupPath}.review-original`
      const replacementPath = `${backupPath}.review-replacement`
      fs.copyFileSync(backupPath, replacementPath)
      const replacement = new Database(replacementPath)
      replacement.prepare(`
        INSERT INTO local_state(key, version, value_json, updated_at_ms)
        VALUES ('view_prev_state', 1, '{"review":true}', 30)
        ON CONFLICT(key) DO UPDATE SET
          version = excluded.version,
          value_json = excluded.value_json,
          updated_at_ms = excluded.updated_at_ms
      `).run()
      replacement.close()
      fs.renameSync(backupPath, originalPath)
      fs.renameSync(replacementPath, backupPath)
      try {
        await assert.rejects(
          phase4.initializePhase4(),
          error => error?.code == 'database_advance_backup_invalid',
        )
      } finally {
        fs.unlinkSync(backupPath)
        fs.renameSync(originalPath, backupPath)
      }
      assert.equal(publicationAttempts, 1)
      assert.equal(rawRepository.getRawLyricFallbackState(), 'cutover-pending-cache-only')

      assert.deepEqual(await phase4.initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
      assert.equal(publicationAttempts, 2)
      assert.equal(rawRepository.getRawLyricFallbackState(), 'schema7-cache-only')
      assert.deepEqual(db.prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledgerAfterCommit)
      assert.deepEqual(markerRow(db, 'legacy_cache_v1.cutover'), cutoverAfterCommit)
      assert.deepEqual(fs.readdirSync(paths.backupsRoot), backupsAfterCommit)
    } finally {
      rawRepository.enterRawLyricSchema7CacheOnly = originalPublishFallback
    }
  })

  it('deduplicates identical same-connection advances and rejects conflicting backup roots', async() => {
    const paths = await createSchema6Fixture('cache-cutover-concurrent-advance')
    const db = dbService.getAppDB()
    seedLyrics(db)
    assert.equal((await cacheDb.openCacheDatabase()).status, 'created')
    assert.equal((await loadRawMigration().migrateRawLyrics({ nowMs: 10 })).status, 'complete')
    const cutover = require('../../src/main/migration/cache/cutover.ts')
    assert.equal((await cutover.attestSchema6TypedOwnership(db, 20)).status, 'completed')
    loadRawRepository().enterRawLyricCutoverPending()

    const first = dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot })
    const second = dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot })
    assert.equal(first, second)
    await assert.rejects(
      dbService.advanceAppDatabase({
        targetSchemaVersion: 7,
        backupsRoot: path.join(paths.fixture.path, 'other-backups'),
      }),
      error => error?.code == 'database_advance_conflict',
    )
    const advanced = await first
    assert.equal(advanced.schemaVersion, 7)
    assert.equal(dbService.getAppDB(), db)
    assert.equal(fs.readdirSync(paths.backupsRoot).length, 1)
    assert.match(readCutoverDetails().backupBasename, /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$/)
  })

  it('relaunches exact schema 7 without replaying migration or backup and reruns live typed smoke', async() => {
    const paths = await createSchema6Fixture('cache-cutover-relaunch')
    seedLyrics(dbService.getAppDB())
    assert.deepEqual(await loadPhase4().initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    const backupNames = fs.readdirSync(paths.backupsRoot)
    const ledgerBefore = dbService.getAppDB().prepare('SELECT * FROM schema_migrations ORDER BY version').all()

    await closeServices()
    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.status, 'ready')
    assert.equal(relaunched.schemaVersion, 7)
    assert.deepEqual(relaunched.migratedVersions, [])
    assert.equal(relaunched.backupPath, null)
    assert.deepEqual(fs.readdirSync(paths.backupsRoot), backupNames)
    assert.deepEqual(dbService.getAppDB().prepare('SELECT * FROM schema_migrations ORDER BY version').all(), ledgerBefore)
    assert.deepEqual(await loadPhase4().initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    assert.equal((await cacheDb.runCacheRead(cache => cache.prepare('SELECT count(*) AS count FROM raw_lyric_groups').get().count)).status, 'hit')
  })

  it('resolves only the exact v2 backup basename while ignoring unknown artifacts', async() => {
    await prepareExistingSchema6('cache-cutover-v2-exact-backup')
    const result = await advanceExistingSchema6()
    const unknownBasename = `lx.data.db.pre-migration-v6-to-v7.${'0'.repeat(64)}.backup`
    assert.notEqual(result.backupBasename, unknownBasename)
    const unknownPath = path.join(preparedFixture.backupsRoot, unknownBasename)
    const unknownBytes = Buffer.from('unknown-backup-artifact')
    fs.writeFileSync(unknownPath, unknownBytes)
    const cutoverBefore = markerRow(preparedFixture.db, 'legacy_cache_v1.cutover')
    const rootBefore = fs.readdirSync(preparedFixture.backupsRoot).sort()

    const paths = preparedFixture
    await closeServices()
    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.schemaVersion, 7)
    assert.deepEqual(await loadPhase4().initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    assert.deepEqual(fs.readdirSync(paths.backupsRoot).sort(), rootBefore)
    assert.deepEqual(fs.readFileSync(unknownPath), unknownBytes)
    assert.deepEqual(markerRow(dbService.getAppDB(), 'legacy_cache_v1.cutover'), cutoverBefore)
  })

  it('resolves historical v1 evidence read-only without repair, relink, deletion, rewrite, or scan', async() => {
    await prepareExistingSchema6('cache-cutover-v1-read-only')
    await advanceExistingSchema6()
    const { backupBasename, backupPath } = installHistoricalV1Cutover()
    const unknownBasename = `lx.data.db.pre-migration-v6-to-v7.${'0'.repeat(64)}.backup`
    assert.notEqual(backupBasename, unknownBasename)
    const unknownPath = path.join(preparedFixture.backupsRoot, unknownBasename)
    fs.writeFileSync(unknownPath, 'historical-unknown-artifact')
    const paths = preparedFixture
    const rootBefore = fs.readdirSync(paths.backupsRoot).sort()
    const bytesBefore = new Map(rootBefore.map(name => [name, fs.readFileSync(path.join(paths.backupsRoot, name))]))
    const linksBefore = new Map(rootBefore.map(name => [
      name,
      fs.lstatSync(path.join(paths.backupsRoot, name), { bigint: true }).nlink,
    ]))
    const cutoverBefore = markerRow(paths.db, 'legacy_cache_v1.cutover')
    assert.equal(markerRow(paths.db, 'legacy_cache_v1.backup_prepared'), null)
    const backupBytes = fs.readFileSync(backupPath)

    await closeServices()
    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.schemaVersion, 7)
    fs.writeFileSync(backupPath, 'invalid historical backup')
    await assert.rejects(
      dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot }),
      error => error?.code == 'database_advance_backup_invalid',
    )
    fs.writeFileSync(backupPath, backupBytes)
    const advanced = await dbService.advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot: paths.backupsRoot })
    assert.equal(advanced.backupPath, backupPath)
    assert.deepEqual(await loadPhase4().initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    assert.deepEqual(fs.readdirSync(paths.backupsRoot).sort(), rootBefore)
    for (const name of rootBefore) {
      const artifactPath = path.join(paths.backupsRoot, name)
      assert.deepEqual(fs.readFileSync(artifactPath), bytesBefore.get(name))
      assert.equal(fs.lstatSync(artifactPath, { bigint: true }).nlink, linksBefore.get(name))
    }
    assert.deepEqual(markerRow(dbService.getAppDB(), 'legacy_cache_v1.cutover'), cutoverBefore)
    assert.equal(markerRow(dbService.getAppDB(), 'legacy_cache_v1.backup_prepared'), null)
  })

  it('rejects malformed cutover v2 true and false unions even with matching marker hashes', async() => {
    await prepareExistingSchema6('cache-cutover-v2-malformed-unions')
    const result = await advanceExistingSchema6()
    const db = preparedFixture.db
    const readWriteMarker = markerRow(db, 'legacy_cache_v1.read_write_verified')
    const valid = {
      backupBasename: result.backupBasename,
      backupByteLength: result.backupByteLength,
      backupRequired: true,
      backupSha256: result.backupSha256,
      backupSourceSchemaVersion: 6,
      completedAtMs: result.completedAtMs,
      fromSchemaVersion: 6,
      rawLyricsDeletedRows: result.rawLyricsDeletedRows,
      readWriteMarkerSha256: result.readWriteMarkerSha256,
      removedObjects: ['index_music_info_other_source', 'music_info_other_source', 'music_url'],
      toSchemaVersion: 7,
      version: 2,
    }
    const { backupSha256, ...missingTrueEvidence } = valid
    const falseDetails = {
      backupRequired: false,
      completedAtMs: valid.completedAtMs,
      fromSchemaVersion: 6,
      rawLyricsDeletedRows: valid.rawLyricsDeletedRows,
      readWriteMarkerSha256: valid.readWriteMarkerSha256,
      removedObjects: valid.removedObjects,
      toSchemaVersion: 7,
      version: 2,
    }
    const invalidDetails = [
      { ...valid, backupRequired: false },
      missingTrueEvidence,
      { ...falseDetails, backupBasename: valid.backupBasename },
      { ...falseDetails, backupRequired: 'false' },
    ]

    for (const details of invalidDetails) {
      db.prepare(`
        UPDATE migration_markers SET source_sha256 = ?, details_json = ?
        WHERE name = 'legacy_cache_v1.cutover'
      `).run(framedHash('lx.storage.phase4.cutover-details.v2', details), canonical(details))
      assert.throws(
        () => require('../../src/main/migration/cache/cutover.ts').readCutoverMarker(db, readWriteMarker),
        /phase4_cutover_marker_invalid/,
      )
    }
  })

  it('rejects traversal in the exact v2 backup basename', async() => {
    await prepareExistingSchema6('cache-cutover-v2-traversal')
    const result = await advanceExistingSchema6()
    const db = preparedFixture.db
    const readWriteMarker = markerRow(db, 'legacy_cache_v1.read_write_verified')
    const details = {
      ...readCutoverDetails(),
      backupBasename: '../lx.data.db.pre-migration-v6-to-v7.escape.backup',
    }
    db.prepare(`
      UPDATE migration_markers SET source_sha256 = ?, details_json = ?
      WHERE name = 'legacy_cache_v1.cutover'
    `).run(framedHash('lx.storage.phase4.cutover-details.v2', details), canonical(details))
    assert.equal(result.backupBasename.includes('..'), false)
    assert.throws(
      () => require('../../src/main/migration/cache/cutover.ts').readCutoverMarker(db, readWriteMarker),
      /phase4_cutover_marker_invalid/,
    )
  })

  it('rejects a schema-7 relaunch whose raw marker claims unequal source and target rows', async() => {
    const paths = await createSchema6Fixture('cache-cutover-impossible-raw-marker')
    seedLyrics(dbService.getAppDB())
    assert.equal((await loadPhase4().initializePhase4()).schemaVersion, 7)
    await closeServices()
    const cacheBefore = fs.readFileSync(paths.cachePath)

    const direct = new Database(paths.databasePath)
    rebindRawMarkerChain(direct, rawDetails => { rawDetails.targetRows = rawDetails.sourceRows + 1 })
    direct.close()

    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.status, 'recovery')
    assert.deepEqual(fs.readFileSync(paths.cachePath), cacheBefore)
  })

  it('rejects a schema-7 relaunch whose raw marker claims unequal source and target owner groups', async() => {
    const paths = await createSchema6Fixture('cache-cutover-impossible-owner-marker')
    seedLyrics(dbService.getAppDB())
    assert.equal((await loadPhase4().initializePhase4()).schemaVersion, 7)
    await closeServices()
    const cacheBefore = fs.readFileSync(paths.cachePath)

    const direct = new Database(paths.databasePath)
    rebindRawMarkerChain(direct, rawDetails => {
      rawDetails.targetOwnerGroups = rawDetails.sourceOwnerGroups + 1
    })
    direct.close()

    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.status, 'recovery')
    assert.deepEqual(fs.readFileSync(paths.cachePath), cacheBefore)
  })

  it('keeps a schema-7 relaunch cache-only when the preserved cache is unavailable', async() => {
    const paths = await createSchema6Fixture('cache-cutover-degraded-relaunch')
    const db = dbService.getAppDB()
    seedLyrics(db)
    assert.deepEqual(await loadPhase4().initializePhase4(), { schemaVersion: 7, typedOwnershipVerified: true })
    await closeServices()

    const invalidCache = Buffer.from('preserve-invalid-schema7-cache')
    fs.writeFileSync(paths.cachePath, invalidCache)
    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.status, 'ready')
    assert.equal(relaunched.schemaVersion, 7)
    assert.deepEqual(await loadPhase4().initializePhase4(), {
      schemaVersion: 7,
      typedOwnershipVerified: false,
    })
    assert.deepEqual(fs.readFileSync(paths.cachePath), invalidCache)
    dbService.getAppDB().prepare('INSERT INTO lyric(id, source, type, text) VALUES (?, ?, ?, ?)')
      .run('schema7-degraded-raw', 'raw', 'lyric', Buffer.from('must-not-read').toString('base64'))

    const originalGetAppDB = dbService.getAppDB
    const relaunchedDb = originalGetAppDB()
    const sql = []
    dbService.getAppDB = () => new Proxy(relaunchedDb, {
      get(target, property, receiver) {
        if (property == 'prepare') return statement => {
          sql.push(statement)
          return target.prepare(statement)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    try {
      assert.deepEqual(await loadRawRepository().rawLyricGet({
        provider: 'tx', sourceTrackId: 'schema7-degraded-raw', nowMs: 100,
      }), { status: 'miss' })
    } finally {
      dbService.getAppDB = originalGetAppDB
    }
    assert.equal(sql.some(statement => /\bFROM\s+lyric\b/i.test(statement)), false)
  })

  it('rejects a mismatched schema-7 cutover before opening or mutating cache.db', async() => {
    const paths = await createSchema6Fixture('cache-cutover-invalid-relaunch')
    seedLyrics(dbService.getAppDB())
    assert.equal((await loadPhase4().initializePhase4()).schemaVersion, 7)
    await closeServices()
    const cacheBefore = fs.readFileSync(paths.cachePath)
    const direct = new Database(paths.databasePath)
    direct.prepare("UPDATE migration_markers SET source_sha256 = ? WHERE name = 'legacy_cache_v1.cutover'").run('0'.repeat(64))
    direct.close()

    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.status, 'recovery')
    assert.deepEqual(fs.readFileSync(paths.cachePath), cacheBefore)
  })

  it('rejects a version above the known registry without touching cache.db', async() => {
    const paths = await createSchema6Fixture('cache-cutover-future-schema')
    seedLyrics(dbService.getAppDB())
    assert.equal((await loadPhase4().initializePhase4()).schemaVersion, 7)
    await closeServices()
    const cacheBefore = fs.readFileSync(paths.cachePath)
    const direct = new Database(paths.databasePath)
    direct.prepare(`
      INSERT INTO schema_migrations(version, name, checksum, applied_at_ms)
      VALUES (8, 'future_schema', ?, 1)
    `).run('f'.repeat(64))
    direct.prepare("UPDATE db_info SET field_value = '8' WHERE field_name = 'version'").run()
    direct.close()

    const relaunched = await dbService.init({
      dataPath: paths.profileRoot,
      cacheRoot: paths.cacheRoot,
      backupsRoot: paths.backupsRoot,
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(relaunched.status, 'recovery')
    assert.equal(relaunched.reason, 'schema_invalid')
    assert.deepEqual(relaunched.diagnostics, ['schema.verify_failed'])
    assert.deepEqual(fs.readFileSync(paths.cachePath), cacheBefore)
  })

  it('never falls back to authoritative raw lyrics after a verified cutover', async() => {
    await createSchema6Fixture('cache-cutover-cache-only')
    const db = dbService.getAppDB()
    seedLyrics(db)
    assert.equal((await loadPhase4().initializePhase4()).schemaVersion, 7)
    db.prepare('INSERT INTO lyric(id, source, type, text) VALUES (?, ?, ?, ?)')
      .run('post-cutover-raw', 'raw', 'lyric', Buffer.from('must-not-read').toString('base64'))
    await loadRawRepository().rawLyricClear()

    const originalGetAppDB = dbService.getAppDB
    const sql = []
    dbService.getAppDB = () => new Proxy(db, {
      get(target, property, receiver) {
        if (property == 'prepare') return statement => {
          sql.push(statement)
          return target.prepare(statement)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    try {
      assert.deepEqual(await loadRawRepository().rawLyricGet({
        provider: 'tx', sourceTrackId: 'post-cutover-raw', nowMs: 100,
      }), { status: 'miss' })
    } finally {
      dbService.getAppDB = originalGetAppDB
    }
    assert.equal(sql.some(statement => /\bFROM\s+lyric\b/i.test(statement)), false)
  })
})
