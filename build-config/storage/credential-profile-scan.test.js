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

const createInMemoryServerRuntime = () => {
  let webSocketServer
  const httpHandlers = new Map()
  class WebSocketServer {
    clients = new Set()
    handlers = new Map()

    constructor() {
      webSocketServer = this
    }

    on(event, handler) {
      this.handlers.set(event, handler)
    }

    emit(event, ...args) {
      this.handlers.get(event)?.(...args)
    }

    close() {
      this.emit('close')
    }
  }
  return {
    http: {
      createServer: () => ({
        on(event, handler) { httpHandlers.set(event, handler) },
        listen() { httpHandlers.get('listening')?.() },
        address: () => ({ port: 9527 }),
        close: callback => { callback() },
      }),
    },
    WebSocketServer,
    connect(socket, request) {
      webSocketServer.emit('connection', socket, request)
    },
  }
}

const createInMemoryServerService = ({ runtime, getUserSpace, toPublicDevice, onStatus }) =>
  loadTsModule(path.join(sourceRoot, 'main/modules/sync/server/server/server.ts'), {
    'node:http': runtime.http,
    ws: { WebSocketServer: runtime.WebSocketServer },
    './sync': { registerLocalSyncEvent() {}, unregisterLocalSyncEvent() {}, callObj: {}, sync: async() => {} },
    './auth': { authCode: async() => {}, authConnect: async() => {} },
    '@common/constants_sync': {
      SYNC_CLOSE_CODE: { normal: 1000, failed: 4100 },
      SYNC_CODE: { helloMsg: 'hello', idPrefix: 'id:', msgAuthFailed: 'failed' },
    },
    '../user': { getUserSpace, releaseUserSpace() {}, getServerId: () => 'server', initServerInfo: async() => {}, toPublicDevice },
    '@common/utils/syncRpc': {
      createSyncRpc: () => ({ remote: {}, createQueueRemote: () => ({}), message() {}, destroy() {} }),
    },
    '../../log': { info() {}, warn() {}, error() {} },
    '@main/modules/winMain': { sendServerStatus: onStatus },
    '../utils/tools': { decryptMsg: async(_key, value) => value, encryptMsg: async(_key, value) => value, generateCode: () => 'code' },
    '../../migrate': { __esModule: true, default: async() => {} },
    'node:net': {},
    '@common/utils/nodejs': { getAddress: () => [] },
    '@common/utils/common': { arrRemove() {} },
    '@common/syncProtocol': { getSyncProtocol: () => ({ id: 'current' }) },
  })

const createClientStatusService = () => loadTsModule(path.join(sourceRoot, 'main/modules/sync/client/client.ts'), {
  ws: class {},
  './utils': {},
  './sync': { callObj: {} },
  '../log': { info() {}, error() {} },
  '@common/utils/common': { arrRemove() {}, dateFormat: () => '' },
  '@main/modules/winMain': { sendClientStatus: () => {} },
  '@common/utils/syncRpc': { createSyncRpc: () => ({}) },
  '@common/constants_sync': { SYNC_CLOSE_CODE: { normal: 1000, failed: 4100 } },
  '@common/utils/nodejs': { getAddress: () => [] },
  '../utils': { aesEncrypt: value => value },
  '@common/syncProtocol': { getSyncProtocol: () => ({ id: 'current', syncConnectMessage: '' }) },
})

const createSyncExportFacade = ({ client, server }) => loadTsModule(path.join(sourceRoot, 'main/modules/sync/index.ts'), {
  './client': {
    connectServer: async() => {},
    disconnectServer: async() => {},
    getStatus: client.getStatus,
  },
  './server': server,
  './client/modules/userApi/service': {
    getRemoteUserApiMeta: async() => null,
    pullUserApiFromServer: async() => null,
    pushUserApiToServer: async() => null,
  },
})

const createCoordinatorDependencies = (checkCredentials, runMigrationHooks = async() => {}) => {
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
    runMigrationHooks: async result => {
      calls.push('migration:run')
      return await runMigrationHooks(result)
    },
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

const loadStorageMigrationHooks = ({
  initializeCredentialVault,
  migrateLegacyCredentials,
  createAccountRepository,
  migrateDBData = async() => {},
}) => loadTsModule(path.join(sourceRoot, 'main/app.ts'), {
  electron: { app: {}, shell: {}, screen: {}, nativeTheme: {} },
  '@common/constants': { URL_SCHEME_RXP: /^$/ },
  './utils': {
    getProxy: () => null,
    getTheme: () => null,
    initHotKey: async() => ({ local: {}, global: {} }),
    initSetting: async() => ({ setting: {} }),
    parseEnvParams: () => ({ cmdParams: {}, deeplink: null }),
  },
  '@common/config': { navigationUrlWhiteList: [] },
  '@common/defaultSetting': {},
  './modules/winMain': { isExistWindow: () => false, showWindow: () => {} },
  '@main/event': { createAppEvent: () => ({}), createDislikeEvent: () => ({}), createListEvent: () => ({}) },
  '@common/utils': { isMac: false },
  './worker': () => ({}),
  './utils/migrate': { migrateDBData },
  './storage/credentials': { initializeCredentialVault },
  './storage/accounts/accountRepository': { createAccountRepository },
  './migration/credentials/credentialMigration': { migrateLegacyCredentials },
  '@common/utils/request': { setProxyByHost: () => {} },
  '@main/utils/webContentsNavigationGuard': { getWebContentsNavigationDecision: () => 'allow' },
  './migration/legacyUserData': { getPortableUserDataPaths: () => null, migrateLegacyUserData: async() => {} },
  '@common/projectIdentity': { PROJECT_IDENTITY: {} },
}).runStorageMigrationHooks

const createLiveGlobal = (root, profileStore = createProfileStore()) => {
  global.lxDataPath = root
  global.lx = {
    credentialVault: null,
    accountRepository: null,
    worker: { dbService: profileStore },
  }
  return profileStore
}

const assertCredentialHookRecovery = async({ runMigrationHooks, expectedDiagnostic, sentinel }) => {
  const { createStorageCoordinator, checkCredentialStartup } = require(coordinatorPath)
  const { calls, deps } = createCoordinatorDependencies(
    async() => await checkCredentialStartup({
      dataRoot: global.lxDataPath,
      vault: global.lx.credentialVault,
      profileRepository: global.lx.accountRepository,
    }),
    runMigrationHooks,
  )
  const outcome = await createStorageCoordinator(deps).start()
  assert.deepEqual(outcome, {
    status: 'recovery',
    reason: 'credential_startup_check_failed',
    target: {
      kind: 'external-migration',
      component: 'credentials',
      affectedPath: path.join(global.lxDataPath, 'credentials.v1.json'),
      diagnostics: [expectedDiagnostic],
    },
  })
  assert.equal(calls.some(call => call == 'credentials:check'), false)
  assert.equal(calls.some(call => call == 'settings:init'), false)
  assert.equal(calls.some(call => call == 'modules:register'), false)
  assert.equal(calls.filter(call => Array.isArray(call) && call[0] == 'recovery:show').length, 1)
  assert.equal(JSON.stringify({ outcome, calls }).includes(sentinel), false)
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
      'SYNC_LEGACY_CLIENT_KEY_SENTINEL',
      'SYNC_LEGACY_SERVER_KEY_SENTINEL',
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
    await writeJson(path.join(root, 'sync.json'), {
      syncAuthKey: {
        server_a: { clientId: 'legacy-client-a', key: knownSecrets[4], serverName: 'Duplicate Server A' },
        server_legacy: { clientId: 'client-legacy', key: knownSecrets[7], serverName: 'Legacy Server', syncProtocol: 'legacy' },
      },
      clients: {
        device_a: { clientId: 'device_a', key: knownSecrets[5], deviceName: 'Duplicate Desktop', isMobile: false },
        device_legacy: { clientId: 'device_legacy', key: knownSecrets[8], deviceName: 'Legacy Phone', isMobile: true, lastSyncDate: 30 },
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
    assert.deepEqual(migration, { status: 'complete', encryptedEntries: 8, memoryOnlyEntries: 0, profiles: 2 })

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
    const legacyClientCredential = await syncClientData.getSyncAuthKey('server_legacy')
    const serverData = new UserDataManage('default')
    const serverCredential = await serverData.getClientKeyInfo('device_a')
    const legacyServerCredential = await serverData.getClientKeyInfo('device_legacy')
    const clientStatusService = createClientStatusService()
    clientStatusService.sendSyncStatus({ status: true, message: 'fixture-ready' })
    const runtime = createInMemoryServerRuntime()
    let resolveConnected
    const connected = new Promise(resolve => { resolveConnected = resolve })
    const { toPublicDevice } = require('../../src/main/modules/sync/server/user/data.ts')
    const serverService = createInMemoryServerService({
      runtime,
      getUserSpace: () => ({
        dataManage: {
          getClientKeyInfo: clientId => serverData.getClientKeyInfo(clientId),
          saveClientKeyInfo: async() => {},
        },
        getDecices: () => serverData.getAllClientKeyInfo(),
      }),
      toPublicDevice,
      onStatus: status => {
        if (status.devices.length > 0) resolveConnected()
      },
    })
    const sync = createSyncExportFacade({ client: clientStatusService, server: serverService })
    const socket = {
      on() {},
      addEventListener() {},
      send() {},
      ping() {},
      close() {},
      terminate() {},
    }
    const originalLog = console.log
    console.log = () => {}
    let syncClientStatus
    let syncServerStatus
    let publicDevices
    let serverStarted = false
    try {
      await serverService.startServer(9527)
      serverStarted = true
      runtime.connect(socket, { url: '/?i=device_a' })
      await connected
      syncClientStatus = sync.getClientStatus()
      syncServerStatus = sync.getServerStatus()
      publicDevices = await sync.getServerDevices()
    } finally {
      if (serverStarted) await serverService.stopServer()
      console.log = originalLog
    }

    assert.equal(clientCredential.key, knownSecrets[4])
    assert.equal(legacyClientCredential.key, knownSecrets[7])
    assert.equal(serverCredential.key, knownSecrets[5])
    assert.equal(legacyServerCredential.key, knownSecrets[8])
    assert.equal(syncServerStatus.devices.some(device => device.clientId == 'device_a'), true)
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

    const allRendererResponses = [qqStatus, neteaseStatus, webDAVStatus, syncClientStatus, syncServerStatus, publicDevices]
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
  it('shows credential recovery when live vault initialization fails', async() => {
    const root = await makeRoot()
    createLiveGlobal(root)
    const sentinel = 'VAULT_INITIALIZATION_FAILURE_SENTINEL'
    const runMigrationHooks = loadStorageMigrationHooks({
      initializeCredentialVault: async() => { throw new Error(sentinel) },
      migrateLegacyCredentials: async() => { throw new Error('must not migrate') },
      createAccountRepository: () => { throw new Error('must not create repository') },
    })

    await assertCredentialHookRecovery({
      runMigrationHooks,
      expectedDiagnostic: 'credentials.vault_unreadable',
      sentinel,
    })
  })

  it('shows credential recovery when a live vault read fails during hydration', async() => {
    const root = await makeRoot()
    const profileStore = createLiveGlobal(root)
    const sentinel = 'VAULT_READ_FAILURE_SENTINEL'
    const vault = {
      mode: 'encrypted',
      read: () => { throw new Error(sentinel) },
    }
    const runMigrationHooks = loadStorageMigrationHooks({
      initializeCredentialVault: async() => {
        global.lx.credentialVault = vault
        return vault
      },
      migrateLegacyCredentials: async() => ({ status: 'complete', encryptedEntries: 0, memoryOnlyEntries: 0, profiles: 0 }),
      createAccountRepository: require('../../src/main/storage/accounts/accountRepository.ts').createAccountRepository,
    })
    global.lx.worker.dbService = profileStore

    await assertCredentialHookRecovery({
      runMigrationHooks,
      expectedDiagnostic: 'credentials.vault_unreadable',
      sentinel,
    })
  })

  it('shows credential recovery when live credential inventory migration fails', async() => {
    const root = await makeRoot()
    const profileStore = createLiveGlobal(root)
    const sentinel = 'INVENTORY_FAILURE_SENTINEL'
    await fsp.writeFile(path.join(root, 'sync.json'), `{ "secret": "${sentinel}"`, 'utf8')
    const { createCredentialVault } = require(vaultPath)
    const vault = await createCredentialVault({ profileRoot: root, cipher: encryptedCipher })
    const runMigrationHooks = loadStorageMigrationHooks({
      initializeCredentialVault: async() => {
        global.lx.credentialVault = vault
        return vault
      },
      migrateLegacyCredentials: require(migrationPath).migrateLegacyCredentials,
      createAccountRepository: require('../../src/main/storage/accounts/accountRepository.ts').createAccountRepository,
    })
    global.lx.worker.dbService = profileStore

    await assertCredentialHookRecovery({
      runMigrationHooks,
      expectedDiagnostic: 'credentials.legacy_migration_failed',
      sentinel,
    })
  })

  it('shows fixed recovery when previously migrated memory-only credentials are gone', async() => {
    const root = await makeRoot()
    createLiveGlobal(root)
    const sentinel = 'MEMORY_ONLY_RESTART_SENTINEL'
    const vault = {
      mode: 'memory-only',
      read: () => ({ status: 'missing' }),
    }
    const runMigrationHooks = loadStorageMigrationHooks({
      initializeCredentialVault: async() => {
        global.lx.credentialVault = vault
        return vault
      },
      migrateLegacyCredentials: async() => ({ status: 'secure-storage-unavailable', volatileEntries: 0 }),
      createAccountRepository: () => { throw new Error('must not create repository') },
    })

    await assertCredentialHookRecovery({
      runMigrationHooks,
      expectedDiagnostic: 'credentials.memory_only_entries_unavailable',
      sentinel,
    })
  })

  it('passes the profile root and registers credential shutdown flushers after hydration', async() => {
    const root = await makeRoot()
    createLiveGlobal(root)
    const registrations = new Map()
    const calls = []
    global.lx.storage = {
      registerShutdownFlusher(name, flush) {
        registrations.set(name, flush)
        return () => {}
      },
    }
    const vault = {
      mode: 'encrypted',
      read: () => ({ status: 'missing' }),
      flush: async() => { calls.push('vault:flush') },
    }
    let repositoryOptions
    const accountRepository = {
      hydrate: async() => { calls.push('account:hydrate') },
      getStatus: () => ({ loggedIn: false, profile: null, updatedAtMs: null, persistence: null }),
      flush: async() => { calls.push('account:flush') },
    }
    const runMigrationHooks = loadStorageMigrationHooks({
      initializeCredentialVault: async() => {
        global.lx.credentialVault = vault
        return vault
      },
      migrateLegacyCredentials: async() => ({ status: 'complete', encryptedEntries: 0, memoryOnlyEntries: 0, profiles: 0 }),
      createAccountRepository: options => {
        repositoryOptions = options
        return accountRepository
      },
    })

    assert.equal(await runMigrationHooks({ existed: true }), undefined)
    assert.equal(repositoryOptions.profileRoot, root)
    assert.deepEqual([...registrations.keys()], ['credential-vault', 'account-repository'])
    await registrations.get('credential-vault')()
    await registrations.get('account-repository')()
    assert.deepEqual(calls, ['account:hydrate', 'vault:flush', 'account:flush'])
  })

  it('shows credential recovery when live account hydration fails', async() => {
    const root = await makeRoot()
    createLiveGlobal(root)
    const sentinel = 'ACCOUNT_HYDRATION_FAILURE_SENTINEL'
    const vault = {
      mode: 'encrypted',
      read: () => ({ status: 'missing' }),
    }
    const runMigrationHooks = loadStorageMigrationHooks({
      initializeCredentialVault: async() => {
        global.lx.credentialVault = vault
        return vault
      },
      migrateLegacyCredentials: async() => ({ status: 'complete', encryptedEntries: 0, memoryOnlyEntries: 0, profiles: 0 }),
      createAccountRepository: () => ({
        hydrate: async() => { throw new Error(sentinel) },
        getStatus: () => ({ loggedIn: false, profile: null, updatedAtMs: null, persistence: null }),
      }),
    })

    await assertCredentialHookRecovery({
      runMigrationHooks,
      expectedDiagnostic: 'credentials.profile_repository_unreadable',
      sentinel,
    })
  })

  it('keeps unrelated database failures fatal without showing credential recovery', async() => {
    const { createStorageCoordinator } = require(coordinatorPath)
    const { calls, deps } = createCoordinatorDependencies(async() => ({
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: [],
    }))
    deps.initDatabase = async() => {
      calls.push('database:init')
      const error = new Error('DATABASE_FAILURE_SENTINEL')
      error.code = 'database_open_failed'
      throw error
    }

    assert.deepEqual(await createStorageCoordinator(deps).start(), { status: 'fatal', reason: 'database_open_failed' })
    assert.equal(calls.some(call => Array.isArray(call) && call[0] == 'recovery:show'), false)
    assert.equal(calls.some(call => call == 'migration:run'), false)
  })

  it('keeps pre-credential legacy database migration failures fatal', async() => {
    const root = await makeRoot()
    createLiveGlobal(root)
    const runMigrationHooks = loadStorageMigrationHooks({
      migrateDBData: async() => {
        const error = new Error('LEGACY_DATABASE_FAILURE_SENTINEL')
        error.code = 'legacy_database_migration_failed'
        throw error
      },
      initializeCredentialVault: async() => { throw new Error('must not initialize vault') },
      migrateLegacyCredentials: async() => { throw new Error('must not migrate credentials') },
      createAccountRepository: () => { throw new Error('must not create repository') },
    })
    const { createStorageCoordinator } = require(coordinatorPath)
    const { calls, deps } = createCoordinatorDependencies(async() => ({
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: [],
    }), runMigrationHooks)
    deps.initDatabase = async() => {
      calls.push('database:init')
      return { status: 'ready', existed: false, schemaVersion: 4, migratedVersions: [], backupPath: null }
    }

    assert.deepEqual(await createStorageCoordinator(deps).start(), {
      status: 'fatal', reason: 'legacy_database_migration_failed',
    })
    assert.equal(calls.some(call => Array.isArray(call) && call[0] == 'recovery:show'), false)
    assert.equal(calls.some(call => call == 'credentials:check'), false)
    assert.equal(calls.some(call => call == 'settings:init'), false)
  })

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

  it('preserves the fixed source-scan diagnostic and a contained credential recovery path', async() => {
    const { createStorageCoordinator } = require(coordinatorPath)
    const recoveryPath = path.join('C:\\profiles\\fixture', 'credentials.v1.json')
    const { deps } = createCoordinatorDependencies(async() => ({
      vaultReadable: true,
      profileRepositoryReadable: true,
      activePlaintextSources: ['legacy.credential-source-scan'],
      recoveryPath,
    }))

    const outcome = await createStorageCoordinator(deps).start()

    assert.equal(outcome.status, 'recovery')
    assert.equal(outcome.target.affectedPath, recoveryPath)
    assert.deepEqual(outcome.target.diagnostics, ['credentials.source_scan_failed'])
  })
})
