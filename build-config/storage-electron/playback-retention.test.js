const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// Electron ABI tests transpile source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

process.env.TZ = 'UTC'

const dbService = require('../../src/main/worker/dbService/db.ts')
const repository = require('../../src/main/worker/dbService/modules/playback/index.ts')
const { evaluateVacuumEligibility } = require('../../src/main/worker/dbService/modules/playback/retention.ts')

const tempDirs = []
const yearMs = 365 * 24 * 60 * 60 * 1000
const group = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  try { dbService.close() } catch {}
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const createStore = async() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-playback-retention-'))
  tempDirs.push(root)
  const result = await dbService.init({
    dataPath: root,
    backupDir: path.join(root, 'backups'),
    previousShutdownWasClean: true,
  })
  assert.equal(result.status, 'ready')
  return dbService.getDB()
}

const track = id => ({
  source: 'test',
  sourceTrackId: id,
  name: `Track ${id}`,
  singer: `Singer ${id}`,
  durationMs: 240000,
  playablePayload: null,
})

const start = (db, { id = 'one', at = 1000, consent = {}, playbackGroupUuid = group } = {}) => {
  const result = repository.playbackStart({
    version: 1,
    playbackGroupUuid,
    track: track(id),
    context: { type: null, id: null },
    resume: { listId: null, indexHint: null },
    startReason: 'select',
    startPositionMs: 0,
    occurredAtMs: at,
    consent: { recentAllowed: true, statsAllowed: true, privateMode: false, ...consent },
  })
  assert.equal(result.mode, 'activity')
  return result.ack
}

const commit = ({
  playbackGroupUuid = group,
  checkpointSeq = 2,
  played = 500,
  active = 700,
  at = 2000,
  fact,
} = {}) =>
  repository.playbackCommit({
    version: 1,
    checkpoint: {
      playbackGroupUuid,
      checkpointSeq,
      cumulativePlayedMs: played,
      cumulativeActiveMs: active,
      positionMs: played,
      durationMs: 240000,
      occurredAtMs: at,
    },
    ...(fact == null ? {} : { fact }),
  })

const total = db => db.prepare(`
  SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
    baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs
  FROM activity_totals WHERE id = 1
`).get()

const daily = db => db.prepare(`
  SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
    baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs
  FROM listening_daily WHERE local_day = '1970-01-01'
`).get()

const listeningTrack = db => db.prepare(`
  SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
    baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs
  FROM listening_tracks
`).get()

const terminalFact = { version: 1, type: 'play_end', reason: 'natural_end' }

describe('playback retention', () => {
  it('moves eligible played and active contributions to every baseline before cascading a closed session', async() => {
    const db = await createStore()
    start(db)
    commit({ fact: terminalFact })
    const before = { total: total(db), daily: daily(db), track: listeningTrack(db) }

    const result = repository.playbackCompact({ version: 1, nowMs: yearMs + 3000, batchSize: 500 })

    assert.deepEqual(result, { version: 1, deleted: 1, remainingEligible: 0 })
    assert.deepEqual(total(db), {
      baselinePlayedMs: 500,
      livePlayedMs: 0,
      baselineActiveMs: 700,
      liveActiveMs: 0,
    })
    assert.deepEqual(daily(db), total(db))
    assert.deepEqual(listeningTrack(db), total(db))
    for (const key of ['baselinePlayedMs', 'livePlayedMs', 'baselineActiveMs', 'liveActiveMs']) {
      assert.equal(before.total[key], before.daily[key])
      assert.equal(before.total[key], before.track[key])
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, 0)
    assert.deepEqual(repository.playbackCompact({ version: 1, nowMs: yearMs + 3000, batchSize: 500 }), {
      version: 1,
      deleted: 0,
      remainingEligible: 0,
    })
  })

  it('compacts interrupted rows and skips statistics transfer for disallowed and pre-cutoff segments', async() => {
    const db = await createStore()
    start(db)
    commit()
    repository.playbackMarkStaleSessionsInterrupted({ nowMs: 3000 })
    db.prepare('UPDATE projection_state SET visible_after_ms = 1500 WHERE name = \'statistics\'').run()

    assert.deepEqual(repository.playbackCompact({ version: 1, nowMs: yearMs + 4000, batchSize: 1 }), {
      version: 1,
      deleted: 1,
      remainingEligible: 0,
    })
    assert.deepEqual(total(db), {
      baselinePlayedMs: 0,
      livePlayedMs: 500,
      baselineActiveMs: 0,
      liveActiveMs: 700,
    })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions').get().count, 0)
  })

  it('uses a strict 365-day age boundary and deletes statistics-disabled sessions without transfer', async() => {
    const db = await createStore()
    start(db)
    commit({ fact: terminalFact })

    assert.deepEqual(repository.playbackCompact({ version: 1, nowMs: yearMs + 2000, batchSize: 500 }), {
      version: 1,
      deleted: 0,
      remainingEligible: 0,
    })
    assert.equal(repository.playbackCompact({ version: 1, nowMs: yearMs + 2001, batchSize: 500 }).deleted, 1)
    const conserved = total(db)

    start(db, {
      id: 'statistics-disabled',
      at: 3000,
      playbackGroupUuid: '22222222-2222-4222-8222-222222222222',
      consent: { statsAllowed: false },
    })
    commit({
      playbackGroupUuid: '22222222-2222-4222-8222-222222222222',
      played: 0,
      active: 0,
      at: 4000,
      fact: terminalFact,
    })
    assert.equal(repository.playbackCompact({ version: 1, nowMs: yearMs + 4001, batchSize: 500 }).deleted, 1)
    assert.deepEqual(total(db), conserved)
  })

  it('rolls back the batch when any projection bucket is missing or has insufficient live values', async() => {
    const db = await createStore()
    start(db)
    commit({ fact: terminalFact })
    db.prepare('UPDATE listening_daily SET live_active_ms = 699').run()
    const before = {
      sessions: db.prepare('SELECT * FROM playback_sessions').all(),
      events: db.prepare('SELECT * FROM playback_events').all(),
      daily: db.prepare('SELECT * FROM listening_daily').all(),
      tracks: db.prepare('SELECT * FROM listening_tracks').all(),
      total: db.prepare('SELECT * FROM activity_totals').all(),
    }

    assert.throws(
      () => repository.playbackCompact({ version: 1, nowMs: yearMs + 3000, batchSize: 500 }),
      /playback_retention_projection_invariant/,
    )
    assert.deepEqual(db.prepare('SELECT * FROM playback_sessions').all(), before.sessions)
    assert.deepEqual(db.prepare('SELECT * FROM playback_events').all(), before.events)
    assert.deepEqual(db.prepare('SELECT * FROM listening_daily').all(), before.daily)
    assert.deepEqual(db.prepare('SELECT * FROM listening_tracks').all(), before.tracks)
    assert.deepEqual(db.prepare('SELECT * FROM activity_totals').all(), before.total)
  })

  it('keeps exactly the newest 100000 terminal rows and breaks equal end-time ties by session id', async() => {
    const db = await createStore()
    db.prepare(`
      INSERT INTO track_snapshots(source, source_track_id, name, singer, duration_ms, updated_at_ms)
      VALUES('test', 'bulk', 'Bulk', 'Singer', NULL, 1)
    `).run()
    const insert = db.prepare(`
      INSERT INTO playback_sessions(
        session_uuid, playback_group_uuid, segment_no, track_id, local_day,
        utc_offset_minutes, context_type, context_id, start_reason, end_reason,
        started_at_ms, ended_at_ms, start_position_ms, last_position_ms, duration_ms,
        played_ms, active_ms, cumulative_played_ms, cumulative_active_ms,
        checkpoint_seq, state, recent_allowed, stats_allowed, created_at_ms
      ) VALUES(?, ?, 0, 1, '1970-01-01', 0, NULL, NULL, 'select', 'natural_end',
        1, 2, 0, 0, NULL, 0, 0, 0, 0, 1, 'closed', 0, 0, 1)
    `)
    db.transaction(() => {
      for (let index = 1; index <= 100002; index++) {
        const suffix = String(index).padStart(12, '0')
        insert.run(`00000000-0000-4000-8000-${suffix}`, `group-${index}`)
      }
    })()

    const result = repository.playbackCompact({ version: 1, nowMs: 2, batchSize: 1 })

    assert.deepEqual(result, { version: 1, deleted: 1, remainingEligible: 1 })
    assert.deepEqual(repository.playbackCompact({ version: 1, nowMs: 2, batchSize: 1 }), {
      version: 1,
      deleted: 1,
      remainingEligible: 0,
    })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions').get().count, 100000)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions WHERE session_id = 1').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions WHERE session_id = 2').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions WHERE session_id = 3').get().count, 1)
  })

  it('preserves factual projection timestamps when rank compaction runs before the statistics cutoff', async() => {
    const db = await createStore()
    assert.equal(repository.playbackClearStatistics({ version: 1, occurredAtMs: 2000 }), null)
    start(db, { id: 'stats-only', at: 2500, consent: { recentAllowed: false } })
    commit({ at: 3000, fact: terminalFact })
    const trackId = db.prepare(`
      SELECT track_id AS trackId FROM track_snapshots WHERE source_track_id = 'stats-only'
    `).get().trackId
    const insert = db.prepare(`
      INSERT INTO playback_sessions(
        session_uuid, playback_group_uuid, segment_no, track_id, local_day,
        utc_offset_minutes, context_type, context_id, start_reason, end_reason,
        started_at_ms, ended_at_ms, start_position_ms, last_position_ms, duration_ms,
        played_ms, active_ms, cumulative_played_ms, cumulative_active_ms,
        checkpoint_seq, state, recent_allowed, stats_allowed, created_at_ms
      ) VALUES(?, ?, 0, ?, '1970-01-01', 0, NULL, NULL, 'select', 'natural_end',
        3500, 4000, 0, 0, NULL, 0, 0, 0, 0, 1, 'closed', 0, 0, 3500)
    `)
    db.transaction(() => {
      for (let index = 1; index <= 100000; index++) {
        const suffix = String(index).padStart(12, '0')
        insert.run(`10000000-0000-4000-8000-${suffix}`, `newer-${index}`, trackId)
      }
    })()

    assert.deepEqual(repository.playbackCompact({ version: 1, nowMs: 1000, batchSize: 1 }), {
      version: 1,
      deleted: 1,
      remainingEligible: 0,
    })
    assert.deepEqual(db.prepare(`
      SELECT updated_at_ms AS updatedAtMs FROM listening_daily
    `).get(), { updatedAtMs: 3000 })
    assert.deepEqual(db.prepare(`
      SELECT updated_at_ms AS updatedAtMs FROM listening_tracks
    `).get(), { updatedAtMs: 3000 })
    assert.deepEqual(db.prepare(`
      SELECT updated_at_ms AS updatedAtMs FROM activity_totals WHERE id = 1
    `).get(), { updatedAtMs: 3000 })
    const stats = repository.playbackGetListeningStats()
    assert.equal(stats.total.playedMs, 500)
    assert.equal(stats.total.activeMs, 700)
    assert.equal(stats.daily.length, 1)
    assert.equal(stats.daily[0].playedMs, 500)
    assert.equal(stats.daily[0].activeMs, 700)
    assert.equal(stats.tracks.length, 1)
    assert.equal(stats.tracks[0].playedMs, 500)
    assert.equal(stats.tracks[0].activeMs, 700)
    assert.deepEqual(repository.playbackGetRecent({ version: 1, limit: 520 }), [])
  })

  it('rejects hostile and out-of-range compaction commands without changing the database', async() => {
    const db = await createStore()
    const before = db.prepare('SELECT * FROM projection_state ORDER BY name').all()
    const hostile = Object.create(null)
    Object.assign(hostile, { version: 1, nowMs: 1, batchSize: 1 })
    for (const input of [
      hostile,
      { version: 1, nowMs: -1, batchSize: 1 },
      { version: 1, nowMs: 1.5, batchSize: 1 },
      { version: 1, nowMs: 1, batchSize: 0 },
      { version: 1, nowMs: 1, batchSize: 501 },
      { version: 1, nowMs: 1, batchSize: 1, extra: true },
    ]) assert.throws(() => repository.playbackCompact(input), /Invalid playback compact/)
    assert.deepEqual(db.prepare('SELECT * FROM projection_state ORDER BY name').all(), before)
  })
})

describe('idle vacuum eligibility', () => {
  it('requires both a free-page ratio above 25 percent and adequate temporary disk space', () => {
    assert.deepEqual(evaluateVacuumEligibility({
      pageCount: 100,
      freelistCount: 25,
      pageSize: 4096,
      databaseFileBytes: 409600,
      availableFreeBytes: 100000000,
    }), {
      eligible: false,
      reason: 'insufficient_free_pages',
      freePageRatio: 0.25,
      requiredFreeBytes: 67928064,
    })
    assert.deepEqual(evaluateVacuumEligibility({
      pageCount: 100,
      freelistCount: 26,
      pageSize: 4096,
      databaseFileBytes: 409600,
      availableFreeBytes: 67928063,
    }), {
      eligible: false,
      reason: 'insufficient_disk_space',
      freePageRatio: 0.26,
      requiredFreeBytes: 67928064,
    })
    assert.deepEqual(evaluateVacuumEligibility({
      pageCount: 100,
      freelistCount: 26,
      pageSize: 4096,
      databaseFileBytes: 409600,
      availableFreeBytes: 67928064,
    }), {
      eligible: true,
      reason: 'eligible',
      freePageRatio: 0.26,
      requiredFreeBytes: 67928064,
    })
  })

  it('reports from the open database path and startup leaves free pages untouched', async() => {
    let db = await createStore()
    const root = tempDirs[0]
    db.exec('CREATE TABLE vacuum_fixture(value BLOB)')
    const insert = db.prepare('INSERT INTO vacuum_fixture(value) VALUES(zeroblob(65536))')
    db.transaction(() => {
      for (let index = 0; index < 64; index++) insert.run()
    })()
    db.exec('DROP TABLE vacuum_fixture')
    const before = {
      pageCount: db.pragma('page_count', { simple: true }),
      freelistCount: db.pragma('freelist_count', { simple: true }),
    }
    assert.ok(before.freelistCount / before.pageCount > 0.25)

    dbService.close()
    const startup = await dbService.init({
      dataPath: root,
      backupDir: path.join(root, 'backups'),
      previousShutdownWasClean: true,
    })
    assert.equal(startup.status, 'ready')
    db = dbService.getDB()
    assert.equal(db.pragma('page_count', { simple: true }), before.pageCount)
    assert.equal(db.pragma('freelist_count', { simple: true }), before.freelistCount)

    const result = repository.playbackGetVacuumEligibility({ version: 1 })

    assert.equal(result.version, 1)
    assert.equal(result.pageCount, before.pageCount)
    assert.equal(result.freelistCount, before.freelistCount)
    assert.equal(result.eligible, result.availableFreeBytes >= result.requiredFreeBytes)
    assert.equal(result.reason, result.eligible ? 'eligible' : 'insufficient_disk_space')
    assert.equal(Object.hasOwn(result, 'databasePath'), false)
    assert.throws(
      () => repository.playbackGetVacuumEligibility({ version: 1, path: 'D:\\hostile' }),
      /Invalid playback vacuum eligibility/,
    )
  })
})
