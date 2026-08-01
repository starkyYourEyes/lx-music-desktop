# Cache Database and Runtime Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move reconstructable structured data and cache-owned runtime artifacts out of the authoritative profile so cache failure, reset, and later user-initiated clearing cannot damage durable user data or Electron session state.

**Architecture:** Startup computes immutable profile/cache/runtime/temp/backup roots before loading modules that can create Electron sessions. The already-open authoritative database remains on schema 6 until a machine-verified Phase 3 attestation permits a separately guarded, serialized `cache.db` lifecycle. Raw lyrics are copied and verified, URL and alternate-source caches are replaced with source-scoped repositories, and only a typed Phase 4 attestation permits the authoritative schema-7 cleanup.

**Tech Stack:** Electron app/session APIs, Node.js filesystem/path APIs, TypeScript, `better-sqlite3`, Comlink, Vue renderer IPC, and `node:test`.

## Global Constraints

- Phase 3 must pass in the current code and must also be machine-verified from `legacy_data_v1.cross_artifact_complete` on every Phase 4 startup before creating, opening, or mutating `cache.db`.
- Portable profile layout preparation may precede the database gate because it locates the authoritative database; no cache-root mutation may precede the gate.
- Keep `lx.data.db` authoritative. `<cacheRoot>/cache.db` is the only new SQLite database and is always disposable.
- Open the authoritative database at schema 6, verify Phase 3, complete cache copy/read/write attestation, then advance the same open database to schema 7. Never call memoized `init()` a second time with a conflicting target.
- `StoragePaths.backupsRoot` is canonical: installed `<profileRoot>/backups`, portable `<portableRoot>/backups`. Production code may not derive a backup path elsewhere.
- Portable migration copies only `portable/userData/LxDatas` to `portable/profile`. It never copies the old Electron session tree or other `portable/userData` children.
- Retain the portable source until a successful typed-only startup is acknowledged and a later startup revalidates both manifests under the migration lock.
- Cache lifecycle is exactly `closed | opening | ready | unavailable | resetting`; one FIFO gate serializes open, close, reset, every cache RPC, and prune.
- Cache failure never enters authoritative recovery. Reads become misses, writes/prune become disabled, and diagnostics expose only fixed non-secret codes.
- Raw provider lyrics move to cache; edited lyrics remain authoritative and are never cleared with cache.
- Discard legacy music URLs and alternate-source rows because they have no trustworthy age or expiry metadata.
- New cache identities include provider/source track identity. URL identity also includes account scope and quality.
- Music URLs are bearer-like values: never log/export them and apply user-only file permissions where supported.
- Alternate-source replacement is atomic for the complete owner tuple. Raw lyric and alternate-source eviction removes complete owner groups.
- All byte accounting uses UTF-8 serialized bytes. Expiry and LRU ties use explicit deterministic key ordering.
- Set Electron `sessionData` before any `session.fromPartition()`, `BrowserWindow`, or `app.whenReady()` consumer.
- `sessionData` is a mixed persistent runtime root. Never recursively delete it. Clear only named Chromium cache categories through Electron APIs.
- Theme images and User API scripts are durable. External theme files are copied into main-owned opaque staging; only owned staging files may be deleted.
- Completed downloads, partial downloads, and `download_list` rows remain outside cache ownership.
- Do not create or clear `<cacheRoot>/artwork` or `<cacheRoot>/audio`; the current source inventory has no producer for either root.
- Phase 4 publishes a protected main-only `CacheManager`. It does not add or rewire a renderer clear-all action; that UI/action belongs to Phase 5.
- Every recursive delete proves direct-child ownership, regular non-link targets, and containment under the exact declared root.
- Phase 4 tests require an explicit short worktree-local D: fixture root. Set process-local `LX_TEST_STORAGE_ROOT`, `TEMP`, and `TMP`; never use a real profile, portable directory, backup, download directory, or browser session.
- Every Phase 4 test created by this plan, and every existing storage fixture modified by it, obtains its owned directory through `build-config/storage/helpers/test-storage-root.js`; untouched compatibility suites still run with process-local `TEMP`/`TMP` redirected to the same D: root.
- Inject tiny test quotas, clocks, and `ENOSPC` faults. Never allocate a literal 101 MiB cache or 20,001-track fixture.
- Preserve all unrelated user changes. Stage only files named by the active task and never stage `.superpowers/` artifacts.

## File Structure

- Create `src/common/storage/cachePhase.ts`: exact Phase 3 prerequisite parsing for Phase 4.
- Create `src/common/storage/cache.ts` and `cacheValidation.ts`: cache DTOs, diagnostics, policies, and strict validators.
- Create `src/main/bootstrap.ts` and `application.ts`: early path bootstrap followed by dynamic application loading.
- Create `src/main/utils/storagePaths.ts`: installed/portable root calculation and containment helpers.
- Create guarded portable migration modules under `src/main/migration/`.
- Create `src/main/utils/tempLifecycle.ts` and `src/main/services/themeAssetManager.ts`.
- Create `src/main/worker/dbService/cacheDb.ts`, `cacheTables.ts`, `cacheMigrate.ts`, and `cacheSchemaContract.ts`.
- Split raw and edited lyric repositories by database owner.
- Replace music URL and alternate-source modules with scoped cache repositories.
- Create `src/main/services/sessionRegistry.ts`, `cacheArtifactInventory.ts`, and `cacheManager.ts`.
- Create `src/main/migration/cache/rawLyrics.ts` and `cutover.ts`.
- Add authoritative migration `0007_cache_cleanup.ts` only after typed cache attestation.
- Add fixture-only Phase 4 helpers/tests under `build-config/storage/` and `build-config/storage-electron/`.

## Shared Interfaces

Use these names and semantics unchanged across tasks:

```ts
export interface StoragePaths {
  profileRoot: string
  cacheRoot: string
  runtimeRoot: string
  sessionDataRoot: string
  tempRoot: string
  runTempRoot: string
  backupsRoot: string
  portableRoot: string | null
}

export interface CachePhasePrerequisiteV1 {
  version: 1
  markerName: 'legacy_data_v1.cross_artifact_complete'
  markerSha256: string
}

export type CacheLifecycleState =
  | 'closed' | 'opening' | 'ready' | 'unavailable' | 'resetting'

export type CacheDiagnosticCode =
  | 'cache_phase3_prerequisite_invalid'
  | 'cache_target_invalid'
  | 'cache_open_failed'
  | 'cache_schema_invalid'
  | 'cache_integrity_failed'
  | 'cache_operation_failed'
  | 'cache_close_failed'
  | 'cache_delete_failed'
  | 'cache_reopen_failed'
  | 'cache_capacity_unavailable'

export type CacheReadResult<T> =
  | { status: 'hit'; value: T }
  | { status: 'miss' }
  | { status: 'unavailable'; code: CacheDiagnosticCode }

export type CacheWriteResult =
  | { status: 'stored' }
  | { status: 'unavailable'; code: CacheDiagnosticCode }

export type CacheExecutionResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'unavailable'; code: CacheDiagnosticCode }

export interface CacheOpenResult {
  status: 'ready' | 'created' | 'recreated' | 'unavailable'
  schemaVersion: 1 | null
  diagnostic: CacheDiagnosticCode | null
}

export interface CacheResetLease { resetId: string }

export interface CacheWorkerLifecycle {
  openCacheDatabase(): Promise<CacheOpenResult>
  beginCacheReset(): Promise<CacheResetLease>
  finishCacheReset(input: CacheResetLease): Promise<CacheOpenResult>
  getCacheLifecycleState(): Promise<CacheLifecycleState>
}

// Worker-private only. CacheDatabaseHandle is the active better-sqlite3 handle
// and neither it nor these callbacks crosses Comlink.
export interface CacheRepositoryGate {
  runCacheRead<T>(operation: (db: CacheDatabaseHandle) => T | null | undefined): Promise<CacheReadResult<T>>
  runCacheWrite(operation: (db: CacheDatabaseHandle) => void): Promise<CacheWriteResult>
  runCacheImmediate<T>(operation: (db: CacheDatabaseHandle) => T): Promise<CacheExecutionResult<T>>
}

export interface SessionClearResult {
  key: string
  component: 'chromium-http' | 'chromium-cache-storage' | 'chromium-code'
  status: 'cleared' | 'failed'
  code?: 'session_cache_clear_failed'
}
```

`DatabaseInitOptions` keeps `dataPath` and `previousShutdownWasClean` and requires all three storage/cutover inputs together: `cacheRoot`, `backupsRoot`, and `targetSchemaVersion`. Every process initially passes the immutable `StoragePaths.cacheRoot`, `StoragePaths.backupsRoot`, and `targetSchemaVersion: 6`; this is a migration ceiling, not a request to downgrade. When the on-disk database is already schema 7, `init()` accepts it only after verifying the exact schema-7 structural contract and `legacy_cache_v1.cutover` marker, reports schema 7, and never invokes a target-6 migration. Any other current version above the requested ceiling fails closed. The no-argument `openCacheDatabase()` derives its only target from the captured `cacheRoot`. First cutover calls `advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot })` on the existing authoritative connection and atomically refreshes database health, memoized startup result, and the coordinator's ready outcome to schema 7.

---

### Task 0: Add the Fixture Root and Executable Phase 3 Gate

**Files:**
- Create: `src/common/storage/cachePhase.ts`
- Create: `build-config/storage/helpers/test-storage-root.js`
- Create: `build-config/storage/cache-phase-prerequisite.test.js`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/worker/dbService/modules/phase3/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: `src/main/types/db_service.d.ts`
- Modify: `build-config/storage/startup-coordinator.test.js`

**Interfaces:**
- Produces: `getCachePhasePrerequisite(value?: unknown): CachePhasePrerequisiteV1`.
- Adds: optional coordinator dependency `initializePhase4(prerequisite): Promise<{ schemaVersion: 6 | 7 }>`; when absent, ready uses the authoritative startup result, and when present, ready uses this returned schema version.
- Consumes: only the exact cross-artifact marker and canonical `Phase3ManifestV1` parser/hash.
- Guarantees: no Phase 4 cache initializer runs before valid writer and reader evidence.

- [ ] **Step 1: Write the failing prerequisite and call-order tests**

```js
it('rejects a missing marker before cache initialization', async() => {
  const result = await start({ marker: null })
  assert.equal(result.reason, 'cache_phase3_prerequisite_invalid')
  assert.equal(calls.includes('phase4:initialize'), false)
  assert.equal(await sha256(appDbPath), beforeHash)
})

it('accepts only a canonical marker with complete typed playback checks', () => {
  const result = getCachePhasePrerequisite(completeMarker())
  assert.equal(result.markerName, 'legacy_data_v1.cross_artifact_complete')
  assert.throws(() => getCachePhasePrerequisite(markerWith({ playbackReader: 'not-applicable' })))
})
```

Cover missing/corrupt JSON, unexpected fields/order, hash mismatch, incomplete writer, incomplete reader, a valid immutable replay, and propagation of the initializer's schema version into the coordinator ready outcome. The coordinator calls this after the existing Phase 3 gate and before the optional `initializePhase4(prerequisite)` dependency.

- [ ] **Step 2: Run and verify RED with a D-local process environment**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:TEMP=$env:LX_TEST_STORAGE_ROOT
$env:TMP=$env:LX_TEST_STORAGE_ROOT
node --test build-config/storage/cache-phase-prerequisite.test.js build-config/storage/startup-coordinator.test.js
```

Expected: FAIL because no exact Phase 4 prerequisite API or coordinator gate exists.

- [ ] **Step 3: Implement the narrow marker verifier and owned fixture helper**

Parse `detailsJson` as `Phase3ManifestV1`, require canonical JSON and `phase3ManifestSha256(manifest) === marker.sourceSha256`, and require `playback-writer` and `playback-reader` to be `complete`. The worker method takes no marker name or caller-supplied value. Convert all malformed cases to `cache_phase3_prerequisite_invalid` without exposing marker contents.

`createTestStorageRoot(prefix)` requires `LX_TEST_STORAGE_ROOT`, creates one unique direct non-link child with an ownership marker, and removes only that child after a second identity/containment check. It never removes the supplied base root.

- [ ] **Step 4: Verify GREEN and the unchanged Phase 3 startup contract**

Run the command from Step 2 plus:

```powershell
node --no-warnings --experimental-strip-types --test build-config/storage/playback-comparison.test.js
```

Expected: all tests pass and rejected prerequisite cases preserve the schema-6 database hash.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/cachePhase.ts src/main/startup/storageCoordinator.ts src/main/worker/dbService/modules/phase3/index.ts src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts src/main/types/db_service.d.ts build-config/storage/helpers/test-storage-root.js build-config/storage/cache-phase-prerequisite.test.js build-config/storage/startup-coordinator.test.js
git commit -m "test: enforce the cache phase prerequisite"
```

### Task 1: Bootstrap Explicit Roots and Canonical Backups

**Files:**
- Create: `src/main/utils/storagePaths.ts`
- Create: `src/main/bootstrap.ts`
- Create: `src/main/application.ts`
- Create: `build-config/storage/storage-paths.test.js`
- Modify: `src/main/index.ts`
- Modify: `src/main/app.ts`
- Modify: `src/main/types/app.d.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `build-config/storage/startup-coordinator.test.js`
- Modify: `build-config/storage-electron/account-profile.test.js`
- Modify: `build-config/storage-electron/database-recovery.test.js`
- Modify: `build-config/storage-electron/migration-runner.test.js`
- Modify: `build-config/storage-electron/non-activity-repository.test.js`
- Modify: `build-config/storage-electron/non-activity-retry.test.js`
- Modify: `build-config/storage-electron/playback-clear.test.js`
- Modify: `build-config/storage-electron/playback-migration.test.js`
- Modify: `build-config/storage-electron/playback-phase3.integration.test.js`
- Modify: `build-config/storage-electron/playback-renderer-crash.integration.test.js`
- Modify: `build-config/storage-electron/playback-retention.test.js`
- Modify: `build-config/storage-electron/playback-storage.test.js`
- Modify: `build-config/storage-electron/storage-foundation.integration.test.js`

**Interfaces:**
- Produces: immutable `StoragePaths` before the application module graph loads.
- Produces: `resolveStoragePaths()`, `initializeStoragePaths()`, and `assertContainedPath()`.
- Changes: every `DatabaseInitOptions` call site supplies the same immutable `cacheRoot` and `backupsRoot` from `StoragePaths`, plus the explicit initial `targetSchemaVersion: 6`; `backupDir` is removed.

- [ ] **Step 1: Write installed, portable, import-order, and backup-location tests**

```js
it('builds explicit portable siblings beside the executable', () => {
  assert.deepEqual(resolvePortable('D:\\Player\\app.exe'), {
    portableRoot: 'D:\\Player\\portable',
    profileRoot: 'D:\\Player\\portable\\profile',
    cacheRoot: 'D:\\Player\\portable\\cache',
    runtimeRoot: 'D:\\Player\\portable\\runtime',
    sessionDataRoot: 'D:\\Player\\portable\\runtime\\session-data',
    tempRoot: 'D:\\Player\\portable\\temp',
    backupsRoot: 'D:\\Player\\portable\\backups',
  })
})

it('sets both Electron paths before loading application modules', async() => {
  await bootstrap(fakeElectron, importApplication)
  assert.deepEqual(calls.slice(0, 3), [
    'setPath:userData', 'setPath:sessionData', 'import:application',
  ])
})
```

Also assert installed backups use `<profileRoot>/backups`, portable backups use the sibling `portable/backups`, and no backup appears under `portable/profile/backups`.
- [ ] **Step 2: Run and verify RED**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:TEMP=$env:LX_TEST_STORAGE_ROOT
$env:TMP=$env:LX_TEST_STORAGE_ROOT
node --test build-config/storage/storage-paths.test.js
```

Expected: FAIL because the current entry point derives one mixed user-data root and loads the application statically.

- [ ] **Step 3: Implement the early bootstrap and canonical root contract**

`src/main/index.ts` must remain a minimal entry that loads `bootstrap.ts`; `bootstrap.ts` may import only Electron/path/bootstrap-safe modules, applies `userData` and `sessionData`, stores `global.storagePaths`, then dynamically imports `application.ts`. Move the current startup body into `application.ts`. Remove `setUserDataPath()` ownership from `app.ts`.

Installed mode keeps the current roaming `LxDatas` profile. Use Electron's application-local cache location as the parent for distinct `cache` and `runtime` children, and use the OS temp base plus `PROJECT_IDENTITY.appId` for `tempRoot`. Portable mode computes the exact five sibling roots. Do not create `cacheRoot` here; Task 4 creates it only after Task 0 succeeds. Keep `global.lxDataPath=profileRoot` as a compatibility alias while production callers migrate to `global.storagePaths`.

Pass `global.storagePaths.cacheRoot`, `global.storagePaths.backupsRoot`, and `targetSchemaVersion: 6` together to database initialization. Rename the backup option and update every fixture call site with roots created through `createTestStorageRoot()` and the explicit target; retain all existing backup collision/containment behavior. Include all three values in initialization identity checks so memoized `init()` rejects conflicting roots or targets. Until Task 10 installs migration 7 and its verified steady-state branch, every current version above 6 remains rejected.

- [ ] **Step 4: Verify GREEN and startup compatibility**

```powershell
node --test build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/database-recovery.test.js
npm run build:main
```

Expected: all tests/build pass, and source scans find no production `path.join(profileRoot, 'backups')` or `path.join(global.lxDataPath, 'backups')` derivation.

- [ ] **Step 5: Commit**

```powershell
git add src/main/utils/storagePaths.ts src/main/bootstrap.ts src/main/application.ts src/main/index.ts src/main/app.ts src/main/types/app.d.ts src/main/worker/dbService/db.ts build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js build-config/storage-electron/account-profile.test.js build-config/storage-electron/database-recovery.test.js build-config/storage-electron/migration-runner.test.js build-config/storage-electron/non-activity-repository.test.js build-config/storage-electron/non-activity-retry.test.js build-config/storage-electron/playback-clear.test.js build-config/storage-electron/playback-migration.test.js build-config/storage-electron/playback-phase3.integration.test.js build-config/storage-electron/playback-renderer-crash.integration.test.js build-config/storage-electron/playback-retention.test.js build-config/storage-electron/playback-storage.test.js build-config/storage-electron/storage-foundation.integration.test.js
git commit -m "feat: bootstrap explicit storage roots"
```

### Task 2: Migrate the Portable Profile with a Locked Journal

**Files:**
- Create: `src/main/migration/guardedDirectoryMigration.js`
- Create: `src/main/migration/guardedDirectoryMigration.d.ts`
- Create: `src/main/migration/portableProfile.js`
- Create: `src/main/migration/portableProfile.d.ts`
- Create: `build-config/storage/portable-profile-migration.test.js`
- Modify: `src/main/migration/legacyUserData.js`
- Modify: `src/main/migration/legacyUserData.d.ts`
- Modify: `src/main/bootstrap.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `build-config/storage/credential-profile-scan.test.js`

**Interfaces:**
- Produces: `preparePortableProfile()`, `acknowledgePortableProfileStartup()`, and `retireAcknowledgedPortableSource()`.
- Reuses: one guarded lock/manifest/promotion implementation for installed legacy and portable migration.
- Guarantees: source removal occurs only on a later process start after a prior typed-only acknowledgement.

- [ ] **Step 1: Write the migration state-machine matrix**

```js
it('promotes only LxDatas and retains it through the acknowledged startup', async() => {
  const first = preparePortableProfile(fixture)
  assert.equal(first.state, 'promoted')
  assert.equal(await exists(sourceLxDatas), true)
  assert.equal(await exists(path.join(profileRoot, 'lx.data.db')), true)
  assert.equal(await exists(path.join(profileRoot, 'Session Storage')), false)

  await acknowledgePortableProfileStartup(first.token)
  assert.equal(await exists(sourceLxDatas), true)
  await retireAcknowledgedPortableSource(nextStartupFixture)
  assert.equal(await exists(sourceLxDatas), false)
})
```

Cover fresh install, interrupted copy, stale owned stage, live/dead lock, retry, destination collision, source mutation, symlink/reparse point, two concurrent creators, acknowledgement mismatch, and files outside `LxDatas`.

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/portable-profile-migration.test.js
```

Expected: FAIL because the current portable path treats `portable/userData` as the live root.

- [ ] **Step 3: Implement locked copy, manifest verification, promotion, and delayed retirement**

Factor the current cooperating-process lock, stable `lstat` checks, non-link traversal, sorted file SHA-256 manifest, owned stage cleanup, and no-replace promotion into `guardedDirectoryMigration.js` without weakening installed migration tests.

Portable lock, journal, and stage are direct children of `portableRoot`, outside the profile payload. The journal has version 1, source/destination manifest hashes, promotion run ID, state `promoted | typed-only-acknowledged`, and acknowledgement run ID. A non-empty invalid destination never becomes success. First startup promotes and keeps the source; the coordinator writes acknowledgement only after Phase 4 typed repository smoke succeeds; a later startup reacquires the lock and revalidates both recorded manifests before removing only the exact source `portable/userData/LxDatas`.

- [ ] **Step 4: Verify GREEN and existing migration compatibility**

```powershell
node --test build-config/storage/portable-profile-migration.test.js build-config/storage/credential-profile-scan.test.js
npm run build:main
```

Expected: all cases pass and no old Electron session-data child is copied.

- [ ] **Step 5: Commit**

```powershell
git add src/main/migration/guardedDirectoryMigration.js src/main/migration/guardedDirectoryMigration.d.ts src/main/migration/portableProfile.js src/main/migration/portableProfile.d.ts src/main/migration/legacyUserData.js src/main/migration/legacyUserData.d.ts src/main/bootstrap.ts src/main/startup/storageCoordinator.ts build-config/storage/portable-profile-migration.test.js build-config/storage/credential-profile-scan.test.js
git commit -m "feat: migrate the portable profile safely"
```

### Task 3: Own Per-Run Temp and Theme Assets in Main

**Files:**
- Create: `src/main/utils/tempLifecycle.ts`
- Create: `src/main/services/themeAssetManager.ts`
- Create: `build-config/storage/temp-lifecycle.test.js`
- Create: `build-config/storage/theme-asset-manager.test.js`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/utils/index.ts`
- Modify: `src/main/modules/winMain/rendererEvent/app.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/common/types/ipc_main.d.ts`
- Modify: `src/common/types/ipc_renderer.d.ts`
- Modify: `src/common/types/theme.d.ts`
- Modify: `src/main/types/app.d.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/views/Setting/components/ThemeEditModal/index.vue`
- Modify: `src/renderer/worker/main/music.ts`
- Modify: `src/renderer/worker/main/index.ts`
- Modify: `src/renderer/worker/utils/index.ts`

**Interfaces:**
- Produces: `RunTempHandle` for exactly `theme-editor | local-artwork | backup-import`.
- Produces: main-only `stageThemeImage`, `promoteThemeImage`, and `discardThemeImage` ownership.
- Guarantees: renderer cancellation/scavenge cannot delete an external file.

- [ ] **Step 1: Write ownership, external-file, and durable-promotion tests**

```js
it('copies an external image into opaque owned staging and preserves the source', async() => {
  const staged = await manager.stageThemeImage({ sourcePath: externalImage })
  await manager.discardThemeImage({ stagingId: staged.stagingId })
  assert.equal(await sha256(externalImage), originalHash)
  assert.equal(await exists(stagedOwnedPath), false)
})

it('rejects a replaced staged link before promotion', async() => {
  const staged = await manager.stageThemeImage({ sourcePath: externalImage })
  await replaceWithLink(stagedOwnedPath, outsideFile)
  await assert.rejects(manager.promoteThemeImage(staged), /theme_stage_invalid/)
  assert.equal(await exists(outsideFile), true)
})
```

Also cover duplicate basename, invalid image bytes, oversize input, failed save, old `theme_images` copy/hash/read-back, startup scavenging, and local-artwork containment.

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/temp-lifecycle.test.js build-config/storage/theme-asset-manager.test.js
```

Expected: FAIL because the renderer currently copies/moves/deletes paths below durable `theme_images/temp`.

- [ ] **Step 3: Implement owned run directories and main-owned theme operations**

```ts
export interface RunTempHandle {
  runTempRoot: string
  createChild(name: 'theme-editor' | 'local-artwork' | 'backup-import'): Promise<string>
  cleanup(): Promise<void>
}
```

Each run is a direct non-link child with exclusive `.owner.v1.json`. Scavenge/cleanup checks directory and marker identity twice and removes only that owned run child.

Theme staging accepts a selected external path only as source input. Main validates a bounded regular non-link image by content, copies it under a generated opaque name, and returns only an opaque `stagingId` plus a safe preview reference. Promotion revalidates ownership and atomically installs a collision-safe generated file in `<profileRoot>/assets/theme-images`; cancel removes only the staging ID. The renderer performs no direct filesystem delete/move for theme staging.

Configure the renderer worker once with `runTempRoot`; large local artwork uses an opaque file below `local-artwork` and no longer calls `os.tmpdir()`.

- [ ] **Step 4: Verify GREEN and builds**

```powershell
node --test build-config/storage/temp-lifecycle.test.js build-config/storage/theme-asset-manager.test.js
npm run build:main
npm run build:renderer
```

Expected: all tests/builds pass and an ownership scan finds no renderer-side theme file removal or migrated producer `os.tmpdir()` use.

- [ ] **Step 5: Commit**

```powershell
git add src/main/utils/tempLifecycle.ts src/main/services/themeAssetManager.ts src/main/startup/storageCoordinator.ts src/main/utils/index.ts src/main/modules/winMain/rendererEvent/app.ts src/common/ipcNames.ts src/common/types/ipc_main.d.ts src/common/types/ipc_renderer.d.ts src/common/types/theme.d.ts src/main/types/app.d.ts src/renderer/utils/ipc.ts src/renderer/views/Setting/components/ThemeEditModal/index.vue src/renderer/worker/main/music.ts src/renderer/worker/main/index.ts src/renderer/worker/utils/index.ts build-config/storage/temp-lifecycle.test.js build-config/storage/theme-asset-manager.test.js
git commit -m "feat: isolate temporary and theme assets"
```

### Task 4: Open a Guarded Cache DB Behind a Serialized Lifecycle

**Files:**
- Create: `src/main/worker/dbService/sqliteTarget.ts`
- Create: `src/main/worker/dbService/cacheDb.ts`
- Create: `src/main/worker/dbService/cacheTables.ts`
- Create: `src/main/worker/dbService/cacheMigrate.ts`
- Create: `src/main/worker/dbService/cacheSchemaContract.ts`
- Create: `src/main/worker/dbService/modules/cacheLifecycle/index.ts`
- Create: `build-config/storage-electron/cache-db.test.js`
- Create: `build-config/storage-electron/cache-lifecycle.test.js`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/types/db_service.d.ts`

**Interfaces:**
- Consumes: configured `cacheRoot` plus the exact Task 0 prerequisite re-read from `getAppDB()`.
- Produces: the shared `CacheWorkerLifecycle` and worker-private `CacheRepositoryGate` with the exact `runCacheRead`, `runCacheWrite`, and `runCacheImmediate` signatures above.
- Hides: the active cache handle and every gate callback from Comlink; public worker APIs remain typed repository methods plus `CacheWorkerLifecycle`.
- Guarantees: app DB remains usable for every cache failure.

- [ ] **Step 1: Write schema, corruption, degraded-mode, and concurrency tests**

```js
it('does not touch the cache target before the Phase 3 prerequisite', async() => {
  await assert.rejects(service.openCacheDatabase(), /cache_phase3_prerequisite_invalid/)
  assert.equal(await exists(cacheRoot), false)
  assert.equal(await sha256(appDbPath), appHash)
})

it('queues cache RPC behind one reset lease', async() => {
  const lease = await service.beginCacheReset()
  const pendingRead = service.runCacheRead(db => db.prepare(`
    SELECT text FROM raw_lyrics
    WHERE provider = ? AND source_track_id = ? AND lyric_type = ?
  `).get('tx', 'missing', 'lyric') ?? null)
  assert.equal(await isSettled(pendingRead), false)
  await service.finishCacheReset(lease)
  assert.deepEqual(await pendingRead, { status: 'miss' })
})

it('degrades on ENOSPC without entering app recovery', async() => {
  injectOpenError('ENOSPC')
  assert.deepEqual(await service.openCacheDatabase(), {
    status: 'unavailable', schemaVersion: null, diagnostic: 'cache_capacity_unavailable',
  })
  assert.equal(readDurableSentinel(), 'kept')
})
```

Cover malformed bytes, syntactically valid wrong schema/checksum, corrupt WAL/SHM, link/non-file target, target replacement, close/delete/reopen failure, `EACCES`, stale/foreign reset lease, concurrent open/reset/read/write/prune, and app-DB hash equality.

- [ ] **Step 2: Run and verify RED**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:TEMP=$env:LX_TEST_STORAGE_ROOT
$env:TMP=$env:LX_TEST_STORAGE_ROOT
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-db.test.js build-config/storage-electron/cache-lifecycle.test.js
```

Expected: FAIL because only the authoritative connection exists.

- [ ] **Step 3: Implement cache schema version 1 and the FIFO lifecycle gate**

`openCacheDatabase()` accepts no path argument. It uses only the immutable `DatabaseInitOptions.cacheRoot` captured by a successful authoritative initialization at schema 6 or the verified schema-7 steady state and resolves `<cacheRoot>/cache.db`; a missing prior initialization or conflicting reinitialization fails before touching the cache root.

Use this ownership schema without weakening constraints:

```sql
CREATE TABLE cache_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64),
  applied_at_ms INTEGER NOT NULL CHECK(applied_at_ms >= 0)
);

CREATE TABLE raw_lyric_groups (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, source_track_id)
);

CREATE TABLE raw_lyrics (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  lyric_type TEXT NOT NULL CHECK(lyric_type IN ('lyric','tlyric','rlyric','lxlyric')),
  text TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(provider, source_track_id, lyric_type),
  FOREIGN KEY(provider, source_track_id)
    REFERENCES raw_lyric_groups(provider, source_track_id) ON DELETE CASCADE
);

CREATE TABLE music_urls (
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  url TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(provider, account_scope, source_track_id, quality)
);

CREATE TABLE other_source_groups (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms >= 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  last_accessed_at_ms INTEGER NOT NULL CHECK(last_accessed_at_ms >= created_at_ms),
  PRIMARY KEY(original_provider, original_track_id)
);

CREATE TABLE other_sources (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(rank >= 0),
  candidate_provider TEXT NOT NULL,
  candidate_track_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  PRIMARY KEY(original_provider, original_track_id, rank),
  UNIQUE(original_provider, original_track_id, candidate_provider, candidate_track_id),
  FOREIGN KEY(original_provider, original_track_id)
    REFERENCES other_source_groups(original_provider, original_track_id) ON DELETE CASCADE
);
```

Add deterministic expiry/LRU indexes for URL rows and both owner-group tables. Validate migration version/name/checksum, exact tables/columns/indexes/FKs, `user_version=1`, and `quick_check`.

Refactor the existing guarded SQLite target checks into `sqliteTarget.ts` so both DB owners reject links, non-regular targets, containment changes, and visible target swaps. Cache policy differs: after statements/maps are invalidated and handles closed, only verified contained `cache.db`, `cache.db-wal`, and `cache.db-shm` may be isolated/recreated. `EACCES`, `ENOSPC`, close/delete/reopen failure, or unverifiable targets enter `unavailable`; return fixed codes without paths or payloads.

One FIFO mutex owns every state transition and repository callback. `beginCacheReset()` drains prior work, enters `resetting`, invalidates repositories, and closes. New RPC queues. `finishCacheReset()` consumes the single-use lease, reopens in a `finally` path, and releases queued work against `ready` or `unavailable`.

`runCacheRead()` maps only `null`/`undefined` to `miss`. `runCacheWrite()` reports `stored` only after its callback completes. `runCacheImmediate()` executes its callback inside one `better-sqlite3` immediate transaction and returns the committed value. All three queue on the same mutex as open/reset/prune and receive the active handle only while state is `ready`. Target identity/link failures map to `cache_target_invalid`, `SQLITE_FULL`/`ENOSPC` to `cache_capacity_unavailable`, corrupt/not-a-database failures to `cache_integrity_failed`, schema-contract failures to `cache_schema_invalid`, and any other repository callback failure to `cache_operation_failed`; each returns `unavailable`, invalidates statements, closes/isolate the handle when safe, and transitions lifecycle to `unavailable`. Repository code never imports or exports a generic cache handle.

- [ ] **Step 4: Verify GREEN and authoritative recovery isolation**

Run Step 2 plus:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/database-recovery.test.js
npm run build:main
```

Expected: cache tests and existing authoritative recovery tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/sqliteTarget.ts src/main/worker/dbService/cacheDb.ts src/main/worker/dbService/cacheTables.ts src/main/worker/dbService/cacheMigrate.ts src/main/worker/dbService/cacheSchemaContract.ts src/main/worker/dbService/modules/cacheLifecycle/index.ts src/main/worker/dbService/db.ts src/main/worker/dbService/index.ts src/main/worker/dbService/modules/index.ts src/main/startup/storageCoordinator.ts src/main/types/db_service.d.ts build-config/storage-electron/cache-db.test.js build-config/storage-electron/cache-lifecycle.test.js
git commit -m "feat: add the guarded cache database lifecycle"
```

### Task 5: Split Edited and Raw Lyrics and Verify the Copy

**Files:**
- Create: `src/main/worker/dbService/modules/lyric/raw/statements.ts`
- Create: `src/main/worker/dbService/modules/lyric/raw/repository.ts`
- Create: `src/main/worker/dbService/modules/lyric/edited/statements.ts`
- Create: `src/main/worker/dbService/modules/lyric/edited/repository.ts`
- Create: `src/main/migration/cache/rawLyrics.ts`
- Create: `build-config/storage-electron/raw-lyric-migration.test.js`
- Rewrite: `src/main/worker/dbService/modules/lyric/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/modules/winMain/rendererEvent/music.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/common/types/music.d.ts`
- Modify: `src/main/types/db_service.d.ts`
- Remove after replacement: `src/main/worker/dbService/modules/lyric/dbHelper.ts`
- Remove after replacement: `src/main/worker/dbService/modules/lyric/statements.ts`

**Interfaces:**
- Edited APIs use only `getAppDB()`.
- Raw reads use `runCacheRead`; raw owner replacement uses `runCacheImmediate`; public methods return `CacheReadResult`/`CacheWriteResult` without exposing a handle.
- Migration preserves every valid raw variant before recording `legacy_cache_v1.raw_lyrics`.

- [ ] **Step 1: Write split-ownership, fallback, hash, and degraded-mode tests**

```js
it('copies all raw variants and leaves edited rows byte-identical', async() => {
  const editedBefore = readAppEditedRows()
  const result = await migrateRawLyrics({ nowMs: 1000 })
  assert.equal(result.sourceRows, result.targetRows)
  assert.equal(result.sourceSha256, result.targetSha256)
  assert.deepEqual(readAppEditedRows(), editedBefore)
})

it('prefers exact provider and falls back to legacy only on a miss', async() => {
  await rawLyricPut(track('legacy', '1', 'old'))
  await rawLyricPut(track('tx', '1', 'new'))
  assert.equal((await rawLyricGet(key('tx', '1'))).value.lyric, 'new')
  assert.equal((await rawLyricGet(key('kw', '1'))).value.lyric, 'old')
})
```

Cover invalid legacy rows, all four variants, provider collisions, atomic owner replacement, group timestamps/bytes, copy interruption/retry, marker mismatch, pre-cutover app fallback, and unavailable-cache misses.

- [ ] **Step 2: Run and verify RED**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/raw-lyric-migration.test.js
```

Expected: FAIL because raw and edited rows share the authoritative connection and ID-only API.

- [ ] **Step 3: Implement source-scoped raw ownership and verified copy**

```ts
rawLyricGet(input: { provider: string; sourceTrackId: string; nowMs: number }): Promise<CacheReadResult<LX.Music.LyricInfo>>
rawLyricPut(input: { provider: string; sourceTrackId: string; lyrics: LX.Music.LyricInfo; nowMs: number }): Promise<CacheWriteResult>
rawLyricCount(): Promise<CacheReadResult<{ rows: number; ownerGroups: number; bytes: number }>>
```

Validate and serialize all variants, calculate exact UTF-8 bytes, and replace the complete `(provider, sourceTrackId)` group through `runCacheImmediate`. A hit and its one group access-time update run through `runCacheRead`. During migration decode old base64 rows, assign `provider='legacy'`, and hash sorted `(provider, sourceTrackId, lyricType, UTF8 text bytes)` tuples. Verify source/target row count, owner count, and hash before writing the authoritative marker. Before schema-7 cutover, a cache miss/unavailable result may fall back to the old app raw row; after cutover it is a reconstructable miss. Edited reads/writes never use cache.

- [ ] **Step 4: Verify GREEN and main/renderer contracts**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/raw-lyric-migration.test.js
npm run build:main
npm run build:renderer
```

Expected: tests/builds pass and edited fixtures remain unchanged.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/lyric src/main/migration/cache/rawLyrics.ts src/main/worker/dbService/modules/index.ts src/main/modules/winMain/rendererEvent/music.ts src/renderer/utils/ipc.ts src/common/ipcNames.ts src/common/types/music.d.ts src/main/types/db_service.d.ts build-config/storage-electron/raw-lyric-migration.test.js
git commit -m "refactor: move raw lyrics to cache ownership"
```

### Task 6: Replace URL and Alternate-Source APIs with Scoped Repositories

**Files:**
- Create: `src/common/storage/cache.ts`
- Create: `src/common/storage/cacheValidation.ts`
- Rewrite: `src/main/worker/dbService/modules/music_url/`
- Rewrite: `src/main/worker/dbService/modules/music_other_source/`
- Create: `build-config/storage-electron/scoped-cache-repository.test.js`
- Create: `build-config/storage/cache-callsite.test.js`
- Modify: `src/main/modules/winMain/rendererEvent/music.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/common/types/music.d.ts`
- Modify: `src/main/types/db_service.d.ts`
- Modify: `src/renderer/core/music/online.ts`
- Modify: `src/renderer/core/music/local.ts`
- Modify: `src/renderer/core/music/utils.ts`
- Modify: `src/renderer/core/useApp/useInitUserApi.ts`
- Modify: `src/main/modules/userApi/renderer/preload.js`
- Modify: `src/common/types/user_api.d.ts`
- Modify: `src/common/types/playback_source.d.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: `src/main/types/worker.d.ts`

**Interfaces:**
- URL owner: `(provider, accountScope, sourceTrackId, quality)`.
- Alternate-source owner: `(originalProvider, originalTrackId)` with complete atomic replacement.
- Product decision: activate the existing dormant alternate-source persistence with the scoped contract.

- [ ] **Step 1: Write validation, atomic ownership, and full call-site tests**

```js
it('never returns an expired or differently scoped URL', async() => {
  await musicUrlPut({ provider: 'tx', accountScope: 'user-a', sourceTrackId: '1', quality: '320k', url: 'TOKEN', providerExpiresAtMs: 100, nowMs: 1 })
  assert.equal((await musicUrlGet(key('user-a', 101))).status, 'miss')
  assert.equal((await musicUrlGet(key('user-b', 50))).status, 'miss')
})

it('atomically replaces the complete alternate-source owner set', async() => {
  await otherSourcesPut(owner, [candidate('a', 0), candidate('b', 1)])
  await otherSourcesPut(owner, [candidate('b', 0)])
  assert.deepEqual((await otherSourcesGet(owner)).value.map(x => x.id), ['b'])
})
```

Cover duplicate rank/candidate rejection, empty replacement, rollback after delete, credentials/URL stripping, byte totals, rank order, unavailable cache, User API source capture, and hostile/malformed IPC. The ownership scan must cover TS/JS/Vue/SQL across renderer, main IPC, User API preload/runtime, worker exports, shared types, and schemas.

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/cache-callsite.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/scoped-cache-repository.test.js
```

Expected: FAIL because current keys are synthesized ID-only strings and alternate-source persistence is disabled.

- [ ] **Step 3: Implement strict DTOs and scoped cache RPC**

```ts
musicUrlGet(input: MusicUrlKeyV1 & { nowMs: number }): Promise<CacheReadResult<string>>
musicUrlPut(input: MusicUrlKeyV1 & { url: string; providerExpiresAtMs?: number; nowMs: number }): Promise<CacheWriteResult>
musicUrlInvalidateAccount(input: { provider: string; accountScope: string }): Promise<number>
musicUrlInvalidateSource(input: { provider: string }): Promise<number>

otherSourcesGet(input: TrackIdentityV1 & { nowMs: number }): Promise<CacheReadResult<LX.Music.MusicInfoOnline[]>>
otherSourcesPut(input: TrackIdentityV1 & { candidates: LX.Music.MusicInfoOnline[]; nowMs: number }): Promise<CacheWriteResult>
```

Provider expiry wins; otherwise URL TTL is 15 minutes. Update access only on valid hits. Derive `accountScope` from a stable non-secret account/profile identity, never a cookie/token. Do not include URL values in errors/logs.

For alternate sources, strictly clone/sanitize candidates, reject credential/stream URL fields, duplicate ranks, and duplicate candidate identities, then use `runCacheImmediate` to delete old owner rows and insert the new ranked group plus exact group byte total. Empty candidates delete the group. URL/alternate reads use `runCacheRead`; single-row URL writes use `runCacheWrite`; reads update one owner timestamp inside the gated callback. Wire the actual `useInitUserApi.ts` closure and preload path. Discard all legacy URL/alternate rows rather than importing them.

- [ ] **Step 4: Verify GREEN, builds, and ownership scan**

```powershell
node --test build-config/storage/cache-callsite.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/scoped-cache-repository.test.js
npm run build:main
npm run build:renderer
```

Expected: no active unscoped ID-only cache signature/query remains.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/cache.ts src/common/storage/cacheValidation.ts src/main/worker/dbService/modules/music_url src/main/worker/dbService/modules/music_other_source src/main/modules/winMain/rendererEvent/music.ts src/renderer/utils/ipc.ts src/common/ipcNames.ts src/common/types/music.d.ts src/common/types/user_api.d.ts src/common/types/playback_source.d.ts src/main/types/db_service.d.ts src/main/types/worker.d.ts src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts src/renderer/core/music/online.ts src/renderer/core/music/local.ts src/renderer/core/music/utils.ts src/renderer/core/useApp/useInitUserApi.ts src/main/modules/userApi/renderer/preload.js build-config/storage-electron/scoped-cache-repository.test.js build-config/storage/cache-callsite.test.js
git commit -m "refactor: use scoped expiring cache repositories"
```

### Task 7: Enforce Deterministic TTL, Quota, and Invalidation

**Files:**
- Create: `src/main/worker/dbService/modules/cacheLifecycle/prune.ts`
- Create: `build-config/storage-electron/cache-policy.test.js`
- Modify: `src/common/storage/cache.ts`
- Modify: `src/main/worker/dbService/cacheTables.ts`
- Modify: `src/main/worker/dbService/cacheSchemaContract.ts`
- Modify: `src/main/worker/dbService/modules/cacheLifecycle/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: `src/main/modules/netease.ts`
- Modify: `src/main/modules/netease/account.ts`
- Modify: `src/main/modules/qqMusic/index.ts`
- Modify: `src/main/modules/userApi/index.ts`

**Interfaces:**
- Produces: `cachePrune({ nowMs, batchSize })` serialized with cache writes/reset.
- Consumes: injectable clock, limits, and UTF-8 byte calculator for small tests.
- Guarantees: exact group totals and stable eviction ties.

- [ ] **Step 1: Write small-policy boundary and concurrency tests**

```js
it('evicts every raw variant as one deterministic owner group', async() => {
  const service = fixture({ rawLyrics: { maxBytes: 1024, maxTracks: 2 } })
  await service.seedEqualTimestampGroups(['b:2', 'a:2', 'a:1'])
  const result = await service.prune()
  assert.deepEqual(result.rawLyrics.evictedOwners, ['a:1'])
  assert.equal(await service.rawVariantCount('a', '1'), 0)
  assert.equal(result.rawLyrics.bytesAfter, await service.rawBytes())
})

it('serializes prune with complete-owner replacement', async() => {
  const [write, prune] = await runControlledWriteAndPrune()
  assert.equal(write.partialRowsObserved, 0)
  assert.equal(prune.partialRowsObserved, 0)
})
```

Cover exact cap boundary, expired-first order, equal timestamps, group sums, all lyric variants, all alternate candidates, transaction rollback, post-prune count/bytes, URL account/source invalidation, and unavailable-cache no-op.

- [ ] **Step 2: Run and verify RED**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-policy.test.js
```

Expected: FAIL because no deterministic group policy exists.

- [ ] **Step 3: Implement fixed production policy with injectable test limits**

```ts
export const CACHE_POLICY = {
  musicUrls: { fallbackTtlMs: 15 * 60 * 1000, maxEntries: 5_000 },
  rawLyrics: { maxBytes: 100 * 1024 * 1024, maxTracks: 20_000, maxIdleMs: 180 * 24 * 60 * 60 * 1000 },
  otherSources: { ttlMs: 30 * 24 * 60 * 60 * 1000, maxBytes: 50 * 1024 * 1024 },
} as const
```

Expire first, then evict LRU until every cap passes. Stable order is access time, creation time, then binary provider/track/quality keys. Execute each bounded prune batch through `runCacheImmediate`, delete raw/alternate groups atomically, and report exact rows, owners, and bytes before/after. Run in batches of `1..500`, while idle and after a write exceeds 110% of a cap; never acquire the lifecycle gate recursively from inside a write callback.

After credential/profile clear succeeds, logout invalidates only the matching provider/account URL scope. Source disable invalidates only that provider's URLs. Neither touches raw lyrics, alternate sources, or unrelated accounts.

- [ ] **Step 4: Verify GREEN and main build**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-policy.test.js
npm run build:main
```

Expected: tests pass without a disk-filling fixture.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/cacheLifecycle/prune.ts src/main/worker/dbService/modules/cacheLifecycle/index.ts src/common/storage/cache.ts src/main/worker/dbService/cacheTables.ts src/main/worker/dbService/cacheSchemaContract.ts src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts src/main/modules/netease.ts src/main/modules/netease/account.ts src/main/modules/qqMusic/index.ts src/main/modules/userApi/index.ts build-config/storage-electron/cache-policy.test.js
git commit -m "feat: enforce deterministic cache policies"
```

### Task 8: Register Every Electron Session Behind a Clear Barrier

**Files:**
- Create: `src/main/services/sessionRegistry.ts`
- Create: `build-config/storage/session-registry.test.js`
- Modify: `src/main/modules/winMain/main.ts`
- Modify: `src/main/modules/winMain/index.ts`
- Modify: `src/main/modules/userApi/runtimeWindow.ts`
- Modify: `src/main/modules/userApi/main.ts`
- Modify: `src/main/modules/qqMusic/browserAuth.ts`
- Modify: `src/main/types/app.d.ts`
- Modify: `build-config/user-api/runtime-compatibility.test.js`
- Modify: `build-config/user-api/runtime-registry.test.js`
- Modify: `build-config/user-api/runtime-pool.test.js`

**Interfaces:**
- Produces: stable-key registration with a `ready` barrier and matching disposer.
- Produces: `clearRegisteredCaches()` for Task 9; no renderer exposure.
- Guarantees: a session created during a clear cannot be used before its cache categories are cleared.

- [ ] **Step 1: Write registration, disposal, barrier, and preservation tests**

```js
it('clears a session registered midway before its creator proceeds', async() => {
  const clearing = registry.clearRegisteredCaches()
  await firstSession.clearStarted
  const late = registry.register({ key: 'user-api:late', session: lateSession })
  assert.equal(await isSettled(late.ready), false)
  await clearing
  await late.ready
  assert.deepEqual(lateSession.calls, [
    'clearCache', 'clearStorageData:cachestorage', 'clearCodeCaches',
  ])
})

it('never clears cookies or local storage', async() => {
  await registry.clearRegisteredCaches()
  assert.equal(session.calls.includes('clearStorageData:all'), false)
  assert.equal(await session.cookies.get({}), cookieFixture)
  assert.equal(await readLocalStorage(), localStorageFixture)
})
```

Cover main `persist:win-main`, multiple User API partitions, duplicate key, duplicate session identity, mismatched unregister, disposal, transient QQ login with `cache:false`, per-session/category failure, and two concurrent clear callers.

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/session-registry.test.js
```

Expected: FAIL because sessions are created independently and User API creation occurs in `runtimeWindow.ts`.

- [ ] **Step 3: Implement stable registration and the clear barrier**

```ts
export interface SessionRegistration {
  ready: Promise<void>
  unregister(): void
}

export interface SessionRegistry {
  register(input: { key: string; session: Electron.Session }): SessionRegistration
  clearRegisteredCaches(): Promise<SessionClearResult[]>
}
```

Validate bounded stable keys. Deduplicate the exact `(key, session identity)` registration, reject key/identity collisions, and unregister only the matching token. Main, User API, and login owners must await `registration.ready` before constructing/loading a window that uses the session and call `unregister()` on the matching disposal path.

Keep User API registration ownership fully encapsulated in `runtimeWindow.ts`: `createRuntimeWindow()` awaits readiness before constructing/loading, the returned runtime retains its registration token, and `disposeRuntimeWindow()` unregisters it after successful disposal. Its existing async signatures do not change, so `src/main/modules/userApi/runtimePool.ts` and `src/main/modules/userApi/index.ts` require no production edit; the three named compatibility suites prove those callers remain valid. Apply the same encapsulation inside `qqMusic/browserAuth.ts`. Main-window creation becomes async so it can await registration before constructing `BrowserWindow`; `src/main/modules/winMain/index.ts` adopts that promise and handles a fixed-code creation failure without an unhandled rejection.

The clear barrier snapshots current registrations, clears them, and incorporates registrations that arrive before release. For each session call only:

```ts
session.clearCache()
session.clearStorageData({ storages: ['cachestorage'] })
session.clearCodeCaches({})
```

Return one shared `SessionClearResult` per stable key/category, collect fixed-code failures without skipping remaining sessions, and never include partition names beyond the validated stable key or any session data. Never call parameterless `clearStorageData()`, `clearAuthCache()`, or cookie APIs as part of this cache barrier.

- [ ] **Step 4: Verify GREEN and affected session suites**

```powershell
node --test build-config/storage/session-registry.test.js build-config/user-api/runtime-compatibility.test.js build-config/user-api/runtime-registry.test.js build-config/user-api/runtime-pool.test.js
npm run build:main
```

Expected: all tests/build pass, including the existing User API runtime creation, registry, pool, and disposal contracts. The new `session-registry.test.js` owns the transient QQ login-session coverage because there is no separate QQ browser-auth test file.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/sessionRegistry.ts src/main/modules/winMain/main.ts src/main/modules/winMain/index.ts src/main/modules/userApi/runtimeWindow.ts src/main/modules/userApi/main.ts src/main/modules/qqMusic/browserAuth.ts src/main/types/app.d.ts build-config/storage/session-registry.test.js build-config/user-api/runtime-compatibility.test.js build-config/user-api/runtime-registry.test.js build-config/user-api/runtime-pool.test.js
git commit -m "feat: register Electron cache sessions"
```

### Task 9: Publish a Protected Main-Only CacheManager

**Files:**
- Create: `src/main/services/cacheArtifactInventory.ts`
- Create: `src/main/services/cacheManager.ts`
- Create: `build-config/storage/cache-manager.test.js`
- Modify: `src/common/storage/cache.ts`
- Modify: `src/main/application.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/types/app.d.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/core/music/utils.ts`
- Modify: `src/renderer/core/useApp/useEventListener.ts`

**Interfaces:**
- Consumes: Task 4 reset lease, Task 8 session barrier, and immutable `StoragePaths`.
- Produces: a main-only `CacheManager.clearAll()` for Phase 5 to expose later.
- Produces: one main-to-renderer `storage_cache_generation_v1` notification carrying only a strictly increasing integer; it is not an invokable clear action.
- Does not modify: `SettingOther.vue`, `src/common/ipcNames.ts`, renderer clear-all IPC, or the current Chromium-only `clear_cache` handler.

- [ ] **Step 1: Write exact inventory, ordering, concurrency, and durable-preservation tests**

```js
it('uses only owned DB artifacts and registered Chromium categories', async() => {
  await manager.clearAll()
  assert.deepEqual(events, [
    'worker:begin-reset',
    'delete:cache.db', 'delete:cache.db-wal', 'delete:cache.db-shm',
    'sessions:clear-registered',
    'worker:finish-reset',
    'broadcast:generation:1',
  ])
  assert.equal(events.some(x => /artwork|audio|session-data/.test(x)), false)
})

it('does not publish a generation when no fresh cache connection is installed', async() => {
  reopenResult = { status: 'unavailable', schemaVersion: null, diagnostic: 'cache_reopen_failed' }
  const result = await manager.clearAll()
  assert.equal(result.status, 'degraded')
  assert.equal(result.generation, 0)
  assert.equal(events.some(x => x.startsWith('broadcast:')), false)
})
```

Seed byte-identifiable settings, app DB, vault, edited lyric, theme, User API script, completed/partial download, backup, cookies, local storage, and `download_list` fixtures. Assert every one is unchanged after success and each injected failure.
Also hold an alternate-source request open across a successful generation change and prove its late result cannot repopulate either `otherSourceCache` or `getOtherSourcePromises`; a failed reopen publishes no notification and leaves the current generation unchanged.

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/cache-manager.test.js
```

Expected: FAIL because no protected orchestrator or artifact inventory exists.

- [ ] **Step 3: Implement the main-only reset orchestration**

```ts
export interface CacheClearResult {
  status: 'cleared' | 'degraded'
  generation: number
  components: ReadonlyArray<{
    component: 'cache-db' | 'chromium-http' | 'chromium-cache-storage' | 'chromium-code'
    key: string
    status: 'cleared' | 'failed'
    code?: CacheDiagnosticCode | 'session_cache_clear_failed'
  }>
}

export interface CacheManager {
  clearAll(): Promise<CacheClearResult>
}
```

Inventory only the three cache DB artifacts and registered Chromium categories. Filesystem targets are derived internally as known direct non-link children; callers cannot supply paths. `clearAll()` is single-flight: acquire reset lease, delete validated DB artifacts, run the session barrier, and always call `finishCacheReset()` in `finally`. Cache RPC stays queued throughout.

Increment/broadcast generation only when `finishCacheReset()` installs a new usable cache connection (`created` or `recreated`). Session-category failures may produce `degraded` while still publishing the fresh DB generation. A delete/reopen failure that leaves no fresh DB publishes no generation. In-memory maps adopt the generation only from this internal broadcaster.

Export the exact internal event name `storage_cache_generation_v1` and generation DTO from `src/common/storage/cache.ts`. `application.ts` injects a publisher backed by the existing main-window `sendEvent`; no `ipcMain.handle`, renderer command, or settings action is added. `renderer/utils/ipc.ts` exposes a receive-only subscription, `useEventListener.ts` owns its disposal, and `music/utils.ts` clears `otherSourceCache` plus matching in-flight registrations on a strictly newer generation. Each asynchronous fill captures its starting generation and may populate a map only if that generation is still current; completion from an older generation may resolve its original caller but cannot overwrite or delete entries belonging to the new generation. Task 4 already invalidates worker-side statements under the reset lease, so there is no separate renderer-worker map consumer.

- [ ] **Step 4: Verify GREEN and prove no UI exposure**

```powershell
node --test build-config/storage/cache-manager.test.js
npm run build:main
npm run build:renderer
git diff -- src/renderer/views/Setting/components/SettingOther.vue src/common/ipcNames.ts
```

Expected: tests/builds pass and the final diff command is empty for this task.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/cacheArtifactInventory.ts src/main/services/cacheManager.ts src/common/storage/cache.ts src/main/application.ts src/main/startup/storageCoordinator.ts src/main/types/app.d.ts src/renderer/utils/ipc.ts src/renderer/core/music/utils.ts src/renderer/core/useApp/useEventListener.ts build-config/storage/cache-manager.test.js
git commit -m "feat: add the protected cache manager"
```

### Task 10: Attest Typed Cache Ownership and Advance to Schema 7

**Files:**
- Create: `src/main/worker/dbService/modules/phase4/index.ts`
- Create: `src/main/migration/cache/cutover.ts`
- Create: `src/main/worker/dbService/migrations/0007_cache_cleanup.ts`
- Create: `build-config/storage-electron/cache-cutover.test.js`
- Modify: `src/common/storage/cachePhase.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `src/main/worker/dbService/migrations/index.ts`
- Modify: `src/main/worker/dbService/schemaContract.ts`
- Modify: `src/main/worker/dbService/tables.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/modules/lyric/index.ts`
- Modify: `src/main/worker/dbService/modules/account_profile/dbHelper.ts`
- Modify: `src/main/worker/dbService/modules/account_profile/statements.ts`
- Modify: `src/main/worker/dbService/modules/app_state/dbHelper.ts`
- Modify: `src/main/worker/dbService/modules/app_state/statements.ts`
- Modify: `src/main/worker/dbService/modules/dislike_list/dbHelper.ts`
- Modify: `src/main/worker/dbService/modules/dislike_list/statements.ts`
- Modify: `src/main/worker/dbService/modules/download/dbHelper.ts`
- Modify: `src/main/worker/dbService/modules/download/statements.ts`
- Modify: `src/main/worker/dbService/modules/list/dbHelper.ts`
- Modify: `src/main/worker/dbService/modules/list/statements.ts`
- Modify: `src/main/worker/dbService/modules/phase3/index.ts`
- Modify: `src/main/worker/dbService/modules/playback/dbHelper.ts`
- Modify: `src/main/worker/dbService/modules/playback/index.ts`
- Modify: `src/main/worker/dbService/modules/playback/repository.ts`
- Modify: `src/main/worker/dbService/modules/playback/retention.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: `src/main/types/db_service.d.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/migration/portableProfile.js`
- Modify: `build-config/storage-electron/account-profile.test.js`
- Modify: `build-config/storage-electron/migration-runner.test.js`
- Modify: `build-config/storage-electron/non-activity-repository.test.js`
- Modify: `build-config/storage-electron/non-activity-retry.test.js`
- Modify: `build-config/storage-electron/playback-clear.test.js`
- Modify: `build-config/storage-electron/playback-migration.test.js`
- Modify: `build-config/storage-electron/playback-phase3.integration.test.js`
- Modify: `build-config/storage-electron/playback-renderer-crash.integration.test.js`
- Modify: `build-config/storage-electron/playback-retention.test.js`
- Modify: `build-config/storage-electron/playback-storage.test.js`
- Modify: `build-config/storage/cache-callsite.test.js`

**Interfaces:**
- Produces: immutable `legacy_cache_v1.read_write_verified` and `legacy_cache_v1.cutover` markers.
- Produces: `advanceAppDatabase({ targetSchemaVersion: 7, backupsRoot })` on the existing connection.
- Removes: compatibility alias `getDB`; ownership must compile as `getAppDB` or lifecycle-mediated cache access.

- [ ] **Step 1: Write marker, cutover, backup, retry, and ownership tests**

```js
it('refuses schema 7 before every typed cache check is verified', async() => {
  smoke.otherSourcesAtomicReplace = false
  await assert.rejects(completeCacheCutover(), /phase4_cache_smoke_failed/)
  assert.equal(readSchemaVersion(), 6)
  assert.equal(countAppRawRows(), sourceRawCount)
  assert.equal(readMarker('legacy_cache_v1.read_write_verified'), null)
})

it('advances the same open DB and writes cutover atomically', async() => {
  const connectionIdentity = getAppDB()
  await completeCacheCutover()
  assert.equal(getAppDB(), connectionIdentity)
  assert.equal(readSchemaVersion(), 7)
  assert.equal(countAppEditedRows(), editedCount)
  assert.equal(countAppRawRows(), 0)
  assert.equal(hasTable('music_url'), false)
  assert.equal(hasTable('music_info_other_source'), false)
})
```

Cover fresh install, schema-6 upgrade, skipped-release upgrade, direct target-7 refusal, raw marker mismatch, unhealthy cache, each typed smoke failure, failure before/after marker, inside/after migration 7, retry exactly once, canonical installed/portable backup root, and no second `init()`. After a successful cutover, close every handle and construct a fresh service/coordinator against the same files: initial target 6 must accept and report verified schema 7 without replaying migration or backup creation, then `initializePhase4` must open the same `cache.db` and complete a typed write/read smoke successfully. Reject the same relaunch before any cache mutation when the schema-7 contract or cutover marker is absent/mismatched.

Add a post-cutover raw-read test that deletes the corresponding cache row, traces authoritative SQL, and expects a cache miss with zero authoritative raw-lyric query. The ownership test permits legacy raw SQL only in `src/main/migration/cache/rawLyrics.ts` and rejects it from active lyric repositories/callers.

- [ ] **Step 2: Run and verify RED**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-cutover.test.js
```

Expected: FAIL because no Phase 4 attestation or schema-7 migration exists.

- [ ] **Step 3: Implement exact typed attestation and guarded advancement**

At schema 6, revalidate the Task 0 marker, `legacy_cache_v1.raw_lyrics`, cache schema health, and named smoke checks for raw lyric write/read, URL write/read/expiry, and alternate-source atomic replace/read. Smoke data uses reserved non-user identities and rolls back all fixture rows in its transaction. Persist `legacy_cache_v1.read_write_verified` with version, cache schema version, raw-marker hash, exact check names, and canonical evidence hashes; read it back and re-hash before advancing.

`advanceAppDatabase()` uses the existing write connection and the canonical `backupsRoot`, creates/verifies the online pre-migration backup, then runs only pending migrations through target 7. Migration 7 itself requires both Phase 4 markers inside the authoritative transaction; it deletes only `lyric.source='raw'`, drops legacy URL/alternate-source tables and indexes, retains edited lyrics and all durable tables, updates the structural contract, and writes `legacy_cache_v1.cutover` in that transaction. After commit and verification, `advanceAppDatabase()` atomically updates `DatabaseHealth.schemaVersion`, the memoized `DatabaseStartupResult`, and its returned ready result to 7. The coordinator uses that Phase 4 result, rather than the earlier schema-6 snapshot, for `StorageStartupOutcome.schemaVersion`.

A direct target-7 call fails before deletion. An injected failure leaves schema 6 intact. A post-commit retry verifies schema 7/marker and does not replay. Implement the shared steady-state contract here, after migration 7 and its structural contract exist: a later process still calls `init(... targetSchemaVersion: 6)`, but before pending-migration calculation `db.ts` recognizes only an exact schema 7 plus verified `legacy_cache_v1.cutover`, reports 7, and does not ask the migration runner to downgrade. Schema 7 without valid structure/marker and every version above the known registry fail closed. After the coordinator reaches ready with typed Phase 4 repositories, record the portable typed-only acknowledgement from Task 2; source retirement remains a later-start action.

The Task 5 legacy raw fallback is isolated to the schema-6 transition. Before migration 7 can delete raw rows, switch the active lyric repository to cache-only mode and prove the typed cache smoke still passes; after the transaction commits, `src/main/worker/dbService/modules/lyric/index.ts` can never invoke the authoritative fallback. On failure before commit, restore the schema-6 fallback state; on or after a verified commit, retries remain cache-only. Migration-only raw reads stay confined to `src/main/migration/cache/rawLyrics.ts`.

Replace every durable `getDB()` use with `getAppDB()` and cache access with lifecycle-owned callbacks, then remove the alias/export. The whole-source scan must include tests so helpers do not preserve ambiguous ownership.

- [ ] **Step 4: Verify GREEN, builds, and ownership**

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/cache-cutover.test.js
node --test build-config/storage/cache-callsite.test.js
npm run build:main
npm run build:renderer
npm run test:main-bundle
rg -n '\bgetDB\b|FROM .*music_url|FROM .*music_info_other_source' src/main/worker/dbService build-config/storage-electron
```

Expected: tests/builds pass; the scan has no generic accessor or authoritative URL/alternate-source query, and `cache-callsite.test.js` proves active raw reads have no authoritative fallback outside the migration-only allowlist.

- [ ] **Step 5: Commit**

Stage exactly the files above, then:

```powershell
git commit -m "refactor: complete the guarded cache cutover"
```

### Task 11: Run the Fixture-Only Phase 4 Acceptance Matrix

**Files:**
- Create: `build-config/storage-electron/cache-phase4.integration.test.js`
- Create: `build-config/storage/cache-ownership.test.js`

**Interfaces:**
- Consumes: all Phase 4 services, markers, installed/portable layouts, and the durable fixture set.
- Produces: executable acceptance evidence; no production feature or UI.
- Guarantees: all tests remain inside the explicit worktree-local D: fixture root.

- [ ] **Step 1: Write the installed/portable durability and failure matrix**

Both new files use `createTestStorageRoot()` from `build-config/storage/helpers/test-storage-root.js`. The durable fixture contains settings, vault ciphertext, app DB rows (playlists, local state, edited lyrics, `download_list`), theme assets, User API scripts, completed downloads, partial downloads, backups, cookies, and local storage. The cache fixture contains only cache DB rows and registered Chromium cache categories.

```js
it('keeps every durable artifact across cache corruption and reset', async() => {
  const before = await snapshotDurableFixture()
  await corruptCacheOnly()
  const startup = await startFixture()
  assert.equal(startup.cache.status, 'recreated')
  await cacheManager.clearAll()
  assert.deepEqual(await snapshotDurableFixture(), before)
})

it('serves durable repositories while the cache is unavailable', async() => {
  injectCacheFailure('ENOSPC')
  const startup = await startFixture()
  assert.equal(startup.status, 'ready')
  assert.equal(startup.cache.status, 'unavailable')
  assert.deepEqual(await readPlaylistsAndEditedLyrics(), durableExpected)
})
```

Run fresh install, upgrade, skipped release, interrupted/retried portable migration, corrupt cache, valid wrong schema, WAL/SHM failure, link target, `EACCES`, `ENOSPC`, close/delete/reopen failure, and concurrent clear/write. Hash the app DB before/after every pre-cutover cache failure; use semantic snapshots across intentional schema 7.

- [ ] **Step 2: Write the whole-source ownership gate**

Scan TS/JS/Vue/SQL across renderer, main IPC, User API preload/runtime, worker exports, common/shared types, tests, and schemas. Reject:

```text
unscoped cache identity APIs
production backup-path derivation outside storagePaths.ts
os.tmpdir() in migrated producers
renderer-provided deletion targets
Phase 4 CacheManager clear-all IPC/UI wiring
cacheRoot artwork/audio producers or deletion targets
active getDB imports/exports
authoritative raw-lyric/music-url/alternate-source queries after cutover
```

- [ ] **Step 3: Run the complete fixture-only Phase 4 verification**

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
git status --short
```

Expected: every command passes; fixture path audit reports no access outside the owned root; no related Node/Electron fixture process remains.

- [ ] **Step 4: Verify every Phase 4 acceptance statement explicitly**

Record an evidence table mapping each statement below to test names/logs. Re-run any missing proof; a passing aggregate without statement-level evidence is not sufficient.

- [ ] **Step 5: Commit the acceptance fixtures**

```powershell
git add build-config/storage-electron/cache-phase4.integration.test.js build-config/storage/cache-ownership.test.js
git commit -m "test: verify cache separation cutover"
```

## Phase 4 Acceptance Gate

Do not start Phase 5 backup/export/legacy cleanup until all statements are true:

1. The exact Phase 3 marker and typed playback reader/writer evidence are verified before any `cache.db` path mutation.
2. Installed and portable roots are explicit; `sessionData` is set before session/window creation; all operational backups use canonical `StoragePaths.backupsRoot`.
3. Portable migration is locked, journaled, manifest-verified, copies only `LxDatas`, keeps the source through typed acknowledgement, and retires it only on a later verified startup.
4. Per-run cleanup cannot escape an owned direct child, and theme cancellation/save/scavenge cannot delete an external source.
5. Cache lifecycle serializes all RPC/reset work and degrades safely on malformed schema, corruption, permission, capacity, close, delete, or reopen failure while durable repositories remain available.
6. Every valid raw lyric variant copies with matching canonical hash/count; edited lyrics remain byte-identical and authoritative.
7. Legacy URL and alternate-source rows are discarded; all new reads/writes use provider-scoped identity, expiry, strict sanitization, and atomic complete-owner replacement.
8. TTL/quota/invalidation has deterministic ties, exact UTF-8 group accounting, complete-group eviction, and tested transaction/concurrency behavior.
9. Main, User API, and login sessions register/deregister correctly; a mid-clear session is cleared before use; cookies and local storage remain intact.
10. The main-only CacheManager clears only three DB artifacts plus named Chromium cache categories, never runtime session data or unowned artwork/audio roots, and publishes generation only after a fresh usable DB.
11. Settings, vault, authoritative DB/durable rows, edited lyrics, themes, User API scripts, downloads, partial downloads, backups, cookies, and local storage survive cache failure/reset byte-for-byte or by an approved semantic schema-7 snapshot.
12. Fresh installs, installed/portable upgrades, skipped releases, interruption/retry, degraded cache, and cutover all pass inside disposable D-local fixtures.
13. No generic `getDB`, unscoped cache API, authoritative legacy-cache query, production backup derivation, migrated-producer `os.tmpdir()`, renderer deletion path, artwork/audio cache target, or Phase 4 clear-all UI wiring remains.
14. Schema 7 is reached only after immutable Phase 4 typed attestation on the same open app connection; failures/retries never delete authoritative rows early or record migration 7 twice.

## Preflight Finding Ownership

| Finding | Owning tasks |
| --- | --- |
| Machine-enforced Phase 3 and Phase 5 clear-UI boundary | 0, 9, 11 |
| Canonical installed/portable `backupsRoot` | 1, 10, 11 |
| Locked portable promotion and delayed retirement | 2, 11 |
| Serialized guarded cache lifecycle and degraded mode | 4, 9, 11 |
| Atomic multi-row ownership and deterministic group accounting | 5, 6, 7 |
| Producer inventory; no unsupported artwork/audio roots | 3, 9, 11 |
| Complete session registry including `runtimeWindow.ts` | 8, 9, 11 |
| Safe external theme staging and durable promotion | 3, 11 |
| User API/shared-type call sites and active scoped alternate-source contract | 6, 11 |
| Operation gate and success-qualified cache generation | 4, 8, 9 |
| Short D-local roots and injected tiny quotas/failures | 0, 7, 11 |
| Full durable fixture, ownership, portable, and retry gate | 10, 11 |
