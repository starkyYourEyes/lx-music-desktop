const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
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

const tempDirs = []

afterEach(() => {
  try {
    dbService.close()
  } catch {}
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const createStore = async(prefix = 'lx-non-activity-') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(root)
  const result = await dbService.init({
    dataPath: root,
    backupDir: path.join(root, 'backups'),
    previousShutdownWasClean: true,
  })
  assert.equal(result.status, 'ready')
  return { root, result, db: dbService.getDB() }
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
  it('bootstraps schema 5 with constrained application-state tables', async() => {
    const { result, db } = await createStore()

    assert.equal(result.schemaVersion, 5)
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

  it('rejects malformed authoritative rows that are looser than the SQL checks', async() => {
    const { db } = await createStore()
    const repository = getRepository()
    repository.importLegacyNonActivity(legacyImport())

    db.prepare("UPDATE local_state SET updated_at_ms = 1.5 WHERE key = 'view_prev_state'").run()
    assert.throws(() => repository.getLocalState(), /local state row/i)
    db.prepare("UPDATE local_state SET updated_at_ms = 0 WHERE key = 'view_prev_state'").run()

    db.prepare("UPDATE search_history SET last_used_at_ms = 1.5 WHERE term = 'A'").run()
    assert.throws(() => repository.getSearchHistory(), /search history row/i)
  })

  it('detects structural damage to a schema 5 application-state table', async() => {
    const { root } = await createStore('lx-non-activity-damage-')
    const databasePath = path.join(root, 'lx.data.db')
    dbService.close()
    const db = new Database(databasePath)
    db.exec('ALTER TABLE local_state RENAME COLUMN value_json TO payload_json')
    db.close()

    const result = await dbService.init({
      dataPath: root,
      backupDir: path.join(root, 'backups'),
      previousShutdownWasClean: true,
    })

    assert.equal(result.status, 'recovery')
    assert.equal(result.reason, 'schema_invalid')
    assert.equal(result.diagnostics.includes('schema.column_missing:local_state.value_json'), true)
  })
})
