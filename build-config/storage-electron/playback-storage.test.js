const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { afterEach, describe, it } = require('node:test')
const Database = require('better-sqlite3')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

// Electron ABI tests transpile source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { target: typescript.ScriptTarget.ESNext, module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

process.env.TZ = 'America/New_York'

const dbService = require('../../src/main/worker/dbService/db.ts')
const repository = require('../../src/main/worker/dbService/modules/playback/index.ts')
const { migration8 } = require('../../src/main/worker/dbService/migrations/0008_listening_play_count.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const tempDirs = []
const playbackPipelineClocks = []
const groupA = '11111111-1111-4111-8111-111111111111'
const groupB = '22222222-2222-4222-8222-222222222222'
const startAt = Date.parse('2026-03-08T05:00:00.000Z')

afterEach(() => {
  for (const clock of playbackPipelineClocks.splice(0)) clock.alive = false
  try { dbService.close() } catch {}
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

const createStore = async() => {
  const fixture = createTestStorageRoot('lx-playback-storage')
  tempDirs.push(fixture)
  const root = fixture.path
  const result = await dbService.init({
    dataPath: root,
    cacheRoot: path.join(root, 'cache'),
    backupsRoot: path.join(root, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(result.status, 'ready')
  return dbService.getAppDB()
}

const enablePlayCount = db => migration8.up(db, { appliedAtMs: startAt })

const track = (id = 'one') => ({
  source: 'test',
  sourceTrackId: id,
  name: `Track ${id}`,
  singer: `Singer ${id}`,
  durationMs: 240000,
  playablePayload: null,
})

const startCommand = (consent = {}, overrides = {}) => ({
  version: 1,
  playbackGroupUuid: groupA,
  track: track(),
  context: { type: 'playlist', id: 'list-one' },
  resume: { listId: 'list-one', indexHint: 3 },
  startReason: 'select',
  startPositionMs: 500,
  occurredAtMs: startAt,
  consent: { recentAllowed: true, statsAllowed: true, privateMode: false, ...consent },
  ...overrides,
})

const checkpoint = (checkpointSeq, cumulativePlayedMs, overrides = {}) => ({
  playbackGroupUuid: groupA,
  checkpointSeq,
  cumulativePlayedMs,
  cumulativeActiveMs: cumulativePlayedMs + 100,
  positionMs: 500 + cumulativePlayedMs,
  durationMs: 240000,
  occurredAtMs: startAt + cumulativePlayedMs,
  ...overrides,
})

const commitAt = (checkpointSeq, cumulativePlayedMs, fact, overrides = {}) => ({
  version: 1,
  checkpoint: checkpoint(checkpointSeq, cumulativePlayedMs, overrides),
  ...(fact == null ? {} : { fact }),
})

const pauseFact = { version: 1, type: 'pause', reason: 'user' }
const playStartFact = { version: 1, type: 'play_start', reason: 'select' }

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

const durableState = db => Object.fromEntries(activityTables.map(table => [
  table,
  db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
]))

const captureError = callback => {
  let result
  try {
    callback()
  } catch (error) {
    result = error
  }
  assert.ok(result instanceof Error, 'expected callback to throw')
  return result
}

const counts = db => Object.fromEntries([
  'track_snapshots',
  'playback_sessions',
  'playback_events',
  'recent_tracks',
  'listening_daily',
  'listening_tracks',
  'playback_resume_state',
].map(table => [table, db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]))

const session = (db, segmentNo = 0, group = groupA) => db.prepare(`
  SELECT session_id AS sessionId, session_uuid AS sessionUuid, playback_group_uuid AS playbackGroupUuid,
    segment_no AS segmentNo, local_day AS localDay, utc_offset_minutes AS utcOffsetMinutes,
    start_reason AS startReason, end_reason AS endReason, started_at_ms AS startedAtMs,
    ended_at_ms AS endedAtMs, start_position_ms AS startPositionMs,
    last_position_ms AS lastPositionMs, duration_ms AS durationMs, played_ms AS playedMs,
    active_ms AS activeMs, cumulative_played_ms AS cumulativePlayedMs,
    cumulative_active_ms AS cumulativeActiveMs, checkpoint_seq AS checkpointSeq,
    state, recent_allowed AS recentAllowed, stats_allowed AS statsAllowed
  FROM playback_sessions WHERE playback_group_uuid = ? AND segment_no = ?
`).get(group, segmentNo)

const total = db => db.prepare(`
  SELECT baseline_played_ms AS baselinePlayedMs, live_played_ms AS livePlayedMs,
    baseline_active_ms AS baselineActiveMs, live_active_ms AS liveActiveMs,
    updated_at_ms AS updatedAtMs FROM activity_totals WHERE id = 1
`).get()

const createPlaybackPipeline = ({
  occurredAtMs,
  monotonicMs = 0,
  positionMs = 0,
  timeZone = 'America/New_York',
  phase = 'playing',
}) => {
  const recorderPath = path.resolve(__dirname, '../../src/renderer/core/playbackRecorder/index.ts')
  const hookPath = path.resolve(__dirname, '../../src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts')
  const current = { occurredAtMs, monotonicMs, positionMs, alive: true }
  playbackPipelineClocks.push(current)
  const timeouts = []
  const commands = []
  const timers = {
    setInterval: () => ({ type: 'interval' }),
    clearInterval: () => {},
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false, fired: false }
      timeouts.push(timer)
      return timer
    },
    clearTimeout(timer) { timer.cleared = true },
  }
  const recorder = loadTsModule(recorderPath, {
    '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
  }).createPlaybackRecorder({
    isAlive: () => current.alive,
    transport: async command => {
      commands.push(command)
      switch (command.kind) {
        case 'start': return repository.playbackStart(command.request)
        case 'commit': return repository.playbackCommit(command.request)
        default: throw new Error(`unexpected playback command: ${command.kind}`)
      }
    },
  })
  const controller = loadTsModule(hookPath, {
    '@renderer/core/playbackRecorder': { createPlaybackRecorder: () => recorder },
    '@renderer/store/recentPlay/action': { initRecentPlayList: async() => {} },
    '@renderer/store/listeningTime/action': { initListeningTimeStats: async() => {} },
    '@renderer/utils/ipc': { registerShutdownFlusher: () => () => {} },
    '@renderer/plugins/player': {},
    '@common/utils/vueTools': { onBeforeUnmount: () => {} },
  }).createPlaybackRecorderController({
    recorder,
    now: () => current.occurredAtMs,
    monotonicNow: () => current.monotonicMs,
    getPositionMs: () => current.positionMs,
    getDurationMs: () => null,
    createUuid: () => groupA,
    timeZone,
    timers,
  })

  controller.startTimers()
  controller.select({
    track: { ...track(), durationMs: null },
    context: { type: 'playlist', id: 'list-one' },
    resume: { listId: 'list-one', indexHint: 3 },
    startReason: 'select',
    startPositionMs: positionMs,
  })
  controller.nativePlaying(1)
  if (phase == 'paused') controller.pause('user')
  if (phase == 'buffering') controller.bufferingStart()

  return {
    commands,
    controller,
    current,
    recorder,
    stop() { current.alive = false },
    fireNextBoundary() {
      const timer = timeouts.find(candidate => !candidate.cleared && !candidate.fired)
      assert.ok(timer, 'expected a scheduled civil-day boundary')
      timer.fired = true
      timer.callback()
    },
  }
}

const integrity = db => ({
  quick: db.pragma('quick_check'),
  foreignKeys: db.pragma('foreign_key_check'),
})

describe('atomic playback repository', () => {
  it('starts activity atomically and returns exact recent, listening, and resume DTOs', async() => {
    const db = await createStore()

    const result = repository.playbackStart(startCommand())

    assert.equal(result.mode, 'activity')
    assert.deepEqual(result.ack, {
      playbackGroupUuid: groupA,
      sessionUuid: result.ack.sessionUuid,
      segmentNo: 0,
      checkpointSeq: 1,
      cumulativePlayedMs: 0,
      cumulativeActiveMs: 0,
    })
    assert.match(result.ack.sessionUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.deepEqual(counts(db), {
      track_snapshots: 1,
      playback_sessions: 1,
      playback_events: 1,
      recent_tracks: 1,
      listening_daily: 0,
      listening_tracks: 0,
      playback_resume_state: 1,
    })
    assert.deepEqual(session(db), {
      sessionId: session(db).sessionId,
      sessionUuid: result.ack.sessionUuid,
      playbackGroupUuid: groupA,
      segmentNo: 0,
      localDay: '2026-03-08',
      utcOffsetMinutes: -300,
      startReason: 'select',
      endReason: null,
      startedAtMs: startAt,
      endedAtMs: null,
      startPositionMs: 500,
      lastPositionMs: 500,
      durationMs: 240000,
      playedMs: 0,
      activeMs: 0,
      cumulativePlayedMs: 0,
      cumulativeActiveMs: 0,
      checkpointSeq: 1,
      state: 'playing',
      recentAllowed: 1,
      statsAllowed: 1,
    })
    assert.deepEqual(repository.playbackGetRecent({ version: 1, limit: 520 }), [{
      version: 1,
      ...track(),
      lastPlayedAtMs: startAt,
      legacyRank: null,
    }])
    assert.deepEqual(repository.playbackGetListeningStats(), {
      version: 1,
      total: {
        baselinePlayedMs: 0,
        livePlayedMs: 0,
        baselineActiveMs: 0,
        liveActiveMs: 0,
        playedMs: 0,
        activeMs: 0,
      },
      daily: [],
      tracks: [],
      updatedAtMs: 0,
    })
    assert.deepEqual(repository.playbackGetResume(), {
      version: 1,
      source: 'test',
      sourceTrackId: 'one',
      listId: 'list-one',
      indexHint: 3,
      positionMs: 500,
      durationMs: 240000,
      updatedAtMs: startAt,
    })
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('returns the durable start acknowledgement without relatching consent or replacing identity', async() => {
    const db = await createStore()
    const first = repository.playbackStart(startCommand({ recentAllowed: false, statsAllowed: true }))

    const replay = repository.playbackStart(startCommand(
      { recentAllowed: true, statsAllowed: false },
      { track: track('replacement'), occurredAtMs: startAt + 9999 },
    ))

    assert.deepEqual(replay, first)
    assert.equal(session(db).recentAllowed, 0)
    assert.equal(session(db).statsAllowed, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM track_snapshots').get().count, 1)
    assert.equal(repository.playbackGetResume().sourceTrackId, 'one')
  })

  it('counts only the first statistics-enabled start for a playback group', async() => {
    const db = await createStore()
    enablePlayCount(db)
    const request = startCommand({ recentAllowed: false, statsAllowed: true })

    const first = repository.playbackStart(request)
    assert.equal(repository.playbackGetListeningStats().tracks[0].playCount, 1)
    assert.deepEqual(repository.playbackStart(request), first)
    repository.playbackCommit(commitAt(2, 1000, pauseFact))
    repository.playbackCommit(commitAt(3, 1000, {
      version: 1,
      type: 'resume',
      reason: 'user',
    }))
    assert.equal(repository.playbackGetListeningStats().tracks[0].playCount, 1)

    repository.playbackStart(startCommand(
      { recentAllowed: true, statsAllowed: false },
      { playbackGroupUuid: groupB, track: track('disabled'), occurredAtMs: startAt + 2000 },
    ))
    assert.deepEqual(
      repository.playbackGetListeningStats().tracks.map(row => [row.sourceTrackId, row.playCount]),
      [['one', 1]],
    )
  })

  it('rolls back a new playback group when its track play count is exhausted', async() => {
    const db = await createStore()
    enablePlayCount(db)
    repository.playbackStart(startCommand({ recentAllowed: false, statsAllowed: true }))
    db.prepare('UPDATE listening_tracks SET play_count = ?').run(Number.MAX_SAFE_INTEGER)
    const before = durableState(db)

    assert.throws(() => repository.playbackStart(startCommand(
      { recentAllowed: true, statsAllowed: true },
      { playbackGroupUuid: groupB, occurredAtMs: startAt + 1000 },
    )), /playback_play_count_overflow/)

    assert.deepEqual(durableState(db), before)
    assert.equal(repository.playbackGetListeningStats().tracks[0].playCount, Number.MAX_SAFE_INTEGER)
  })

  it('acks duplicate and out-of-order checkpoints without a second delta or event', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())

    const first = repository.playbackCommit(commitAt(2, 1000, pauseFact))
    const duplicate = repository.playbackCommit(commitAt(2, 1000, pauseFact))
    const stale = repository.playbackCommit(commitAt(1, 500))

    assert.deepEqual(duplicate, first)
    assert.deepEqual(stale, first)
    assert.equal(total(db).livePlayedMs, 1000)
    assert.equal(total(db).liveActiveMs, 1100)
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM playback_events WHERE event_type = 'pause'").get().count, 1)
    assert.equal(repository.playbackGetResume().positionMs, 1500)
    assert.deepEqual(repository.playbackGetListeningStats(), {
      version: 1,
      total: {
        baselinePlayedMs: 0,
        livePlayedMs: 1000,
        baselineActiveMs: 0,
        liveActiveMs: 1100,
        playedMs: 1000,
        activeMs: 1100,
      },
      daily: [{
        baselinePlayedMs: 0,
        livePlayedMs: 1000,
        baselineActiveMs: 0,
        liveActiveMs: 1100,
        playedMs: 1000,
        activeMs: 1100,
        localDay: '2026-03-08',
      }],
      tracks: [{
        baselinePlayedMs: 0,
        livePlayedMs: 1000,
        baselineActiveMs: 0,
        liveActiveMs: 1100,
        playedMs: 1000,
        activeMs: 1100,
        source: 'test',
        sourceTrackId: 'one',
        name: 'Track one',
        singer: 'Singer one',
        durationMs: 240000,
        playCount: 0,
      }],
      updatedAtMs: startAt + 1000,
    })
  })

  it('rolls back session, event, resume, and every projection after an injected projection failure', async() => {
    const db = await createStore()
    const started = repository.playbackStart(startCommand())
    const beforeResume = repository.playbackGetResume()

    assert.throws(
      () => repository.playbackCommit(commitAt(2, 1000, pauseFact), { failAt: 'after-daily' }),
      /injected failure/,
    )

    assert.equal(session(db).checkpointSeq, 1)
    assert.equal(session(db).playedMs, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_daily').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_tracks').get().count, 0)
    assert.deepEqual(total(db), {
      baselinePlayedMs: 0,
      livePlayedMs: 0,
      baselineActiveMs: 0,
      liveActiveMs: 0,
      updatedAtMs: 0,
    })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, 1)
    assert.deepEqual(repository.playbackGetResume(), beforeResume)
    assert.deepEqual(repository.playbackCommit(commitAt(2, 1000, pauseFact)), {
      ...started.ack,
      checkpointSeq: 2,
      cumulativePlayedMs: 1000,
      cumulativeActiveMs: 1100,
    })
  })

  it('rejects commit options after one hostile envelope inspection', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())
    const before = durableState(db)
    let ownKeysCalls = 0
    const options = new Proxy({ failAt: 'after-daily' }, {
      ownKeys(target) {
        ownKeysCalls++
        if (ownKeysCalls == 1) throw new Error('first options trap escaped')
        return Reflect.ownKeys(target)
      },
    })

    const error = captureError(
      () => repository.playbackCommit(commitAt(2, 1000, pauseFact), options),
    )

    assert.equal(error.message, 'Invalid playback commit options')
    assert.equal(ownKeysCalls, 1)
    assert.deepEqual(durableState(db), before)
  })

  it('rolls back before a baseline plus live projection would exceed the DTO safe-integer range', async() => {
    const db = await createStore()
    db.prepare(`
      UPDATE activity_totals
      SET baseline_played_ms = ?, updated_at_ms = 1
      WHERE id = 1
    `).run(Number.MAX_SAFE_INTEGER)
    const started = repository.playbackStart(startCommand())
    const beforeResume = repository.playbackGetResume()

    assert.throws(() => repository.playbackCommit(commitAt(2, 1, undefined, {
      cumulativeActiveMs: 1,
    })), /playback_projection_overflow/)

    const storedSession = session(db)
    assert.deepEqual({
      playedMs: storedSession.playedMs,
      activeMs: storedSession.activeMs,
      cumulativePlayedMs: storedSession.cumulativePlayedMs,
      cumulativeActiveMs: storedSession.cumulativeActiveMs,
      checkpointSeq: storedSession.checkpointSeq,
    }, {
      playedMs: 0,
      activeMs: 0,
      cumulativePlayedMs: 0,
      cumulativeActiveMs: 0,
      checkpointSeq: 1,
    })
    assert.equal(session(db).sessionUuid, started.ack.sessionUuid)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_daily').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_tracks').get().count, 0)
    assert.deepEqual(repository.playbackGetResume(), beforeResume)
    assert.deepEqual(total(db), {
      baselinePlayedMs: Number.MAX_SAFE_INTEGER,
      livePlayedMs: 0,
      baselineActiveMs: 0,
      liveActiveMs: 0,
      updatedAtMs: 1,
    })
  })

  it('rolls back activity start when a trigger aborts after the resume write', async() => {
    const db = await createStore()
    const before = durableState(db)
    db.exec(`
      CREATE TEMP TRIGGER fail_activity_start_after_resume
      AFTER INSERT ON playback_resume_state
      BEGIN
        SELECT RAISE(ABORT, 'late activity start failure');
      END;
    `)

    assert.throws(() => repository.playbackStart(startCommand()), /late activity start failure/)

    assert.deepEqual(durableState(db), before)
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('rolls back ordinary commit when a trigger aborts after the optional event write', async() => {
    const db = await createStore()
    const started = repository.playbackStart(startCommand())
    const before = durableState(db)
    db.exec(`
      CREATE TEMP TRIGGER fail_commit_after_event
      AFTER INSERT ON playback_events
      WHEN NEW.sequence_no = 2
      BEGIN
        SELECT RAISE(ABORT, 'late ordinary commit failure');
      END;
    `)

    assert.throws(
      () => repository.playbackCommit(commitAt(2, 1000, pauseFact)),
      /late ordinary commit failure/,
    )

    assert.deepEqual(durableState(db), before)
    assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), started.ack)
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('rolls back day boundary when a trigger aborts after the new segment write', async() => {
    const db = await createStore()
    const started = repository.playbackStart(startCommand())
    const before = durableState(db)
    db.exec(`
      CREATE TEMP TRIGGER fail_boundary_after_new_segment
      AFTER INSERT ON playback_sessions
      WHEN NEW.segment_no = 1
      BEGIN
        SELECT RAISE(ABORT, 'late day boundary failure');
      END;
    `)
    const played = 23 * 60 * 60 * 1000

    assert.throws(() => repository.playbackCommit({
      version: 1,
      checkpoint: checkpoint(2, played, {
        cumulativeActiveMs: played,
        positionMs: 1000,
        occurredAtMs: Date.parse('2026-03-09T04:00:00.000Z'),
      }),
      boundary: { type: 'day_boundary', nextLocalDay: '2026-03-09', utcOffsetMinutes: -240 },
    }), /late day boundary failure/)

    assert.deepEqual(durableState(db), before)
    assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), started.ack)
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('rolls back preplay failure when a trigger aborts after the error event write', async() => {
    const db = await createStore()
    const before = durableState(db)
    db.exec(`
      CREATE TEMP TRIGGER fail_preplay_after_error
      AFTER INSERT ON playback_events
      WHEN NEW.event_type = 'error'
      BEGIN
        SELECT RAISE(ABORT, 'late preplay failure');
      END;
    `)
    const input = {
      ...startCommand({ recentAllowed: true, statsAllowed: false }),
      error: { version: 1, type: 'error', stage: 'url', code: 404, recoverable: false, attempt: 2 },
    }

    assert.throws(
      () => repository.playbackRecordPreplayFailure(input),
      /late preplay failure/,
    )

    assert.deepEqual(durableState(db), before)
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('enforces all consent combinations and private playback', async() => {
    const groups = [
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '55555555-5555-4555-8555-555555555555',
      '66666666-6666-4666-8666-666666666666',
      '77777777-7777-4777-8777-777777777777',
    ]
    const matrix = [
      { recentAllowed: true, statsAllowed: true, privateMode: false, mode: 'activity', sessions: 1, recent: 1, playedMs: 1000, resume: 1 },
      { recentAllowed: true, statsAllowed: false, privateMode: false, mode: 'activity', sessions: 1, recent: 1, playedMs: 0, resume: 1 },
      { recentAllowed: false, statsAllowed: true, privateMode: false, mode: 'activity', sessions: 1, recent: 0, playedMs: 1000, resume: 1 },
      { recentAllowed: false, statsAllowed: false, privateMode: false, mode: 'resume-only', sessions: 0, recent: 0, playedMs: 0, resume: 1 },
      { recentAllowed: true, statsAllowed: true, privateMode: true, mode: 'private', sessions: 0, recent: 0, playedMs: 0, resume: 0 },
    ]

    for (const [index, expected] of matrix.entries()) {
      const db = await createStore()
      const group = groups[index]
      const request = startCommand({
        recentAllowed: expected.recentAllowed,
        statsAllowed: expected.statsAllowed,
        privateMode: expected.privateMode,
      }, { playbackGroupUuid: group })
      const started = repository.playbackStart(request)
      assert.equal(started.mode, expected.mode)
      if (started.mode == 'activity') {
        repository.playbackCommit(commitAt(
          2,
          expected.statsAllowed ? 1000 : 0,
          undefined,
          {
            playbackGroupUuid: group,
            cumulativeActiveMs: expected.statsAllowed ? 1100 : 0,
          },
        ))
      } else if (started.mode == 'resume-only') {
        assert.deepEqual(started.ack, {
          playbackGroupUuid: group,
          checkpointSeq: 1,
          positionMs: 500,
        })
        assert.deepEqual(repository.playbackStart(request), started)
        repository.playbackUpdateResume({
          version: 1,
          playbackGroupUuid: group,
          checkpointSeq: 2,
          track: { source: 'test', sourceTrackId: 'one' },
          listId: 'list-one',
          indexHint: 3,
          positionMs: 1500,
          durationMs: 240000,
          updatedAtMs: startAt + 1000,
        })
      } else {
        assert.deepEqual(started, {
          mode: 'private',
          playbackGroupUuid: group,
          checkpointSeq: 0,
        })
      }
      assert.deepEqual({
        sessions: db.prepare('SELECT COUNT(*) AS count FROM playback_sessions').get().count,
        events: db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count,
        recent: db.prepare('SELECT COUNT(*) AS count FROM recent_tracks').get().count,
        playedMs: total(db).livePlayedMs,
        resume: db.prepare('SELECT COUNT(*) AS count FROM playback_resume_state').get().count,
      }, {
        sessions: expected.sessions,
        events: expected.sessions,
        recent: expected.recent,
        playedMs: expected.playedMs,
        resume: expected.resume,
      })
      if (started.mode == 'activity' && !expected.statsAllowed) {
        assert.equal(session(db, 0, group).playedMs, 0)
        assert.equal(session(db, 0, group).activeMs, 0)
        assert.equal(session(db, 0, group).cumulativePlayedMs, 0)
        assert.equal(session(db, 0, group).cumulativeActiveMs, 0)
      }
      dbService.close()
    }
  })

  it('uses stored consent for later commits after a conflicting start replay', async() => {
    const db = await createStore()
    const start = repository.playbackStart(startCommand({ recentAllowed: false, statsAllowed: true }))
    repository.playbackCommit(commitAt(2, 1000))
    repository.playbackStart(startCommand({ recentAllowed: true, statsAllowed: false }))
    repository.playbackCommit(commitAt(3, 2000, undefined, { cumulativeActiveMs: 2200 }))

    assert.equal(repository.playbackGetRecent({ version: 1, limit: 520 }).length, 0)
    assert.equal(total(db).livePlayedMs, 2000)
    assert.equal(session(db).recentAllowed, 0)
    assert.equal(session(db).statsAllowed, 1)
    assert.equal(session(db).sessionUuid, start.ack.sessionUuid)
  })

  it('rotates a DST boundary without changing the group or duplicating delta', async() => {
    const db = await createStore()
    enablePlayCount(db)
    repository.playbackStart(startCommand())
    const played = 23 * 60 * 60 * 1000

    const request = {
      version: 1,
      checkpoint: checkpoint(2, played, {
        cumulativeActiveMs: played,
        positionMs: 1000,
        occurredAtMs: Date.parse('2026-03-09T04:00:00.000Z'),
      }),
      boundary: { type: 'day_boundary', nextLocalDay: '2026-03-09', utcOffsetMinutes: -240 },
    }
    const ack = repository.playbackCommit(request)

    assert.equal(ack.playbackGroupUuid, groupA)
    assert.equal(ack.segmentNo, 1)
    assert.equal(session(db, 0).utcOffsetMinutes, -300)
    assert.equal(session(db, 0).state, 'closed')
    assert.equal(session(db, 0).endReason, 'day_boundary')
    assert.equal(session(db, 0).playedMs, played)
    assert.equal(session(db, 1).utcOffsetMinutes, -240)
    assert.equal(session(db, 1).state, 'playing')
    assert.equal(session(db, 1).playedMs, 0)
    assert.equal(session(db, 1).cumulativePlayedMs, played)
    assert.equal(total(db).livePlayedMs, played)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, 1)
    assert.deepEqual(repository.playbackGetListeningStats().daily.map(row => [row.localDay, row.livePlayedMs]), [
      ['2026-03-08', played],
    ])
    assert.deepEqual(repository.playbackCommit(request), ack)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_sessions').get().count, 2)
    assert.equal(total(db).livePlayedMs, played)
    assert.equal(repository.playbackGetListeningStats().tracks[0].playCount, 1)
  })

  it('rejects a boundary whose local day or UTC offset does not match its occurrence', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())
    const request = {
      version: 1,
      checkpoint: checkpoint(2, 1000, { occurredAtMs: Date.parse('2026-03-09T04:00:00.000Z') }),
      boundary: { type: 'day_boundary', nextLocalDay: '2026-03-09', utcOffsetMinutes: -300 },
    }

    assert.throws(() => repository.playbackCommit(request), /playback_boundary_mismatch/)
    assert.equal(session(db).checkpointSeq, 1)
    assert.equal(total(db).livePlayedMs, 0)
  })

  it('rejects instants after an ordinary midnight boundary before mutation', async() => {
    const db = await createStore()
    const started = repository.playbackStart(startCommand())
    const before = durableState(db)

    for (const occurredAtMs of [
      Date.parse('2026-03-09T04:00:00.001Z'),
      Date.parse('2026-03-09T16:00:00.000Z'),
    ]) {
      assert.throws(() => repository.playbackCommit({
        version: 1,
        checkpoint: checkpoint(2, 1000, { occurredAtMs }),
        boundary: { type: 'day_boundary', nextLocalDay: '2026-03-09', utcOffsetMinutes: -240 },
      }), /playback_boundary_mismatch/)
      assert.deepEqual(durableState(db), before)
    }

    assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), started.ack)
  })

  it('rotates exact and delayed midnight callbacks at the exact boundary and drains later commands', async() => {
    const cases = [
      { label: 'exact', delayMs: 0, expectedPriorMs: 10_000, expectedCurrentMs: 0 },
      { label: '+1 ms', delayMs: 1, expectedPriorMs: 10_000, expectedCurrentMs: 1 },
      { label: 'materially delayed', delayMs: 20_000, expectedPriorMs: 10_000, expectedCurrentMs: 20_000 },
    ]

    for (const testCase of cases) {
      const db = await createStore()
      const startMs = Date.parse('2026-01-02T04:59:50.000Z')
      const pipeline = createPlaybackPipeline({ occurredAtMs: startMs })
      assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true, testCase.label)

      const elapsedMs = 10_000 + testCase.delayMs
      Object.assign(pipeline.current, {
        occurredAtMs: startMs + elapsedMs,
        monotonicMs: elapsedMs,
        positionMs: elapsedMs,
      })
      pipeline.fireNextBoundary()
      pipeline.controller.checkpoint()

      assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true, testCase.label)
      assert.equal(pipeline.recorder.getState().outbox.length, 0, testCase.label)
      const boundary = pipeline.commands.find(command => command.kind == 'commit' && command.request.boundary != null)
      assert.equal(boundary.request.checkpoint.occurredAtMs, Date.parse('2026-01-02T05:00:00.000Z'), testCase.label)
      assert.deepEqual(repository.playbackGetListeningStats().daily.map(row => [row.localDay, row.livePlayedMs]), [
        ['2026-01-01', testCase.expectedPriorMs],
        ...(testCase.expectedCurrentMs == 0 ? [] : [['2026-01-02', testCase.expectedCurrentMs]]),
      ], testCase.label)
      pipeline.stop()
      dbService.close()
    }
  })

  it('catches up every missed New York spring boundary without skipping the 23-hour day', async() => {
    const db = await createStore()
    const startMs = Date.parse('2026-03-07T05:00:00.000Z')
    const endMs = Date.parse('2026-03-10T05:00:00.000Z')
    const elapsedMs = endMs - startMs
    const pipeline = createPlaybackPipeline({ occurredAtMs: startMs })
    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)

    Object.assign(pipeline.current, { occurredAtMs: endMs, monotonicMs: elapsedMs, positionMs: elapsedMs })
    pipeline.fireNextBoundary()
    pipeline.controller.checkpoint()

    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)
    assert.equal(pipeline.recorder.getState().outbox.length, 0)
    assert.deepEqual(pipeline.commands
      .filter(command => command.kind == 'commit' && command.request.boundary != null)
      .map(command => [
        command.request.checkpoint.occurredAtMs,
        command.request.boundary.nextLocalDay,
        command.request.boundary.utcOffsetMinutes,
      ]), [
      [Date.parse('2026-03-08T05:00:00.000Z'), '2026-03-08', -300],
      [Date.parse('2026-03-09T04:00:00.000Z'), '2026-03-09', -240],
      [Date.parse('2026-03-10T04:00:00.000Z'), '2026-03-10', -240],
    ])
    assert.deepEqual(repository.playbackGetListeningStats().daily.map(row => [row.localDay, row.livePlayedMs]), [
      ['2026-03-07', 24 * 60 * 60 * 1_000],
      ['2026-03-08', 23 * 60 * 60 * 1_000],
      ['2026-03-09', 24 * 60 * 60 * 1_000],
      ['2026-03-10', 60 * 60 * 1_000],
    ])
    assert.equal(total(db).livePlayedMs, elapsedMs)
  })

  it('allocates the complete 25-hour New York fall day before the next boundary', async() => {
    const db = await createStore()
    const startMs = Date.parse('2026-11-01T04:00:00.000Z')
    const boundaryMs = Date.parse('2026-11-02T05:00:00.000Z')
    const elapsedMs = boundaryMs - startMs
    const pipeline = createPlaybackPipeline({ occurredAtMs: startMs })
    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)

    Object.assign(pipeline.current, { occurredAtMs: boundaryMs, monotonicMs: elapsedMs, positionMs: elapsedMs })
    pipeline.fireNextBoundary()

    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)
    assert.deepEqual(repository.playbackGetListeningStats().daily.map(row => [row.localDay, row.livePlayedMs]), [
      ['2026-11-01', 25 * 60 * 60 * 1_000],
    ])
    assert.equal(total(db).livePlayedMs, elapsedMs)
  })

  it('rotates paused and buffering intervals without adding played or active time', async() => {
    for (const phase of ['paused', 'buffering']) {
      const db = await createStore()
      const startMs = Date.parse('2026-01-02T04:59:50.000Z')
      const pipeline = createPlaybackPipeline({ occurredAtMs: startMs, phase })
      assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true, phase)

      Object.assign(pipeline.current, { occurredAtMs: startMs + 30_000, monotonicMs: 30_000, positionMs: 0 })
      pipeline.fireNextBoundary()

      assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true, phase)
      assert.equal(total(db).livePlayedMs, 0, phase)
      assert.equal(total(db).liveActiveMs, 0, phase)
      assert.deepEqual(repository.playbackGetListeningStats().daily, [], phase)
      pipeline.stop()
      dbService.close()
    }
  })

  it('interpolates divergent wall and monotonic clocks and conservatively resets an unsafe interval', async() => {
    let db = await createStore()
    let startMs = Date.parse('2026-01-02T04:59:50.000Z')
    let pipeline = createPlaybackPipeline({ occurredAtMs: startMs })
    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)

    Object.assign(pipeline.current, { occurredAtMs: startMs + 30_000, monotonicMs: 15_000, positionMs: 15_000 })
    pipeline.fireNextBoundary()
    pipeline.controller.checkpoint()
    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)
    assert.deepEqual(repository.playbackGetListeningStats().daily.map(row => [row.localDay, row.livePlayedMs]), [
      ['2026-01-01', 5_000],
      ['2026-01-02', 10_000],
    ])
    assert.equal(total(db).livePlayedMs, 15_000)

    pipeline.stop()
    dbService.close()
    db = await createStore()
    startMs = Date.parse('2026-01-03T04:59:50.000Z')
    pipeline = createPlaybackPipeline({ occurredAtMs: startMs, monotonicMs: 10_000, positionMs: 10_000 })
    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)
    Object.assign(pipeline.current, { occurredAtMs: startMs + 30_000, monotonicMs: 1_000, positionMs: 1_000 })
    pipeline.fireNextBoundary()
    Object.assign(pipeline.current, { occurredAtMs: startMs + 31_000, monotonicMs: 2_000, positionMs: 2_000 })
    pipeline.controller.checkpoint()

    assert.equal(await pipeline.recorder.flush({ timeoutMs: 1_000 }), true)
    assert.deepEqual(repository.playbackGetListeningStats().daily.map(row => [row.localDay, row.livePlayedMs]), [
      ['2026-01-03', 1_000],
    ])
    assert.equal(total(db).livePlayedMs, 1_000)
  })

  it('rejects a midnight multiple civil dates after the open segment before mutation', async() => {
    const db = await createStore()
    const started = repository.playbackStart(startCommand())
    const before = durableState(db)

    assert.throws(() => repository.playbackCommit({
      version: 1,
      checkpoint: checkpoint(2, 1000, {
        occurredAtMs: Date.parse('2026-03-10T04:00:00.000Z'),
      }),
      boundary: { type: 'day_boundary', nextLocalDay: '2026-03-10', utcOffsetMinutes: -240 },
    }), /playback_boundary_mismatch/)

    assert.deepEqual(durableState(db), before)
    assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), started.ack)
  })

  it('rejects skipped calendar labels and does not jump to the later existing date', async() => {
    const originalTimeZone = process.env.TZ
    process.env.TZ = 'Pacific/Apia'
    try {
      const db = await createStore()
      const started = repository.playbackStart(startCommand({}, {
        occurredAtMs: Date.parse('2011-12-29T10:00:00.000Z'),
      }))
      const before = durableState(db)
      const checkpointAtDateLine = checkpoint(2, 1000, {
        occurredAtMs: Date.parse('2011-12-30T10:00:00.000Z'),
      })

      assert.throws(() => repository.playbackCommit({
        version: 1,
        checkpoint: checkpointAtDateLine,
        boundary: { type: 'day_boundary', nextLocalDay: '2011-12-30', utcOffsetMinutes: 840 },
      }), /playback_boundary_mismatch/)
      assert.throws(() => repository.playbackCommit({
        version: 1,
        checkpoint: checkpointAtDateLine,
        boundary: { type: 'day_boundary', nextLocalDay: '2011-12-31', utcOffsetMinutes: 840 },
      }), /playback_boundary_mismatch/)

      assert.deepEqual(durableState(db), before)
      assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), started.ack)
    } finally {
      process.env.TZ = originalTimeZone
    }
  })

  it('accepts the first valid instant after a DST-skipped local midnight', async() => {
    const originalTimeZone = process.env.TZ
    process.env.TZ = 'America/Santiago'
    try {
      const db = await createStore()
      repository.playbackStart(startCommand({}, {
        occurredAtMs: Date.parse('2026-09-05T04:00:00.000Z'),
      }))
      const played = 24 * 60 * 60 * 1000
      const before = durableState(db)

      assert.throws(() => repository.playbackCommit({
        version: 1,
        checkpoint: checkpoint(2, played, {
          cumulativeActiveMs: played,
          positionMs: 1000,
          occurredAtMs: Date.parse('2026-09-06T04:00:00.001Z'),
        }),
        boundary: { type: 'day_boundary', nextLocalDay: '2026-09-06', utcOffsetMinutes: -180 },
      }), /playback_boundary_mismatch/)
      assert.deepEqual(durableState(db), before)

      const ack = repository.playbackCommit({
        version: 1,
        checkpoint: checkpoint(2, played, {
          cumulativeActiveMs: played,
          positionMs: 1000,
          occurredAtMs: Date.parse('2026-09-06T04:00:00.000Z'),
        }),
        boundary: { type: 'day_boundary', nextLocalDay: '2026-09-06', utcOffsetMinutes: -180 },
      })

      assert.equal(ack.segmentNo, 1)
      assert.equal(session(db, 0).localDay, '2026-09-05')
      assert.equal(session(db, 0).utcOffsetMinutes, -240)
      assert.equal(session(db, 1).localDay, '2026-09-06')
      assert.equal(session(db, 1).utcOffsetMinutes, -180)
      assert.equal(total(db).livePlayedMs, played)
    } finally {
      process.env.TZ = originalTimeZone
    }
  })

  it('rotates the 25-hour fall DST day at the supplied civil midnight', async() => {
    const db = await createStore()
    const fallStart = Date.parse('2026-11-01T04:00:00.000Z')
    repository.playbackStart(startCommand({}, { occurredAtMs: fallStart }))
    const played = 25 * 60 * 60 * 1000

    const ack = repository.playbackCommit({
      version: 1,
      checkpoint: checkpoint(2, played, {
        cumulativeActiveMs: played,
        positionMs: 1000,
        occurredAtMs: Date.parse('2026-11-02T05:00:00.000Z'),
      }),
      boundary: { type: 'day_boundary', nextLocalDay: '2026-11-02', utcOffsetMinutes: -300 },
    })

    assert.equal(ack.segmentNo, 1)
    assert.equal(session(db, 0).localDay, '2026-11-01')
    assert.equal(session(db, 0).utcOffsetMinutes, -240)
    assert.equal(session(db, 1).localDay, '2026-11-02')
    assert.equal(session(db, 1).utcOffsetMinutes, -300)
    assert.equal(total(db).livePlayedMs, played)
  })

  it('returns a terminal acknowledgement after ack loss and fails closed for a newer request', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())
    const final = repository.playbackCommit(commitAt(2, 1000, {
      version: 1,
      type: 'skip',
      reason: 'next',
      automatic: false,
    }))

    assert.equal(session(db).state, 'closed')
    assert.equal(session(db).endReason, 'next')
    assert.deepEqual(repository.playbackCommit(commitAt(2, 1000)), final)
    assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), final)
    assert.throws(() => repository.playbackCommit(commitAt(3, 2000)), /playback_group_closed/)
    assert.equal(total(db).livePlayedMs, 1000)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, 2)
  })

  it('rejects unknown groups and decreasing cumulative counters without mutation', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())
    repository.playbackCommit(commitAt(2, 1000))

    assert.throws(() => repository.playbackCommit(commitAt(3, 999)), /Invalid cumulativePlayedMs/)
    assert.throws(() => repository.playbackCommit(commitAt(3, 2000, undefined, { cumulativeActiveMs: 1099 })), /Invalid cumulativeActiveMs/)
    assert.throws(() => repository.playbackCommit(commitAt(2, 0, undefined, { playbackGroupUuid: groupB })), /playback_group_not_found/)
    assert.equal(session(db).checkpointSeq, 2)
    assert.equal(total(db).livePlayedMs, 1000)
  })

  it('stores semantic fact fields and closes only terminal facts', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())
    repository.playbackCommit(commitAt(2, 100, { version: 1, type: 'pause', reason: 'device' }))
    assert.equal(session(db).state, 'paused')
    repository.playbackCommit(commitAt(3, 200, { version: 1, type: 'resume', reason: 'recovery' }, { cumulativeActiveMs: 400 }))
    repository.playbackCommit(commitAt(4, 300, { version: 1, type: 'seek', origin: 'party', fromMs: 700, toMs: 9000 }, { cumulativeActiveMs: 500 }))
    repository.playbackCommit(commitAt(5, 400, { version: 1, type: 'error', stage: 'buffer', code: 12, recoverable: true, attempt: 2 }, { cumulativeActiveMs: 600 }))
    assert.equal(session(db).state, 'playing')
    repository.playbackCommit(commitAt(6, 500, { version: 1, type: 'error', stage: 'decode', code: null, recoverable: false, attempt: 3 }, { cumulativeActiveMs: 700 }))

    assert.equal(session(db).state, 'closed')
    assert.equal(session(db).endReason, 'error')
    assert.deepEqual(db.prepare(`
      SELECT sequence_no AS sequenceNo, event_type AS type, reason, details_json AS detailsJson
      FROM playback_events ORDER BY sequence_no
    `).all(), [
      { sequenceNo: 1, type: 'play_start', reason: 'select', detailsJson: null },
      { sequenceNo: 2, type: 'pause', reason: 'device', detailsJson: null },
      { sequenceNo: 3, type: 'resume', reason: 'recovery', detailsJson: null },
      { sequenceNo: 4, type: 'seek', reason: 'party', detailsJson: '{"fromMs":700,"toMs":9000}' },
      { sequenceNo: 5, type: 'error', reason: null, detailsJson: '{"attempt":2,"code":12,"recoverable":true,"stage":"buffer"}' },
      { sequenceNo: 6, type: 'error', reason: null, detailsJson: '{"attempt":3,"code":null,"recoverable":false,"stage":"decode"}' },
    ])
  })

  it('persists the renderer-produced fallback pause reason through the repository', async() => {
    const db = await createStore()
    const { AppEvent } = require('../../src/renderer/event/appEvent.ts')
    const recorderPath = path.resolve(__dirname, '../../src/renderer/core/playbackRecorder/index.ts')
    const hookPath = path.resolve(__dirname, '../../src/renderer/core/useApp/usePlayer/usePlaybackRecorder.ts')
    const commitRequests = []
    let alive = true
    let cleanup = () => {}
    const recorder = loadTsModule(recorderPath, {
      '../../utils/playback': { sendPlaybackCommand: async() => { throw new Error('unexpected default transport') } },
    }).createPlaybackRecorder({
      isAlive: () => alive,
      retry: { initialMs: 100, maxMs: 100 },
      transport: async command => {
        switch (command.kind) {
          case 'start': return repository.playbackStart(command.request)
          case 'commit':
            commitRequests.push(command.request)
            return repository.playbackCommit(command.request)
          default: throw new Error('unexpected playback mode')
        }
      },
    })
    const hook = loadTsModule(hookPath, {
      '@renderer/core/playbackRecorder': { createPlaybackRecorder: () => recorder },
      '@renderer/store/recentPlay/action': { initRecentPlayList: async() => {} },
      '@renderer/store/listeningTime/action': { initListeningTimeStats: async() => {} },
      '@renderer/utils/ipc': { registerShutdownFlusher: () => () => {} },
      '@renderer/plugins/player': {
        getCurrentTime: () => 0,
        getDuration: () => 240,
        getPlaybackRate: () => 1,
        onTimeupdate: () => () => {},
      },
      '@common/utils/vueTools': { onBeforeUnmount: callback => { cleanup = callback } },
    })
    const appEvent = new AppEvent()
    const previousWindow = global.window
    global.window = { app_event: appEvent }

    try {
      hook.default()
      appEvent.musicToggled({
        track: track(),
        context: { type: 'playlist', id: 'list-one' },
        resume: { listId: 'list-one', indexHint: 3 },
        startReason: 'select',
        startPositionMs: 0,
      })
      appEvent.playerPlaying()
      assert.equal(await recorder.flush({ timeoutMs: 1000 }), true)

      appEvent.playerPause()
      const flushed = await recorder.flush({ timeoutMs: 1000 })
      assert.deepEqual(commitRequests[0].fact, { version: 1, type: 'pause', reason: 'device' })
      assert.equal(flushed, true)
      assert.deepEqual(db.prepare(`
        SELECT event_type AS type, reason
        FROM playback_events WHERE sequence_no = 2
      `).get(), { type: 'pause', reason: 'device' })
    } finally {
      alive = false
      cleanup()
      global.window = previousWindow
    }
  })

  it('rejects commit-time play_start while playing or paused without mutation', async() => {
    const db = await createStore()
    const started = repository.playbackStart(startCommand())
    const blocker = new Database(db.name)
    db.pragma('busy_timeout = 1')
    let before = durableState(db)

    const rejectWhileWriteLocked = request => {
      blocker.exec('BEGIN IMMEDIATE')
      try {
        assert.equal(
          captureError(() => repository.playbackCommit(request)).message,
          'playback_commit_play_start_forbidden',
        )
      } finally {
        blocker.exec('ROLLBACK')
      }
    }

    try {
      rejectWhileWriteLocked(commitAt(2, 1000, playStartFact))
      assert.deepEqual(durableState(db), before)
      assert.deepEqual(repository.playbackCommit(commitAt(1, 0)), started.ack)

      const paused = repository.playbackCommit(commitAt(2, 1000, pauseFact))
      before = durableState(db)
      rejectWhileWriteLocked(commitAt(3, 2000, playStartFact))
      assert.deepEqual(durableState(db), before)
      assert.deepEqual(repository.playbackCommit(commitAt(2, 1000)), paused)
    } finally {
      if (blocker.inTransaction) blocker.exec('ROLLBACK')
      blocker.close()
    }
  })

  it('updates resume idempotently and prevents an older group from replacing newer state', async() => {
    await createStore()
    const update = (playbackGroupUuid, checkpointSeq, updatedAtMs, positionMs) => ({
      version: 1,
      playbackGroupUuid,
      checkpointSeq,
      track: { source: 'test', sourceTrackId: playbackGroupUuid == groupA ? 'one' : 'two' },
      listId: null,
      indexHint: null,
      positionMs,
      durationMs: null,
      updatedAtMs,
    })

    const first = repository.playbackUpdateResume(update(groupA, 1, 1000, 10))
    assert.deepEqual(repository.playbackUpdateResume(update(groupA, 1, 2000, 20)), first)
    assert.deepEqual(repository.playbackUpdateResume(update(groupA, 0, 3000, 30)), first)
    assert.deepEqual(repository.playbackUpdateResume(update(groupA, 2, 2000, 20)), {
      playbackGroupUuid: groupA,
      checkpointSeq: 2,
      positionMs: 20,
    })
    assert.deepEqual(repository.playbackUpdateResume(update(groupB, 1, 1999, 30)), {
      playbackGroupUuid: groupA,
      checkpointSeq: 2,
      positionMs: 20,
    })
    assert.deepEqual(repository.playbackUpdateResume(update(groupB, 1, 2000, 30)), {
      playbackGroupUuid: groupB,
      checkpointSeq: 1,
      positionMs: 30,
    })
    assert.deepEqual(repository.playbackGetResume(), {
      version: 1,
      source: 'test',
      sourceTrackId: 'two',
      listId: null,
      indexHint: null,
      positionMs: 30,
      durationMs: null,
      updatedAtMs: 2000,
    })
  })

  it('records one closed zero-duration final pre-play failure without projections', async() => {
    const db = await createStore()
    const input = {
      ...startCommand({ recentAllowed: true, statsAllowed: false }),
      error: { version: 1, type: 'error', stage: 'url', code: 404, recoverable: false, attempt: 2 },
    }

    const ack = repository.playbackRecordPreplayFailure(input)

    assert.equal(ack.checkpointSeq, 1)
    assert.equal(session(db).state, 'closed')
    assert.equal(session(db).endReason, 'error')
    assert.equal(session(db).endedAtMs, startAt)
    assert.equal(session(db).playedMs, 0)
    assert.equal(session(db).recentAllowed, 0)
    assert.equal(session(db).statsAllowed, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events WHERE event_type = \'error\'').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_tracks').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_tracks').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_resume_state').get().count, 0)
    assert.deepEqual(repository.playbackRecordPreplayFailure(input), ack)
  })

  it('rejects private, both-disabled, and recoverable pre-play failures before any write', async() => {
    assert.equal(typeof repository.playbackRecordPreplayFailure, 'function')
    const cases = [
      { consent: { recentAllowed: false, statsAllowed: false, privateMode: false }, error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: false, attempt: 1 }, expectedError: /playback_activity_disabled/ },
      { consent: { recentAllowed: true, statsAllowed: true, privateMode: true }, error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: false, attempt: 1 }, expectedError: /playback_private_mode/ },
      { consent: { recentAllowed: true, statsAllowed: false, privateMode: false }, error: { version: 1, type: 'error', stage: 'url', code: null, recoverable: true, attempt: 1 }, expectedError: /playback_preplay_failure_recoverable/ },
    ]

    for (const overrides of cases) {
      const db = await createStore()
      assert.throws(
        () => repository.playbackRecordPreplayFailure({ ...startCommand(overrides.consent), error: overrides.error }),
        overrides.expectedError,
      )
      assert.deepEqual(counts(db), {
        track_snapshots: 0,
        playback_sessions: 0,
        playback_events: 0,
        recent_tracks: 0,
        listening_daily: 0,
        listening_tracks: 0,
        playback_resume_state: 0,
      })
      dbService.close()
    }
  })

  it('interrupts stale open sessions without fabricating duration, events, or projection changes', async() => {
    const db = await createStore()
    repository.playbackStart(startCommand())
    repository.playbackCommit(commitAt(2, 1000, pauseFact))
    const beforeEvents = db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count
    const beforeTotal = total(db)

    assert.equal(repository.playbackMarkStaleSessionsInterrupted({ nowMs: startAt + 5000 }), 1)
    assert.equal(repository.playbackMarkStaleSessionsInterrupted({ nowMs: startAt + 6000 }), 0)

    assert.equal(session(db).state, 'interrupted')
    assert.equal(session(db).endedAtMs, startAt + 5000)
    assert.equal(session(db).endReason, null)
    assert.equal(session(db).playedMs, 1000)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, beforeEvents)
    assert.deepEqual(total(db), beforeTotal)
    assert.deepEqual(repository.playbackCommit(commitAt(2, 1000)), {
      playbackGroupUuid: groupA,
      sessionUuid: session(db).sessionUuid,
      segmentNo: 0,
      checkpointSeq: 2,
      cumulativePlayedMs: 1000,
      cumulativeActiveMs: 1100,
    })
    assert.throws(() => repository.playbackCommit(commitAt(3, 2000)), /playback_group_closed/)
  })

  it('caps live recent playback at 520 rows in recency order', async() => {
    const db = await createStore()
    for (let index = 0; index < 521; index++) {
      const hex = (index + 1000).toString(16).padStart(12, '0')
      const group = `aaaaaaaa-aaaa-4aaa-8aaa-${hex}`
      repository.playbackStart(startCommand({}, {
        playbackGroupUuid: group,
        track: track(String(index)),
        occurredAtMs: startAt + index,
      }))
    }

    const recent = repository.playbackGetRecent({ version: 1, limit: 520 })
    assert.equal(recent.length, 520)
    assert.equal(recent[0].sourceTrackId, '520')
    assert.equal(recent.at(-1).sourceTrackId, '1')
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_tracks').get().count, 520)
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM recent_tracks recent
      JOIN track_snapshots track ON track.track_id = recent.track_id
      WHERE track.source_track_id = '0'
    `).get().count, 0)
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('rolls back a start when recent projection sequencing cannot advance', async() => {
    const db = await createStore()
    db.prepare(`
      INSERT INTO track_snapshots(
        source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
      ) VALUES('test', 'one', 'Legacy name', 'Legacy singer', NULL, NULL, 0)
    `).run()
    const trackId = db.prepare("SELECT track_id AS trackId FROM track_snapshots WHERE source_track_id = 'one'").get().trackId
    db.prepare(`
      INSERT INTO recent_tracks(
        track_id, recency_seq, last_session_id, last_played_at_ms, legacy_rank, updated_at_ms
      ) VALUES(?, ?, NULL, NULL, 1, 0)
    `).run(trackId, Number.MAX_SAFE_INTEGER)

    assert.throws(() => repository.playbackStart(startCommand()), /playback_recent_sequence_exhausted/)
    assert.deepEqual(counts(db), {
      track_snapshots: 1,
      playback_sessions: 0,
      playback_events: 0,
      recent_tracks: 1,
      listening_daily: 0,
      listening_tracks: 0,
      playback_resume_state: 0,
    })
    assert.deepEqual(db.prepare(`
      SELECT name, singer, duration_ms AS durationMs, updated_at_ms AS updatedAtMs
      FROM track_snapshots WHERE track_id = ?
    `).get(trackId), {
      name: 'Legacy name',
      singer: 'Legacy singer',
      durationMs: null,
      updatedAtMs: 0,
    })
    assert.deepEqual(db.prepare(`
      SELECT last_session_id AS lastSessionId, updated_at_ms AS updatedAtMs
      FROM projection_state WHERE name = 'recent'
    `).get(), { lastSessionId: null, updatedAtMs: 0 })
    assert.deepEqual(integrity(db), { quick: [{ quick_check: 'ok' }], foreignKeys: [] })
  })

  it('promotes imported baselines with a positive live recency sequence and preserves exact sums', async() => {
    const db = await createStore()
    db.prepare(`
      INSERT INTO track_snapshots(
        source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
      ) VALUES('test', 'one', 'Legacy name', 'Legacy singer', NULL, NULL, 0)
    `).run()
    const trackId = db.prepare("SELECT track_id AS trackId FROM track_snapshots WHERE source_track_id = 'one'").get().trackId
    db.prepare(`
      INSERT INTO recent_tracks(
        track_id, recency_seq, last_session_id, last_played_at_ms, legacy_rank, updated_at_ms
      ) VALUES(?, -1, NULL, NULL, 1, 0)
    `).run(trackId)
    db.prepare(`
      INSERT INTO listening_daily(
        local_day, baseline_played_ms, live_played_ms,
        baseline_active_ms, live_active_ms, updated_at_ms
      ) VALUES('2026-03-08', 4000, 0, 0, 0, 0)
    `).run()
    db.prepare(`
      INSERT INTO listening_tracks(
        track_id, baseline_played_ms, live_played_ms,
        baseline_active_ms, live_active_ms, last_played_at_ms, updated_at_ms
      ) VALUES(?, 3000, 0, 0, 0, NULL, 0)
    `).run(trackId)
    db.prepare('UPDATE activity_totals SET baseline_played_ms = 5000 WHERE id = 1').run()

    repository.playbackStart(startCommand())
    repository.playbackCommit(commitAt(2, 1000))

    assert.deepEqual(db.prepare(`
      SELECT recency_seq AS recencySeq, legacy_rank AS legacyRank
      FROM recent_tracks WHERE track_id = ?
    `).get(trackId), { recencySeq: 1, legacyRank: null })
    const stats = repository.playbackGetListeningStats()
    assert.deepEqual({
      total: [stats.total.baselinePlayedMs, stats.total.livePlayedMs, stats.total.playedMs],
      daily: [stats.daily[0].baselinePlayedMs, stats.daily[0].livePlayedMs, stats.daily[0].playedMs],
      track: [stats.tracks[0].baselinePlayedMs, stats.tracks[0].livePlayedMs, stats.tracks[0].playedMs],
      snapshot: [stats.tracks[0].name, stats.tracks[0].singer, stats.tracks[0].durationMs],
    }, {
      total: [5000, 1000, 6000],
      daily: [4000, 1000, 5000],
      track: [3000, 1000, 4000],
      snapshot: ['Track one', 'Singer one', 240000],
    })
  })

  it('validates query and stale-interruption envelopes exactly', async() => {
    await createStore()
    assert.equal(typeof repository.playbackGetRecent, 'function')
    assert.equal(typeof repository.playbackMarkStaleSessionsInterrupted, 'function')
    const recentError = 'Invalid playback recent query'
    const staleError = 'Invalid stale playback request'
    const hostile = new Proxy({}, {
      getPrototypeOf() { throw new Error('hostile trap escaped') },
    })
    const ownKeysHostile = new Proxy({}, {
      ownKeys() { throw new Error('ownKeys trap escaped') },
    })
    const descriptorHostile = new Proxy({ version: 1, limit: 1 }, {
      getOwnPropertyDescriptor() { throw new Error('descriptor trap escaped') },
    })
    const symbolQuery = { version: 1, limit: 1, [Symbol('extra')]: true }
    const nonEnumerableExtraQuery = { version: 1, limit: 1 }
    Object.defineProperty(nonEnumerableExtraQuery, 'extra', { value: true })
    const nonEnumerableVersionQuery = { limit: 1 }
    Object.defineProperty(nonEnumerableVersionQuery, 'version', { value: 1 })
    let getterCalls = 0
    const accessorVersionQuery = { limit: 1 }
    Object.defineProperty(accessorVersionQuery, 'version', {
      enumerable: true,
      get() {
        getterCalls++
        throw new Error('version getter escaped')
      },
    })
    const accessorLimitQuery = { version: 1 }
    Object.defineProperty(accessorLimitQuery, 'limit', {
      enumerable: true,
      get() {
        getterCalls++
        throw new Error('limit getter escaped')
      },
    })
    const accessorStale = {}
    Object.defineProperty(accessorStale, 'nowMs', {
      enumerable: true,
      get() {
        getterCalls++
        throw new Error('stale getter escaped')
      },
    })
    const countedProxy = (value, counts) => new Proxy(value, {
      ownKeys(target) {
        counts.ownKeys++
        return Reflect.ownKeys(target)
      },
      getOwnPropertyDescriptor(target, key) {
        counts.descriptors++
        return Reflect.getOwnPropertyDescriptor(target, key)
      },
    })

    for (const input of [
      { version: 2, limit: 1 },
      { version: 1, limit: 0 },
      { version: 1, limit: 521 },
      { version: 1, limit: 1.5 },
      { version: 1, limit: 1, extra: true },
      hostile,
      ownKeysHostile,
      descriptorHostile,
      symbolQuery,
      nonEnumerableExtraQuery,
      nonEnumerableVersionQuery,
      accessorVersionQuery,
      accessorLimitQuery,
    ]) assert.equal(captureError(() => repository.playbackGetRecent(input)).message, recentError)
    for (const input of [
      { nowMs: -1 },
      { nowMs: 1.5 },
      { nowMs: 1, extra: true },
      { nowMs: 1, [Symbol('extra')]: true },
      hostile,
      ownKeysHostile,
      accessorStale,
    ]) assert.equal(captureError(() => repository.playbackMarkStaleSessionsInterrupted(input)).message, staleError)
    assert.equal(getterCalls, 0)

    const queryTraps = { ownKeys: 0, descriptors: 0 }
    assert.deepEqual(repository.playbackGetRecent(countedProxy({ version: 1, limit: 1 }, queryTraps)), [])
    assert.deepEqual(queryTraps, { ownKeys: 1, descriptors: 2 })
    const staleTraps = { ownKeys: 0, descriptors: 0 }
    assert.equal(repository.playbackMarkStaleSessionsInterrupted(
      countedProxy({ nowMs: startAt }, staleTraps),
    ), 0)
    assert.deepEqual(staleTraps, { ownKeys: 1, descriptors: 1 })

    assert.equal(captureError(() => repository.playbackGetListeningStats({})).message, 'Invalid playback listening query')
    assert.equal(captureError(() => repository.playbackGetResume({})).message, 'Invalid playback resume query')
  })
})
