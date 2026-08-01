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
const playback = require('../../src/main/worker/dbService/modules/playback/index.ts')
const appState = require('../../src/main/worker/dbService/modules/app_state/index.ts')

const tempDirs = []
const groupA = '11111111-1111-4111-8111-111111111111'
const groupB = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  try { dbService.close() } catch {}
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const createStore = async() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-playback-clear-'))
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

const start = ({
  group = groupA,
  id = 'one',
  at = 1000,
  recentAllowed = true,
  statsAllowed = true,
} = {}) => playback.playbackStart({
  version: 1,
  playbackGroupUuid: group,
  track: track(id),
  context: { type: 'playlist', id: 'list' },
  resume: { listId: 'list', indexHint: 0 },
  startReason: 'select',
  startPositionMs: 0,
  occurredAtMs: at,
  consent: { recentAllowed, statsAllowed, privateMode: false },
})

const checkpoint = ({
  group = groupA,
  seq = 2,
  played = 500,
  active = 700,
  at = 1500,
  position = played,
} = {}) => ({
  playbackGroupUuid: group,
  checkpointSeq: seq,
  cumulativePlayedMs: played,
  cumulativeActiveMs: active,
  positionMs: position,
  durationMs: 240000,
  occurredAtMs: at,
})

const commit = (value = {}, fact) => playback.playbackCommit({
  version: 1,
  checkpoint: checkpoint(value),
  ...(fact == null ? {} : { fact }),
})

const session = (db, segmentNo = 0, group = groupA) => db.prepare(`
  SELECT session_id AS sessionId, playback_group_uuid AS playbackGroupUuid,
    segment_no AS segmentNo, start_reason AS startReason, end_reason AS endReason,
    started_at_ms AS startedAtMs, ended_at_ms AS endedAtMs,
    last_position_ms AS lastPositionMs, played_ms AS playedMs, active_ms AS activeMs,
    cumulative_played_ms AS cumulativePlayedMs,
    cumulative_active_ms AS cumulativeActiveMs, checkpoint_seq AS checkpointSeq,
    state, recent_allowed AS recentAllowed, stats_allowed AS statsAllowed
  FROM playback_sessions WHERE playback_group_uuid = ? AND segment_no = ?
`).get(group, segmentNo)

const total = db => db.prepare(`
  SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
    baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs,
    updated_at_ms AS updatedAtMs FROM activity_totals WHERE id = 1
`).get()

const projectionState = (db, name) => db.prepare(`
  SELECT name, version, last_session_id AS lastSessionId,
    visible_after_ms AS visibleAfterMs, updated_at_ms AS updatedAtMs
  FROM projection_state WHERE name = ?
`).get(name)

const activitySnapshot = db => Object.fromEntries([
  'track_snapshots',
  'playback_sessions',
  'playback_events',
  'recent_tracks',
  'listening_daily',
  'listening_tracks',
  'activity_totals',
  'projection_state',
  'playback_resume_state',
].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

const pause = { version: 1, type: 'pause', reason: 'user' }

describe('recent clear', () => {
  it('clears only recent state and rejects delayed pre-cutoff starts while admitting the cutoff', async() => {
    const db = await createStore()
    start()
    commit()
    const facts = activitySnapshot(db)

    assert.equal(playback.playbackClearRecent({ version: 1, occurredAtMs: 2000 }), undefined)

    assert.deepEqual(playback.playbackGetRecent({ version: 1, limit: 520 }), [])
    assert.deepEqual(projectionState(db, 'recent'), {
      name: 'recent', version: 1, lastSessionId: null, visibleAfterMs: 2000, updatedAtMs: 2000,
    })
    assert.deepEqual(db.prepare('SELECT * FROM playback_sessions ORDER BY rowid').all(), facts.playback_sessions)
    assert.deepEqual(db.prepare('SELECT * FROM playback_events ORDER BY rowid').all(), facts.playback_events)
    assert.deepEqual(db.prepare('SELECT * FROM track_snapshots ORDER BY rowid').all(), facts.track_snapshots)
    assert.deepEqual(db.prepare('SELECT * FROM listening_daily ORDER BY rowid').all(), facts.listening_daily)
    assert.deepEqual(db.prepare('SELECT * FROM listening_tracks ORDER BY rowid').all(), facts.listening_tracks)

    start({ group: groupB, id: 'old', at: 1999 })
    assert.deepEqual(playback.playbackGetRecent({ version: 1, limit: 520 }), [])
    commit({ group: groupB, seq: 2, played: 100, active: 120, at: 2100 })
    const groupC = '33333333-3333-4333-8333-333333333333'
    start({ group: groupC, id: 'edge', at: 2000 })
    assert.deepEqual(playback.playbackGetRecent({ version: 1, limit: 520 }).map(row => row.sourceTrackId), ['edge'])
  })

  it('defensively hides retained rows older than the recent cutoff', async() => {
    const db = await createStore()
    start()
    playback.playbackClearRecent({ version: 1, occurredAtMs: 2000 })
    const trackId = db.prepare('SELECT track_id AS trackId FROM track_snapshots').get().trackId
    db.prepare(`
      INSERT INTO recent_tracks(track_id, recency_seq, last_session_id, last_played_at_ms, updated_at_ms)
      VALUES(?, 1, NULL, 1999, 2001)
    `).run(trackId)
    assert.deepEqual(playback.playbackGetRecent({ version: 1, limit: 520 }), [])
  })

  it('rejects a stale cutoff and replays the same cutoff without deleting newer recent data', async() => {
    const db = await createStore()
    start()
    playback.playbackClearRecent({ version: 1, occurredAtMs: 2000 })
    start({ group: groupB, id: 'newer', at: 2500 })
    const before = activitySnapshot(db)

    assert.throws(
      () => playback.playbackClearRecent({ version: 1, occurredAtMs: 1999 }),
      /playback_recent_clear_stale/,
    )
    assert.deepEqual(activitySnapshot(db), before)
    assert.equal(playback.playbackClearRecent({ version: 1, occurredAtMs: 2000 }), undefined)
    assert.deepEqual(activitySnapshot(db), before)
    assert.deepEqual(playback.playbackGetRecent({ version: 1, limit: 520 }).map(row => row.sourceTrackId), ['newer'])
  })
})

describe('statistics clear handshake', () => {
  it('checkpoints and rotates an active segment, zeros statistics, and accepts the next checkpoint', async() => {
    const db = await createStore()
    start()
    commit()
    const clearCheckpoint = checkpoint({ seq: 3, played: 800, active: 1000, at: 2000, position: 800 })

    const ack = playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 2000,
      activeCheckpoint: clearCheckpoint,
    })

    assert.deepEqual(session(db, 0), {
      sessionId: session(db, 0).sessionId,
      playbackGroupUuid: groupA,
      segmentNo: 0,
      startReason: 'select',
      endReason: 'statistics_clear',
      startedAtMs: 1000,
      endedAtMs: 2000,
      lastPositionMs: 800,
      playedMs: 800,
      activeMs: 1000,
      cumulativePlayedMs: 800,
      cumulativeActiveMs: 1000,
      checkpointSeq: 3,
      state: 'closed',
      recentAllowed: 1,
      statsAllowed: 1,
    })
    assert.deepEqual(session(db, 1), {
      sessionId: session(db, 1).sessionId,
      playbackGroupUuid: groupA,
      segmentNo: 1,
      startReason: 'statistics_clear',
      endReason: null,
      startedAtMs: 2000,
      endedAtMs: null,
      lastPositionMs: 800,
      playedMs: 0,
      activeMs: 0,
      cumulativePlayedMs: 800,
      cumulativeActiveMs: 1000,
      checkpointSeq: 3,
      state: 'playing',
      recentAllowed: 1,
      statsAllowed: 1,
    })
    assert.deepEqual(ack, {
      playbackGroupUuid: groupA,
      sessionUuid: ack.sessionUuid,
      segmentNo: 1,
      checkpointSeq: 3,
      cumulativePlayedMs: 800,
      cumulativeActiveMs: 1000,
    })
    assert.deepEqual(playback.playbackGetListeningStats(), {
      version: 1,
      total: { baselinePlayedMs: 0, livePlayedMs: 0, baselineActiveMs: 0, liveActiveMs: 0, playedMs: 0, activeMs: 0 },
      daily: [],
      tracks: [],
      updatedAtMs: 2000,
    })
    assert.deepEqual(projectionState(db, 'statistics'), {
      name: 'statistics', version: 1, lastSessionId: null, visibleAfterMs: 2000, updatedAtMs: 2000,
    })
    assert.equal(playback.playbackGetRecent({ version: 1, limit: 520 }).length, 1)

    const next = commit({ seq: 4, played: 1000, active: 1300, at: 2200, position: 1000 })
    assert.equal(next.sessionUuid, ack.sessionUuid)
    assert.deepEqual(total(db), {
      baselinePlayedMs: 0,
      livePlayedMs: 200,
      baselineActiveMs: 0,
      liveActiveMs: 300,
      updatedAtMs: 2200,
    })
  })

  it('preserves paused state and rejects an uncoordinated clear while a segment is open', async() => {
    const db = await createStore()
    start()
    commit({ seq: 2, played: 100, active: 150, at: 1200 }, pause)
    const before = activitySnapshot(db)

    assert.throws(
      () => playback.playbackClearStatistics({ version: 1, occurredAtMs: 1500 }),
      /playback_statistics_clear_checkpoint_required/,
    )
    assert.deepEqual(activitySnapshot(db), before)
    assert.throws(() => playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 1500,
      activeCheckpoint: checkpoint({ seq: 1, played: 0, active: 0, at: 1000, position: 0 }),
    }), /playback_statistics_clear_checkpoint_stale/)
    assert.deepEqual(activitySnapshot(db), before)

    const ack = playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 1500,
      activeCheckpoint: checkpoint({ seq: 3, played: 200, active: 250, at: 1500 }),
    })
    assert.equal(ack.segmentNo, 1)
    assert.equal(session(db, 1).state, 'paused')
  })

  it('returns null without an open segment and prevents delayed pre-cutoff statistics writes', async() => {
    const db = await createStore()
    assert.equal(playback.playbackClearStatistics({ version: 1, occurredAtMs: 2000 }), null)
    start({ at: 1999 })
    commit({ seq: 2, played: 100, active: 120, at: 2100 })
    assert.deepEqual(total(db), {
      baselinePlayedMs: 0,
      livePlayedMs: 0,
      baselineActiveMs: 0,
      liveActiveMs: 0,
      updatedAtMs: 2000,
    })

    db.prepare(`
      INSERT INTO listening_daily(
        local_day, baseline_played_ms, live_played_ms,
        baseline_active_ms, live_active_ms, updated_at_ms
      ) VALUES('1969-12-31', 10, 20, 30, 40, 1999)
    `).run()
    assert.deepEqual(playback.playbackGetListeningStats().daily, [])
  })

  it('rolls back the checkpoint, rotation, projection reset, and cutoff on an injected failure', async() => {
    const db = await createStore()
    start()
    commit()
    const before = activitySnapshot(db)

    for (const failAt of [
      'after-checkpoint', 'after-close', 'after-rotate', 'after-reset', 'after-cutoff',
    ]) {
      assert.throws(() => playback.playbackClearStatistics({
        version: 1,
        occurredAtMs: 2000,
        activeCheckpoint: checkpoint({ seq: 3, played: 800, active: 1000, at: 2000 }),
      }, { failAt }), /injected failure/)
      assert.deepEqual(activitySnapshot(db), before, failAt)
    }
  })

  it('rejects stale clears and replays the same cutoff without erasing post-cutoff statistics', async() => {
    const db = await createStore()
    start()
    const firstAck = playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 2000,
      activeCheckpoint: checkpoint({ seq: 2, played: 500, active: 700, at: 2000 }),
    })
    const currentCheckpoint = checkpoint({ seq: 3, played: 800, active: 1100, at: 2500 })
    const currentAck = playback.playbackCommit({ version: 1, checkpoint: currentCheckpoint })
    const before = activitySnapshot(db)

    assert.throws(() => playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 1999,
      activeCheckpoint: currentCheckpoint,
    }), /playback_statistics_clear_stale/)
    assert.deepEqual(activitySnapshot(db), before)

    const replay = playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 2000,
      activeCheckpoint: currentCheckpoint,
    })
    assert.equal(firstAck.sessionUuid, currentAck.sessionUuid)
    assert.deepEqual(replay, currentAck)
    assert.deepEqual(activitySnapshot(db), before)
    assert.deepEqual(total(db), {
      baselinePlayedMs: 0,
      livePlayedMs: 300,
      baselineActiveMs: 0,
      liveActiveMs: 400,
      updatedAtMs: 2500,
    })
  })

  it('rejects nonzero counters for statistics-disabled clear and continues with zero counters', async() => {
    const db = await createStore()
    start({ recentAllowed: true, statsAllowed: false })
    const before = activitySnapshot(db)

    assert.throws(() => playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 2000,
      activeCheckpoint: checkpoint({ seq: 2, played: 1, active: 1, at: 2000, position: 1 }),
    }), /playback_statistics_disabled_cumulative_nonzero/)
    assert.deepEqual(activitySnapshot(db), before)

    const ack = playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 2000,
      activeCheckpoint: checkpoint({ seq: 2, played: 0, active: 0, at: 2000, position: 0 }),
    })
    assert.deepEqual(ack, {
      playbackGroupUuid: groupA,
      sessionUuid: ack.sessionUuid,
      segmentNo: 1,
      checkpointSeq: 2,
      cumulativePlayedMs: 0,
      cumulativeActiveMs: 0,
    })
    assert.deepEqual(playback.playbackCommit({
      version: 1,
      checkpoint: checkpoint({ seq: 3, played: 0, active: 0, at: 2500, position: 0 }),
    }), {
      ...ack,
      checkpointSeq: 3,
    })
    assert.equal(session(db, 1).cumulativePlayedMs, 0)
    assert.equal(session(db, 1).cumulativeActiveMs, 0)
  })

  it('retains snapshots referenced by stats-only sessions across recent and statistics clears', async() => {
    const db = await createStore()
    start({ recentAllowed: false, statsAllowed: true })
    commit()
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_tracks').get().count, 0)

    playback.playbackClearRecent({ version: 1, occurredAtMs: 1600 })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM track_snapshots').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_tracks').get().count, 1)

    playback.playbackClearStatistics({
      version: 1,
      occurredAtMs: 2000,
      activeCheckpoint: checkpoint({ seq: 3, played: 800, active: 1000, at: 2000 }),
    })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM track_snapshots').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions').get().count, 2)
  })
})

describe('delete-all and device reset', () => {
  it('deletes all playback activity, resets seed rows and cutoffs, and preserves non-playback state', async() => {
    const db = await createStore()
    appState.setLocalState({ version: 1, key: 'list_prev_select_id', value: 'keep-me', updatedAtMs: 10 })
    start()
    commit()
    playback.playbackClearRecent({ version: 1, occurredAtMs: 1600 })

    assert.equal(playback.playbackDeleteAllActivity({ version: 1, occurredAtMs: 2000 }), undefined)

    for (const table of [
      'track_snapshots', 'playback_sessions', 'playback_events', 'recent_tracks',
      'listening_daily', 'listening_tracks', 'playback_resume_state',
    ]) assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table)
    assert.deepEqual(total(db), {
      baselinePlayedMs: 0,
      livePlayedMs: 0,
      baselineActiveMs: 0,
      liveActiveMs: 0,
      updatedAtMs: 2000,
    })
    assert.deepEqual(db.prepare(`
      SELECT name, version, last_session_id AS lastSessionId,
        visible_after_ms AS visibleAfterMs, updated_at_ms AS updatedAtMs
      FROM projection_state ORDER BY name
    `).all(), [
      { name: 'recent', version: 1, lastSessionId: null, visibleAfterMs: null, updatedAtMs: 2000 },
      { name: 'statistics', version: 1, lastSessionId: null, visibleAfterMs: null, updatedAtMs: 2000 },
    ])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count, 1)
    assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }])
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })

  it('rolls back delete-all when a late seed reset fails', async() => {
    const db = await createStore()
    start()
    commit()
    const before = activitySnapshot(db)
    db.exec(`
      CREATE TRIGGER fail_activity_total_reset
      BEFORE UPDATE ON activity_totals
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END
    `)
    assert.throws(
      () => playback.playbackDeleteAllActivity({ version: 1, occurredAtMs: 2000 }),
      /injected failure/,
    )
    assert.deepEqual(activitySnapshot(db), before)
  })

  it('atomically clears only local state and playback resume for a device reset', async() => {
    const db = await createStore()
    appState.setLocalState({ version: 1, key: 'list_prev_select_id', value: 'remove-me', updatedAtMs: 10 })
    start()
    commit()
    const before = activitySnapshot(db)
    const markerCount = db.prepare('SELECT COUNT(*) AS count FROM migration_markers').get().count

    assert.equal(playback.playbackResetDeviceState({ version: 1 }), undefined)

    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_resume_state').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_markers').get().count, markerCount)
    for (const table of [
      'track_snapshots', 'playback_sessions', 'playback_events', 'recent_tracks',
      'listening_daily', 'listening_tracks', 'activity_totals', 'projection_state',
    ]) assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(), before[table], table)
  })

  it('rolls back local state when resume deletion fails during device reset', async() => {
    const db = await createStore()
    appState.setLocalState({ version: 1, key: 'list_prev_select_id', value: 'keep-me', updatedAtMs: 10 })
    start()
    db.exec(`
      CREATE TRIGGER fail_resume_reset
      BEFORE DELETE ON playback_resume_state
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END
    `)
    assert.throws(() => playback.playbackResetDeviceState({ version: 1 }), /injected failure/)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_resume_state').get().count, 1)
  })
})

describe('clear command validation', () => {
  it('rejects hostile, excess-key, unsafe timestamp, and malformed checkpoint envelopes', async() => {
    const db = await createStore()
    const before = activitySnapshot(db)
    const hostile = Object.create(null)
    Object.assign(hostile, { version: 1, occurredAtMs: 1 })
    for (const callback of [
      () => playback.playbackClearRecent(hostile),
      () => playback.playbackClearRecent({ version: 1, occurredAtMs: -1 }),
      () => playback.playbackClearStatistics({ version: 1, occurredAtMs: 1, extra: true }),
      () => playback.playbackClearStatistics({ version: 1, occurredAtMs: 1, activeCheckpoint: { bad: true } }),
      () => playback.playbackDeleteAllActivity({ version: 1, occurredAtMs: Number.MAX_SAFE_INTEGER + 1 }),
      () => playback.playbackResetDeviceState({ version: 1, extra: true }),
    ]) assert.throws(callback, /Invalid playback/)
    assert.deepEqual(activitySnapshot(db), before)
  })

  it('keeps private and resume-only playback fact-free through retention and clear operations', async() => {
    const db = await createStore()
    const privateResult = playback.playbackStart({
      version: 1,
      playbackGroupUuid: groupA,
      track: track('private'),
      context: { type: null, id: null },
      resume: { listId: null, indexHint: null },
      startReason: 'select',
      startPositionMs: 0,
      occurredAtMs: 1100,
      consent: { recentAllowed: true, statsAllowed: true, privateMode: true },
    })
    const resumeOnly = start({ group: groupB, id: 'resume-only', at: 1200, recentAllowed: false, statsAllowed: false })
    assert.equal(privateResult.mode, 'private')
    assert.equal(resumeOnly.mode, 'resume-only')

    playback.playbackClearRecent({ version: 1, occurredAtMs: 1300 })
    assert.equal(playback.playbackClearStatistics({ version: 1, occurredAtMs: 1300 }), null)
    assert.deepEqual(playback.playbackCompact({ version: 1, nowMs: 1300, batchSize: 500 }), {
      version: 1,
      deleted: 0,
      remainingEligible: 0,
    })
    for (const table of ['track_snapshots', 'playback_sessions', 'playback_events', 'recent_tracks', 'listening_daily', 'listening_tracks']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, table)
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_resume_state').get().count, 1)
  })
})
