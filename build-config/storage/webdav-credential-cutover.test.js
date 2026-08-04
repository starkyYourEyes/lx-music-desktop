const assert = require('node:assert/strict')
const fs = require('node:fs')
const Module = require('node:module')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Readable, Writable } = require('node:stream')
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
let serverRequestListener
const settingWrites = []
let settingsDocument

const settingsStore = {
  get(key) {
    return settingsDocument[key]
  },
  has(key) {
    return Object.hasOwn(settingsDocument, key)
  },
  override(value) {
    settingsDocument = structuredClone(value)
    settingWrites.push(structuredClone(value))
  },
}

class TestHttpServer extends EventEmitter {
  constructor(listener) {
    super()
    serverRequestListener = listener
    this.listening = false
  }

  listen() {
    this.listening = true
    queueMicrotask(() => this.emit('listening'))
  }

  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: 43123 }
  }

  close() {
    this.listening = false
    this.emit('close')
  }
}

class TestServerResponse extends Writable {
  constructor() {
    super()
    this.headersSent = false
    this.statusCode = null
  }

  _write(_chunk, _encoding, callback) {
    callback()
  }

  writeHead(statusCode) {
    this.statusCode = statusCode
    this.headersSent = true
    return this
  }
}

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
  if (request == 'node:http') {
    return { createServer: listener => new TestHttpServer(listener) }
  }
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
    return () => settingsStore
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
    passVerification() { verifyResult = true },
  }
}

const createControlledRealVault = async() => {
  const { createCredentialVault } = require('../../src/main/storage/credentials/credentialVault.ts')
  let document = null
  let nextReplaceGate = null
  let nextReplaceStarted = null
  const file = {
    async read() {
      return document == null ? null : JSON.parse(JSON.stringify(document))
    },
    async replace(value) {
      const gate = nextReplaceGate
      const started = nextReplaceStarted
      nextReplaceGate = null
      nextReplaceStarted = null
      started?.resolve()
      if (gate) await gate.promise
      document = JSON.parse(JSON.stringify(value))
    },
    async flush() {},
  }
  const vault = await createCredentialVault({
    profileRoot: 'unused',
    file,
    cipher: {
      mode: 'encrypted',
      encrypt: plaintext => Buffer.from(plaintext),
      decrypt: ciphertext => ciphertext.toString(),
    },
  })
  return {
    vault,
    blockNextReplace() {
      nextReplaceGate = deferred()
      nextReplaceStarted = deferred()
      return {
        started: nextReplaceStarted.promise,
        release: nextReplaceGate.resolve,
      }
    },
  }
}

const responseBody = (content = '') => {
  const buffer = Buffer.from(content)
  const body = Readable.from([buffer])
  body.dump = async() => {}
  body.text = async() => content
  body.arrayBuffer = async() => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
  return body
}

const emptyPropfindResponse = () => ({
  statusCode: 207,
  headers: {},
  body: {
    text: async() => '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>',
    dump: async() => {},
  },
})

const createWebDAVMusic = (overrides = {}) => ({
  id: 'webdav_song',
  name: 'Song',
  singer: 'Singer',
  source: 'webdav',
  interval: null,
  username: 'RENDERER_USER_SENTINEL',
  password: 'RENDERER_PASS_SENTINEL',
  meta: {
    songId: 'song.mp3',
    albumName: '',
    picUrl: null,
    url: 'https://settings.example.test/dav',
    path: 'song.mp3',
    fileName: 'song.mp3',
    ext: 'mp3',
    title: null,
    artist: null,
    album: null,
    albumArtist: null,
    year: null,
    genre: null,
    hasEmbeddedPic: false,
    embeddedLyric: null,
    lyricPath: 'song.lrc',
    krcPath: null,
    picPath: 'song.jpg',
    username: 'RENDERER_META_USER_SENTINEL',
    password: 'RENDERER_META_PASS_SENTINEL',
    ...overrides,
  },
})

describe('WebDAV credential cutover', () => {
  beforeEach(() => {
    settingWrites.length = 0
    settingsDocument = {
      storageSchemaVersion: 1,
      version: '2.1.0',
      setting: {
        version: '2.1.0',
        'webdav.url': 'https://settings.example.test/dav',
      },
      catalogPreferences: {
        version: 1,
        leaderboard: { source: 'kw', boardId: 'kw__16' },
        songList: { source: 'kw', sortId: 'new', tagId: '' },
        search: { temp_source: 'kw', source: 'all', type: 'music' },
      },
    }
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

  it('persists a complete secret-free snapshot after a successful ordinary settings write', () => {
    const { updateSetting } = require('../../src/main/utils/index.ts')

    updateSetting({ 'webdav.url': 'https://safe.example.test/dav' })

    assert.equal(settingWrites.length, 1)
    assert.equal(settingWrites[0].setting['webdav.url'], 'https://safe.example.test/dav')
    assert.equal(Object.hasOwn(settingWrites[0].setting, 'webdav.username'), false)
    assert.equal(Object.hasOwn(settingWrites[0].setting, 'webdav.password'), false)
    assert.doesNotMatch(JSON.stringify(settingWrites[0]), /SETTINGS_(?:USER|PASS)_SENTINEL/)
  })

  it('keeps a full default config unconfigured on first and second launch', async() => {
    const { updateSetting } = require('../../src/main/utils/index.ts')
    const { collectLegacyCredentialInventory } = require('../../src/main/migration/credentials/legacySources.ts')
    const defaultSetting = require('../../src/common/defaultSetting.ts').default
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-webdav-default-relaunch-'))
    try {
      const firstLaunch = updateSetting({ ...defaultSetting }, true)
      const persisted = settingWrites.at(-1)
      assert.equal(Object.hasOwn(persisted.setting, 'webdav.username'), false)
      assert.equal(Object.hasOwn(persisted.setting, 'webdav.password'), false)
      fs.writeFileSync(path.join(root, 'config_v2.json'), JSON.stringify(persisted))

      assert.deepEqual((await collectLegacyCredentialInventory(root)).credentials, [])
      assert.deepEqual((await collectLegacyCredentialInventory(root)).credentials, [])
      assert.equal(firstLaunch.setting['webdav.username'], '')
      assert.equal(firstLaunch.setting['webdav.password'], '')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects URL userinfo from runtime settings without persisting or echoing it', () => {
    const { updateSetting } = require('../../src/main/utils/index.ts')
    const url = 'https://URL_USER_SENTINEL:URL_PASS_SENTINEL@example.test/dav'

    assert.throws(
      () => updateSetting({ 'webdav.url': url }),
      error => !JSON.stringify(error).includes('URL_USER_SENTINEL') &&
        !JSON.stringify(error).includes('URL_PASS_SENTINEL') && /WebDAV URL/i.test(error.message),
    )
    assert.deepEqual(settingWrites, [])
  })

  it('rejects URL userinfo from initialization without rewriting or publishing it', () => {
    const { updateSetting } = require('../../src/main/utils/index.ts')
    const defaultSetting = require('../../src/common/defaultSetting.ts').default
    const input = {
      ...defaultSetting,
      'webdav.url': 'https://INIT_USER_SENTINEL:INIT_PASS_SENTINEL@example.test/dav',
      'webdav.username': '',
      'webdav.password': '',
    }

    assert.throws(
      () => updateSetting(input, true),
      error => !JSON.stringify(error).includes('INIT_USER_SENTINEL') &&
        !JSON.stringify(error).includes('INIT_PASS_SENTINEL') && /WebDAV URL/i.test(error.message),
    )
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

  it('returns secret-free status for every persistence state and unsafe username shape', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const cases = [
      {
        read: { status: 'available', value: { version: 1, username: 'alice', password: 'ASCII_PASS_SENTINEL' } },
        expected: { configured: true, usernameHint: 'a***e', persistence: 'encrypted' },
      },
      {
        read: { status: 'memory-only', value: { version: 1, username: 'bob', password: 'MEMORY_PASS_SENTINEL' } },
        expected: { configured: true, usernameHint: 'b***b', persistence: 'memory-only' },
      },
      {
        read: { status: 'available', value: { version: 1, username: '\u{1f600}user', password: 'ASTRAL_PASS_SENTINEL' } },
        expected: { configured: true, usernameHint: '***', persistence: 'encrypted' },
      },
      {
        read: { status: 'available', value: { version: 1, username: 'e\u0301mail', password: 'COMBINING_PASS_SENTINEL' } },
        expected: { configured: true, usernameHint: '***', persistence: 'encrypted' },
      },
      {
        read: { status: 'available', value: { version: 1, username: 'a', password: 'SHORT_PASS_SENTINEL' } },
        expected: { configured: true, usernameHint: '***', persistence: 'encrypted' },
      },
      {
        read: { status: 'missing' },
        expected: { configured: false, usernameHint: null, persistence: 'missing' },
      },
      {
        read: { status: 'undecryptable' },
        expected: {
          configured: false,
          usernameHint: null,
          persistence: 'missing',
          unavailableReason: 'credential_undecryptable',
        },
      },
    ]

    for (const testCase of cases) {
      const vault = { read: () => testCase.read }
      const status = await createWebDAVCredentialService(vault).getCredentialStatus()
      assert.deepEqual(status, testCase.expected)
      const serialized = JSON.stringify(status)
      if ('value' in testCase.read) {
        assert.notEqual(status.usernameHint, testCase.read.value.username)
        assert.doesNotMatch(serialized, /PASS_SENTINEL/)
      }
      assert.doesNotMatch(serialized, /[\uD800-\uDFFF]/u)
    }
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

  it('serializes overlapping set and remove calls in invocation order', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const controlled = createVault(null)
    const writeGate = deferred()
    controlled.setWriteGate(writeGate)
    const service = createWebDAVCredentialService(controlled.vault)
    let removeSettled = false

    const saving = service.setCredentials({ username: 'first', password: 'FIRST_PASS_SENTINEL' })
    await new Promise(resolve => setImmediate(resolve))
    const removing = service.removeCredentials().then(() => { removeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(removeSettled, false)
    writeGate.resolve()
    await Promise.all([saving, removing])
    assert.deepEqual(await service.getCredentialStatus(), {
      configured: false,
      usernameHint: null,
      persistence: 'missing',
    })

    const reverse = createVault({ version: 1, username: 'old', password: 'OLD_PASS_SENTINEL' })
    const removeGate = deferred()
    reverse.setRemoveGate(removeGate)
    const reverseService = createWebDAVCredentialService(reverse.vault)
    let saveSettled = false
    const firstRemove = reverseService.removeCredentials()
    await new Promise(resolve => setImmediate(resolve))
    const laterSave = reverseService.setCredentials({ username: 'later', password: 'LATER_PASS_SENTINEL' }).then(result => {
      saveSettled = true
      return result
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(saveSettled, false)
    removeGate.resolve()
    await Promise.all([firstRemove, laterSave])
    assert.deepEqual(await reverseService.getCredentialStatus(), {
      configured: true,
      usernameHint: 'l***r',
      persistence: 'encrypted',
    })
  })

  it('makes a later remove win over an overlapping write in the real vault', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const controlled = await createControlledRealVault()
    const service = createWebDAVCredentialService(controlled.vault)
    const gate = controlled.blockNextReplace()
    let removeSettled = false

    const saving = service.setCredentials({ username: 'alice', password: 'REAL_PASS_SENTINEL' })
    await gate.started
    const removing = service.removeCredentials().then(() => { removeSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(removeSettled, false)
    gate.release()
    await Promise.all([saving, removing])

    assert.deepEqual(controlled.vault.read({ kind: 'webdav-basic' }), { status: 'missing' })
  })

  it('continues queued mutations after an earlier verification failure', async() => {
    const { createWebDAVCredentialService } = require('../../src/main/modules/webdav.ts')
    const controlled = createVault(null)
    controlled.failVerification()
    const service = createWebDAVCredentialService(controlled.vault)
    await assert.rejects(service.setCredentials({ username: 'first', password: 'FIRST_PASS_SENTINEL' }), /verif/i)
    controlled.passVerification()

    await service.setCredentials({ username: 'later', password: 'LATER_PASS_SENTINEL' })

    assert.deepEqual(await service.getCredentialStatus(), {
      configured: true,
      usernameHint: 'l***r',
      persistence: 'encrypted',
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

  it('rejects URL userinfo from configured and list override paths without a request', async() => {
    const { getConfiguredWebDAV, listWebDAVMusics } = require('../../src/main/modules/webdav.ts')
    const { vault } = createVault({ version: 1, username: 'vault-user', password: 'VAULT_PASS_SENTINEL' })
    global.lx.credentialVault = vault
    global.lx.appSetting['webdav.url'] = 'https://CONFIG_USER_SENTINEL:CONFIG_PASS_SENTINEL@example.test/dav'
    let requests = 0
    requestImpl = async() => { requests++; return emptyPropfindResponse() }

    assert.throws(
      () => getConfiguredWebDAV(),
      error => !JSON.stringify(error).includes('CONFIG_PASS_SENTINEL') && /WebDAV URL/i.test(error.message),
    )
    global.lx.appSetting['webdav.url'] = 'https://settings.example.test/dav'
    await assert.rejects(
      listWebDAVMusics({ url: 'https://OVERRIDE_USER_SENTINEL:OVERRIDE_PASS_SENTINEL@example.test/dav' }),
      error => !JSON.stringify(error).includes('OVERRIDE_PASS_SENTINEL') && /WebDAV URL/i.test(error.message),
    )
    assert.equal(requests, 0)
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
    const invalidInputs = [
      Object.assign(Object.create(null), {
        url: 'https://transient.example.test/dav',
        username: 'transient-user',
        password: 'TRANSIENT_PASS_SENTINEL',
      }),
      {
        url: 'https://transient.example.test/dav',
        username: 'transient-user',
        password: 'TRANSIENT_PASS_SENTINEL',
        extra: true,
      },
      { url: '', username: 'transient-user', password: 'TRANSIENT_PASS_SENTINEL' },
      { url: 'https://transient.example.test/dav', username: '', password: 'TRANSIENT_PASS_SENTINEL' },
      { url: 'https://transient.example.test/dav', username: 'transient-user', password: '' },
      { url: 'not-a-url', username: 'transient-user', password: 'TRANSIENT_PASS_SENTINEL' },
      { url: 'https://URL_USER_SENTINEL:URL_PASS_SENTINEL@example.test/dav', username: 'transient-user', password: 'TRANSIENT_PASS_SENTINEL' },
      { url: `https://example.test/${'a'.repeat(8 * 1024)}`, username: 'transient-user', password: 'TRANSIENT_PASS_SENTINEL' },
      { url: 'https://transient.example.test/dav', username: 'u'.repeat(4 * 1024 + 1), password: 'TRANSIENT_PASS_SENTINEL' },
      { url: 'https://transient.example.test/dav', username: 'transient-user', password: 'p'.repeat(4 * 1024 + 1) },
    ]
    for (const input of invalidInputs) {
      await assert.rejects(
        testWebDAV(input),
        error => error.message == 'Invalid WebDAV test config' &&
          !JSON.stringify(error).includes('URL_PASS_SENTINEL') &&
          !JSON.stringify(error).includes('TRANSIENT_PASS_SENTINEL'),
      )
    }
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

  it('uses vault credentials across list, play, picture, lyric, and upload paths', async() => {
    const {
      getWebDAVMusicLyric,
      getWebDAVMusicPic,
      getWebDAVMusicUrl,
      listWebDAVMusics,
      uploadLocalMusicToWebDAV,
    } = require('../../src/main/modules/webdav.ts')
    const { vault } = createVault({ version: 1, username: 'vault-user', password: 'VAULT_PASS_SENTINEL' })
    global.lx.credentialVault = vault
    const authorizations = []
    requestImpl = async(_url, options) => {
      authorizations.push(options.headers.Authorization)
      if (typeof options.body?.resume == 'function') {
        await new Promise((resolve, reject) => {
          options.body.once('end', resolve).once('error', reject).resume()
        })
      }
      const method = options.method
      return {
        statusCode: method == 'PROPFIND' ? 207 : method == 'GET' ? 200 : 201,
        headers: { 'content-type': method == 'GET' ? 'text/plain' : undefined },
        body: responseBody(method == 'PROPFIND' ? '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"/>' : 'content'),
      }
    }
    const musicInfo = createWebDAVMusic()

    await listWebDAVMusics({
      username: 'RENDERER_USER_SENTINEL',
      password: 'RENDERER_PASS_SENTINEL',
    })
    const streamUrl = await getWebDAVMusicUrl(musicInfo)
    const streamResponse = new TestServerResponse()
    const streamed = new Promise((resolve, reject) => streamResponse.once('finish', resolve).once('error', reject))
    serverRequestListener({ url: new URL(streamUrl).pathname, headers: {} }, streamResponse)
    await streamed
    await getWebDAVMusicPic(musicInfo)
    await getWebDAVMusicLyric(musicInfo)

    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-webdav-cutover-'))
    const localPath = path.join(localRoot, 'song.mp3')
    fs.writeFileSync(localPath, 'audio')
    global.lx.appSetting['localMusic.dirs'] = [localRoot]
    global.lx.appSetting['localMusic.webdavDir'] = 'local-music'
    try {
      await uploadLocalMusicToWebDAV({
        musicInfo: {
          id: localPath,
          name: 'Song',
          singer: 'Singer',
          source: 'local',
          interval: null,
          username: 'RENDERER_USER_SENTINEL',
          password: 'RENDERER_PASS_SENTINEL',
          meta: {
            songId: localPath,
            albumName: '',
            filePath: localPath,
            ext: 'mp3',
          },
        },
        webdavDir: 'local-music',
        username: 'RENDERER_USER_SENTINEL',
        password: 'RENDERER_PASS_SENTINEL',
      })
    } finally {
      fs.rmSync(localRoot, { recursive: true, force: true })
    }

    const expected = `Basic ${Buffer.from('vault-user:VAULT_PASS_SENTINEL').toString('base64')}`
    assert.ok(authorizations.length >= 6)
    assert.ok(authorizations.every(value => value == expected))
    assert.doesNotMatch(JSON.stringify(authorizations), /RENDERER_(?:META_)?(?:USER|PASS)_SENTINEL/)
  })

  it('logs only fixed diagnostics when an authenticated dependency exposes secrets', async() => {
    const { uploadLocalMusicToWebDAV } = require('../../src/main/modules/webdav.ts')
    const { vault } = createVault({ version: 1, username: 'vault-user', password: 'VAULT_PASS_SENTINEL' })
    global.lx.credentialVault = vault
    requestImpl = async() => {
      throw new Error('https://LOG_USER_SENTINEL:LOG_PASS_SENTINEL@example.test/dav')
    }
    const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-webdav-diagnostic-'))
    const localPath = path.join(localRoot, 'song.mp3')
    fs.writeFileSync(localPath, 'audio')
    global.lx.appSetting['localMusic.dirs'] = [localRoot]
    global.lx.appSetting['localMusic.webdavDir'] = 'local-music'
    const diagnostics = []
    const originals = { log: console.log, warn: console.warn, error: console.error }
    console.log = (...args) => { diagnostics.push(args.map(String).join(' ')) }
    console.warn = (...args) => { diagnostics.push(args.map(String).join(' ')) }
    console.error = (...args) => { diagnostics.push(args.map(String).join(' ')) }
    try {
      await assert.rejects(uploadLocalMusicToWebDAV({
        musicInfo: {
          id: localPath,
          name: 'Song',
          singer: 'Singer',
          source: 'local',
          interval: null,
          meta: { songId: localPath, albumName: '', filePath: localPath, ext: 'mp3' },
        },
        webdavDir: 'local-music',
      }), /WebDAV MKCOL failed/)
    } finally {
      Object.assign(console, originals)
      fs.rmSync(localRoot, { recursive: true, force: true })
    }

    assert.ok(diagnostics.length > 0)
    assert.doesNotMatch(JSON.stringify(diagnostics), /LOG_(?:USER|PASS)_SENTINEL/)
  })
})
