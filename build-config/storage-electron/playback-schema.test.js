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
const {
  verifyDatabase,
  verifyDatabaseAgainstContract,
} = require('../../src/main/worker/dbService/verifyDB.ts')

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
const MAX_SAFE_INTEGER = 9007199254740991

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
    ['local_day', 'TEXT', 1, 1],
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
    ['name', 'TEXT', 1, 1],
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

const rebuildResumeState = (db, checkpointDefinition) => db.exec(`
  DROP TABLE playback_resume_state;
  CREATE TABLE playback_resume_state (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    playback_group_uuid TEXT NOT NULL,
    checkpoint_seq ${checkpointDefinition},
    source TEXT NOT NULL,
    source_track_id TEXT NOT NULL,
    list_id TEXT,
    index_hint INTEGER CHECK(index_hint IS NULL OR (
      typeof(index_hint) = 'integer' AND index_hint BETWEEN 0 AND 1000000
    )),
    position_ms INTEGER NOT NULL CHECK(
      typeof(position_ms) = 'integer' AND position_ms BETWEEN 0 AND 9007199254740991
    ),
    duration_ms INTEGER CHECK(duration_ms IS NULL OR (
      typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 9007199254740991
    )),
    updated_at_ms INTEGER NOT NULL CHECK(
      typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
    )
  );
`)

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

  it('rejects repeated null listening-day identities', () => {
    const { db } = bootstrap()
    const insertNullDay = () => db.prepare(`
      INSERT INTO listening_daily(local_day, updated_at_ms) VALUES(NULL, 0)
    `).run()

    assertConstraint(insertNullDay)
    assertConstraint(insertNullDay)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM listening_daily WHERE local_day IS NULL').get().count, 0)
    db.prepare("INSERT INTO listening_daily(local_day, updated_at_ms) VALUES('2026-08-01', 0)").run()
  })

  it('rejects repeated null projection identities', () => {
    const { db } = bootstrap()
    const insertNullProjection = () => db.prepare(`
      INSERT INTO projection_state(name, version, updated_at_ms) VALUES(NULL, 1, 0)
    `).run()

    assertConstraint(insertNullProjection)
    assertConstraint(insertNullProjection)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM projection_state WHERE name IS NULL').get().count, 0)
    assert.deepEqual(db.prepare('SELECT name FROM projection_state ORDER BY name').all(), [
      { name: 'recent' },
      { name: 'statistics' },
    ])
  })

  it('rejects a playback open-group index with the wrong partial predicate', () => {
    const { db } = bootstrap()
    db.exec(`
      DROP INDEX playback_one_open_group;
      CREATE UNIQUE INDEX playback_one_open_group
      ON playback_sessions(playback_group_uuid)
      WHERE state = 'playing';
    `)

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.index_where:playback_sessions.playback_one_open_group'],
    })
  })

  it('preserves quoted literal case when verifying partial predicates', () => {
    const { db } = bootstrap()
    db.exec(`
      DROP INDEX playback_one_open_group;
      CREATE UNIQUE INDEX playback_one_open_group
      ON playback_sessions(playback_group_uuid)
      WHERE state IN ('PLAYING','paused');
    `)

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.index_where:playback_sessions.playback_one_open_group'],
    })
  })

  it('rejects a canonical check weakened by a permissive alternative', () => {
    const { db } = bootstrap()
    rebuildResumeState(db, `INTEGER NOT NULL CHECK(
      (typeof(checkpoint_seq) = 'integer'
        AND checkpoint_seq BETWEEN 0 AND 9007199254740991)
      OR checkpoint_seq = 1.5
    )`)

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.check_missing:playback_resume_state.checkpoint_seq.integer'],
    })
  })

  it('ignores canonical check text that appears only in a SQL comment', () => {
    const { db } = bootstrap()
    rebuildResumeState(db, `INTEGER NOT NULL /* CHECK(
      typeof(checkpoint_seq) = 'integer' AND checkpoint_seq BETWEEN 0 AND 9007199254740991
    ) */`)

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.check_missing:playback_resume_state.checkpoint_seq.integer'],
    })
  })

  it('preserves quoted literal punctuation when verifying checks and partial predicates', () => {
    const db = openDatabase()
    db.exec(`
      CREATE TABLE literal_check(value TEXT CHECK(value IN ('a,b')));
      CREATE INDEX literal_partial ON literal_check(value) WHERE value = 'a,b';
    `)
    const contract = {
      tables: [{
        name: 'literal_check',
        columns: [{ name: 'value', type: 'TEXT', notNull: false, primaryKeyPosition: 0 }],
        indexes: [{
          name: 'literal_partial',
          columns: ['value'],
          unique: false,
          partial: true,
          where: "value = 'a, b'",
        }],
        foreignKeys: [],
        checks: [{ name: 'value.literal', expression: "value IN ('a, b')" }],
      }],
    }

    assert.deepEqual(verifyDatabaseAgainstContract(
      db,
      contract,
      { runQuickCheck: false, runForeignKeyCheck: false },
    ), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: [
        'schema.index_where:literal_check.literal_partial',
        'schema.check_missing:literal_check.value.literal',
      ],
    })
  })

  it('accepts a terminal backslash literal and resumes at the following check', () => {
    const db = openDatabase()
    db.exec(`
      CREATE TABLE backslash_check (
        value TEXT CHECK(value != '\\'),
        sequence INTEGER CHECK(sequence > 0)
      );
    `)
    const contract = {
      tables: [{
        name: 'backslash_check',
        columns: [
          { name: 'value', type: 'TEXT', notNull: false, primaryKeyPosition: 0 },
          { name: 'sequence', type: 'INTEGER', notNull: false, primaryKeyPosition: 0 },
        ],
        indexes: [],
        foreignKeys: [],
        checks: [
          { name: 'value.backslash', expression: "value != '\\'" },
          { name: 'sequence.positive', expression: 'sequence > 0' },
        ],
      }],
    }

    assert.deepEqual(verifyDatabaseAgainstContract(
      db,
      contract,
      { runQuickCheck: false, runForeignKeyCheck: false },
    ), { ok: true, diagnostics: [] })
  })

  it('rejects a playback table missing a critical integer check', () => {
    const { db } = bootstrap()
    db.exec(`
      DROP TABLE playback_resume_state;
      CREATE TABLE playback_resume_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        playback_group_uuid TEXT NOT NULL,
        checkpoint_seq INTEGER NOT NULL,
        source TEXT NOT NULL,
        source_track_id TEXT NOT NULL,
        list_id TEXT,
        index_hint INTEGER CHECK(index_hint IS NULL OR (
          typeof(index_hint) = 'integer' AND index_hint BETWEEN 0 AND 1000000
        )),
        position_ms INTEGER NOT NULL CHECK(
          typeof(position_ms) = 'integer' AND position_ms BETWEEN 0 AND 9007199254740991
        ),
        duration_ms INTEGER CHECK(duration_ms IS NULL OR (
          typeof(duration_ms) = 'integer' AND duration_ms BETWEEN 0 AND 9007199254740991
        )),
        updated_at_ms INTEGER NOT NULL CHECK(
          typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
        )
      );
    `)

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.check_missing:playback_resume_state.checkpoint_seq.integer'],
    })
  })

  it('rejects a playback column missing its canonical default', () => {
    const { db } = bootstrap()
    db.exec(`
      DROP TABLE activity_totals;
      CREATE TABLE activity_totals (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        baseline_played_ms INTEGER NOT NULL DEFAULT 0 CHECK(
          typeof(baseline_played_ms) = 'integer' AND baseline_played_ms BETWEEN 0 AND 9007199254740991
        ),
        live_played_ms INTEGER NOT NULL CHECK(
          typeof(live_played_ms) = 'integer' AND live_played_ms BETWEEN 0 AND 9007199254740991
        ),
        baseline_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
          typeof(baseline_active_ms) = 'integer' AND baseline_active_ms BETWEEN 0 AND 9007199254740991
        ),
        live_active_ms INTEGER NOT NULL DEFAULT 0 CHECK(
          typeof(live_active_ms) = 'integer' AND live_active_ms BETWEEN 0 AND 9007199254740991
        ),
        updated_at_ms INTEGER NOT NULL CHECK(
          typeof(updated_at_ms) = 'integer' AND updated_at_ms BETWEEN 0 AND 9007199254740991
        )
      );
      INSERT INTO activity_totals(
        id, baseline_played_ms, live_played_ms, baseline_active_ms, live_active_ms, updated_at_ms
      ) VALUES(1, 0, 0, 0, 0, 0);
    `)

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.column_default:activity_totals.live_played_ms'],
    })
  })

  it('rejects a playback schema missing a required projection seed', () => {
    const { db } = bootstrap()
    db.prepare("DELETE FROM projection_state WHERE name = 'recent'").run()

    assert.deepEqual(verifyDatabase(db, { runQuickCheck: false, runForeignKeyCheck: false }), {
      ok: false,
      reason: 'schema_invalid',
      diagnostics: ['schema.seed_missing:projection_state.recent'],
    })
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
      play_start: ['select', 'next', 'previous', 'auto', 'restore', 'remote', 'day_boundary', 'statistics_clear'],
      pause: ['user', 'device', 'remote', 'recovery'],
      resume: ['user', 'device', 'remote', 'recovery'],
      seek: ['bar', 'hotkey', 'media_session', 'lyric', 'party', 'restore', 'buffer_recovery'],
      skip: ['next', 'previous', 'select', 'dislike', 'stop', 'error', 'load_timeout', 'buffer_timeout', 'queue_removed'],
      play_end: ['natural_end'],
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
    for (const eventType of ['play_start', 'pause', 'resume', 'seek', 'skip', 'play_end']) {
      assertConstraint(() => insertEvent(db, sessionId, sequenceNo++, eventType, null))
    }
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

  it('supports signed recent sequences while retaining safe-integer bounds', () => {
    const { db } = bootstrap()
    const firstLegacyTrack = insertTrack(db)
    const lastLegacyTrack = insertTrack(db)
    const liveTrack = insertTrack(db)

    const insertRecent = db.prepare(`
      INSERT INTO recent_tracks(track_id, recency_seq, legacy_rank, updated_at_ms)
      VALUES(?, ?, ?, 0)
    `)
    insertRecent.run(firstLegacyTrack, -1, 1)
    insertRecent.run(lastLegacyTrack, -520, 520)
    insertRecent.run(liveTrack, 1, null)

    assert.deepEqual(
      db.prepare('SELECT recency_seq AS recencySeq, legacy_rank AS legacyRank FROM recent_tracks ORDER BY recency_seq DESC').all(),
      [
        { recencySeq: 1, legacyRank: null },
        { recencySeq: -1, legacyRank: 1 },
        { recencySeq: -520, legacyRank: 520 },
      ],
    )

    const belowSafeTrack = insertTrack(db)
    const aboveSafeTrack = insertTrack(db)
    assertConstraint(() => db.prepare(`
      INSERT INTO recent_tracks(track_id, recency_seq, updated_at_ms)
      VALUES(?, -9007199254740992, 0)
    `).run(belowSafeTrack))
    assertConstraint(() => db.prepare(`
      INSERT INTO recent_tracks(track_id, recency_seq, updated_at_ms)
      VALUES(?, 9007199254740992, 0)
    `).run(aboveSafeTrack))
  })

  it('rejects fractional values from every integer-semantic column category', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db)
    const sessionId = insertSession(db, trackId, {
      cumulativePlayedMs: 10,
      cumulativeActiveMs: 10,
    })
    const closedSessionId = insertSession(db, trackId, {
      state: 'closed',
      endedAtMs: 2000,
      endReason: 'stop',
    })
    insertEvent(db, sessionId, 0, 'error', null)
    db.prepare(`
      INSERT INTO recent_tracks(track_id, recency_seq, last_session_id, updated_at_ms)
      VALUES(?, 1, ?, 0)
    `).run(trackId, sessionId)
    db.prepare("INSERT INTO listening_daily(local_day, updated_at_ms) VALUES('2026-08-01', 0)").run()
    db.prepare('INSERT INTO listening_tracks(track_id, updated_at_ms) VALUES(?, 0)').run(trackId)
    db.prepare(`INSERT INTO playback_resume_state(
      id, playback_group_uuid, checkpoint_seq, source, source_track_id,
      index_hint, position_ms, duration_ms, updated_at_ms
    ) VALUES(1, 'group', 0, 'test', 'track', 0, 0, 0, 0)`).run()

    const updates = [
      ['track_snapshots.track_id', 'UPDATE track_snapshots SET track_id = 1.5 WHERE track_id = ?', [trackId]],
      ['track_snapshots.duration_ms', 'UPDATE track_snapshots SET duration_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['track_snapshots.updated_at_ms', 'UPDATE track_snapshots SET updated_at_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['playback_sessions.session_id', 'UPDATE playback_sessions SET session_id = 1.5 WHERE session_id = ?', [closedSessionId]],
      ['playback_sessions.segment_no', 'UPDATE playback_sessions SET segment_no = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.track_id', 'UPDATE playback_sessions SET track_id = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.utc_offset_minutes', 'UPDATE playback_sessions SET utc_offset_minutes = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.started_at_ms', 'UPDATE playback_sessions SET started_at_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.ended_at_ms', 'UPDATE playback_sessions SET ended_at_ms = 1500.5 WHERE session_id = ?', [closedSessionId]],
      ['playback_sessions.start_position_ms', 'UPDATE playback_sessions SET start_position_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.last_position_ms', 'UPDATE playback_sessions SET last_position_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.duration_ms', 'UPDATE playback_sessions SET duration_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.played_ms', 'UPDATE playback_sessions SET played_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.active_ms', 'UPDATE playback_sessions SET active_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.cumulative_played_ms', 'UPDATE playback_sessions SET cumulative_played_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.cumulative_active_ms', 'UPDATE playback_sessions SET cumulative_active_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.checkpoint_seq', 'UPDATE playback_sessions SET checkpoint_seq = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.recent_allowed', 'UPDATE playback_sessions SET recent_allowed = 0.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.stats_allowed', 'UPDATE playback_sessions SET stats_allowed = 0.5 WHERE session_id = ?', [sessionId]],
      ['playback_sessions.created_at_ms', 'UPDATE playback_sessions SET created_at_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_events.event_id', 'UPDATE playback_events SET event_id = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_events.session_id', 'UPDATE playback_events SET session_id = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_events.sequence_no', 'UPDATE playback_events SET sequence_no = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_events.occurred_at_ms', 'UPDATE playback_events SET occurred_at_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['playback_events.position_ms', 'UPDATE playback_events SET position_ms = 1.5 WHERE session_id = ?', [sessionId]],
      ['recent_tracks.track_id', 'UPDATE recent_tracks SET track_id = 1.5 WHERE track_id = ?', [trackId]],
      ['recent_tracks.recency_seq', 'UPDATE recent_tracks SET recency_seq = 1.5 WHERE track_id = ?', [trackId]],
      ['recent_tracks.last_session_id', 'UPDATE recent_tracks SET last_session_id = 1.5 WHERE track_id = ?', [trackId]],
      ['recent_tracks.last_played_at_ms', 'UPDATE recent_tracks SET last_played_at_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['recent_tracks.legacy_rank', 'UPDATE recent_tracks SET legacy_rank = 1.5 WHERE track_id = ?', [trackId]],
      ['recent_tracks.updated_at_ms', 'UPDATE recent_tracks SET updated_at_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_daily.baseline_played_ms', "UPDATE listening_daily SET baseline_played_ms = 1.5 WHERE local_day = '2026-08-01'", []],
      ['listening_daily.live_played_ms', "UPDATE listening_daily SET live_played_ms = 1.5 WHERE local_day = '2026-08-01'", []],
      ['listening_daily.baseline_active_ms', "UPDATE listening_daily SET baseline_active_ms = 1.5 WHERE local_day = '2026-08-01'", []],
      ['listening_daily.live_active_ms', "UPDATE listening_daily SET live_active_ms = 1.5 WHERE local_day = '2026-08-01'", []],
      ['listening_daily.updated_at_ms', "UPDATE listening_daily SET updated_at_ms = 1.5 WHERE local_day = '2026-08-01'", []],
      ['listening_tracks.track_id', 'UPDATE listening_tracks SET track_id = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_tracks.baseline_played_ms', 'UPDATE listening_tracks SET baseline_played_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_tracks.live_played_ms', 'UPDATE listening_tracks SET live_played_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_tracks.baseline_active_ms', 'UPDATE listening_tracks SET baseline_active_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_tracks.live_active_ms', 'UPDATE listening_tracks SET live_active_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_tracks.last_played_at_ms', 'UPDATE listening_tracks SET last_played_at_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['listening_tracks.updated_at_ms', 'UPDATE listening_tracks SET updated_at_ms = 1.5 WHERE track_id = ?', [trackId]],
      ['activity_totals.id', 'UPDATE activity_totals SET id = 1.5 WHERE id = 1', []],
      ['activity_totals.baseline_played_ms', 'UPDATE activity_totals SET baseline_played_ms = 1.5 WHERE id = 1', []],
      ['activity_totals.live_played_ms', 'UPDATE activity_totals SET live_played_ms = 1.5 WHERE id = 1', []],
      ['activity_totals.baseline_active_ms', 'UPDATE activity_totals SET baseline_active_ms = 1.5 WHERE id = 1', []],
      ['activity_totals.live_active_ms', 'UPDATE activity_totals SET live_active_ms = 1.5 WHERE id = 1', []],
      ['activity_totals.updated_at_ms', 'UPDATE activity_totals SET updated_at_ms = 1.5 WHERE id = 1', []],
      ['projection_state.version', "UPDATE projection_state SET version = 1.5 WHERE name = 'recent'", []],
      ['projection_state.last_session_id', "UPDATE projection_state SET last_session_id = 1.5 WHERE name = 'recent'", []],
      ['projection_state.visible_after_ms', "UPDATE projection_state SET visible_after_ms = 1.5 WHERE name = 'recent'", []],
      ['projection_state.updated_at_ms', "UPDATE projection_state SET updated_at_ms = 1.5 WHERE name = 'recent'", []],
      ['playback_resume_state.id', 'UPDATE playback_resume_state SET id = 1.5 WHERE id = 1', []],
      ['playback_resume_state.checkpoint_seq', 'UPDATE playback_resume_state SET checkpoint_seq = 1.5 WHERE id = 1', []],
      ['playback_resume_state.index_hint', 'UPDATE playback_resume_state SET index_hint = 1.5 WHERE id = 1', []],
      ['playback_resume_state.position_ms', 'UPDATE playback_resume_state SET position_ms = 1.5 WHERE id = 1', []],
      ['playback_resume_state.duration_ms', 'UPDATE playback_resume_state SET duration_ms = 1.5 WHERE id = 1', []],
      ['playback_resume_state.updated_at_ms', 'UPDATE playback_resume_state SET updated_at_ms = 1.5 WHERE id = 1', []],
    ]
    for (const [name, sql, params] of updates) {
      assert.throws(() => db.prepare(sql).run(...params), /constraint|datatype mismatch/i, name)
    }
  })

  it('accepts safe integer boundaries and nullable integer fields', () => {
    const { db } = bootstrap()
    const trackId = insertTrack(db, { durationMs: null, updatedAtMs: MAX_SAFE_INTEGER })
    const sessionId = insertSession(db, trackId, {
      segmentNo: MAX_SAFE_INTEGER,
      utcOffsetMinutes: -840,
      startedAtMs: 0,
      endedAtMs: MAX_SAFE_INTEGER,
      startPositionMs: MAX_SAFE_INTEGER,
      lastPositionMs: MAX_SAFE_INTEGER,
      durationMs: null,
      playedMs: MAX_SAFE_INTEGER,
      activeMs: MAX_SAFE_INTEGER,
      cumulativePlayedMs: MAX_SAFE_INTEGER,
      cumulativeActiveMs: MAX_SAFE_INTEGER,
      checkpointSeq: MAX_SAFE_INTEGER,
      state: 'closed',
      endReason: 'stop',
      createdAtMs: MAX_SAFE_INTEGER,
    })
    insertEvent(db, sessionId, MAX_SAFE_INTEGER, 'error', null, {
      occurredAtMs: MAX_SAFE_INTEGER,
      positionMs: MAX_SAFE_INTEGER,
    })
    db.prepare(`
      INSERT INTO recent_tracks(
        track_id, recency_seq, last_session_id, last_played_at_ms, legacy_rank, updated_at_ms
      ) VALUES(?, 0, NULL, NULL, NULL, ?)
    `).run(trackId, MAX_SAFE_INTEGER)
    db.prepare(`
      INSERT INTO listening_daily(
        local_day, baseline_played_ms, live_played_ms, baseline_active_ms, live_active_ms, updated_at_ms
      ) VALUES('2026-08-01', 0, ?, 0, ?, ?)
    `).run(MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
    db.prepare(`
      INSERT INTO listening_tracks(
        track_id, baseline_played_ms, live_played_ms, baseline_active_ms,
        live_active_ms, last_played_at_ms, updated_at_ms
      ) VALUES(?, 0, ?, 0, ?, NULL, ?)
    `).run(trackId, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
    db.prepare(`
      UPDATE activity_totals SET baseline_played_ms = 0, live_played_ms = ?,
        baseline_active_ms = 0, live_active_ms = ?, updated_at_ms = ? WHERE id = 1
    `).run(MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
    db.prepare(`
      UPDATE projection_state SET version = ?, last_session_id = NULL,
        visible_after_ms = NULL, updated_at_ms = ? WHERE name = 'recent'
    `).run(MAX_SAFE_INTEGER, MAX_SAFE_INTEGER)
    db.prepare(`INSERT INTO playback_resume_state(
      id, playback_group_uuid, checkpoint_seq, source, source_track_id,
      index_hint, position_ms, duration_ms, updated_at_ms
    ) VALUES(1, 'group', ?, 'test', 'track', NULL, ?, NULL, ?)`).run(
      MAX_SAFE_INTEGER,
      MAX_SAFE_INTEGER,
      MAX_SAFE_INTEGER,
    )
    db.prepare('UPDATE playback_resume_state SET index_hint = 0 WHERE id = 1').run()
    db.prepare('UPDATE playback_resume_state SET index_hint = 1000000 WHERE id = 1').run()

    assert.deepEqual(db.pragma('foreign_key_check'), [])
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
