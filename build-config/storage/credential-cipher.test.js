const assert = require('node:assert/strict')
const fs = require('node:fs')
const { describe, it } = require('node:test')
const typescript = require('typescript')

// eslint-disable-next-line n/no-deprecated-api
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8')
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      target: typescript.ScriptTarget.ESNext,
      module: typescript.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
  }).outputText
  module._compile(output, filename)
}

const cipherPath = '../../src/main/storage/credentials/safeStorageCipher.ts'
const typesPath = '../../src/main/storage/credentials/types.ts'

const fakeSafeStorage = ({ available, backend, platform = 'win32' }) => ({
  safeStorage: {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: plaintext => Buffer.from(`encrypted:${plaintext}`),
    decryptString: ciphertext => ciphertext.toString().replace('encrypted:', ''),
  },
  platform,
})

describe('credential cipher', () => {
  it('uses encrypted persistence only when the backend is secure', () => {
    const { createCredentialCipher } = require(cipherPath)

    assert.equal(createCredentialCipher(fakeSafeStorage({ available: true, backend: 'kwallet' })).mode, 'encrypted')
    assert.equal(createCredentialCipher(fakeSafeStorage({ available: false })).mode, 'memory-only')
    assert.equal(createCredentialCipher(fakeSafeStorage({ available: true, backend: 'basic_text', platform: 'linux' })).mode, 'memory-only')
  })

  it('derives stable non-secret entry ids', () => {
    const { toCredentialEntryId } = require(typesPath)

    assert.equal(toCredentialEntryId({ kind: 'netease-cookie' }), 'netease-cookie')
    assert.equal(
      toCredentialEntryId({ kind: 'sync-server-device', userName: 'alice', clientId: 'desktop-1' }),
      'sync-server-device:alice:desktop-1',
    )
    assert.throws(() => toCredentialEntryId({ kind: 'sync-server-device', userName: '../x', clientId: 'a' }))
    assert.throws(() => toCredentialEntryId({ kind: '../x' }))
  })

  it('accepts only canonical standard Base64 sync identifiers', () => {
    const { toCredentialEntryId } = require(typesPath)
    const standardBase64Ids = ['MDEyMzQ1Njc4OWFiY2RlZg==', '+/v7+/v7+/v7+/v7+/v7+w==']
    for (const standardBase64Id of standardBase64Ids) {
      assert.equal(
        toCredentialEntryId({ kind: 'sync-client', serverId: standardBase64Id }),
        `sync-client:${standardBase64Id}`,
      )
      assert.equal(
        toCredentialEntryId({ kind: 'sync-server-device', userName: 'default', clientId: standardBase64Id }),
        `sync-server-device:default:${standardBase64Id}`,
      )
    }
    for (const invalidId of [
      '../x',
      'MDEyMzQ1Njc4OWFiY2RlZg=',
      'MDEyMzQ1Njc4OWFiY2RlZg===',
      'MDEyMzQ1Njc4OWFiY2RlZg==junk',
      'MDEyMzQ1Njc4OWFiY2RlZg==/',
    ]) {
      assert.throws(() => toCredentialEntryId({ kind: 'sync-client', serverId: invalidId }))
      assert.throws(() => toCredentialEntryId({ kind: 'sync-server-device', userName: 'default', clientId: invalidId }))
    }
    assert.throws(() => toCredentialEntryId({ kind: 'sync-server-device', userName: '../x', clientId: standardBase64Ids[0] }))
  })

  it('validates credential payload bounds before vault persistence', () => {
    const { assertCookieCredential, assertSyncKeyCredential, assertWebDAVCredential } = require(typesPath)

    assert.equal(assertCookieCredential('cookie=value'), 'cookie=value')
    assert.equal(assertSyncKeyCredential('sync-key'), 'sync-key')
    assert.deepEqual(assertWebDAVCredential({ version: 1, username: 'alice', password: 'secret' }), {
      version: 1,
      username: 'alice',
      password: 'secret',
    })
    assert.throws(() => assertCookieCredential(''))
    assert.throws(() => assertSyncKeyCredential('x'.repeat(64 * 1024 + 1)))
    assert.throws(() => assertWebDAVCredential({ version: 1, username: 'x'.repeat(4 * 1024 + 1), password: 'secret' }))
  })

  it('measures credential payload limits as UTF-8 bytes', () => {
    const { assertCookieCredential, assertSyncKeyCredential, assertWebDAVCredential } = require(typesPath)
    const maxCookie = '😀'.repeat(16 * 1024)
    const maxWebDAVField = '😀'.repeat(1024)

    assert.equal(assertCookieCredential(maxCookie), maxCookie)
    assert.throws(() => assertSyncKeyCredential('😀'.repeat(16 * 1024 + 1)))
    assert.deepEqual(assertWebDAVCredential({ version: 1, username: maxWebDAVField, password: maxWebDAVField }), {
      version: 1,
      username: maxWebDAVField,
      password: maxWebDAVField,
    })
    assert.throws(() => assertWebDAVCredential({ version: 1, username: '😀'.repeat(1024 + 1), password: 'secret' }))
  })

  it('checks storage availability before each cryptographic operation', () => {
    const { createCredentialCipher } = require(cipherPath)
    let available = true
    let encryptCalls = 0
    let decryptCalls = 0
    const cipher = createCredentialCipher({
      safeStorage: {
        isEncryptionAvailable: () => available,
        getSelectedStorageBackend: () => 'kwallet',
        encryptString: () => {
          encryptCalls += 1
          return Buffer.from('encrypted')
        },
        decryptString: () => {
          decryptCalls += 1
          return 'plain'
        },
      },
      platform: 'linux',
    })

    available = false
    assert.throws(() => cipher.encrypt('secret'))
    assert.throws(() => cipher.decrypt(Buffer.from('encrypted')))
    assert.equal(encryptCalls, 0)
    assert.equal(decryptCalls, 0)
  })

  it('does not promote a memory-only cipher when its backend later becomes available', () => {
    const { createCredentialCipher } = require(cipherPath)
    let available = false
    let encryptCalls = 0
    const cipher = createCredentialCipher({
      safeStorage: {
        isEncryptionAvailable: () => available,
        encryptString: () => {
          encryptCalls += 1
          return Buffer.from('encrypted')
        },
        decryptString: () => 'plain',
      },
    })

    available = true
    assert.equal(cipher.mode, 'memory-only')
    assert.throws(() => cipher.encrypt('secret'))
    assert.equal(encryptCalls, 0)
  })
})
