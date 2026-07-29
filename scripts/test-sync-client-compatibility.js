const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('./test-utils/load-ts-module')
const { PROJECT_IDENTITY } = require('../src/common/projectIdentity')
const {
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
} = require('../src/common/syncProtocol')

const root = path.resolve(__dirname, '..')
const syncConstants = loadTsModule(path.join(root, 'src/common/constants_sync.ts'), {
  './projectIdentity': { PROJECT_IDENTITY },
})
const urlInfo = {
  httpProtocol: 'http:',
  wsProtocol: 'ws:',
  hostPath: 'sync.test',
  href: 'http://sync.test',
}

const loadClientAuth = ({
  keyInfo = null,
  authenticate,
  rsaDecrypt = () => Buffer.from(JSON.stringify({
    clientId: 'client-id',
    key: 'client-key',
    serverName: 'Test Server',
  })),
}) => {
  const attempts = []
  const saved = []
  const request = async(url, options = {}) => {
    const pathname = new URL(url).pathname
    if (pathname === '/hello') return { text: syncConstants.SYNC_CODE.helloMsg, code: 200 }
    if (pathname === '/id') return { text: `${syncConstants.SYNC_CODE.idPrefix}server-id`, code: 200 }
    attempts.push(options.headers)
    return authenticate(options.headers, attempts.length)
  }
  const handleAuth = loadTsModule(path.join(root, 'src/main/modules/sync/client/auth.ts'), {
    './utils': {
      request,
      generateRsaKey: async() => ({
        publicKey: '-----BEGIN PUBLIC KEY-----\ntest-key\n-----END PUBLIC KEY-----',
        privateKey: 'test-private-key',
      }),
    },
    './data': {
      getSyncAuthKey: async() => keyInfo,
      setSyncAuthKey: async(serverId, info) => saved.push({ serverId, info }),
    },
    '../log': { error() {} },
    '../utils': {
      aesEncrypt: text => text,
      aesDecrypt: text => text,
      getComputerName: () => 'Test Client',
      rsaDecrypt,
    },
    '@common/utils/nodejs': {
      toMD5: value => createHash('md5').update(value).digest('hex'),
    },
    '@common/constants_sync': syncConstants,
    '@common/projectIdentity': { PROJECT_IDENTITY },
    '@common/syncProtocol': require('../src/common/syncProtocol'),
  }).default
  return { handleAuth, attempts, saved }
}

test('code authentication keeps current protocol when the first attempt succeeds', async() => {
  const harness = loadClientAuth({
    authenticate: async() => ({ text: 'rsa-response', code: 200 }),
  })
  const info = await harness.handleAuth(urlInfo, '123456')
  assert.equal(harness.attempts.length, 1)
  assert.match(harness.attempts[0].m, new RegExp(`^${CURRENT_SYNC_PROTOCOL.syncAuthPrefix}`))
  assert.equal(info.syncProtocol, 'current')
  assert.equal(harness.saved.at(-1).info.syncProtocol, 'current')
})

test('code authentication falls back from current to legacy and persists it', async() => {
  const harness = loadClientAuth({
    authenticate: async({ m }) => m.startsWith(CURRENT_SYNC_PROTOCOL.syncAuthPrefix)
      ? { text: syncConstants.SYNC_CODE.authFailed, code: 401 }
      : { text: 'rsa-response', code: 200 },
  })
  const info = await harness.handleAuth(urlInfo, '123456')
  assert.deepEqual(
    harness.attempts.map(({ m }) => m.split('\n')[0]),
    [CURRENT_SYNC_PROTOCOL.syncAuthPrefix, LEGACY_SYNC_PROTOCOL.syncAuthPrefix],
  )
  assert.equal(info.syncProtocol, 'legacy')
  assert.equal(harness.saved.at(-1).info.syncProtocol, 'legacy')
})

test('client does not downgrade after a blocked response', async() => {
  const harness = loadClientAuth({
    authenticate: async() => ({ text: syncConstants.SYNC_CODE.msgBlockedIp, code: 403 }),
  })
  await assert.rejects(
    harness.handleAuth(urlInfo, '123456'),
    new RegExp(syncConstants.SYNC_CODE.msgBlockedIp),
  )
  assert.equal(harness.attempts.length, 1)
})

test('client does not downgrade after a malformed successful response', async() => {
  const harness = loadClientAuth({
    authenticate: async() => ({ text: 'malformed-response', code: 200 }),
    rsaDecrypt: () => { throw new Error('malformed RSA response') },
  })
  await assert.rejects(
    harness.handleAuth(urlInfo, '123456'),
    new RegExp(syncConstants.SYNC_CODE.authFailed),
  )
  assert.equal(harness.attempts.length, 1)
})

for (const [description, decryptedPayload] of [
  ['invalid JSON', '{'],
  ['a null value', 'null'],
  ['an empty object', '{}'],
  ['a non-string clientId', '{"clientId":1,"key":"client-key","serverName":"Test Server"}'],
  ['a non-string key', '{"clientId":"client-id","key":false,"serverName":"Test Server"}'],
  ['a non-string serverName', '{"clientId":"client-id","key":"client-key","serverName":[]}'],
  ['an empty clientId', '{"clientId":"","key":"client-key","serverName":"Test Server"}'],
  ['an empty key', '{"clientId":"client-id","key":"","serverName":"Test Server"}'],
  ['an empty serverName', '{"clientId":"client-id","key":"client-key","serverName":""}'],
]) {
  test(`client rejects malformed decrypted auth payload with ${description}`, async() => {
    const harness = loadClientAuth({
      authenticate: async() => ({ text: 'rsa-response', code: 200 }),
      rsaDecrypt: () => Buffer.from(decryptedPayload),
    })
    await assert.rejects(
      harness.handleAuth(urlInfo, '123456'),
      err => {
        assert.equal(err.message, syncConstants.SYNC_CODE.authFailed)
        return true
      },
    )
    assert.equal(harness.attempts.length, 1)
    assert.equal(harness.saved.length, 0)
  })
}

test('unmarked cached keys negotiate once and persist the successful protocol', async() => {
  const harness = loadClientAuth({
    keyInfo: { clientId: 'client-id', key: 'client-key', serverName: 'Test Server' },
    authenticate: async({ m }) => m.startsWith(CURRENT_SYNC_PROTOCOL.syncAuthPrefix)
      ? { text: syncConstants.SYNC_CODE.authFailed, code: 401 }
      : { text: syncConstants.SYNC_CODE.helloMsg, code: 200 },
  })
  const info = await harness.handleAuth(urlInfo)
  assert.equal(info.syncProtocol, 'legacy')
  assert.equal(harness.saved.at(-1).info.syncProtocol, 'legacy')
})

test('socket connection uses the protocol stored on the key', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/main/modules/sync/client/client.ts'),
    'utf8',
  )
  assert.match(source, /getSyncProtocol\(keyInfo\.syncProtocol\)\.syncConnectMessage/)
  assert.match(
    source,
    /wireProtocol:\s*getSyncProtocol\(keyInfo\.syncProtocol\)\.id/,
  )
  assert.equal(
    require('../src/common/syncProtocol').getSyncProtocol('legacy').syncConnectMessage,
    'lx-music connect',
  )
})
