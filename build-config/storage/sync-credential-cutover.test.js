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

    await service.startServer(9527)
    runtime.connect(socket, { url: '/?i=device_a' })
    await connected
    const status = service.getStatus()
    await service.stopServer()

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
})
