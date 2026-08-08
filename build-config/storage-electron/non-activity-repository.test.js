const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
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
const dbService = require('../../src/main/worker/dbService/db.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const tempDirs = []

afterEach(() => {
  try {
    dbService.close()
  } catch {}
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

const createStore = async(prefix = 'lx-non-activity-') => {
  const fixture = createTestStorageRoot(prefix)
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
  return { root, result, db: dbService.getAppDB() }
}

const getRepository = () => require('../../src/main/worker/dbService/modules/app_state/index.ts')

const localState = {
  version: 1,
  viewPrevState: { url: '/list', query: { id: 'one' } },
  listScrollPosition: { one: 12, two: 24 },
  listPrevSelectId: 'one',
}

const playlistMetadata = {
  one: {
    updateTime: 10,
    isAutoUpdate: false,
    profile: { description: 'One', createdAt: 1 },
  },
  two: {
    updateTime: 20,
    isAutoUpdate: true,
    profile: { coverUrl: 'https://example.test/two.png' },
  },
}

const groupedProfile = { description: 'kept', group: 'external' }

const marker = (name, source = 'a', completedAtMs = 100) => ({
  name,
  sourceSha256: source.repeat(64),
  completedAtMs,
  detailsJson: '{"version":1}',
})

const legacyImport = (overrides = {}) => ({
  localState,
  playlistMetadata,
  searchHistory: ['A', 'a', 'A', ...Array.from({ length: 20 }, (_, index) => `q${index}`)],
  markers: {
    localState: marker('legacy_data_v1.local_state', 'a'),
    playlistMetadata: marker('legacy_data_v1.playlist_metadata', 'b'),
    searchHistory: marker('legacy_data_v1.search_history', 'c'),
  },
  ...overrides,
})

describe('authoritative non-activity storage', () => {
  it('bootstraps schema 6 with constrained application-state tables', async() => {
    const { result, db } = await createStore()

    assert.equal(result.schemaVersion, 6)
    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('local_state', 'playlist_metadata', 'search_history') ORDER BY name").all(),
      [{ name: 'local_state' }, { name: 'playlist_metadata' }, { name: 'search_history' }],
    )
    assert.deepEqual(
      db.pragma('table_info(local_state)').map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk })),
      [
        { name: 'key', type: 'TEXT', notnull: 0, pk: 1 },
        { name: 'version', type: 'INTEGER', notnull: 1, pk: 0 },
        { name: 'value_json', type: 'TEXT', notnull: 1, pk: 0 },
        { name: 'updated_at_ms', type: 'INTEGER', notnull: 1, pk: 0 },
      ],
    )
    assert.throws(
      () => db.prepare('INSERT INTO local_state (key, version, value_json, updated_at_ms) VALUES (?, ?, ?, ?)')
        .run('unknown', 1, '{}', 0),
      /constraint/i,
    )
    assert.throws(
      () => db.prepare('INSERT INTO playlist_metadata (playlist_id, is_auto_update, update_time_ms, profile_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)')
        .run('one', 2, 0, null, 0),
      /constraint/i,
    )
    assert.throws(
      () => db.prepare('INSERT INTO search_history (term, recency_seq, last_used_at_ms, use_count) VALUES (?, ?, ?, ?)')
        .run('term', 1, null, 0),
      /constraint/i,
    )
  })

  it('keeps every Phase 2 target empty before legacy import preflight', async() => {
    const { db } = await createStore()

    assert.deepEqual({
      localState: db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count,
      playlistMetadata: db.prepare('SELECT COUNT(*) AS count FROM playlist_metadata').get().count,
      searchHistory: db.prepare('SELECT COUNT(*) AS count FROM search_history').get().count,
      markers: db.prepare("SELECT COUNT(*) AS count FROM migration_markers WHERE name LIKE 'legacy_data_v1.%'").get().count,
    }, {
      localState: 0,
      playlistMetadata: 0,
      searchHistory: 0,
      markers: 0,
    })
  })

  it('returns validated defaults from a fresh authoritative store', async() => {
    const { db } = await createStore()
    const repository = getRepository()

    const result = repository.getLocalState()
    assert.deepEqual(result, {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    })
    result.viewPrevState.query.mutated = true
    result.listScrollPosition.mutated = 1
    assert.deepEqual(repository.getLocalState(), {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    })
    assert.deepEqual(db.prepare('SELECT key FROM local_state').all(), [])
  })

  it('sets one local-state key in a fresh store and returns default siblings', async() => {
    const { db } = await createStore()
    const repository = getRepository()

    assert.deepEqual(repository.setLocalState({
      version: 1,
      key: 'list_scroll_positions',
      value: { fresh: 8 },
      updatedAtMs: 25,
    }), {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: { fresh: 8 },
      listPrevSelectId: 'default',
    })
    assert.deepEqual(
      db.prepare('SELECT key, updated_at_ms FROM local_state').all(),
      [{ key: 'list_scroll_positions', updated_at_ms: 25 }],
    )
  })

  it('resets clear local state to defaults and remains writable', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    repository.importLegacyNonActivity(legacyImport())

    repository.clearLocalState()
    assert.deepEqual(repository.getLocalState(), {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    })
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count, 0)
    assert.deepEqual(repository.setLocalState({
      version: 1,
      key: 'list_prev_select_id',
      value: 'fresh-list',
      updatedAtMs: 30,
    }), {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'fresh-list',
    })
    assert.deepEqual(
      db.prepare('SELECT key, updated_at_ms FROM local_state').all(),
      [{ key: 'list_prev_select_id', updated_at_ms: 30 }],
    )
  })

  it('imports all three domains and markers atomically with unknown timestamps', async() => {
    const { db } = await createStore()
    const repository = getRepository()

    const result = repository.importLegacyNonActivity(legacyImport())

    assert.deepEqual(result.localState, localState)
    assert.deepEqual(result.playlistMetadata, playlistMetadata)
    assert.deepEqual(result.searchHistory, ['A', 'a', ...Array.from({ length: 13 }, (_, index) => `q${index}`)])
    assert.deepEqual(repository.getSearchHistory(), result.searchHistory)
    assert.deepEqual(
      db.prepare('SELECT key, updated_at_ms FROM local_state ORDER BY key').all(),
      [
        { key: 'list_prev_select_id', updated_at_ms: 0 },
        { key: 'list_scroll_positions', updated_at_ms: 0 },
        { key: 'view_prev_state', updated_at_ms: 0 },
      ],
    )
    assert.deepEqual(
      db.prepare('SELECT playlist_id, updated_at_ms FROM playlist_metadata ORDER BY playlist_id').all(),
      [
        { playlist_id: 'one', updated_at_ms: 0 },
        { playlist_id: 'two', updated_at_ms: 0 },
      ],
    )
    assert.deepEqual(
      db.prepare("SELECT term, recency_seq, last_used_at_ms, use_count FROM search_history WHERE term IN ('A', 'a') ORDER BY recency_seq DESC").all(),
      [
        { term: 'A', recency_seq: 15, last_used_at_ms: null, use_count: 1 },
        { term: 'a', recency_seq: 14, last_used_at_ms: null, use_count: 1 },
      ],
    )
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_markers').get().count, 3)

    result.localState.viewPrevState.query.id = 'mutated'
    result.playlistMetadata.two.profile.coverUrl = 'mutated'
    result.searchHistory[0] = 'mutated'
    assert.deepEqual(repository.getLocalState(), localState)
    assert.deepEqual(repository.getPlaylistMetadata(), playlistMetadata)
    assert.equal(repository.getSearchHistory()[0], 'A')
  })

  it('preserves newer authoritative values on a same-hash replay', async() => {
    await createStore()
    const repository = getRepository()
    const input = legacyImport()
    repository.importLegacyNonActivity(input)
    const currentLocalState = repository.setLocalState({
      version: 1,
      key: 'list_prev_select_id',
      value: 'runtime-list',
      updatedAtMs: 500,
    })
    const currentPlaylistMetadata = repository.applyPlaylistMetadata({
      version: 1,
      action: 'upsert',
      playlistId: 'runtime-list',
      value: { updateTime: 500, isAutoUpdate: false },
      updatedAtMs: 500,
    })
    const currentSearchHistory = repository.applySearchHistory({
      version: 1,
      action: 'record',
      term: 'runtime-term',
      usedAtMs: 500,
    })

    assert.deepEqual(repository.importLegacyNonActivity(input), {
      localState: currentLocalState,
      playlistMetadata: currentPlaylistMetadata,
      searchHistory: currentSearchHistory,
    })
  })

  it('preflights second and third marker conflicts before any target write', async() => {
    const conflicts = [
      marker('legacy_data_v1.playlist_metadata', 'f'),
      marker('legacy_data_v1.search_history', 'f'),
    ]
    for (const conflict of conflicts) {
      const { db } = await createStore(`lx-non-activity-conflict-${conflict.name.split('.').at(-1)}-`)
      const repository = getRepository()
      repository.completeNonActivityMigrationMarker(conflict)

      assert.throws(() => repository.importLegacyNonActivity(legacyImport()), /source conflict/i)
      assert.deepEqual(repository.getLocalState(), {
        version: 1,
        viewPrevState: { url: '/search', query: {} },
        listScrollPosition: {},
        listPrevSelectId: 'default',
      })
      assert.deepEqual(repository.getPlaylistMetadata(), {})
      assert.deepEqual(repository.getSearchHistory(), [])
      assert.deepEqual(
        db.prepare('SELECT name, source_sha256 FROM migration_markers').all(),
        [{ name: conflict.name, source_sha256: conflict.sourceSha256 }],
      )
      dbService.close()
    }
  })

  it('rolls back earlier target writes and markers when readback verification fails', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    db.exec(`
      CREATE TRIGGER corrupt_search_history_readback
      AFTER INSERT ON search_history
      BEGIN
        UPDATE search_history SET term = 'corrupt:' || term WHERE term = NEW.term;
      END;
    `)

    assert.throws(() => repository.importLegacyNonActivity(legacyImport()), /search history import readback/i)
    assert.deepEqual(repository.getLocalState(), {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    })
    assert.deepEqual(repository.getPlaylistMetadata(), {})
    assert.deepEqual(repository.getSearchHistory(), [])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_markers').get().count, 0)
  })

  it('returns authoritative post-write values for local, playlist, and search commands', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    repository.importLegacyNonActivity(legacyImport())

    assert.deepEqual(repository.setLocalState({
      version: 1,
      key: 'list_scroll_positions',
      value: { two: 99 },
      updatedAtMs: 500,
    }), {
      ...localState,
      listScrollPosition: { two: 99 },
    })
    assert.equal(
      db.prepare("SELECT updated_at_ms FROM local_state WHERE key = 'list_scroll_positions'").get().updated_at_ms,
      500,
    )

    const afterRemove = repository.applyPlaylistMetadata({ version: 1, action: 'remove', playlistId: 'one' })
    assert.deepEqual(afterRemove, { two: playlistMetadata.two })
    assert.equal(afterRemove.two.isAutoUpdate, true)
    assert.deepEqual(repository.applyPlaylistMetadata({
      version: 1,
      action: 'upsert',
      playlistId: 'three',
      value: { updateTime: 30, isAutoUpdate: false },
      updatedAtMs: 600,
    }), {
      two: playlistMetadata.two,
      three: { updateTime: 30, isAutoUpdate: false },
    })

    const afterRecord = repository.applySearchHistory({ version: 1, action: 'record', term: 'A', usedAtMs: 700 })
    assert.equal(afterRecord[0], 'A')
    assert.equal(afterRecord.length, 15)
    assert.deepEqual(
      db.prepare("SELECT last_used_at_ms, use_count FROM search_history WHERE term = 'A'").get(),
      { last_used_at_ms: 700, use_count: 2 },
    )
    assert.deepEqual(
      repository.applySearchHistory({ version: 1, action: 'remove', term: 'a' }),
      afterRecord.filter(term => term != 'a'),
    )
  })

  it('persists a grouped profile through reload and removes it when retain omits its playlist', async() => {
    const { root } = await createStore()
    const repository = getRepository()
    repository.applyPlaylistMetadata({
      version: 1,
      action: 'upsert',
      playlistId: 'grouped',
      value: { updateTime: 1, isAutoUpdate: false, profile: groupedProfile },
      updatedAtMs: 1,
    })

    dbService.close()
    const result = await dbService.init({
      dataPath: root,
      cacheRoot: path.join(root, 'cache'),
      backupsRoot: path.join(root, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    assert.equal(result.status, 'ready')

    assert.deepEqual(getRepository().getPlaylistMetadata().grouped.profile, groupedProfile)
    assert.deepEqual(repository.applyPlaylistMetadata({
      version: 1,
      action: 'retain',
      playlistIds: ['grouped'],
    }).grouped.profile, groupedProfile)
    assert.deepEqual(repository.applyPlaylistMetadata({
      version: 1,
      action: 'retain',
      playlistIds: [],
    }), {})
  })

  it('enforces the 10000-row playlist metadata limit without blocking updates', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    const fullMetadata = Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => [
      `list-${index}`,
      { updateTime: index, isAutoUpdate: false },
    ]))
    repository.importLegacyNonActivity(legacyImport({ playlistMetadata: fullMetadata }))

    const updated = repository.applyPlaylistMetadata({
      version: 1,
      action: 'upsert',
      playlistId: 'list-0',
      value: { updateTime: 20_000, isAutoUpdate: true },
      updatedAtMs: 50,
    })
    assert.equal(Object.keys(updated).length, 10_000)
    assert.deepEqual(updated['list-0'], { updateTime: 20_000, isAutoUpdate: true })

    assert.throws(() => repository.applyPlaylistMetadata({
      version: 1,
      action: 'upsert',
      playlistId: 'list-overflow',
      value: { updateTime: 1, isAutoUpdate: false },
      updatedAtMs: 50,
    }), /playlist metadata limit/i)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playlist_metadata').get().count, 10_000)

    db.prepare(`
      INSERT INTO playlist_metadata (
        playlist_id, is_auto_update, update_time_ms, profile_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?)
    `).run('direct-overflow', 0, 1, null, 0)
    assert.throws(() => repository.getPlaylistMetadata(), /playlist metadata limit/i)
  })

  it('validates every import input before writing any domain or marker', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    const invalid = legacyImport({
      markers: {
        ...legacyImport().markers,
        searchHistory: marker('legacy_data_v1.catalog_preferences', 'c'),
      },
    })

    assert.throws(() => repository.importLegacyNonActivity(invalid), /search history marker/i)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM local_state').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM playlist_metadata').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM search_history').get().count, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_markers').get().count, 0)
  })

  it('validates search import terms after the retained history is full', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    const searchHistory = [...Array.from({ length: 15 }, (_, index) => `valid-${index}`), 42]

    assert.throws(() => repository.importLegacyNonActivity(legacyImport({ searchHistory })), /term/i)
    assert.deepEqual(repository.getLocalState(), {
      version: 1,
      viewPrevState: { url: '/search', query: {} },
      listScrollPosition: {},
      listPrevSelectId: 'default',
    })
    assert.deepEqual(repository.getPlaylistMetadata(), {})
    assert.deepEqual(repository.getSearchHistory(), [])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM migration_markers').get().count, 0)
  })

  it('restricts marker RPCs to the five non-activity migration names', async() => {
    await createStore()
    const repository = getRepository()
    const allowed = [
      'legacy_data_v1.local_state',
      'legacy_data_v1.playlist_metadata',
      'legacy_data_v1.search_history',
      'legacy_data_v1.catalog_preferences',
      'legacy_data_v1.phase2_complete',
    ]

    for (const name of allowed) assert.equal(repository.getNonActivityMigrationMarker(name), null)
    const completion = marker('legacy_data_v1.phase2_complete', 'f', 900)
    repository.completeNonActivityMigrationMarker(completion)
    assert.deepEqual(repository.getNonActivityMigrationMarker(completion.name), completion)
    assert.throws(() => repository.getNonActivityMigrationMarker('legacy_data_v1.account_profiles'), /marker name/i)
    assert.throws(
      () => repository.completeNonActivityMigrationMarker(marker('arbitrary.renderer.marker')),
      /marker name/i,
    )
  })

  it('enforces non-negative safe-integer timestamps in schema 6', async() => {
    const { db } = await createStore()

    for (const value of ['-1', '1.5', '9007199254740992']) {
      assert.throws(
        () => db.exec(`
          INSERT INTO local_state (key, version, value_json, updated_at_ms)
          VALUES ('view_prev_state', 1, '{}', ${value})
        `),
        /constraint/i,
      )
      assert.throws(
        () => db.exec(`
          INSERT INTO playlist_metadata (
            playlist_id, is_auto_update, update_time_ms, profile_json, updated_at_ms
          ) VALUES ('update-${value}', 0, ${value}, NULL, 0)
        `),
        /constraint/i,
      )
      assert.throws(
        () => db.exec(`
          INSERT INTO playlist_metadata (
            playlist_id, is_auto_update, update_time_ms, profile_json, updated_at_ms
          ) VALUES ('write-${value}', 0, 0, NULL, ${value})
        `),
        /constraint/i,
      )
      assert.throws(
        () => db.exec(`
          INSERT INTO search_history (term, recency_seq, last_used_at_ms, use_count)
          VALUES ('search-${value}', ${value == '-1' ? 1 : value == '1.5' ? 2 : 3}, ${value}, 1)
        `),
        /constraint/i,
      )
    }
    db.exec(`
      INSERT INTO search_history (term, recency_seq, last_used_at_ms, use_count)
      VALUES ('unknown-time', 4, NULL, 1)
    `)
    assert.equal(db.prepare("SELECT last_used_at_ms FROM search_history WHERE term = 'unknown-time'").get().last_used_at_ms, null)
  })

  it('rejects malformed authoritative rows that are looser than the SQL checks', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    repository.importLegacyNonActivity(legacyImport())

    db.pragma('ignore_check_constraints = ON')
    db.prepare("UPDATE local_state SET updated_at_ms = 1.5 WHERE key = 'view_prev_state'").run()
    assert.throws(() => repository.getLocalState(), /local state row/i)
    db.prepare("UPDATE local_state SET updated_at_ms = 0 WHERE key = 'view_prev_state'").run()

    db.prepare("UPDATE search_history SET last_used_at_ms = 1.5 WHERE term = 'A'").run()
    assert.throws(() => repository.getSearchHistory(), /search history row/i)
  })

  it('detects structural damage to a schema 6 application-state table', async() => {
    const { root } = await createStore('lx-non-activity-damage-')
    const databasePath = path.join(root, 'lx.data.db')
    dbService.close()
    const db = new Database(databasePath)
    db.exec('ALTER TABLE local_state RENAME COLUMN value_json TO payload_json')
    db.close()

    const result = await dbService.init({
      dataPath: root,
      cacheRoot: path.join(root, 'cache'),
      backupsRoot: path.join(root, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'schema_invalid')
    assert.equal(result.diagnostics.includes('schema.column_missing:local_state.value_json'), true)
  })
})
