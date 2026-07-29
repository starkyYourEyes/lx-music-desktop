# Sync RPC Wire Compatibility Design

**Date:** 2026-07-29

**Status:** Approved direction; implementation pending written-spec review

## Problem

The standalone sync server uses `message2call@0.1.3`. Its first RPC call after
WebSocket authentication is:

```json
{
  "name": "getEnabledFeatures__<random>",
  "path": ["getEnabledFeatures"],
  "data": ["server", "<supported-features>"]
}
```

The desktop application replaced `message2call` with its local `createSyncRpc`
implementation in commit `4096a86c5fc9a751d3980ce003e71a43dc447f76`.
The replacement only accepts this newer envelope:

```json
{
  "type": "call",
  "id": "<id>",
  "path": ["getEnabledFeatures"],
  "args": ["server", "<supported-features>"],
  "group": null
}
```

The desktop client therefore ignores the standalone server's valid legacy
request. The `getEnabledFeatures` handler is never called, the client sends no
response, and the server times out after 120 seconds.

An in-memory cross-implementation reproduction using the real
`message2call@0.1.3` package and the current local `createSyncRpc` produced:

```text
RESULT=timeout
HANDLER_CALLED=false
CLIENT_REPLIED=false
```

## Goals

1. Restore the legacy `message2call` wire behavior first.
2. Add compatibility with the current local `{type,id,path,args}` wire behavior
   on top of the restored legacy behavior.
3. Support all required peer combinations:
   - current desktop client to current desktop server;
   - current desktop client to standalone/original sync server;
   - original desktop or mobile client to current desktop server;
   - already-built current clients or servers that only understand the newer
     local RPC envelope.
4. Keep authentication, connection-message, and RPC-envelope selection
   automatic.
5. Preserve the local RPC implementation's path validation, error handling,
   queue recovery, and destroy behavior.
6. Do not modify the standalone server.
7. Do not reintroduce the `message2call` npm dependency or its upstream package
   metadata.

## Non-Goals

- Changing sync feature versions or module synchronization behavior.
- Changing connection-code authentication or WebSocket encryption.
- Recreating the removed implementation worktree or changing repository
  identity.
- Supporting arbitrary or malformed third-party RPC formats.

## Design

### 1. Canonical Internal Messages

`createSyncRpc` will keep one internal representation for calls, results, and
errors. Wire decoders translate an incoming envelope into that representation;
wire encoders translate an outgoing operation into the selected peer format.

This keeps function resolution, queues, timeouts, and pending-call settlement
independent from the wire format.

### 2. Legacy Format Is Restored First

The first implementation stage changes the local RPC wire behavior to match
`message2call@0.1.3`:

Legacy call:

```json
{
  "name": "<request-id>",
  "path": ["method", "path"],
  "data": ["argument-1", "argument-2"]
}
```

Legacy success response:

```json
{
  "name": "<request-id>",
  "error": null,
  "data": "<result>"
}
```

Legacy error response:

```json
{
  "name": "<request-id>",
  "error": "<message>"
}
```

The legacy format will be the default for `createSyncRpc`. The implementation
will retain own-property traversal and block `__proto__`, `prototype`, and
`constructor`; restoring the old wire behavior must not restore unsafe path
resolution.

### 3. Current Format Is Added as a Compatibility Layer

The second implementation stage adds a `wireProtocol` option:

```ts
type SyncRpcWireProtocol = 'legacy' | 'current'
type SyncRpcWireProtocolOption =
  | SyncRpcWireProtocol
  | (() => SyncRpcWireProtocol)
```

Outbound calls use the configured format:

- `legacy` sends `{name,path,data}` and receives `{name,error,data}`;
- `current` sends `{type,id,path,args,group}` and receives
  `{type:'result'|'error',id,...}`.

Incoming messages are always decoded from both formats. A response mirrors the
format of the incoming call. This allows a peer to receive either format
without ambiguous response handling.

The default is `legacy`, so any call site that does not select a format remains
compatible with `message2call`.

A resolver function is evaluated when an outbound call is encoded, rather than
when the RPC instance is created. The desktop client passes a fixed value
because its key is already available in `connect()`. The built-in server passes
a resolver because the WebSocket RPC instance is created before
`handleConnection()` assigns `socket.keyInfo`; its first outbound sync call is
made only after that assignment. This avoids duplicating key lookup or
reordering the connection lifecycle.

### 4. Per-Connection Format Selection

The existing authentication marker `keyInfo.syncProtocol` selects the outbound
RPC format:

| Authentication profile | RPC wire format |
| --- | --- |
| `legacy` | `legacy` |
| `current` | `current` |
| missing marker | `current` |

This mapping is applied in both desktop roles:

- desktop sync client connecting to a server;
- desktop application's built-in sync server accepting a client.

The missing-marker default remains `current` because existing unmarked keys
belong to current installations and may communicate with already-built peers
that only understand the newer local envelope.

Authentication fallback already persists `syncProtocol: 'legacy'` when the
current desktop connects to an original server. The current server already
stores `syncProtocol: 'legacy'` when an original client authenticates.
Therefore no new user setting or wire negotiation is required.

### 5. Lifecycle and Error Handling

Each WebSocket connection continues to own a fresh RPC instance. Closing one
socket destroys only that instance and rejects its pending and queued calls.
Reconnect creates a new instance with the same format selection rules.

Unknown formats are ignored. Recognized calls with invalid paths or arguments
receive an error in the request's own wire format. Send, encryption, parse, and
decrypt failures continue through the existing connection error paths.

## Compatibility Matrix

| Local role | Peer | Auth marker | Outbound format | Expected result |
| --- | --- | --- | --- | --- |
| current client | original server | `legacy` | legacy | compatible |
| current client | updated current server | `current` | current | compatible |
| current client | already-built current server | `current` | current | compatible |
| updated current server | original client | `legacy` | legacy | compatible |
| updated current server | updated current client | `current` | current | compatible |
| updated current server | already-built current client | `current` | current | compatible |

Because incoming decoding accepts both formats, format selection mistakes from
a mixed-version peer can still be handled when that peer initiates the call.

## Test Strategy

Implementation follows red-green-refactor in two stages.

### Stage 1: Restore Legacy Behavior

Add failing tests that use a small legacy peer harness with the exact
`message2call@0.1.3` envelopes. Tests must prove:

- a legacy peer can call `getEnabledFeatures` on `createSyncRpc`;
- `createSyncRpc` can call a legacy peer and settle its response;
- legacy errors reject with the remote error;
- legacy queue calls remain FIFO and recover after timeout;
- legacy destroy rejects in-flight, queued, and future calls.

Run the tests before implementation and record the expected timeout/no-handler
failure.

### Stage 2: Add Current Compatibility

Add failing tests that prove:

- `wireProtocol: 'current'` preserves the existing current envelope;
- incoming legacy and current calls both reach the same real handler;
- each response mirrors the incoming request format;
- legacy and current responses settle only the matching pending call;
- blocked paths are rejected in both formats;
- client and built-in server select the format from `keyInfo.syncProtocol`;
- reconnect creates a usable fresh RPC instance after the previous instance is
  destroyed.

The existing self-to-self RPC tests and sync authentication compatibility tests
remain part of the regression suite.

## Verification

Before packaging:

```powershell
node --test scripts/test-sync-rpc.js scripts/test-sync-client-compatibility.js scripts/test-project-identity.js scripts/test-upstream-detachment.js
npm run lint
```

The final integration check must reproduce the server's initialization call
with the legacy envelope and verify that `getEnabledFeatures` returns before
the timeout. A new Windows x64 portable build is produced only after all tests
and lint pass.

## Delivery

The implementation will be split into reviewable commits:

1. restore the legacy `message2call` wire behavior and its tests;
2. add current-envelope compatibility and per-connection selection;
3. apply any verification-only correction required by the full suite;
4. build and hash the Windows x64 portable executable.

The standalone sync-server repository is read-only reference material for this
work and will not be modified.
