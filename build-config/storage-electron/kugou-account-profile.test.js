const assert = require('node:assert/strict')
const fs = require('node:fs')
const { afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const Database = require('better-sqlite3')
const { migrations } = require('../../src/main/worker/dbService/migrations/index.ts')
const { runMigrations, getSchemaVersion } = require('../../src/main/worker/dbService/migrate.ts')
const { normalizePublicAccountProfile } = require('../../src/common/storage/accountProfile.ts')

const databases = []
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close()
})

const createSchema8Database = () => {
  const db = new Database(':memory:')
  databases.push(db)
  db.exec(`
    CREATE TABLE db_info (id INTEGER PRIMARY KEY, field_name TEXT, field_value TEXT);
    INSERT INTO db_info(id, field_name, field_value) VALUES (1, 'version', '8');
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL
    );
    CREATE TABLE account_profiles (
      provider TEXT PRIMARY KEY CHECK(provider IN ('netease', 'qq_music')),
      profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),
      updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
    );
  `)
  for (const migration of migrations.slice(0, 6)) {
    db.prepare('INSERT INTO schema_migrations(version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)')
      .run(migration.version, migration.name, migration.checksum, migration.version)
  }
  db.prepare('INSERT INTO account_profiles(provider, profile_json, updated_at_ms) VALUES (?, ?, ?)')
    .run('netease', '{"userId":1,"nickname":"N","avatarUrl":""}', 1)
  db.prepare('INSERT INTO account_profiles(provider, profile_json, updated_at_ms) VALUES (?, ?, ?)')
    .run('qq_music', '{"uin":"7","nickname":"Q"}', 2)
  return db
}

describe('Kugou account profile migration', () => {
  it('migrates schema 8 to 9 while preserving existing rows and accepting Kugou', () => {
    const db = createSchema8Database()
    const result = runMigrations(db, migrations, { targetSchemaVersion: 9, now: () => 9000 })

    assert.deepEqual(result, { fromVersion: 8, toVersion: 9, applied: [9] })
    assert.equal(getSchemaVersion(db), 9)
    assert.equal(db.prepare('SELECT profile_json FROM account_profiles WHERE provider = ?').get('netease').profile_json,
      '{"userId":1,"nickname":"N","avatarUrl":""}')
    assert.equal(db.prepare('SELECT profile_json FROM account_profiles WHERE provider = ?').get('qq_music').profile_json,
      '{"uin":"7","nickname":"Q"}')

    db.prepare('INSERT INTO account_profiles(provider, profile_json, updated_at_ms) VALUES (?, ?, ?)')
      .run('kugou', '{"userId":"42","nickname":"Kugou User","avatarUrl":""}', 3)
    assert.deepEqual(db.prepare('SELECT provider, profile_json AS profileJson, updated_at_ms AS updatedAtMs FROM account_profiles WHERE provider = ?').get('kugou'), {
      provider: 'kugou', profileJson: '{"userId":"42","nickname":"Kugou User","avatarUrl":""}', updatedAtMs: 3,
    })
    assert.throws(() => normalizePublicAccountProfile('kugou', {
      userId: '42', nickname: 'K', avatarUrl: '', token: 'secret',
    }), /public account profile|token/i)
    assert.throws(() => db.prepare('INSERT INTO account_profiles(provider, profile_json, updated_at_ms) VALUES (?, ?, ?)').run('unsupported', '{}', 1), /constraint/i)
  })
})
