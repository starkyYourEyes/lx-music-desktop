# Cache Database and Runtime Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move reconstructable structured data and cache-owned files out of the authoritative profile so the complete cache can be cleared or rebuilt without touching durable user data or Electron session state.

**Architecture:** Startup computes explicit profile/cache/runtime/temp roots before creating any Electron session or window. The existing DB worker opens a second, independently versioned `cache.db` connection for raw lyrics, expiring music URLs, and alternate-source results; migration copies and verifies raw lyrics, discards untrustworthy legacy URL/source caches, switches readers, then removes old authoritative cache rows.

**Tech Stack:** Electron app/session APIs, Node.js filesystem/path APIs, TypeScript, `better-sqlite3`, Comlink, Vue renderer IPC, and `node:test`.

## Global Constraints

- This plan requires completed Phase 3 and `legacy_data_v1.cross_artifact_complete`.
- Keep `lx.data.db` authoritative and add only `<cacheRoot>/cache.db` as a disposable database.
- `cache.db` corruption may recreate only `cache.db`; authoritative DB corruption must still enter read-only recovery.
- Raw provider lyrics move to cache; edited lyrics remain in `lx.data.db` and are never cleared with cache.
- Discard legacy music URLs and alternate-source rows because they lack trustworthy age/expiry data.
- Migrate every valid raw lyric row and verify sorted content hash/count before switching readers.
- New cache keys include provider/source track identity; new writes may not use an unscoped `id` alone.
- Music URLs are bearer-like values: never log/export them and apply user-only file permissions where supported.
- Set Electron `sessionData` before any `session.fromPartition()`, BrowserWindow, or `app.whenReady()` consumer.
- `sessionData` is a mixed persistent runtime root. Never recursively delete it during cache clearing.
- Clear Chromium cache through Electron APIs for explicit cache categories only; do not clear Cookies or LocalStorage.
- Theme images and User API scripts are durable. Theme editor staging and local-artwork extraction use the per-run temp root.
- Completed and partial downloads remain outside cache ownership.
- Every recursive delete first resolves and proves containment under the exact cache/temp root; never follow symlinks outside it.
- Preserve every unrelated user change listed in the roadmap and any later concurrent edit; stage only files named by each task.

## File Structure

- Create `src/main/utils/storagePaths.ts`: installed/portable root calculation and containment helpers.
- Modify `src/main/migration/legacyUserData.js/.d.ts`: migrate the old portable layout into explicit subdirectories.
- Modify `src/main/app.ts` and `src/main/index.ts`: apply `userData` and `sessionData` before readiness/session use.
- Create `src/main/utils/tempLifecycle.ts`: per-run directory ownership and stale-run scavenging.
- Create `src/main/services/sessionRegistry.ts`: explicit Electron session registration.
- Create `src/main/worker/dbService/cacheTables.ts` and `cacheMigrate.ts`: independent cache schema/version.
- Modify `src/main/worker/dbService/db.ts`: explicit app/cache connections and cache reset lifecycle.
- Split raw/edited lyric implementations by database owner.
- Replace music URL and other-source modules with scoped cache repositories.
- Create `src/main/migration/cache/rawLyrics.ts` and `cutover.ts`.
- Create `src/main/services/cacheManager.ts`: prune, clear, reopen, and invalidation orchestration.
- Modify cache-related IPC/callers and settings UI counts.
- Add authoritative migration `0007_cache_cleanup.ts` only after reader cutover verifies.

---

### Task 1: Compute Explicit Installed and Portable Storage Roots

**Files:**
- Create: `src/main/utils/storagePaths.ts`
- Modify: `src/main/migration/legacyUserData.js`
- Modify: `src/main/migration/legacyUserData.d.ts`
- Modify: `src/main/app.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/types/app.d.ts`
- Create: `build-config/storage/storage-paths.test.js`

**Interfaces:**
- Consumes: Electron path getters, platform, executable path, environment, and project identity.
- Produces: one immutable `StoragePaths` object before app readiness.
- Guarantees: portable and installed artifacts have explicit ownership roots.

- [ ] **Step 1: Write installed, portable, ordering, and containment tests**

```js
it('builds explicit portable roots beside the executable', () => {
  assert.deepEqual(resolveStoragePaths({ platform: 'win32', executablePath: 'D:\\Player\\app.exe', portable: true }), {
    portableRoot: 'D:\\Player\\portable',
    profileRoot: 'D:\\Player\\portable\\profile',
    cacheRoot: 'D:\\Player\\portable\\cache',
    runtimeRoot: 'D:\\Player\\portable\\runtime',
    sessionDataRoot: 'D:\\Player\\portable\\runtime\\session-data',
    tempRoot: 'D:\\Player\\portable\\temp',
    backupsRoot: 'D:\\Player\\portable\\backups',
  })
})

it('sets sessionData before the first session or window operation', () => {
  initializePaths(fakeElectron)
  assert.deepEqual(calls.slice(0, 2), ['app.setPath:userData', 'app.setPath:sessionData'])
  assert.ok(calls.indexOf('app.setPath:sessionData') < calls.indexOf('session.fromPartition'))
})

it('rejects a deletion target outside its declared root', () => {
  assert.throws(() => assertContainedPath('C:\\cache-root', 'C:\\profile\\lx.data.db'))
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/storage-paths.test.js
```

Expected: FAIL because storage roots are implicit.

- [ ] **Step 3: Implement the root contract and portable migration**

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

export function resolveStoragePaths(input: StoragePathInput): Omit<StoragePaths, 'runTempRoot'>
export function initializeStoragePaths(input: StoragePathInput): StoragePaths
export function assertContainedPath(root: string, candidate: string): string
```

For installed builds, keep the current roaming `LxDatas` directory as `profileRoot`. Derive one application-local root from Electron's cache location; use separate `cache` and `runtime` children. Use the OS temp directory plus `PROJECT_IDENTITY.appId` for `tempRoot`. Keep operational backups below `<profileRoot>/backups`.

For portable builds, use `portable/{profile,cache,runtime,temp,backups}`. If the old `portable/userData/LxDatas` exists and `portable/profile` does not, reuse the existing manifest-copy/verify/atomic-promotion discipline in `legacyUserData.js`; never merge directories blindly. Preserve the old source until the new profile manifest and one startup succeed.

Call `app.setPath('userData', profileRoot)` and `app.setPath('sessionData', sessionDataRoot)` before `app.whenReady()` and any imported module can call `session.fromPartition()`. Set `global.lxDataPath=profileRoot` rather than appending `LxDatas` again for portable layout.

- [ ] **Step 4: Verify GREEN and startup build**

```powershell
node --test build-config/storage/storage-paths.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/utils/storagePaths.ts src/main/migration/legacyUserData.js src/main/migration/legacyUserData.d.ts src/main/app.ts src/main/index.ts src/main/types/app.d.ts build-config/storage/storage-paths.test.js
git commit -m "feat: separate profile cache and runtime roots"
```

### Task 2: Add Per-Run Temporary Ownership and Move Staging Files

**Files:**
- Create: `src/main/utils/tempLifecycle.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/utils/index.ts`
- Modify: `src/renderer/views/Setting/components/ThemeEditModal/index.vue`
- Modify: `src/renderer/worker/main/music.ts`
- Modify: `src/renderer/worker/main/index.ts`
- Modify: `src/renderer/worker/utils/index.ts`
- Create: `build-config/storage/temp-lifecycle.test.js`

**Interfaces:**
- Consumes: `StoragePaths.tempRoot/runTempRoot`.
- Produces: owned run directories, safe cleanup/scavenge, theme staging path, and local-artwork temp path.
- Guarantees: cleanup never follows or removes an unowned directory.

- [ ] **Step 1: Write ownership and traversal tests**

```js
it('scavenges only direct owned run children', async() => {
  await createOwnedRun(tempRoot, 'old-run', oldTimestamp)
  await createUnownedDirectory(tempRoot, 'keep-me')
  await createSymlink(path.join(tempRoot, 'linked'), profileRoot)
  const result = await scavengeRunTemps({ tempRoot, nowMs, maxAgeMs: DAY_MS })
  assert.deepEqual(result.removed, ['old-run'])
  assert.equal(await exists(path.join(tempRoot, 'keep-me')), true)
  assert.equal(await exists(profileRoot), true)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/temp-lifecycle.test.js
```

Expected: FAIL because shared temp directories are unmanaged.

- [ ] **Step 3: Implement run markers and call-site changes**

```ts
export interface RunTempHandle {
  runTempRoot: string
  createChild(name: 'theme-editor' | 'local-artwork' | 'backup-import'): Promise<string>
  cleanup(): Promise<void>
}

export function createRunTemp(input: { tempRoot: string; runId: string; startedAtMs: number }): Promise<RunTempHandle>
export function scavengeRunTemps(input: { tempRoot: string; nowMs: number; maxAgeMs: number }): Promise<TempScavengeResult>
```

Each run directory is a direct child with an exclusive `.owner.v1.json` containing run ID, PID, and start time. Before recursive removal, `lstat` the directory and marker twice, reject links, validate marker ownership, resolve containment, and remove only that owned child.

`getAllThemes()` returns `{dataPath, stagingPath}` where durable `dataPath=<profileRoot>/assets/theme-images` and staging is `<runTempRoot>/theme-editor`. Migrate old `theme_images` with copy/hash/read-back before switching. Theme save moves only the selected staged file into durable assets.

Configure the renderer main worker once with `{runTempRoot}` and write large embedded artwork below `local-artwork`; remove its direct `os.tmpdir()/PROJECT_IDENTITY.tempDirectoryName` use.

- [ ] **Step 4: Verify GREEN and builds**

```powershell
node --test build-config/storage/temp-lifecycle.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/utils/tempLifecycle.ts src/main/startup/storageCoordinator.ts src/main/utils/index.ts src/renderer/views/Setting/components/ThemeEditModal/index.vue src/renderer/worker/main/music.ts src/renderer/worker/main/index.ts src/renderer/worker/utils/index.ts build-config/storage/temp-lifecycle.test.js
git commit -m "feat: isolate per-run temporary files"
```

### Task 3: Open an Independently Versioned Cache Database

**Files:**
- Create: `src/main/worker/dbService/cacheTables.ts`
- Create: `src/main/worker/dbService/cacheMigrate.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage-electron/cache-db.test.js`

**Interfaces:**
- Consumes: `StoragePaths.cacheRoot` and current worker native binding.
- Produces: explicit app/cache connection accessors and disposable cache startup result.
- Guarantees: cache failure cannot replace or downgrade authoritative DB state.

- [ ] **Step 1: Write schema and corruption-isolation tests**

```js
it('creates cache version 1 without changing app schema version', async() => {
  await openCacheDB({ cachePath })
  assert.equal(getCacheDB().pragma('user_version', { simple: true }), 1)
  assert.equal(getSchemaVersion(getAppDB()), 6)
})

it('recreates corrupt cache and leaves authoritative bytes unchanged', async() => {
  const before = await sha256(appDbPath)
  await fs.writeFile(cachePath, 'corrupt')
  const result = await openCacheDB({ cachePath })
  assert.equal(result.status, 'recreated')
  assert.equal(await sha256(appDbPath), before)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-db.test.js
```

Expected: FAIL because the worker has one connection.

- [ ] **Step 3: Implement cache schema and lifecycle**

```sql
CREATE TABLE cache_schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  checksum TEXT NOT NULL,
  applied_at_ms INTEGER NOT NULL
);

CREATE TABLE raw_lyrics (
  provider TEXT NOT NULL,
  source_track_id TEXT NOT NULL,
  lyric_type TEXT NOT NULL CHECK(lyric_type IN ('lyric','tlyric','rlyric','lxlyric')),
  text TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  created_at_ms INTEGER NOT NULL,
  last_accessed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider, source_track_id, lyric_type)
);

CREATE TABLE music_urls (
  provider TEXT NOT NULL,
  account_scope TEXT NOT NULL DEFAULT '',
  source_track_id TEXT NOT NULL,
  quality TEXT NOT NULL,
  url TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_accessed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(provider, account_scope, source_track_id, quality)
);

CREATE TABLE other_sources (
  original_provider TEXT NOT NULL,
  original_track_id TEXT NOT NULL,
  candidate_provider TEXT NOT NULL,
  candidate_track_id TEXT NOT NULL,
  candidate_json TEXT NOT NULL CHECK(json_valid(candidate_json)),
  rank INTEGER NOT NULL CHECK(rank >= 0),
  byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
  expires_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_accessed_at_ms INTEGER NOT NULL,
  PRIMARY KEY(original_provider, original_track_id, candidate_provider, candidate_track_id)
);
```

Expose:

```ts
getAppDB(): Database.Database
getCacheDB(): Database.Database
openCacheDB(input: { cachePath: string }): Promise<{ status: 'ready' | 'created' | 'recreated'; schemaVersion: 1 }>
closeCacheDB(): void
```

App DB remains ready even when cache must be recreated. Cache uses WAL, structural validation, and user-only file mode. Do not use authoritative migration markers as the cache schema version.

- [ ] **Step 4: Verify GREEN**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-db.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/cacheTables.ts src/main/worker/dbService/cacheMigrate.ts src/main/worker/dbService/db.ts src/main/worker/dbService/index.ts src/main/startup/storageCoordinator.ts build-config/storage-electron/cache-db.test.js
git commit -m "feat: add disposable cache database"
```

### Task 4: Split Edited and Raw Lyric Ownership and Migrate Raw Rows

**Files:**
- Create: `src/main/worker/dbService/modules/lyric/raw/statements.ts`
- Create: `src/main/worker/dbService/modules/lyric/raw/repository.ts`
- Create: `src/main/worker/dbService/modules/lyric/edited/statements.ts`
- Create: `src/main/worker/dbService/modules/lyric/edited/repository.ts`
- Rewrite: `src/main/worker/dbService/modules/lyric/index.ts`
- Remove after replacement: `src/main/worker/dbService/modules/lyric/dbHelper.ts`
- Remove after replacement: `src/main/worker/dbService/modules/lyric/statements.ts`
- Create: `src/main/migration/cache/rawLyrics.ts`
- Create: `build-config/storage-electron/raw-lyric-migration.test.js`

**Interfaces:**
- Consumes: app `lyric.source='raw'|'edited'`, cache raw-lyrics table, and durable migration marker repository.
- Produces: source-scoped raw lyric cache with legacy fallback and app-owned edited lyric repository.
- Guarantees: every valid raw row survives copy/read-back before cutover.

- [ ] **Step 1: Write split-ownership and hash tests**

```js
it('copies every decoded raw row and leaves edited rows in app DB', async() => {
  const result = await migrateRawLyrics({ nowMs: 1000 })
  assert.equal(result.rows, countAppRawRows())
  assert.equal(result.sourceSha256, result.targetSha256)
  assert.equal(getCacheRaw({ provider: 'legacy', sourceTrackId: 'id' }).lyric, 'raw text')
  assert.equal(getAppEdited('id').lyric, 'edited text')
})

it('prefers exact provider and falls back to legacy only on a miss', () => {
  putRaw({ provider: 'legacy', sourceTrackId: 'same', lyric: 'old' })
  putRaw({ provider: 'tx', sourceTrackId: 'same', lyric: 'new' })
  assert.equal(getRaw({ provider: 'tx', sourceTrackId: 'same' }).lyric, 'new')
  assert.equal(getRaw({ provider: 'kw', sourceTrackId: 'same' }).lyric, 'old')
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/raw-lyric-migration.test.js
```

Expected: FAIL because raw/edited use one connection.

- [ ] **Step 3: Implement copy/verify/cutover**

Decode existing base64 text and normalize sorted tuples `(id,type,text)`. Since the old table has no provider, write `provider='legacy'`. Compute source and target SHA-256 over identical canonical tuples. Write `legacy_cache_v1.raw_lyrics` in the authoritative marker table only after count/hash read-back succeeds.

New raw API:

```ts
rawLyricGet(input: { source: string; sourceTrackId: string; nowMs: number }): LX.Music.LyricInfo
rawLyricPut(input: { source: string; sourceTrackId: string; lyrics: LX.Music.LyricInfo; nowMs: number }): void
rawLyricClear(): void
rawLyricCount(): number
```

Edited lyric API remains identity-compatible but uses `getAppDB()` exclusively. `getPlayerLyric()` fetches edited/app and raw/cache values, prefers edited display text, and returns raw info separately. New writes never use `provider='legacy'`.

- [ ] **Step 4: Verify GREEN**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/raw-lyric-migration.test.js
npm run build:main
```

Expected: PASS, including empty/invalid row rejection and migration retry.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/lyric src/main/migration/cache/rawLyrics.ts build-config/storage-electron/raw-lyric-migration.test.js
git commit -m "refactor: move raw lyrics to cache database"
```

### Task 5: Replace URL and Alternate-Source Cache APIs

**Files:**
- Rewrite: `src/main/worker/dbService/modules/music_url/`
- Rewrite: `src/main/worker/dbService/modules/music_other_source/`
- Modify: `src/main/modules/winMain/rendererEvent/music.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/core/music/online.ts`
- Modify: `src/renderer/core/music/local.ts`
- Modify: `src/renderer/core/music/utils.ts`
- Modify: cache-count controls in `src/renderer/views/Setting/components/SettingOther.vue`
- Create: `build-config/storage-electron/scoped-cache-repository.test.js`
- Create: `build-config/storage/cache-callsite.test.js`

**Interfaces:**
- Consumes: cache DB and source-scoped track identity.
- Produces: expiring URL/alternate-source APIs.
- Discards: every old `music_url` and `music_info_other_source` row rather than importing it.

- [ ] **Step 1: Write expiry, scope, and source-scan tests**

```js
it('does not return an expired or differently scoped URL', () => {
  putMusicUrl({ provider: 'tx', accountScope: 'user-a', sourceTrackId: '1', quality: '320k', url: 'TOKEN', expiresAtMs: 100 })
  assert.equal(getMusicUrl({ provider: 'tx', accountScope: 'user-a', sourceTrackId: '1', quality: '320k', nowMs: 101 }), null)
  assert.equal(getMusicUrl({ provider: 'tx', accountScope: 'user-b', sourceTrackId: '1', quality: '320k', nowMs: 50 }), null)
})

it('contains no one-argument cache identity wrappers', () => {
  const source = readCacheCallers()
  assert.doesNotMatch(source, /getRawLyric\(id\)|getMusicUrl\(id\)|getOtherSource\(id\)/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/scoped-cache-repository.test.js
node --test build-config/storage/cache-callsite.test.js
```

Expected: FAIL because current keys are only `id` and have no expiry.

- [ ] **Step 3: Implement scoped cache RPC**

```ts
musicUrlGet(input: MusicUrlKeyV1 & { nowMs: number }): string | null
musicUrlPut(input: MusicUrlKeyV1 & { url: string; providerExpiresAtMs?: number; nowMs: number }): void
musicUrlInvalidateAccount(input: { provider: string; accountScope: string }): number
musicUrlInvalidateSource(input: { provider: string }): number
musicUrlClear(): void
musicUrlCount(): number

otherSourcesGet(input: TrackIdentityV1 & { nowMs: number }): LX.Music.MusicInfoOnline[]
otherSourcesPut(input: TrackIdentityV1 & { candidates: LX.Music.MusicInfoOnline[]; nowMs: number }): void
otherSourcesClear(): void
otherSourcesCount(): number
```

For URLs, provider expiry wins; otherwise set `expiresAtMs=nowMs+15*60*1000`. Update last access only on a valid hit. Alternate sources expire after 30 days and serialize validated cloneable candidates without credentials/stream URLs.

At cutover, issue `DELETE` against old URL/source tables in the later authoritative cleanup transaction; do not copy them. Modify renderer IPC to send provider, source track ID, quality, and account scope. Update currently commented alternate-source persistence to use the typed API only if product behavior expects it; otherwise leave it disabled and remove obsolete count UI rather than maintaining dead cache data.

- [ ] **Step 4: Verify GREEN and builds**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/scoped-cache-repository.test.js
node --test build-config/storage/cache-callsite.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/music_url src/main/worker/dbService/modules/music_other_source src/main/modules/winMain/rendererEvent/music.ts src/renderer/utils/ipc.ts src/renderer/core/music src/renderer/views/Setting/components/SettingOther.vue build-config/storage-electron/scoped-cache-repository.test.js build-config/storage/cache-callsite.test.js
git commit -m "refactor: use scoped expiring cache entries"
```

### Task 6: Enforce TTL, Quota, and Account/Source Invalidation

**Files:**
- Create: `src/main/worker/dbService/modules/cacheLifecycle/prune.ts`
- Create: `src/main/worker/dbService/modules/cacheLifecycle/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Modify: account logout hooks from the credential plan.
- Modify: source-disable event handling in the relevant settings/User API module.
- Create: `build-config/storage-electron/cache-policy.test.js`

**Interfaces:**
- Consumes: cache tables, current time, and bounded batch size.
- Produces: deterministic pruning and invalidation counts.
- Guarantees: policy never deletes durable data.

- [ ] **Step 1: Write exact policy tests**

```js
it('enforces URL expiry and newest 5000 entries', () => {
  seedUrls({ expired: 2, valid: 5002 })
  const result = cachePrune({ nowMs, batchSize: 500 })
  assert.equal(result.musicUrls.expired, 2)
  assert.equal(countUrls(), 5000)
})

it('evicts raw lyrics by age then LRU until both caps pass', () => {
  seedLyrics({ bytes: 101 * MIB, tracks: 20001, oneOlderThanDays: 180 })
  cachePrune({ nowMs, batchSize: 500 })
  assert.ok(rawLyricBytes() <= 100 * MIB)
  assert.ok(rawLyricTrackCount() <= 20000)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-policy.test.js
```

Expected: FAIL because cache policies are absent.

- [ ] **Step 3: Implement fixed policies**

```ts
export const CACHE_POLICY = {
  musicUrls: { fallbackTtlMs: 15 * 60 * 1000, maxEntries: 5000 },
  rawLyrics: { maxBytes: 100 * 1024 * 1024, maxTracks: 20000, maxIdleMs: 180 * 24 * 60 * 60 * 1000 },
  otherSources: { ttlMs: 30 * 24 * 60 * 60 * 1000, maxBytes: 50 * 1024 * 1024 },
} as const

cachePrune(input: { nowMs: number; batchSize: number }): CachePruneResult
```

Delete expired rows first, then least-recently-accessed rows in bounded batches until all caps pass. Group raw lyric deletion by provider/track so one track's lyric variants evict together. Run while idle and after a write takes a category above 110% of its cap.

QQ/NetEase logout invalidates the matching account scope after credential/profile clear. A source disable invalidates that provider's URL rows. Neither action clears raw lyrics or unrelated accounts.

- [ ] **Step 4: Verify GREEN**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-policy.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/cacheLifecycle src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts src/main/modules/qqMusic/index.ts src/main/modules/netease/account.ts build-config/storage-electron/cache-policy.test.js
git commit -m "feat: enforce cache retention policies"
```

### Task 7: Orchestrate Complete Cache Clearing Without Deleting sessionData

**Files:**
- Create: `src/main/services/sessionRegistry.ts`
- Create: `src/main/services/cacheManager.ts`
- Modify: `src/main/modules/winMain/main.ts`
- Modify: `src/main/modules/winMain/rendererEvent/app.ts`
- Modify: `src/main/modules/userApi/main.ts`
- Modify: `src/main/modules/qqMusic/browserAuth.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Create: `build-config/storage/cache-clear.test.js`

**Interfaces:**
- Consumes: explicit storage paths, cache worker lifecycle, registered sessions, and cache-generation broadcaster.
- Produces: component-level `CacheClearResult`.
- Guarantees: deletion targets are an allowlist, not renderer-provided paths.

- [ ] **Step 1: Write ordered-call and preservation tests**

```js
it('clears only cache-owned paths and named Chromium categories', async() => {
  const result = await manager.clearAll()
  assert.deepEqual(calls, [
    'worker:close-cache',
    'delete:cache.db', 'delete:cache.db-wal', 'delete:cache.db-shm',
    'session:clearCache', 'session:clearStorageData:cachestorage', 'session:clearCodeCaches',
    'delete:artwork', 'delete:audio',
    'worker:open-cache', 'broadcast:cache-generation',
  ])
  assert.equal(deletedPaths.includes(sessionDataRoot), false)
  assert.equal(await exists(appDbPath), true)
  assert.equal(await exists(credentialsPath), true)
  assert.equal(await exists(editedLyricFixture), true)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/cache-clear.test.js
```

Expected: FAIL because current clear calls only one window session's `clearCache()`.

- [ ] **Step 3: Implement session registry and cache manager**

```ts
export interface CacheClearResult {
  clearedComponents: string[]
  failures: Array<{ component: string; code: string }>
  generation: number
}

export interface SessionRegistry {
  register(name: string, session: Electron.Session): () => void
  entries(): ReadonlyArray<{ name: string; session: Electron.Session }>
}

export interface CacheManager {
  clearAll(): Promise<CacheClearResult>
}
```

Register `persist:win-main` and User API sessions at creation. Login sessions with `cache:false` may register for their lifetime but are not required for persistent cache coverage. For each session call `clearCache()`, `clearStorageData({storages:['cachestorage']})`, and `clearCodeCaches({})`; never call parameterless `clearStorageData()` in the all-cache action.

Resolve and validate exactly `cache.db`, `cache.db-wal`, `cache.db-shm`, `<cacheRoot>/artwork`, and `<cacheRoot>/audio`. Close cache DB first, delete each explicit target, reopen regardless of intermediate category failures, then broadcast a monotonically increasing generation so renderer/worker memory maps clear. Return failures without broadening deletion.

- [ ] **Step 4: Verify GREEN and main build**

```powershell
node --test build-config/storage/cache-clear.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/services/sessionRegistry.ts src/main/services/cacheManager.ts src/main/modules/winMain/main.ts src/main/modules/winMain/rendererEvent/app.ts src/main/modules/userApi/main.ts src/main/modules/qqMusic/browserAuth.ts src/common/ipcNames.ts src/renderer/utils/ipc.ts build-config/storage/cache-clear.test.js
git commit -m "feat: orchestrate complete cache clearing"
```

### Task 8: Remove Cache Rows from the Authoritative Database After Cutover

**Files:**
- Create: `src/main/worker/dbService/migrations/0007_cache_cleanup.ts`
- Modify: `src/main/worker/dbService/migrations/index.ts`
- Modify: `src/main/worker/dbService/schemaContract.ts`
- Modify: `src/main/worker/dbService/tables.ts`
- Modify: every remaining existing DB module that imports `getDB()`.
- Modify: `src/main/worker/dbService/db.ts` to remove the compatibility `getDB()` alias.
- Create: `src/main/migration/cache/cutover.ts`
- Create: `build-config/storage-electron/cache-cutover.test.js`

**Interfaces:**
- Consumes: raw lyric marker/hash, cache reader/writer smoke checks, and cache schema health.
- Produces: `legacy_cache_v1.read_write_verified` followed by coordinated authoritative schema version `7` and `legacy_cache_v1.cutover`, with no reconstructable URL/source rows.
- Guarantees: cleanup occurs only after verified cache ownership switch.

- [ ] **Step 1: Write cleanup-gate and ownership tests**

```js
it('refuses authoritative cleanup before cache read/write verification', async() => {
  smoke.rawLyricRead = false
  await assert.rejects(completeCacheCutover(), /rawLyricRead/)
  assert.equal(countAppRawRows(), sourceRawCount)
})

it('keeps edited lyrics and drops only cache-owned legacy data', async() => {
  await completeCacheCutover()
  assert.equal(countAppEditedRows(), editedCount)
  assert.equal(countAppRawRows(), 0)
  assert.equal(hasTable('music_url'), false)
  assert.equal(hasTable('music_info_other_source'), false)
})

it('registering migration 7 cannot bypass the external cache gate', async() => {
  const atSix = await initAppDatabase({
    migrations: migrationsThrough7,
    targetSchemaVersion: 6,
  })
  assert.equal(atSix.schemaVersion, 6)

  const refused = await initAppDatabase({
    migrations: migrationsThrough7,
    targetSchemaVersion: 7,
  })
  assert.equal(refused.status, 'recovery')
  assert.equal(refused.reason, 'migration_failed')
  assert.equal(readSchemaVersionReadonly(), 6)
  assert.equal(countAppRawRows(), sourceRawCount)
  assert.equal(hasTable('music_url'), true)
  assert.equal(readMarker('legacy_cache_v1.read_write_verified'), null)
  assert.equal(readMarker('legacy_cache_v1.cutover'), null)
})

it('uses the same 6-then-7 sequence for a fresh profile', async() => {
  const first = await startStorageCoordinator({ profile: freshProfile, failAt: 'before-cache-smoke' })
  assert.equal(first.status, 'recovery')
  assert.equal(readSchemaVersion(freshProfile), 6)
  assert.equal(readMarker('legacy_cache_v1.read_write_verified', freshProfile), null)
  assert.equal(readMarker('legacy_cache_v1.cutover', freshProfile), null)

  const second = await startStorageCoordinator({ profile: freshProfile })
  assert.equal(second.status, 'ready')
  assert.equal(readSchemaVersion(freshProfile), 7)
  assert.ok(readMarker('legacy_cache_v1.read_write_verified', freshProfile))
  assert.ok(readMarker('legacy_cache_v1.cutover', freshProfile))
})

it('rolls migration 7 back and resumes it exactly once', async() => {
  await assert.rejects(
    completeCacheCutover({ failAt: 'inside-authoritative-cleanup' }),
    /injected failure/,
  )
  assert.equal(readSchemaVersion(), 6)
  assert.equal(countAppRawRows(), sourceRawCount)
  assert.ok(readMarker('legacy_cache_v1.read_write_verified'))
  assert.equal(readMarker('legacy_cache_v1.cutover'), null)

  await completeCacheCutover()
  await completeCacheCutover()
  assert.equal(readSchemaVersion(), 7)
  assert.equal(countAppliedMigration(7), 1)
  assert.equal(countMarker('legacy_cache_v1.cutover'), 1)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-cutover.test.js
```

Expected: FAIL because legacy tables/rows remain.

- [ ] **Step 3: Implement delayed authoritative cleanup**

Initialize the app DB with `targetSchemaVersion:6`, complete and verify the external cache copy/read/write cutover, then write `legacy_cache_v1.read_write_verified` with the cache schema version, raw-lyric marker hash, and exact typed read/write smoke-check names. Invoke the same ordered runner with `targetSchemaVersion:7` only after reading that marker back. Migration 7 itself requires both `legacy_cache_v1.raw_lyrics` and `legacy_cache_v1.read_write_verified`; a direct target-7 call without either throws before deletion and leaves schema 6 intact. It then deletes only `lyric.source='raw'`, retains edited rows, drops `music_url` and `music_info_other_source` plus their indexes, updates the structural contract, and writes `legacy_cache_v1.cutover` in the same authoritative transaction. Fresh installs and users skipping releases follow this same two-stage startup; registration of migration 7 alone never triggers early cleanup. Inject failures before cache creation, after raw-copy verification, after reader cutover, after the read/write marker, inside migration 7, and after its commit; every retry must stop at either a fully usable schema 6 state or a fully verified schema 7 state.

Change list/download/dislike/edited-lyric modules to `getAppDB()` and raw/URL/other-source modules to `getCacheDB()`. Remove `getDB()` so future ownership mistakes fail at compile time.

- [ ] **Step 4: Run the complete Phase 4 verification**

```powershell
node --test build-config/storage/storage-paths.test.js build-config/storage/temp-lifecycle.test.js build-config/storage/cache-callsite.test.js build-config/storage/cache-clear.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-*.test.js build-config/storage-electron/raw-lyric-migration.test.js build-config/storage-electron/scoped-cache-repository.test.js
npm run lint
npm run build:main
npm run build:renderer
npm run test:main-bundle
rg -n "\bgetDB\b|FROM .*music_url|FROM .*music_info_other_source" src/main/worker/dbService
git status --short
```

Expected: tests/builds pass; the ownership scan has no generic DB accessor or authoritative legacy-cache query.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/migrations/0007_cache_cleanup.ts src/main/worker/dbService/migrations/index.ts src/main/worker/dbService/schemaContract.ts src/main/worker/dbService/tables.ts src/main/worker/dbService/modules src/main/worker/dbService/db.ts src/main/migration/cache/cutover.ts build-config/storage-electron/cache-cutover.test.js
git commit -m "refactor: remove cache data from authoritative database"
```

## Phase 4 Acceptance Gate

Do not start final backup/legacy cleanup until all statements are true:

1. Installed and portable roots are explicit and `sessionData` is configured before session/window creation.
2. Per-run temp cleanup cannot escape its owned direct child.
3. Cache corruption recreates only `cache.db`.
4. Every valid raw lyric copied with matching content hash; edited lyrics remain authoritative.
5. Legacy URL and alternate-source rows were discarded, not treated as fresh cache.
6. New cache reads/writes use provider-scoped identity and expiry.
7. TTL/quota/account/source invalidation policies pass exact tests.
8. Clear-all cache uses Electron cache APIs, never recursively deletes runtime session data, and preserves every durable fixture.
9. No unqualified `getDB()` accessor remains.
10. Upgrades and fresh installs both stop at schema `6` until the external cache gate passes; a failed or repeated schema `7` run never drops rows early or records the migration twice.
