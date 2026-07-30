const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
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

const migrationPath = '../../src/main/migration/credentials/credentialMigration.ts'
const vaultPath = '../../src/main/storage/credentials/credentialVault.ts'
const temporaryRoots = []

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
  await Promise.all(temporaryRoots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })))
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

  it('uses legacy sync.json only when the newer client source is absent', async() => {
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createCredentialVault } = require(vaultPath)
    const root = await makeRoot()
    await writeJson(path.join(root, 'sync.json'), {
      syncAuthKey: { legacy_server: { key: 'legacy-client-key' } },
      clients: { legacy_device: { clientId: 'legacy-device', key: 'legacy-server-key', deviceName: 'Old', isMobile: false } },
    })
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    const profileStore = { migrateLegacyAccountProfiles: async() => {}, getMigrationMarker: async() => null }

    await migrateLegacyCredentials({ dataRoot: root, vault, profiles: profileStore, now: () => 100 })

    assert.equal(await vault.verify({ kind: 'sync-client', serverId: 'legacy_server' }, { version: 1, key: 'legacy-client-key' }), true)
    assert.equal(await vault.verify({ kind: 'sync-server-device', userName: 'default', clientId: 'legacy_device' }, { version: 1, key: 'legacy-server-key' }), true)
    assert.deepEqual(await readJson(path.join(root, 'sync.json')), {
      syncAuthKey: { legacy_server: {} },
      clients: { legacy_device: { clientId: 'legacy-device', deviceName: 'Old', isMobile: false } },
    })
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
      /duplicate legacy credential destination/i,
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

    await assert.rejects(
      migrateLegacyCredentials({ dataRoot: root, vault, profiles: { migrateLegacyAccountProfiles: async() => {} }, now: () => 100 }),
      /WebDAV password/i,
    )
    assert.deepEqual(await readJson(configPath), { setting: { 'webdav.username': 'only-user', keep: true } })
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
