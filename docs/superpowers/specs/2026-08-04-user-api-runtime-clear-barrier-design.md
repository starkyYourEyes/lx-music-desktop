# User API Runtime Clear Barrier Design

## Context

The storage-architecture merge moves Electron session data into an explicit
runtime root and adds isolated User API partitions. Deleting a User API source
can therefore require both runtime-window disposal and partition cleanup.

The runtime pool already retains late window creations after the caller's
ten-second deadline and destroys those windows before clearing their partition.
It also prevents a replacement runtime from being installed once cleanup has
entered its closing phase. The remaining race is narrower: a replacement can
still call `createRuntimeWindow()` after `clearRuntimeSession()` has started.
Preventing installation is too late because the raw window may already be
using the partition that is being cleared.

This document supplements
`2026-07-29-storage-architecture-design.md`. It changes only User API runtime
lifecycle coordination; it does not change data classification, physical
storage paths, migration behavior, or backup policy.

## Decision

Use an exclusive, per-source clear barrier in the runtime pool.

For a given `apiId`, the barrier closes synchronously before partition cleanup
starts and remains closed until that cleanup succeeds. A runtime creation must
pass the barrier immediately before the raw `createRuntimeWindow()` call. No
promise turn or other asynchronous boundary may exist between the final
admission check and invoking raw creation.

The barrier is deliberately narrower than a general lifecycle mutex. Existing
creation, initialization, request, lease, and retirement behavior remains
concurrent except where partition cleanup requires exclusion.

## Binding Invariants

For each `apiId`:

1. Partition cleanup may start only after every previously admitted raw runtime
   has either failed creation or been destroyed successfully.
2. Once the clear barrier closes, no new raw `createRuntimeWindow()` call may
   start until partition cleanup succeeds.
3. A creation admitted before the barrier closes remains owned by the existing
   retirement aggregate. Cleanup waits for that creation to settle and, if it
   produces a window, for that window to be destroyed.
4. An `ensure()` arriving after the barrier closes does not join the destruction
   aggregate because it has not created a raw runtime. It waits on the barrier.
5. Successful cleanup opens the barrier. Waiting `ensure()` calls retry through
   the normal single-flight `ensureRecord()` path and therefore create at most
   one replacement generation.
6. Failed cleanup keeps retirement ownership and the barrier closed. Waiting
   `ensure()` calls reject with the retained cleanup failure; they do not retry
   cleanup implicitly or create a runtime.
7. A later explicit disposal request may retry failed cleanup. Recreation is
   allowed only after that retry succeeds.
8. `clearSession` remains a monotonic upgrade. A `true` request cannot be lost
   behind an earlier `false` retirement.

## State Ownership

The existing per-source creation-retirement state remains the owner of late
creations and deferred partition cleanup. Its closing state is refined into an
observable barrier with these logical phases:

- `draining`: cleanup is requested, but admitted creations or records still
  need to settle and be destroyed;
- `clearing`: all admitted owners are gone, the barrier is closed, and the
  partition clear attempt is in flight;
- `failed`: the clear attempt failed, ownership is retained, and creation stays
  blocked until explicit retry;
- `complete`: the clear succeeded and the retirement state may be removed.

These may be represented by explicit phase fields or equivalent retained
promise/state fields. The implementation must preserve the observable
transitions and invariants, not a particular type shape.

The pool remains the authority for admission. Lower-level runtime disposal
continues to own the exact window-destroy and Electron-session operations. A
record retirement already blocks recreation through `retiringByApiId`; the new
barrier closes the gap in the late-creation aggregate's direct session-clear
path.

## Creation Flow

`ensureRecord(apiId)` follows this order:

1. Reject a retained failed retirement without creating anything.
2. Await an active successful clear attempt, then restart `ensureRecord()` so
   source existence, current records, and concurrent creation are re-evaluated.
3. Reuse an existing record or admitted creation when available.
4. At the raw-creation admission point, synchronously verify that no clear
   barrier is active and invoke `createRuntimeWindow()` in the same turn.
5. Publish and retain enough state before yielding so a cleanup request that
   follows admission can discover and drain the raw creation.

If cleanup closes the barrier before admission, no generation is installed or
initialized. The post-clear retry uses current source information rather than
a stale pre-clear snapshot.

The ten-second initialization deadline begins with an admitted creation, as it
does today. Time spent waiting for an already active partition clear is a
cleanup prerequisite, not a blocked raw creation. This avoids creating a
runtime after its own deadline has already expired.

## Cleanup Flow

An explicit `clearSession: true` retirement continues to return at the existing
ten-second lifecycle deadline when an already admitted raw creation is blocked.
The retained aggregate owns the remaining work in the background.

When all admitted creations and records are safely gone, the aggregate:

1. closes the per-source barrier synchronously;
2. rechecks ownership/version state before starting the clear;
3. invokes `clearRuntimeSession(apiId)` exactly once for that attempt;
4. on success, marks cleanup complete, removes the retained retirement, and
   releases waiting creation calls to retry;
5. on failure, records the exact failure, retains the closed barrier, and leaves
   cleanup available only to an explicit disposal retry.

New `ensure()` calls cannot extend or join an in-flight clear attempt. This
prevents a deadlock where cleanup waits for a creation that is itself waiting
for cleanup.

## Error Handling

- Raw creation or destruction failures retain the existing retry semantics.
- A clear failure is logged through the existing lifecycle observer and remains
  reachable through the pool; it must not become an unhandled rejection.
- Waiting `ensure()` calls receive the retained failure and do not silently
  fall through to a fresh generation.
- A successful explicit cleanup retry releases the barrier exactly once.
- Source deletion or replacement while waiting is handled by re-entering
  `ensureRecord()` after a successful clear, which revalidates current source
  state.

## Verification

Add focused regressions to the real runtime-pool harness:

1. Gate `clearRuntimeSession()`, observe that it has started, call `ensure()`,
   and prove generation 2 does not call raw creation until the clear resolves.
2. After clear success, prove the waiting `ensure()` retries normally and only
   one replacement generation is created for concurrent waiters.
3. Make the clear fail and prove waiting `ensure()` calls reject, no raw
   generation starts, and retirement remains owned.
4. Retry through explicit `dispose(..., { clearSession: true })`, then prove a
   later `ensure()` can create after successful cleanup.
5. Preserve all existing blocked-creation, late-destruction, monotonic-upgrade,
   generation-isolation, failed-retirement, `disposeAll()`, and proxy-unsubscribe
   regressions.

Run at minimum:

```powershell
$env:NODE_COMPILE_CACHE='.superpowers/t/node-compile-cache'
node --test build-config/user-api/runtime-pool.test.js
npm run build:main
```

## Scope

Expected implementation changes are limited to:

- `src/main/modules/userApi/runtimePool.ts`;
- `build-config/user-api/runtime-pool.test.js`;
- narrowly required runtime-pool harness observers or gates;
- the existing runtime-lifecycle implementation and review reports.

No storage layout, migration, renderer, playback, credential, backup, or cache
policy changes are part of this design.
