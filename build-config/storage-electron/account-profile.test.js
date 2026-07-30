const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
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

const tempDirs = []

afterEach(() => {
  try {
    dbService.close()
  } catch {}
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('account profile storage', () => {
  it('bootstraps schema 4 and accepts only public provider profiles', async() => {
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-account-profile-'))
    tempDirs.push(profileRoot)
    const result = await dbService.init({
      dataPath: profileRoot,
      backupDir: path.join(profileRoot, 'backups'),
      previousShutdownWasClean: true,
    })

    assert.equal(result.status, 'ready')
    assert.equal(result.schemaVersion, 4)
    assert.deepEqual(result.migratedVersions, [])
    assert.equal(getSchemaVersion(dbService.getDB()), 4)

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
})
