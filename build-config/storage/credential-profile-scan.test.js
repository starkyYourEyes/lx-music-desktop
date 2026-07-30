const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { after, afterEach, describe, it } = require('node:test')
const typescript = require('typescript')
const loadTsModule = require('../../scripts/test-utils/load-ts-module')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  module._compile(output, filename)
}

const sourceRoot = path.resolve(__dirname, '../../src')
const originalResolveFilename = Module._resolveFilename
const originalLoad = Module._load
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  return originalResolveFilename.call(this, request, parent, isMain, options)
}
Module._load = function(request, parent, isMain) {
  if (request == '@common/utils/lyricUtils/kg') return { decodeKrc: () => ({ lyric: '' }) }
  return originalLoad.call(this, request, parent, isMain)
}

const coordinatorPath = '../../src/main/startup/storageCoordinator.ts'
const migrationPath = '../../src/main/migration/credentials/credentialMigration.ts'
const vaultPath = '../../src/main/storage/credentials/credentialVault.ts'
const temporaryRoots = []

const encryptedCipher = {
  mode: 'encrypted',
  encrypt: plaintext => Buffer.concat([Buffer.from('profile-scan:'), Buffer.from(plaintext).reverse()]),
  decrypt: ciphertext => {
    if (!ciphertext.subarray(0, 13).equals(Buffer.from('profile-scan:'))) throw new Error('invalid ciphertext')
    return Buffer.from(ciphertext.subarray(13)).reverse().toString('utf8')
  },
}

const writeJson = async(filePath, value) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(value), 'utf8')
}

const makeRoot = async() => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-credential-profile-scan-'))
  temporaryRoots.push(root)
  return root
}

const readProfileJsonText = async(root, vaultFile) => {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const values = await Promise.all(entries.map(async entry => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) return await readProfileJsonText(target, vaultFile)
    if (!entry.isFile() || !entry.name.endsWith('.json') || path.resolve(target) == path.resolve(vaultFile)) return []
    return [await fsp.readFile(target, 'utf8')]
  }))
  return values.flat().join('\n')
}

const createProfileStore = () => {
  const rows = new Map()
  return {
    async migrateLegacyAccountProfiles({ rows: migratedRows }) {
      for (const row of migratedRows) rows.set(row.provider, { ...row })
    },
    async getAccountProfile(provider) {
      return rows.get(provider) ?? null
    },
    async upsertAccountProfile(row) {
      rows.set(row.provider, { ...row })
    },
    async removeAccountProfile(provider) {
      rows.delete(provider)
    },
  }
}

const createQQMusicService = accounts => {
  const { createQQMusicAccountService } = require('../../src/main/modules/qqMusic/index.ts')
  return createQQMusicAccountService({
    accounts,
    loginService: {
      createLoginQr: async() => ({ key: 'unused', qrurl: '', qrimg: '' }),
      checkLoginQr: async() => ({ state: 'waiting', message: '' }),
      cancelLoginQr: async() => {},
      disposeAll: async() => {},
    },
    songService: { getGuessLikeSongs: async() => [] },
    dailyRecommendService: { getDailyRecommendSongs: async() => [] },
    homeRecommendService: { getHomeRecommendation: async() => ({}) },
    playlistDetailService: { getPlaylistDetail: async() => ({}) },
    feedbackService: { likeMusic: async() => {}, dislikeMusic: async() => {} },
    credentialService: { getRefreshDueAt: () => null, refresh: async cookie => cookie },
    onRefreshDiagnostic: () => {},
    now: () => 10_001,
    schedule: () => undefined,
  })
}

const createNeteaseService = accounts => {
  const { createNeteaseAccountService } = require('../../src/main/modules/netease/account.ts')
  return createNeteaseAccountService({
    accounts,
    api: {
      login_qr_key: async() => { throw new Error('network must not be used') },
      login_qr_create: async() => { throw new Error('network must not be used') },
      login_qr_check: async() => { throw new Error('network must not be used') },
      login_status: async() => { throw new Error('network must not be used') },
      logout: async() => { throw new Error('network must not be used') },
    },
    now: () => 10_001,
  })
}

const createCoordinatorDependencies = checkCredentials => {
  const calls = []
  const deps = {
    runState: {
      begin: async() => { calls.push('run-state:begin'); return true },
      markClean: async() => { calls.push('run-state:clean') },
    },
    initDatabase: async() => {
      calls.push('database:init')
      return { status: 'ready', existed: true, schemaVersion: 4, migratedVersions: [], backupPath: null }
    },
    closeDatabase: async() => { calls.push('database:close') },
    runMigrationHooks: async() => { calls.push('migration:run') },
    checkCredentials: async() => {
      calls.push('credentials:check')
      return await checkCredentials()
    },
    initSettings: async() => { calls.push('settings:init') },
    registerModules: () => { calls.push('modules:register') },
    appInited: () => { calls.push('app:inited') },
    showRecovery: async outcome => { calls.push(['recovery:show', outcome]) },
    flushStores: async() => { calls.push('stores:flush') },
  }
  return { calls, deps }
}

afterEach(async() => {
  delete global.lx
  delete global.lxDataPath
  for (const request of [coordinatorPath, migrationPath, vaultPath]) {
    try { delete require.cache[require.resolve(request)] } catch {}
  }
  await Promise.all(temporaryRoots.splice(0).map(root => fsp.rm(root, { recursive: true, force: true })))
})

after(() => {
  Module._resolveFilename = originalResolveFilename
  Module._load = originalLoad
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

describe('complete credential profile cutover', () => {
  it('migrates every legacy credential kind and keeps persisted and public responses secret-free', async() => {
    const knownSecrets = [
      'NETEASE_COOKIE_SENTINEL',
      'QQ_COOKIE_SENTINEL',
      'WEBDAV_USER_SENTINEL',
      'WEBDAV_PASSWORD_SENTINEL',
      'SYNC_CLIENT_KEY_SENTINEL',
      'SYNC_SERVER_KEY_SENTINEL',
      'SYNC_USER_KEY_SENTINEL',
    ]
    const root = await makeRoot()
    const encryptedVaultPath = path.join(root, 'credentials.v1.json')
    await writeJson(path.join(root, 'data.json'), {
      unrelated: { keep: true },
      neteaseAccount: {
        cookie: knownSecrets[0],
        profile: { userId: 1001, nickname: 'NetEase User', avatarUrl: 'https://example.test/netease.png' },
        updatedAt: 10_000,
      },
      qqMusicAccount: {
        cookie: `uin=22001; qqmusic_key=${knownSecrets[1]}`,
        profile: { uin: '22001', nickname: 'QQ User' },
        updatedAt: 10_000,
      },
    })
    await writeJson(path.join(root, 'config_v2.json'), {
      setting: {
        'webdav.url': 'https://example.test/dav',
        'webdav.username': knownSecrets[2],
        'webdav.password': knownSecrets[3],
      },
    })
    await writeJson(path.join(root, 'sync/client/syncAuthKey.json'), {
      server_a: { clientId: 'client_a', key: knownSecrets[4], serverName: 'Server A', syncProtocol: 'current' },
    })
    await writeJson(path.join(root, 'sync/server/devices.json'), {
      userName: 'default',
      clients: {
        device_a: {
          clientId: 'device_a',
          key: knownSecrets[5],
          deviceName: 'Desktop',
          isMobile: false,
          lastConnectDate: 10,
          syncProtocol: 'current',
        },
      },
    })
    await writeJson(path.join(root, 'sync/server/users/alice/devices.json'), {
      userName: 'ignored-document-name',
      clients: {
        device_b: {
          clientId: 'device_b',
          key: knownSecrets[6],
          deviceName: 'Phone',
          isMobile: true,
          lastConnectDate: 20,
          syncProtocol: 'current',
        },
      },
    })

    const { createCredentialVault } = require(vaultPath)
    const { migrateLegacyCredentials } = require(migrationPath)
    const { createAccountRepository } = require('../../src/main/storage/accounts/accountRepository.ts')
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const { checkCredentialStartup } = require(coordinatorPath)
    const profileStore = createProfileStore()
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher, now: () => 10_000 })
    const accounts = createAccountRepository({ vault, profiles: profileStore })
    const activeCheck = await checkCredentialStartup({
      dataRoot: root,
      vault,
      profileRepository: accounts,
    })
    assert.deepEqual(activeCheck, {
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: [
        'legacy.data.netease-cookie',
        'legacy.data.qq-music-cookie',
        'legacy.config.webdav-basic',
        'legacy.sync.client-key',
        'legacy.sync.server-device-key',
      ],
    })
    assert.equal(knownSecrets.some(secret => JSON.stringify(activeCheck).includes(secret)), false)

    const migration = await migrateLegacyCredentials({
      dataRoot: root,
      vault,
      profiles: profileStore,
      now: () => 10_000,
    })
    assert.deepEqual(migration, { status: 'complete', encryptedEntries: 6, memoryOnlyEntries: 0, profiles: 2 })

    await accounts.hydrate()
    global.lxDataPath = root
    global.lx = {
      credentialVault: vault,
      accountRepository: accounts,
      appSetting: {
        'sync.server.maxSsnapshotNum': 3,
        'list.addMusicLocationType': 'add_start',
      },
    }

    const qqStatus = createQQMusicService(accounts).getAccountStatus()
    const neteaseStatus = await createNeteaseService(accounts).getAccountStatus()
    const webDAVStatus = await createWebDAVCredentialService(vault).getCredentialStatus()
    const migrateSyncData = require('../../src/main/modules/sync/migrate.ts').default
    await migrateSyncData(root)
    const syncClientData = require('../../src/main/modules/sync/client/data.ts')
    const { UserDataManage } = require('../../src/main/modules/sync/server/user/data.ts')
    const clientCredential = await syncClientData.getSyncAuthKey('server_a')
    const serverData = new UserDataManage('default')
    const serverCredential = await serverData.getClientKeyInfo('device_a')
    const publicDevices = await serverData.getAllClientKeyInfo()
    const syncStatus = loadTsModule(path.join(sourceRoot, 'main/modules/sync/client/client.ts'), {
      ws: class {},
      './utils': {},
      './sync': { callObj: {} },
      '../log': {},
      '@common/utils/common': {},
      '@main/modules/winMain': {},
      '@common/utils/syncRpc': {},
      '@common/constants_sync': {},
      '@common/utils/nodejs': {},
      '../utils': {},
      '@common/syncProtocol': {},
    }).getStatus()

    assert.equal(clientCredential.key, knownSecrets[4])
    assert.equal(serverCredential.key, knownSecrets[5])
    assert.equal(await vault.verify(
      { kind: 'sync-server-device', userName: 'alice', clientId: 'device_b' },
      { version: 1, key: knownSecrets[6] },
    ), true)
    const startupCheck = await checkCredentialStartup({
      dataRoot: root,
      vault,
      profileRepository: accounts,
    })
    assert.deepEqual(startupCheck, {
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: [],
    })

    const allRendererResponses = [qqStatus, neteaseStatus, webDAVStatus, syncStatus, publicDevices]
    const profileJsonText = await readProfileJsonText(root, encryptedVaultPath)
    const vaultText = await fsp.readFile(encryptedVaultPath, 'utf8')
    for (const secret of knownSecrets) {
      assert.equal(profileJsonText.includes(secret), false)
      assert.equal(vaultText.includes(secret), false)
      assert.equal(JSON.stringify(allRendererResponses).includes(secret), false)
    }
  })
})

describe('credential startup gate', () => {
  it('checks credentials after migration and before settings and module registration', async() => {
    const { createStorageCoordinator } = require(coordinatorPath)
    const { calls, deps } = createCoordinatorDependencies(async() => ({
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: [],
    }))

    assert.deepEqual(await createStorageCoordinator(deps).start(), { status: 'ready', schemaVersion: 4 })
    assert.deepEqual(calls, [
      'run-state:begin',
      'database:init',
      'migration:run',
      'credentials:check',
      'settings:init',
      'modules:register',
      'app:inited',
    ])
  })

  it('shows credential recovery and registers nothing when the smoke check is unhealthy', async() => {
    const { createStorageCoordinator } = require(coordinatorPath)
    const sentinel = 'PLAINTEXT_VALUE_SENTINEL'
    const cases = [
      { vaultReadable: false, profileRepositoryReadable: true, activePlaintextSources: [] },
      { vaultReadable: true, profileRepositoryReadable: false, activePlaintextSources: [] },
      { vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: ['legacy.data.netease-cookie'] },
      { vaultReadable: true, profileRepositoryReadable: true, activePlaintextSources: [sentinel] },
    ]

    for (const check of cases) {
      const { calls, deps } = createCoordinatorDependencies(async() => check)
      const outcome = await createStorageCoordinator(deps).start()

      assert.equal(outcome.status, 'recovery')
      assert.equal(outcome.reason, 'credential_startup_check_failed')
      assert.equal(outcome.target.kind, 'external-migration')
      assert.equal(outcome.target.component, 'credentials')
      assert.equal(calls.some(call => call == 'settings:init'), false)
      assert.equal(calls.some(call => call == 'modules:register'), false)
      assert.equal(calls.some(call => call == 'app:inited'), false)
      assert.equal(calls.filter(call => Array.isArray(call) && call[0] == 'recovery:show').length, 1)
      assert.equal(JSON.stringify({ outcome, calls }).includes(sentinel), false)
    }
  })
})
