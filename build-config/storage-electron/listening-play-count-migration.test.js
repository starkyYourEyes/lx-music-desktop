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
const { migration8 } = require('../../src/main/worker/dbService/migrations/0008_listening_play_count.ts')
const { migrations } = require('../../src/main/worker/dbService/migrations/index.ts')
const { databaseSchema8Contract } = require('../../src/main/worker/dbService/schemaContract.ts')

const databases = []

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close()
  }
})

const createSchema7Projection = () => {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(`
    CREATE TABLE listening_tracks (
      track_id INTEGER PRIMARY KEY,
      baseline_played_ms INTEGER NOT NULL DEFAULT 0,
      live_played_ms INTEGER NOT NULL DEFAULT 0,
      baseline_active_ms INTEGER NOT NULL DEFAULT 0,
      live_active_ms INTEGER NOT NULL DEFAULT 0,
      last_played_at_ms INTEGER,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE playback_sessions (
      session_id INTEGER PRIMARY KEY,
      playback_group_uuid TEXT NOT NULL,
      segment_no INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      started_at_ms INTEGER NOT NULL,
      stats_allowed INTEGER NOT NULL
    );
    CREATE TABLE projection_state (
      name TEXT PRIMARY KEY,
      visible_after_ms INTEGER
    );
    INSERT INTO projection_state(name, visible_after_ms) VALUES('statistics', 100);
    INSERT INTO listening_tracks(track_id, baseline_played_ms, updated_at_ms)
      VALUES(1, 120000, 1000), (2, 60000, 1000);
    INSERT INTO playback_sessions(
      session_id, playback_group_uuid, segment_no, track_id, started_at_ms, stats_allowed
    ) VALUES
      (1, 'group-a', 0, 1, 100, 1),
      (2, 'group-a', 1, 1, 200, 1),
      (3, 'group-b', 0, 1, 300, 1),
      (4, 'group-before-cutoff', 0, 1, 99, 1),
      (5, 'group-disabled', 0, 1, 400, 0),
      (6, 'group-without-aggregate', 0, 3, 500, 1);
  `)
  return db
}

describe('listening play-count migration', () => {
  it('registers schema 8 after the protected cache-cleanup migration', () => {
    assert.equal(migration8.version, 8)
    assert.equal(migrations.at(-1), migration8)
    assert.equal(databaseSchema8Contract.tables.some(table => table.name == 'listening_tracks'), true)
  })

  it('backfills only retained visible original statistics-enabled playback groups', () => {
    const db = createSchema7Projection()

    migration8.up(db, { appliedAtMs: 9000 })

    assert.deepEqual(
      db.prepare('SELECT track_id, play_count FROM listening_tracks ORDER BY track_id').all(),
      [
        { track_id: 1, play_count: 2 },
        { track_id: 2, play_count: 0 },
        { track_id: 3, play_count: 1 },
      ],
    )
    assert.deepEqual(
      db.prepare(`
        SELECT baseline_played_ms, live_played_ms, baseline_active_ms, live_active_ms,
          last_played_at_ms, updated_at_ms
        FROM listening_tracks WHERE track_id = 3
      `).get(),
      {
        baseline_played_ms: 0,
        live_played_ms: 0,
        baseline_active_ms: 0,
        live_active_ms: 0,
        last_played_at_ms: 500,
        updated_at_ms: 500,
      },
    )
    assert.throws(
      () => db.prepare('UPDATE listening_tracks SET play_count = -1 WHERE track_id = 1').run(),
      /constraint/i,
    )
    assert.throws(
      () => db.prepare('UPDATE listening_tracks SET play_count = 1.5 WHERE track_id = 1').run(),
      /constraint/i,
    )
    assert.throws(
      () => db.prepare('UPDATE listening_tracks SET play_count = 9007199254740992 WHERE track_id = 1').run(),
      /constraint/i,
    )
  })

  it('treats a null statistics cutoff as fully visible retained history', () => {
    const db = createSchema7Projection()
    db.prepare("UPDATE projection_state SET visible_after_ms = NULL WHERE name = 'statistics'").run()

    migration8.up(db, { appliedAtMs: 9000 })

    assert.equal(
      db.prepare('SELECT play_count FROM listening_tracks WHERE track_id = 1').get().play_count,
      3,
    )
  })
})
