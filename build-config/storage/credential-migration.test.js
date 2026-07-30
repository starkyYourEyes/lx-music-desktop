const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { after, afterEach, describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const migrationPath = '../../src/main/migration/credentials/credentialMigration.ts'
const vaultPath = '../../src/main/storage/credentials/credentialVault.ts'
const temporaryRoots = []
const sourceRoot = path.resolve(__dirname, '../../src')
const originalResolveFilename = Module._resolveFilename
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

const encryptedCipher = {
  mode: 'encrypted',
  encrypt: plaintext => Buffer.concat([Buffer.from('migration-test:'), Buffer.from(plaintext).reverse()]),
  decrypt: ciphertext => {
    if (!ciphertext.subarray(0, 15).equals(Buffer.from('migration-test:'))) throw new Error('invalid ciphertext')
    return Buffer.from(ciphertext.subarray(15)).reverse().toString('utf8')
  },
}

const memoryOnlyCipher = {
  mode: 'memory-only',
  encrypt: () => { throw new Error('must not encrypt') },
  decrypt: () => { throw new Error('must not decrypt') },
}

const makeRoot = async() => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-credential-migration-'))
  temporaryRoots.push(root)
  return root
}

const writeJson = async(filePath, value) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(value), 'utf8')
}

const readJson = async filePath => JSON.parse(await fsp.readFile(filePath, 'utf8'))

afterEach(async() => {
  delete global.lx
  delete global.lxDataPath
  await Promise.all(temporaryRoots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })))
})

after(() => {
  Module._resolveFilename = originalResolveFilename
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

describe('legacy credential migration', () => {
  for (const failAt of ['after-vault-write', 'after-profile-write', 'after-source-redaction']) {
    it(`resumes safely ${failAt}`, async() => {
      const { migrateLegacyCredentials } = require(migrationPath)
      const { createCredentialVault } = require(vaultPath)
      const root = await makeRoot()
      const dataPath = path.join(root, 'data.json')
      const configPath = path.join(root, 'config_v2.json')
      const clientPath = path.join(root, 'sync', 'client', 'syncAuthKey.json')
      const serverPath = path.join(root, 'sync', 'server', 'devices.json')
      const userPath = path.join(root, 'sync', 'server', 'users', 'alice', 'devices.json')

      await writeJson(dataPath, {
        unrelated: { keep: true },
        neteaseAccount: {
          cookie: 'netease-cookie',
          profile: { userId: 7, nickname: 'N', avatarUrl: 'https://avatar/n' },
          updatedAt: 10,
        },
        qqMusicAccount: {
          cookie: 'qq-cookie',
          profile: { uin: '8', nickname: 'Q' },
          updatedAt: 20,
        },
      })
      await writeJson(configPath, { setting: { 'webdav.username': 'webdav-user', 'webdav.password': 'webdav-password', keep: true } })
      await writeJson(clientPath, { server_a: { clientId: 'client-a', key: 'client-key', serverName: 'Server' } })
      await writeJson(serverPath, { userName: 'default', clients: { device_a: { clientId: 'device-a', key: 'server-key', deviceName: 'Desktop', isMobile: false, lastConnectDate: 1 } } })
      await writeJson(userPath, { userName: 'alice', clients: { device_b: { clientId: 'device-b', key: 'user-key', deviceName: 'Phone', isMobile: true, lastConnectDate: 2 } } })

      const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher, now: () => 100 })
      const profiles = new Map()
      const dbMarkers = new Map()
      const profileStore = {
        migrateLegacyAccountProfiles: async({ rows, marker }) => {
          const existing = dbMarkers.get(marker.name)
          if (existing != null && existing.sourceSha256 != marker.sourceSha256) throw new Error('marker source conflict')
          for (const row of rows) profiles.set(row.provider, row)
          dbMarkers.set(marker.name, marker)
        },
        getMigrationMarker: async name => dbMarkers.get(name) ?? null,
      }
      const runMigration = async options => migrateLegacyCredentials({
        dataRoot: root,
        vault,
        profiles: profileStore,
        now: () => 100,
        ...options,
      })
      const countVaultEntries = async() => Object.keys((await readJson(path.join(root, 'credentials.v1.json'))).entries).length
      const countAccountProfiles = async() => profiles.size
      const verifyEveryDestination = async() => {
        const envelope = await readJson(path.join(root, 'credentials.v1.json'))
        return Object.keys(envelope.entries).length == 6 &&
          await vault.verify({ kind: 'netease-cookie' }, { version: 1, cookie: 'netease-cookie' }) &&
          await vault.verify({ kind: 'qq-music-cookie' }, { version: 1, cookie: 'qq-cookie' }) &&
          await vault.verify({ kind: 'webdav-basic' }, { version: 1, username: 'webdav-user', password: 'webdav-password' }) &&
          await vault.verify({ kind: 'sync-client', serverId: 'server_a' }, { version: 1, key: 'client-key' }) &&
          await vault.verify({ kind: 'sync-server-device', userName: 'default', clientId: 'device_a' }, { version: 1, key: 'server-key' }) &&
          await vault.verify({ kind: 'sync-server-device', userName: 'alice', clientId: 'device_b' }, { version: 1, key: 'user-key' }) &&
          dbMarkers.has('legacy_data_v1.account_profiles')
      }

      await assert.rejects(runMigration({ failAt }), /injected failure/)
      await runMigration()
      assert.equal(await countVaultEntries(), 6)
      assert.equal(await countAccountProfiles(), 2)
      assert.equal(await verifyEveryDestination(), true)

      assert.deepEqual(await readJson(dataPath), { unrelated: { keep: true }, neteaseAccount: { profile: { userId: 7, nickname: 'N', avatarUrl: 'https://avatar/n' }, updatedAt: 10 }, qqMusicAccount: { profile: { uin: '8', nickname: 'Q' }, updatedAt: 20 } })
      assert.deepEqual(await readJson(configPath), { setting: { keep: true } })
      assert.deepEqual(await readJson(clientPath), { server_a: { clientId: 'client-a', serverName: 'Server' } })
      assert.deepEqual(await readJson(serverPath), { userName: 'default', clients: { device_a: { clientId: 'device-a', deviceName: 'Desktop', isMobile: false, lastConnectDate: 1 } } })
      assert.deepEqual(await readJson(userPath), { userName: 'alice', clients: { device_b: { clientId: 'device-b', deviceName: 'Phone', isMobile: true, lastConnectDate: 2 } } })
    })
  }

  it('coalesces canonically identical mixed sync sources while accounting for and redacting every source', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    const clientPath = path.join(root, 'sync/client/syncAuthKey.json')
    const serverPath = path.join(root, 'sync/server/devices.json')
    const legacyPath = path.join(root, 'sync.json')
    await writeJson(clientPath, {
      shared_server: { clientId: 'client-current', key: 'shared-client-key', serverName: 'Current Server' },
    })
    await writeJson(serverPath, {
      userName: 'default',
      clients: { shared_device: { clientId: 'shared-device', key: 'shared-server-key', deviceName: 'Current Device', isMobile: false } },
    })
    await writeJson(legacyPath, {
      syncAuthKey: { shared_server: { clientId: 'client-legacy', key: 'shared-client-key', serverName: 'Legacy Server' } },
      clients: { shared_device: { clientId: 'shared-device', key: 'shared-server-key', deviceName: 'Legacy Device', isMobile: false } },
    })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    const profileStore = { migrateLegacyAccountProfiles: async() => {}, getMigrationMarker: async() => null }

    assert.deepEqual(await migrateLegacyCredentials({ dataRoot: root, vault, profiles: profileStore, now: () => 100 }), {
      status: 'complete', encryptedEntries: 2, memoryOnlyEntries: 0, profiles: 0,
    })

    assert.equal(await vault.verify({ kind: 'sync-client', serverId: 'shared_server' }, { version: 1, key: 'shared-client-key' }), true)
    assert.equal(await vault.verify({ kind: 'sync-server-device', userName: 'default', clientId: 'shared_device' }, { version: 1, key: 'shared-server-key' }), true)
    assert.equal(Object.keys((await readJson(path.join(root, 'credentials.v1.json'))).entries).length, 2)
    const markerNames = Object.keys((await readJson(path.join(root, 'credentials.v1.json'))).migrationMarkers)
    assert.equal(markerNames.filter(name => name.startsWith('legacy_data_v1.credentials.') && name != 'legacy_data_v1.credentials.memory-only').length, 4)
    assert.deepEqual(await readJson(clientPath), {
      shared_server: { clientId: 'client-current', serverName: 'Current Server' },
    })
    assert.deepEqual(await readJson(serverPath), {
      userName: 'default',
      clients: { shared_device: { clientId: 'shared-device', deviceName: 'Current Device', isMobile: false } },
    })
    assert.deepEqual(await readJson(legacyPath), {
      syncAuthKey: { shared_server: { clientId: 'client-legacy', serverName: 'Legacy Server' } },
      clients: { shared_device: { clientId: 'shared-device', deviceName: 'Legacy Device', isMobile: false } },
    })
  })

  it('migrates legacy-only mixed sync destinations with their public metadata', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    await writeJson(path.join(root, 'sync/client/syncAuthKey.json'), {
      current_server: { clientId: 'current-client', key: 'current-client-key', serverName: 'Current Server' },
    })
    await writeJson(path.join(root, 'sync/server/devices.json'), {
      userName: 'default',
      clients: { current_device: { clientId: 'current-device', key: 'current-server-key', deviceName: 'Current Device', isMobile: false } },
    })
    await writeJson(path.join(root, 'sync.json'), {
      syncAuthKey: { legacy_server: { clientId: 'legacy-client', key: 'legacy-client-key', serverName: 'Legacy Server', syncProtocol: 'legacy' } },
      clients: { legacy_device: { clientId: 'legacy-device', key: 'legacy-server-key', deviceName: 'Legacy Device', isMobile: true, lastSyncDate: 55 } },
    })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })

    assert.deepEqual(await migrateLegacyCredentials({
      dataRoot: root,
      vault,
      profiles: { migrateLegacyAccountProfiles: async() => {} },
      now: () => 100,
    }), { status: 'complete', encryptedEntries: 4, memoryOnlyEntries: 0, profiles: 0 })
    global.lxDataPath = root
    global.lx = { credentialVault: vault, appSetting: {} }
    await require('../../src/main/modules/sync/migrate.ts').default(root)

    assert.equal(await vault.verify({ kind: 'sync-client', serverId: 'legacy_server' }, { version: 1, key: 'legacy-client-key' }), true)
    assert.equal(await vault.verify({ kind: 'sync-server-device', userName: 'default', clientId: 'legacy_device' }, { version: 1, key: 'legacy-server-key' }), true)
    assert.deepEqual(await readJson(path.join(root, 'sync/client/servers.v1.json')), {
      version: 1,
      servers: {
        current_server: { clientId: 'current-client', serverName: 'Current Server' },
        legacy_server: { clientId: 'legacy-client', serverName: 'Legacy Server', syncProtocol: 'legacy' },
      },
    })
    assert.deepEqual(await readJson(path.join(root, 'sync/server/devices.v2.json')), {
      version: 2,
      userName: 'default',
      clients: {
        current_device: { clientId: 'current-device', deviceName: 'Current Device', isMobile: false },
        legacy_device: { clientId: 'legacy-device', deviceName: 'Legacy Device', isMobile: true, lastConnectDate: 55 },
      },
    })
  })

  it('rejects conflicting mixed sync credentials before any source, destination, marker, or metadata changes', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    const clientPath = path.join(root, 'sync/client/syncAuthKey.json')
    const legacyPath = path.join(root, 'sync.json')
    const clientMetadataPath = path.join(root, 'sync/client/servers.v1.json')
    await writeJson(clientPath, {
      shared_server: { clientId: 'current-client', key: 'current-key', serverName: 'Current Server' },
    })
    await writeJson(legacyPath, {
      syncAuthKey: { shared_server: { clientId: 'legacy-client', key: 'conflicting-key', serverName: 'Legacy Server' } },
    })
    await writeJson(clientMetadataPath, {
      version: 1, servers: { preserved: { clientId: 'preserved-client', serverName: 'Preserved' } },
    })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher, now: () => 1 })
    await vault.write({ kind: 'sync-client', serverId: 'shared_server' }, { version: 1, key: 'preexisting-key' })
    const paths = [clientPath, legacyPath, clientMetadataPath, path.join(root, 'credentials.v1.json')]
    const before = await Promise.all(paths.map(filePath => fsp.readFile(filePath, 'utf8')))

    await assert.rejects(
      migrateLegacyCredentials({ dataRoot: root, vault, profiles: { migrateLegacyAccountProfiles: async() => {} }, now: () => 100 }),
      error => error instanceof Error && error.message == 'Conflicting legacy credential destination',
    )

    const after = await Promise.all(paths.map(filePath => fsp.readFile(filePath, 'utf8')))
    assert.deepEqual(after, before)
    assert.equal(await vault.verify({ kind: 'sync-client', serverId: 'shared_server' }, { version: 1, key: 'preexisting-key' }), true)
  })

  it('keeps no stale encrypted destination after a memory-only migration and reports it on restart', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    await writeJson(path.join(root, 'data.json'), {
      neteaseAccount: { cookie: 'memory-only-cookie', profile: { userId: 1, nickname: 'N', avatarUrl: '' }, updatedAt: 1 },
    })
    const encryptedVault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    await encryptedVault.write({ kind: 'netease-cookie' }, { version: 1, cookie: 'stale-encrypted-cookie' })
    const memoryVault = await createCredentialVault({ profileRoot: root, cipher: memoryOnlyCipher })
    const profiles = { migrateLegacyAccountProfiles: async() => {} }

    assert.deepEqual(await migrateLegacyCredentials({ dataRoot: root, vault: memoryVault, profiles, now: () => 100 }), {
      status: 'secure-storage-unavailable', volatileEntries: 1,
    })
    assert.equal(await memoryVault.verify({ kind: 'netease-cookie' }, { version: 1, cookie: 'memory-only-cookie' }), true)
    assert.equal(Object.hasOwn((await readJson(path.join(root, 'credentials.v1.json'))).entries, 'netease-cookie'), false)

    const restartedMemoryVault = await createCredentialVault({ profileRoot: root, cipher: memoryOnlyCipher })
    assert.deepEqual(await migrateLegacyCredentials({ dataRoot: root, vault: restartedMemoryVault, profiles, now: () => 200 }), {
      status: 'secure-storage-unavailable', volatileEntries: 0,
    })
    const restartedEncryptedVault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    assert.deepEqual(restartedEncryptedVault.read({ kind: 'netease-cookie' }), { status: 'missing' })
  })

  it('uses the validated user directory name rather than devices.json userName', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    await writeJson(path.join(root, 'sync', 'server', 'users', 'alice', 'devices.json'), {
      userName: 'bob', clients: { device_a: { key: 'alice-key' } },
    })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    await migrateLegacyCredentials({ dataRoot: root, vault, profiles: { migrateLegacyAccountProfiles: async() => {} }, now: () => 100 })

    assert.equal(await vault.verify({ kind: 'sync-server-device', userName: 'alice', clientId: 'device_a' }, { version: 1, key: 'alice-key' }), true)
    assert.deepEqual(vault.read({ kind: 'sync-server-device', userName: 'bob', clientId: 'device_a' }), { status: 'missing' })
  })

  it('rejects colliding sync destinations before redacting either source', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    const rootDevices = path.join(root, 'sync', 'server', 'devices.json')
    const userDevices = path.join(root, 'sync', 'server', 'users', 'default', 'devices.json')
    await writeJson(rootDevices, { userName: 'default', clients: { device_a: { key: 'first-key' } } })
    await writeJson(userDevices, { userName: 'ignored', clients: { device_a: { key: 'second-key' } } })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })

    await assert.rejects(
      migrateLegacyCredentials({ dataRoot: root, vault, profiles: { migrateLegacyAccountProfiles: async() => {} }, now: () => 100 }),
      /conflicting legacy credential destination/i,
    )
    assert.equal((await readJson(rootDevices)).clients.device_a.key, 'first-key')
    assert.equal((await readJson(userDevices)).clients.device_a.key, 'second-key')
  })

  it('migrates an account profile even when its cookie is absent', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    await writeJson(path.join(root, 'data.json'), {
      neteaseAccount: { profile: { userId: 5, nickname: 'Profile', avatarUrl: '' }, updatedAt: 9 },
    })
    const rows = []
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    const result = await migrateLegacyCredentials({
      dataRoot: root,
      vault,
      profiles: { migrateLegacyAccountProfiles: async input => { rows.push(...input.rows) } },
      now: () => 100,
    })

    assert.deepEqual(result, { status: 'complete', encryptedEntries: 0, memoryOnlyEntries: 0, profiles: 1 })
    assert.deepEqual(rows.map(row => ({ ...row, profileJson: JSON.parse(row.profileJson) })), [{ provider: 'netease', profileJson: { userId: 5, nickname: 'Profile', avatarUrl: '' }, updatedAtMs: 9 }])
  })

  it('rejects a partial WebDAV source without exposing settings', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    const configPath = path.join(root, 'config_v2.json')
    await writeJson(configPath, { setting: { 'webdav.username': 'only-user', keep: true } })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    let vaultWrites = 0
    const originalWrite = vault.write
    vault.write = async(...args) => {
      vaultWrites++
      return await originalWrite(...args)
    }

    await assert.rejects(
      migrateLegacyCredentials({ dataRoot: root, vault, profiles: { migrateLegacyAccountProfiles: async() => {} }, now: () => 100 }),
      /WebDAV password/i,
    )
    assert.deepEqual(await readJson(configPath), { setting: { 'webdav.username': 'only-user', keep: true } })
    assert.equal(vaultWrites, 0)
  })

  it('treats a persisted both-empty WebDAV pair as unconfigured', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    const configPath = path.join(root, 'config_v2.json')
    await writeJson(configPath, {
      version: 2,
      setting: { 'webdav.username': '', 'webdav.password': '', keep: true },
    })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    let vaultWrites = 0
    const originalWrite = vault.write
    vault.write = async(...args) => {
      vaultWrites++
      return await originalWrite(...args)
    }

    assert.deepEqual(await migrateLegacyCredentials({
      dataRoot: root,
      vault,
      profiles: { migrateLegacyAccountProfiles: async() => {} },
      now: () => 100,
    }), { status: 'complete', encryptedEntries: 0, memoryOnlyEntries: 0, profiles: 0 })
    assert.equal(vaultWrites, 0)
  })

  it('persists only non-secret source identities in credential migration markers', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const { collectLegacyCredentialInventory } = require('../../src/main/migration/credentials/legacySources.ts')
    const root = await makeRoot()
    await writeJson(path.join(root, 'config_v2.json'), {
      setting: { 'webdav.username': 'weak-user', 'webdav.password': 'weak-password' },
    })
    const inventory = await collectLegacyCredentialInventory(root)
    assert.equal(Object.hasOwn(inventory.credentials[0], 'sourceSha256'), false)
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })

    await migrateLegacyCredentials({
      dataRoot: root,
      vault,
      profiles: { migrateLegacyAccountProfiles: async() => {} },
      now: () => 100,
    })

    const envelope = await readJson(path.join(root, 'credentials.v1.json'))
    for (const [name, marker] of Object.entries(envelope.migrationMarkers)) {
      assert.deepEqual(Object.keys(marker).sort(), ['completedAtMs', 'sourceId'])
      assert.equal(typeof marker.sourceId, 'string')
      assert.equal(marker.sourceId.length > 0, true)
      if (name.startsWith('legacy_data_v1.credentials.') && name != 'legacy_data_v1.credentials.memory-only') {
        assert.equal(marker.sourceId, name)
      }
    }
  })

  it('preflights every inventoried value before redacting any source', async() => {
    const { collectLegacyCredentialInventory } = require('../../src/main/migration/credentials/legacySources.ts')
    const { redactLegacySecrets } = require('../../src/main/migration/credentials/redactLegacySecrets.ts')
    const root = await makeRoot()
    const dataPath = path.join(root, 'data.json')
    const configPath = path.join(root, 'config_v2.json')
    await writeJson(dataPath, { neteaseAccount: { cookie: 'original-cookie' } })
    await writeJson(configPath, { setting: { 'webdav.username': 'user', 'webdav.password': 'original-password' } })
    const inventory = await collectLegacyCredentialInventory(root)
    await writeJson(configPath, { setting: { 'webdav.username': 'user', 'webdav.password': 'changed-password' } })
    const dataBefore = await fsp.readFile(dataPath, 'utf8')
    const configBefore = await fsp.readFile(configPath, 'utf8')

    await assert.rejects(redactLegacySecrets(inventory.credentials), /changed|identity|source/i)

    assert.equal(await fsp.readFile(dataPath, 'utf8'), dataBefore)
    assert.equal(await fsp.readFile(configPath, 'utf8'), configBefore)
  })

  it('rejects a source file replaced after inventory even when its value is unchanged', async() => {
    const { collectLegacyCredentialInventory } = require('../../src/main/migration/credentials/legacySources.ts')
    const { redactLegacySecrets } = require('../../src/main/migration/credentials/redactLegacySecrets.ts')
    const root = await makeRoot()
    const dataPath = path.join(root, 'data.json')
    const displacedPath = path.join(root, 'data.displaced.json')
    const document = { neteaseAccount: { cookie: 'same-cookie' }, keep: true }
    await writeJson(dataPath, document)
    const inventory = await collectLegacyCredentialInventory(root)
    await fsp.rename(dataPath, displacedPath)
    await writeJson(dataPath, document)

    await assert.rejects(redactLegacySecrets(inventory.credentials), /identity|source/i)
    assert.deepEqual(await readJson(dataPath), document)
  })

  it('rejects a data root reached through an ancestor symbolic link', async t => {
    const { collectLegacyCredentialInventory } = require('../../src/main/migration/credentials/legacySources.ts')
    const container = await makeRoot()
    const actualRoot = path.join(container, 'actual')
    const linkedRoot = path.join(container, 'linked')
    await fsp.mkdir(actualRoot)
    await writeJson(path.join(actualRoot, 'data.json'), { neteaseAccount: { cookie: 'cookie' } })
    try {
      await fsp.symlink(actualRoot, linkedRoot, 'junction')
    } catch (error) {
      if (error && error.code == 'EPERM') return t.skip('symbolic links require local privilege')
      throw error
    }

    await assert.rejects(collectLegacyCredentialInventory(linkedRoot), /data root|source path/i)
  })

  it('rejects a symbolic sync user directory', async t => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    const userRoot = path.join(root, 'sync', 'server', 'users')
    await fsp.mkdir(userRoot, { recursive: true })
    try {
      await fsp.symlink(root, path.join(userRoot, 'alice'), 'junction')
    } catch (error) {
      if (error && error.code == 'EPERM') return t.skip('symbolic links require local privilege')
      throw error
    }
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })

    await assert.rejects(
      migrateLegacyCredentials({ dataRoot: root, vault, profiles: { migrateLegacyAccountProfiles: async() => {} }, now: () => 100 }),
      /Invalid sync user path/,
    )
  })
})
