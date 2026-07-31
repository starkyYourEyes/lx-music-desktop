const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { after, describe, it } = require('node:test')
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
Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  if (request.startsWith('@common/')) request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

after(() => {
  Module._resolveFilename = originalResolveFilename
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const readEveryJson = async(root) => {
  const entries = await fsp.readdir(root, { withFileTypes: true })
  const values = await Promise.all(entries.map(async entry => {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) return await readEveryJson(target)
    return entry.name.endsWith('.json') ? [await fsp.readFile(target, 'utf8')] : []
  }))
  return values.flat()
}

const createVault = () => {
  const entries = new Map()
  return {
    read(ref) {
      const value = entries.get(JSON.stringify(ref))
      return value == null ? { status: 'missing' } : { status: 'available', value }
    },
    async write(ref, value) {
      entries.set(JSON.stringify(ref), { ...value })
      return { persistence: 'encrypted' }
    },
    async verify(ref, expected) {
      return JSON.stringify(entries.get(JSON.stringify(ref))) == JSON.stringify(expected)
    },
    async remove(ref) {
      entries.delete(JSON.stringify(ref))
    },
  }
}

const writeJson = async(filePath, value) => {
  await fsp.mkdir(path.dirname(filePath), { recursive: true })
  await fsp.writeFile(filePath, JSON.stringify(value))
}

const deferred = () => {
  let resolvePromise
  const promise = new Promise(resolve => { resolvePromise = resolve })
  return { promise, resolve: resolvePromise }
}

const createGatedMetadataFile = initialValue => {
  let value = structuredClone(initialValue)
  let nextGate = null
  let readCalls = 0
  let replaceCalls = 0
  return {
    file: {
      async read() {
        readCalls++
        return structuredClone(value)
      },
      async replace(nextValue) {
        replaceCalls++
        const snapshot = structuredClone(nextValue)
        const gate = nextGate
        nextGate = null
        if (gate != null) {
          gate.started.resolve()
          await gate.release.promise
        }
        value = snapshot
        return { fileSha256: 'fixture' }
      },
      async flush() {},
    },
    gateNextReplace() {
      const gate = { started: deferred(), release: deferred() }
      nextGate = gate
      return { started: gate.started.promise, release: gate.release.resolve }
    },
    read: () => structuredClone(value),
    getReadCalls: () => readCalls,
    getReplaceCalls: () => replaceCalls,
  }
}

const createJournal = () => {
  let revision = 0
  return {
    async begin() { return ++revision },
    async complete() {},
    async list() { return [] },
    async flush() {},
  }
}

const freshRequire = request => {
  const resolved = require.resolve(request)
  delete require.cache[resolved]
  return require(request)
}

const createServerService = ({
  getUserSpace,
  migrateData = async() => {},
  serverRuntime,
  toPublicDevice = ({ key: _key, ...device }) => device,
  sendServerStatus = () => {},
}) => {
  return loadTsModule(path.join(sourceRoot, 'main/modules/sync/server/server/server.ts'), {
    'node:http': serverRuntime?.http ?? {},
    ws: { WebSocketServer: serverRuntime?.WebSocketServer ?? class {} },
    './sync': { registerLocalSyncEvent() {}, unregisterLocalSyncEvent() {}, callObj: {}, sync: async() => {} },
    './auth': { authCode: async() => {}, authConnect: async() => {} },
    '@common/constants_sync': {
      SYNC_CLOSE_CODE: { normal: 1000, failed: 4100 },
      SYNC_CODE: { helloMsg: 'hello', idPrefix: 'id:', msgAuthFailed: 'failed' },
    },
    '../user': { getUserSpace, releaseUserSpace() {}, getServerId: () => 'server', initServerInfo: async() => {}, toPublicDevice },
    '@common/utils/syncRpc': {
      createSyncRpc: () => ({
        remote: {},
        createQueueRemote: () => ({}),
        message() {},
        destroy() {},
      }),
    },
    '../../log': { info() {}, warn() {}, error() {} },
    '@main/modules/winMain': { sendServerStatus },
    '../utils/tools': { decryptMsg: async(_keyInfo, value) => value, encryptMsg: async(_keyInfo, value) => value, generateCode: () => 'code' },
    '../../migrate': { __esModule: true, default: migrateData },
    'node:net': {},
    '@common/utils/nodejs': { getAddress: () => [] },
    '@common/utils/common': { arrRemove() {} },
    '@common/syncProtocol': { getSyncProtocol: () => ({ id: 'current' }) },
  })
}

const createServerRuntime = () => {
  let webSocketServer
  const httpHandlers = new Map()
  const createHttpServer = () => ({
    on(event, handler) {
      httpHandlers.set(event, handler)
    },
    listen() {
      httpHandlers.get('listening')?.()
    },
    address() {
      return { port: 9527 }
    },
    close(callback) {
      callback()
    },
  })

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
    http: { createServer: createHttpServer },
    WebSocketServer,
    connect(socket, request) {
      webSocketServer.emit('connection', socket, request)
    },
  }
}

const createClientStatusService = unavailableError => {
  const sentStatuses = []
  const service = loadTsModule(path.join(sourceRoot, 'main/modules/sync/client/index.ts'), {
    './auth': { __esModule: true, default: async() => { throw unavailableError } },
    './client': {
      connect() {},
      async disconnect() {},
      sendSyncStatus(status) { sentStatuses.push(status) },
      sendSyncMessage() {},
      getStatus: () => sentStatuses.at(-1),
    },
    './utils': { parseUrl: () => ({}) },
    '../migrate': { __esModule: true, default: async() => {} },
    '../log': { info() {}, error() {}, r_warn() {} },
    '@common/constants_sync': {
      SYNC_CODE: {
        connecting: 'connecting',
        connectServiceFailed: 'connect_failed',
        missingAuthCode: 'missing_auth_code',
      },
    },
  })
  return { service, sentStatuses }
}

const createClientStatusState = () => loadTsModule(path.join(sourceRoot, 'main/modules/sync/client/client.ts'), {
  ws: class {},
  './utils': { encryptMsg() {}, decryptMsg() {} },
  './sync': { callObj: {} },
  '../log': { info() {}, error() {}, warn() {} },
  '@common/utils/common': { arrRemove() {}, dateFormat: () => '' },
  '@main/modules/winMain': { sendClientStatus() {} },
  '@common/utils/syncRpc': { createSyncRpc: () => ({}) },
  '@common/constants_sync': { SYNC_CLOSE_CODE: { failed: 4100 } },
  '@common/utils/nodejs': { getAddress: () => [] },
  '@common/syncProtocol': { getSyncProtocol: () => ({}) },
})

describe('sync credential cutover', () => {
  it('removes keys from server device data and JSON metadata', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-credential-cutover-'))
    global.lxDataPath = root
    global.lx = {
      credentialVault: createVault(),
      appSetting: {
        'sync.server.maxSsnapshotNum': 3,
        'list.addMusicLocationType': 'add_start',
      },
    }

    const clientData = require('../../src/main/modules/sync/client/data.ts')
    const { UserDataManage } = require('../../src/main/modules/sync/server/user/data.ts')
    await clientData.setSyncAuthKey('server_a', {
      clientId: 'client_a',
      key: 'CLIENT_KEY_SENTINEL',
      serverName: 'Test server',
      syncProtocol: 'current',
    })

    const devices = new UserDataManage('default')
    await devices.saveClientKeyInfo({
      clientId: 'device_a',
      key: 'SERVER_KEY_SENTINEL',
      deviceName: 'Desktop',
      isMobile: false,
      syncProtocol: 'current',
      lastConnectDate: 1,
    })
    const publicDevices = await devices.getAllClientKeyInfo()

    assert.doesNotMatch(JSON.stringify(publicDevices), /SERVER_KEY_SENTINEL/)
    assert.equal(Object.hasOwn(publicDevices[0], 'key'), false)
    for (const text of await readEveryJson(root)) {
      assert.doesNotMatch(text, /CLIENT_KEY_SENTINEL|SERVER_KEY_SENTINEL/)
    }

    await fsp.rm(root, { recursive: true, force: true })
  })

  it('keeps exported server status and device services key-free', async() => {
    const service = createServerService({
      getUserSpace: () => ({
        getDecices: async() => [{
          clientId: 'device_a',
          key: 'SERVER_KEY_SENTINEL',
          deviceName: 'Desktop',
          isMobile: false,
          lastConnectDate: 1,
        }],
      }),
    })

    const status = service.getStatus()
    const devices = await service.getDevices()

    assert.doesNotMatch(JSON.stringify(status), /SERVER_KEY_SENTINEL/)
    assert.doesNotMatch(JSON.stringify(devices), /SERVER_KEY_SENTINEL/)
    assert.equal(Object.hasOwn(devices[0], 'key'), false)
  })

  it('projects an undecryptable sync client credential without affecting other destinations', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-client-unavailable-'))
    const vault = createVault()
    global.lxDataPath = root
    global.lx = { credentialVault: vault, appSetting: {} }
    try {
      const clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
      await clientData.setSyncAuthKey('server_unavailable', {
        clientId: 'client_unavailable', key: 'CLIENT_KEY_UNAVAILABLE_SENTINEL', serverName: 'Unavailable',
      })
      await clientData.setSyncAuthKey('server_available', {
        clientId: 'client_available', key: 'CLIENT_KEY_AVAILABLE_SENTINEL', serverName: 'Available',
      })
      const originalRead = vault.read
      vault.read = ref => ref.kind == 'sync-client' && ref.serverId == 'server_unavailable'
        ? { status: 'undecryptable' }
        : originalRead.call(vault, ref)

      await assert.rejects(
        clientData.getSyncAuthKey('server_unavailable'),
        error => error.unavailableReason == 'credential_undecryptable' &&
          !JSON.stringify(error).includes('CLIENT_KEY_UNAVAILABLE_SENTINEL'),
      )
      assert.notEqual(await clientData.getSyncAuthKey('server_available'), null)

      const unavailableError = Object.assign(new Error('credential unavailable'), {
        unavailableReason: 'credential_undecryptable',
      })
      const { service, sentStatuses } = createClientStatusService(unavailableError)
      await assert.rejects(service.connectServer('http://fixture'), /credential unavailable/)
      assert.deepEqual(sentStatuses.at(-1), {
        status: false,
        message: 'credential unavailable',
        unavailableReason: 'credential_undecryptable',
      })
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('retains and clears the unavailable reason in the real sync client status state', () => {
    const client = createClientStatusState()

    client.sendSyncStatus({
      status: false,
      message: 'credential unavailable',
      unavailableReason: 'credential_undecryptable',
    })
    assert.equal(client.getStatus().unavailableReason, 'credential_undecryptable')

    client.sendSyncStatus({ status: false, message: '' })
    assert.equal(Object.hasOwn(client.getStatus(), 'unavailableReason'), false)
  })

  it('projects undecryptable sync server devices without affecting available or missing destinations', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-server-unavailable-'))
    const vault = createVault()
    global.lxDataPath = root
    global.lx = {
      credentialVault: vault,
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    try {
      const serverData = freshRequire('../../src/main/modules/sync/server/user/data.ts')
      const manager = new serverData.UserDataManage('default')
      for (const [clientId, deviceName] of [
        ['device_unavailable', 'Unavailable'],
        ['device_available', 'Available'],
        ['device_missing', 'Missing'],
      ]) {
        await manager.saveClientKeyInfo({
          clientId,
          key: `SERVER_KEY_${clientId.toUpperCase()}_SENTINEL`,
          deviceName,
          isMobile: false,
        })
      }
      await vault.remove({ kind: 'sync-server-device', userName: 'default', clientId: 'device_missing' })
      const originalRead = vault.read
      vault.read = ref => ref.kind == 'sync-server-device' && ref.clientId == 'device_unavailable'
        ? { status: 'undecryptable' }
        : originalRead.call(vault, ref)
      const service = createServerService({
        getUserSpace: () => ({ getDecices: () => manager.getAllClientKeyInfo() }),
        toPublicDevice: serverData.toPublicDevice,
      })

      const devices = await service.getDevices()
      const byId = Object.fromEntries(devices.map(device => [device.clientId, device]))
      assert.equal(byId.device_unavailable.unavailableReason, 'credential_undecryptable')
      assert.equal(Object.hasOwn(byId.device_available, 'unavailableReason'), false)
      assert.equal(Object.hasOwn(byId.device_missing, 'unavailableReason'), false)
      assert.doesNotMatch(JSON.stringify(devices), /SERVER_KEY_/)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('projects a connected keyed status device at the exported status boundary', async() => {
    const runtime = createServerRuntime()
    const keyInfo = {
      clientId: 'device_a',
      key: 'SERVER_KEY_SENTINEL',
      deviceName: 'Desktop',
      isMobile: false,
      lastConnectDate: 1,
    }
    let publicDeviceCalls = 0
    let resolveConnected
    const connected = new Promise(resolve => { resolveConnected = resolve })
    const service = createServerService({
      serverRuntime: runtime,
      getUserSpace: () => ({
        dataManage: {
          getClientKeyInfo: async() => keyInfo,
          saveClientKeyInfo: async() => {},
        },
      }),
      // The connection path places the first result in internal status; getStatus must project it again.
      toPublicDevice: device => {
        publicDeviceCalls += 1
        if (publicDeviceCalls == 1) return device
        const { key: _key, ...publicDevice } = device
        return publicDevice
      },
      sendServerStatus: status => {
        if (status.devices.length) resolveConnected()
      },
    })
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
    let status
    try {
      await service.startServer(9527)
      runtime.connect(socket, { url: '/?i=device_a' })
      await connected
      status = service.getStatus()
      await service.stopServer()
    } finally {
      console.log = originalLog
    }

    assert.equal(status.devices.length, 1)
    assert.equal(status.devices[0].clientId, 'device_a')
    assert.equal(status.devices[0].deviceName, 'Desktop')
    assert.equal(status.devices[0].isMobile, false)
    assert.equal(typeof status.devices[0].lastConnectDate, 'number')
    assert.doesNotMatch(JSON.stringify(status), /SERVER_KEY_SENTINEL/)
  })

  it('migrates legacy devices before the device-list service reads metadata', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-device-list-'))
    global.lxDataPath = root
    global.lx = {
      credentialVault: createVault(),
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    await writeJson(path.join(root, 'sync/server/devices.json'), {
      userName: 'default',
      clients: {
        device_a: {
          clientId: 'device_a',
          deviceName: 'Desktop',
          isMobile: false,
          lastConnectDate: 42,
        },
      },
    })
    const migrateData = freshRequire('../../src/main/modules/sync/migrate.ts').default
    const { UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts')
    let manager
    const service = createServerService({
      migrateData,
      getUserSpace: () => {
        manager ??= new UserDataManage('default')
        return { getDecices: () => manager.getAllClientKeyInfo() }
      },
    })

    const devices = await service.getDevices()

    assert.deepEqual(devices, [{
      clientId: 'device_a',
      deviceName: 'Desktop',
      isMobile: false,
      lastConnectDate: 42,
    }])
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'sync/server/devices.v2.json'), 'utf8')), {
      version: 2,
      userName: 'default',
      clients: {
        device_a: {
          clientId: 'device_a',
          deviceName: 'Desktop',
          isMobile: false,
          lastConnectDate: 42,
        },
      },
    })
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('keeps completed device metadata readable when obsolete legacy JSON is malformed', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-completed-cutover-'))
    global.lxDataPath = root
    global.lx = {
      credentialVault: createVault(),
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    const clientMetadataPath = path.join(root, 'sync/client/servers.v1.json')
    const deviceMetadataPath = path.join(root, 'sync/server/devices.v2.json')
    const clientMetadata = {
      version: 1,
      servers: {
        server_a: { clientId: 'client_a', serverName: 'Server' },
      },
    }
    const deviceMetadata = {
      version: 2,
      userName: 'default',
      clients: {
        device_a: { clientId: 'device_a', deviceName: 'Desktop', isMobile: false, lastConnectDate: 42 },
      },
    }
    await writeJson(clientMetadataPath, clientMetadata)
    await writeJson(deviceMetadataPath, deviceMetadata)
    await fsp.writeFile(path.join(root, 'sync/client/syncAuthKey.json'), '{ malformed')
    await fsp.writeFile(path.join(root, 'sync/server/devices.json'), '{ malformed')
    const originalClientMetadata = await fsp.readFile(clientMetadataPath, 'utf8')
    const originalDeviceMetadata = await fsp.readFile(deviceMetadataPath, 'utf8')
    const migrateData = freshRequire('../../src/main/modules/sync/migrate.ts').default
    const { UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts')
    let manager
    const service = createServerService({
      migrateData,
      getUserSpace: () => {
        manager ??= new UserDataManage('default')
        return { getDecices: () => manager.getAllClientKeyInfo() }
      },
    })

    const devices = await service.getDevices()

    assert.deepEqual(devices, [{
      clientId: 'device_a',
      deviceName: 'Desktop',
      isMobile: false,
      lastConnectDate: 42,
    }])
    assert.equal(await fsp.readFile(clientMetadataPath, 'utf8'), originalClientMetadata)
    assert.equal(await fsp.readFile(deviceMetadataPath, 'utf8'), originalDeviceMetadata)
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('maps legacy sync.json lastSyncDate to v2 lastConnectDate', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-last-connect-'))
    global.lxDataPath = root
    global.lx = { credentialVault: createVault(), appSetting: {} }
    await writeJson(path.join(root, 'sync.json'), {
      serverId: 'server_a',
      clients: {
        device_a: {
          clientId: 'device_a',
          key: 'SERVER_KEY_SENTINEL',
          deviceName: 'Desktop',
          isMobile: false,
          lastSyncDate: 123,
          snapshotKey: 'snapshot_a',
        },
      },
      syncAuthKey: {},
      snapshotInfo: { clients: {} },
    })

    await freshRequire('../../src/main/modules/sync/migrate.ts').default(root)

    const metadata = JSON.parse(await fsp.readFile(path.join(root, 'sync/server/devices.v2.json'), 'utf8'))
    assert.equal(metadata.clients.device_a.lastConnectDate, 123)
    assert.doesNotMatch(JSON.stringify(metadata), /SERVER_KEY_SENTINEL/)
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('canonicalizes same-count versioned metadata only after vaulting discovered keys', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-canonical-metadata-'))
    const vault = createVault()
    global.lxDataPath = root
    global.lx = { credentialVault: vault, appSetting: {} }
    await writeJson(path.join(root, 'sync/client/servers.v1.json'), {
      version: 1,
      servers: {
        server_a: {
          clientId: 'client_a',
          serverName: 'Server',
          key: 'CLIENT_KEY_SENTINEL',
          forbidden: 'remove-me',
        },
      },
      forbidden: true,
    })
    await writeJson(path.join(root, 'sync/server/devices.v2.json'), {
      version: 2,
      userName: 'default',
      clients: {
        device_a: {
          clientId: 'device_a',
          deviceName: 'Desktop',
          isMobile: false,
          key: 'SERVER_KEY_SENTINEL',
          forbidden: 'remove-me',
        },
      },
      forbidden: true,
    })

    await freshRequire('../../src/main/modules/sync/migrate.ts').default(root)

    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'sync/client/servers.v1.json'), 'utf8')), {
      version: 1,
      servers: { server_a: { clientId: 'client_a', serverName: 'Server' } },
    })
    assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'sync/server/devices.v2.json'), 'utf8')), {
      version: 2,
      userName: 'default',
      clients: { device_a: { clientId: 'device_a', deviceName: 'Desktop', isMobile: false } },
    })
    assert.equal(vault.read({ kind: 'sync-client', serverId: 'server_a' }).status, 'available')
    assert.equal(vault.read({ kind: 'sync-server-device', userName: 'default', clientId: 'device_a' }).status, 'available')
    await fsp.rm(root, { recursive: true, force: true })
  })

  it('writes only runtime-readable sync metadata after vaulting keys from invalid entries', async() => {
    const cases = [
      {
        name: 'empty client id',
        side: 'client',
        id: 'server_empty_client',
        value: { clientId: '', serverName: 'Server', key: 'CLIENT_KEY_EMPTY_ID_SENTINEL' },
      },
      {
        name: 'empty server name',
        side: 'client',
        id: 'server_empty_name',
        value: { clientId: 'client_empty_name', serverName: '', key: 'CLIENT_KEY_EMPTY_NAME_SENTINEL' },
      },
      {
        name: 'empty device id',
        side: 'server',
        id: 'device_empty_id',
        value: { clientId: '', deviceName: 'Desktop', isMobile: false, key: 'SERVER_KEY_EMPTY_ID_SENTINEL' },
      },
      {
        name: 'empty device name',
        side: 'server',
        id: 'device_empty_name',
        value: { clientId: 'device_empty_name', deviceName: '', isMobile: false, key: 'SERVER_KEY_EMPTY_NAME_SENTINEL' },
      },
      ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, null].map((lastConnectDate, index) => ({
        name: `invalid connection date ${index}`,
        side: 'server',
        id: `device_invalid_date_${index}`,
        value: {
          clientId: `device_invalid_date_${index}`,
          deviceName: 'Desktop',
          isMobile: false,
          lastConnectDate,
          key: `SERVER_KEY_INVALID_DATE_${index}_SENTINEL`,
        },
      })),
      {
        name: 'invalid legacy sync date',
        side: 'server',
        id: 'device_invalid_legacy_date',
        value: {
          clientId: 'device_invalid_legacy_date',
          deviceName: 'Desktop',
          isMobile: false,
          lastSyncDate: -1,
          key: 'SERVER_KEY_INVALID_LEGACY_DATE_SENTINEL',
        },
      },
    ]

    const { normalizeSyncServerDevice } = freshRequire('../../src/common/storage/syncMetadata.ts')
    for (const lastConnectDate of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      assert.equal(normalizeSyncServerDevice({
        clientId: 'device_non_finite',
        deviceName: 'Desktop',
        isMobile: false,
        lastConnectDate,
      }), null)
    }

    for (const testCase of cases) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-validator-parity-'))
      const vault = createVault()
      global.lxDataPath = root
      global.lx = {
        credentialVault: vault,
        appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
      }
      try {
        await writeJson(path.join(root, 'sync/client/servers.v1.json'), {
          version: 1,
          servers: {
            server_valid: { clientId: 'client_valid', serverName: 'Server', forbidden: true },
            ...(testCase.side == 'client' ? { [testCase.id]: testCase.value } : {}),
          },
          forbidden: true,
        })
        await writeJson(path.join(root, 'sync/server/devices.v2.json'), {
          version: 2,
          userName: 'default',
          clients: {
            device_valid: { clientId: 'device_valid', deviceName: 'Desktop', isMobile: false, forbidden: true },
            ...(testCase.side == 'server' ? { [testCase.id]: testCase.value } : {}),
          },
          forbidden: true,
        })

        await freshRequire('../../src/main/modules/sync/migrate.ts').default(root)

        const clientMetadata = JSON.parse(await fsp.readFile(path.join(root, 'sync/client/servers.v1.json'), 'utf8'))
        const serverMetadata = JSON.parse(await fsp.readFile(path.join(root, 'sync/server/devices.v2.json'), 'utf8'))
        assert.deepEqual(clientMetadata, {
          version: 1,
          servers: { server_valid: { clientId: 'client_valid', serverName: 'Server' } },
        }, testCase.name)
        assert.deepEqual(serverMetadata, {
          version: 2,
          userName: 'default',
          clients: { device_valid: { clientId: 'device_valid', deviceName: 'Desktop', isMobile: false } },
        }, testCase.name)

        const ref = testCase.side == 'client'
          ? { kind: 'sync-client', serverId: testCase.id }
          : { kind: 'sync-server-device', userName: 'default', clientId: testCase.id }
        assert.equal(vault.read(ref).status, 'available', testCase.name)

        const clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
        assert.equal(await clientData.getSyncAuthKey('server_valid'), null, testCase.name)
        const { UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts')
        assert.deepEqual(await new UserDataManage('default').getAllClientKeyInfo(), [{
          clientId: 'device_valid',
          deviceName: 'Desktop',
          isMobile: false,
        }], testCase.name)
      } finally {
        await fsp.rm(root, { recursive: true, force: true })
      }
    }
  })

  it('rejects invalid sync metadata changed after credential inventory', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-invalid-destination-race-'))
    const vault = createVault()
    const destination = path.join(root, 'sync/client/servers.v1.json')
    const inventoried = {
      version: 1,
      servers: {
        server_inventoried: { clientId: '', serverName: 'Inventoried', key: 'INVENTORIED_KEY_1234567890' },
      },
    }
    const replacement = {
      version: 1,
      servers: {
        server_replacement: { clientId: '', serverName: 'Replacement', key: 'REPLACEMENT_KEY_1234567890' },
      },
    }
    global.lxDataPath = root
    global.lx = { credentialVault: vault, appSetting: {} }
    try {
      await writeJson(destination, inventoried)
      const { createAtomicJsonFile } = freshRequire('../../src/main/storage/atomicJsonFile.ts')
      let destinationChanged = false
      const migrateData = loadTsModule(path.join(sourceRoot, 'main/modules/sync/migrate.ts'), {
        '@main/storage/atomicJsonFile': {
          createAtomicJsonFile(options) {
            const file = createAtomicJsonFile(options)
            if (path.resolve(options.filePath) != path.resolve(destination)) return file
            return {
              ...file,
              async replace(value) {
                if (!destinationChanged) {
                  destinationChanged = true
                  await writeJson(destination, replacement)
                }
                return await file.replace(value)
              },
            }
          },
        },
      }).default

      await assert.rejects(migrateData(root), /Atomic JSON durable destination/)
      assert.deepEqual(JSON.parse(await fsp.readFile(destination, 'utf8')), replacement)
      assert.equal(vault.read({ kind: 'sync-client', serverId: 'server_inventoried' }).status, 'available')
      assert.equal(vault.read({ kind: 'sync-client', serverId: 'server_replacement' }).status, 'missing')
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('resumes every root sync migration phase before verified source cleanup', async() => {
    const phases = [
      'after-directories',
      'after-server-info',
      'after-server-metadata',
      'after-snapshots',
      'after-client-metadata',
    ]
    for (const failAt of phases) {
      const root = await fsp.mkdtemp(path.join(os.tmpdir(), `lx-sync-resume-${failAt}-`))
      const vault = createVault()
      global.lxDataPath = root
      global.lx = { credentialVault: vault, appSetting: {} }
      const legacyPath = path.join(root, 'sync.json')
      const snapshotPath = path.join(root, 'snapshot_fixture.json')
      await writeJson(legacyPath, {
        serverId: 'server_a',
        clients: {
          device_a: {
            clientId: 'device_a',
            key: 'SERVER_KEY_SENTINEL',
            deviceName: 'Desktop',
            isMobile: false,
            lastSyncDate: 123,
            snapshotKey: 'snapshot_a',
          },
        },
        syncAuthKey: {
          server_a: {
            clientId: 'client_a',
            key: 'CLIENT_KEY_SENTINEL',
            serverName: 'Server',
          },
        },
        snapshotInfo: { clients: {} },
      })
      await writeJson(snapshotPath, { fixture: true })
      const migrateData = freshRequire('../../src/main/modules/sync/migrate.ts').default

      await assert.rejects(migrateData(root, { failAt }), /injected failure/i)
      assert.equal(fs.existsSync(legacyPath), true)

      await migrateData(root)

      assert.equal(fs.existsSync(legacyPath), false)
      assert.equal(fs.existsSync(snapshotPath), false)
      assert.deepEqual(JSON.parse(await fsp.readFile(path.join(root, 'sync/server/serverInfo.json'), 'utf8')), {
        serverId: 'server_a',
        version: 2,
      })
      assert.equal(fs.existsSync(path.join(root, 'sync/server/list/snapshot/snapshot_fixture.json')), true)
      assert.equal(vault.read({ kind: 'sync-client', serverId: 'server_a' }).status, 'available')
      assert.equal(vault.read({ kind: 'sync-server-device', userName: 'default', clientId: 'device_a' }).status, 'available')
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('awaits server identity persistence and propagates its failure', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-server-info-'))
    global.lxDataPath = root
    global.lx = { appSetting: {} }
    const blockedTemporaryPath = path.join(root, 'sync/server/serverInfo.json.next')
    await fsp.mkdir(blockedTemporaryPath, { recursive: true })
    try {
      const serverData = freshRequire('../../src/main/modules/sync/server/user/data.ts')
      await assert.rejects(serverData.initServerInfo(), /EISDIR|directory|illegal operation/i)
      await assert.rejects(serverData.flushServerInfo(), /EISDIR|directory|illegal operation/i)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('reconciles interrupted client credential saves and removals on restart', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-client-intent-'))
    const vault = createVault()
    global.lxDataPath = root
    global.lx = { credentialVault: vault, appSetting: {} }
    try {
      let clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
      await assert.rejects(clientData.setSyncAuthKey('server_a', {
        clientId: 'client_a',
        key: 'CLIENT_KEY_SENTINEL',
        serverName: 'Server',
      }, { failAt: 'after-vault-write' }), /injected failure/i)

      clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
      assert.equal(await clientData.getSyncAuthKey('server_a'), null)

      await clientData.setSyncAuthKey('server_a', {
        clientId: 'client_a',
        key: 'CLIENT_KEY_SENTINEL',
        serverName: 'Server',
      })
      await assert.rejects(
        clientData.removeSyncAuthKey('server_a', { failAt: 'after-vault-remove' }),
        /injected failure/i,
      )

      clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
      assert.equal(await clientData.getSyncAuthKey('server_a'), null)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('reconciles interrupted server credential saves and removals on restart', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-server-intent-'))
    const vault = createVault()
    global.lxDataPath = root
    global.lx = {
      credentialVault: vault,
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    const keyInfo = {
      clientId: 'device_a',
      key: 'SERVER_KEY_SENTINEL',
      deviceName: 'Desktop',
      isMobile: false,
    }
    try {
      let { UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts')
      let manager = new UserDataManage('default')
      await assert.rejects(manager.saveClientKeyInfo(keyInfo, { failAt: 'after-vault-write' }), /injected failure/i)

      ;({ UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts'))
      manager = new UserDataManage('default')
      assert.equal(await manager.getClientKeyInfo('device_a'), null)

      await manager.saveClientKeyInfo(keyInfo)
      await assert.rejects(manager.removeClientKeyInfo('device_a', { failAt: 'after-vault-remove' }), /injected failure/i)

      ;({ UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts'))
      manager = new UserDataManage('default')
      assert.equal(await manager.getClientKeyInfo('device_a'), null)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('serializes later client and server removals behind blocked saves', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-overlap-intent-'))
    const vault = createVault()
    const originalWrite = vault.write
    let releaseWrite
    let writeCalls = 0
    vault.write = async(...args) => {
      writeCalls++
      if (writeCalls <= 2) await new Promise(resolve => { releaseWrite = resolve })
      return await originalWrite.apply(vault, args)
    }
    const waitForWriteCall = async expected => {
      if (writeCalls >= expected) return
      await new Promise(resolve => setImmediate(resolve))
      await waitForWriteCall(expected)
    }
    global.lxDataPath = root
    global.lx = {
      credentialVault: vault,
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    try {
      const clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
      const clientSave = clientData.setSyncAuthKey('server_a', {
        clientId: 'client_a',
        key: 'CLIENT_KEY_SENTINEL',
        serverName: 'Server',
      })
      await waitForWriteCall(1)
      const clientRemove = clientData.removeSyncAuthKey('server_a')
      releaseWrite()
      await Promise.all([clientSave, clientRemove])
      assert.equal(await clientData.getSyncAuthKey('server_a'), null)

      const { UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts')
      const manager = new UserDataManage('default')
      const serverSave = manager.saveClientKeyInfo({
        clientId: 'device_a',
        key: 'SERVER_KEY_SENTINEL',
        deviceName: 'Desktop',
        isMobile: false,
      })
      await waitForWriteCall(2)
      const serverRemove = manager.removeClientKeyInfo('device_a')
      releaseWrite()
      await Promise.all([serverSave, serverRemove])
      assert.equal(await manager.getClientKeyInfo('device_a'), null)
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })

  it('serializes client mutations across destinations at the shared metadata document', async() => {
    const vault = createVault()
    const metadata = createGatedMetadataFile({ version: 1, servers: {} })
    const clientData = loadTsModule(path.join(sourceRoot, 'main/modules/sync/client/data.ts'), {
      '@main/storage/atomicJsonFile': { createAtomicJsonFile: () => metadata.file },
      '@main/storage/credentials': { getCredentialVault: () => vault },
      '@main/storage/operationJournal': { createOperationJournal: createJournal },
    })
    global.lxDataPath = path.join(os.tmpdir(), 'lx-sync-client-gated-fixture')
    global.lx = { credentialVault: vault, appSetting: {} }

    const saveGate = metadata.gateNextReplace()
    const saveA = clientData.setSyncAuthKey('server_a', {
      clientId: 'client_a', key: 'CLIENT_KEY_A_SENTINEL', serverName: 'Server A',
    })
    await saveGate.started
    const saveB = clientData.setSyncAuthKey('server_b', {
      clientId: 'client_b', key: 'CLIENT_KEY_B_SENTINEL', serverName: 'Server B',
    })
    await new Promise(resolve => setImmediate(resolve))
    const saveReplacementsBeforeRelease = metadata.getReplaceCalls()
    saveGate.release()
    await Promise.all([saveA, saveB])

    assert.equal(saveReplacementsBeforeRelease, 1)
    assert.deepEqual(Object.keys(metadata.read().servers).sort(), ['server_a', 'server_b'])
    assert.equal(vault.read({ kind: 'sync-client', serverId: 'server_a' }).status, 'available')
    assert.equal(vault.read({ kind: 'sync-client', serverId: 'server_b' }).status, 'available')

    const interleaveGate = metadata.gateNextReplace()
    const saveC = clientData.setSyncAuthKey('server_c', {
      clientId: 'client_c', key: 'CLIENT_KEY_C_SENTINEL', serverName: 'Server C',
    })
    await interleaveGate.started
    const removeA = clientData.removeSyncAuthKey('server_a')
    await new Promise(resolve => setImmediate(resolve))
    const interleaveReplacementsBeforeRelease = metadata.getReplaceCalls()
    interleaveGate.release()
    await Promise.all([saveC, removeA])

    assert.equal(interleaveReplacementsBeforeRelease, 3)
    assert.deepEqual(Object.keys(metadata.read().servers).sort(), ['server_b', 'server_c'])
  })

  it('serializes server mutations across destinations at the shared metadata document', async() => {
    const vault = createVault()
    const metadata = createGatedMetadataFile({ version: 2, userName: 'default', clients: {} })
    const serverData = loadTsModule(path.join(sourceRoot, 'main/modules/sync/server/user/data.ts'), {
      '@main/storage/atomicJsonFile': { createAtomicJsonFile: () => metadata.file },
      '@main/storage/credentials': { getCredentialVault: () => vault },
      '@main/storage/operationJournal': { createOperationJournal: createJournal },
    })
    global.lxDataPath = path.join(os.tmpdir(), 'lx-sync-server-gated-fixture')
    global.lx = {
      credentialVault: vault,
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    const manager = new serverData.UserDataManage('default')
    await manager.getAllClientKeyInfo()

    const saveGate = metadata.gateNextReplace()
    const saveA = manager.saveClientKeyInfo({
      clientId: 'device_a', key: 'SERVER_KEY_A_SENTINEL', deviceName: 'Desktop A', isMobile: false,
    })
    await saveGate.started
    const saveB = manager.saveClientKeyInfo({
      clientId: 'device_b', key: 'SERVER_KEY_B_SENTINEL', deviceName: 'Desktop B', isMobile: false,
    })
    await new Promise(resolve => setImmediate(resolve))
    const saveReplacementsBeforeRelease = metadata.getReplaceCalls()
    saveGate.release()
    await Promise.all([saveA, saveB])

    assert.equal(saveReplacementsBeforeRelease, 1)
    assert.deepEqual(Object.keys(metadata.read().clients).sort(), ['device_a', 'device_b'])
    assert.equal(vault.read({ kind: 'sync-server-device', userName: 'default', clientId: 'device_a' }).status, 'available')
    assert.equal(vault.read({ kind: 'sync-server-device', userName: 'default', clientId: 'device_b' }).status, 'available')

    const interleaveGate = metadata.gateNextReplace()
    const saveC = manager.saveClientKeyInfo({
      clientId: 'device_c', key: 'SERVER_KEY_C_SENTINEL', deviceName: 'Desktop C', isMobile: false,
    })
    await interleaveGate.started
    const removeA = manager.removeClientKeyInfo('device_a')
    await new Promise(resolve => setImmediate(resolve))
    const interleaveReplacementsBeforeRelease = metadata.getReplaceCalls()
    interleaveGate.release()
    await Promise.all([saveC, removeA])

    assert.equal(interleaveReplacementsBeforeRelease, 3)
    assert.deepEqual(Object.keys(metadata.read().clients).sort(), ['device_b', 'device_c'])
  })

  it('serializes replacement manager initialization with in-flight server mutations', async() => {
    const vault = createVault()
    const metadata = createGatedMetadataFile({ version: 2, userName: 'default', clients: {} })
    const serverData = loadTsModule(path.join(sourceRoot, 'main/modules/sync/server/user/data.ts'), {
      '@main/storage/atomicJsonFile': { createAtomicJsonFile: () => metadata.file },
      '@main/storage/credentials': { getCredentialVault: () => vault },
      '@main/storage/operationJournal': { createOperationJournal: createJournal },
    })
    global.lxDataPath = path.join(os.tmpdir(), 'lx-sync-server-manager-lifecycle')
    global.lx = {
      credentialVault: vault,
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'top' },
    }
    const firstManager = new serverData.UserDataManage('default')
    await firstManager.getAllClientKeyInfo()

    const saveGate = metadata.gateNextReplace()
    const firstSave = firstManager.saveClientKeyInfo({
      clientId: 'device_first', key: 'FIRST_MANAGER_KEY_1234567890', deviceName: 'First', isMobile: false,
    })
    await saveGate.started
    const readsAtBlockedCommit = metadata.getReadCalls()
    const replacementManager = new serverData.UserDataManage('default')
    const replacementSave = replacementManager.saveClientKeyInfo({
      clientId: 'device_replacement', key: 'REPLACEMENT_MANAGER_KEY_1234567890', deviceName: 'Replacement', isMobile: false,
    })
    await new Promise(resolve => setImmediate(resolve))
    const readsBeforeRelease = metadata.getReadCalls()
    saveGate.release()
    await Promise.all([firstSave, replacementSave])

    assert.deepEqual(Object.keys(metadata.read().clients).sort(), ['device_first', 'device_replacement'])
    assert.equal(readsBeforeRelease, readsAtBlockedCommit)
  })

  it('registers client and server credential flushers with the storage coordinator', async() => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lx-sync-flushers-'))
    const registrations = new Map()
    global.lxDataPath = root
    global.lx = {
      credentialVault: createVault(),
      storage: {
        registerShutdownFlusher(name, flush) {
          registrations.set(name, flush)
          return () => {}
        },
      },
      appSetting: { 'sync.server.maxSsnapshotNum': 3, 'list.addMusicLocationType': 'add_start' },
    }
    try {
      const clientData = freshRequire('../../src/main/modules/sync/client/data.ts')
      await clientData.setSyncAuthKey('server_a', {
        clientId: 'client_a',
        key: 'CLIENT_KEY_SENTINEL',
        serverName: 'Server',
      })
      const { UserDataManage } = freshRequire('../../src/main/modules/sync/server/user/data.ts')
      const manager = new UserDataManage('default')
      await manager.getAllClientKeyInfo()

      assert.deepEqual([...registrations.keys()].sort(), ['sync-client-credentials', 'sync-server-credentials'])
      await Promise.all([...registrations.values()].map(async flush => { await flush() }))
    } finally {
      await fsp.rm(root, { recursive: true, force: true })
    }
  })
})
