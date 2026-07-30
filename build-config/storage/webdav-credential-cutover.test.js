const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')
const { after, beforeEach, describe, it } = require('node:test')
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
const originalLoad = Module._load
let requestImpl
const settingWrites = []

Module._resolveFilename = function(request, parent, isMain, options) {
  if (request.startsWith('@main/')) {
    request = path.join(sourceRoot, 'main', request.slice('@main/'.length))
  }
  if (request.startsWith('@common/')) {
    request = path.join(sourceRoot, 'common', request.slice('@common/'.length))
  }
  return originalResolveFilename.call(this, request, parent, isMain, options)
}

Module._load = function(request, parent, isMain) {
  if (request == 'undici') {
    return { request: (...args) => requestImpl(...args) }
  }
  if (request == '@common/utils/lyricUtils/kg') {
    return { decodeKrc: () => ({ lyric: '' }) }
  }
  if (request == 'electron') {
    return {
      nativeTheme: {},
      powerSaveBlocker: {},
    }
  }
  if (request == '@main/utils/store') {
    return () => ({
      override(value) {
        settingWrites.push(value)
      },
    })
  }
  return originalLoad.call(this, request, parent, isMain)
}

after(() => {
  Module._resolveFilename = originalResolveFilename
  Module._load = originalLoad
  // eslint-disable-next-line n/no-deprecated-api
  delete require.extensions['.ts']
})

const deferred = () => {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, resolve: release }
}

const createVault = (initial, persistence = 'encrypted') => {
  let credential = initial
  let writeGate = null
  let removeGate = null
  let verifyResult = true
  const writes = []
  const removes = []
  const vault = {
    mode: persistence,
    read() {
      return credential == null
        ? { status: 'missing' }
        : { status: persistence == 'encrypted' ? 'available' : 'memory-only', value: { ...credential } }
    },
    async write(ref, value) {
      writes.push({ ref, value: { ...value } })
      if (writeGate) await writeGate.promise
      credential = { ...value }
      return { persistence }
    },
    async verify() {
      return verifyResult
    },
    async remove(ref) {
      removes.push(ref)
      if (removeGate) await removeGate.promise
      credential = null
    },
  }
  return {
    vault,
    writes,
    removes,
    setWriteGate(gate) { writeGate = gate },
    setRemoveGate(gate) { removeGate = gate },
    failVerification() { verifyResult = false },
  }
}

const emptyPropfindResponse = () => ({
  statusCode: 207,
  headers: {},
  body: {
    text: async() => '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>',
    dump: async() => {},
  },
})

describe('WebDAV credential cutover', () => {
  beforeEach(() => {
    settingWrites.length = 0
    requestImpl = async() => emptyPropfindResponse()
    global.envParams = { cmdParams: {} }
    global.lx = {
      appSetting: {
        'webdav.url': 'https://settings.example.test/dav',
        'webdav.username': 'SETTINGS_USER_SENTINEL',
        'webdav.password': 'SETTINGS_PASS_SENTINEL',
      },
    }
  })

  it('drops credential keys from every ordinary settings write and rejects non-empty runtime values', () => {
    const { sanitizeSettingUpdate, updateSetting } = require('../../src/main/utils/index.ts')
    const sanitized = sanitizeSettingUpdate({
      'webdav.url': 'https://example.test/dav',
      'webdav.username': 'USER_SENTINEL',
      'webdav.password': 'PASS_SENTINEL',
    })

    assert.deepEqual(sanitized, { 'webdav.url': 'https://example.test/dav' })
    assert.throws(() => updateSetting({ 'webdav.username': 'USER_SENTINEL' }), /WebDAV credentials/i)
    assert.throws(() => updateSetting({ 'webdav.password': 'PASS_SENTINEL' }), /WebDAV credentials/i)
    assert.deepEqual(settingWrites, [])
  })

  it('returns only a masked WebDAV credential status', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const { vault } = createVault({ version: 1, username: 'alice', password: 'PASS_SENTINEL' })
    const service = createWebDAVCredentialService(vault)

    const status = await service.getCredentialStatus()

    assert.deepEqual(status, {
      configured: true,
      usernameHint: 'a***e',
      persistence: 'encrypted',
    })
    assert.doesNotMatch(JSON.stringify(status), /PASS_SENTINEL/)
  })

  it('awaits and verifies credential writes before reporting success', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const controlled = createVault(null)
    const gate = deferred()
    controlled.setWriteGate(gate)
    const service = createWebDAVCredentialService(controlled.vault)
    let settled = false

    const saving = service.setCredentials({ username: 'alice', password: 'PASS_SENTINEL' }).then(result => {
      settled = true
      return result
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    gate.resolve()
    assert.deepEqual(await saving, { persistence: 'encrypted' })
    assert.deepEqual(await service.getCredentialStatus(), {
      configured: true,
      usernameHint: 'a***e',
      persistence: 'encrypted',
    })

    const unverified = createVault(null)
    unverified.failVerification()
    await assert.rejects(
      createWebDAVCredentialService(unverified.vault).setCredentials({ username: 'alice', password: 'PASS_SENTINEL' }),
      /verif/i,
    )
  })

  it('awaits credential removal and verifies the readback before resolving', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const controlled = createVault({ version: 1, username: 'alice', password: 'PASS_SENTINEL' })
    const gate = deferred()
    controlled.setRemoveGate(gate)
    const service = createWebDAVCredentialService(controlled.vault)
    let settled = false

    const removing = service.removeCredentials().then(() => { settled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(settled, false)
    gate.resolve()
    await removing

    assert.deepEqual(await service.getCredentialStatus(), {
      configured: false,
      usernameHint: null,
      persistence: 'missing',
    })
  })

  it('builds normal configured access from the ordinary URL and vault credentials', () => {
    const { getConfiguredWebDAV } = require('../../src/main/modules/webdav.ts')
    const { vault } = createVault({ version: 1, username: 'vault-user', password: 'VAULT_PASS_SENTINEL' })
    global.lx.credentialVault = vault

    assert.deepEqual(getConfiguredWebDAV(), {
      url: 'https://settings.example.test/dav',
      username: 'vault-user',
      password: 'VAULT_PASS_SENTINEL',
    })
  })

  it('strictly validates transient test credentials without writing them to the vault', async() => {
    const { testWebDAV } = require('../../src/main/modules/webdav.ts')
    const controlled = createVault(null)
    global.lx.credentialVault = controlled.vault
    let requests = 0
    requestImpl = async() => {
      requests++
      return emptyPropfindResponse()
    }

    await testWebDAV({
      url: 'https://transient.example.test/dav',
      username: 'transient-user',
      password: 'TRANSIENT_PASS_SENTINEL',
    })

    assert.equal(requests, 1)
    assert.deepEqual(controlled.writes, [])
    await assert.rejects(testWebDAV({
      url: 'https://transient.example.test/dav',
      username: 'transient-user',
      password: 'TRANSIENT_PASS_SENTINEL',
      extra: true,
    }), /WebDAV test config/i)
    assert.equal(requests, 1)
  })

  it('does not let ordinary list params override vault credentials at runtime', async() => {
    const { listWebDAVMusics } = require('../../src/main/modules/webdav.ts')
    const { vault } = createVault({ version: 1, username: 'vault-user', password: 'VAULT_PASS_SENTINEL' })
    global.lx.credentialVault = vault
    let authorization
    requestImpl = async(_url, options) => {
      authorization = options.headers.Authorization
      return emptyPropfindResponse()
    }

    await listWebDAVMusics({
      url: 'https://override.example.test/dav',
      username: 'OVERRIDE_USER_SENTINEL',
      password: 'OVERRIDE_PASS_SENTINEL',
    })

    assert.equal(authorization, `Basic ${Buffer.from('vault-user:VAULT_PASS_SENTINEL').toString('base64')}`)
  })
})
