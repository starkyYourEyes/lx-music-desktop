# Sync RPC Wire Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the legacy `message2call` wire protocol, then add compatibility with the current local RPC envelope so every approved current/original client-server combination completes synchronization.

**Architecture:** `createSyncRpc` keeps one internal pending-call, queue, and function-dispatch model. A legacy encoder/decoder is restored first; a second current-format encoder/decoder is then layered on it, with replies mirroring each request's format and outbound format selected from the authenticated connection profile.

**Tech Stack:** Node.js, CommonJS, TypeScript declarations, `node:test`, WebSocket, Electron, Electron Builder.

## Global Constraints

- Restore legacy `message2call@0.1.3` wire behavior before adding current-envelope compatibility.
- Do not add `message2call` or another upstream RPC package to `package.json`.
- Do not modify `D:\projects\lx-music-sync-server`; it is read-only reference material.
- Preserve blocked RPC path segments: `__proto__`, `prototype`, and `constructor`.
- Preserve pending-call timeouts, FIFO group queues, queue recovery, and destroy rejection.
- Accept both recognized wire formats on every connection.
- Reply in the same wire format as the incoming call.
- Use legacy wire format for `syncProtocol: 'legacy'`.
- Use current wire format for `syncProtocol: 'current'` and missing markers.
- Resolve the built-in server's wire format at outbound-call time because `socket.keyInfo` is assigned after its RPC instance is created.
- Run every production change through a witnessed RED-GREEN test cycle.
- Build only the Windows x64 portable package after the complete test and lint suite passes.

## File Structure

- Create `scripts/test-sync-rpc-wire-compatibility.js`: exact legacy/current wire-envelope interoperability tests.
- Modify `scripts/test-sync-rpc.js`: preserve core RPC behavior under the restored legacy default and current opt-in.
- Modify `src/common/utils/syncRpc.js`: legacy-first dual-wire implementation.
- Modify `src/common/utils/syncRpc.d.ts`: public wire protocol option and resolver type.
- Modify `scripts/test-sync-client-compatibility.js`: assert the desktop client selects the wire protocol from its stored authentication profile.
- Modify `scripts/test-project-identity.js`: assert the built-in server resolves the wire protocol from its authenticated key.
- Modify `src/main/modules/sync/client/client.ts`: pass a fixed per-connection wire protocol.
- Modify `src/main/modules/sync/server/server/server.ts`: pass a deferred per-connection wire protocol resolver.

---

### Task 1: Restore the Legacy Message2call Wire Protocol

**Files:**
- Create: `scripts/test-sync-rpc-wire-compatibility.js`
- Modify: `scripts/test-sync-rpc.js`
- Modify: `src/common/utils/syncRpc.js`

**Interfaces:**
- Consumes: existing `createSyncRpc(options)`, `remote`, `createQueueRemote(groupName)`, `message(data)`, and `destroy()`.
- Produces: a legacy-default `createSyncRpc` that sends and accepts `{name,path,data}` calls and `{name,error,data}` responses.

- [ ] **Step 1: Add a real legacy-envelope peer harness**

Create `scripts/test-sync-rpc-wire-compatibility.js` with this initial content:

```js
const assert = require('node:assert/strict')
const test = require('node:test')
const { createSyncRpc } = require('../src/common/utils/syncRpc')

const clone = value => JSON.parse(JSON.stringify(value))

const createLegacyPeer = ({ funcsObj = {}, timeout = 75 } = {}) => {
  let sendMessage = () => {}
  let nextId = 0
  const pending = new Map()

  const resolveFunction = path => {
    let parent = null
    let target = funcsObj
    for (const part of path) {
      parent = target
      target = target?.[part]
    }
    if (typeof target != 'function') throw new Error(`${path.at(-1)} is not defined`)
    return { parent, target }
  }

  const call = (path, ...args) => new Promise((resolve, reject) => {
    const name = `${path.join('.')}__legacy-${++nextId}`
    const timer = setTimeout(() => {
      pending.delete(name)
      reject(new Error('timeout'))
    }, timeout)
    pending.set(name, { resolve, reject, timer })
    sendMessage({ name, path, data: args })
  })

  const message = async data => {
    if (!data || typeof data.name != 'string') return
    if (Array.isArray(data.path) && data.path.length) {
      try {
        const { parent, target } = resolveFunction(data.path)
        const result = await target.apply(parent, data.data)
        sendMessage({ name: data.name, error: null, data: result })
      } catch (error) {
        sendMessage({ name: data.name, error: error.message })
      }
      return
    }
    const entry = pending.get(data.name)
    if (!entry) return
    pending.delete(data.name)
    clearTimeout(entry.timer)
    if (data.error == null) entry.resolve(data.data)
    else entry.reject(new Error(String(data.error)))
  }

  const destroy = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('destroy'))
    }
    pending.clear()
  }

  return {
    call,
    destroy,
    message,
    setSendMessage(handler) {
      sendMessage = handler
    },
  }
}

const createLegacyPair = ({ rpcFuncs = {}, peerFuncs = {}, timeout = 75 } = {}) => {
  const peer = createLegacyPeer({ funcsObj: peerFuncs, timeout })
  let rpc
  const rpcFrames = []
  const peerFrames = []
  peer.setSendMessage(data => {
    peerFrames.push(clone(data))
    setImmediate(() => rpc.message(clone(data)))
  })
  rpc = createSyncRpc({
    funcsObj: rpcFuncs,
    timeout,
    sendMessage(data) {
      rpcFrames.push(clone(data))
      setImmediate(() => peer.message(clone(data)))
    },
  })
  return { peer, peerFrames, rpc, rpcFrames }
}
```

- [ ] **Step 2: Add failing legacy call tests**

Append these tests to `scripts/test-sync-rpc-wire-compatibility.js`:

```js
test('legacy peer calls the local getEnabledFeatures handler', async t => {
  let handlerCalled = false
  const pair = createLegacyPair({
    rpcFuncs: {
      getEnabledFeatures(serverType, supportedFeatures) {
        handlerCalled = true
        assert.equal(serverType, 'server')
        assert.deepEqual(supportedFeatures, { list: 1 })
        return { list: { skipSnapshot: false } }
      },
    },
  })
  t.after(() => { pair.peer.destroy(); pair.rpc.destroy() })

  assert.deepEqual(
    await pair.peer.call(['getEnabledFeatures'], 'server', { list: 1 }),
    { list: { skipSnapshot: false } },
  )
  assert.equal(handlerCalled, true)
  assert.deepEqual(Object.keys(pair.rpcFrames.at(-1)).sort(), ['data', 'error', 'name'])
})

test('local RPC calls and receives a legacy peer response by default', async t => {
  const pair = createLegacyPair({
    peerFuncs: {
      echo(value) {
        return `legacy:${value}`
      },
    },
  })
  t.after(() => { pair.peer.destroy(); pair.rpc.destroy() })

  assert.equal(await pair.rpc.remote.echo('value'), 'legacy:value')
  assert.deepEqual(Object.keys(pair.rpcFrames[0]).sort(), ['data', 'name', 'path'])
  assert.equal(pair.rpcFrames[0].path.join('.'), 'echo')
  assert.deepEqual(pair.rpcFrames[0].data, ['value'])
})

test('legacy peer errors reject the local pending call', async t => {
  const pair = createLegacyPair({
    peerFuncs: {
      fail() {
        throw new Error('legacy failure')
      },
    },
  })
  t.after(() => { pair.peer.destroy(); pair.rpc.destroy() })

  await assert.rejects(pair.rpc.remote.fail(), /legacy failure/)
})
```

- [ ] **Step 3: Verify the legacy tests are RED**

Run:

```powershell
node --test scripts/test-sync-rpc-wire-compatibility.js
```

Expected:

- `legacy peer calls the local getEnabledFeatures handler` fails with `timeout`;
- `local RPC calls and receives a legacy peer response by default` fails with `timeout`;
- the current implementation emits a frame containing `type`, `id`, and `args` instead of the expected legacy keys.

- [ ] **Step 4: Adjust the core error assertion for the legacy default**

In `scripts/test-sync-rpc.js`, replace:

```js
await assert.rejects(pair.left.remote.fail(), error => error.name == 'TypeError' && error.message == 'remote failure')
```

with:

```js
await assert.rejects(pair.left.remote.fail(), /remote failure/)
```

Legacy `message2call` transmits an error message string and therefore does not
preserve the remote JavaScript error class. Task 2 adds a current-wire test that
continues to verify structured error names.

- [ ] **Step 5: Change outbound calls to the legacy envelope**

In `src/common/utils/syncRpc.js`, change the request ID and send operation inside
`callRemote` to:

```js
const id = `${path.join('.')}__${Date.now().toString(36)}-${++nextId}`
const timer = setTimeout(() => {
  settlePending(id, entry => entry.reject(new Error(`Sync RPC timeout: ${path.join('.')}`)))
}, Math.max(1, timeout))
pending.set(id, { resolve, reject, timer })
send({ name: id, path, data: args }, error => settlePending(id, entry => entry.reject(error)))
```

- [ ] **Step 6: Make handler replies use the legacy envelope**

Replace `handleCall` with:

```js
const handleCall = async data => {
  const path = Array.isArray(data.path) ? data.path : []
  try {
    if (typeof data.name != 'string' || !Array.isArray(data.data)) throw new Error('Invalid RPC call')
    const { parent, target } = resolveFunction(path)
    const args = await onCallBeforeParams(data.data)
    if (!Array.isArray(args)) throw new Error('RPC parameter hook must return an array')
    const result = await target.apply(parent, args)
    send(
      { name: data.name, error: null, data: result },
      error => reportError(error, path, null),
    )
  } catch (error) {
    reportError(error, path, null)
    if (typeof data.name == 'string') {
      send(
        { name: data.name, error: toError(error).message },
        sendError => reportError(sendError, path, null),
      )
    }
  }
}
```

Remove `serializeError` and `deserializeError` at the top of the file; Task 2
adds them back when the structured current format is restored.

- [ ] **Step 7: Make message dispatch use legacy call/response fields**

Replace the current `message` function with:

```js
const message = data => {
  if (destroyed || !data || typeof data != 'object' || typeof data.name != 'string') return
  if (Array.isArray(data.path) && data.path.length) {
    void handleCall(data)
    return
  }
  settlePending(data.name, entry => {
    if (data.error == null) entry.resolve(data.data)
    else entry.reject(new Error(String(data.error)))
  })
}
```

- [ ] **Step 8: Verify legacy behavior and existing RPC behavior are GREEN**

Run:

```powershell
node --test scripts/test-sync-rpc-wire-compatibility.js scripts/test-sync-rpc.js
```

Expected: all legacy interoperability, queue, timeout, error, and destroy tests
pass with zero failures.

- [ ] **Step 9: Commit the restored legacy protocol**

```powershell
git add -- scripts/test-sync-rpc-wire-compatibility.js scripts/test-sync-rpc.js src/common/utils/syncRpc.js
git commit -m "fix: restore legacy sync rpc wire protocol"
```

---

### Task 2: Add the Current Wire Protocol as a Compatibility Layer

**Files:**
- Modify: `scripts/test-sync-rpc-wire-compatibility.js`
- Modify: `src/common/utils/syncRpc.js`
- Modify: `src/common/utils/syncRpc.d.ts`

**Interfaces:**
- Consumes: the legacy-default RPC from Task 1.
- Produces: `SyncRpcWireProtocol`, `SyncRpcWireProtocolOption`, and `wireProtocol?: SyncRpcWireProtocolOption`.
- Produces: dual-format incoming dispatch and per-call outbound format resolution.

- [ ] **Step 1: Add a current-format RPC pair helper**

Append this helper to `scripts/test-sync-rpc-wire-compatibility.js` before the
tests:

```js
const createCurrentPair = ({ leftFuncs = {}, rightFuncs = {}, timeout = 75 } = {}) => {
  let left
  let right
  const leftFrames = []
  const rightFrames = []
  left = createSyncRpc({
    funcsObj: leftFuncs,
    timeout,
    wireProtocol: 'current',
    sendMessage(data) {
      leftFrames.push(clone(data))
      setImmediate(() => right.message(clone(data)))
    },
  })
  right = createSyncRpc({
    funcsObj: rightFuncs,
    timeout,
    wireProtocol: 'current',
    sendMessage(data) {
      rightFrames.push(clone(data))
      setImmediate(() => left.message(clone(data)))
    },
  })
  return { left, leftFrames, right, rightFrames }
}
```

- [ ] **Step 2: Add failing current-format and dual-decoder tests**

Append:

```js
test('current wire protocol preserves the type and id envelope', async t => {
  const pair = createCurrentPair({
    rightFuncs: {
      echo(value) {
        return `current:${value}`
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })

  assert.equal(await pair.left.remote.echo('value'), 'current:value')
  assert.deepEqual(
    Object.keys(pair.leftFrames[0]).sort(),
    ['args', 'group', 'id', 'path', 'type'],
  )
  assert.equal(pair.leftFrames[0].type, 'call')
  assert.equal(pair.rightFrames[0].type, 'result')
})

test('incoming calls receive responses in their own wire format', async t => {
  const sent = []
  const rpc = createSyncRpc({
    funcsObj: {
      echo(value) {
        return value
      },
    },
    sendMessage(data) {
      sent.push(clone(data))
    },
  })
  t.after(() => rpc.destroy())

  rpc.message({ name: 'legacy-1', path: ['echo'], data: ['legacy'] })
  rpc.message({ type: 'call', id: 'current-1', path: ['echo'], args: ['current'], group: null })
  await new Promise(resolve => setImmediate(resolve))

  assert.deepEqual(sent[0], { name: 'legacy-1', error: null, data: 'legacy' })
  assert.deepEqual(sent[1], { type: 'result', id: 'current-1', data: 'current' })
})

test('wire protocol resolver is evaluated for each outbound call', async t => {
  let selected = 'legacy'
  const sent = []
  const rpc = createSyncRpc({
    funcsObj: {},
    wireProtocol: () => selected,
    sendMessage(data) {
      sent.push(clone(data))
    },
  })
  t.after(() => rpc.destroy())

  const legacyCall = rpc.remote.first()
  const legacyFrame = sent[0]
  assert.equal(typeof legacyFrame.name, 'string')
  rpc.message({ name: legacyFrame.name, error: null, data: 'legacy-result' })
  assert.equal(await legacyCall, 'legacy-result')

  selected = 'current'
  const currentCall = rpc.remote.second()
  const currentFrame = sent[1]
  assert.equal(currentFrame.type, 'call')
  rpc.message({ type: 'result', id: currentFrame.id, data: 'current-result' })
  assert.equal(await currentCall, 'current-result')
})

test('current wire errors preserve the remote error name', async t => {
  const pair = createCurrentPair({
    rightFuncs: {
      fail() {
        throw new TypeError('current failure')
      },
    },
  })
  t.after(() => { pair.left.destroy(); pair.right.destroy() })

  await assert.rejects(
    pair.left.remote.fail(),
    error => error.name == 'TypeError' && error.message == 'current failure',
  )
})

test('blocked paths return errors in both wire formats', async t => {
  const sent = []
  const rpc = createSyncRpc({
    funcsObj: {},
    sendMessage(data) {
      sent.push(clone(data))
    },
  })
  t.after(() => rpc.destroy())

  rpc.message({ name: 'legacy-blocked', path: ['__proto__', 'polluted'], data: [] })
  rpc.message({
    type: 'call',
    id: 'current-blocked',
    path: ['constructor', 'polluted'],
    args: [],
    group: null,
  })
  await new Promise(resolve => setImmediate(resolve))

  assert.match(sent[0].error, /Unknown RPC path/)
  assert.equal(sent[1].type, 'error')
  assert.match(sent[1].error.message, /Unknown RPC path/)
})
```

- [ ] **Step 3: Verify the current compatibility tests are RED**

Run:

```powershell
node --test scripts/test-sync-rpc-wire-compatibility.js
```

Expected:

- current outbound calls time out because Task 1 only sends legacy frames;
- a raw current call produces no response;
- `wireProtocol` resolver assertions fail because the option does not exist;
- current structured error-name assertions fail.

- [ ] **Step 4: Add public wire protocol types**

In `src/common/utils/syncRpc.d.ts`, add before `SyncRpcOptions`:

```ts
export type SyncRpcWireProtocol = 'legacy' | 'current'
export type SyncRpcWireProtocolOption =
  | SyncRpcWireProtocol
  | (() => SyncRpcWireProtocol)
```

Add this property to `SyncRpcOptions`:

```ts
wireProtocol?: SyncRpcWireProtocolOption
```

- [ ] **Step 5: Restore structured current error helpers**

At the top of `src/common/utils/syncRpc.js`, after `toError`, add:

```js
const serializeError = error => ({
  name: typeof error?.name == 'string' ? error.name : 'Error',
  message: typeof error?.message == 'string' ? error.message : String(error),
})
const deserializeError = value => {
  const error = new Error(typeof value?.message == 'string' ? value.message : 'Remote RPC error')
  error.name = typeof value?.name == 'string' ? value.name : 'Error'
  return error
}
```

- [ ] **Step 6: Add per-call wire protocol resolution and encoders**

Add `wireProtocol = 'legacy'` to the destructured `createSyncRpc` options, then
add these helpers inside `createSyncRpc` after `reportError`:

```js
const resolveWireProtocol = () => {
  const selected = typeof wireProtocol == 'function' ? wireProtocol() : wireProtocol
  return selected == 'current' ? 'current' : 'legacy'
}
const encodeCall = (protocol, id, path, args, group) => protocol == 'current'
  ? { type: 'call', id, path, args, group }
  : { name: id, path, data: args }
const encodeResult = (protocol, id, data) => protocol == 'current'
  ? { type: 'result', id, data }
  : { name: id, error: null, data }
const encodeError = (protocol, id, error) => protocol == 'current'
  ? { type: 'error', id, error: serializeError(error) }
  : { name: id, error: toError(error).message }
```

Change the send operation in `callRemote` to:

```js
send(
  encodeCall(resolveWireProtocol(), id, path, args, group),
  error => settlePending(id, entry => entry.reject(error)),
)
```

- [ ] **Step 7: Canonicalize handler calls and mirror response formats**

Replace `handleCall` with:

```js
const handleCall = async({ id, path: rawPath, args: rawArgs, group, protocol }) => {
  const path = Array.isArray(rawPath) ? rawPath : []
  try {
    if (typeof id != 'string' || !Array.isArray(rawArgs)) throw new Error('Invalid RPC call')
    const { parent, target } = resolveFunction(path)
    const args = await onCallBeforeParams(rawArgs)
    if (!Array.isArray(args)) throw new Error('RPC parameter hook must return an array')
    const result = await target.apply(parent, args)
    send(
      encodeResult(protocol, id, result),
      error => reportError(error, path, group),
    )
  } catch (error) {
    reportError(error, path, group)
    if (typeof id == 'string') {
      send(
        encodeError(protocol, id, error),
        sendError => reportError(sendError, path, group),
      )
    }
  }
}
```

- [ ] **Step 8: Decode both wire formats**

Replace `message` with:

```js
const message = data => {
  if (destroyed || !data || typeof data != 'object') return

  switch (data.type) {
    case 'call':
      void handleCall({
        id: data.id,
        path: data.path,
        args: data.args,
        group: typeof data.group == 'string' ? data.group : null,
        protocol: 'current',
      })
      return
    case 'result':
      if (typeof data.id == 'string') {
        settlePending(data.id, entry => entry.resolve(data.data))
      }
      return
    case 'error':
      if (typeof data.id == 'string') {
        settlePending(data.id, entry => entry.reject(deserializeError(data.error)))
      }
      return
  }

  if (typeof data.name != 'string') return
  if (Array.isArray(data.path) && data.path.length) {
    void handleCall({
      id: data.name,
      path: data.path,
      args: data.data,
      group: null,
      protocol: 'legacy',
    })
    return
  }
  settlePending(data.name, entry => {
    if (data.error == null) entry.resolve(data.data)
    else entry.reject(new Error(String(data.error)))
  })
}
```

- [ ] **Step 9: Verify legacy and current tests are GREEN**

Run:

```powershell
node --test scripts/test-sync-rpc-wire-compatibility.js scripts/test-sync-rpc.js
```

Expected: all legacy-default, current-opt-in, dual-decoder, queue, timeout,
blocked-path, error, and destroy tests pass.

- [ ] **Step 10: Commit dual-wire RPC support**

```powershell
git add -- scripts/test-sync-rpc-wire-compatibility.js src/common/utils/syncRpc.js src/common/utils/syncRpc.d.ts
git commit -m "feat: support current sync rpc wire protocol"
```

---

### Task 3: Select the Wire Protocol from the Authenticated Connection

**Files:**
- Modify: `scripts/test-sync-client-compatibility.js`
- Modify: `scripts/test-project-identity.js`
- Modify: `src/main/modules/sync/client/client.ts`
- Modify: `src/main/modules/sync/server/server/server.ts`

**Interfaces:**
- Consumes: `wireProtocol` from Task 2 and `getSyncProtocol(protocolId)`.
- Produces: fixed client-side selection and deferred built-in-server selection.

- [ ] **Step 1: Add failing client selection assertion**

Extend the existing
`socket connection uses the protocol stored on the key` test in
`scripts/test-sync-client-compatibility.js` with:

```js
assert.match(
  source,
  /wireProtocol:\s*getSyncProtocol\(keyInfo\.syncProtocol\)\.id/,
)
```

- [ ] **Step 2: Add failing built-in server selection assertion**

In `scripts/test-project-identity.js`, add:

```js
test('built-in sync server resolves RPC wire protocol after key assignment', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/main/modules/sync/server/server/server.ts'),
    'utf8',
  )
  assert.match(
    source,
    /wireProtocol:\s*\(\)\s*=>\s*getSyncProtocol\(socket\.keyInfo\.syncProtocol\)\.id/,
  )
  assert.match(
    source,
    /import\s+\{\s*getSyncProtocol\s*\}\s+from\s+'@common\/syncProtocol'/,
  )
})
```

- [ ] **Step 3: Verify connection selection tests are RED**

Run:

```powershell
node --test scripts/test-sync-client-compatibility.js scripts/test-project-identity.js
```

Expected: the two new source assertions fail because neither RPC constructor
currently receives `wireProtocol`.

- [ ] **Step 4: Pass a fixed wire protocol from the desktop client**

In `src/main/modules/sync/client/client.ts`, add this option to the existing
`createSyncRpc` call immediately after `timeout`:

```ts
wireProtocol: getSyncProtocol(keyInfo.syncProtocol).id,
```

The client already imports `getSyncProtocol` for its WebSocket connection
message, so no new import is needed.

- [ ] **Step 5: Pass a deferred wire protocol resolver from the built-in server**

In `src/main/modules/sync/server/server/server.ts`, add:

```ts
import { getSyncProtocol } from '@common/syncProtocol'
```

Add this option to the existing `createSyncRpc` call immediately after
`timeout`:

```ts
wireProtocol: () => getSyncProtocol(socket.keyInfo.syncProtocol).id,
```

The function must remain deferred. The RPC instance is created near line 181,
while `handleConnection` assigns `socket.keyInfo` near line 74 and then starts
the first outbound sync call near line 80.

- [ ] **Step 6: Verify connection selection tests are GREEN**

Run:

```powershell
node --test scripts/test-sync-client-compatibility.js scripts/test-project-identity.js
```

Expected: both files pass with zero failures.

- [ ] **Step 7: Run the focused cross-protocol regression suite**

Run:

```powershell
node --test scripts/test-sync-rpc-wire-compatibility.js scripts/test-sync-rpc.js scripts/test-sync-client-compatibility.js scripts/test-project-identity.js
```

Expected: all tests pass; the legacy `getEnabledFeatures` reproduction returns
a feature object instead of timing out.

- [ ] **Step 8: Commit connection-level selection**

```powershell
git add -- scripts/test-sync-client-compatibility.js scripts/test-project-identity.js src/main/modules/sync/client/client.ts src/main/modules/sync/server/server/server.ts
git commit -m "fix: select sync rpc wire protocol per connection"
```

---

### Task 4: Full Verification and Windows x64 Portable Delivery

**Files:**
- Verify: all tracked files
- Build artifact: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`

**Interfaces:**
- Consumes: the three implementation commits.
- Produces: verified source state and a hashed Windows x64 portable executable.

- [ ] **Step 1: Run all sync and detachment regression tests**

Run:

```powershell
node --test scripts/test-sync-rpc-wire-compatibility.js scripts/test-sync-rpc.js scripts/test-sync-client-compatibility.js scripts/test-project-identity.js scripts/test-upstream-detachment.js
```

Expected: zero failed, cancelled, or skipped tests.

- [ ] **Step 2: Run the complete source lint**

Run:

```powershell
npm run lint
```

Expected: exit code 0 and no ESLint diagnostics.

- [ ] **Step 3: Build the production bundles**

Run:

```powershell
npm run build
```

Expected: exit code 0 and production main/renderer bundles in `dist`.

- [ ] **Step 4: Run bundle and packaged-app tests**

Run:

```powershell
npm run test:main-bundle
npm run test:packaged-app
```

Expected: both commands exit 0 with zero failed tests.

- [ ] **Step 5: Ensure the existing portable executable is not running**

Run:

```powershell
$portable = 'D:\projects\lx-music-desktop\build\starky-lx-music-desktop-v3.0.0-x64-portable.exe'
$runningPortable = Get-CimInstance Win32_Process |
  Where-Object {
    $_.ExecutablePath -and
    [string]::Equals(
      $_.ExecutablePath,
      $portable,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  }
$runningPortable | Select-Object ProcessId, Name, ExecutablePath
```

If the command returns a process, verify its `ExecutablePath` equals the exact
path above, then stop only those returned IDs:

```powershell
$runningPortable | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force
}
```

- [ ] **Step 6: Build the Windows x64 portable executable**

Run:

```powershell
npm run pack:win:portable:x64
```

Expected: exit code 0 and
`build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` has a new modification
time.

- [ ] **Step 7: Hash and inspect the portable artifact**

Run:

```powershell
$portable = 'D:\projects\lx-music-desktop\build\starky-lx-music-desktop-v3.0.0-x64-portable.exe'
Get-Item -LiteralPath $portable |
  Select-Object FullName, Length, LastWriteTime
Get-FileHash -Algorithm SHA256 -LiteralPath $portable
```

Expected: the file exists, has non-zero length, and returns a SHA-256 hash.

- [ ] **Step 8: Verify final Git state and commit history**

Run:

```powershell
git status --short
git log --oneline -6
```

Expected: the worktree is clean; the design/plan commit and the three
implementation commits are visible. The portable artifact remains ignored and
does not appear in `git status`.
