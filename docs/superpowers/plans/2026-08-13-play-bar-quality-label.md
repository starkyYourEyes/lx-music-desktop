# Play Bar Quality Label Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the trusted quality explicitly reported for the active, media-validated audio resource to the right of the song name in the bottom play bar.

**Architecture:** Keep `resolvedQuality` for playback selection, diagnostics, and cache keys, and carry optional `reportedQuality` independently from source responses or trusted download metadata. Persist that optional value in cache schema v2, propagate it through candidates and validated resources, and publish it to a session-scoped player ref only when the current resource passes `canplay`. `ModernBar.vue` reads that ref and renders a fixed, non-clickable label beside an ellipsized clickable title.

**Tech Stack:** TypeScript, JavaScript, Vue 3 Options API, Less/CSS Modules, Electron IPC, SQLite (`better-sqlite3`), Node.js `node:test`, Vue SFC compiler test harness.

## Global Constraints

- Valid display values are exactly `128k`, `192k`, `320k`, `flac`, `flac24bit`, `ape`, and `wav`; do not normalize spelling, case, or copy.
- A missing or invalid source response `type` falls back only as `resolvedQuality`; it must not produce `reportedQuality` or a label.
- Publish quality only after the current foreground resource passes `canplay`; stale, rejected, expired, cancelled, failed, or merely resolving resources must not publish it.
- Clear quality before a new foreground resolution, track replacement, retry, cancellation, stop, disposal, or terminal resolution failure can expose the previous value.
- Completed downloads use `metadata.quality`; direct local files and WebDAV resources have no reported quality.
- Cache keys and lookup order continue to use `resolvedQuality`; nullable `reported_quality` is metadata and must not affect identity, authorization, expiry, pruning, or invalidation.
- Migrate a strictly valid cache schema v1 atomically to v2, preserve all existing cache rows, assign `NULL` to migrated URL rows, and continue to reject malformed or unknown schemas without mutating them.
- The quality label is read-only, is outside the title copy target, never shrinks, uses the playlist source-label treatment, and forces the song name to truncate first.
- Do not add quality to songs, playlists, history, persisted player position, local files, WebDAV records, diagnostics, or settings.
- Preserve unrelated working-tree changes in `build-config/playback-media-validation.test.js`, `build-config/playback-source-fallback.test.js`, `build-config/song-row-components.test.js`, `build-config/storage-electron/database-recovery.test.js`, `build-config/test-utils/playback-fallback-harness.js`, `src/renderer/core/music/playback/sourceAdapter.ts`, `src/renderer/core/useApp/usePlayer/usePlayerEvent.ts`, and `src/renderer/views/List/MusicList/index.vue`.

---

## File Structure

- Modify `src/renderer/core/music/playback/sourceAdapter.ts`: validate response `type` once and return `{ url, resolvedQuality, reportedQuality? }` for built-in and custom sources.
- Modify `src/common/types/playback_source.d.ts`: add optional `reportedQuality` to the playback candidate contract.
- Modify `src/renderer/core/music/playback/session.ts`: carry source/cache reported quality into candidates and cache commits without changing resolution quality semantics.
- Modify `build-config/playback-source-fallback.test.js` and `build-config/test-utils/playback-fallback-harness.js`: cover adapter validation, candidate propagation, cache metadata, and direct-resource branches while retaining current harness changes.
- Modify `src/main/worker/dbService/cacheTables.ts`: define the final v2 schema with nullable, checked `reported_quality`.
- Modify `src/main/worker/dbService/cacheMigrate.ts`: preserve a strict v1 contract and atomically migrate it to v2.
- Modify `src/main/worker/dbService/cacheSchemaContract.ts`: verify the exact v2 columns, checks, indexes, and migration ledger; expose strict v1 recognition only to the migration gate.
- Modify `src/main/worker/dbService/cacheDb.ts` and `src/main/types/db_service.d.ts`: migrate recognized v1 artifacts before final verification and report schema version 2.
- Modify `build-config/storage-electron/cache-db.test.js` and `build-config/storage-electron/database-recovery.test.js`: cover fresh v2, v1 migration, atomic failure, and fail-closed schema handling while preserving current recovery edits.
- Modify `src/common/storage/cache.ts` and `src/common/storage/cacheValidation.ts`: define and validate URL cache values and optional put metadata.
- Modify `src/main/worker/dbService/modules/music_url/index.ts`: round-trip nullable reported quality.
- Modify `src/main/services/musicUrlAuthorization.ts`, `src/main/modules/winMain/rendererEvent/music.ts`, and `src/renderer/utils/ipc.ts`: carry cache metadata through authorization and IPC.
- Modify `src/renderer/core/music/playback/cache.ts`: store `{ url, reportedQuality }` in memory and persistence while keeping key order unchanged.
- Modify `build-config/storage-electron/scoped-cache-repository.test.js`, `build-config/storage/music-url-authorization.test.js`, and `build-config/storage/cache-callsite.test.js`: cover strict input, repository, authorization, and IPC-facing contracts.
- Modify `src/renderer/core/music/playback/coordinator.ts` and `src/renderer/core/music/playback/index.ts`: propagate optional quality through candidate, validated, preload, and direct download resources.
- Modify `src/renderer/store/player/state.ts`, `src/renderer/core/player/action.ts`, and `src/renderer/core/useApp/usePlayer/usePlayerEvent.ts`: own, clear, and publish `currentPlaybackQuality` at the correct lifecycle boundaries.
- Modify `build-config/playback-media-validation.test.js`: cover pre-`canplay`, acceptance, stale events, fallback, retry, cancellation, stop, direct download, local, and WebDAV behavior.
- Create `build-config/play-bar-quality-label.test.js`: render and inspect `ModernBar.vue` for values, DOM ownership, shared progress styles, and responsive CSS.
- Modify `src/renderer/components/layout/PlayBar/ModernBar.vue`: split the title row and render the fixed quality label.

### Task 1: Separate Resolved And Reported Source Quality

**Files:**
- Modify: `src/renderer/core/music/playback/sourceAdapter.ts`
- Modify: `src/common/types/playback_source.d.ts`
- Modify: `src/renderer/core/music/playback/session.ts`
- Modify: `build-config/playback-source-fallback.test.js`
- Modify: `build-config/test-utils/playback-fallback-harness.js`

**Interfaces:**
- Consumes: source response `{ url: unknown, type?: unknown }`, requested `LX.Quality`, cache hits from Task 3, and existing `QUALITYS`.
- Produces: `PlaybackSourceResult = { url: string, resolvedQuality: LX.Quality, reportedQuality?: LX.Quality }` and `LX.Playback.PlaybackUrlCandidate.reportedQuality?: LX.Quality`.
- Keeps: `SourceAttempt.resolvedQuality`, candidate `quality`, cache-key `quality`, lookup order, diagnostics, legacy `toOldMusicInfo(...)` calls, and error normalization.

- [ ] **Step 1: Re-read overlapping user changes before editing**

Run:

```powershell
git diff -- build-config/playback-source-fallback.test.js build-config/test-utils/playback-fallback-harness.js src/renderer/core/music/playback/sourceAdapter.ts
```

Expected: the diff includes the current legacy music-info conversion and related harness assertions. Keep those hunks intact and add the quality contract around them.

- [ ] **Step 2: Write failing adapter contract tests**

Extend `build-config/playback-source-fallback.test.js` so both built-in and custom paths cover every trusted raw value and reject all other values:

```js
for (const reportedQuality of ['128k', '192k', '320k', 'flac', 'flac24bit', 'ape', 'wav']) {
  test(`custom source preserves reported quality ${reportedQuality}`, async() => {
    const adapter = createAdapterHarness({
      request: async() => ({
        ok: true,
        value: { data: { type: reportedQuality, url: `https://audio/${reportedQuality}` } },
      }),
    })
    assert.deepEqual(await adapter.getMusicUrl({
      apiId: 'user_api_a', requestId: 'session:1', musicInfo: onlineMusic,
      quality: 'flac', signal: new AbortController().signal,
    }), {
      url: `https://audio/${reportedQuality}`,
      resolvedQuality: reportedQuality,
      reportedQuality,
    })
  })
}

test('missing and invalid custom quality use only the requested resolved quality', async() => {
  for (const data of [
    { url: 'https://audio/missing' },
    { type: 'FLAC', url: 'https://audio/case-changed' },
    { type: 'not-a-quality', url: 'https://audio/invalid' },
  ]) {
    const adapter = createAdapterHarness({ request: async() => ({ ok: true, value: { data } }) })
    assert.deepEqual(await adapter.getMusicUrl({
      apiId: 'user_api_a', requestId: 'session:1', musicInfo: onlineMusic,
      quality: '320k', signal: new AbortController().signal,
    }), { url: data.url, resolvedQuality: '320k' })
  }
})

test('built-in source validates reported type instead of casting it', async() => {
  const valid = createAdapterHarness({
    builtinRequest: async() => ({ type: 'ape', url: 'https://audio/valid' }),
  })
  assert.deepEqual(await valid.getMusicUrl({
    apiId: 'builtin', requestId: 'r1', musicInfo: onlineMusic,
    quality: 'flac', signal: new AbortController().signal,
  }), { url: 'https://audio/valid', resolvedQuality: 'ape', reportedQuality: 'ape' })

  const invalid = createAdapterHarness({
    builtinRequest: async() => ({ type: 'hires', url: 'https://audio/invalid' }),
  })
  assert.deepEqual(await invalid.getMusicUrl({
    apiId: 'builtin', requestId: 'r2', musicInfo: onlineMusic,
    quality: 'flac', signal: new AbortController().signal,
  }), { url: 'https://audio/invalid', resolvedQuality: 'flac' })
})
```

Update the existing adapter assertions that expect `{ url, quality }` to expect the new result shape. Add a local custom-source assertion: valid `type` becomes `reportedQuality`, but a missing/invalid `type` still yields `resolvedQuality: '128k'` without a reported value.

- [ ] **Step 3: Write failing session propagation tests**

Teach `createResolveSessionHarness` to let `options.request` resolve the new result shape, then add:

```js
test('source candidate carries reported quality independently from resolved quality', async() => {
  const harness = createSessionHarness({
    request: async() => ({
      url: 'https://audio/source', resolvedQuality: '320k', reportedQuality: '192k',
    }),
  })
  const candidate = await harness.nextCandidate()
  assert.equal(candidate.quality, '320k')
  assert.equal(candidate.reportedQuality, '192k')
})

test('source candidate omits unreported quality while retaining its resolved key quality', async() => {
  const harness = createSessionHarness({
    request: async() => ({ url: 'https://audio/source', resolvedQuality: '320k' }),
  })
  const candidate = await harness.nextCandidate()
  assert.equal(candidate.quality, '320k')
  assert.equal(Object.hasOwn(candidate, 'reportedQuality'), false)
})
```

The intentionally different values prove the two fields are not accidentally collapsed. Task 3 will add cache-hit and commit assertions after the cache value contract exists.

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
node --test build-config/playback-source-fallback.test.js
```

Expected: FAIL because the adapter still returns `quality`, built-in `type` is cast without validation, and candidates have no `reportedQuality`.

- [ ] **Step 5: Implement the adapter result contract**

In `sourceAdapter.ts`, export and use one result type:

```ts
export interface PlaybackSourceResult {
  url: string
  resolvedQuality: LX.Quality
  reportedQuality?: LX.Quality
}

const toQualityResult = (
  url: string,
  value: unknown,
  fallback: LX.Quality,
): PlaybackSourceResult => isPlaybackQuality(value)
  ? { url, resolvedQuality: value, reportedQuality: value }
  : { url, resolvedQuality: fallback }
```

Change `getMusicUrl` and `getLocalMusicUrl` to return `Promise<PlaybackSourceResult>`. Built-in and custom online requests pass the response's raw `type` and requested quality to `toQualityResult`. Custom local requests use `'128k'` as the `resolvedQuality` fallback but still keep a valid returned `type` as `reportedQuality`. Do not change `toOldMusicInfo`, request IDs, URL validation, abort behavior, or error mapping.

- [ ] **Step 6: Carry optional reported quality through source candidates**

Add this field to `LX.Playback.PlaybackUrlCandidate`:

```ts
reportedQuality?: LX.Quality
```

In `session.ts`, replace source result reads with:

```ts
attempt.resolvedQuality = resolved.resolvedQuality
return makeCandidate({
  origin: 'source',
  quality: resolved.resolvedQuality,
  ...(resolved.reportedQuality == null ? {} : { reportedQuality: resolved.reportedQuality }),
  url: resolved.url,
  // preserve the existing apiId/platform/cacheKey/deadline fields
})
```

Build the persistent cache key from `resolved.resolvedQuality`. Do not infer `reportedQuality` from the requested quality, selected capability, candidate metadata, file extension, or URL.

- [ ] **Step 7: Run the source/session test and verify GREEN**

Run:

```powershell
node --test build-config/playback-source-fallback.test.js
```

Expected: all tests PASS, including existing legacy music-info and fallback tests.

- [ ] **Step 8: Commit the source-quality contract**

```powershell
git add -- build-config/playback-source-fallback.test.js build-config/test-utils/playback-fallback-harness.js src/common/types/playback_source.d.ts src/renderer/core/music/playback/sourceAdapter.ts src/renderer/core/music/playback/session.ts
git commit -m "feat: preserve reported playback quality"
```

### Task 2: Migrate The Cache Schema To Version 2

**Files:**
- Modify: `src/main/worker/dbService/cacheTables.ts`
- Modify: `src/main/worker/dbService/cacheMigrate.ts`
- Modify: `src/main/worker/dbService/cacheSchemaContract.ts`
- Modify: `src/main/worker/dbService/cacheDb.ts`
- Modify: `src/main/types/db_service.d.ts`
- Modify: `build-config/storage-electron/cache-db.test.js`
- Modify: `build-config/storage-electron/database-recovery.test.js`

**Interfaces:**
- Consumes: an empty database, an exact schema-v1 database, or an exact schema-v2 database.
- Produces: `CACHE_SCHEMA_VERSION = 2`, a final `music_urls.reported_quality TEXT NULL` column, `inspectCacheSchema(db): CacheSchemaInspection`, `migrateCacheSchemaV1ToV2(db, appliedAtMs, verifyFinal, hooks): void`, and `CacheOpenResult.schemaVersion: 2 | null`.
- Migration guarantee: v1 recognition happens against immutable v1 table SQL, columns, indexes, checks, and ledger before any write; the v1-to-v2 transaction either commits the complete v2 schema and ledger or leaves v1 unchanged.

- [ ] **Step 1: Re-read overlapping database recovery changes**

Run:

```powershell
git diff -- build-config/storage-electron/database-recovery.test.js
```

Expected: user recovery-test edits are visible. Preserve them and update only schema-version expectations or fixtures required by v2.

- [ ] **Step 2: Add failing fresh-v2 and v1-migration tests**

In `build-config/storage-electron/cache-db.test.js`, preserve the exact current v1 schema as a test fixture before changing `CACHE_SCHEMA_SOURCE`. Add helpers that create a v1 artifact with one row in every cache table. Assert:

```js
it('creates schema version 2 with nullable checked reported quality', async() => {
  const { cacheRoot } = await createAppFixture()
  const service = createCacheService({ now: () => 1234 })
  assert.deepEqual(await service.openCacheDatabase(), {
    status: 'created', schemaVersion: 2, diagnostic: null,
  })
  const db = new Database(path.join(cacheRoot, 'cache.db'), { readonly: true })
  const column = db.pragma('table_info("music_urls")').find(row => row.name == 'reported_quality')
  assert.deepEqual({ type: column.type, notnull: column.notnull }, { type: 'TEXT', notnull: 0 })
  assert.throws(() => db.prepare(`INSERT INTO music_urls(
    provider, account_scope, source_track_id, quality, url, reported_quality,
    expires_at_ms, created_at_ms, last_accessed_at_ms
  ) VALUES ('tx','profile-v1:uin:1','x','320k','https://audio','hires',10,1,1)`).run())
  db.close()
})

it('atomically migrates exact schema v1 rows to v2 with null reported quality', async() => {
  const { cacheRoot } = await createAppFixture()
  createExactV1Cache(path.join(cacheRoot, 'cache.db'), { withRows: true })
  const service = createCacheService({ now: () => 5678 })
  assert.deepEqual(await service.openCacheDatabase(), {
    status: 'ready', schemaVersion: 2, diagnostic: null,
  })
  const db = new Database(path.join(cacheRoot, 'cache.db'), { readonly: true })
  assert.equal(db.pragma('user_version', { simple: true }), 2)
  assert.deepEqual(db.prepare(`SELECT url, reported_quality AS reportedQuality FROM music_urls`).get(), {
    url: 'https://media.invalid/legacy', reportedQuality: null,
  })
  assert.equal(db.prepare('SELECT count(*) AS count FROM raw_lyrics').get().count, 1)
  assert.equal(db.prepare('SELECT count(*) AS count FROM other_sources').get().count, 1)
  assert.deepEqual(db.prepare(`SELECT version, name FROM cache_schema_migrations ORDER BY version`).all(), [
    { version: 1, name: 'cache_schema_v1' },
    { version: 2, name: 'cache_schema_v2_reported_quality' },
  ])
  db.close()
})
```

Use the seven-value SQL check:

```sql
reported_quality IS NULL OR reported_quality IN ('128k','192k','320k','flac','flac24bit','ape','wav')
```

- [ ] **Step 3: Add failing atomicity and fail-closed tests**

Add tests that (a) inject a failure after `music_urls_v2` is populated but before the migration transaction ends and then verify the original v1 fingerprint and rows are unchanged, and (b) mutate each of v1's ledger checksum, URL column definition, index definition, check constraint, and `user_version` and verify opening returns `cache_schema_invalid` without changing the artifact fingerprint.

Expose a test-only hook in the migration function instead of patching SQLite globally:

```ts
export interface CacheMigrationHooks {
  beforeCommitV2?: () => void
}

export const migrateCacheSchemaV1ToV2 = (
  db: Database.Database,
  appliedAtMs: number,
  verifyFinal: (db: Database.Database) => boolean,
  hooks: CacheMigrationHooks = {},
): void => { /* implementation */ }
```

The atomicity test passes `beforeCommitV2() { throw new Error('injected migration failure') }` and asserts `user_version` remains 1, the v1 ledger remains one row, no temporary table survives, and the original URL is readable.

- [ ] **Step 4: Run cache database tests and verify RED**

Run:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-name-pattern="schema version 2|migrates exact schema v1|migration failure|malformed schema v1" build-config/storage-electron/cache-db.test.js
```

Expected: FAIL because only schema v1 is accepted and no `reported_quality` column or migration path exists.

- [ ] **Step 5: Define immutable v1 and final v2 schema sources**

In `cacheTables.ts`, keep the current schema text byte-for-byte as `CACHE_SCHEMA_V1_SOURCE`. Define `CACHE_SCHEMA_SOURCE` as the v2 fresh schema by adding this nullable column after `url`:

```sql
reported_quality TEXT CHECK(
  reported_quality IS NULL OR
  reported_quality IN ('128k','192k','320k','flac','flac24bit','ape','wav')
),
```

Define these constants in `cacheMigrate.ts` so old and final contracts cannot accidentally share an identity:

```ts
export const CACHE_SCHEMA_V1_VERSION = 1 as const
export const CACHE_SCHEMA_VERSION = 2 as const
export const CACHE_MIGRATION_V1_NAME = 'cache_schema_v1' as const
export const CACHE_MIGRATION_V1_CHECKSUM = createHash('sha256')
  .update(CACHE_SCHEMA_V1_SOURCE).digest('hex')
export const CACHE_MIGRATION_NAME = 'cache_schema_v2_reported_quality' as const
export const CACHE_MIGRATION_CHECKSUM = createHash('sha256')
  .update(CACHE_SCHEMA_V2_MIGRATION_SOURCE).digest('hex')
```

Define deterministic `CACHE_SCHEMA_V2_MIGRATION_SOURCE` before the checksum. It creates `music_urls_v2`, copies every old row with `NULL`, drops the old table, renames the replacement, recreates the two URL indexes, inserts the v2 ledger row, and sets `user_version = 2`. A fresh v2 bootstrap executes `CACHE_SCHEMA_SOURCE` and inserts both immutable ledger entries, using the same names and checksums as a migrated database. Do not use a bare `ALTER TABLE ADD COLUMN`: rebuilding the table makes the final table SQL identical for fresh and migrated databases, which the strict schema contract already compares.

- [ ] **Step 6: Implement strict recognition and atomic migration**

Refactor `cacheSchemaContract.ts` so internal contract construction can verify either exact source without weakening final verification:

```ts
export const verifyCacheSchemaV1 = (db: Database.Database): CacheSchemaVerification =>
  verifyCacheSchemaVersion(db, v1Contract)

export const verifyCacheSchema = (db: Database.Database): CacheSchemaVerification =>
  verifyCacheSchemaVersion(db, v2Contract)

export type CacheSchemaInspection =
  | { ok: true, version: 1 | 2 }
  | { ok: false, diagnostic: CacheSchemaDiagnostic }

export const inspectCacheSchema = (db: Database.Database): CacheSchemaInspection => {
  const version = db.pragma('user_version', { simple: true })
  if (version !== 1 && version !== 2) return { ok: false, diagnostic: 'cache_schema_invalid' }
  const verification = version == 1 ? verifyCacheSchemaV1(db) : verifyCacheSchema(db)
  return verification.ok ? { ok: true, version } : verification
}
```

The v2 column contract includes `['reported_quality', 'TEXT', false, 0]`, the v2 checks include the exact seven-value nullable expression, and the v2 ledger requires both immutable entries with their SHA-256 checksums. Keep index keys, collations, foreign keys, and every other table contract unchanged.

In `cacheMigrate.ts`, compute checksums from the immutable v1 full schema and the deterministic v2 migration source. Keep final schema inspection in `cacheSchemaContract.ts`; passing `verifyFinal` avoids a module cycle because that contract already imports the migration constants. Then implement:

```ts
export const migrateCacheSchemaV1ToV2 = (db, appliedAtMs, verifyFinal, hooks = {}) => {
  assertTimestamp(appliedAtMs)
  db.transaction(() => {
    if (db.pragma('user_version', { simple: true }) != 1) throw new Error('cache_schema_invalid')
    db.exec(CACHE_SCHEMA_V2_MIGRATION_SOURCE)
    hooks.beforeCommitV2?.()
    if (!verifyFinal(db)) throw new Error('cache_schema_invalid')
  }).immediate()
}
```

`bootstrapCacheSchema` remains the empty-database entry point but now creates final v2 and both ledger rows. The caller, not the migrator, must strictly recognize v1 before invoking migration.

If verification relies on `foreign_key_check`, keep foreign keys enabled during verification and manage the table rebuild in the supported SQLite order. Never accept a v1 database based only on `user_version` or the ledger.

- [ ] **Step 7: Integrate migration into the guarded open path**

Update `cacheDb.ts` so its immutable in-memory preflight calls `inspectCacheSchema` and returns the recognized version, rejecting everything else before opening the real artifact. Carry that recognized version into the guarded real-open path; after ownership is revalidated, re-run the matching exact verifier against the real connection. For recognized v1 call `migrateCacheSchemaV1ToV2(db, now(), candidate => verifyCacheSchema(candidate).ok)`, verify final v2, then enable WAL. For recognized v2, verify final v2 without writing. Empty artifacts still call `bootstrapCacheSchema`, then verify v2. Update all successful `CacheOpenResult` values and the ambient DB-service type to `schemaVersion: 2 | null`.

Do not migrate the temporary in-memory preflight copy and assume success; the real migration must run only after all existing target/identity checks pass. Migration errors keep the lifecycle unavailable and retain the artifact for diagnosis, matching current fail-closed behavior.

- [ ] **Step 8: Run cache and recovery tests and verify GREEN**

Run:

```powershell
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-db.test.js build-config/storage-electron/database-recovery.test.js
```

Expected: all tests PASS; fresh and migrated databases report v2, legacy URLs survive with null metadata, injected migration failure rolls back, and malformed schemas remain unavailable.

- [ ] **Step 9: Commit the schema migration**

```powershell
git add -- build-config/storage-electron/cache-db.test.js build-config/storage-electron/database-recovery.test.js src/main/types/db_service.d.ts src/main/worker/dbService/cacheTables.ts src/main/worker/dbService/cacheMigrate.ts src/main/worker/dbService/cacheSchemaContract.ts src/main/worker/dbService/cacheDb.ts
git commit -m "feat: migrate music URL cache quality metadata"
```

### Task 3: Round-Trip Reported Quality Through Cache And IPC

**Files:**
- Modify: `src/common/storage/cache.ts`
- Modify: `src/common/storage/cacheValidation.ts`
- Modify: `src/main/worker/dbService/modules/music_url/index.ts`
- Modify: `src/main/services/musicUrlAuthorization.ts`
- Modify: `src/main/modules/winMain/rendererEvent/music.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/core/music/playback/cache.ts`
- Modify: `src/renderer/core/music/playback/session.ts`
- Modify: `build-config/storage-electron/scoped-cache-repository.test.js`
- Modify: `build-config/storage/music-url-authorization.test.js`
- Modify: `build-config/storage/cache-callsite.test.js`
- Modify: `build-config/playback-source-fallback.test.js`
- Modify: `build-config/test-utils/playback-fallback-harness.js`

**Interfaces:**
- Consumes: Task 1 candidate `reportedQuality?: LX.Quality` and Task 2 nullable `music_urls.reported_quality`.
- Produces: `MusicUrlCacheValueV1 = { url: string, reportedQuality: LX.Quality | null }`, put inputs with optional `reportedQuality?: LX.Quality`, `PlaybackCacheHit.reportedQuality?: LX.Quality`, and `PlaybackUrlCache.commit(key, url, reportedQuality?)`.
- Compatibility: `getMusicUrlByKey(key)` continues returning only the URL string for legacy callers; only the authorized structured path exposes metadata.

- [ ] **Step 1: Write failing validation and repository tests**

In `scoped-cache-repository.test.js`, extend the URL repository cases:

```js
it('round-trips nullable reported quality independently from key quality', async() => {
  await createFixture()
  const put = repositoryFunction(URL_MODULE, 'musicUrlPut')
  const get = repositoryFunction(URL_MODULE, 'musicUrlGet')
  const base = urlKey('profile-v1:uin:10001', 1)

  await put({ ...base, url: 'https://media.invalid/reported', reportedQuality: '192k' })
  assert.deepEqual(await get({ ...base, nowMs: 2 }), {
    status: 'hit',
    value: { url: 'https://media.invalid/reported', reportedQuality: '192k' },
  })

  await put({ ...base, sourceTrackId: 'missing', url: 'https://media.invalid/missing' })
  assert.deepEqual((await get({ ...base, sourceTrackId: 'missing', nowMs: 2 })).value, {
    url: 'https://media.invalid/missing', reportedQuality: null,
  })
})
```

Add exact-shape validation assertions that every valid value is accepted, an omitted property becomes SQL `NULL`, and explicit `undefined`, `null`, `FLAC`, `hires`, numbers, inherited properties, accessors, and unknown properties are rejected for put input. `reportedQuality` is optional on input, not nullable; null exists only in stored/read values.

- [ ] **Step 2: Write failing authorization and call-site tests**

In `music-url-authorization.test.js`, make the worker return `{ status: 'hit', value: { url, reportedQuality } }` and assert `service.read(...)` preserves the object. Assert `service.write(...)` forwards optional `reportedQuality` unchanged and does not alter provider, account scope, source track ID, or key quality.

In `cache-callsite.test.js`, update the main handler/worker method signatures and add an assertion that the renderer authorized get result is structured while `getMusicUrlByKey` unwraps `.url`. Keep stale-authorization behavior: structured get returns `null`; legacy get returns `''`.

- [ ] **Step 3: Write failing playback cache tests**

Add to `playback-source-fallback.test.js`:

```js
test('playback cache preserves reported metadata without changing lookup order', async() => {
  const reads = []
  const cache = createCacheHarness({
    read: async key => {
      reads.push(key.quality)
      return key.quality == '320k'
        ? { url: 'https://cache/320', reportedQuality: '192k' }
        : null
    },
  })
  const hit = await cache.lookup(musicUrlKey(onlineMusic, 'flac'))
  assert.deepEqual(reads, ['flac', '320k'])
  assert.equal(hit.quality, '320k')
  assert.equal(hit.reportedQuality, '192k')
})

test('accepted source candidate commits its optional reported quality', async() => {
  const harness = createSessionHarness({
    request: async() => ({
      url: 'https://source/value', resolvedQuality: '320k', reportedQuality: '192k',
    }),
  })
  const candidate = await harness.nextCandidate()
  assert.equal(harness.accept(candidate.candidateId), 'accepted')
  await harness.flush()
  assert.deepEqual(harness.cacheCommits[0], [candidate.cacheKey, candidate.url, '192k'])
})

test('legacy cache hit carries no reported quality', async() => {
  const harness = createSessionHarness({
    cachedValue: { url: 'https://cache/legacy', reportedQuality: null },
  })
  const candidate = await harness.nextCandidate()
  assert.equal(candidate.origin, 'cache')
  assert.equal(Object.hasOwn(candidate, 'reportedQuality'), false)
})
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test build-config/storage/music-url-authorization.test.js build-config/storage/cache-callsite.test.js build-config/playback-source-fallback.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/scoped-cache-repository.test.js
```

Expected: FAIL because reads still return strings, writes do not accept metadata, and playback memory stores only URLs.

- [ ] **Step 5: Define and validate cache transport values**

In `src/common/storage/cache.ts` add:

```ts
export interface MusicUrlCacheValueV1 {
  url: string
  reportedQuality: LX.Quality | null
}

export interface AuthorizedMusicUrlPutInputV1 extends AuthorizedMusicUrlGetInputV1 {
  url: string
  reportedQuality?: LX.Quality
  providerExpiresAtMs?: number
}
```

Add the same optional field to `MusicUrlPutInputV1`. In `cacheValidation.ts`, export or reuse one `isMusicUrlQuality` guard backed by the seven exact values. Allow `reportedQuality` as an optional own data property only, reject explicit null/undefined, and include it in parsed output only when present and valid.

- [ ] **Step 6: Return structured repository values**

Update `music_url/index.ts` so `musicUrlGetSync` selects and validates:

```ts
type MusicUrlRow = {
  url: string
  reportedQuality: LX.Quality | null
  expiresAtMs: number
}

return { url: row.url, reportedQuality: row.reportedQuality }
```

The SQL aliases `reported_quality AS reportedQuality`. Reject any non-null value outside the seven-value set even though the database check also prevents it. Update `INSERT ... ON CONFLICT` so `reported_quality` is written and replaced; omission binds `null`. Keep TTL, touch, pruning, deletion, and key predicates unchanged.

- [ ] **Step 7: Carry the value through authorization and IPC**

Change `MusicUrlAuthorizationService.read`, its worker, the main IPC handler type, and renderer invocation to `CacheReadResultV1<MusicUrlCacheValueV1>`. Forward `reportedQuality` in authorization writes.

Make the renderer authorized helper explicit:

```ts
export const getMusicUrl = async(
  key: AuthorizedMusicUrlKeyV1,
): Promise<MusicUrlCacheValueV1 | null> => {
  // return hit.value, null on miss/unavailable/stale authorization
}
```

Use a structured overload for playback persistence:

```ts
export function saveMusicUrl(
  key: AuthorizedMusicUrlKeyV1,
  value: MusicUrlCacheValueV1,
  providerExpiresAtMs?: number,
): Promise<void>
```

Keep the legacy `(musicInfo, quality, url)` overload. `getMusicUrlByKey` unwraps `value?.url ?? ''`, so lyric/download legacy callers do not receive a new shape.

- [ ] **Step 8: Store metadata in renderer memory and session candidates**

In `playback/cache.ts`, change the memory map to `Map<string, MusicUrlCacheValueV1>` and defensively create new objects when reading or returning them. Define:

```ts
export interface PlaybackCacheHit {
  key: AuthorizedMusicUrlKeyV1
  quality: LX.Quality
  url: string
  reportedQuality?: LX.Quality
  provisional: boolean
}

commit: (key, url, reportedQuality?) => Promise<void>
```

Convert persisted `null` to an omitted candidate property. Memory and persistent hits must behave identically. Commit memory before awaiting persistence as today, call `save(key, { url, reportedQuality: reportedQuality ?? null })`, and retain generation/tombstone/revision behavior.

In `session.ts`, add cache-hit reported quality to the candidate and call:

```ts
options.cache.commit(candidate.cacheKey, candidate.url, candidate.reportedQuality)
```

Cache persistence failure remains non-blocking and must not strip the in-memory candidate metadata.

- [ ] **Step 9: Run cache, IPC, and playback tests and verify GREEN**

Run:

```powershell
node --test build-config/storage/music-url-authorization.test.js build-config/storage/cache-callsite.test.js build-config/playback-source-fallback.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/scoped-cache-repository.test.js
```

Expected: all tests PASS; nullable metadata round-trips, lookup order is unchanged, old rows yield no reported value, and cache failure behavior remains unchanged.

- [ ] **Step 10: Commit cache metadata flow**

```powershell
git add -- build-config/playback-source-fallback.test.js build-config/test-utils/playback-fallback-harness.js build-config/storage/cache-callsite.test.js build-config/storage/music-url-authorization.test.js build-config/storage-electron/scoped-cache-repository.test.js src/common/storage/cache.ts src/common/storage/cacheValidation.ts src/main/modules/winMain/rendererEvent/music.ts src/main/services/musicUrlAuthorization.ts src/main/worker/dbService/modules/music_url/index.ts src/renderer/core/music/playback/cache.ts src/renderer/core/music/playback/session.ts src/renderer/utils/ipc.ts
git commit -m "feat: round trip playback quality cache metadata"
```

### Task 4: Publish Quality Only For The Current Validated Resource

**Files:**
- Modify: `src/renderer/core/music/playback/coordinator.ts`
- Modify: `src/renderer/core/music/playback/index.ts`
- Modify: `src/renderer/store/player/state.ts`
- Modify: `src/renderer/core/player/action.ts`
- Modify: `src/renderer/core/useApp/usePlayer/usePlayerEvent.ts`
- Modify: `build-config/playback-media-validation.test.js`
- Modify: `build-config/playback-source-fallback.test.js`
- Modify: `build-config/test-utils/playback-fallback-harness.js`

**Interfaces:**
- Consumes: Task 1/3 `reportedQuality?: LX.Quality`, accepted resources from the coordinator, and trusted `LX.Download.ListItem.metadata.quality`.
- Produces: optional `reportedQuality` on direct, candidate, and validated resources, plus `currentPlaybackQuality: Ref<LX.Quality | null>`.
- Lifecycle API additions: action-controller dependency `setPlaybackQuality(value: LX.Quality | null): void`; media-handler dependency with the same signature.

- [ ] **Step 1: Re-read overlapping media and harness changes**

Run:

```powershell
git diff -- build-config/playback-media-validation.test.js build-config/test-utils/playback-fallback-harness.js src/renderer/core/useApp/usePlayer/usePlayerEvent.ts
```

Expected: the accepted-candidate `playerLoadeddata()` replay and its tests are present. Preserve the ordering `loadeddata` then `canplay`; quality publication is added without removing that replay.

- [ ] **Step 2: Write failing direct-resource contract tests**

In `playback-source-fallback.test.js`, extend `createMusicFacadeHarness` assertions:

```js
test('downloaded resource carries trusted download metadata quality', async() => {
  const harness = createMusicFacadeHarness()
  const result = await harness.createPlaybackRequest(downloadedMusic, { reason: 'initial' })
  assert.equal(result.kind, 'direct')
  assert.equal(result.resource.reportedQuality, downloadedMusic.metadata.quality)
})

test('direct local and WebDAV resources omit reported quality', async() => {
  const harness = createMusicFacadeHarness()
  for (const info of [localMusic, webdavMusic]) {
    const result = await harness.createPlaybackRequest(info, { reason: 'initial' })
    assert.equal(result.kind, 'direct')
    assert.equal(Object.hasOwn(result.resource, 'reportedQuality'), false)
  }
})
```

- [ ] **Step 3: Write failing `canplay` publication tests**

Extend `createPlayerHarness` with `let playbackQuality = null`, pass `setPlaybackQuality: value => { playbackQuality = value }` to both production factories, and expose `currentPlaybackQuality()`.

Add focused tests:

```js
test('candidate quality stays hidden until current canplay accepts it', async() => {
  const harness = createPlayerHarness({ sourceReportedQualities: ['flac'] })
  const candidate = await harness.bindCandidate('https://audio/current')
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitLoadeddata(candidate)
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(candidate)
  assert.equal(harness.currentPlaybackQuality(), 'flac')
})

test('fallback rejection never publishes failed quality', async() => {
  const harness = createPlayerHarness({
    sourceUrls: ['https://audio/bad', 'https://audio/good'],
    sourceReportedQualities: ['flac24bit', '192k'],
  })
  const failed = await harness.bindCandidate('https://audio/bad')
  harness.emitError(failed)
  assert.equal(harness.currentPlaybackQuality(), null)
  const accepted = await harness.waitForBoundCandidate('https://audio/good')
  harness.emitCanplay(accepted)
  assert.equal(harness.currentPlaybackQuality(), '192k')
})

test('replacement clears quality and stale canplay cannot restore it', async() => {
  const harness = createPlayerHarness({ sourceReportedQualities: ['320k', 'ape'] })
  const oldEvent = await harness.bindCandidate('https://audio/old')
  harness.emitCanplay(oldEvent)
  assert.equal(harness.currentPlaybackQuality(), '320k')
  const replacing = harness.setMusicUrl(songB, { reason: 'initial' })
  assert.equal(harness.currentPlaybackQuality(), null)
  harness.emitCanplay(oldEvent)
  assert.equal(harness.currentPlaybackQuality(), null)
  await replacing
})
```

Also add individual assertions for `postCommitError` retry, terminal failure, `action.cancel('stop')`, action disposal, downloaded direct `canplay`, direct local `canplay`, WebDAV `canplay`, and promoted preloads. For a promoted preload, assert preload validation alone leaves the value null and real-player `canplay` publishes it.

- [ ] **Step 4: Run playback tests and verify RED**

Run:

```powershell
npm run test:playback-fallback
```

Expected: FAIL because resources and player state do not carry or publish reported quality.

- [ ] **Step 5: Propagate quality through coordinator resources**

Add `reportedQuality?: LX.Quality` to `DirectPlaybackResource`, `CandidatePlaybackResource`, and `ValidatedPlaybackResource`. Copy it in both transformations:

```ts
...(candidate.reportedQuality == null ? {} : { reportedQuality: candidate.reportedQuality })
```

and:

```ts
...(resource.reportedQuality == null ? {} : { reportedQuality: resource.reportedQuality })
```

Do not derive it from `resource.quality`. This ensures source, cache, foreground, preload, and validated paths all preserve the distinction.

- [ ] **Step 6: Attach quality only to downloaded direct resources**

In `createPlaybackMusicFacade`, change only the successful downloaded-file branch:

```ts
resource: {
  kind: 'direct',
  songIdentity,
  url: deps.encodePath(path),
  reportedQuality: musicInfo.metadata.quality,
}
```

Leave WebDAV, successful local file, and local-source fallback branches without inferred direct metadata.

- [ ] **Step 7: Add session-scoped player state and clearing boundaries**

In `src/renderer/store/player/state.ts` add:

```ts
export const currentPlaybackQuality = ref<LX.Quality | null>(null)
```

Inject `setPlaybackQuality` into `createPlaybackActionController`. Call `setPlaybackQuality(null)` synchronously in the shared `clearActiveResource()` and at the start of every `setMusicUrl` before awaiting `startForeground`. Use the shared clear path for cancel and dispose. Also clear in `fail(...)` before surfacing a current terminal failure. Initialize the production controller with:

```ts
setPlaybackQuality: value => { currentPlaybackQuality.value = value }
```

This ref is not attached to `musicInfo`, `playMusicInfo`, persisted state, or `window.lxData`.

- [ ] **Step 8: Publish only after current-resource acceptance**

Inject the same setter into `createPlayerMediaEventHandlers`. In `error`, clear with `deps.setPlaybackQuality(null)` immediately after the current-resource identity gate and before candidate fallback or legacy error events; this also covers a validated/direct media error when retry is disabled. In `canplay`, keep the current event identity gate and candidate acceptance/`replaceResourceContext` gate first. Only after `acceptedResource` is final, publish:

```ts
deps.setLoadedMusicIdentity(acceptedResource.songIdentity)
deps.setPlaybackQuality(acceptedResource.reportedQuality ?? null)
deps.appEvent.playerCanplay()
```

Do not publish in `loadstart`, `loadeddata`, `waiting`, source resolution, resource binding, preload validation, candidate errors, or coordinator callbacks. Preserve the existing accepted-candidate `playerLoadeddata()` replay before `playerCanplay()`.

- [ ] **Step 9: Run playback tests and verify GREEN**

Run:

```powershell
npm run test:playback-fallback
```

Expected: all tests PASS. The old value clears immediately on replacement/retry/stop, only accepted current `canplay` publishes, stale events are inert, download metadata appears, and local/WebDAV remain empty.

- [ ] **Step 10: Commit validated playback state**

```powershell
git add -- build-config/playback-media-validation.test.js build-config/playback-source-fallback.test.js build-config/test-utils/playback-fallback-harness.js src/renderer/core/music/playback/coordinator.ts src/renderer/core/music/playback/index.ts src/renderer/core/player/action.ts src/renderer/core/useApp/usePlayer/usePlayerEvent.ts src/renderer/store/player/state.ts
git commit -m "feat: publish validated playback quality"
```

### Task 5: Render The Quality Label In The Play Bar

**Files:**
- Create: `build-config/play-bar-quality-label.test.js`
- Modify: `src/renderer/components/layout/PlayBar/ModernBar.vue`

**Interfaces:**
- Consumes: Task 4 `currentPlaybackQuality: Ref<LX.Quality | null>`.
- Produces: `.titleRow`, `.title`, and `.quality` siblings where only `.title` owns the copy click handler.
- Visual contract: primary color, `font-size: .8em`, `opacity: .75`, light left/right padding, no background/border/radius, `flex: none` on quality, and `min-width: 0`/ellipsis on title.

- [ ] **Step 1: Create a failing play-bar SFC harness**

Create `build-config/play-bar-quality-label.test.js` using `loadVueSfc`, Vue SSR, `@vue/compiler-sfc`, Less, and PostCSS. Mock all `ModernBar.vue` imports and register empty child components. Return mutable Vue refs for `musicInfo`, `currentPlaybackQuality`, `progressStyle`, and clipboard calls.

Use these core assertions:

```js
const qualities = ['128k', '192k', '320k', 'flac', 'flac24bit', 'ape', 'wav']

for (const quality of qualities) {
  test(`play bar renders raw quality ${quality}`, async() => {
    const { html } = await renderPlayBar({ quality, progressStyle: 'full' })
    assert.match(html, new RegExp(`class="quality"[^>]*>${quality}</span>`))
  })
}

test('play bar hides an empty quality and all progress styles share ModernBar markup', async() => {
  const empty = await renderPlayBar({ quality: null, progressStyle: 'full' })
  assert.doesNotMatch(empty.html, /class="quality"/)
  for (const progressStyle of ['full', 'middle', 'mini']) {
    const { html } = await renderPlayBar({ quality: 'flac', progressStyle })
    assert.match(html, /class="titleRow"/)
    assert.match(html, /class="quality"[^>]*>flac</)
  }
})
```

Mount once with a custom renderer or inspect the compiled VNode tree to assert the title and quality are siblings, the title has `onClick`, and the quality has no `onClick`. Trigger title click and assert the clipboard receives only the song name; triggering the quality node must do nothing.

- [ ] **Step 2: Add failing compiled-style assertions**

Compile the CSS Modules Less block using the same alias file-manager pattern as `song-row-components.test.js`. Resolve module selectors and assert:

```js
assertDeclarations(stylesheet, `.${modules.titleRow}`, {
  display: 'flex', 'align-items': 'baseline', width: '100%', 'min-width': '0',
})
assertDeclarations(stylesheet, `.${modules.title}`, {
  flex: '1 1 auto', 'min-width': '0', overflow: 'hidden',
  'text-overflow': 'ellipsis', 'white-space': 'nowrap',
})
assertDeclarations(stylesheet, `.${modules.quality}`, {
  flex: 'none', color: 'var(--color-primary)', 'font-size': '.8em', opacity: '.75',
})
```

Also assert `.quality` has light inline padding and has no `background`, `background-color`, `border`, or `border-radius` declaration. Assert no media query hides `.quality`, and no rule changes the existing player height.

- [ ] **Step 3: Run the play-bar test and verify RED**

Run:

```powershell
node --test build-config/play-bar-quality-label.test.js
```

Expected: FAIL because `ModernBar.vue` has a single clickable title element and no quality label or layout rules.

- [ ] **Step 4: Implement title and label siblings**

Import `currentPlaybackQuality` from the player state and expose it from `setup()`. Replace the title block with:

```vue
<div :class="$style.titleRow">
  <div
    :class="$style.title"
    :aria-label="musicInfo.name + $t('copy_tip')"
    @click="handleCopy(musicInfo.name)"
  >
    {{ musicInfo.name || 'LX Music' }}
  </div>
  <span v-if="currentPlaybackQuality" :class="$style.quality">
    {{ currentPlaybackQuality }}
  </span>
</div>
```

The `span` has no click handler, title, tooltip, translation, or accessibility role because it is passive metadata.

- [ ] **Step 5: Implement the compact source-label styling**

Keep `.infoContent` height and singer row unchanged. Add:

```less
.titleRow {
  display: flex;
  align-items: baseline;
  width: 100%;
  min-width: 0;
}

.title {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 14px;
  color: var(--color-font);
  .mixin-ellipsis-1();
  cursor: default;
}

.quality {
  flex: none;
  padding: 0 5px;
  color: var(--color-primary);
  font-size: .8em;
  opacity: .75;
  white-space: nowrap;
}
```

Remove `max-width: 100%` from `.title` if it prevents flex shrinkage. Do not add a pill background, rounded border, fixed label width, transition, hover state, or viewport-scaled font size.

- [ ] **Step 6: Run the play-bar test and verify GREEN**

Run:

```powershell
node --test build-config/play-bar-quality-label.test.js
```

Expected: all tests PASS for all seven values, empty state, click ownership, the three progress styles, and the flex/ellipsis contract.

- [ ] **Step 7: Commit the play-bar UI**

```powershell
git add -- build-config/play-bar-quality-label.test.js src/renderer/components/layout/PlayBar/ModernBar.vue
git commit -m "feat: show quality in play bar"
```

### Task 6: Verify The Complete Feature

**Files:**
- Verify only; modify production or tests only to fix failures caused by Tasks 1-5.

**Interfaces:**
- Consumes: all prior task contracts.
- Produces: focused tests, lint, main/renderer builds, and visual evidence that the final label does not overlap or alter the play-bar height.

- [ ] **Step 1: Run all focused regression suites**

Run:

```powershell
npm run test:playback-fallback
node --test build-config/play-bar-quality-label.test.js build-config/song-row-components.test.js build-config/storage/music-url-authorization.test.js build-config/storage/cache-callsite.test.js
npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/cache-db.test.js build-config/storage-electron/scoped-cache-repository.test.js build-config/storage-electron/database-recovery.test.js
```

Expected: every command exits 0. Existing source-tag, playback fallback, recovery, stale-event, and cache failure tests remain green.

- [ ] **Step 2: Lint every touched source file**

Run:

```powershell
npx eslint -f node_modules/eslint-formatter-friendly src/common/storage/cache.ts src/common/storage/cacheValidation.ts src/common/types/playback_source.d.ts src/main/modules/winMain/rendererEvent/music.ts src/main/services/musicUrlAuthorization.ts src/main/types/db_service.d.ts src/main/worker/dbService/cacheTables.ts src/main/worker/dbService/cacheMigrate.ts src/main/worker/dbService/cacheSchemaContract.ts src/main/worker/dbService/cacheDb.ts src/main/worker/dbService/modules/music_url/index.ts src/renderer/components/layout/PlayBar/ModernBar.vue src/renderer/core/music/playback/cache.ts src/renderer/core/music/playback/coordinator.ts src/renderer/core/music/playback/index.ts src/renderer/core/music/playback/session.ts src/renderer/core/music/playback/sourceAdapter.ts src/renderer/core/player/action.ts src/renderer/core/useApp/usePlayer/usePlayerEvent.ts src/renderer/store/player/state.ts src/renderer/utils/ipc.ts
```

Expected: exit 0 with no lint errors. Do not run `lint:fix` across unrelated files.

- [ ] **Step 3: Build both application bundles**

Run:

```powershell
npm run build:renderer
npm run build:main
```

Expected: both webpack production builds exit 0 with no TypeScript errors. This verifies ambient types and the cache IPC contract across process boundaries.

- [ ] **Step 4: Inspect desktop and narrow play-bar layouts**

Start the application with `npm run dev`. In the running app, validate one source that reports `flac24bit`, one source response with no valid `type`, a downloaded song, a local song, and a WebDAV song. Capture desktop and narrow-window screenshots after `canplay`.

Expected:

- `flac24bit` appears raw beside the title only after playback validates.
- Missing/invalid source type, local, and WebDAV show no label.
- Downloaded playback shows `metadata.quality` after `canplay`.
- At desktop and narrow widths, the quality stays visible, the song title ellipsizes first, singer placement and play-bar height do not change, and no text overlaps controls.
- Clicking the title copies the song name; clicking the quality does not copy or navigate.

- [ ] **Step 5: Review the final diff for scope and user-change preservation**

Run:

```powershell
git status --short
git diff --check
git diff --stat
git diff -- build-config/playback-media-validation.test.js build-config/playback-source-fallback.test.js build-config/song-row-components.test.js build-config/storage-electron/database-recovery.test.js build-config/test-utils/playback-fallback-harness.js src/renderer/core/music/playback/sourceAdapter.ts src/renderer/core/useApp/usePlayer/usePlayerEvent.ts src/renderer/views/List/MusicList/index.vue
```

Expected: `git diff --check` exits 0; feature changes match this plan; pre-existing `toOldMusicInfo`, media-event replay, song-row, database-recovery, and list changes remain present; unrelated temporary directories are untouched.

- [ ] **Step 6: Commit verification-only fixes if needed**

If Steps 1-5 required feature-specific corrections, first use `git diff --name-only` to identify which files from Tasks 1-5 actually changed. Stage only those named feature files with one or more literal commands such as:

```powershell
git add -- src/renderer/components/layout/PlayBar/ModernBar.vue build-config/play-bar-quality-label.test.js
git commit -m "fix: complete play bar quality validation"
```

Repeat `git add --` with literal paths for any other corrected feature files. Expected: no commit is created when verification required no edits. Never stage unrelated dirty files or temporary directories, and do not use `git add -A` or `git add -u` in this dirty worktree.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-play-bar-quality-label.md`. Two execution options:

1. **Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, and iterate quickly.

2. **Inline Execution** - Execute tasks in this session using `superpowers:executing-plans`, with batch checkpoints for review.
