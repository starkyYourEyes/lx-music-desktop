const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const sourceRoot = path.resolve(__dirname, '../../src')
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

const { DATA_KEYS } = require('../../src/common/constants.ts')
const { createCredentialVault } = require('../../src/main/storage/credentials/credentialVault.ts')
const dbService = require('../../src/main/worker/dbService/db.ts')
const playbackRepository = require('../../src/main/worker/dbService/modules/playback/index.ts')
const { migrateLegacyPlaybackActivity } = require('../../src/main/migration/legacyData/activity.ts')
const { createStorageCoordinator } = require('../../src/main/startup/storageCoordinator.ts')
const { createDataHandlers } = require('../../src/main/modules/winMain/rendererEvent/data.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const tempDirs = []

afterEach(() => {
  try { dbService.close() } catch {}
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

const sha256 = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

const encryptedCipher = () => {
  const key = crypto.createHash('sha256').update('playback-migration-test-key').digest()
  return {
    mode: 'encrypted',
    encrypt(plaintext) {
      const iv = crypto.randomBytes(12)
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    decrypt(payload) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12))
      decipher.setAuthTag(payload.subarray(12, 28))
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}

const memoryOnlyCipher = {
  mode: 'memory-only',
  encrypt() { throw new Error('memory-only') },
  decrypt() { throw new Error('memory-only') },
}

const onlineTrack = (id, overrides = {}) => ({
  id,
  source: 'kw',
  name: `Name ${id}`,
  singer: `Singer ${id}`,
  interval: null,
  meta: {
    songId: id,
    albumName: '',
    qualitys: [],
    _qualitys: {},
    providerUrl: `https://provider.invalid/${id}`,
    apiKey: `SECRET_${id}`,
  },
  ...overrides,
})

const initializeDatabase = async(root) => {
  const result = await dbService.init({
    dataPath: root,
    cacheRoot: path.join(root, 'cache'),
    backupsRoot: path.join(root, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(result.status, 'ready')
}

const createFixture = async(parsed, { vaultMode = 'encrypted' } = {}) => {
  const fixture = createTestStorageRoot('lx-playback-migration')
  tempDirs.push(fixture)
  const root = fixture.path
  await initializeDatabase(root)
  let vault
  const openVault = async() => {
    vault = vaultMode == 'unavailable'
      ? null
      : await createCredentialVault({
        profileRoot: root,
        cipher: vaultMode == 'memory-only' ? memoryOnlyCipher : encryptedCipher(),
        now: () => 111,
      })
  }
  await openVault()
  const snapshot = {
    sourcePath: path.join(root, 'data.json'),
    parsed,
    fileSha256: sha256(parsed),
    fileIdentity: { dev: 1, ino: 1, size: 1, mtimeMs: 1, ctimeMs: 1, birthtimeMs: 1 },
  }
  const repository = {
    importLegacyPlaybackActivity: input => playbackRepository.importLegacyPlaybackActivity(input),
    getPlaybackActivityMigrationMarker: () => playbackRepository.getPlaybackActivityMigrationMarker(),
  }
  const run = (options = {}) => migrateLegacyPlaybackActivity({
    source: snapshot,
    vault,
    repository,
    now: () => 1234,
    ...options,
  })
  const restart = async() => {
    await vault?.flush()
    dbService.close()
    await initializeDatabase(root)
    await openVault()
  }
  return {
    root,
    snapshot,
    run,
    restart,
    db: () => dbService.getDB(),
    vault: () => vault,
  }
}

const marker = db => db.prepare(`
  SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs, details_json AS detailsJson
  FROM migration_markers WHERE name = 'legacy_data_v1.playback_activity'
`).get() ?? null

const recentRows = db => db.prepare(`
  SELECT t.source, t.source_track_id AS sourceTrackId, r.recency_seq AS recencySeq,
    r.legacy_rank AS legacyRank, r.last_played_at_ms AS lastPlayedAtMs,
    r.last_session_id AS lastSessionId, r.updated_at_ms AS updatedAtMs
  FROM recent_tracks r JOIN track_snapshots t ON t.track_id = r.track_id
  ORDER BY r.legacy_rank
`).all()

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count

const insertPlaylistTrack = (db, listId, index, track) => {
  db.prepare(`
    INSERT OR IGNORE INTO my_list(id, name, position) VALUES(?, ?, 0)
  `).run(listId, listId)
  db.prepare(`
    INSERT INTO my_list_music_info(id, listId, name, singer, source, interval, meta)
    VALUES(?, ?, ?, ?, ?, ?, ?)
  `).run(track.id, listId, track.name, track.singer, track.source, track.interval, JSON.stringify(track.meta))
  db.prepare(`
    INSERT INTO my_list_music_info_order(listId, musicInfoId, "order") VALUES(?, ?, ?)
  `).run(listId, track.id, index)
}

describe('legacy playback activity migration', () => {
  it('imports exact independent baselines without synthetic facts or timestamps', async() => {
    const first = onlineTrack('first')
    const second = onlineTrack('second')
    const fixture = await createFixture({
      recentPlayList: [first, first, second],
      listeningTimeStats: {
        totalSeconds: 1.2346,
        daily: { '2026-07-29': 0.3335 },
        songs: {
          duplicate: { id: 'first', source: 'kw', name: 'Older first', singer: 'Older singer', seconds: 0.9004 },
          other: { id: 'stats-only', source: 'kw', name: 'Stats only', singer: 'Stats singer', seconds: 0.1 },
        },
      },
      playInfo: null,
    })

    const result = await fixture.run()
    const db = fixture.db()

    assert.equal(result.status, 'complete')
    assert.deepEqual(recentRows(db), [
      { source: 'kw', sourceTrackId: 'first', recencySeq: -1, legacyRank: 1, lastPlayedAtMs: null, lastSessionId: null, updatedAtMs: 0 },
      { source: 'kw', sourceTrackId: 'second', recencySeq: -2, legacyRank: 2, lastPlayedAtMs: null, lastSessionId: null, updatedAtMs: 0 },
    ])
    assert.equal(count(db, 'track_snapshots'), 3)
    assert.equal(count(db, 'playback_sessions'), 0)
    assert.equal(count(db, 'playback_events'), 0)
    assert.equal(count(db, 'playback_resume_state'), 0)
    assert.deepEqual(db.prepare('SELECT * FROM listening_daily').get(), {
      local_day: '2026-07-29',
      baseline_played_ms: 334,
      live_played_ms: 0,
      baseline_active_ms: 0,
      live_active_ms: 0,
      updated_at_ms: 0,
    })
    assert.deepEqual(db.prepare(`
      SELECT baseline_played_ms, live_played_ms, baseline_active_ms, live_active_ms,
        last_played_at_ms, updated_at_ms FROM listening_tracks ORDER BY track_id
    `).all(), [
      { baseline_played_ms: 900, live_played_ms: 0, baseline_active_ms: 0, live_active_ms: 0, last_played_at_ms: null, updated_at_ms: 0 },
      { baseline_played_ms: 100, live_played_ms: 0, baseline_active_ms: 0, live_active_ms: 0, last_played_at_ms: null, updated_at_ms: 0 },
    ])
    assert.deepEqual(db.prepare('SELECT * FROM activity_totals WHERE id = 1').get(), {
      id: 1,
      baseline_played_ms: 1235,
      live_played_ms: 0,
      baseline_active_ms: 0,
      live_active_ms: 0,
      updated_at_ms: 0,
    })
    const snapshots = db.prepare(`
      SELECT source_track_id AS sourceTrackId, name, playable_payload_json AS playablePayloadJson, updated_at_ms AS updatedAtMs
      FROM track_snapshots ORDER BY source_track_id
    `).all()
    assert.equal(snapshots.find(row => row.sourceTrackId == 'first').name, 'Name first')
    assert.equal(snapshots.find(row => row.sourceTrackId == 'stats-only').playablePayloadJson, null)
    assert.doesNotMatch(snapshots.find(row => row.sourceTrackId == 'first').playablePayloadJson, /SECRET_|provider\.invalid/)
    assert.ok(snapshots.every(row => row.updatedAtMs == 0))
    const details = JSON.parse(marker(db).detailsJson)
    assert.deepEqual(details, {
      version: 1,
      baselineActiveTimeKnown: false,
      dailyCount: 1,
      listeningTrackCount: 2,
      mismatch: { totalVsDailyMs: 901, totalVsTracksMs: 235 },
      recentCount: 2,
      resumeImported: false,
    })
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_markers WHERE name = 'legacy_data_v1.cross_artifact_complete'").get().count, 0)
  })

  it('exact-upserts listening-only snapshots without downgrading overlapping recent snapshots', async() => {
    const recent = onlineTrack('overlap', { name: 'Rich recent', singer: 'Recent singer' })
    const fixture = await createFixture({
      recentPlayList: [recent],
      listeningTimeStats: {
        totalSeconds: 3,
        songs: {
          statsOnly: {
            id: 'stats-only', source: 'kw', name: 'Declared stats', singer: 'Declared singer', seconds: 1,
          },
          overlap: {
            id: 'overlap', source: 'kw', name: 'Older overlap', singer: 'Older singer', seconds: 2,
          },
        },
      },
    })
    const insertSnapshot = fixture.db().prepare(`
      INSERT INTO track_snapshots(
        source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
      ) VALUES(?, ?, ?, ?, ?, ?, ?)
    `)
    insertSnapshot.run('kw', 'stats-only', 'Stale name', 'Stale singer', 999, '{"stale":true}', 777)
    insertSnapshot.run('kw', 'overlap', 'Stale overlap', 'Stale singer', 888, '{"stale":true}', 777)

    const result = await fixture.run()

    assert.equal(result.status, 'complete')
    assert.deepEqual(fixture.db().prepare(`
      SELECT source_track_id AS sourceTrackId, name, singer, duration_ms AS durationMs,
        playable_payload_json AS playablePayloadJson, updated_at_ms AS updatedAtMs
      FROM track_snapshots ORDER BY source_track_id
    `).all(), [
      {
        sourceTrackId: 'overlap',
        name: 'Rich recent',
        singer: 'Recent singer',
        durationMs: null,
        playablePayloadJson: JSON.stringify({
          id: 'overlap',
          interval: null,
          meta: { _qualitys: {}, albumName: '', qualitys: [], songId: 'overlap' },
          name: 'Rich recent',
          singer: 'Recent singer',
          source: 'kw',
        }),
        updatedAtMs: 0,
      },
      {
        sourceTrackId: 'stats-only',
        name: 'Declared stats',
        singer: 'Declared singer',
        durationMs: null,
        playablePayloadJson: null,
        updatedAtMs: 0,
      },
    ])
    assert.ok(marker(fixture.db()))
  })

  it('rolls back before the marker when listening snapshot readback is not exact', async() => {
    const fixture = await createFixture({
      listeningTimeStats: {
        totalSeconds: 1,
        songs: {
          statsOnly: {
            id: 'stats-only', source: 'kw', name: 'Declared stats', singer: 'Declared singer', seconds: 1,
          },
        },
      },
    })
    fixture.db().prepare(`
      INSERT INTO track_snapshots(
        source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
      ) VALUES('kw', 'stats-only', 'Stale name', 'Stale singer', 999, '{"stale":true}', 777)
    `).run()
    fixture.db().exec(`
      CREATE TRIGGER corrupt_listening_snapshot_after_update
      AFTER UPDATE OF name, singer, duration_ms, playable_payload_json, updated_at_ms ON track_snapshots
      WHEN NEW.source = 'kw' AND NEW.source_track_id = 'stats-only'
      BEGIN
        UPDATE track_snapshots SET name = 'Tampered after upsert' WHERE track_id = NEW.track_id;
      END;
    `)

    await assert.rejects(fixture.run(), /tracks.*readback|readback.*tracks/i)

    assert.equal(marker(fixture.db()), null)
    assert.equal(count(fixture.db(), 'listening_tracks'), 0)
    assert.deepEqual(fixture.db().prepare(`
      SELECT name, singer, duration_ms AS durationMs, playable_payload_json AS playablePayloadJson,
        updated_at_ms AS updatedAtMs FROM track_snapshots WHERE source = 'kw' AND source_track_id = 'stats-only'
    `).get(), {
      name: 'Stale name',
      singer: 'Stale singer',
      durationMs: 999,
      playablePayloadJson: '{"stale":true}',
      updatedAtMs: 777,
    })
  })

  it('deduplicates recent identity by first rank and caps the projection at 520', async() => {
    const tracks = Array.from({ length: 523 }, (_, index) => onlineTrack(`track-${index}`))
    tracks.splice(2, 0, tracks[0])
    const fixture = await createFixture({ recentPlayList: tracks })

    await fixture.run()

    const rows = recentRows(fixture.db())
    assert.equal(rows.length, 520)
    assert.equal(rows[0].sourceTrackId, 'track-0')
    assert.equal(rows[1].sourceTrackId, 'track-1')
    assert.equal(rows[2].sourceTrackId, 'track-2')
    assert.equal(rows.at(-1).sourceTrackId, 'track-519')
    assert.deepEqual(rows.map(row => row.recencySeq), Array.from({ length: 520 }, (_, index) => -(index + 1)))
  })

  it('uses collision-free tuple keys and locale-independent canonical activity ordering', async() => {
    const parsed = () => ({
      listeningTimeStats: {
        totalSeconds: 10,
        songs: {
          z: { id: 'id', source: 'z', name: 'Z', singer: 'Singer', seconds: 1 },
          umlaut: { id: 'id', source: '\u00e4', name: 'Umlaut', singer: 'Singer', seconds: 2 },
          nulLeft: { id: 'c', source: 'a\0b', name: 'Nul left', singer: 'Singer', seconds: 3 },
          nulRight: { id: 'b\0c', source: 'a', name: 'Nul right', singer: 'Singer', seconds: 4 },
        },
      },
    })
    const ordinalCompare = (left, right) => left < right ? -1 : left > right ? 1 : 0
    const runWithLocaleDirection = async direction => {
      const originalLocaleCompare = String.prototype.localeCompare
      // eslint-disable-next-line no-extend-native
      String.prototype.localeCompare = function(other) {
        return direction * ordinalCompare(String(this), String(other))
      }
      try {
        const fixture = await createFixture(parsed())
        const result = await fixture.run()
        return {
          result,
          marker: marker(fixture.db()),
          tuples: fixture.db().prepare(`
            SELECT source, source_track_id AS sourceTrackId FROM track_snapshots ORDER BY rowid
          `).all(),
        }
      } finally {
        // eslint-disable-next-line no-extend-native
        String.prototype.localeCompare = originalLocaleCompare
        dbService.close()
      }
    }

    const ascending = await runWithLocaleDirection(1)
    const descending = await runWithLocaleDirection(-1)

    assert.equal(ascending.result.status, 'complete')
    assert.equal(descending.result.status, 'complete')
    assert.equal(ascending.result.sourceSha256, descending.result.sourceSha256)
    assert.ok(ascending.marker)
    assert.ok(descending.marker)
    assert.equal(ascending.tuples.length, 4)
    assert.equal(descending.tuples.length, 4)
    assert.deepEqual(
      new Set(ascending.tuples.map(row => JSON.stringify([row.source, row.sourceTrackId]))),
      new Set([
        JSON.stringify(['z', 'id']),
        JSON.stringify(['\u00e4', 'id']),
        JSON.stringify(['a\0b', 'c']),
        JSON.stringify(['a', 'b\0c']),
      ]),
    )
  })

  it('imports resume only when list identity, index, and positions validate', async() => {
    const validTrack = onlineTrack('resume-track')
    const valid = await createFixture({
      playInfo: { listId: 'list', index: 0, time: 1.2346, maxTime: 5.0004 },
    })
    insertPlaylistTrack(valid.db(), 'list', 0, validTrack)

    await valid.run()

    assert.deepEqual(valid.db().prepare(`
      SELECT source, source_track_id AS sourceTrackId, list_id AS listId, index_hint AS indexHint,
        position_ms AS positionMs, duration_ms AS durationMs, checkpoint_seq AS checkpointSeq,
        updated_at_ms AS updatedAtMs FROM playback_resume_state WHERE id = 1
    `).get(), {
      source: 'kw',
      sourceTrackId: 'resume-track',
      listId: 'list',
      indexHint: 0,
      positionMs: 1235,
      durationMs: 5000,
      checkpointSeq: 0,
      updatedAtMs: 0,
    })
    assert.equal(count(valid.db(), 'playback_sessions'), 0)
    assert.equal(count(valid.db(), 'playback_events'), 0)

    dbService.close()
    const invalid = await createFixture({
      playInfo: { listId: 'missing', index: 0, time: 10, maxTime: 5 },
    })
    await invalid.run()
    assert.equal(count(invalid.db(), 'playback_resume_state'), 0)
  })

  it('handles empty and malformed known activity values as an exact empty baseline', async() => {
    for (const parsed of [{}, { recentPlayList: {}, listeningTimeStats: 'bad', playInfo: { listId: '', index: -1 } }]) {
      const fixture = await createFixture(parsed)
      await fixture.run()
      assert.equal(count(fixture.db(), 'recent_tracks'), 0)
      assert.equal(count(fixture.db(), 'listening_daily'), 0)
      assert.equal(count(fixture.db(), 'listening_tracks'), 0)
      assert.equal(count(fixture.db(), 'playback_resume_state'), 0)
      assert.equal(fixture.db().prepare('SELECT baseline_played_ms FROM activity_totals WHERE id = 1').get().baseline_played_ms, 0)
      assert.ok(marker(fixture.db()))
      dbService.close()
    }
  })

  it('rejects an unrelated caller activity hash before the worker transaction', async() => {
    const fixture = await createFixture({})
    const command = {
      sourceSha256: 'f'.repeat(64),
      completedAtMs: 1234,
      recent: [{
        legacyRank: 1,
        track: {
          source: 'kw',
          sourceTrackId: 'direct-worker',
          name: 'Direct worker',
          singer: 'Singer',
          durationMs: null,
          playablePayload: null,
        },
      }],
      listening: {
        totalPlayedMs: 1000,
        daily: [],
        tracks: [],
        mismatch: { totalVsDailyMs: 1000, totalVsTracksMs: 1000 },
        baselineActiveTimeKnown: false,
      },
      resume: null,
    }

    assert.throws(
      () => playbackRepository.importLegacyPlaybackActivity(command),
      /activity hash|hash mismatch/i,
    )

    assert.equal(marker(fixture.db()), null)
    assert.equal(count(fixture.db(), 'recent_tracks'), 0)
    assert.equal(count(fixture.db(), 'track_snapshots'), 0)
    assert.equal(fixture.db().prepare('SELECT baseline_played_ms FROM activity_totals WHERE id = 1').get().baseline_played_ms, 0)
  })

  it('quarantines only sorted unknown keys in the persistent encrypted vault', async() => {
    const known = Object.fromEntries(Object.values(DATA_KEYS).map(key => [key, null]))
    const fixture = await createFixture({
      ...known,
      listPosition: { legacy: 1 },
      ignoreVersion: 'obsolete',
      lastStartInfo: { obsolete: true },
      zFuture: { secretLike: 'VALUE_Z' },
      aFuture: 'VALUE_A',
    })

    await fixture.run()
    await fixture.vault().flush()

    const read = fixture.vault().read({ kind: 'legacy-quarantine', sourceSha256: fixture.snapshot.fileSha256 })
    assert.equal(read.status, 'available')
    assert.deepEqual(read.value, {
      version: 1,
      sourceSha256: fixture.snapshot.fileSha256,
      keys: ['aFuture', 'zFuture'],
      payload: { aFuture: 'VALUE_A', zFuture: { secretLike: 'VALUE_Z' } },
    })
    const vaultText = fs.readFileSync(path.join(fixture.root, 'credentials.v1.json'), 'utf8')
    assert.doesNotMatch(vaultText, /VALUE_A|VALUE_Z|secretLike/)
    assert.ok(marker(fixture.db()))
  })

  it('requires persistent vault quarantine only when unknown keys exist', async() => {
    for (const vaultMode of ['memory-only', 'unavailable']) {
      const blocked = await createFixture({ future: 'UNKNOWN_VALUE' }, { vaultMode })
      await assert.rejects(blocked.run(), /quarantine|vault|secure/i)
      assert.equal(marker(blocked.db()), null)
      assert.equal(count(blocked.db(), 'recent_tracks'), 0)
      dbService.close()

      const allowed = await createFixture({ recentPlayList: [onlineTrack(`known-${vaultMode}`)] }, { vaultMode })
      await allowed.run()
      assert.ok(marker(allowed.db()))
      assert.equal(count(allowed.db(), 'recent_tracks'), 1)
      dbService.close()
    }
  })

  it('reuses only a matching marker whose attestation and quarantine verify', async() => {
    const fixture = await createFixture({ recentPlayList: [onlineTrack('one')], future: 'UNKNOWN' })
    await fixture.run()
    const before = {
      rows: fixture.db().prepare('SELECT * FROM recent_tracks').all(),
      marker: marker(fixture.db()),
    }

    const repeated = await fixture.run()

    assert.equal(repeated.status, 'already-complete')
    assert.deepEqual(fixture.db().prepare('SELECT * FROM recent_tracks').all(), before.rows)
    assert.deepEqual(marker(fixture.db()), before.marker)

    const quarantineRef = { kind: 'legacy-quarantine', sourceSha256: fixture.snapshot.fileSha256 }
    const mismatchedQuarantine = {
      version: 1,
      sourceSha256: fixture.snapshot.fileSha256,
      keys: ['future'],
      payload: { future: 'MISMATCH' },
    }
    await fixture.vault().write(quarantineRef, mismatchedQuarantine)
    await assert.rejects(fixture.run(), /quarantine.*(mismatch|verification)/i)
    assert.deepEqual(fixture.vault().read(quarantineRef).value, mismatchedQuarantine)
    await fixture.vault().write(quarantineRef, {
      version: 1,
      sourceSha256: fixture.snapshot.fileSha256,
      keys: ['future'],
      payload: { future: 'UNKNOWN' },
    })

    const validDetails = marker(fixture.db()).detailsJson
    fixture.db().prepare(`
      UPDATE migration_markers SET details_json = ? WHERE name = 'legacy_data_v1.playback_activity'
    `).run('{"version":1,"recentCount":999}')
    await assert.rejects(fixture.run(), /marker|attestation|verification/i)
    fixture.db().prepare(`
      UPDATE migration_markers SET details_json = ? WHERE name = 'legacy_data_v1.playback_activity'
    `).run(validDetails)

    const changed = {
      ...fixture.snapshot,
      parsed: { recentPlayList: [onlineTrack('two')] },
      fileSha256: sha256({ recentPlayList: [onlineTrack('two')] }),
    }
    await assert.rejects(fixture.run({ source: changed }), /source conflict/i)
  })

  it('treats the marker as the initial transaction attestation after legal activity evolves', async() => {
    const first = onlineTrack('one')
    const second = onlineTrack('two')
    const fixture = await createFixture({
      recentPlayList: [first, second],
      listeningTimeStats: {
        totalSeconds: 3,
        daily: { '2026-07-29': 2 },
        songs: { first: { ...first, seconds: 2 } },
      },
      playInfo: { listId: 'list', index: 0, time: 1, maxTime: 5 },
    })
    insertPlaylistTrack(fixture.db(), 'list', 0, first)
    insertPlaylistTrack(fixture.db(), 'list', 1, second)
    await fixture.run()

    fixture.db().prepare("DELETE FROM recent_tracks WHERE track_id = (SELECT track_id FROM track_snapshots WHERE source = 'kw' AND source_track_id = 'two')").run()
    fixture.db().prepare('UPDATE recent_tracks SET recency_seq = 42, updated_at_ms = 222').run()
    fixture.db().prepare('UPDATE listening_daily SET live_played_ms = 11, live_active_ms = 7, updated_at_ms = 333').run()
    fixture.db().prepare('UPDATE listening_tracks SET live_played_ms = 13, live_active_ms = 5, last_played_at_ms = 444, updated_at_ms = 444').run()
    fixture.db().prepare('UPDATE activity_totals SET live_played_ms = 17, live_active_ms = 9, updated_at_ms = 555 WHERE id = 1').run()
    fixture.db().prepare('UPDATE playback_resume_state SET checkpoint_seq = 8, position_ms = 2345, updated_at_ms = 666 WHERE id = 1').run()
    fixture.db().prepare("DELETE FROM my_list_music_info_order WHERE listId = 'list'").run()
    fixture.db().prepare('INSERT INTO my_list_music_info_order(listId, musicInfoId, "order") VALUES(?, ?, ?)').run('list', second.id, 0)
    fixture.db().prepare('INSERT INTO my_list_music_info_order(listId, musicInfoId, "order") VALUES(?, ?, ?)').run('list', first.id, 1)

    const evolved = Object.fromEntries([
      'recent_tracks',
      'listening_daily',
      'listening_tracks',
      'activity_totals',
      'playback_resume_state',
      'my_list_music_info_order',
    ].map(table => [table, fixture.db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
    const markerBefore = marker(fixture.db())

    await fixture.restart()
    const result = await fixture.run()

    assert.equal(result.status, 'already-complete')
    assert.equal(result.resumeImported, true)
    for (const [table, rows] of Object.entries(evolved)) {
      assert.deepEqual(fixture.db().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), rows, table)
    }
    assert.deepEqual(marker(fixture.db()), markerBefore)
  })

  it('recovers every database and vault failure boundary across a real restart', async() => {
    const failPoints = ['after-quarantine', 'before-transaction', 'inside-transaction', 'before-marker', 'after-commit']
    for (const failAt of failPoints) {
      const fixture = await createFixture({
        recentPlayList: [onlineTrack('retry')],
        listeningTimeStats: { totalSeconds: 2 },
        future: { value: 'RETRY_SECRET' },
      })

      await assert.rejects(fixture.run({ failAt }), /injected failure/)
      if (['after-quarantine', 'before-transaction', 'inside-transaction', 'before-marker'].includes(failAt)) {
        assert.equal(marker(fixture.db()), null, failAt)
      }
      if (['inside-transaction', 'before-marker'].includes(failAt)) {
        assert.equal(count(fixture.db(), 'recent_tracks'), 0, failAt)
        assert.equal(fixture.db().prepare('SELECT baseline_played_ms FROM activity_totals WHERE id = 1').get().baseline_played_ms, 0, failAt)
      }

      await fixture.restart()
      const result = await fixture.run()
      assert.ok(['complete', 'already-complete'].includes(result.status), failAt)
      assert.equal(count(fixture.db(), 'recent_tracks'), 1, failAt)
      assert.equal(count(fixture.db(), 'listening_tracks'), 0, failAt)
      assert.equal(fixture.db().prepare('SELECT baseline_played_ms FROM activity_totals WHERE id = 1').get().baseline_played_ms, 2000, failAt)
      assert.equal(fixture.db().prepare("SELECT COUNT(*) AS count FROM migration_markers WHERE name = 'legacy_data_v1.playback_activity'").get().count, 1, failAt)
      assert.equal(fixture.vault().read({ kind: 'legacy-quarantine', sourceSha256: fixture.snapshot.fileSha256 }).status, 'available', failAt)

      const rows = fixture.db().prepare('SELECT * FROM recent_tracks').all()
      await fixture.run()
      assert.deepEqual(fixture.db().prepare('SELECT * FROM recent_tracks').all(), rows, failAt)
      dbService.close()
    }
  })

  it('runs the activity importer before storage verification and module registration without freezing legacy handlers', async() => {
    const calls = []
    const legacyStore = new Map()
    const handlers = createDataHandlers(() => ({
      get: key => legacyStore.get(key),
      set: (key, value) => legacyStore.set(key, value),
    }), { getPlaybackActivityMigrationMarker: async() => null })
    const coordinator = createStorageCoordinator({
      runState: { begin: async() => true, markClean: async() => {} },
      preflightLegacyData: async() => ({ status: 'absent' }),
      initDatabase: async() => ({ status: 'ready', schemaVersion: 6, existed: true, databasePath: 'test' }),
      closeDatabase: () => {},
      runMigrationHooks: async() => { calls.push('phase2-migrations') },
      runPlaybackActivityMigration: async() => { calls.push('activity-migration') },
      checkCredentials: async() => {
        calls.push('credential-check')
        return { vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [] }
      },
      verifyPhase2Storage: async() => { calls.push('storage-verification') },
      interruptStalePlaybackSessions: async() => { calls.push('stale-interruption') },
      runPlaybackTypedSmoke: async() => {
        calls.push('playback-smoke')
        return { version: 1, writerEvidenceSha256: 'd'.repeat(64), readerEvidenceSha256: 'e'.repeat(64) }
      },
      getPhase3AttestationPrerequisites: async() => { calls.push('phase3-prerequisites'); return { version: 1 } },
      completePhase3Attestation: async() => { calls.push('phase3-attestation') },
      initSettings: async() => { calls.push('settings') },
      registerModules: () => { calls.push('modules') },
      appInited: () => { calls.push('app-inited') },
      showRecovery: async() => {},
      flushStores: async() => {},
    })

    assert.deepEqual(await coordinator.start(), { status: 'ready', schemaVersion: 6 })
    assert.deepEqual(calls, [
      'phase2-migrations', 'activity-migration', 'credential-check',
      'storage-verification', 'stale-interruption', 'playback-smoke', 'phase3-prerequisites',
      'phase3-attestation', 'settings', 'modules', 'app-inited',
    ])
    await handlers.set({ path: 'playInfo', data: { still: 'writable' } })
    assert.deepEqual(await handlers.get('playInfo'), { still: 'writable' })
  })
})
