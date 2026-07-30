# Non-Activity Legacy Data Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move catalog preferences, navigation state, playlist metadata, and search history out of `data.json` into typed settings/database services without touching playback activity until its atomic Phase 3 cutover.

**Architecture:** A single allowlisted legacy-source parser normalizes each destination domain and computes an independent canonical hash. Three database domains import in one SQLite transaction, catalog preferences use an independently staged atomic `config_v2.json` replacement, and startup activates typed readers/writers only after every destination read-back passes.

**Tech Stack:** TypeScript, `better-sqlite3`, Comlink, atomic JSON persistence, Node.js crypto, Electron IPC, Vue renderer stores, and `node:test`.

## Global Constraints

- This plan requires authoritative schema version `4`, the startup coordinator, atomic JSON writer, and completed credential cutover.
- Do not migrate, archive, redact, or stop legacy writes for `playInfo`, `recentPlayList`, or `listeningTimeStats` in this plan.
- Do not read `data.json` through arbitrary renderer IPC during migration; the main-process coordinator owns the source snapshot.
- If the selected legacy `data.json` exists but is invalid JSON or has a non-object root, preserve its exact bytes, write no Phase 2 target marker/value, and enter the isolated startup recovery flow. Never replace it with defaults or silently fall back to the other root.
- Compute separate canonical source hashes for local state, playlist metadata, search history, and catalog preferences.
- A change only to playback activity keys must not change any Phase 2 hash.
- Import local state, playlist metadata, search history, and their markers in one SQLite transaction.
- Stage, flush, parse, validate, atomically replace, and hash `config_v2.json` before writing its external marker.
- Do not claim the SQLite transaction covers the settings-file replacement.
- Preserve legacy list order and exact case-sensitive search-term identity; do not invent timestamps.
- Search history retains at most 15 terms.
- `listUpdateInfo` is durable playlist metadata, not resettable UI state.
- Typed IPC accepts registered operations and bounded values only; the renderer never selects a raw key or sends unbounded `any`.
- Keep account profiles owned by the credential plan; do not create a second account table.
- Preserve every unrelated user change listed in the roadmap and any later concurrent edit; stage only files named by each task.

## File Structure

- Create authoritative migration `0005_non_activity_state.ts`.
- Create `src/main/worker/dbService/modules/app_state/` for local state, playlist metadata, and search history.
- Create `src/common/storage/stateContracts.ts` for domain commands and result types.
- Create `src/common/storage/stateValidation.ts` for exact validators and limits.
- Create `src/main/storage/settings/document.ts` for the versioned settings document.
- Create `src/main/migration/legacyData/source.ts` for one immutable parsed startup snapshot.
- Create `src/main/migration/legacyData/nonActivity.ts` for Phase 2 orchestration.
- Create `src/main/modules/winMain/rendererEvent/storageState.ts` for typed domain IPC.
- Create `src/renderer/utils/storageState.ts` for typed renderer wrappers.
- Modify existing renderer data/search modules while preserving their public UI-facing functions.
- Remove only the legacy pre-v2 helper that eagerly creates a new `data.json`; keep other old-format compatibility reads in the new source module.

---

### Task 1: Add Non-Activity Contracts and Validators

**Files:**
- Create: `src/common/storage/stateContracts.ts`
- Create: `src/common/storage/stateValidation.ts`
- Create: `build-config/storage/non-activity-contracts.test.js`

**Interfaces:**
- Consumes: existing `DEFAULT_SETTING`, list metadata types, and shared validation primitives.
- Produces: `CatalogPreferencesV1`, `LocalStateSnapshotV1`, `PlaylistMetadataCommandV1`, and `SearchHistoryCommandV1`.
- Used by: worker repository, migration coordinator, main IPC, and renderer wrappers.

- [ ] **Step 1: Write exact boundary tests**

```js
it('accepts only the three registered local-state keys', () => {
  assert.deepEqual(parseLocalStateUpdate({
    version: 1,
    key: 'list_prev_select_id',
    value: 'default',
    updatedAtMs: 1,
  }).key, 'list_prev_select_id')
  assert.throws(() => parseLocalStateUpdate({ version: 1, key: 'arbitrary', value: {}, updatedAtMs: 1 }))
})

it('enforces all payload limits without logging values', () => {
  assert.throws(() => parseSearchHistoryCommand({ version: 1, action: 'record', term: 'x'.repeat(201), usedAtMs: 1 }))
  assert.throws(() => parsePlaylistMetadataCommand({
    version: 1,
    action: 'retain',
    playlistIds: Array.from({ length: 10001 }, (_, index) => String(index)),
  }))
  assert.throws(() => parseLocalStateUpdate({
    version: 1,
    key: 'view_prev_state',
    value: { url: '/search', query: { q: 'x'.repeat(32768) } },
    updatedAtMs: 1,
  }))
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/non-activity-contracts.test.js
```

Expected: FAIL because the contracts do not exist.

- [ ] **Step 3: Implement the exact versioned contracts**

```ts
export interface CatalogPreferencesV1 {
  version: 1
  leaderboard: { source: LX.OnlineSource; boardId: string }
  songList: { source: LX.OnlineSource; sortId: string; tagId: string }
  search: {
    temp_source: LX.OnlineSource
    source: LX.OnlineSource | 'all'
    type: 'music' | 'songlist'
  }
}

export interface LocalStateSnapshotV1 {
  version: 1
  viewPrevState: typeof DEFAULT_SETTING.viewPrevState
  listScrollPosition: LX.List.ListPositionInfo
  listPrevSelectId: string
}

export type LocalStateUpdateV1 =
  | { version: 1; key: 'view_prev_state'; value: typeof DEFAULT_SETTING.viewPrevState; updatedAtMs: number }
  | { version: 1; key: 'list_scroll_positions'; value: LX.List.ListPositionInfo; updatedAtMs: number }
  | { version: 1; key: 'list_prev_select_id'; value: string; updatedAtMs: number }

export type PlaylistMetadataCommandV1 =
  | { version: 1; action: 'upsert'; playlistId: string; value: LX.List.ListUpdateInfo[string]; updatedAtMs: number }
  | { version: 1; action: 'remove'; playlistId: string }
  | { version: 1; action: 'retain'; playlistIds: string[] }

export type SearchHistoryCommandV1 =
  | { version: 1; action: 'record'; term: string; usedAtMs: number }
  | { version: 1; action: 'remove'; term: string }
  | { version: 1; action: 'clear' }
```

Limits are fixed: IDs 1-256 characters; URLs 1-4096; view query JSON 32 KiB; playlist profile JSON 32 KiB; search terms 1-200; scroll maps 10,000 entries with finite non-negative positions; retain lists 10,000 IDs. Parsers reject extra properties and use field names only in errors.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/non-activity-contracts.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/stateContracts.ts src/common/storage/stateValidation.ts build-config/storage/non-activity-contracts.test.js
git commit -m "feat: define non-activity storage contracts"
```

### Task 2: Add Authoritative Non-Activity Tables and Repository

**Files:**
- Create: `src/main/worker/dbService/migrations/0005_non_activity_state.ts`
- Modify: `src/main/worker/dbService/migrations/index.ts`
- Create: `src/main/worker/dbService/modules/app_state/statements.ts`
- Create: `src/main/worker/dbService/modules/app_state/dbHelper.ts`
- Create: `src/main/worker/dbService/modules/app_state/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Create: `build-config/storage-electron/non-activity-repository.test.js`

**Interfaces:**
- Consumes: Task 1 commands and `getAppDB()`.
- Produces: authoritative schema version `5` and `AppStateRepository` worker RPC.
- Guarantees: command transactions return the authoritative post-write value.

- [ ] **Step 1: Write schema, ordering, and mutation tests**

```js
it('preserves case-sensitive imported order and caps search history at 15', () => {
  repository.importSearchHistory(['A', 'a', 'A', ...Array.from({ length: 20 }, (_, i) => `q${i}`)])
  const result = repository.getSearchHistory()
  assert.deepEqual(result.slice(0, 2), ['A', 'a'])
  assert.equal(result.length, 15)
  assert.equal(readRow('A').last_used_at_ms, null)
  assert.equal(readRow('A').use_count, 1)
})

it('mutates one playlist metadata row without overwriting siblings', () => {
  repository.importPlaylistMetadata(fixtureMetadata)
  repository.applyPlaylistMetadata({ version: 1, action: 'remove', playlistId: 'one' })
  assert.equal(repository.getPlaylistMetadata().two.isAutoUpdate, true)
})
```

- [ ] **Step 2: Run under Electron ABI and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/non-activity-repository.test.js
```

Expected: FAIL because schema version 5 is absent.

- [ ] **Step 3: Implement schema and repository**

```sql
CREATE TABLE local_state (
  key TEXT PRIMARY KEY CHECK(key IN (
    'view_prev_state', 'list_scroll_positions', 'list_prev_select_id'
  )),
  version INTEGER NOT NULL CHECK(version = 1),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE playlist_metadata (
  playlist_id TEXT PRIMARY KEY,
  is_auto_update INTEGER NOT NULL CHECK(is_auto_update IN (0, 1)),
  update_time_ms INTEGER NOT NULL CHECK(update_time_ms >= 0),
  profile_json TEXT CHECK(profile_json IS NULL OR json_valid(profile_json)),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE search_history (
  term TEXT PRIMARY KEY,
  recency_seq INTEGER NOT NULL UNIQUE,
  last_used_at_ms INTEGER,
  use_count INTEGER NOT NULL CHECK(use_count >= 1)
);
```

Worker API:

```ts
getLocalState(): LocalStateSnapshotV1
setLocalState(update: LocalStateUpdateV1): LocalStateSnapshotV1
clearLocalState(): void
getPlaylistMetadata(): LX.List.ListUpdateInfo
applyPlaylistMetadata(command: PlaylistMetadataCommandV1): LX.List.ListUpdateInfo
getSearchHistory(): string[]
applySearchHistory(command: SearchHistoryCommandV1): string[]
importLegacyNonActivity(input: LegacyNonActivityImportV1): LegacyNonActivityImportResultV1
```

Search `record` allocates `MAX(recency_seq)+1`, increments use count, removes an existing exact-case row before reinsertion, and deletes rows below the newest 15 in the same transaction. Import keeps the first occurrence from the source list, assigns descending recency while preserving source order, and never sets a time.

- [ ] **Step 4: Verify GREEN and schema health**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/non-activity-repository.test.js
npm run build:main
```

Expected: PASS; structural and foreign-key checks remain clean.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/migrations/0005_non_activity_state.ts src/main/worker/dbService/migrations/index.ts src/main/worker/dbService/modules/app_state src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts build-config/storage-electron/non-activity-repository.test.js
git commit -m "feat: add typed application state repository"
```

### Task 3: Version the Settings Document Without Losing Existing Fields

**Files:**
- Create: `src/main/storage/settings/document.ts`
- Modify: `src/main/utils/index.ts`
- Create: `build-config/storage/settings-document.test.js`

**Interfaces:**
- Consumes: old `{version, setting}` and new `SettingsDocumentV1`.
- Produces: validated `catalogPreferences` alongside ordinary settings.
- Guarantees: `updateSetting()` changes only the `setting` section.

- [ ] **Step 1: Write compatibility and secret-denylist tests**

```js
it('upgrades an old settings document with default catalog preferences', () => {
  const result = parseSettingsDocument({ version: '2.11.0', setting: ordinarySetting })
  assert.equal(result.storageSchemaVersion, 1)
  assert.deepEqual(result.catalogPreferences, defaultCatalogPreferences)
})

it('preserves catalog preferences across ordinary setting updates', () => {
  const next = replaceOrdinarySettings(existingDocument, nextSetting)
  assert.deepEqual(next.catalogPreferences, existingDocument.catalogPreferences)
})

it('never accepts non-empty WebDAV credential settings', () => {
  assert.throws(() => replaceOrdinarySettings(existingDocument, {
    ...nextSetting,
    'webdav.password': 'PASS_SENTINEL',
  }))
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/settings-document.test.js
```

Expected: FAIL because the document wrapper does not exist.

- [ ] **Step 3: Implement the document contract**

```ts
export interface SettingsDocumentV1 {
  storageSchemaVersion: 1
  version: string
  setting: LX.AppSetting
  catalogPreferences: CatalogPreferencesV1
}

export function parseSettingsDocument(value: unknown): SettingsDocumentV1
export function replaceOrdinarySettings(
  current: SettingsDocumentV1,
  setting: LX.AppSetting,
): SettingsDocumentV1
export function replaceCatalogPreferences(
  current: SettingsDocumentV1,
  preferences: CatalogPreferencesV1,
): SettingsDocumentV1
```

Modify `updateSetting()` so it loads the complete validated document and calls `Store.override()` with all four fields. Remove the assumption that only `{version, setting}` exists. `initSetting()` must not call the old `migrateDataJson()` helper; Task 4 owns that compatibility source.

- [ ] **Step 4: Verify GREEN and settings initialization**

```powershell
node --test build-config/storage/settings-document.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/storage/settings/document.ts src/main/utils/index.ts build-config/storage/settings-document.test.js
git commit -m "feat: version the settings document"
```

### Task 4: Build the Idempotent Phase 2 Migration Coordinator

**Files:**
- Create: `src/main/migration/legacyData/source.ts`
- Create: `src/main/migration/legacyData/nonActivity.ts`
- Modify: `src/main/utils/migrate.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage/non-activity-source.test.js`
- Create: `build-config/storage-electron/non-activity-retry.test.js`

**Interfaces:**
- Consumes: one frozen parsed `data.json` snapshot, settings document, app-state repository, and marker repository.
- Produces: four target markers and `legacy_data_v1.phase2_complete`.
- Leaves: playback activity keys and writers untouched.

- [ ] **Step 1: Write normalization and domain-hash tests**

```js
it('maps old listPosition but never includes activity in Phase 2 hashes', () => {
  const first = normalizeNonActivitySource({
    ...legacy,
    listPosition: { default: 10 },
    recentPlayList: [{ id: 'a' }],
    listeningTimeStats: { totalSeconds: 1 },
  })
  const second = normalizeNonActivitySource({
    ...legacy,
    listPosition: { default: 10 },
    recentPlayList: [{ id: 'b' }],
    listeningTimeStats: { totalSeconds: 99 },
  })
  assert.deepEqual(first.hashes, second.hashes)
  assert.deepEqual(first.localState.listScrollPosition, { default: 10 })
})

it('preserves a corrupt selected source and makes no partial target visible', async() => {
  await fs.writeFile(profileDataPath, '{"broken":', 'utf8')
  await fs.writeFile(`${profileDataPath}.previous`, JSON.stringify(validLegacy), 'utf8')
  const originalBytes = await fs.readFile(profileDataPath)
  const before = readPhase2TargetSnapshot()

  const outcome = await storageCoordinator.start()

  assert.deepEqual(outcome, {
    status: 'recovery',
    reason: 'legacy_data_invalid_json',
    target: {
      kind: 'legacy-json',
      sourcePath: profileDataPath,
      candidatePreviousPath: `${profileDataPath}.previous`,
    },
  })
  assert.deepEqual(await fs.readFile(profileDataPath), originalBytes)
  assert.deepEqual(readPhase2TargetSnapshot(), before)
  assert.equal(readMarker('legacy_data_v1.phase2_complete'), null)
  assert.equal(registerModulesCalls, 0)
  assert.equal(createWindowCalls, 0)
})
```

- [ ] **Step 2: Add crash points around each artifact**

```js
it('resumes after config replacement without duplicating database rows', async() => {
  await assert.rejects(runMigration({ failAt: 'after-config-replace' }), /injected failure/)
  assert.equal(readMarker('legacy_data_v1.catalog_preferences'), null)
  await runMigration()
  assert.equal(countRows('playlist_metadata'), 2)
  assert.equal(countRows('search_history'), 3)
  assert.ok(readMarker('legacy_data_v1.catalog_preferences'))
})
```

- [ ] **Step 3: Run and verify RED**

```powershell
node --test build-config/storage/non-activity-source.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/non-activity-retry.test.js
```

Expected: FAIL because Phase 2 migration is absent.

- [ ] **Step 4: Implement exact source and coordinator flow**

```ts
export interface LegacyDataSnapshotV1 {
  sourcePath: string
  parsed: Record<string, unknown>
  fileSha256: string
}

export type LegacyDataSourceResult =
  | { status: 'available'; snapshot: LegacyDataSnapshotV1 }
  | { status: 'absent' }
  | {
      status: 'recovery'
      reason: 'legacy_data_invalid_json' | 'legacy_data_invalid_root'
      sourcePath: string
      fileSha256: string
      candidatePreviousPath: string | null
    }

export async function readLegacyDataSource(input: {
  profileRoot: string
  legacyRoot: string
}): Promise<LegacyDataSourceResult>

export async function migrateLegacyNonActivity(
  deps: NonActivityMigrationDeps,
): Promise<{
  status: 'complete' | 'already-complete' | 'no-source'
  databaseCounts: { localState: number; playlistMetadata: number; searchHistory: number }
  catalogPreferencesSha256: string
}>
```

Select `<profileRoot>/data.json` when it exists; only when it is absent may the reader select `<legacyRoot>/data.json`. Read the selected file once, hash its exact bytes, parse it, require a plain-object root, and retain the immutable snapshot for this startup. A selected corrupt source returns `status:'recovery'`; do not try the other root, rename/delete the source, import defaults, stage settings, or write a marker. Inspect an exact sibling `.previous` only as a validated recovery candidate and expose its path to the existing recovery dialog; restoration requires an explicit recovery action outside this migration. Normalize the four allowlisted domains with defaults and validators only after a valid root exists. The worker imports the three DB domains, reads back normalized values, compares hashes/counts, and writes three markers in one explicit transaction.

For settings, call `stage(document, 'next')` to create `config_v2.json.next`, flush, parse, compare catalog preferences, and call `commit(stage)` to atomically replace the destination and return the complete resulting file SHA-256. Then write `legacy_data_v1.catalog_preferences`. If a retry sees matching normalized preferences already active but no marker, it validates the full current document and writes only the missing marker.

After typed repository smoke reads succeed, write `legacy_data_v1.phase2_complete`. Delete only the old helper code that creates a new `data.json`; retain older playlist/settings compatibility unrelated to this source.

- [ ] **Step 5: Verify GREEN**

```powershell
node --test build-config/storage/non-activity-source.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/non-activity-retry.test.js
npm run build:main
```

Expected: PASS for invalid JSON/non-object roots and every injected point before/after DB commit, settings replace, marker write, and smoke check. Corrupt-source cases preserve the source bytes, show no partial Phase 2 values/markers, and do not register modules or create a window.

- [ ] **Step 6: Commit**

```powershell
git add src/main/migration/legacyData src/main/utils/migrate.ts src/main/startup/storageCoordinator.ts build-config/storage/non-activity-source.test.js build-config/storage-electron/non-activity-retry.test.js
git commit -m "feat: migrate non-activity legacy data"
```

### Task 5: Add Typed State IPC and Switch Renderer Callers

**Files:**
- Create: `src/main/modules/winMain/rendererEvent/storageState.ts`
- Create: `src/renderer/utils/storageState.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Modify: `src/renderer/utils/data.ts`
- Modify: `src/renderer/store/search/action.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Create: `build-config/storage/non-activity-ipc.test.js`
- Create: `build-config/storage/non-activity-callsite.test.js`

**Interfaces:**
- Consumes: Task 1 validators and worker repository.
- Produces: eight domain-specific IPC methods.
- Preserves: current exported functions from `src/renderer/utils/data.ts` for page/component compatibility.

- [ ] **Step 1: Write handler parsing and source-scan tests**

```js
it('rejects unknown operations and oversized state before worker dispatch', async() => {
  await assert.rejects(dispatch({ type: 'local_state.set', update: { key: 'unknown', value: {} } }))
  assert.equal(workerCalls.length, 0)
})

it('contains no generic data calls for Phase 2 domains', () => {
  const source = readFiles([
    'src/renderer/utils/data.ts',
    'src/renderer/store/search/action.ts',
  ])
  assert.doesNotMatch(source, /DATA_KEYS\.(viewPrevState|listScrollPosition|listPrevSelectId|listUpdateInfo|searchHistoryList|leaderboardSetting|songListSetting|searchSetting)/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/non-activity-ipc.test.js build-config/storage/non-activity-callsite.test.js
```

Expected: FAIL because current wrappers call `get_data/save_data`.

- [ ] **Step 3: Add the exact IPC surface**

Add these names and matching request/response types:

```text
storage_catalog_preferences_get
storage_catalog_preference_set
storage_local_state_get
storage_local_state_set
storage_playlist_metadata_get
storage_playlist_metadata_mutate
storage_search_history_get
storage_search_history_mutate
```

`set_catalog_preference` accepts `{section:'leaderboard'|'songList'|'search', value}` and rewrites the full validated settings document atomically. Local/playlist/search handlers parse the Task 1 discriminated unions, invoke worker RPC, and return the authoritative post-write result. No handler accepts a path or arbitrary key.

Keep public functions such as `getListPosition`, `setListAutoUpdate`, and `getSearchSetting`, but replace their internal imports with `src/renderer/utils/storageState.ts`. Change `clearHistoryList(id: string)` to `clearHistoryList()` and make search mutations update the renderer list from the returned authoritative order.

- [ ] **Step 4: Verify GREEN and builds**

```powershell
node --test build-config/storage/non-activity-ipc.test.js build-config/storage/non-activity-callsite.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/modules/winMain/rendererEvent/storageState.ts src/renderer/utils/storageState.ts src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/index.ts src/renderer/utils/data.ts src/renderer/store/search/action.ts src/renderer/utils/ipc.ts build-config/storage/non-activity-ipc.test.js build-config/storage/non-activity-callsite.test.js
git commit -m "refactor: cut non-activity state over to typed storage"
```

### Task 6: Gate Phase 2 Without Freezing Playback Activity

**Files:**
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage/non-activity-startup.test.js`

**Interfaces:**
- Consumes: `legacy_data_v1.phase2_complete` and typed reader/writer smoke checks.
- Produces: Phase 2 readiness for account/module/window registration.
- Explicitly preserves: legacy activity endpoints until the playback plan.

- [ ] **Step 1: Write startup-order and activity-preservation tests**

```js
it('activates typed Phase 2 writers before the renderer window', async() => {
  await coordinator.start()
  assert.ok(calls.indexOf('phase2:typed-write-smoke') < calls.indexOf('modules:register'))
})

it('does not redact or disable legacy activity keys in Phase 2', async() => {
  await coordinator.start()
  assert.equal(legacyWriterState.playInfo, 'enabled')
  assert.equal(legacyWriterState.recentPlayList, 'enabled')
  assert.equal(legacyWriterState.listeningTimeStats, 'enabled')
  assert.equal(await exists(dataJsonPath), true)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/non-activity-startup.test.js
```

Expected: FAIL until the coordinator has a Phase 2 gate.

- [ ] **Step 3: Implement and verify the gate**

Smoke-read each migrated target and perform reversible typed writes in an isolated test transaction/temporary settings document. Production startup verifies validators and repository availability without changing user values. Return a fatal migration error rather than falling back to legacy readers for a domain whose completion marker exists.

Run:

```powershell
node --test build-config/storage/non-activity-*.test.js
npm run test:storage:electron
npm run lint
npm run build:main
npm run build:renderer
git status --short
```

Expected: PASS; current activity writers and the two user-owned listening-time files remain unchanged.

- [ ] **Step 4: Commit**

```powershell
git add src/main/startup/storageCoordinator.ts build-config/storage/non-activity-startup.test.js
git commit -m "test: gate non-activity storage cutover"
```

## Phase 2 Acceptance Gate

Do not start playback migration until all statements are true:

1. Local state, playlist metadata, and search history round-trip through schema version `5` repositories.
2. Catalog preferences survive ordinary setting writes and contain no secret settings.
3. Phase 2 hashes are unchanged by activity-key mutations.
4. An interrupted settings replacement or DB import resumes without duplicate rows or value loss.
5. All Phase 2 renderer callers use typed IPC and cannot select arbitrary keys.
6. `playInfo`, `recentPlayList`, and `listeningTimeStats` remain intact and writable until Phase 3 freezes them together.
7. Invalid legacy JSON enters isolated recovery with its bytes intact and no partially visible Phase 2 target.
