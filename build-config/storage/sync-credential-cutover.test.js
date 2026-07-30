const assert = require('node:assert/strict')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { after, describe, it } = require('node:test')
const typescript = require('typescript')

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
})
