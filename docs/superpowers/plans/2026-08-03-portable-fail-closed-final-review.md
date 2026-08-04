# Portable Fail-Closed Final Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the remaining portable-storage races and hard-link dependencies while preserving NTFS, FAT32, and exFAT support, fail-closed schema cutover, complete Electron cache clearing, and account-scoped URL persistence.

**Architecture:** Three bootstrap-safe ownership modules provide direct-directory guards, two-stage exclusive immutable artifacts, and exclusive isolation directories. Every destructive consumer moves its exact owned node into a private directory before reclaiming bytes, while database cutover binds one resumable unique backup to schema-6 and verifies its open guard inside migration 7 immediately before commit. Electron default-session registration and a main-only per-provider account-generation FIFO close the two non-filesystem races.

**Tech Stack:** Node.js 22, TypeScript 5.9, Electron 37, better-sqlite3 12, CommonJS bootstrap modules, `proper-lockfile` 4.1.2, Node.js test runner, PowerShell.

## Global Constraints

- Production behavior must work on NTFS, FAT32, and exFAT and must contain no `fs.link`, `fs.linkSync`, `FileHandle.link`, or equivalent required hard-link operation under `src/**`.
- Correctness must not depend on hard-link support or directory-fsync support.
- Mutable stable paths are never unlinked or recursively removed after only an earlier identity check. They must first move into an exclusively created private direct-child isolation directory.
- Unknown, changed, linked, non-empty, mismatched, or ambiguous nodes are retained. No operation scans for or chooses an unreferenced retained artifact.
- A fresh database reaches schema 7 without creating or mutating `backupsRoot`. An existing schema-6 database cannot reach schema 7 without one verified pre-cutover backup.
- Existing schema-6 retries reuse the exact `legacy_cache_v1.backup_prepared` artifact. They never allocate a second candidate while that marker exists.
- The prepared marker binds the canonical schema-6 logical source state in `source_sha256`; a restarted process verifies it and resumes cutover before any other database mutation hook.
- Cutover marker version 2 is the only format written. Existing cutover marker version 1 remains strict read-only compatibility and is never relinked, repaired, deleted, or rewritten.
- Bootstrap creates or validates only required profile, temp, runtime, session-data, and run-temp roots. A missing cache root is created only by the cache owner after independently re-reading the Phase 3 prerequisite. A missing backup root is created only by the existing-database backup owner.
- `retired-retained` is fail-closed while its exact payload remains: startup stops before database open. If an operator later removes that exact payload and leaves the journal-bound private directory empty, the next startup may finalize `retired`; production never removes it automatically.
- Migration leases use `proper-lockfile` `4.1.2` with production constants `stale: 30_000`, `update: 10_000`, and exactly three fixed 250 ms retries. Every process uses `realpath: false` and the same direct contained `lockfilePath`.
- A migration lease compromise is sticky. Every promotion, journal or receipt mutation, source retirement, and guarded-stage cleanup calls `lease.assertHeld()` immediately before mutation.
- `session.defaultSession` is registered after `app.whenReady()` and before any tray, lyric, main, login, or User API window can be created. Production never calls its registration's `unregister()`.
- Persistent music URL reads and writes require a main-issued provider, normalized account scope, and generation authorization. Old flat renderer payloads are rejected.
- User API music URLs remain non-persistent and never request an account authorization.
- All implementation follows RED/GREEN TDD. Tests use only `.superpowers/t` or an explicit disposable real-volume smoke root; no real profile, portable, cache, backup, or user configuration directory may be read or mutated.
- Preserve unrelated user changes. Stage and commit only the files named by the current task.

## File Structure

- Create `src/main/storage/directDirectory.js` and `directDirectory.d.ts` for bootstrap-safe direct-directory observation, exclusive child creation, and descriptor-backed revalidation.
- Create `src/main/storage/exclusiveArtifact.js` and `exclusiveArtifact.d.ts` for unique `O_EXCL` reservation and bounded verified completion.
- Create `src/main/storage/exclusiveIsolation.js` and `exclusiveIsolation.d.ts` for private directory reservation, stable-path isolation, and exact reclamation.
- Create `src/main/migration/migrationLease.js` and `migrationLease.d.ts` as the only `proper-lockfile` adapter.
- Keep guarded directory migration and portable migration in their existing CommonJS files so pre-Electron startup remains directly testable.
- Rewrite `src/main/worker/dbService/databaseBackup.ts` as the database-specific artifact/resume owner; keep generic filesystem ownership out of `db.ts`.
- Keep cutover marker parsing and semantic evidence in `src/main/migration/cache/cutover.ts`; pass final guard validation through the migration context.
- Create `src/main/services/defaultSessionLifetime.ts` for process-lifetime default-session admission.
- Create `src/main/services/musicUrlAuthorization.ts` for per-provider FIFO authorization, worker writes, and authoritative account transitions.
- Create `build-config/storage/portable-filesystem-smoke.js` for explicit NTFS/FAT32/exFAT evidence and `portable-filesystem.test.js` for its safety/static contract.

---

### Task 1: Validate and Publish Storage Roots Before Electron Paths

**Files:**
- Create: `src/main/storage/directDirectory.js`
- Create: `src/main/storage/directDirectory.d.ts`
- Modify: `src/main/utils/storagePaths.ts`
- Modify: `src/main/bootstrap.ts`
- Modify: `src/main/utils/tempLifecycle.ts`
- Modify: `src/main/application.ts`
- Modify: `src/main/types/app.d.ts`
- Modify: `src/main/worker/dbService/cacheDb.ts`
- Test: `build-config/storage/local-artwork-worker.test.js`
- Test: `build-config/storage/storage-paths.test.js`
- Test: `build-config/storage/startup-coordinator.test.js`
- Test: `build-config/storage/temp-lifecycle.test.js`
- Test: `build-config/storage/theme-asset-manager.test.js`
- Test: `build-config/storage/theme-store-transaction.test.js`
- Test: `build-config/storage-electron/cache-db.test.js`

**Interfaces:**
- Produces: `validateDirectDirectory(path, options?): DirectDirectoryGuard`.
- Produces: `observeDirectChild(parent, basename): DirectDirectoryObservation`.
- Produces: `createDirectChildDirectory(parent, basename, options?): DirectDirectoryGuard`.
- Produces: `revalidateDirectDirectory(guard): void` and `closeDirectDirectory(guard): void`.
- Produces: `prepareRunTempLifecycle(input): Promise<RunTempReservation>`.
- Changes: `initializeStoragePaths(input): Promise<{ paths: Readonly<StoragePaths>, runTempReservation: RunTempReservation }>`.
- Changes: `createRunTempHandle({ reservation }): Promise<RunTempHandle>`; it no longer accepts caller-supplied temp paths.
- Preserves: `StoragePaths` string fields and `global.lxDataPath` compatibility alias.

- [ ] **Step 1: Write failing root, publication-order, and run reservation tests**

Add exact type-shape and behavior tests:

```js
it('rejects profile temp and portable junction roots before any app.setPath call', async(t) => {
  const calls = []
  const result = await runBootstrapWithLinkedRoot(t, calls)
  assert.equal(result.exited, 1)
  assert.deepEqual(calls, [])
})

it('creates runtime and sessionData before publication while leaving cache and backups absent', async() => {
  const initialized = await initializeFixture()
  assert.equal(fs.statSync(initialized.paths.runtimeRoot).isDirectory(), true)
  assert.equal(fs.statSync(initialized.paths.sessionDataRoot).isDirectory(), true)
  assert.equal(fs.existsSync(initialized.paths.cacheRoot), false)
  assert.equal(fs.existsSync(initialized.paths.backupsRoot), false)
  assert.equal(fs.existsSync(path.join(initialized.paths.runTempRoot, '.owner.v1.json')), true)
})

it('rejects a parent identity swap during direct-child creation', () => {
  const parent = validateDirectDirectory(fixture.parent)
  replaceDirectory(fixture.parent)
  assert.throws(
    () => createDirectChildDirectory(parent, 'child', { mode: 0o700 }),
    error => error.code == 'direct_directory_changed',
  )
})

it('adopts only the bootstrap-created run directory and owner marker', async() => {
  const initialized = await initializeFixture()
  await assert.rejects(
    createRunTempHandle({ reservation: { ...initialized.runTempReservation, runTempRoot: fixture.foreign } }),
    /run_temp_owner_invalid/,
  )
})
```

In `cache-db.test.js` add tests named `creates a missing cache root only after re-reading the phase-3 prerequisite` and `rejects a cache-root parent replacement before child creation`. The first test fingerprints the missing cache parent before a rejected prerequisite and asserts that neither `cacheRoot` nor `cache.db` exists.

Add `rejects a linked existing portable profile when no legacy source exists` to prove source-less portable startup validates `portable/profile` before it can become `userData`.

Add `rejects existing linked cache and backups roots before publication` and `rejects a Windows reparse directory even when it reports as a directory`. The latter uses a Windows fixture when available and an injected `lstat`/`realpath` adapter elsewhere so non-symbolic-link reparse/realpath divergence remains covered on every CI host.

Update every existing run-temp fixture in `local-artwork-worker.test.js`, `startup-coordinator.test.js`, `temp-lifecycle.test.js`, `theme-asset-manager.test.js`, and `theme-store-transaction.test.js` to obtain its run directory from `prepareRunTempLifecycle` and pass only that returned reservation to `createRunTempHandle`. These callers must no longer pre-create or supply `runTempRoot`.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test build-config/storage/storage-paths.test.js build-config/storage/temp-lifecycle.test.js build-config/storage/local-artwork-worker.test.js build-config/storage/startup-coordinator.test.js build-config/storage/theme-asset-manager.test.js build-config/storage/theme-store-transaction.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-db.test.js
```

Expected: FAIL because roots are recursively created, `initializeStoragePaths` returns no reservation, the reservation-only API does not exist, and cache root creation does not consume a direct-directory guard.

- [ ] **Step 3: Implement direct-directory guards and bootstrap ordering**

Declare the exact public contract:

```ts
export interface NodeIdentity {
  dev: string
  ino: string
}

export interface DirectDirectoryGuard {
  path: string
  realPath: string
  descriptor: number
  identity: NodeIdentity
  ancestry: ReadonlyArray<{ path: string, identity: NodeIdentity }>
}

export type DirectDirectoryObservation =
  | { status: 'present', guard: DirectDirectoryGuard }
  | { status: 'absent', parent: DirectDirectoryGuard, path: string, basename: string }

export function validateDirectDirectory(
  directoryPath: string,
  options?: { fsApi?: typeof import('node:fs'), pathApi?: typeof import('node:path') },
): DirectDirectoryGuard

export function observeDirectChild(
  parent: DirectDirectoryGuard,
  basename: string,
): DirectDirectoryObservation

export function createDirectChildDirectory(
  parent: DirectDirectoryGuard,
  basename: string,
  options?: { mode?: number },
): DirectDirectoryGuard

export function revalidateDirectDirectory(guard: DirectDirectoryGuard): void
export function closeDirectDirectory(guard: DirectDirectoryGuard): void
```

`validateDirectDirectory` walks every existing lexical ancestor with `lstatSync({ bigint: true })`, rejects links/non-directories, opens the leaf directory, compares `fstatSync` identity, and requires normalized `realpathSync.native` equality. `createDirectChildDirectory` revalidates the parent, calls non-recursive `mkdirSync(child, { mode })`, captures the child, and revalidates parent and child. `EEXIST` validates the exact existing directory; it never replaces it.

Define the run reservation in `tempLifecycle.ts` so bootstrap creates the run directory and owner marker once and `application.ts` can only adopt that exact result:

```ts
export interface RunTempReservation {
  tempRoot: string
  tempRootIdentity: NodeIdentity
  runTempRoot: string
  runTempIdentity: NodeIdentity
  markerPath: string
  markerIdentity: NodeIdentity
  markerRaw: string
  runId: string
}

export function prepareRunTempLifecycle(input: {
  tempRoot: string
  runId?: string
}): Promise<RunTempReservation>

export function createRunTempHandle(input: {
  reservation: RunTempReservation
}): Promise<RunTempHandle>
```

`prepareRunTempLifecycle` validates the direct temp root, exclusively creates one unpredictable `run-*` child, writes owner marker v1 with `wx`, captures both identities and the exact marker bytes, and returns a frozen reservation only after final revalidation. `createRunTempHandle` rejects any changed field, ancestry, identity, or marker and never creates or rewrites the run root or marker.

Use this exact fixture shape at every test caller:

```js
await fsp.mkdir(tempRoot, { recursive: true })
const { prepareRunTempLifecycle, createRunTempHandle } = loadLifecycle(fsPromises)
const reservation = await prepareRunTempLifecycle({ tempRoot, runId })
const runTempRoot = reservation.runTempRoot
const handle = await createRunTempHandle({ reservation })
```

For injected-filesystem race tests, obtain both functions from the same `loadLifecycle(injectedFs)` call and arm replacement hooks only after reservation adoption. For the stale-run scavenging test, leave a reservation-created run unclean and pass its `runTempRoot` to assertions; do not synthesize an owner marker through the adoption API.

Remove `tempLifecycle.ts`'s runtime import of `assertContainedPath` from `storagePaths.ts`; use `directDirectory.js` plus local direct-child checks instead. This lets `storagePaths.ts` invoke temp lifecycle preparation without a circular runtime dependency.

Make initialization asynchronous and move stale-run scavenging before new run creation:

```ts
export interface InitializedStoragePaths {
  paths: Readonly<StoragePaths>
  runTempReservation: RunTempReservation
}

export const initializeStoragePaths = async(
  input: StoragePathResolutionInput,
): Promise<InitializedStoragePaths> => {
  const resolved = resolveStoragePaths(input)
  await validateAndCreateRequiredRoots(resolved)
  await validateOptionalRootIfPresent(resolved.cacheRoot)
  await validateOptionalRootIfPresent(resolved.backupsRoot)
  await scavengeRunTempRoots(resolved.tempRoot)
  const runTempReservation = await prepareRunTempLifecycle({ tempRoot: resolved.tempRoot })
  return {
    paths: Object.freeze({ ...resolved, runTempRoot: runTempReservation.runTempRoot }),
    runTempReservation,
  }
}
```

In `bootstrap.ts` await this result, publish `userData` and `sessionData` only afterward, and store `global.runTempReservation`. In `application.ts` remove the later scavenging call and consume that reservation exactly once. In `cacheDb.ts` independently re-read the Phase 3 prerequisite, then validate the cache parent and create the missing direct child; a coordinator-passed prerequisite is not mutation authority.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the three Step 2 commands again. Expected: all selected tests pass and no missing cache/backup root is created early.

- [ ] **Step 5: Commit the root boundary**

```powershell
git add src/main/storage/directDirectory.js src/main/storage/directDirectory.d.ts src/main/utils/storagePaths.ts src/main/bootstrap.ts src/main/utils/tempLifecycle.ts src/main/application.ts src/main/types/app.d.ts src/main/worker/dbService/cacheDb.ts build-config/storage/local-artwork-worker.test.js build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js build-config/storage/temp-lifecycle.test.js build-config/storage/theme-asset-manager.test.js build-config/storage/theme-store-transaction.test.js build-config/storage-electron/cache-db.test.js
git commit -m "refactor: validate storage roots before publication"
```

### Task 2: Add Two-Stage Exclusive Immutable Artifacts

**Files:**
- Create: `src/main/storage/exclusiveArtifact.js`
- Create: `src/main/storage/exclusiveArtifact.d.ts`
- Create: `build-config/storage/exclusive-artifact.test.js`

**Interfaces:**
- Consumes: a live `DirectDirectoryGuard` from Task 1.
- Produces: `reserveExclusiveArtifact(root, options): ExclusiveArtifactReservation`.
- Produces: `completeExclusiveArtifact(reservation, source, options): ImmutableArtifactGuard`.
- Produces: `closeArtifactReservation(reservation): void` for a retained attempt abandoned before completion.
- Produces: `revalidateImmutableArtifact(guard): void` and `closeArtifactGuard(guard): void`.
- Guarantees: zero-length reservation precedes bytes; no rename, link, overwrite, automatic failed-attempt deletion, or directory fsync.

- [ ] **Step 1: Write failing reservation and completion tests**

```js
it('reserves a zero-length same-root regular file with O_EXCL and mode 0600', () => {
  const root = validateDirectDirectory(fixture.root)
  const reservation = reserveExclusiveArtifact(root, {
    prefix: '.lx-artifact-',
    suffix: '.attempt',
    artifactKind: 'test-v1',
  })
  assert.equal(fs.fstatSync(reservation.descriptor).size, 0)
  assert.equal(path.dirname(reservation.path), path.resolve(fixture.root))
  assert.equal(fs.statSync(reservation.path).mode & 0o777, 0o600)
})

it('completes bounded chunks without link rename or a staging alias', () => {
  const guard = completeFixtureArtifact(Buffer.from('verified bytes'))
  assert.equal(guard.byteLength, 14)
  assert.equal(guard.sha256, sha256(Buffer.from('verified bytes')))
  assert.deepEqual(fs.readdirSync(fixture.root), [guard.basename])
})

it('retains a partial attempt after write sync or semantic verification failure', () => {
  const error = assert.throws(() => completeWithInjectedFailure())
  assert.equal(error.code, 'artifact_verification_failed')
  assert.equal(fs.readdirSync(fixture.root).length, 1)
})
```

Also add `closing an abandoned reservation retains its zero-length attempt`, `rejects a root replacement immediately before and after O_EXCL reservation`, `rejects pathname and root replacement at final guard revalidation`, and `works with an adapter that exposes no link and no directory fsync`.

- [ ] **Step 2: Run the artifact test and verify RED**

Run:

```powershell
node --test build-config/storage/exclusive-artifact.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the exact reservation/guard API**

```ts
export type ArtifactKind =
  | 'database-backup-v1'
  | 'theme-image-v1'
  | 'portable-smoke-v1'
  | 'test-v1'

export interface BoundedByteSource {
  byteLength: number
  read(offset: number, maximumBytes: number): Buffer
}

export interface ExclusiveArtifactReservation {
  root: DirectDirectoryGuard
  path: string
  basename: string
  descriptor: number
  identity: NodeIdentity
  artifactKind: ArtifactKind
}

export interface ImmutableArtifactGuard extends ExclusiveArtifactReservation {
  sha256: string
  byteLength: number
}

export function reserveExclusiveArtifact(
  root: DirectDirectoryGuard,
  options: {
    prefix: string
    suffix: string
    artifactKind: ArtifactKind
    randomBytes?: (size: number) => Buffer
  },
): ExclusiveArtifactReservation

export function completeExclusiveArtifact(
  reservation: ExclusiveArtifactReservation,
  source: BoundedByteSource,
  options?: {
    chunkBytes?: number
    verifyReadOnly?: (input: {
      path: string
      readDescriptor: number
      sha256: string
      byteLength: number
    }) => void
  },
): ImmutableArtifactGuard

export function closeArtifactReservation(
  reservation: ExclusiveArtifactReservation,
): void

export function revalidateImmutableArtifact(guard: ImmutableArtifactGuard): void
export function closeArtifactGuard(guard: ImmutableArtifactGuard): void
```

Reservation revalidates the root immediately before each `O_CREAT | O_EXCL | O_WRONLY` attempt, uses mode `0o600`, a 16-byte random token, and at most eight collisions. Immediately after open it proves the descriptor is a regular file, the pathname still resolves to that descriptor identity as a direct child of the same root, and the root guard is unchanged. A before/after root swap closes the descriptor, retains any zero-byte node already created, and fails without writing payload bytes. Completion again revalidates root/path/descriptor, writes at most `source.byteLength` in 1 MiB chunks, rejects short/long sources, fsyncs the file descriptor, opens a second read-only descriptor for hash/semantic verification, and revalidates pathname-to-original-descriptor identity before and after the callback. Failure closes descriptors but retains the attempt. Closing either reservation or completed guard is idempotent, closes only owned descriptors, and never deletes or renames the artifact.

- [ ] **Step 4: Run the artifact test and verify GREEN**

Run the Step 2 command. Expected: all artifact tests pass.

- [ ] **Step 5: Commit the immutable primitive**

```powershell
git add src/main/storage/exclusiveArtifact.js src/main/storage/exclusiveArtifact.d.ts build-config/storage/exclusive-artifact.test.js
git commit -m "feat: add exclusive immutable artifact guards"
```

### Task 3: Add Exclusive Isolation and Exact Reclamation

**Files:**
- Create: `src/main/storage/exclusiveIsolation.js`
- Create: `src/main/storage/exclusiveIsolation.d.ts`
- Create: `build-config/storage/exclusive-isolation.test.js`

**Interfaces:**
- Consumes: `DirectDirectoryGuard` and `NodeIdentity` from Task 1.
- Produces: `reserveExclusiveIsolation`, `reopenExclusiveIsolation`, `isolateOwnedPath`, and `reclaimIsolatedPayload` with the exact signatures below.
- Guarantees: the only destination inside a private isolation directory is fixed basename `payload`; there is no restore operation.

- [ ] **Step 1: Write failing isolation race tests**

```js
it('reports conflict and preserves both payload and stable-path replacement', async() => {
  const source = await captureOwnedFile(fixture.root, 'cache.db')
  const isolation = await reserveExclusiveIsolation({
    root: source.root,
    prefix: '.lx-isolation-',
  })
  const result = await isolateOwnedPath({
    source,
    reservation: isolation,
    beforeStableAbsenceCheck: () => fs.writeFileSync(source.path, 'replacement', { flag: 'wx' }),
  })
  assert.equal(result.state, 'conflict')
  assert.equal(fs.readFileSync(source.path, 'utf8'), 'replacement')
  assert.equal(fs.readFileSync(isolation.payloadPath, 'utf8'), 'owned')
})

it('reclaims only an exactly verified payload with no unexpected siblings', async() => {
  const isolated = await isolateFixtureDirectory()
  fs.writeFileSync(path.join(isolated.guard.isolationPath, 'unexpected'), 'keep')
  const result = await reclaimIsolatedPayload({ guard: isolated.guard, verifyPayload })
  assert.equal(result.state, 'retained')
  assert.equal(fs.existsSync(isolated.guard.payloadPath), true)
})
```

Add tests named `reserves an unpredictable empty direct-child isolation directory exclusively`, `retries EEXIST without adopting or replacing the existing node`, and `retains the private directory when identity marker or removal verification fails`.

- [ ] **Step 2: Run the isolation test and verify RED**

```powershell
node --test build-config/storage/exclusive-isolation.test.js
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement reservation, move, conflict, and reclaim states**

```ts
export interface OwnedDirectNode {
  root: DirectDirectoryGuard
  path: string
  basename: string
  identity: NodeIdentity
  kind: 'file' | 'directory'
}

export interface IsolationReservation {
  root: DirectDirectoryGuard
  isolationPath: string
  isolationBasename: string
  isolationIdentity: NodeIdentity
  payloadPath: string
}

export interface IsolatedPayloadGuard extends IsolationReservation {
  sourcePath: string
  expectedIdentity: NodeIdentity
  payloadIdentity: NodeIdentity
  kind: 'file' | 'directory'
}

export type IsolationResult =
  | { state: 'absent' }
  | { state: 'isolated', guard: IsolatedPayloadGuard }
  | { state: 'conflict', reservation: IsolationReservation, error: Error }

export function reserveExclusiveIsolation(input: {
  root: DirectDirectoryGuard
  prefix: string
  randomBytes?: (size: number) => Buffer
}): Promise<IsolationReservation>

export function reopenExclusiveIsolation(input: {
  root: DirectDirectoryGuard
  isolationBasename: string
  isolationIdentity: NodeIdentity
}): Promise<IsolationReservation>

export function isolateOwnedPath(input: {
  source: OwnedDirectNode
  reservation?: IsolationReservation
  prefix?: string
  onReserved?: (reservation: IsolationReservation) => Promise<void>
  verifySource?: (sourcePath: string) => Promise<void>
  beforeStableAbsenceCheck?: () => Promise<void> | void
}): Promise<IsolationResult>

export function reclaimIsolatedPayload(input: {
  guard: IsolatedPayloadGuard
  verifyPayload?: (payloadPath: string) => Promise<void>
}): Promise<
  { state: 'reclaimed' } |
  { state: 'retained', error: Error }
>
```

Reserve with non-recursive `mkdir` mode `0o700` and eight unpredictable-name attempts. Revalidate root/reservation/source, rename source to `payload`, verify moved identity and optional marker, run the optional deterministic test interleaving hook, then revalidate the stable path as absent. Production callers never supply that hook. A replacement yields `conflict` and both nodes remain. Reclaim verifies the isolation directory identity, exact `payload` identity/marker, and that `readdir(isolationPath)` is exactly `['payload']` before removing; any remaining or changed node returns `retained`.

- [ ] **Step 4: Run the isolation test and verify GREEN**

Run the Step 2 command. Expected: all isolation tests pass.

- [ ] **Step 5: Commit the isolation primitive**

```powershell
git add src/main/storage/exclusiveIsolation.js src/main/storage/exclusiveIsolation.d.ts build-config/storage/exclusive-isolation.test.js
git commit -m "feat: add exclusive path isolation"
```

### Task 4: Replace Hard-Link Migration Locks With `proper-lockfile` Leases

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/migration/migrationLease.js`
- Create: `src/main/migration/migrationLease.d.ts`
- Create: `build-config/storage/migration-lease.test.js`

**Interfaces:**
- Consumes: direct contained lock paths ending in the existing `.migration.lock` names.
- Produces: `acquireMigrationLease(options): Promise<MigrationLease>` and `releaseMigrationLease(lease): Promise<void>`.
- Production dependency: exact direct runtime dependency `"proper-lockfile": "4.1.2"`.
- Preserves: lock path names; changes their node type from regular file to empty directory.

- [ ] **Step 1: Write failing lease protocol tests**

```js
it('acquires without hard links and releases only the owned empty lease directory', async() => {
  const lease = await acquireMigrationLease(fixture.options)
  assert.equal(fs.lstatSync(fixture.lockPath).isDirectory(), true)
  assert.deepEqual(fs.readdirSync(fixture.lockPath), [])
  lease.assertHeld()
  await releaseMigrationLease(lease)
  assert.equal(fs.existsSync(fixture.lockPath), false)
})

it('preserves and rejects a non-empty or linked lease path', async(t) => {
  fs.mkdirSync(fixture.lockPath)
  fs.writeFileSync(path.join(fixture.lockPath, 'unknown'), 'keep')
  await assert.rejects(acquireMigrationLease(fixture.options), /migration_lease_invalid/)
  assert.equal(fs.readFileSync(path.join(fixture.lockPath, 'unknown'), 'utf8'), 'keep')
})

it('rejects every mutation after the compromise callback fires', async() => {
  const lease = await acquireMigrationLease(fixture.options)
  fixture.compromise(new Error('injected'))
  assert.throws(() => lease.assertHeld(), /migration_lease_compromised/)
})
```

Also cover crash immediately after `mkdir` and before first heartbeat, live heartbeat blocking, unchanged stale empty-directory recovery, identity change, and release failure retention.

- [ ] **Step 2: Install the direct dependency and verify RED**

Run:

```powershell
npm install --save --save-exact proper-lockfile@4.1.2
node --test build-config/storage/migration-lease.test.js
```

Expected: dependency installation succeeds, then the test FAILS because `migrationLease.js` does not exist. Keep the package manifest/lockfile change for the GREEN implementation.

- [ ] **Step 3: Implement the controlled lease adapter**

```ts
export interface MigrationLease {
  rootPath: string
  rootIdentity: NodeIdentity
  lockPath: string
  lockIdentity: NodeIdentity
  assertHeld(): void
}

export function acquireMigrationLease(input: {
  rootPath: string
  lockPath: string
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
}): Promise<MigrationLease>

export function releaseMigrationLease(lease: MigrationLease): Promise<void>
```

Call `properLockfile.lock(rootPath, options)` with:

```js
const PRODUCTION_LEASE_OPTIONS = Object.freeze({
  stale: 30_000,
  update: 10_000,
  realpath: false,
  retries: Object.freeze({
    retries: 3,
    factor: 1,
    minTimeout: 250,
    maxTimeout: 250,
    randomize: false,
  }),
})
```

Set `lockfilePath` to the validated direct child. The controlled filesystem adapter allows only `mkdir`, `stat`, `lstat`, `readdir`, `utimes`, and empty-directory `rmdir` on the exact lock path. It rejects links, files, unexpected entries, root swaps, and lock identity changes. `onCompromised` stores a sticky fixed error. `releaseMigrationLease` calls `assertHeld()`, then the package release function; it surfaces release failure and never recursively removes the path.

- [ ] **Step 4: Run lease tests and verify GREEN**

```powershell
node --test build-config/storage/migration-lease.test.js
npm ls proper-lockfile
```

Expected: tests pass and `npm ls` shows `proper-lockfile@4.1.2` as a direct application dependency.

- [ ] **Step 5: Commit lease and dependency**

```powershell
git add package.json package-lock.json src/main/migration/migrationLease.js src/main/migration/migrationLease.d.ts build-config/storage/migration-lease.test.js
git commit -m "refactor: use portable migration leases"
```

### Task 5: Convert Guarded Directory Migration to Leases and Isolated Stage Cleanup

**Files:**
- Modify: `src/main/migration/guardedDirectoryMigration.js`
- Modify: `src/main/migration/guardedDirectoryMigration.d.ts`
- Modify: `src/main/migration/legacyUserData.js`
- Modify: `src/main/migration/legacyUserData.d.ts`
- Modify: `src/main/bootstrap.ts`
- Create: `build-config/storage/guarded-directory-migration.test.js`
- Modify: `scripts/test-legacy-user-data-migration.js`

**Interfaces:**
- Consumes: direct-directory guards from Task 1, isolation helpers from Task 3, and `MigrationLease` from Task 4.
- Changes: `copyDirectoryWithManifestPromotion(options): Promise<DirectoryPromotionResult>` and requires `lease: MigrationLease`.
- Changes: `createDirectoryManifest(fsApi, rootPath): Promise<DirectoryManifestEntry[]>`.
- Changes: `migrateLegacyUserData(options): Promise<MigrationResult>`.
- Removes: `acquireMigrationLock`, `releaseMigrationLock`, `defaultIsProcessAlive`, and `removeStaleOwnedStages`.
- Preserves: existing legacy destination, marker filename, result fields, and lock pathname.

- [ ] **Step 1: Write failing lease/stage tests**

```js
it('reclaims a successfully isolated guarded stage', async() => {
  const result = await migrateFixture()
  assert.equal(result.status, 'promoted')
  assert.equal(fs.existsSync(result.stagePath), false)
  assert.deepEqual(listIsolationNames(fixture.root), [])
})

it('preserves a replacement raced into guarded-stage isolation', async() => {
  const result = await migrateFixture({
    beforeStageIsolation() {
      replaceDirectoryWithSameContent(fixture.stagePath)
    },
  })
  assert.equal(result.status, 'failed')
  assert.equal(fs.existsSync(fixture.stagePath), true)
  assert.equal(listIsolationNames(fixture.root).length, 1)
})

it('never scans a retained or unreferenced stage directory on retry', async() => {
  seedRetainedStage(fixture.root, 'unreferenced')
  await migrateFixture()
  assert.equal(readRetainedStage(fixture.root), 'unreferenced')
})
```

Add a test that triggers `lease.assertHeld()` compromise before promotion and verifies destination/source remain unchanged. Update the legacy-user-data script to await the migration result and to reject a pre-existing old regular-file lock without deleting it.

Add `binds guarded-stage identity at exclusive creation and preserves a later same-content replacement`. Capture the stage when exclusively created, then inject the replacement immediately after that exact stage is renamed into isolation and before the stable-absence check; assert that the replacement remains at the stable stage path and the creation-bound node alone remains as the isolated payload.

- [ ] **Step 2: Run guarded migration tests and verify RED**

```powershell
node --test build-config/storage/guarded-directory-migration.test.js
node scripts/test-legacy-user-data-migration.js
```

Expected: FAIL because guarded migration still owns a hard-link file lock, scans stale stage prefixes, and uses restore-based cleanup.

- [ ] **Step 3: Implement asynchronous guarded copy and isolated cleanup**

Update the declaration:

```ts
export interface DirectoryPromotionOptions {
  fsApi?: typeof import('node:fs')
  rootPath: string
  sourcePath: string
  destinationPath: string
  stagePrefix: string
  runId: string
  lease: MigrationLease
  logger?: Pick<Console, 'info' | 'warn' | 'error'>
  writePayloadMarker?: (input: {
    payloadPath: string
    sourceManifest: DirectoryManifestEntry[]
    copiedManifest: DirectoryManifestEntry[]
  }) => Promise<void> | void
  beforePromotion?: (input: {
    payloadPath: string
    sourceManifest: DirectoryManifestEntry[]
    destinationManifest: DirectoryManifestEntry[]
    sourceManifestHash: string
    destinationManifestHash: string
  }) => Promise<void> | void
}

export type DirectoryPromotionResult = {
  status: 'promoted' | 'destination-exists' | 'failed'
  stagePath?: string
  sourceManifest?: DirectoryManifestEntry[]
  destinationManifest?: DirectoryManifestEntry[]
  sourceManifestHash?: string
  destinationManifestHash?: string
  error?: unknown
}

export function copyDirectoryWithManifestPromotion(
  options: DirectoryPromotionOptions,
): Promise<DirectoryPromotionResult>
```

Copy files through bounded asynchronous reads/writes so the heartbeat timer runs. Capture the stage directory identity immediately after its exclusive creation, before writing the ownership marker or payload, and carry that immutable identity through copy, promotion, and cleanup; cleanup never recaptures ownership from the current pathname. Call `lease.assertHeld()` before every destination rename, marker write, source-sensitive revalidation, and stage isolation. On success or owned failure, isolate only that creation-bound stage and reclaim only its exact marker-bound payload. A conflict retains the isolation directory and returns `failed`. Delete the prefix scanner entirely.

Change legacy migration to:

```js
const lease = await acquireMigrationLease({ rootPath, lockPath, logger })
try {
  const migration = await copyDirectoryWithManifestPromotion({
    fsApi,
    rootPath,
    sourcePath: legacyPath,
    destinationPath: userDataPath,
    stagePrefix: tempPrefix,
    runId: crypto.randomUUID(),
    lease,
    logger,
    writePayloadMarker,
  })
  tempPath = migration.stagePath
  if (migration.status == 'promoted') {
    safeLog(logger, 'info', `Migrated user data to ${userDataPath}`)
    return createResult('migrated', true)
  }
  if (migration.status == 'destination-exists') {
    return getUsableDirectory(fsApi, userDataPath)
      ? createResult('current-exists', true)
      : createResult('failed', false, new Error(`Current user-data path is not a directory: ${userDataPath}`))
  }
  safeLog(logger, 'error', 'Legacy user-data migration failed', migration.error)
  if (migration.error instanceof DirectorySourceChangedError) {
    return createResult('failed', false, migration.error)
  }
  lease.assertHeld()
  const userDataPathReady = prepareFreshUserDataUnderDirectGuard()
  return createResult('failed', userDataPathReady, migration.error)
} finally {
  await releaseMigrationLease(lease)
}
```

Keep the existing pre-lease `current-exists` and `legacy-missing` branches. `prepareFreshUserDataUnderDirectGuard` validates `rootPath`, observes only the exact direct basename, and either validates that existing directory or calls `createDirectChildDirectory`; it never recursively creates through an unknown parent. In the post-copy failure branch, `lease.assertHeld()` occurs immediately before this helper, so a compromised or invalid lease rejects without creating `userDataPath`. `createResult` continues returning exact `MigrationResult` fields `status`, `legacyPath`, `userDataPath`, optional `tempPath`, `lockPath`, `userDataPathReady`, and optional `error`. Release errors override apparent success so the caller stops startup. A legacy regular-file lock is an unknown node and remains untouched.

- [ ] **Step 4: Run guarded migration tests and verify GREEN**

Run the Step 2 commands. Expected: both suites pass without a production hard-link call.

- [ ] **Step 5: Commit guarded migration**

```powershell
git add src/main/migration/guardedDirectoryMigration.js src/main/migration/guardedDirectoryMigration.d.ts src/main/migration/legacyUserData.js src/main/migration/legacyUserData.d.ts src/main/bootstrap.ts build-config/storage/guarded-directory-migration.test.js scripts/test-legacy-user-data-migration.js
git commit -m "refactor: isolate guarded migration stages"
```

### Task 6: Journal Portable Source Retirement Before Isolation

**Files:**
- Modify: `src/main/migration/portableProfile.js`
- Modify: `src/main/migration/portableProfile.d.ts`
- Modify: `src/main/bootstrap.ts`
- Modify: `build-config/storage/portable-profile-migration.test.js`
- Modify: `build-config/storage/startup-coordinator.test.js`

**Interfaces:**
- Consumes: migration lease from Task 4, guarded promotion from Task 5, and journal-bound isolation from Task 3.
- Changes: `preparePortableProfile(options): Promise<PortableProfilePreparationResult>`.
- Changes: `retireAcknowledgedPortableSource(options): Promise<PortableProfileRetirementResult>`.
- Preserves: current preparation token fields and version, receipt compatibility, exact journal/receipt filenames, and source/destination manifest semantics.
- Writes: strict portable journal version 2 with the state union below.

- [ ] **Step 1: Write failing retirement state-machine tests**

```js
it('durably records retirement-intent before moving LxDatas', async() => {
  const events = []
  const result = await retireFixture({
    afterJournalWrite(journal) { events.push(journal.state) },
    beforeSourceRename() { events.push('rename') },
  })
  assert.equal(result.state, 'retired')
  assert.deepEqual(events.slice(0, 2), ['retirement-intent', 'rename'])
})

it('records an exact interrupted payload as retired-retained without deleting it', async() => {
  await createInterruptedIsolatedRetirement()
  const result = await retireFixture()
  assert.equal(result.state, 'failed')
  assert.equal(readJournal().state, 'retired-retained')
  assert.equal(fs.existsSync(journalPayloadPath()), true)
})

it('finalizes retirement-isolated when the exact payload is already absent', async() => {
  await createRetirementIsolatedJournal({ payloadPresent: false })
  const result = await retireFixture()
  assert.equal(result.state, 'retired')
  assert.equal(readJournal().state, 'retired')
})
```

Also add tests for replacement at the retirement rename boundary, exact journal-bound empty-isolation resume, identity mismatch, unexpected private entries, unreferenced isolation preservation, and version-1 upgrade only after source and destination reverify.

- [ ] **Step 2: Run portable tests and verify RED**

```powershell
node --test build-config/storage/portable-profile-migration.test.js
node --test --test-name-pattern="portable|retirement" build-config/storage/startup-coordinator.test.js
```

Expected: FAIL because retirement deletes `LxDatas` directly and journal version 1 has no retirement evidence.

- [ ] **Step 3: Implement the strict journal version-2 union**

Declare:

```ts
export type PortableJournalStateV2 =
  | 'promoted'
  | 'typed-only-acknowledged'
  | 'retirement-intent'
  | 'retirement-isolated'
  | 'retired'
  | 'retired-retained'

export interface PortableRetirementEvidenceV2 {
  isolationBasename: string
  isolationIdentity: NodeIdentity
  sourceIdentity: NodeIdentity
  sourceManifestHash: string
  destinationManifestHash: string
}

export interface PortableJournalV2 {
  version: 2
  sourceManifestHash: string
  destinationManifestHash: string
  sourceIdentity: NodeIdentity
  destinationIdentity: NodeIdentity
  userDataIdentity: NodeIdentity
  promotionRunId: string
  preparationRunId: string
  acknowledgementRunId: string | null
  state: PortableJournalStateV2
  retirement: PortableRetirementEvidenceV2 | null
}
```

`promoted` and `typed-only-acknowledged` require `retirement:null`. Retirement states require an exact evidence object and acknowledged run ID. The flow is:

```js
lease.assertHeld()
const reservation = await reserveExclusiveIsolation({ root: portableRootGuard, prefix: '.lx-portable-retired-' })
lease.assertHeld()
let retirementJournal = withRetirement(journal, 'retirement-intent', reservation)
await writeJournal(retirementJournal)
lease.assertHeld()
const isolation = await isolateOwnedPath({
  source: capturedSource,
  reservation,
  verifySource: verifyRecordedSource,
})
if (isolation.state != 'isolated') return failRetirement(isolation)
lease.assertHeld()
retirementJournal = withState(retirementJournal, 'retirement-isolated')
await writeJournal(retirementJournal)
lease.assertHeld()
const reclaimed = await reclaimIsolatedPayload({
  guard: isolation.guard,
  verifyPayload: verifyRecordedSource,
})
if (reclaimed.state == 'retained') {
  lease.assertHeld()
  retirementJournal = withState(retirementJournal, 'retired-retained')
  await writeJournal(retirementJournal)
  return { state: 'failed', error: reclaimed.error }
}
lease.assertHeld()
retirementJournal = withState(retirementJournal, 'retired')
await writeJournal(retirementJournal)
return { state: 'retired' }
```

Recovery follows only the journal basename and identity. It never deletes an interrupted payload. `retired-retained` with a present payload remains fatal; an exact absent payload plus empty private directory finalizes `retired`. Bootstrap awaits all portable functions and exits before loading `application.ts` on `failed`.

`preparePortableProfile`, `acknowledgePortableProfileStartup`, and `retireAcknowledgedPortableSource` each acquire the Task 4 lease, assert it before every journal/receipt/source mutation, and await release. A release failure makes the operation fail. A version-1 journal receives retirement authority only after source identity, userData ancestry identity, source manifest, and destination manifest all reverify.

- [ ] **Step 4: Run portable tests and verify GREEN**

Run the Step 2 commands. Expected: all selected tests pass, including strict version-1 read compatibility.

- [ ] **Step 5: Commit portable retirement**

```powershell
git add src/main/migration/portableProfile.js src/main/migration/portableProfile.d.ts src/main/bootstrap.ts build-config/storage/portable-profile-migration.test.js build-config/storage/startup-coordinator.test.js
git commit -m "fix: journal portable source retirement"
```

### Task 7: Isolate Every Cache Artifact Before Reset Reopen

**Files:**
- Modify: `src/main/services/cacheArtifactInventory.ts`
- Modify: `src/main/services/cacheManager.ts`
- Modify: `src/main/worker/dbService/cacheDb.ts`
- Modify: `src/main/worker/dbService/modules/cacheLifecycle/index.ts`
- Modify: `src/main/types/db_service.d.ts`
- Modify: `build-config/storage/cache-manager.test.js`
- Modify: `build-config/storage-electron/cache-lifecycle.test.js`
- Modify: `build-config/storage-electron/cache-phase4.integration.test.js`

**Interfaces:**
- Consumes: exclusive isolation from Task 3 and cache direct-root validation from Task 1.
- Changes: `clearOwnedArtifacts(): Promise<CacheArtifactClearResult>`.
- Produces: `abortCacheReset(input: CacheResetLease): Promise<void>`.
- Preserves: `beginCacheReset`, `finishCacheReset`, `CacheOpenResult`, fixed diagnostic union, single-flight clear, and the success-qualified generation contract.

- [ ] **Step 1: Write failing cache reset ordering tests**

```js
it('isolates all SQLite artifacts before reclaiming or reopening', async() => {
  const events = []
  const result = await managerFixture({ events }).clearAll()
  assert.equal(result.status, 'cleared')
  assert.deepEqual(events, [
    'reset.begin',
    'cache.db.isolated',
    'cache.db-wal.isolated',
    'cache.db-shm.isolated',
    'stable.absent',
    'payloads.reclaimed',
    'sessions.cleared',
    'reset.finished',
    'generation.published',
  ])
})

it('preserves a replacement raced into cache isolation and does not reopen', async() => {
  const result = await managerFixture({ injectStableReplacement: 'cache.db' }).clearAll()
  assert.equal(result.status, 'degraded')
  assert.equal(fixture.finishCalls, 0)
  assert.equal(fixture.abortCalls, 1)
  assert.equal(fixture.published.length, 0)
  assert.equal(fs.readFileSync(fixture.cachePath, 'utf8'), 'replacement')
})
```

Add tests for isolated payload reclamation failure, abort without fresh open, no generation after reopen failure, and generation publication when only named Chromium categories fail.

- [ ] **Step 2: Run cache reset tests and verify RED**

```powershell
node --test build-config/storage/cache-manager.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-lifecycle.test.js
```

Expected: FAIL because inventory unlinks stable paths and `finishCacheReset` always reopens.

- [ ] **Step 3: Implement isolation batches and a non-reopening abort**

Use the exact worker extension:

```ts
export interface CacheWorkerLifecycle {
  openCacheDatabase(): Promise<CacheOpenResult>
  beginCacheReset(): Promise<CacheResetLease>
  finishCacheReset(input: CacheResetLease): Promise<CacheOpenResult>
  abortCacheReset(input: CacheResetLease): Promise<void>
  getCacheLifecycleState(): Promise<CacheLifecycleState>
}
```

`abortCacheReset` validates the exact active lease, sets the lifecycle to `unavailable` with `cache_delete_failed`, releases the held FIFO, and never calls `openWithinGate`.

The manager sequence is:

```ts
const lease = await worker.beginCacheReset()
const artifacts = await inventory.clearOwnedArtifacts()
if (artifacts.status != 'cleared') {
  await worker.abortCacheReset(lease)
  return degradedCacheResult(artifacts.code)
}
const sessions = await sessionRegistry.clearRegisteredCaches()
const reopen = await worker.finishCacheReset(lease)
if (reopen.status == 'created' || reopen.status == 'recreated') publishNextGeneration()
return cacheClearResult(artifacts, sessions, reopen)
```

Inventory captures `cache.db`, `cache.db-wal`, and `cache.db-shm` identities under one root guard, isolates every present node, revalidates all three stable names absent, then reclaims every exact payload. Any conflict or retained payload returns `{ status:'failed', code:'cache_delete_failed' }`. Session clearing starts only after database bytes are reclaimed.

If isolation fails after an earlier artifact moved, retain every still-present private directory from that batch and do not reclaim it as rollback. The failed clear calls `abortCacheReset`, leaves all stable-path replacements untouched, and never publishes a generation.

- [ ] **Step 4: Run cache reset tests and verify GREEN**

Run the Step 2 commands, then:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-phase4.integration.test.js
```

Expected: all three suites pass.

- [ ] **Step 5: Commit cache reset isolation**

```powershell
git add src/main/services/cacheArtifactInventory.ts src/main/services/cacheManager.ts src/main/worker/dbService/cacheDb.ts src/main/worker/dbService/modules/cacheLifecycle/index.ts src/main/types/db_service.d.ts build-config/storage/cache-manager.test.js build-config/storage-electron/cache-lifecycle.test.js build-config/storage-electron/cache-phase4.integration.test.js
git commit -m "fix: isolate cache artifacts before reset"
```

### Task 8: Convert Run-Temp Cleanup to Isolation Without Restore

**Files:**
- Modify: `src/main/utils/tempLifecycle.ts`
- Modify: `src/main/application.ts`
- Modify: `build-config/storage/temp-lifecycle.test.js`

**Interfaces:**
- Consumes: bootstrap-created `RunTempReservation` from Task 1 and isolation helpers from Task 3.
- Preserves: `RunTempHandle`, `RunTempChild` names, owner marker version 1, child ownership checks, and cleanup as the final shutdown step.
- Removes: quarantine rename/restore behavior and scanning of quarantine/isolation prefixes.

- [ ] **Step 1: Write failing run cleanup tests**

```js
test('preserves a replacement raced into the stable run pathname', async() => {
  const handle = await createFixtureHandle()
  replaceRunAtIsolationBoundary(handle.runTempRoot)
  await assert.rejects(handle.cleanup(), /run_temp_owner_invalid/)
  assert.equal(fs.existsSync(handle.runTempRoot), true)
  assert.equal(findRetainedRunIsolation(fixture.tempRoot).length, 1)
})

test('retains the isolated run when recursive reclamation fails', async() => {
  const handle = await createFixtureHandle({ failPayloadRemoval: true })
  await assert.rejects(handle.cleanup(), /run_temp_cleanup_failed/)
  assert.equal(findRetainedRunIsolation(fixture.tempRoot).length, 1)
})

test('startup scavenging ignores retained isolation and legacy quarantine names', async() => {
  seedRetainedNames(fixture.tempRoot)
  await scavengeRunTempRoots(fixture.tempRoot)
  assert.deepEqual(readRetainedNames(fixture.tempRoot), seededNames)
})
```

Also update the successful cleanup test to assert that both payload bytes and the empty private directory are reclaimed.

- [ ] **Step 2: Run temp lifecycle tests and verify RED**

```powershell
node --test build-config/storage/temp-lifecycle.test.js
```

Expected: FAIL because cleanup attempts to restore quarantine paths and scavenging recognizes the old quarantine convention.

- [ ] **Step 3: Implement exact run ownership isolation**

Capture the run as an `OwnedDirectNode` only after revalidating the parent, run identity, and exact marker. Call:

```ts
const result = await isolateOwnedPath({
  source: ownedRun,
  prefix: '.lx-run-retained-',
  verifySource: async runPath => { await assertRunMarker(runPath, ownership.marker) },
})
if (result.state == 'conflict') throw fixedError('run_temp_owner_invalid')
if (result.state == 'isolated') {
  const reclaimed = await reclaimIsolatedPayload({
    guard: result.guard,
    verifyPayload: async payloadPath => { await assertRunMarker(payloadPath, ownership.marker) },
  })
  if (reclaimed.state == 'retained') throw fixedError('run_temp_cleanup_failed')
}
```

Scavenging considers only names matching `^run-[A-Za-z0-9_-]+$` with a valid owner marker and routes each verified stale run through the same isolation/reclaim helper. It never recognizes `.lx-run-retained-*`, `*.quarantine-*`, migration stage prefixes, or arbitrary directories. `application.ts` keeps temp cleanup in the shutdown `finally` block.

- [ ] **Step 4: Run temp lifecycle tests and verify GREEN**

Run the Step 2 command. Expected: every run-temp test passes.

- [ ] **Step 5: Commit run-temp isolation**

```powershell
git add src/main/utils/tempLifecycle.ts src/main/application.ts build-config/storage/temp-lifecycle.test.js
git commit -m "fix: isolate run temp before cleanup"
```

### Task 9: Publish Theme Assets Directly and Retire Stages Before Settings

**Files:**
- Modify: `src/main/services/themeAssetManager.ts`
- Modify: `build-config/storage/theme-asset-manager.test.js`
- Modify: `build-config/storage/theme-store-transaction.test.js`

**Interfaces:**
- Consumes: immutable artifact guards from Task 2, isolation from Task 3, and `RunTempHandle` from Task 8.
- Preserves: `ThemeAssetManager` public methods, 8 MiB image limit, eight memory-stage limit, Linux descriptor-based staging creation, Windows/Darwin memory stages, opaque persisted filenames, and legacy-theme original filenames.
- Removes: `createAssetTemp`, hard-link `publishAsset`, quarantine restore, and commit-before-stage-retirement.

- [ ] **Step 1: Write failing descriptor/order/rollback tests**

```js
test('copies a disk stage only from its retained read descriptor', async() => {
  const manager = await createLinuxManager()
  const staged = await manager.stageThemeImage({ sourcePath: fixture.source })
  replacePathAfterDescriptorOpen(staged.previewPath)
  await assert.rejects(
    manager.promoteThemeImage(staged, async() => 'committed'),
    /theme_stage_invalid/,
  )
  assert.equal(readReplacement(staged.previewPath), 'replacement')
})

test('retires the disk stage before invoking the settings commit', async() => {
  const events = []
  await manager.promoteThemeImage(staged, async promoted => {
    events.push('settings')
    assert.equal(fs.existsSync(staged.previewPath), false)
    assert.equal(fs.existsSync(promoted.previewPath), true)
  })
  assert.deepEqual(events, ['settings'])
})

test('retains an ambiguous durable rollback target without unlinking it', async() => {
  const promoted = await capturePromotedTargetBeforeCommitFailure()
  raceReplacementAtRollback(promoted.previewPath)
  await assert.rejects(promoted.finish(), /theme_asset_invalid/)
  assert.equal(fs.existsSync(promoted.previewPath), true)
  assert.equal(findRetainedThemeIsolation().length, 1)
})
```

Add tests named `revalidates the stage pathname before and after durable copy`, `preserves a stage replacement and never invokes settings commit`, `rolls back the exact durable target through isolation`, and `publishes and rolls back when the filesystem adapter has no link method`. Update commit-failure expectations so every promotion consumes its staging ID.

Add cancellation tests named `discard isolates and reclaims the exact disk stage` and `discard preserves a replacement raced into stage isolation`. `discardThemeImage` must use the same stage descriptor verification and isolation path as promotion.

- [ ] **Step 2: Run theme tests and verify RED**

```powershell
node --test build-config/storage/theme-asset-manager.test.js
node --test build-config/storage/theme-store-transaction.test.js
```

Expected: FAIL because publication uses `fs.link`, settings commit precedes stage retirement, and rollback can unlink a stable pathname.

- [ ] **Step 3: Implement descriptor-pinned direct publication**

Use this internal stage shape:

```ts
type VerifiedThemeStage =
  | {
    backing: 'memory'
    record: MemoryStagedFile
    bytes: Buffer
    close(): Promise<void>
  }
  | {
    backing: 'disk'
    record: DiskStagedFile
    bytes: Buffer
    descriptor: Awaited<ReturnType<typeof fs.open>>
    descriptorIdentity: FileIdentity
    close(): Promise<void>
  }
```

`openVerifiedStage` keeps the disk descriptor open, reads bounded bytes from it, and checks descriptor/path identity before returning. Reserve a unique durable `theme-image-v1` artifact directly in the validated asset root, complete it from the bounded buffer, and verify image type/hash. Revalidate the stage path against its still-open descriptor, isolate/reclaim a disk stage or remove a memory stage from the map, then invoke the settings callback.

The exact order is:

```ts
const stage = await openVerifiedStage(staged)
let durable: ImmutableArtifactGuard | null = null
try {
  durable = completeExclusiveArtifact(
    reserveThemeTarget(assetRootGuard),
    bufferByteSource(stage.bytes),
    { verifyReadOnly: verifyThemeImageArtifact },
  )
  await revalidateStageAgainstDescriptor(stage)
  await consumeThemeStage(stage)
  const result = await commit({ fileName: durable.basename, previewPath: durable.path })
  return result
} catch (error) {
  if (durable != null) {
    revalidateImmutableArtifact(durable)
    closeArtifactGuard(durable)
    await isolateAndReclaimDurableTarget(durable)
    durable = null
  }
  throw fixedThemeError(error)
} finally {
  await stage.close()
  if (durable != null) closeArtifactGuard(durable)
}
```

Legacy theme migration preserves its original filename by direct `open('wx', 0o600)`, bounded write/fsync/readback, and isolation rollback; it does not use a random name or hard link. An existing same-name file is read through a pinned descriptor and accepted only when hashes match.

- [ ] **Step 4: Run theme tests and verify GREEN**

Run the Step 2 commands. Expected: both suites pass with no `link` method in the injected filesystem.

- [ ] **Step 5: Commit theme publication**

```powershell
git add src/main/services/themeAssetManager.ts build-config/storage/theme-asset-manager.test.js build-config/storage/theme-store-transaction.test.js
git commit -m "fix: publish theme assets without hard links"
```

### Task 10: Rewrite Online Backups Around Open Immutable Guards

**Files:**
- Modify: `src/main/worker/dbService/databaseBackup.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `src/main/worker/dbService/migrate.ts`
- Modify: `build-config/storage-electron/database-recovery.test.js`
- Modify: `build-config/storage-electron/storage-foundation.integration.test.js`

**Interfaces:**
- Consumes: direct-directory and immutable-artifact guards from Tasks 1 and 2.
- Produces: `reserveOnlineBackup`, `closeOnlineBackupReservation`, `completeOnlineBackup`, `verifyRecordedOnlineBackup`, `verifyLegacyOnlineBackup`, and `VerifiedOnlineBackupGuard`.
- Changes: `ReadyInitialization` and `getDatabaseInitialization()` include immutable `existedBeforeOpen: boolean`.
- Preserves: `DatabaseInitOptions` and `DatabaseAdvanceOptions`; callers cannot supply existence state.
- Extends: ordinary migration options with a final in-transaction `beforeCommit?: () => void` guard.

- [ ] **Step 1: Replace hard-link backup tests with unique-guard tests**

```js
it('writes one unique direct backup with no stage link or rename', async() => {
  const guard = await createGuardedBackup(fixture.db)
  assert.match(guard.basename, /^lx\.data\.db\.backup\.[a-f0-9]{32}\.backup$/)
  assert.deepEqual(fs.readdirSync(fixture.backupsRoot), [guard.basename])
  assert.equal(await sqliteQuickCheck(guard.path), 'ok')
})

it('keeps the guard open through migration and rejects final replacement', async() => {
  const result = await initializeWithFinalBackupReplacement()
  assert.equal(result.status, 'recovery')
  assert.equal(result.reason, 'backup_failed')
  assert.equal(readSchemaVersion(fixture.databasePath), 2)
  assert.equal(readReplacementBytes(), 'replacement')
})

it('retains existedBeforeOpen across cached init and schema publication', async() => {
  const first = await dbService.init(existingFixtureOptions)
  const cached = await dbService.init(existingFixtureOptions)
  assert.equal(dbService.getDatabaseInitialization().existedBeforeOpen, true)
  assert.deepEqual(cached, first)
})
```

Add `retains one partial unique attempt on write or verification failure`, `does not overwrite or choose an occupied artifact`, `rejects a generic or wrong-kind reservation at database completion`, `closes both artifact and owned root descriptors when an online reservation is abandoned`, `reopens recorded backup evidence read-only and rejects hash length or schema mismatch`, and `rejects caller-supplied existence state`. Remove expectations for paired hard-link inodes and retained stage aliases.

- [ ] **Step 2: Run focused backup tests and verify RED**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/database-recovery.test.js
```

Expected: FAIL because backup publication still links a random stage to a deterministic final path and initialization stores only the external startup result.

- [ ] **Step 3: Implement database-specific guarded backup APIs**

Declare:

```ts
export interface OnlineBackupReservation extends ExclusiveArtifactReservation {
  artifactKind: 'database-backup-v1'
  sourceSchemaVersion: number
}

export interface VerifiedOnlineBackupGuard {
  path: string
  basename: string
  sha256: string
  byteLength: number
  sourceSchemaVersion: number
  revalidate(): void
  close(): void
}

export function reserveOnlineBackup(input: {
  backupsRoot: string
  basenamePrefix: string
  sourceSchemaVersion: number
}): OnlineBackupReservation

export function closeOnlineBackupReservation(
  reservation: OnlineBackupReservation,
): void

export function completeOnlineBackup(
  db: Database.Database,
  reservation: OnlineBackupReservation,
  nativeOptions: { nativeBinding?: string },
  verifier: OnlineBackupVerifier,
): VerifiedOnlineBackupGuard

export function verifyLegacyOnlineBackup(
  filePath: string,
  nativeOptions: { nativeBinding?: string },
  verifier: OnlineBackupVerifier,
): void

export function verifyRecordedOnlineBackup(input: {
  backupsRoot: string
  basename: string
  expectedSha256: string
  expectedByteLength: number
  expectedSourceSchemaVersion: number
  nativeOptions: { nativeBinding?: string }
  verifier: OnlineBackupVerifier
}): VerifiedOnlineBackupGuard
```

Use `db.serialize()` as the bounded source and verify SQLite read-only with quick check, foreign keys, schema/ledger/marker contracts, and caller row hashes. `completeOnlineBackup` revalidates the narrowed artifact kind and safe positive source schema before writing. `closeOnlineBackupReservation` closes the generic artifact descriptor and the root guard owned internally by `reserveOnlineBackup`; completion failures use the same close path, and `VerifiedOnlineBackupGuard.close()` closes both after success. Keep the artifact and root descriptors open through the consuming migration. For ordinary pre-v6 migration, pass `guard.revalidate` as `beforeCommit` and close only after transaction success/failure.

`verifyRecordedOnlineBackup` resolves only the supplied direct basename beneath a freshly validated existing backup root, opens it read-only, verifies descriptor/path identity, exact SHA-256 and byte length, source schema, and caller SQLite semantics, and returns an open verified guard. It never creates, repairs, appends, scans, or selects a candidate. `verifyLegacyOnlineBackup` remains the separate v1 compatibility path.

`reserveOnlineBackup` revalidates an existing direct `backupsRoot` or exclusively creates that direct child beneath its freshly revalidated owner root immediately before reserving the artifact. Only an initialization with `existedBeforeOpen:true` may call this path; the fresh branch never validates by creation or otherwise mutates `backupsRoot`.

Record the immutable existence fact:

```ts
interface ReadyInitialization {
  dataPath: string
  cacheRoot: string
  backupsRoot: string
  schemaVersion: 6 | 7
  existedBeforeOpen: boolean
}

export const getDatabaseInitialization = (): Readonly<{
  cacheRoot: string
  backupsRoot: string
  schemaVersion: 6 | 7
  existedBeforeOpen: boolean
}>
```

Set `existedBeforeOpen` only from the successful `prepared.existed` result returned by `prepareSqliteTarget` after authoritative open. Preserve it across memoized init and `publishSchema7`; `publishSchema7` changes only `schemaVersion` to `7`. Clear the initialization snapshot only after complete shutdown.

- [ ] **Step 4: Run backup tests and verify GREEN**

Run the complete Step 2 suite again, then:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/storage-foundation.integration.test.js
```

Expected: both invocations pass.

- [ ] **Step 5: Commit guarded backup foundation**

```powershell
git add src/main/worker/dbService/databaseBackup.ts src/main/worker/dbService/db.ts src/main/worker/dbService/migrate.ts build-config/storage-electron/database-recovery.test.js build-config/storage-electron/storage-foundation.integration.test.js
git commit -m "refactor: publish guarded backups without hard links"
```

### Task 11: Bind and Resume One Prepared Schema-6 Backup

**Files:**
- Modify: `src/main/migration/cache/cutover.ts`
- Modify: `src/main/worker/dbService/databaseBackup.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `build-config/storage/credential-profile-scan.test.js`
- Modify: `build-config/storage/non-activity-source.test.js`
- Modify: `build-config/storage/non-activity-startup.test.js`
- Modify: `build-config/storage-electron/cache-cutover.test.js`
- Modify: `build-config/storage-electron/cache-lifecycle.test.js`
- Modify: `build-config/storage-electron/database-recovery.test.js`
- Modify: `build-config/storage-electron/playback-migration.test.js`
- Modify: `build-config/storage-electron/playback-phase3.integration.test.js`
- Modify: `build-config/storage/startup-coordinator.test.js`

**Interfaces:**
- Consumes: `existedBeforeOpen` and online backup guards from Task 10.
- Produces: strict marker `legacy_cache_v1.backup_prepared`.
- Produces: `readBackupPreparedMarker`, `writeBackupPreparedMarker`, and `verifyBackupPreparedMarker` in `cutover.ts`.
- Produces: `reopenPreparedOnlineBackup` in `databaseBackup.ts`.
- Changes: a schema-6 ready result includes immutable `preparedCutoverPending: boolean`; the coordinator resumes `true` before any other database mutation hook.
- Preserves: `advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot })` single-flight and exact same-Promise behavior.

- [ ] **Step 1: Write failing prepared/resume tests**

At the top of `cache-cutover.test.js`, declare the aggregate returned only by its fixture helpers. This is not a production `DatabaseStartupResult`, `BackupPreparedMarkerV1`, or `VerifiedOnlineBackupGuard`:

```js
/**
 * Test-only aggregate assembled from the verified backup guard and persisted marker evidence.
 * @typedef {{
 *   backupBasename: string,
 *   backupByteLength: number,
 *   backupSha256: string,
 *   completedAtMs: number,
 *   path: string,
 *   rawLyricsDeletedRows: number,
 *   readWriteMarkerSha256: string,
 * }} CacheCutoverFixtureResult
 */
```

Annotate `advanceFixture`, `retryAdvance`, and `advanceExistingSchema6` with `@returns {Promise<CacheCutoverFixtureResult>}` and construct the aggregate explicitly from the open guard plus the strict prepared/cutover marker reads. Production functions retain the interfaces declared below.

```js
it('commits backup-prepared before the first backup byte and binds one unique basename', async() => {
  const events = []
  await advanceFixture({ events })
  assert.deepEqual(events.slice(0, 2), ['prepared-marker.commit', 'backup.write'])
  const marker = readPreparedMarker()
  assert.match(marker.details.backupBasename, /^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$/)
})

it('resumes an ENOSPC prefix only after exact prefix verification', async() => {
  await failFirstAdvanceAfterBytes(4096, 'ENOSPC')
  const first = readPreparedArtifact()
  const second = await retryAdvance()
  assert.equal(second.backupBasename, first.basename)
  assert.equal(readPrefix(second.path, 4096).equals(first.bytes), true)
  assert.equal(listPreparedCandidates().length, 1)
})

it('retains and blocks a mismatched marker-bound prefix without allocating another attempt', async() => {
  await createPreparedPrefix()
  mutatePreparedPrefixByte()
  await assert.rejects(retryAdvance(), /backup_prepared_conflict/)
  assert.equal(listPreparedCandidates().length, 1)
})

it('rejects changed authoritative state before resuming even with a zero-length prefix', async() => {
  await crashAfterPreparedMarkerCommit({ bytesWritten: 0 })
  mutateAuthoritativeRowOutOfBand()
  await assert.rejects(restartAndRetryAdvance(), /backup_prepared_source_changed/)
  assert.equal(readPreparedArtifact().byteLength, 0)
  assert.equal(listPreparedCandidates().length, 1)
})
```

Add tests for repeated write/verification/cutover failures reusing one attempt, prepared-marker commit failure retaining an unreferenced zero-byte artifact, a source mutation whose changed bytes fall beyond an existing short prefix, and concurrent advances sharing one prepared artifact.

In `startup-coordinator.test.js`, add `resumes a prepared cutover before migration playback credential or phase-3 mutation hooks`. Seed `preparedCutoverPending:true`, record every dependency call, and require `getCachePhasePrerequisite` plus `initializePhase4` to complete before any of those four mutation-capable hooks.

In every database-ready fixture in `credential-profile-scan.test.js`, `non-activity-source.test.js`, `non-activity-startup.test.js`, `startup-coordinator.test.js`, `cache-lifecycle.test.js`, `database-recovery.test.js`, `playback-migration.test.js`, and `playback-phase3.integration.test.js`, add an explicit `preparedCutoverPending:false`. Do not add that field to credential-health objects, cache-database ready results, scenario descriptors, coordinator return assertions, or the recovery arm.

- [ ] **Step 2: Run prepared-backup tests and verify RED**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-cutover.test.js
node --test build-config/storage/startup-coordinator.test.js build-config/storage/credential-profile-scan.test.js build-config/storage/non-activity-source.test.js build-config/storage/non-activity-startup.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/database-recovery.test.js build-config/storage-electron/cache-lifecycle.test.js build-config/storage-electron/playback-migration.test.js build-config/storage-electron/playback-phase3.integration.test.js
```

Expected: FAIL because schema-6 cutover derives a deterministic path and has no durable pre-write marker or append-only resume.

- [ ] **Step 3: Implement exact prepared marker and prefix resume**

Use:

```ts
export const BACKUP_PREPARED_MARKER_NAME = 'legacy_cache_v1.backup_prepared' as const

export interface BackupPreparedDetailsV1 {
  backupBasename: string
  readWriteMarkerSha256: string
  sourceSchemaVersion: 6
  version: 1
}

export interface BackupPreparedMarkerV1 extends StrictMarkerRow<
  typeof BACKUP_PREPARED_MARKER_NAME
> {
  details: BackupPreparedDetailsV1
}

export function readBackupPreparedMarker(
  db: Database.Database,
): StrictMarkerRow<typeof BACKUP_PREPARED_MARKER_NAME> | null

export function writeBackupPreparedMarker(
  db: Database.Database,
  input: {
    details: BackupPreparedDetailsV1
    completedAtMs: number
  },
): BackupPreparedMarkerV1

export function verifyBackupPreparedMarker(
  db: Database.Database,
  verifiedReadWriteMarker: StrictMarkerRow<typeof READ_WRITE_MARKER_NAME>,
): BackupPreparedMarkerV1 | null

export function backupPreparedSourceSha256(
  db: Database.Database,
  input: {
    details: BackupPreparedDetailsV1
    completedAtMs: number
  },
): string

export interface DatabaseReadyStartupResult {
  status: 'ready'
  existed: boolean
  schemaVersion: number
  migratedVersions: number[]
  backupPath: string | null
  preparedCutoverPending: boolean
}

export function reopenPreparedOnlineBackup(
  db: Database.Database,
  input: {
    backupsRoot: string
    marker: BackupPreparedMarkerV1
    nativeOptions: { nativeBinding?: string }
    verifier: OnlineBackupVerifier
  },
): VerifiedOnlineBackupGuard
```

Require canonical key order `backupBasename,readWriteMarkerSha256,sourceSchemaVersion,version`. Keep those exact details keys; bind the source state in the marker row's `source_sha256` instead:

```ts
backupPreparedSourceSha256(db, { details, completedAtMs })
```

`backupPreparedSourceSha256` first verifies the exact schema-6 structure and ledger, then hashes every row of every schema-6 application table, including `sqlite_sequence` when present, but excludes only the `migration_markers` row named `legacy_cache_v1.backup_prepared`. Encode each SQLite value as a tagged canonical tuple (`null`, integer, finite real, UTF-8 text, or base64 BLOB), sort encoded rows by byte order independently of physical rowid/page layout, and frame the ordered table names, column names, rows, exact details, and `completedAtMs` with `lx.storage.phase4.backup-prepared-source-state.v1`. Unknown tables, columns, SQLite value classes, or non-canonical values fail closed.

`readWriteMarkerSha256` is exactly `markerRowSha256(verifiedReadWriteMarker)`. `completed_at_ms` is the preparation time and is not duplicated inside `details_json`, but it participates in the source-state hash above. The basename regex is exactly `^lx\.data\.db\.pre-migration-v6-to-v7\.[a-f0-9]{32}\.backup$` and rejects separators.

For a missing marker: validate/create `backupsRoot`, reserve the zero-byte file, commit and read back the marker in one SQLite transaction, then serialize/write. Marker commit failure calls `closeOnlineBackupReservation`, retains the zero-byte unreferenced attempt, closes both owned descriptors, and writes no bytes.

`writeBackupPreparedMarker` must run inside the caller's schema-6 transaction, compute the source hash before inserting the excluded marker row, and read back through `verifyBackupPreparedMarker` before that transaction returns. `verifyBackupPreparedMarker` returns null only when the row is absent; any malformed row, read-write hash mismatch, source-state hash mismatch, or unexpected schema state throws `backup_prepared_source_changed` before serialization or append begins.

For an existing marker, `db.ts` verifies the exact prepared marker and source-state hash before calling `db.serialize()`. Only then may `reopenPreparedOnlineBackup` resolve its basename, open read-only first, compare its descriptor identity and every byte against the prefix of that bounded snapshot, reject longer/mismatched content, and open the same inode without truncate for writes beginning at current length. A complete file proceeds directly to semantic verification. Do not await or yield to unrelated database work between marker commit and cutover completion.

Replace only the ready arm of the existing `DatabaseStartupResult` union with `DatabaseReadyStartupResult`; keep the recovery arm unchanged. On schema-6 initialization, verify any prepared marker before publishing the ready result and set `preparedCutoverPending:true` only for that verified state. All other ready results, including `publishSchema7`, set it to false. `storageCoordinator.ts` resolves the production/injected Phase 4 lifecycle immediately after `initDatabase`; when the flag is true it reads the Phase 3 prerequisite and completes `initializePhase4` before `runMigrationHooks`, playback migration, credential checks, or `runPhase3Gate`. It requires a schema-7 success, then continues ordinary startup without invoking Phase 4 a second time. Thus application-owned code cannot change the marker-bound source before retry; the persisted semantic hash still detects out-of-band changes.

Update all eight ready-fixture files named in Step 1 at the same time as the required result field. Use a literal `preparedCutoverPending:false` for ordinary ready fixtures so JavaScript tests exercise the production contract rather than relying on `undefined` being falsy; only the new prepared-resume fixture uses `true`.

- [ ] **Step 4: Run prepared-backup tests and verify GREEN**

Run both Step 2 commands and the complete `database-recovery.test.js` file:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-cutover.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/database-recovery.test.js
node --test build-config/storage/startup-coordinator.test.js build-config/storage/credential-profile-scan.test.js build-config/storage/non-activity-source.test.js build-config/storage/non-activity-startup.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-lifecycle.test.js build-config/storage-electron/playback-migration.test.js build-config/storage-electron/playback-phase3.integration.test.js
```

Expected: all cache cutover tests pass and retries allocate no second full copy.

- [ ] **Step 5: Commit resumable prepared backup**

```powershell
git add src/main/migration/cache/cutover.ts src/main/worker/dbService/databaseBackup.ts src/main/worker/dbService/db.ts src/main/startup/storageCoordinator.ts build-config/storage/credential-profile-scan.test.js build-config/storage/non-activity-source.test.js build-config/storage/non-activity-startup.test.js build-config/storage/startup-coordinator.test.js build-config/storage-electron/cache-cutover.test.js build-config/storage-electron/cache-lifecycle.test.js build-config/storage-electron/database-recovery.test.js build-config/storage-electron/playback-migration.test.js build-config/storage-electron/playback-phase3.integration.test.js
git commit -m "feat: resume one prepared schema-6 backup"
```

### Task 12: Write Cutover Evidence V2 and Guard Migration 7 In-Transaction

**Files:**
- Modify: `src/main/migration/cache/cutover.ts`
- Modify: `src/main/worker/dbService/databaseBackup.ts`
- Modify: `src/main/worker/dbService/migrations/types.ts`
- Modify: `src/main/worker/dbService/migrations/0007_cache_cleanup.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `build-config/storage-electron/cache-cutover.test.js`
- Modify: `build-config/storage-electron/cache-phase4.integration.test.js`

**Interfaces:**
- Consumes: one `VerifiedOnlineBackupGuard`, `verifyRecordedOnlineBackup`, and prepared marker from Task 11, or internal `existedBeforeOpen:false` from Task 10.
- Writes: `CutoverDetailsV2` only; parses both strict v1 and strict v2.
- Changes: migration 7 receives exact cutover evidence and `assertBackupGuard` through `MigrationContext`.
- Tests: consumes the test-only `CacheCutoverFixtureResult` from Task 11; none of its aggregate evidence fields are added to a production ready-result or guard interface.
- Guarantees: final guard failure rolls schema mirror, migration ledger, prepared-marker deletion, and cutover-marker insertion back to schema 6.

- [ ] **Step 1: Write failing v2/fresh/rollback tests**

```js
it('writes cutover v2 with exact backup evidence and removes prepared marker atomically', async() => {
  const result = await advanceExistingSchema6()
  const details = readCutoverDetails()
  assert.deepEqual(details, {
    backupBasename: result.backupBasename,
    backupByteLength: result.backupByteLength,
    backupRequired: true,
    backupSha256: result.backupSha256,
    backupSourceSchemaVersion: 6,
    completedAtMs: result.completedAtMs,
    fromSchemaVersion: 6,
    rawLyricsDeletedRows: result.rawLyricsDeletedRows,
    readWriteMarkerSha256: result.readWriteMarkerSha256,
    removedObjects: expectedRemovedObjects,
    toSchemaVersion: 7,
    version: 2,
  })
  assert.equal(readPreparedMarker(), null)
})

it('rolls schema ledger and markers back when the final in-transaction guard changes', async() => {
  await assert.rejects(advanceWithFinalGuardReplacement(), /backup_file_ownership_invalid/)
  assert.equal(readSchemaVersion(), 6)
  assert.equal(readMigration7Ledger(), null)
  assert.equal(readCutoverMarker(), null)
  assert.notEqual(readPreparedMarker(), null)
})

it('fresh database reaches schema 7 with backupRequired false and no backups root', async() => {
  await startFreshThroughPhase4()
  assert.deepEqual(readCutoverDetails(), {
    backupRequired: false,
    completedAtMs: fixture.completedAtMs,
    fromSchemaVersion: 6,
    rawLyricsDeletedRows: 0,
    readWriteMarkerSha256: fixture.readWriteMarkerSha256,
    removedObjects: expectedRemovedObjects,
    toSchemaVersion: 7,
    version: 2,
  })
  assert.equal(fs.existsSync(fixture.backupsRoot), false)
})
```

Add tests for an existing empty-looking schema-6 file requiring backup, exact v2 basename resolution while unknown artifacts are ignored, v1 read-only resolution without repair, malformed true/false unions, and basename traversal.

- [ ] **Step 2: Run cutover evidence tests and verify RED**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-cutover.test.js
```

Expected: FAIL because only `CutoverDetailsV1` exists, final backup validation is outside the migration transaction, and fresh/existing cutover share one backup path.

- [ ] **Step 3: Implement strict v2 union and migration context**

Declare:

```ts
interface CutoverDetailsV2Base {
  backupRequired: boolean
  completedAtMs: number
  fromSchemaVersion: 6
  rawLyricsDeletedRows: number
  readWriteMarkerSha256: string
  removedObjects: [...typeof SCHEMA7_REMOVED_OBJECTS]
  toSchemaVersion: 7
  version: 2
}

export type CutoverDetailsV2 =
  | (CutoverDetailsV2Base & {
    backupRequired: false
  })
  | (CutoverDetailsV2Base & {
    backupRequired: true
    backupBasename: string
    backupByteLength: number
    backupSha256: string
    backupSourceSchemaVersion: 6
  })

export type CutoverDetails = CutoverDetailsV1 | CutoverDetailsV2

export function readCutoverMarker(
  db: Database.Database,
  readWriteMarker: StrictMarkerRow<typeof READ_WRITE_MARKER_NAME>,
): {
  marker: StrictMarkerRow<typeof CUTOVER_MARKER_NAME>
  details: CutoverDetails
}

export interface CacheCleanupMigrationContext {
  cutover: CutoverDetailsV2
  assertBackupGuard(): void
}

export interface MigrationContext {
  appliedAtMs: number
  cacheCleanup?: CacheCleanupMigrationContext
}
```

`readCutoverMarker` first discriminates on `version`, then applies the exact canonical key set and hash frame for that version; it never accepts a hybrid v1/v2 object. Hash v2 details with frame `lx.storage.phase4.cutover-details.v2`. In both v2 variants, `readWriteMarkerSha256` is exactly `markerRowSha256(verifiedReadWriteMarker)`. The false variant must omit all four backup evidence fields. Keep the existing v1 key set and hash frame unchanged.

Run migration 7 in one transaction:

```ts
const runCacheCutoverMigration = (
  db: Database.Database,
  cacheCleanup: CacheCleanupMigrationContext,
): MigrationRunResult => db.transaction(() => {
  if (!Number.isSafeInteger(cacheCleanup.cutover.completedAtMs) ||
    cacheCleanup.cutover.completedAtMs < 0) throw new Error('phase4_cutover_marker_invalid')
  const context: MigrationContext = Object.freeze({
    appliedAtMs: cacheCleanup.cutover.completedAtMs,
    cacheCleanup,
  })
  const { migration7 } = require('./migrations/0007_cache_cleanup') as typeof CacheCleanupMigration
  migration7.up(db, context)
  db.prepare(`
    INSERT INTO schema_migrations(version, name, checksum, applied_at_ms)
    VALUES (?, ?, ?, ?)
  `).run(migration7.version, migration7.name, migration7.checksum, context.appliedAtMs)
  if (db.prepare("UPDATE db_info SET field_value = ? WHERE field_name = 'version'")
    .run('7').changes != 1) throw new Error('phase4_schema_invalid')
  migration7.verify?.(db, context)
  cacheCleanup.assertBackupGuard()
  return { fromVersion: 6, toVersion: 7, applied: [7] }
})()
```

`migration7.up` requires `context.cacheCleanup`, verifies/deletes the exact prepared marker, and writes v2 in that transaction for `backupRequired:true`; `migration7.verify` re-reads that exact v2 evidence through the same context. Both reject a missing context or an `appliedAtMs` unequal to `cutover.completedAtMs`. Fresh cutover asserts no prepared marker and never resolves/creates `backupsRoot`. Schema-7 steady state passes only the v2 marker's exact basename, SHA-256, byte length, and source schema to `verifyRecordedOnlineBackup`, revalidates the returned guard, and closes it in `finally`; it never scans. V1 derives the existing deterministic candidate and uses `verifyLegacyOnlineBackup` read-only, allowing its historical link count but never mutating it.

- [ ] **Step 4: Run cutover tests and verify GREEN**

Run:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-cutover.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-phase4.integration.test.js
```

Expected: both suites pass.

- [ ] **Step 5: Commit cutover evidence**

```powershell
git add src/main/migration/cache/cutover.ts src/main/worker/dbService/databaseBackup.ts src/main/worker/dbService/migrations/types.ts src/main/worker/dbService/migrations/0007_cache_cleanup.ts src/main/worker/dbService/db.ts build-config/storage-electron/cache-cutover.test.js build-config/storage-electron/cache-phase4.integration.test.js
git commit -m "feat: bind guarded backup evidence to schema 7"
```

### Task 13: Admit `session.defaultSession` for the Process Lifetime

**Files:**
- Create: `src/main/services/defaultSessionLifetime.ts`
- Modify: `src/main/application.ts`
- Modify: `build-config/storage/session-registry.test.js`

**Interfaces:**
- Consumes: `SessionRegistry.register({ key, session }): SessionRegistration`.
- Produces: `createDefaultSessionLifetime(registry): DefaultSessionLifetime`.
- Guarantees: default session key `electron:default` is registered once, its `ready` barrier is awaited, and `unregister` is never exposed or called.
- Preserves: explicit partition/transient session registration and unregister behavior.

- [ ] **Step 1: Write failing lifetime/barrier tests**

```js
test('admits the default session before application startup and never unregisters it', async() => {
  const fixture = createLifetimeFixture()
  const first = fixture.lifetime.admit(fixture.defaultSession)
  const second = fixture.lifetime.admit(fixture.defaultSession)
  assert.strictEqual(first, second)
  assert.equal(fixture.registrations.length, 1)
  fixture.ready.resolve()
  await first
  await fixture.shutdown()
  assert.equal(fixture.registrations[0].unregisterCalls, 0)
})

test('a clear started during shutdown still includes the lifetime default session', async() => {
  const fixture = await createRegisteredApplication()
  const clearing = fixture.registry.clearRegisteredCaches()
  fixture.beginShutdown()
  await clearing
  assert.deepEqual(fixture.clearedKeys, ['electron:default'])
  assert.equal(fixture.unregisterCalls, 0)
})
```

Add a source-wiring test that invokes the application start callback before `app.whenReady()` resolves and proves coordinator `start()` waits for default-session admission. Assert the default session reports all three registry categories, covering HTTP/cache-storage/code-cache state created by tray and lyric consumers.

- [ ] **Step 2: Run session tests and verify RED**

```powershell
node --test build-config/storage/session-registry.test.js
```

Expected: FAIL because no production code registers `session.defaultSession`.

- [ ] **Step 3: Implement the non-unregistering lifetime wrapper**

```ts
export interface DefaultSessionLifetime {
  admit(session: Electron.Session): Promise<void>
}

export const createDefaultSessionLifetime = (
  registry: Pick<SessionRegistry, 'register'>,
): DefaultSessionLifetime => {
  let admittedSession: Electron.Session | null = null
  let ready: Promise<void> | null = null
  return {
    admit(session) {
      if (ready != null) {
        if (admittedSession !== session) return Promise.reject(new Error('default_session_changed'))
        return ready
      }
      admittedSession = session
      const registration = registry.register({ key: 'electron:default', session })
      ready = registration.ready
      return ready
    },
  }
}
```

Do not store or return `registration.unregister`. In `application.ts` import Electron `session` and create one lifetime object. Build a shared readiness promise:

```ts
let defaultSessionLifetime: DefaultSessionLifetime | null = null
const applicationReady = app.whenReady().then(async() => {
  defaultSessionLifetime ??= createDefaultSessionLifetime(global.lx.sessionRegistry)
  await defaultSessionLifetime.admit(session.defaultSession)
})

const init = () => {
  void applicationReady.then(async() => {
    const outcome = await getStorageCoordinator().start()
    handleStartupOutcome(outcome)
  })
}
```

`open-url`, `activate`, normal readiness, and Linux delayed startup all call this gated `init`. No window-producing module can register before `applicationReady` resolves.

- [ ] **Step 4: Run session tests and verify GREEN**

```powershell
node --test build-config/storage/session-registry.test.js
npm run build:main
```

Expected: tests and main build pass.

- [ ] **Step 5: Commit lifetime default session**

```powershell
git add src/main/services/defaultSessionLifetime.ts src/main/application.ts build-config/storage/session-registry.test.js
git commit -m "fix: register the default session for process lifetime"
```

### Task 14: Serialize Account Generations and Persistent URL Writes in Main

**Files:**
- Create: `src/main/services/musicUrlAuthorization.ts`
- Create: `build-config/storage/music-url-authorization.test.js`
- Modify: `src/common/storage/cache.ts`
- Modify: `src/common/storage/cacheValidation.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/common/types/music.d.ts`
- Modify: `src/main/app.ts`
- Modify: `src/main/types/app.d.ts`
- Modify: `src/main/modules/winMain/rendererEvent/music.ts`
- Modify: `src/main/worker/dbService/modules/music_url/index.ts`
- Modify: `src/main/modules/qqMusic/index.ts`
- Modify: `src/main/modules/netease/account.ts`
- Modify: `src/main/modules/netease.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/core/music/utils.ts`
- Modify: `src/renderer/core/music/online.ts`
- Modify: `src/renderer/core/music/local.ts`
- Modify: `build-config/storage/cache-callsite.test.js`
- Modify: `build-config/storage/account-credential-cutover.test.js`

**Interfaces:**
- Produces: `MusicUrlAuthorizationService` with one FIFO for `wy` and one for `tx`.
- Changes: renderer IPC `music_url_get` and `music_url_put` require nested authorization DTOs; legacy flat payloads fail validation.
- Produces: new IPC `music_url_authorize` accepting only `{ provider }`.
- Changes: `musicUrlInvalidateAccount` returns a typed completed/unavailable result instead of collapsing unavailable to zero.
- Preserves: worker cache rows/keys, worker FIFO, QQ/NetEase network-generation guards, playback result delivery, and non-persistent User API URLs.

- [ ] **Step 1: Write failing FIFO, stale, account, and callsite tests**

```js
test('a write committed before transition is removed by the awaited invalidation', async() => {
  const fixture = createAuthorizationFixture()
  const authorization = await fixture.service.authorize('wy')
  const writing = fixture.service.write(fixture.put(authorization))
  await fixture.putStarted.promise
  const transition = fixture.service.transition('wy', async() => {
    await fixture.accounts.clear('netease')
    return { status: 'changed', value: undefined }
  })
  fixture.releasePut.resolve()
  await Promise.all([writing, transition])
  assert.deepEqual(fixture.events, ['put', 'account.clear', 'invalidate'])
})

test('a transition completed before a queued write rejects the stale authorization', async() => {
  const fixture = createAuthorizationFixture()
  const authorization = await fixture.service.authorize('tx')
  await fixture.service.transition('tx', fixture.replaceSameAccount)
  await assert.rejects(
    fixture.service.write(fixture.put(authorization)),
    error => error.code == 'music_url_authorization_stale',
  )
  assert.equal(fixture.workerPutCalls, 0)
})

test('current-generation writes persist and provider FIFOs are independent', async() => {
  const fixture = createAuthorizationFixture()
  const wy = await fixture.service.authorize('wy')
  const tx = await fixture.service.authorize('tx')
  await Promise.all([fixture.service.write(fixture.put(wy)), fixture.service.write(fixture.put(tx))])
  assert.deepEqual(fixture.storedProviders.sort(), ['tx', 'wy'])
})
```

Add tests for logout, same-account relogin, account replacement, invalidation unavailable blocking new authorization, mutation/invalidation await order, stale errors containing no cookie/URL/profile/path, authorization-before-network for every fallback request, response-quality rewriting, and User API bypass.

- [ ] **Step 2: Run authorization and callsite tests and verify RED**

```powershell
node --test build-config/storage/music-url-authorization.test.js build-config/storage/cache-callsite.test.js build-config/storage/account-credential-cutover.test.js
```

Expected: FAIL because renderer supplies raw account scope, main writes directly to worker, and account invalidation uses a separate queue.

- [ ] **Step 3: Define strict authorization wire contracts**

```ts
export type PersistentMusicUrlProviderV1 = 'wy' | 'tx'

export interface MusicUrlAuthorizationRequestV1 {
  provider: PersistentMusicUrlProviderV1
}

export interface MusicUrlAuthorizationV1 {
  version: 1
  provider: PersistentMusicUrlProviderV1
  accountScope: string
  generation: number
}

export interface AuthorizedMusicUrlKeyV1 {
  authorization: MusicUrlAuthorizationV1
  sourceTrackId: string
  quality: string
}

export interface AuthorizedMusicUrlGetInputV1 extends AuthorizedMusicUrlKeyV1 {
  nowMs: number
}

export interface AuthorizedMusicUrlPutInputV1 extends AuthorizedMusicUrlGetInputV1 {
  url: string
  providerExpiresAtMs?: number
}

export type MusicUrlInvalidationResultV1 =
  | { status: 'completed', deletedRows: number }
  | { status: 'unavailable', code: CacheDiagnosticCodeV1 }
```

Add strict plain-object parsers for request, authorization, authorized get, and authorized put. Require safe positive generation, exact provider/scope normalization, exact keys, bounded URL/track fields, and canonical quality values. Old flat `{ provider, accountScope, sourceTrackId, quality }` IPC input is invalid and never dual-decoded.

- [ ] **Step 4: Implement the main-owned FIFO and route every mutation**

```ts
export type AccountTransitionDecision<T> =
  | { status: 'unchanged', value: T }
  | { status: 'changed', value: T }

export interface MusicUrlAuthorizationService {
  authorize(provider: PersistentMusicUrlProviderV1): Promise<MusicUrlAuthorizationV1 | null>
  read(input: AuthorizedMusicUrlGetInputV1): Promise<CacheReadResultV1<string>>
  write(input: AuthorizedMusicUrlPutInputV1): Promise<CacheWriteResultV1>
  transition<T>(
    provider: PersistentMusicUrlProviderV1,
    mutation: () => Promise<AccountTransitionDecision<T>>,
  ): Promise<T>
  flush(): Promise<void>
}

export interface MusicUrlAuthorizationWorker {
  musicUrlGet(input: MusicUrlGetInputV1): Promise<CacheReadResultV1<string>>
  musicUrlPut(input: MusicUrlPutInputV1): Promise<CacheWriteResultV1>
  musicUrlInvalidateAccount(
    input: MusicUrlAccountInvalidationV1,
  ): Promise<MusicUrlInvalidationResultV1>
}

export function createMusicUrlAuthorizationService(input: {
  accounts: Pick<AccountRepository, 'getCookie' | 'getStatus'>
  worker: MusicUrlAuthorizationWorker
}): MusicUrlAuthorizationService
```

Generation starts at `1` per provider and lives only in main memory. Resolve `wy` from the hydrated NetEase cookie/profile and `tx` from QQ Music. `authorize` returns null without both a cookie and normalized public profile. `authorize`, `read`, and `write` queue by provider; reads and writes validate scope/generation/current account, strip authorization, and call the worker while holding the FIFO. Stale operations throw an error whose message and `code` are both `music_url_authorization_stale`; renderer maps a stale read to cache miss and silently ignores a stale background write.

Keep this account generation separate from `StorageCacheGenerationV1`, which invalidates renderer request memoization after a whole-cache reset. Neither counter authorizes the other's operations.

`transition` captures old scope, runs the authoritative mutation, advances generation only for `changed`, then awaits old-scope invalidation before release. Every successful credential save or clear returns `changed`, including refresh and same-scope relogin; `unchanged` is reserved for a rejected stale network result that performed no authoritative mutation.

An unavailable invalidation adds the old scope to a per-provider in-memory pending set. Each later `authorize` call enters that provider FIFO and retries every pending invalidation before reading the current account; it clears only scopes whose worker result is `completed`, and returns null while any scope remains unavailable. `flush` waits both provider tails but never discards pending scopes. Playback continues without persistence while authorization is blocked.

Create the service immediately after `AccountRepository.hydrate()`, store it on `global.lx.musicUrlAuthorization`, and register `flush` with the storage shutdown coordinator. Route all six current authoritative sites through `transition`:

```ts
await musicUrlAuthorization.transition('tx', async() => {
  await accounts.save('qq_music', accountInput)
  return { status: 'changed', value: undefined }
})

await musicUrlAuthorization.transition('wy', async() => {
  await accounts.clear('netease')
  return { status: 'changed', value: undefined }
})
```

Apply the same wrapper to QQ clear, QQ refresh save, QQ login/relogin save, NetEase invalid-profile clear, NetEase refresh/login save, and NetEase logout clear. Keep remote login/logout requests outside the FIFO and return `unchanged` when existing network-generation checks reject a stale result.

- [ ] **Step 5: Route renderer authorization through request lifetime**

Add `requestMusicUrlAuthorization(provider)` in `renderer/utils/ipc.ts`. Change `getMusicUrlCacheKey` to asynchronous:

```ts
export const getMusicUrlCacheKey = async(
  musicInfo: LX.Music.MusicInfo,
  quality: LX.Quality,
  persistentCache = true,
): Promise<AuthorizedMusicUrlKeyV1 | null> => {
  if (!persistentCache || /^user_api/.test(apiSource.value ?? '')) return null
  const provider = musicInfo.source == 'wy' || musicInfo.source == 'tx'
    ? musicInfo.source
    : null
  if (provider == null || !rendererAccountLooksLoggedIn(provider)) return null
  const authorization = await requestMusicUrlAuthorization(provider)
  return authorization == null
    ? null
    : { authorization, sourceTrackId: musicInfo.id, quality }
}
```

Every online/local/fallback path awaits this before starting its network URL request, carries the same authorization through the response, changes only `quality` when the provider returns a different type, and passes it to `saveMusicUrl`. Renderer profile checks remain defense in depth; only main derives scope.

- [ ] **Step 6: Run focused tests and verify GREEN**

```powershell
node --test build-config/storage/music-url-authorization.test.js build-config/storage/cache-callsite.test.js build-config/storage/account-credential-cutover.test.js
npm run build:main
npm run build:renderer
```

Expected: all tests/builds pass.

- [ ] **Step 7: Commit account-generation authorization**

```powershell
git add src/common/storage/cache.ts src/common/storage/cacheValidation.ts src/common/ipcNames.ts src/common/types/music.d.ts src/main/services/musicUrlAuthorization.ts src/main/app.ts src/main/types/app.d.ts src/main/modules/winMain/rendererEvent/music.ts src/main/worker/dbService/modules/music_url/index.ts src/main/modules/qqMusic/index.ts src/main/modules/netease/account.ts src/main/modules/netease.ts src/renderer/utils/ipc.ts src/renderer/core/music/utils.ts src/renderer/core/music/online.ts src/renderer/core/music/local.ts build-config/storage/music-url-authorization.test.js build-config/storage/cache-callsite.test.js build-config/storage/account-credential-cutover.test.js
git commit -m "fix: authorize URL writes by account generation"
```

### Task 15: Prove the Portable Filesystem Contract and Real-Volume Flows

**Files:**
- Create: `build-config/storage/portable-filesystem.test.js`
- Create: `build-config/storage/portable-filesystem-smoke.js`
- Modify: `build-config/storage/cache-ownership.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: direct-directory, artifact, isolation, migration lease, and theme/backup production modules.
- Produces these fixed smoke invocations: `node build-config/storage/portable-filesystem-smoke.js --root $env:LX_SMOKE_NTFS_ROOT --expected-fs ntfs`, the same command with `LX_SMOKE_FAT32_ROOT/fat32`, and the same command with `LX_SMOKE_EXFAT_ROOT/exfat`.
- Produces: `runProductionBackupFlow(runRoot, fsApi)`; the synthetic adapter and real-volume CLI both invoke the same production backup flow.
- Adds: `test:storage:portable` script running the static/unit portable suite.
- Guarantees: unavailable filesystem types are reported as evidence gaps and never counted as passes.

- [ ] **Step 1: Write failing hard-link and smoke-safety tests**

```js
test('contains no production hard-link operation under src', () => {
  const findings = analyzeProductionHardLinks(projectRoot)
  assert.deepEqual(findings, [])
})

test('runs lock backup theme file-isolation and directory-isolation flows without link support', async() => {
  const report = await runSyntheticPortableFlows({
    root: fixture.root,
    expectedFs: 'ntfs',
    probeFilesystem: async() => 'ntfs',
    fsApi: withoutLinkAndDirectoryFsync(fs),
  })
  assert.deepEqual(report.flows, {
    directoryIsolation: 'passed',
    fileIsolation: 'passed',
    lock: 'passed',
    themePublication: 'passed',
    uniqueBackup: 'passed',
  })
})

test('refuses real storage roots and filesystem-type mismatches', async() => {
  await assert.rejects(runSmoke({ root: fixture.profileRoot, expectedFs: 'ntfs' }), /smoke_root_refused/)
  await assert.rejects(runSmoke({
    root: fixture.disposableRoot,
    expectedFs: 'fat32',
    probeFilesystem: async() => 'ntfs',
  }), /smoke_filesystem_mismatch/)
})
```

Extend the existing source analyzer so direct, computed, destructured, and aliased `link`/`linkSync` calls under `src/**` are findings while test-only hard-link race fixtures remain allowed.

- [ ] **Step 2: Run the portable suite and verify RED**

```powershell
node --test build-config/storage/portable-filesystem.test.js build-config/storage/cache-ownership.test.js
```

Expected: the production hard-link assertion already passes after Tasks 1-14, while smoke imports/flow assertions FAIL because the guarded smoke runner does not exist.

- [ ] **Step 3: Implement the guarded smoke runner**

Parse exactly one `--root` and one `--expected-fs`. Require:

```js
const EXPECTED_FILESYSTEMS = new Set(['ntfs', 'fat32', 'exfat'])
const DISPOSABLE_ROOT_NAME = /^lx-portable-fs-smoke-[a-z0-9_-]+$/
```

The root must be absolute, existing, direct/non-link, empty, named with that regex, outside the repository, and neither equal to nor nested below a path whose direct basename is `LxDatas`, `profile`, `cache`, `portable`, or `backups`. Reject non-Windows hosts with `smoke_platform_unsupported`. On Windows, probe the actual volume using `powershell.exe -NoProfile -NonInteractive` and `Get-Volume -FilePath`; normalize its `FileSystem` to lowercase and require exact equality.

Create one unpredictable direct child matching `^lx-portable-smoke-run-[a-f0-9]{32}$` and run:

```js
const report = {
  filesystem: actualFilesystem,
  flows: {
    lock: await runLeaseFlow(runRoot),
    uniqueBackup: runProductionBackupFlow(runRoot, fsApi),
    themePublication: runSyntheticThemeFlow(runRoot),
    fileIsolation: await runFileIsolationFlow(runRoot),
    directoryIsolation: await runDirectoryIsolationFlow(runRoot),
  },
}
```

`runSyntheticPortableFlows` passes its received `fsApi` unchanged to `runProductionBackupFlow`; the real-volume CLI passes ordinary `node:fs`. `runProductionBackupFlow(runRoot, fsApi)` loads `databaseBackup.ts` through `scripts/test-utils/load-ts-module.js` with `{ 'node:fs': fsApi }`. Before that load, delete the cache entries for the production `exclusiveArtifact.js` and `directDirectory.js` dependencies so the loader's nested `Module._load` hook also supplies the same adapter to their `node:fs` imports. Load no test substitute for those modules. This makes the no-`link`/no-directory-fsync test fail deterministically if the production backup path reaches either operation instead of silently falling back to the default filesystem module.

`runProductionBackupFlow` creates a disposable better-sqlite3 database under the run child, inserts a known row, and invokes the loaded production `reserveOnlineBackup` and `completeOnlineBackup` APIs with a verifier that checks quick-check, foreign keys, source schema, and the known row. It asserts the returned guard's hash, byte length, source schema, and SQLite contents, then closes the guard; it never substitutes a generic artifact-only helper.

Each flow verifies bytes and identities. Remove only the exact run child after all guards revalidate and every flow passes; retain it on failure. Print one canonical JSON report and exit nonzero for unsafe root, mismatch, or failed flow.

Add:

```json
{
  "scripts": {
    "test:storage:portable": "node --test build-config/storage/portable-filesystem.test.js build-config/storage/cache-ownership.test.js"
  }
}
```

Merge that key into the existing `scripts` object without reordering unrelated entries.

- [ ] **Step 4: Run portable unit/static verification and collect volume evidence**

```powershell
npm run test:storage:portable
$portableRoots = @{
  ntfs = $env:LX_SMOKE_NTFS_ROOT
  fat32 = $env:LX_SMOKE_FAT32_ROOT
  exfat = $env:LX_SMOKE_EXFAT_ROOT
}
foreach ($filesystem in @('ntfs', 'fat32', 'exfat')) {
  $root = $portableRoots[$filesystem]
  if ([string]::IsNullOrWhiteSpace($root)) {
    Write-Output "EVIDENCE_GAP:${filesystem}:disposable root unavailable"
    continue
  }
  node build-config/storage/portable-filesystem-smoke.js --root $root --expected-fs $filesystem
  if ($LASTEXITCODE -ne 0) { throw "Portable smoke failed for $filesystem" }
}
```

Expected: unit/static tests pass. Each supplied real volume prints a passing canonical report. Each missing environment variable prints an explicit `EVIDENCE_GAP` line, not a pass.

- [ ] **Step 5: Commit portable verification**

```powershell
git add build-config/storage/portable-filesystem.test.js build-config/storage/portable-filesystem-smoke.js build-config/storage/cache-ownership.test.js package.json
git commit -m "test: verify portable filesystem ownership"
```

### Task 16: Run the Full Matrix and One Scoped Final Re-Review

**Files:**
- Create: `docs/superpowers/reviews/2026-08-03-portable-fail-closed-final-review.md`
- Modify only if review finds a blocker: files already owned by Tasks 1-15.

**Interfaces:**
- Consumes: the completed implementation commits and disposable test roots.
- Produces: one evidence report containing exact commands, pass/fail status, real-volume results/gaps, and final review ruling.
- Gate: any load-bearing finding stops integration and returns to the owning task's RED/GREEN loop.

- [ ] **Step 1: Verify the worktree and production hard-link gate**

```powershell
git status --short
git diff --check
npm run test:storage:portable
```

Expected: only intended implementation/review files are present, `git diff --check` is clean, and the portable source gate passes.

- [ ] **Step 2: Run the exact full verification matrix**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:TEMP=$env:LX_TEST_STORAGE_ROOT
$env:TMP=$env:LX_TEST_STORAGE_ROOT
npm run test:storage
npm run test:user-api
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/*.test.js
npm run lint
npm run build:main
npm run build:renderer
npm run test:main-bundle
git diff --check
```

Expected: every command exits 0. Do not summarize a failed or skipped command as passing.

- [ ] **Step 3: Re-run real-volume evidence without converting gaps to passes**

Run the Task 15 PowerShell evidence loop. Record the canonical report for each available filesystem and one `environmental evidence gap` entry for each unavailable filesystem. A type mismatch or failed flow is a blocker, not a gap.

- [ ] **Step 4: Request one scoped final code review**

Use `superpowers:requesting-code-review` once with review base `c739fdc6` and scope restricted to the approved remediation specification. The reviewer must check:

```text
1. No production hard-link dependency or stable-path destructive race remains.
2. Fresh DB and existing schema-6 backup/cutover branches obey their exact evidence contracts.
3. Prepared backup retries allocate no second candidate and final guard validation is in-transaction.
4. Root publication, cache creation, backup creation, and run-temp reservation occur in their allowed phases.
5. Portable retirement follows only journal-bound isolation state.
6. Default session and per-provider URL FIFO close their reviewed races.
7. Tests prove success reclamation and failure retention on every converted cleanup boundary.
```

If a load-bearing finding exists, do not create a second broad review. Return to the owning task, add a failing regression test, implement the minimal fix, rerun its focused tests and the full matrix, then ask the same reviewer to verify only the fix and original finding.

- [ ] **Step 5: Write and commit the evidence report**

The report must contain:

```markdown
# Portable Fail-Closed Final Review Evidence

- Review base: `c739fdc6`
- Full matrix: `passed`
- NTFS smoke: `passed` or `environmental evidence gap`
- FAT32 smoke: `passed` or `environmental evidence gap`
- exFAT smoke: `passed` or `environmental evidence gap`
- Load-bearing review findings: `none`
- Non-blocking observations: `none` or the exact reviewer text and ruling
```

Include the exact command outputs or concise pass evidence below this summary; do not claim results that were not observed.

```powershell
git add -f docs/superpowers/reviews/2026-08-03-portable-fail-closed-final-review.md
git commit -m "docs: record portable fail-closed verification"
```
