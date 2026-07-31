const assert = require('node:assert/strict')
const fs = require('node:fs')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// Electron ABI tests transpile the source modules in-process.
// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const Database = require('better-sqlite3')
const { bootstrapDatabaseSchema, getSchemaVersion, runMigrations } = require('../../src/main/worker/dbService/migrate.ts')
const { migrations } = require('../../src/main/worker/dbService/migrations/index.ts')
const { verifyDatabase } = require('../../src/main/worker/dbService/verifyDB.ts')

const PLAYBACK_TABLES = [
  'activity_totals',
  'listening_daily',
  'listening_tracks',
  'playback_events',
  'playback_resume_state',
  'playback_sessions',
  'projection_state',
  'recent_tracks',
  'track_snapshots',
]

const EXPECTED_COLUMNS = {
  track_snapshots: [
    ['track_id', 'INTEGER', 0, 1],
    ['source', 'TEXT', 1, 0],
    ['source_track_id', 'TEXT', 1, 0],
    ['name', 'TEXT', 1, 0],
    ['singer', 'TEXT', 1, 0],
    ['duration_ms', 'INTEGER', 0, 0],
    ['playable_payload_json', 'TEXT', 0, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
  playback_sessions: [
    ['session_id', 'INTEGER', 0, 1],
    ['session_uuid', 'TEXT', 1, 0],
    ['playback_group_uuid', 'TEXT', 1, 0],
    ['segment_no', 'INTEGER', 1, 0],
    ['track_id', 'INTEGER', 1, 0],
    ['local_day', 'TEXT', 1, 0],
    ['utc_offset_minutes', 'INTEGER', 1, 0],
    ['context_type', 'TEXT', 0, 0],
    ['context_id', 'TEXT', 0, 0],
    ['start_reason', 'TEXT', 1, 0],
    ['end_reason', 'TEXT', 0, 0],
    ['started_at_ms', 'INTEGER', 1, 0],
    ['ended_at_ms', 'INTEGER', 0, 0],
    ['start_position_ms', 'INTEGER', 1, 0],
    ['last_position_ms', 'INTEGER', 1, 0],
    ['duration_ms', 'INTEGER', 0, 0],
    ['played_ms', 'INTEGER', 1, 0],
    ['active_ms', 'INTEGER', 1, 0],
    ['cumulative_played_ms', 'INTEGER', 1, 0],
    ['cumulative_active_ms', 'INTEGER', 1, 0],
    ['checkpoint_seq', 'INTEGER', 1, 0],
    ['state', 'TEXT', 1, 0],
    ['recent_allowed', 'INTEGER', 1, 0],
    ['stats_allowed', 'INTEGER', 1, 0],
    ['created_at_ms', 'INTEGER', 1, 0],
  ],
  playback_events: [
    ['event_id', 'INTEGER', 0, 1],
    ['session_id', 'INTEGER', 1, 0],
    ['sequence_no', 'INTEGER', 1, 0],
    ['event_type', 'TEXT', 1, 0],
    ['occurred_at_ms', 'INTEGER', 1, 0],
    ['position_ms', 'INTEGER', 1, 0],
    ['reason', 'TEXT', 0, 0],
    ['details_json', 'TEXT', 0, 0],
  ],
  recent_tracks: [
    ['track_id', 'INTEGER', 0, 1],
    ['recency_seq', 'INTEGER', 1, 0],
    ['last_session_id', 'INTEGER', 0, 0],
    ['last_played_at_ms', 'INTEGER', 0, 0],
    ['legacy_rank', 'INTEGER', 0, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
  listening_daily: [
    ['local_day', 'TEXT', 0, 1],
    ['baseline_played_ms', 'INTEGER', 1, 0],
    ['live_played_ms', 'INTEGER', 1, 0],
    ['baseline_active_ms', 'INTEGER', 1, 0],
    ['live_active_ms', 'INTEGER', 1, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
  listening_tracks: [
    ['track_id', 'INTEGER', 0, 1],
    ['baseline_played_ms', 'INTEGER', 1, 0],
    ['live_played_ms', 'INTEGER', 1, 0],
    ['baseline_active_ms', 'INTEGER', 1, 0],
    ['live_active_ms', 'INTEGER', 1, 0],
    ['last_played_at_ms', 'INTEGER', 0, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
  activity_totals: [
    ['id', 'INTEGER', 0, 1],
    ['baseline_played_ms', 'INTEGER', 1, 0],
    ['live_played_ms', 'INTEGER', 1, 0],
    ['baseline_active_ms', 'INTEGER', 1, 0],
    ['live_active_ms', 'INTEGER', 1, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
  projection_state: [
    ['name', 'TEXT', 0, 1],
    ['version', 'INTEGER', 1, 0],
    ['last_session_id', 'INTEGER', 0, 0],
    ['visible_after_ms', 'INTEGER', 0, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
  playback_resume_state: [
    ['id', 'INTEGER', 0, 1],
    ['playback_group_uuid', 'TEXT', 1, 0],
    ['checkpoint_seq', 'INTEGER', 1, 0],
    ['source', 'TEXT', 1, 0],
    ['source_track_id', 'TEXT', 1, 0],
    ['list_id', 'TEXT', 0, 0],
    ['index_hint', 'INTEGER', 0, 0],
    ['position_ms', 'INTEGER', 1, 0],
    ['duration_ms', 'INTEGER', 0, 0],
    ['updated_at_ms', 'INTEGER', 1, 0],
  ],
}

const databases = []
let nextId = 0

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
})

const openDatabase = () => {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  databases.push(db)
  return db
}

const bootstrap = targetSchemaVersion => {
  const db = openDatabase()
  const result = bootstrapDatabaseSchema(db, migrations, { targetSchemaVersion, now: () => 1000 })
  return { db, result }
}

const insertTrack = (db, overrides = {}) => {
  const id = ++nextId
  const row = {
    source: 'test',
    sourceTrackId: `track-${id}`,
    name: `Track ${id}`,
    singer: 'Singer',
    durationMs: 180000,
    playablePayloadJson: '{"url":"https://example.test/audio"}',
    updatedAtMs: 1000,
    ...overrides,
  }
  return Number(db.prepare(`
    INSERT INTO track_snapshots (
      source, source_track_id, name, singer, duration_ms, playable_payload_json, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.source,
    row.sourceTrackId,
    row.name,
    row.singer,
    row.durationMs,
    row.playablePayloadJson,
    row.updatedAtMs,
  ).lastInsertRowid)
}

const insertSession = (db, trackId, overrides = {}) => {
  const id = ++nextId
  const row = {
    sessionUuid: `session-${id}`,
    playbackGroupUuid: `group-${id}`,
    segmentNo: 0,
    localDay: '2026-08-01',
    utcOffsetMinutes: 480,
    contextType: null,
    contextId: null,
    startReason: 'select',
    endReason: null,
    startedAtMs: 1000,
    endedAtMs: null,
    startPositionMs: 0,
    lastPositionMs: 0,
    durationMs: 180000,
    playedMs: 0,
    activeMs: 0,
    cumulativePlayedMs: 0,
    cumulativeActiveMs: 0,
    checkpointSeq: 0,
    state: 'playing',
    recentAllowed: 1,
    statsAllowed: 1,
    createdAtMs: 1000,
    ...overrides,
  }
  return Number(db.prepare(`
    INSERT INTO playback_sessions (
      session_uuid, playback_group_uuid, segment_no, track_id, local_day,
      utc_offset_minutes, context_type, context_id, start_reason, end_reason,
      started_at_ms, ended_at_ms, start_position_ms, last_position_ms, duration_ms,
      played_ms, active_ms, cumulative_played_ms, cumulative_active_ms,
      checkpoint_seq, state, recent_allowed, stats_allowed, created_at_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    row.sessionUuid,
    row.playbackGroupUuid,
    row.segmentNo,
    trackId,
    row.localDay,
    row.utcOffsetMinutes,
    row.contextType,
    row.contextId,
    row.startReason,
    row.endReason,
    row.startedAtMs,
    row.endedAtMs,
    row.startPositionMs,
    row.lastPositionMs,
    row.durationMs,
    row.playedMs,
    row.activeMs,
    row.cumulativePlayedMs,
    row.cumulativeActiveMs,
    row.checkpointSeq,
    row.state,
    row.recentAllowed,
    row.statsAllowed,
    row.createdAtMs,
  ).lastInsertRowid)
}

const insertEvent = (db, sessionId, sequenceNo, eventType, reason, overrides = {}) => db.prepare(`
  INSERT INTO playback_events (
    session_id, sequence_no, event_type, occurred_at_ms, position_ms, reason, details_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  sessionId,
  sequenceNo,
  eventType,
  overrides.occurredAtMs ?? 1000,
  overrides.positionMs ?? 0,
  reason,
  overrides.detailsJson ?? null,
)

const assertConstraint = action => assert.throws(action, /constraint/i)

describe('playback activity schema migration', () => {
  it('upgrades an authoritative v5 database to v6 exactly once', () => {
    const { db } = bootstrap(5)
    const upgrade = runMigrations(db, migrations, { now: () => 2000 })
    const ledgerAfterUpgrade = db.prepare('SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version').all()
    const rerun = runMigrations(db, migrations, { now: () => 3000 })

    assert.deepEqual(upgrade, { fromVersion: 5, toVersion: 6, applied: [6] })
    assert.equal(getSchemaVersion(db), 6)
    assert.equal(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '6')
    assert.equal(ledgerAfterUpgrade.at(-1).name, 'playback_activity')
    assert.deepEqual(rerun, { fromVersion: 6, toVersion: 6, applied: [] })
    assert.deepEqual(
      db.prepare('SELECT version, name, checksum, applied_at_ms FROM schema_migrations ORDER BY version').all(),
      ledgerAfterUpgrade,
    )
  })

  it('runs the fresh migration chain and installs all playback objects and seeds', () => {
    const { db, result } = bootstrap()

    assert.deepEqual(result, { fromVersion: 2, toVersion: 6, applied: [3, 4, 5, 6] })
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${PLAYBACK_TABLES.map(() => '?').join(', ')}) ORDER BY name`).all(...PLAYBACK_TABLES)
        .map(row => row.name),
      PLAYBACK_TABLES,
    )
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('playback_one_open_group', 'playback_retention', 'recent_tracks_order') ORDER BY name").all(),
      [
        { name: 'playback_one_open_group' },
        { name: 'playback_retention' },
        { name: 'recent_tracks_order' },
      ],
    )
    assert.deepEqual(db.prepare('SELECT * FROM activity_totals').all(), [{
      id: 1,
      baseline_played_ms: 0,
      live_played_ms: 0,
      baseline_active_ms: 0,
      live_active_ms: 0,
      updated_at_ms: 0,
    }])
    assert.deepEqual(db.prepare('SELECT * FROM projection_state ORDER BY name').all(), [
      { name: 'recent', version: 1, last_session_id: null, visible_after_ms: null, updated_at_ms: 0 },
      { name: 'statistics', version: 1, last_session_id: null, visible_after_ms: null, updated_at_ms: 0 },
    ])
  })

  it('installs the canonical columns, indexes, foreign keys, and structural contract', () => {
    const { db } = bootstrap()

    for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
      assert.deepEqual(
        db.pragma(`table_info(${table})`).map(({ name, type, notnull, pk }) => [name, type, notnull, pk]),
        expected,
        table,
      )
    }
    const indexShapes = table => db.pragma(`index_list(${table})`).map(index => ({
      columns: db.pragma(`index_info(${index.name})`).map(column => column.name),
      unique: index.unique,
      partial: index.partial,
    }))
    for (const [table, expected] of Object.entries({
      track_snapshots: [{ columns: ['source', 'source_track_id'], unique: 1, partial: 0 }],
      playback_sessions: [
        { columns: ['state', 'ended_at_ms', 'session_id'], unique: 0, partial: 0 },
        { columns: ['playback_group_uuid'], unique: 1, partial: 1 },
        { columns: ['playback_group_uuid', 'segment_no'], unique: 1, partial: 0 },
        { columns: ['session_uuid'], unique: 1, partial: 0 },
      ],
      playback_events: [{ columns: ['session_id', 'sequence_no'], unique: 1, partial: 0 }],
      recent_tracks: [
        { columns: ['recency_seq'], unique: 0, partial: 0 },
        { columns: ['recency_seq'], unique: 1, partial: 0 },
      ],
      listening_daily: [{ columns: ['local_day'], unique: 1, partial: 0 }],
      projection_state: [{ columns: ['name'], unique: 1, partial: 0 }],
    })) {
      const actual = indexShapes(table)
      for (const shape of expected) {
        assert.ok(actual.some(value => value.unique == shape.unique && value.partial == shape.partial &&
          JSON.stringify(value.columns) == JSON.stringify(shape.columns)), `${table}: ${JSON.stringify(shape)}`)
      }
    }
    assert.deepEqual(db.pragma('foreign_key_check'), [])
    assert.deepEqual(verifyDatabase(db, { runQuickCheck: true, runForeignKeyCheck: true }), { ok: true, diagnostics: [] })
  })

  it('enforces one open session per group and unique group segments', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db)
    const group = 'shared-group'
    insertSession(db, trackId, { playbackGroupUuid: group, segmentNo: 0 })

    assert.throws(
      () => insertSession(db, trackId, { playbackGroupUuid: group, segmentNo: 1, state: 'paused' }),
      /unique/i,
    )
    db.prepare(`
      UPDATE playback_sessions
      SET state = 'closed', ended_at_ms = 2000, end_reason = 'stop'
      WHERE playback_group_uuid = ?
    `).run(group)
    insertSession(db, trackId, { playbackGroupUuid: group, segmentNo: 1 })
    assert.throws(
      () => insertSession(db, trackId, {
        playbackGroupUuid: group,
        segmentNo: 1,
        state: 'closed',
        endedAtMs: 2000,
        endReason: 'stop',
      }),
      /unique/i,
    )
  })

  it('enforces every session reason and terminal state pairing', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db)
    const startReasons = ['select', 'next', 'previous', 'auto', 'restore', 'remote', 'day_boundary', 'statistics_clear']
    const endReasons = [
      'next', 'previous', 'select', 'dislike', 'stop', 'error', 'load_timeout',
      'buffer_timeout', 'queue_removed', 'natural_end', 'day_boundary', 'statistics_clear',
    ]

    for (const startReason of startReasons) insertSession(db, trackId, { startReason })
    for (const endReason of endReasons) {
      insertSession(db, trackId, { state: 'closed', endedAtMs: 2000, endReason })
    }
    insertSession(db, trackId, { state: 'paused' })
    insertSession(db, trackId, { state: 'interrupted', endedAtMs: 2000 })

    for (const overrides of [
      { startReason: 'unknown' },
      { state: 'unknown' },
      { state: 'playing', endedAtMs: 2000 },
      { state: 'paused', endReason: 'stop' },
      { state: 'closed', endedAtMs: 2000 },
      { state: 'closed', endedAtMs: 2000, endReason: 'unknown' },
      { state: 'interrupted', endedAtMs: 2000, endReason: 'error' },
      { state: 'interrupted' },
    ]) assertConstraint(() => insertSession(db, trackId, overrides))
  })

  it('enforces the event type and reason matrix', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db)
    const sessionId = insertSession(db, trackId)
    const accepted = {
      play_start: ['select', 'next', 'previous', 'auto', 'restore', 'remote', 'day_boundary', 'statistics_clear', null],
      pause: ['user', 'device', 'remote', 'recovery', null],
      resume: ['user', 'device', 'remote', 'recovery', null],
      seek: ['bar', 'hotkey', 'media_session', 'lyric', 'party', 'restore', 'buffer_recovery', null],
      skip: ['next', 'previous', 'select', 'dislike', 'stop', 'error', 'load_timeout', 'buffer_timeout', 'queue_removed', null],
      play_end: ['natural_end', null],
      error: [null],
    }
    let sequenceNo = 0
    for (const [eventType, reasons] of Object.entries(accepted)) {
      for (const reason of reasons) insertEvent(db, sessionId, sequenceNo++, eventType, reason)
    }

    for (const [eventType, reason] of [
      ['unknown', null],
      ['play_start', 'user'],
      ['pause', 'bar'],
      ['resume', 'select'],
      ['seek', 'next'],
      ['skip', 'natural_end'],
      ['play_end', 'stop'],
      ['error', 'error'],
    ]) assertConstraint(() => insertEvent(db, sessionId, sequenceNo++, eventType, reason))
    assert.throws(() => insertEvent(db, sessionId, 0, 'error', null), /unique/i)
  })

  it('enforces session, snapshot, and event numeric and payload constraints', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db, { sourceTrackId: 'duplicate-track' })

    for (const overrides of [
      { durationMs: -1 },
      { updatedAtMs: -1 },
      { playablePayloadJson: 'not-json' },
    ]) assertConstraint(() => insertTrack(db, overrides))
    assert.throws(
      () => insertTrack(db, { source: 'test', sourceTrackId: 'duplicate-track' }),
      /unique/i,
    )

    for (const overrides of [
      { segmentNo: -1 },
      { localDay: '2026-8-1' },
      { utcOffsetMinutes: -841 },
      { utcOffsetMinutes: 841 },
      { startedAtMs: -1 },
      { state: 'closed', endedAtMs: 999, endReason: 'stop' },
      { startPositionMs: -1 },
      { lastPositionMs: -1 },
      { durationMs: -1 },
      { playedMs: -1 },
      { activeMs: -1 },
      { cumulativePlayedMs: -1 },
      { cumulativeActiveMs: -1 },
      { playedMs: 2, cumulativePlayedMs: 1 },
      { activeMs: 2, cumulativeActiveMs: 1 },
      { checkpointSeq: -1 },
      { recentAllowed: 2 },
      { statsAllowed: -1 },
      { createdAtMs: -1 },
    ]) assertConstraint(() => insertSession(db, trackId, overrides))

    const sessionId = insertSession(db, trackId)
    for (const overrides of [
      { sequenceNo: -1, occurredAtMs: 0, positionMs: 0, detailsJson: null },
      { sequenceNo: 1000, occurredAtMs: -1, positionMs: 0, detailsJson: null },
      { sequenceNo: 1001, occurredAtMs: 0, positionMs: -1, detailsJson: null },
      { sequenceNo: 1002, occurredAtMs: 0, positionMs: 0, detailsJson: 'not-json' },
    ]) assertConstraint(() => insertEvent(db, sessionId, overrides.sequenceNo, 'error', null, overrides))
  })

  it('enforces projection, aggregate, recent, listening, and resume bounds', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db)

    const statements = [
      ['INSERT INTO activity_totals(id, updated_at_ms) VALUES(2, 0)', []],
      ['UPDATE activity_totals SET live_played_ms = -1 WHERE id = 1', []],
      ['INSERT INTO projection_state(name, version, updated_at_ms) VALUES(?, 1, 0)', ['unknown']],
      ['UPDATE projection_state SET version = 0 WHERE name = ?', ['recent']],
      ['UPDATE projection_state SET visible_after_ms = -1 WHERE name = ?', ['recent']],
      ['UPDATE projection_state SET updated_at_ms = -1 WHERE name = ?', ['recent']],
      ['INSERT INTO recent_tracks(track_id, recency_seq, last_played_at_ms, legacy_rank, updated_at_ms) VALUES(?, 1, -1, NULL, 0)', [trackId]],
      ['INSERT INTO recent_tracks(track_id, recency_seq, legacy_rank, updated_at_ms) VALUES(?, 1, 0, 0)', [trackId]],
      ['INSERT INTO listening_daily(local_day, live_played_ms, updated_at_ms) VALUES(?, -1, 0)', ['2026-08-01']],
      ['INSERT INTO listening_tracks(track_id, live_active_ms, updated_at_ms) VALUES(?, -1, 0)', [trackId]],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(2, 'group', 0, 'test', 'track', 0, 0, NULL, 0)`, []],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(1, 'group', -1, 'test', 'track', 0, 0, NULL, 0)`, []],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(1, 'group', 0, 'test', 'track', -1, 0, NULL, 0)`, []],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(1, 'group', 0, 'test', 'track', 1000001, 0, NULL, 0)`, []],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(1, 'group', 0, 'test', 'track', 0, -1, NULL, 0)`, []],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(1, 'group', 0, 'test', 'track', 0, 0, -1, 0)`, []],
      [`INSERT INTO playback_resume_state(
        id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
        position_ms, duration_ms, updated_at_ms
      ) VALUES(1, 'group', 0, 'test', 'track', 0, 0, NULL, -1)`, []],
    ]
    for (const [sql, params] of statements) assertConstraint(() => db.prepare(sql).run(...params))

    db.prepare('INSERT INTO recent_tracks(track_id, recency_seq, legacy_rank, updated_at_ms) VALUES(?, 1, 1, 0)').run(trackId)
    const secondTrack = insertTrack(db)
    assert.throws(
      () => db.prepare('INSERT INTO recent_tracks(track_id, recency_seq, legacy_rank, updated_at_ms) VALUES(?, 1, 520, 0)').run(secondTrack),
      /unique/i,
    )
    db.prepare(`INSERT INTO playback_resume_state(
      id, playback_group_uuid, checkpoint_seq, source, source_track_id, index_hint,
      position_ms, duration_ms, updated_at_ms
    ) VALUES(1, 'group', 0, 'test', 'track', 1000000, 0, NULL, 0)`).run()
    assertConstraint(() => db.prepare(`INSERT INTO playback_resume_state(
      id, playback_group_uuid, checkpoint_seq, source, source_track_id,
      position_ms, updated_at_ms
    ) VALUES(1, 'other', 0, 'test', 'other', 0, 0)`).run())
  })

  it('applies cascade, set-null, and restrictive foreign key actions', () => {
    const { db } = bootstrap()
    const retainedTrackId = insertTrack(db)
    const sessionId = insertSession(db, retainedTrackId, {
      state: 'closed',
      endedAtMs: 2000,
      endReason: 'stop',
    })
    insertEvent(db, sessionId, 0, 'error', null)
    db.prepare(`
      INSERT INTO recent_tracks(track_id, recency_seq, last_session_id, updated_at_ms)
      VALUES(?, 1, ?, 0)
    `).run(retainedTrackId, sessionId)
    db.prepare("UPDATE projection_state SET last_session_id = ? WHERE name = 'recent'").run(sessionId)

    assert.throws(() => db.prepare('DELETE FROM track_snapshots WHERE track_id = ?').run(retainedTrackId), /foreign key/i)
    db.prepare('DELETE FROM playback_sessions WHERE session_id = ?').run(sessionId)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playback_events').get().count, 0)
    assert.equal(db.prepare('SELECT last_session_id FROM recent_tracks WHERE track_id = ?').get(retainedTrackId).last_session_id, null)
    assert.equal(db.prepare("SELECT last_session_id FROM projection_state WHERE name = 'recent'").get().last_session_id, null)

    const cascadingTrackId = insertTrack(db)
    db.prepare('INSERT INTO recent_tracks(track_id, recency_seq, updated_at_ms) VALUES(?, 2, 0)').run(cascadingTrackId)
    db.prepare('INSERT INTO listening_tracks(track_id, updated_at_ms) VALUES(?, 0)').run(cascadingTrackId)
    db.prepare('DELETE FROM track_snapshots WHERE track_id = ?').run(cascadingTrackId)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recent_tracks WHERE track_id = ?').get(cascadingTrackId).count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_tracks WHERE track_id = ?').get(cascadingTrackId).count, 0)
    assertConstraint(() => insertSession(db, 999999))
    assert.deepEqual(db.pragma('foreign_key_check'), [])
  })

  it('rolls migration 6 back atomically when its body fails', () => {
    const { db } = bootstrap(5)
    const migration6 = migrations.find(migration => migration.version == 6)
    assert.ok(migration6)
    const failingRegistry = migrations.map(migration => migration.version == 6
      ? {
          ...migration,
          up(database) {
            migration.up(database)
            throw new Error('injected migration 6 failure')
          },
        }
      : migration)

    assert.throws(() => runMigrations(db, failingRegistry), /injected migration 6 failure/)
    assert.deepEqual(
      db.prepare('SELECT version FROM schema_migrations ORDER BY version').all(),
      [{ version: 3 }, { version: 4 }, { version: 5 }],
    )
    assert.equal(db.prepare("SELECT field_value FROM db_info WHERE field_name = 'version'").get().field_value, '5')
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${PLAYBACK_TABLES.map(() => '?').join(', ')})`).all(...PLAYBACK_TABLES),
      [],
    )
  })
})
