const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
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

const dbService = require('../../src/main/worker/dbService/db.ts')
const { getSchemaVersion } = require('../../src/main/worker/dbService/migrate.ts')
const repo = require('../../src/main/worker/dbService/modules/account_profile/index.ts')
const { createTestStorageRoot } = require('../storage/helpers/test-storage-root.js')

const tempDirs = []

afterEach(() => {
  try {
    dbService.close()
  } catch {}
  for (const fixture of tempDirs.splice(0)) fixture.cleanup()
})

describe('account profile storage', () => {
  it('bootstraps schema 6 and accepts only public provider profiles', async() => {
    const fixture = createTestStorageRoot('lx-account-profile')
    tempDirs.push(fixture)
    const profileRoot = fixture.path
    const result = await dbService.init({
      dataPath: profileRoot,
      cacheRoot: path.join(profileRoot, 'cache'),
      backupsRoot: path.join(profileRoot, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })

    assert.equal(result.status, 'ready')
    assert.equal(result.schemaVersion, 6)
    assert.deepEqual(result.migratedVersions, [])
    assert.equal(getSchemaVersion(dbService.getDB()), 6)

    repo.upsertAccountProfile({
      provider: 'qq_music',
      profileJson: '{"uin":"7","nickname":"Q"}',
      updatedAtMs: 1,
    })
    assert.deepEqual(repo.getAccountProfile('qq_music'), {
      provider: 'qq_music',
      profileJson: '{"uin":"7","nickname":"Q"}',
      updatedAtMs: 1,
    })
    assert.throws(
      () => repo.upsertAccountProfile({ provider: 'qq', profileJson: '{}', updatedAtMs: 1 }),
      /provider|constraint/i,
    )
    assert.throws(
      () => repo.upsertAccountProfile({
        provider: 'netease',
        profileJson: '{"nested":{"cookie":"COOKIE_SENTINEL"}}',
        updatedAtMs: 1,
      }),
      /public account profile/i,
    )

    const directInsert = dbService.getDB().prepare(`
      INSERT INTO account_profiles (provider, profile_json, updated_at_ms)
      VALUES (?, ?, ?)
    `)
    assert.throws(() => directInsert.run('netease', 'not-json', 1), /constraint/i)
    assert.throws(() => directInsert.run('netease', '{}', -1), /constraint/i)
    directInsert.run('netease', '{"password":"PASSWORD_SENTINEL"}', 1)
    assert.throws(() => repo.getAccountProfile('netease'), /public account profile/i)
    repo.removeAccountProfile('netease')
    directInsert.run('netease', '{"userId":1,"nickname":"N","avatarUrl":"","opaque":"COOKIE_SENTINEL"}', 1)
    assert.throws(() => repo.getAccountProfile('netease'), /public account profile/i)
    repo.removeAccountProfile('netease')
    directInsert.run('netease', '{"userId":1,"nickname":"N","avatarUrl":""}', 1.5)
    assert.throws(() => repo.getAccountProfile('netease'), /timestamp/i)

    repo.removeAccountProfile('qq_music')
    assert.equal(repo.getAccountProfile('qq_music'), null)
  })

  it('commits legacy profiles and their marker atomically and skips a committed replay', async() => {
    const fixture = createTestStorageRoot('lx-account-profile-migration')
    tempDirs.push(fixture)
    const profileRoot = fixture.path
    await dbService.init({
      dataPath: profileRoot,
      cacheRoot: path.join(profileRoot, 'cache'),
      backupsRoot: path.join(profileRoot, 'backups'),
      previousShutdownWasClean: true,
      targetSchemaVersion: 6,
    })
    const marker = {
      name: 'legacy_data_v1.account_profiles',
      sourceSha256: 'a'.repeat(64),
      completedAtMs: 100,
      detailsJson: '{"version":1,"profileCount":1}',
    }
    const legacyRow = {
      provider: 'netease',
      profileJson: '{"avatarUrl":"","nickname":"Legacy","userId":1}',
      updatedAtMs: 10,
    }

    repo.migrateLegacyAccountProfiles({ rows: [legacyRow], marker })
    assert.deepEqual(repo.getAccountProfile('netease'), legacyRow)
    assert.equal(dbService.getDB().prepare('SELECT COUNT(*) AS count FROM migration_markers WHERE name = ?').get(marker.name).count, 1)

    const refreshedRow = {
      provider: 'netease',
      profileJson: '{"avatarUrl":"","nickname":"Refreshed","userId":1}',
      updatedAtMs: 20,
    }
    repo.upsertAccountProfile(refreshedRow)
    repo.migrateLegacyAccountProfiles({ rows: [legacyRow], marker })
    assert.deepEqual(repo.getAccountProfile('netease'), refreshedRow)

    assert.throws(() => repo.migrateLegacyAccountProfiles({
      rows: [{ ...legacyRow, updatedAtMs: 30 }],
      marker: { ...marker, sourceSha256: 'b'.repeat(64) },
    }), /migration marker/i)
    assert.deepEqual(repo.getAccountProfile('netease'), refreshedRow)
  })
})
