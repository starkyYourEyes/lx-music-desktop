const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
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

const {
  normalizeNonActivitySource,
  readLegacyDataSource,
} = require('../../src/main/migration/legacyData/source.ts')
const { migrateLegacyCredentials } = require('../../src/main/migration/credentials/credentialMigration.ts')
const { withSelectedLegacyDataSource } = require('../../src/main/migration/credentials/legacySources.ts')
const { createStorageCoordinator } = require('../../src/main/startup/storageCoordinator.ts')

const tempDirs = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const makeRoots = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-non-activity-source-'))
  const profileRoot = path.join(root, 'profile')
  const legacyRoot = path.join(root, 'legacy')
  fs.mkdirSync(profileRoot)
  fs.mkdirSync(legacyRoot)
  tempDirs.push(root)
  return { profileRoot, legacyRoot }
}

const legacy = {
  viewPrevState: { url: '/list', query: { id: 'one' } },
  listPrevSelectId: 'one',
  listUpdateInfo: {
    one: { updateTime: 10, isAutoUpdate: false, profile: { description: 'One' } },
    two: { isAutoUpdate: true, profile: { description: 'Two' } },
  },
  searchHistoryList: ['first', 'second', 'first'],
  leaderboardSetting: { source: 'kg', boardId: 'kg__1' },
  songListSetting: { source: 'tx', sortId: 'hot', tagId: '' },
  searchSetting: { temp_source: 'wy', source: 'mg', type: 'songlist' },
}

const runCredentialMigration = async(snapshot, writes) => withSelectedLegacyDataSource(snapshot, () =>
  migrateLegacyCredentials({
    dataRoot: path.dirname(snapshot.sourcePath),
    vault: {
      mode: 'encrypted',
      async write() {
        writes.count++
        return { persistence: 'encrypted' }
      },
      async verify() { return true },
      getMigrationMarker() { return null },
      async putMigrationMarker() {},
    },
    profiles: {
      async migrateLegacyAccountProfiles() {
        throw new Error('profile target write must not run')
      },
    },
  }))

describe('legacy non-activity source', () => {
  it('selects the profile source once and freezes the byte-identical snapshot', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const bytes = Buffer.from(JSON.stringify({ ...legacy, marker: 'profile' }), 'utf8')
    fs.writeFileSync(path.join(profileRoot, 'data.json'), bytes)
    fs.writeFileSync(path.join(legacyRoot, 'data.json'), JSON.stringify({ ...legacy, marker: 'legacy' }))

    const result = await readLegacyDataSource({ profileRoot, legacyRoot })

    assert.equal(result.status, 'available')
    assert.equal(result.snapshot.sourcePath, path.join(profileRoot, 'data.json'))
    assert.equal(result.snapshot.fileSha256, crypto.createHash('sha256').update(bytes).digest('hex'))
    assert.equal(result.snapshot.parsed.marker, 'profile')
    assert.equal(Object.isFrozen(result.snapshot.parsed), true)
    assert.equal(Object.isFrozen(result.snapshot.parsed.viewPrevState), true)
  })

  it('uses the legacy root only when the profile source is absent', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const sourcePath = path.join(legacyRoot, 'data.json')
    fs.writeFileSync(sourcePath, JSON.stringify(legacy))

    const result = await readLegacyDataSource({ profileRoot, legacyRoot })

    assert.equal(result.status, 'available')
    assert.equal(result.snapshot.sourcePath, sourcePath)
  })

  it('rejects selected-file replacement after preflight before credential target writes', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const sourcePath = path.join(profileRoot, 'data.json')
    fs.writeFileSync(sourcePath, JSON.stringify({
      neteaseAccount: { cookie: 'same-cookie' },
      listPrevSelectId: 'old-list',
    }))
    const source = await readLegacyDataSource({ profileRoot, legacyRoot })
    assert.equal(source.status, 'available')
    fs.rmSync(sourcePath)
    const replacement = JSON.stringify({
      neteaseAccount: { cookie: 'same-cookie' },
      listPrevSelectId: 'new-list',
    })
    fs.writeFileSync(sourcePath, replacement)
    const writes = { count: 0 }

    await assert.rejects(
      runCredentialMigration(source.snapshot, writes),
      /Legacy data source changed after preflight/,
    )
    assert.equal(writes.count, 0)
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), replacement)
  })

  it('rejects selected-file byte mutation after preflight before credential target writes', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const sourcePath = path.join(profileRoot, 'data.json')
    const original = JSON.stringify({ neteaseAccount: { cookie: 'same-cookie' }, state: 'old' })
    const mutated = JSON.stringify({ neteaseAccount: { cookie: 'same-cookie' }, state: 'new' })
    assert.equal(Buffer.byteLength(original), Buffer.byteLength(mutated))
    fs.writeFileSync(sourcePath, original)
    const source = await readLegacyDataSource({ profileRoot, legacyRoot })
    assert.equal(source.status, 'available')
    fs.writeFileSync(sourcePath, mutated)
    const writes = { count: 0 }

    await assert.rejects(
      runCredentialMigration(source.snapshot, writes),
      /Legacy data source changed after preflight/,
    )
    assert.equal(writes.count, 0)
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), mutated)
  })

  it('preserves corrupt selected bytes and reports only a valid exact sibling recovery candidate', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const sourcePath = path.join(profileRoot, 'data.json')
    const originalBytes = Buffer.from('{"broken":', 'utf8')
    fs.writeFileSync(sourcePath, originalBytes)
    fs.writeFileSync(`${sourcePath}.previous`, JSON.stringify(legacy))
    fs.writeFileSync(path.join(legacyRoot, 'data.json'), JSON.stringify(legacy))

    const result = await readLegacyDataSource({ profileRoot, legacyRoot })

    assert.deepEqual(result, {
      status: 'recovery',
      reason: 'legacy_data_invalid_json',
      sourcePath,
      fileSha256: crypto.createHash('sha256').update(originalBytes).digest('hex'),
      candidatePreviousPath: `${sourcePath}.previous`,
    })
    assert.deepEqual(fs.readFileSync(sourcePath), originalBytes)
  })

  it('rejects a non-object selected root without trying the other root', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const sourcePath = path.join(profileRoot, 'data.json')
    const bytes = Buffer.from('[]', 'utf8')
    fs.writeFileSync(sourcePath, bytes)
    fs.writeFileSync(`${sourcePath}.previous`, 'null')
    fs.writeFileSync(path.join(legacyRoot, 'data.json'), JSON.stringify(legacy))

    assert.deepEqual(await readLegacyDataSource({ profileRoot, legacyRoot }), {
      status: 'recovery',
      reason: 'legacy_data_invalid_root',
      sourcePath,
      fileSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      candidatePreviousPath: null,
    })
  })

  it('maps old listPosition but never includes activity in Phase 2 hashes', () => {
    const first = normalizeNonActivitySource({
      ...legacy,
      listPosition: { default: 10 },
      recentPlayList: [{ id: 'a' }],
      listeningTimeStats: { totalSeconds: 1 },
    })
    const second = normalizeNonActivitySource({
      ...legacy,
      listPosition: { default: 10 },
      recentPlayList: [{ id: 'b' }],
      listeningTimeStats: { totalSeconds: 99 },
    })
    assert.deepEqual(first.hashes, second.hashes)
    assert.deepEqual(first.localState.listScrollPosition, { default: 10 })
    assert.equal(first.playlistMetadata.two.updateTime, 0)
    assert.deepEqual(first.searchHistory, ['first', 'second'])
  })

  it('stops startup before database or migration work when the selected source is corrupt', async() => {
    const { profileRoot, legacyRoot } = makeRoots()
    const profileDataPath = path.join(profileRoot, 'data.json')
    fs.writeFileSync(profileDataPath, '{"broken":')
    fs.writeFileSync(`${profileDataPath}.previous`, JSON.stringify(legacy))
    const originalBytes = fs.readFileSync(profileDataPath)
    let initDatabaseCalls = 0
    let runMigrationCalls = 0
    let registerModulesCalls = 0
    let createWindowCalls = 0

    const storageCoordinator = createStorageCoordinator({
      runState: { begin: async() => true, markClean: async() => {} },
      preflightLegacyData: () => readLegacyDataSource({ profileRoot, legacyRoot }),
      initDatabase: async() => { initDatabaseCalls++; return { status: 'ready', schemaVersion: 5, existed: false, migratedVersions: [], backupPath: null } },
      closeDatabase: async() => {},
      runMigrationHooks: async() => { runMigrationCalls++ },
      checkCredentials: async() => ({ vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [] }),
      initSettings: async() => {},
      registerModules: () => { registerModulesCalls++ },
      appInited: () => { createWindowCalls++ },
      showRecovery: async() => {},
      flushStores: async() => {},
    })

    const outcome = await storageCoordinator.start()

    assert.deepEqual(outcome, {
      status: 'recovery',
      reason: 'legacy_data_invalid_json',
      target: {
        kind: 'legacy-json',
        sourcePath: profileDataPath,
        candidatePreviousPath: `${profileDataPath}.previous`,
      },
    })
    assert.deepEqual(fs.readFileSync(profileDataPath), originalBytes)
    assert.equal(initDatabaseCalls, 0)
    assert.equal(runMigrationCalls, 0)
    assert.equal(registerModulesCalls, 0)
    assert.equal(createWindowCalls, 0)
  })
})
