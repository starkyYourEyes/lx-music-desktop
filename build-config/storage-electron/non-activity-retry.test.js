const assert = require('node:assert/strict')
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

const dbService = require('../../src/main/worker/dbService/db.ts')
const repository = require('../../src/main/worker/dbService/modules/app_state/index.ts')
const { createAtomicJsonFile } = require('../../src/main/storage/atomicJsonFile.ts')
const { parseSettingsDocument } = require('../../src/main/storage/settings/document.ts')
const { migrateLegacyNonActivity } = require('../../src/main/migration/legacyData/nonActivity.ts')
const { readLegacyDataSource } = require('../../src/main/migration/legacyData/source.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const tempDirs = []

afterEach(() => {
  try { dbService.close() } catch {}
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

const validLegacy = {
  viewPrevState: { url: '/list', query: { id: 'one' } },
  listPosition: { one: 12 },
  listPrevSelectId: 'one',
  listUpdateInfo: {
    one: { updateTime: 10, isAutoUpdate: false, profile: { description: 'One' } },
    two: { updateTime: 20, isAutoUpdate: true, profile: { description: 'Two' } },
  },
  searchHistoryList: ['one', 'two', 'three'],
  leaderboardSetting: { source: 'kg', boardId: 'kg__1' },
  songListSetting: { source: 'tx', sortId: 'hot', tagId: '' },
  searchSetting: { temp_source: 'wy', source: 'mg', type: 'songlist' },
  playInfo: { id: 'outside-phase-2' },
  recentPlayList: [{ id: 'outside-phase-2' }],
  listeningTimeStats: { totalSeconds: 1 },
}

const createFixture = async() => {
  const fixture = createTestStorageRoot('lx-non-activity-retry')
  tempDirs.push(fixture)
  const root = fixture.path
  const profileRoot = path.join(root, 'profile')
  const legacyRoot = path.join(root, 'legacy')
  fs.mkdirSync(profileRoot)
  fs.mkdirSync(legacyRoot)
  const profileDataPath = path.join(profileRoot, 'data.json')
  fs.writeFileSync(profileDataPath, JSON.stringify(validLegacy))
  const configPath = path.join(profileRoot, 'config_v2.json')
  fs.writeFileSync(configPath, JSON.stringify({ version: '3.0.0', setting: { version: '3.0.0' } }))
  const result = await dbService.init({
    dataPath: profileRoot,
    cacheRoot: path.join(root, 'cache'),
    backupsRoot: path.join(root, 'backups'),
    previousShutdownWasClean: true,
    targetSchemaVersion: 6,
  })
  assert.equal(result.status, 'ready')
  const settingsFile = createAtomicJsonFile({
    filePath: configPath,
    validate(value) {
      try { parseSettingsDocument(value); return true } catch { return false }
    },
  })
  const runMigration = async(options = {}) => {
    const source = await readLegacyDataSource({ profileRoot, legacyRoot })
    assert.equal(source.status, 'available')
    return migrateLegacyNonActivity({
      source: source.snapshot,
      settingsPath: configPath,
      settingsDocument: parseSettingsDocument(JSON.parse(fs.readFileSync(configPath, 'utf8'))),
      settingsFile,
      repository,
      now: () => 1234,
      ...options,
    })
  }
  return { configPath, profileDataPath, runMigration, db: dbService.getDB() }
}

const countRows = (db, table) => db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
const readMarker = (db, name) => db.prepare(`
  SELECT name, source_sha256 AS sourceSha256, completed_at_ms AS completedAtMs, details_json AS detailsJson
  FROM migration_markers WHERE name = ?
`).get(name) ?? null

describe('legacy non-activity migration retries', () => {
  it('resumes after config replacement without duplicating database rows', async() => {
    const { db, runMigration } = await createFixture()

    await assert.rejects(runMigration({ failAt: 'after-config-replace' }), /injected failure/)
    assert.equal(readMarker(db, 'legacy_data_v1.catalog_preferences'), null)
    await runMigration()
    assert.equal(countRows(db, 'playlist_metadata'), 2)
    assert.equal(countRows(db, 'search_history'), 3)
    assert.ok(readMarker(db, 'legacy_data_v1.catalog_preferences'))
  })

  it('resumes every artifact boundary to one verified complete marker set', async() => {
    const failPoints = [
      'before-database-import',
      'after-database-import',
      'before-config-replace',
      'after-config-replace',
      'before-catalog-marker',
      'after-catalog-marker',
      'before-smoke-check',
      'after-smoke-check',
      'before-phase2-marker',
      'after-phase2-marker',
    ]

    for (const failAt of failPoints) {
      const { configPath, db, runMigration } = await createFixture()
      await assert.rejects(runMigration({ failAt }), /injected failure/)

      const outcome = await runMigration()

      assert.ok(['complete', 'already-complete'].includes(outcome.status), failAt)
      assert.deepEqual(outcome.databaseCounts, { localState: 3, playlistMetadata: 2, searchHistory: 3 })
      assert.equal(countRows(db, 'local_state'), 3)
      assert.equal(countRows(db, 'playlist_metadata'), 2)
      assert.equal(countRows(db, 'search_history'), 3)
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM migration_markers WHERE name LIKE 'legacy_data_v1.%'").get().count, 5)
      assert.ok(readMarker(db, 'legacy_data_v1.phase2_complete'))
      const settings = parseSettingsDocument(JSON.parse(fs.readFileSync(configPath, 'utf8')))
      assert.deepEqual(settings.catalogPreferences, {
        version: 1,
        leaderboard: validLegacy.leaderboardSetting,
        songList: validLegacy.songListSetting,
        search: validLegacy.searchSetting,
      })
      dbService.close()
    }
  })

  it('returns already-complete without changing rows or marker timestamps', async() => {
    const { db, runMigration } = await createFixture()
    await runMigration()
    const before = db.prepare('SELECT * FROM migration_markers ORDER BY name').all()

    const outcome = await runMigration()

    assert.equal(outcome.status, 'already-complete')
    assert.deepEqual(db.prepare('SELECT * FROM migration_markers ORDER BY name').all(), before)
  })

  it('retries after activity-only source changes without conflicting with the Phase 2 marker', async() => {
    const { db, profileDataPath, runMigration } = await createFixture()
    await runMigration()
    const before = db.prepare('SELECT * FROM migration_markers ORDER BY name').all()
    fs.writeFileSync(profileDataPath, JSON.stringify({
      ...validLegacy,
      playInfo: { id: 'changed' },
      recentPlayList: [{ id: 'changed' }],
      listeningTimeStats: { totalSeconds: 999 },
    }))

    const outcome = await runMigration()

    assert.equal(outcome.status, 'already-complete')
    assert.deepEqual(db.prepare('SELECT * FROM migration_markers ORDER BY name').all(), before)
  })
})
