# Sync Protocol Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make current and original LX Music sync clients and servers interoperate while keeping unrelated upstream identity data removed.

**Architecture:** A focused common module defines exact current and legacy sync profiles. The client negotiates current-first and stores the selected profile with its key; the server identifies the profile during code authentication and binds it to the device key for cached authentication and WebSocket handshakes.

**Tech Stack:** Electron, TypeScript, CommonJS compatibility modules, Node.js test runner, Babel TypeScript test loader, WebSocket, Electron Builder.

## Global Constraints

- Support current desktop client to current server.
- Support current desktop client to original server through automatic legacy fallback.
- Support original desktop and mobile clients to the current server.
- Reject unknown authentication prefixes, client identities, and connection messages.
- Retry another protocol only after an explicit authentication failure.
- Keep legacy sync values confined to one compatibility module and tests.
- Do not restore upstream repository, author, update, branding, user-data, or deep-link identity.
- Produce a Windows x64 portable package after verification.

## File Structure

- Create `src/common/syncProtocol.js`: exact current and legacy sync profiles plus profile lookup and candidate selection.
- Create `src/common/syncProtocol.d.ts`: public types for the CommonJS protocol module.
- Modify `src/common/types/sync.d.ts`: optional protocol marker on client and server key records.
- Modify `src/main/modules/sync/client/auth.ts`: current-first authentication and explicit-failure fallback.
- Modify `src/main/modules/sync/client/client.ts`: profile-specific WebSocket connection message.
- Modify `src/main/modules/sync/server/server/auth.ts`: profile-aware code, cached-key, and connection authentication.
- Modify `src/main/modules/sync/server/user/data.ts`: persist the protocol marker on newly issued server keys.
- Modify `scripts/test-project-identity.js`: protocol profile and server compatibility tests.
- Create `scripts/test-sync-client-compatibility.js`: client negotiation and persistence tests.
- Modify `scripts/test-upstream-detachment.js`: allow only the compatibility module to contain legacy sync identifiers.

---

### Task 1: Define Exact Sync Protocol Profiles

**Files:**
- Create: `src/common/syncProtocol.js`
- Create: `src/common/syncProtocol.d.ts`
- Modify: `src/common/types/sync.d.ts`
- Modify: `scripts/test-project-identity.js`
- Modify: `scripts/test-upstream-detachment.js`

**Interfaces:**
- Consumes: `PROJECT_IDENTITY.syncDesktopId`, `syncMobileId`, `syncAuthPrefix`, and `syncConnectMessage`.
- Produces: `CURRENT_SYNC_PROTOCOL`, `LEGACY_SYNC_PROTOCOL`, `SYNC_PROTOCOLS`, `getSyncProtocol(protocolId)`, and `getSyncProtocolCandidates(protocolId)`.
- Produces: `LX.Sync.SyncProtocolId = 'current' | 'legacy'` and optional `syncProtocol` fields on both key record types.

- [ ] **Step 1: Write failing profile and isolation tests**

Add these imports and tests to `scripts/test-project-identity.js`:

```js
const {
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
  SYNC_PROTOCOLS,
  getSyncProtocol,
  getSyncProtocolCandidates,
} = require('../src/common/syncProtocol')

test('sync compatibility profiles contain only the two approved protocols', () => {
  assert.deepEqual(CURRENT_SYNC_PROTOCOL, {
    id: 'current',
    syncDesktopId: PROJECT_IDENTITY.syncDesktopId,
    syncMobileId: PROJECT_IDENTITY.syncMobileId,
    syncAuthPrefix: PROJECT_IDENTITY.syncAuthPrefix,
    syncConnectMessage: PROJECT_IDENTITY.syncConnectMessage,
  })
  assert.deepEqual(LEGACY_SYNC_PROTOCOL, {
    id: 'legacy',
    syncDesktopId: 'lx_music_desktop',
    syncMobileId: 'lx_music_mobile',
    syncAuthPrefix: 'lx-music auth::',
    syncConnectMessage: 'lx-music connect',
  })
  assert.deepEqual(SYNC_PROTOCOLS, [CURRENT_SYNC_PROTOCOL, LEGACY_SYNC_PROTOCOL])
})

test('sync protocol candidates prefer current and honor a stored marker', () => {
  assert.deepEqual(getSyncProtocolCandidates().map(({ id }) => id), ['current', 'legacy'])
  assert.deepEqual(getSyncProtocolCandidates('legacy').map(({ id }) => id), ['legacy'])
  assert.equal(getSyncProtocol('legacy'), LEGACY_SYNC_PROTOCOL)
  assert.equal(getSyncProtocol(undefined), CURRENT_SYNC_PROTOCOL)
  assert.equal(getSyncProtocol('unexpected'), CURRENT_SYNC_PROTOCOL)
})
```

Add an audit probe to `scripts/test-upstream-detachment.js`:

```js
test('legacy sync identifiers are allowlisted only in the compatibility module', () => {
  const violations = findRuntimeIdentifierViolations([
    {
      path: 'src/common/syncProtocol.js',
      text: 'lx_music_desktop\nlx_music_mobile\nlx-music auth::\nlx-music connect',
    },
    {
      path: 'src/main/stray.ts',
      text: 'lx_music_desktop',
    },
  ])
  assert.deepEqual(violations, [
    'src/main/stray.ts: /\\blx_music_(?:desktop|mobile)\\b/',
  ])
})
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```powershell
node --test scripts/test-project-identity.js scripts/test-upstream-detachment.js
```

Expected: FAIL because `src/common/syncProtocol.js` does not exist and the audit has no compatibility allowlist.

- [ ] **Step 3: Implement the profile module**

Create `src/common/syncProtocol.js`:

```js
const { PROJECT_IDENTITY } = require('./projectIdentity')

const CURRENT_SYNC_PROTOCOL = Object.freeze({
  id: 'current',
  syncDesktopId: PROJECT_IDENTITY.syncDesktopId,
  syncMobileId: PROJECT_IDENTITY.syncMobileId,
  syncAuthPrefix: PROJECT_IDENTITY.syncAuthPrefix,
  syncConnectMessage: PROJECT_IDENTITY.syncConnectMessage,
})

const LEGACY_SYNC_PROTOCOL = Object.freeze({
  id: 'legacy',
  syncDesktopId: 'lx_music_desktop',
  syncMobileId: 'lx_music_mobile',
  syncAuthPrefix: 'lx-music auth::',
  syncConnectMessage: 'lx-music connect',
})

const SYNC_PROTOCOLS = Object.freeze([
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
])

const getSyncProtocol = protocolId =>
  protocolId === LEGACY_SYNC_PROTOCOL.id
    ? LEGACY_SYNC_PROTOCOL
    : CURRENT_SYNC_PROTOCOL

const getSyncProtocolCandidates = protocolId =>
  protocolId == null ? SYNC_PROTOCOLS : [getSyncProtocol(protocolId)]

module.exports = {
  CURRENT_SYNC_PROTOCOL,
  LEGACY_SYNC_PROTOCOL,
  SYNC_PROTOCOLS,
  getSyncProtocol,
  getSyncProtocolCandidates,
}
```

Create `src/common/syncProtocol.d.ts`:

```ts
export interface SyncProtocol {
  readonly id: LX.Sync.SyncProtocolId
  readonly syncDesktopId: string
  readonly syncMobileId: string
  readonly syncAuthPrefix: string
  readonly syncConnectMessage: string
}

export const CURRENT_SYNC_PROTOCOL: Readonly<SyncProtocol>
export const LEGACY_SYNC_PROTOCOL: Readonly<SyncProtocol>
export const SYNC_PROTOCOLS: readonly Readonly<SyncProtocol>[]
export function getSyncProtocol(protocolId?: unknown): Readonly<SyncProtocol>
export function getSyncProtocolCandidates(protocolId?: LX.Sync.SyncProtocolId): readonly Readonly<SyncProtocol>[]
```

Add the protocol type and markers in `src/common/types/sync.d.ts`:

```ts
type SyncProtocolId = 'current' | 'legacy'

interface ClientKeyInfo {
  clientId: string
  key: string
  serverName: string
  syncProtocol?: SyncProtocolId
}

interface ServerKeyInfo {
  clientId: string
  key: string
  deviceName: string
  lastConnectDate?: number
  isMobile: boolean
  syncProtocol?: SyncProtocolId
}
```

In `scripts/test-upstream-detachment.js`, add:

```js
const runtimeIdentifierAllowed = [
  /^src\/common\/syncProtocol\.js$/,
]
```

At the start of each file iteration in `findRuntimeIdentifierViolations`, skip a file only when it matches this allowlist:

```js
if (runtimeIdentifierAllowed.some(pattern => pattern.test(file.path))) continue
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```powershell
node --test scripts/test-project-identity.js scripts/test-upstream-detachment.js
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Commit the protocol model**

```powershell
git add -- src/common/syncProtocol.js src/common/syncProtocol.d.ts src/common/types/sync.d.ts scripts/test-project-identity.js scripts/test-upstream-detachment.js
git commit -m "feat: define sync compatibility profiles"
```

### Task 2: Add Current Client Fallback and Protocol-Aware Reconnects

**Files:**
- Create: `scripts/test-sync-client-compatibility.js`
- Modify: `src/main/modules/sync/client/auth.ts`
- Modify: `src/main/modules/sync/client/client.ts`

**Interfaces:**
- Consumes: `SYNC_PROTOCOLS`, `getSyncProtocolCandidates`, and `getSyncProtocol`.
- Produces: client key records with `syncProtocol`.
- Behavior: try current first, retry legacy only after an HTTP authentication rejection, and use the stored protocol for cached authentication and WebSocket connection.

- [ ] **Step 1: Write failing client negotiation tests**

Create `scripts/test-sync-client-compatibility.js` with a `loadClientAuth` harness that loads the real `auth.ts` through `scripts/test-utils/load-ts-module.js`. Use identity crypto functions so the test can inspect plaintext profile values, and stub only HTTP, RSA key generation, logging, computer name, and key storage:

```js
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
  assert.equal(
    require('../src/common/syncProtocol').getSyncProtocol('legacy').syncConnectMessage,
    'lx-music connect',
  )
})
```

- [ ] **Step 2: Run the client tests and verify RED**

Run:

```powershell
node --test scripts/test-sync-client-compatibility.js
```

Expected: FAIL because authentication makes only the current attempt, key records have no protocol marker, and `client.ts` always uses `SYNC_CODE.msgConnect`.

- [ ] **Step 3: Implement explicit-failure fallback**

In `src/main/modules/sync/client/auth.ts`:

- Import `SYNC_PROTOCOLS`, `getSyncProtocolCandidates`, and the `SyncProtocol` type from `@common/syncProtocol`.
- Add an internal `RetryableProtocolAuthError` used only for HTTP authentication rejection.
- Change code and cached-key authentication functions to accept a `SyncProtocol`.
- Build authentication plaintext from `protocol.syncAuthPrefix` and `protocol.syncDesktopId`.
- Use this exact fallback helper:

```ts
const authenticateWithProtocols = async<T>(
  protocols: readonly Readonly<SyncProtocol>[],
  authenticate: (protocol: Readonly<SyncProtocol>) => Promise<T>,
) => {
  let lastError: unknown
  for (const [index, protocol] of protocols.entries()) {
    try {
      return { value: await authenticate(protocol), protocol }
    } catch (err) {
      lastError = err
      if (!(err instanceof RetryableProtocolAuthError) || index == protocols.length - 1) throw err
    }
  }
  throw lastError
}
```

Map only an HTTP non-200 authentication response or `SYNC_CODE.authFailed`
body to `RetryableProtocolAuthError`. Preserve blocked-IP, network, RSA
decryption, JSON, and response-validation failures as non-retryable errors.

For code authentication, pass `SYNC_PROTOCOLS`, append the successful
`protocol.id` to the returned key, and persist it:

```ts
const keyInfo = {
  ...value,
  syncProtocol: protocol.id,
}
await setSyncAuthKey(serverId, keyInfo)
return keyInfo
```

For cached-key authentication, call:

```ts
getSyncProtocolCandidates(keyInfo.syncProtocol)
```

After success, persist and return the key with the selected marker. Marked keys
have one candidate; unmarked keys negotiate current then legacy.

In `src/main/modules/sync/client/client.ts`, import `getSyncProtocol` and replace
the fixed connection message with:

```ts
aesEncrypt(
  getSyncProtocol(keyInfo.syncProtocol).syncConnectMessage,
  keyInfo.key,
)
```

- [ ] **Step 4: Run client tests and verify GREEN**

Run:

```powershell
node --test scripts/test-sync-client-compatibility.js
```

Expected: PASS with six passed tests and zero failures.

- [ ] **Step 5: Commit client compatibility**

```powershell
git add -- scripts/test-sync-client-compatibility.js src/main/modules/sync/client/auth.ts src/main/modules/sync/client/client.ts
git commit -m "feat: negotiate legacy sync servers"
```

### Task 3: Accept Original Clients on the Current Server

**Files:**
- Modify: `scripts/test-project-identity.js`
- Modify: `src/main/modules/sync/server/server/auth.ts`
- Modify: `src/main/modules/sync/server/user/data.ts`

**Interfaces:**
- Consumes: `SYNC_PROTOCOLS`, `getSyncProtocol`, and `classifySyncClient`.
- Produces: server key records bound to `current` or `legacy`.
- Behavior: the authentication prefix, client identity, cached-key prefix, and connection message must all match the key's exact profile.

- [ ] **Step 1: Replace legacy-rejection tests with bidirectional server tests**

Update the code-auth request helper in `scripts/test-project-identity.js` to
accept a protocol:

```js
const createCodeAuthRequest = (protocol, clientType, remoteAddress) => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const publicKeyBody = publicKey
    .replace('-----BEGIN PUBLIC KEY-----', '')
    .replace('-----END PUBLIC KEY-----', '')
    .replace(/\s/g, '')
  const password = 'identity-test-password'
  const { syncTools, syncUtils } = getRuntimeEntries()
  const key = Buffer.from(syncUtils.toMD5(password).substring(0, 16)).toString('base64')
  const plaintext = [
    protocol.syncAuthPrefix,
    publicKeyBody,
    'Test Client',
    clientType,
  ].join('\n')
  return {
    password,
    privateKey,
    request: {
      headers: { m: syncTools.aesEncrypt(plaintext, key) },
      socket: { remoteAddress },
    },
  }
}

const performCodeAuth = async(protocol, clientType, remoteAddress) => {
  const { authCode, syncTools } = getRuntimeEntries()
  const { password, privateKey, request } =
    createCodeAuthRequest(protocol, clientType, remoteAddress)
  let status
  let body
  await authCode(request, {
    writeHead(value) { status = value },
    end(value) { body = value },
  }, password)
  return {
    status,
    body,
    payload: status == 200
      ? JSON.parse(syncTools.rsaDecrypt(Buffer.from(body, 'base64'), privateKey).toString())
      : null,
  }
}

const performCachedAuth = async(protocol, keyInfo, remoteAddress) => {
  const { authCode, syncTools } = getRuntimeEntries()
  let status
  let body
  await authCode({
    headers: {
      i: keyInfo.clientId,
      m: syncTools.aesEncrypt(protocol.syncAuthPrefix + 'Test Client', keyInfo.key),
    },
    socket: { remoteAddress },
  }, {
    writeHead(value) { status = value },
    end(value) { body = value },
  }, 'unused')
  return { status, body }
}
```

Expose the in-memory client map from `getRuntimeEntries`, update
`performCodeAuth` to receive a protocol. Remove the old tests named
`authCode accepts current desktop and mobile identities`,
`authCode rejects legacy desktop and mobile identities`, and
`authConnect accepts only the current connection message`, then add:

```js
test('authCode accepts desktop and mobile clients from both sync protocols', async() => {
  const cases = [
    [CURRENT_SYNC_PROTOCOL, CURRENT_SYNC_PROTOCOL.syncDesktopId, false],
    [CURRENT_SYNC_PROTOCOL, CURRENT_SYNC_PROTOCOL.syncMobileId, true],
    [LEGACY_SYNC_PROTOCOL, LEGACY_SYNC_PROTOCOL.syncDesktopId, false],
    [LEGACY_SYNC_PROTOCOL, LEGACY_SYNC_PROTOCOL.syncMobileId, true],
  ]
  for (const [index, [protocol, clientType, isMobile]] of cases.entries()) {
    const result = await performCodeAuth(protocol, clientType, `127.0.1.${index + 1}`)
    assert.equal(result.status, 200)
    const stored = getRuntimeEntries().clients.get(result.payload.clientId)
    assert.equal(stored.syncProtocol, protocol.id)
    assert.equal(stored.isMobile, isMobile)
  }
})

test('authCode rejects unknown and cross-profile client identities', async() => {
  const cases = [
    [CURRENT_SYNC_PROTOCOL, LEGACY_SYNC_PROTOCOL.syncDesktopId],
    [LEGACY_SYNC_PROTOCOL, CURRENT_SYNC_PROTOCOL.syncDesktopId],
    [LEGACY_SYNC_PROTOCOL, 'unknown'],
  ]
  for (const [index, [protocol, clientType]] of cases.entries()) {
    const result = await performCodeAuth(protocol, clientType, `127.0.2.${index + 1}`)
    assert.equal(result.status, 401)
    assert.equal(result.payload, null)
  }
})
```

Add cached-key and connection tests for each profile:

```js
test('cached-key and WebSocket authentication follow the stored protocol', async() => {
  const { authConnect, syncConstants, syncTools } = getRuntimeEntries()
  for (const [index, protocol] of SYNC_PROTOCOLS.entries()) {
    const authorized = await performCodeAuth(
      protocol,
      protocol.syncDesktopId,
      `127.0.3.${index + 1}`,
    )
    const cached = await performCachedAuth(
      protocol,
      authorized.payload,
      `127.0.4.${index + 1}`,
    )
    assert.equal(cached.status, 200)
    assert.equal(
      syncTools.aesDecrypt(cached.body, authorized.payload.key),
      syncConstants.SYNC_CODE.helloMsg,
    )

    const token = syncTools.aesEncrypt(protocol.syncConnectMessage, authorized.payload.key)
    await assert.doesNotReject(authConnect({
      socket: { remoteAddress: `127.0.5.${index + 1}` },
      url: `/socket?i=${encodeURIComponent(authorized.payload.clientId)}&t=${encodeURIComponent(token)}`,
    }))
  }
})
```

Add the profile-bound rejection and unmarked-key tests:

```js
test('legacy keys reject current cached and connection messages', async() => {
  const { authConnect, syncTools } = getRuntimeEntries()
  const authorized = await performCodeAuth(
    LEGACY_SYNC_PROTOCOL,
    LEGACY_SYNC_PROTOCOL.syncDesktopId,
    '127.0.6.1',
  )
  const cached = await performCachedAuth(
    CURRENT_SYNC_PROTOCOL,
    authorized.payload,
    '127.0.6.2',
  )
  assert.equal(cached.status, 401)

  const token = syncTools.aesEncrypt(
    CURRENT_SYNC_PROTOCOL.syncConnectMessage,
    authorized.payload.key,
  )
  await assert.rejects(authConnect({
    socket: { remoteAddress: '127.0.6.3' },
    url: `/socket?i=${encodeURIComponent(authorized.payload.clientId)}&t=${encodeURIComponent(token)}`,
  }), /failed/)
})

test('unmarked server keys default to the current protocol', async() => {
  const { clients } = getRuntimeEntries()
  const authorized = await performCodeAuth(
    CURRENT_SYNC_PROTOCOL,
    CURRENT_SYNC_PROTOCOL.syncDesktopId,
    '127.0.7.1',
  )
  delete clients.get(authorized.payload.clientId).syncProtocol

  const current = await performCachedAuth(
    CURRENT_SYNC_PROTOCOL,
    authorized.payload,
    '127.0.7.2',
  )
  const legacy = await performCachedAuth(
    LEGACY_SYNC_PROTOCOL,
    authorized.payload,
    '127.0.7.3',
  )
  assert.equal(current.status, 200)
  assert.equal(legacy.status, 401)
})
```

- [ ] **Step 2: Run server compatibility tests and verify RED**

Run:

```powershell
node --test scripts/test-project-identity.js
```

Expected: FAIL because the current server rejects legacy prefixes and identities and does not persist a protocol marker.

- [ ] **Step 3: Bind server keys to the authenticated profile**

Change `createClientKeyInfo` in
`src/main/modules/sync/server/user/data.ts` to accept and persist a protocol:

```ts
export const createClientKeyInfo = (
  deviceName: string,
  isMobile: boolean,
  syncProtocol: LX.Sync.SyncProtocolId = 'current',
): LX.Sync.ServerKeyInfo => {
  const keyInfo: LX.Sync.ServerKeyInfo = {
    clientId: randomBytes(4 * 4).toString('base64'),
    key: randomBytes(16).toString('base64'),
    deviceName,
    isMobile,
    syncProtocol,
    lastConnectDate: 0,
  }
  return keyInfo
}
```

In `src/main/modules/sync/server/server/auth.ts`, import `SYNC_PROTOCOLS` and
`getSyncProtocol`.

For code authentication:

```ts
const data = text.split('\n')
const protocol = SYNC_PROTOCOLS.find(
  candidate => data[0] === candidate.syncAuthPrefix,
)
if (!protocol) return null
const client = classifySyncClient(data[3], protocol)
if (!client) return null
const keyInfo = createClientKeyInfo(deviceName, client.isMobile, protocol.id)
```

Do not use a global `startsWith(SYNC_CODE.authMsg)` gate before selecting the
profile. Require exact equality for the first newline-delimited field.

For cached-key authentication:

```ts
const protocol = getSyncProtocol(keyInfo.syncProtocol)
if (text.startsWith(protocol.syncAuthPrefix)) {
  const deviceName = text.replace(protocol.syncAuthPrefix, '') || 'Unknown'
  // Preserve the existing device-name update and encrypted hello response.
}
```

For connection authentication:

```ts
return text == getSyncProtocol(keyInfo.syncProtocol).syncConnectMessage
```

Unmarked stored server keys resolve to the current profile through
`getSyncProtocol(undefined)`.

- [ ] **Step 4: Run server and audit tests and verify GREEN**

Run:

```powershell
node --test scripts/test-project-identity.js scripts/test-upstream-detachment.js
```

Expected: PASS with zero failed tests.

- [ ] **Step 5: Commit server compatibility**

```powershell
git add -- scripts/test-project-identity.js src/main/modules/sync/server/server/auth.ts src/main/modules/sync/server/user/data.ts
git commit -m "feat: accept legacy sync clients"
```

### Task 4: Verify and Build the Windows x64 Portable Package

**Files:**
- Verify: all files changed in Tasks 1-3.
- Build output: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`

**Interfaces:**
- Consumes: the completed dual-protocol implementation.
- Produces: fresh test, lint, application build, and portable-package evidence.

- [ ] **Step 1: Run focused compatibility tests**

```powershell
node --test scripts/test-sync-client-compatibility.js scripts/test-project-identity.js scripts/test-upstream-detachment.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run related sync and security regression tests**

```powershell
node --test scripts/test-sync-rpc.js scripts/test-electron-security-boundaries.js scripts/test-legacy-user-data-migration.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 3: Run the full source lint**

```powershell
npm run lint
```

Expected: exit code 0 with no ESLint errors.

- [ ] **Step 4: Build all application bundles**

```powershell
npm run build
```

Expected: exit code 0 and production bundles written under `dist/`.

- [ ] **Step 5: Build the Windows x64 portable executable**

```powershell
npm run pack:win:portable:x64
```

Expected: exit code 0 and
`build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` exists with a nonzero
size.

- [ ] **Step 6: Inspect the final diff and artifact**

```powershell
git status --short
git diff --check
Get-Item 'build\starky-lx-music-desktop-v3.0.0-x64-portable.exe' | Select-Object FullName, Length, LastWriteTime
```

Expected: only intentional plan or source changes remain, `git diff --check`
reports no errors, and the artifact metadata is current.

- [ ] **Step 7: Commit any final test-only corrections**

If verification required a test or implementation correction, repeat its
failing and passing test cycle, then commit the exact corrected files:

```powershell
git add -- scripts/test-sync-client-compatibility.js scripts/test-project-identity.js scripts/test-upstream-detachment.js src/common/syncProtocol.js src/common/syncProtocol.d.ts src/common/types/sync.d.ts src/main/modules/sync/client/auth.ts src/main/modules/sync/client/client.ts src/main/modules/sync/server/server/auth.ts src/main/modules/sync/server/user/data.ts
git commit -m "fix: complete sync compatibility verification"
```

If no correction was required, do not create an empty commit.
