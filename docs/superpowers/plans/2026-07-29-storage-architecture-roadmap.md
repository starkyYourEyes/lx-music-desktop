# Storage Architecture Delivery Roadmap

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved local-storage architecture as six independently reviewable milestones without losing existing user data or introducing a long-lived dual-write path.

**Architecture:** `lx.data.db` remains the only authoritative application database, `cache.db` owns reconstructable structured cache data, and `credentials.v1.json` stores independently encrypted secrets. Startup is gated by storage migration and health checks; typed services replace `data.json`, playback facts feed projections, and the final milestone removes legacy plumbing only after a verified typed-only startup.

**Tech Stack:** Electron 37.6.1, Node.js 22 or newer, TypeScript 5.9, Vue 3.3, `better-sqlite3` 12.6, Comlink worker RPC, Electron `safeStorage`, and `node:test`.

## Global Constraints

- Keep `lx.data.db`; do not rename it to `app.db` and do not add `activity.db`.
- Add only one additional SQLite database, `<cacheRoot>/cache.db`, and treat it as disposable.
- Do not add `event_outbox` until a real external playback-history consumer exists.
- Run migrations after the single-instance lock succeeds and before renderer windows, account services, sync services, or legacy writers start.
- Do not claim atomicity across SQLite, JSON, and credential-vault files; use a marker and read-back verification for each destination.
- Do not use a long-lived dual write. Each domain follows freeze, import, read back, switch readers/writers, then remove the legacy value.
- Never log Cookies, WebDAV credentials, sync keys, music URLs, vault ciphertext, complete account payloads, or playback event details.
- Never persist a secret in plaintext when Electron secure encryption is unavailable.
- Keep downloaded media, partial downloads, edited lyrics, themes, User API scripts, settings, credentials, and backups outside cache-clear ownership.
- Use integer milliseconds for new playback storage and `Math.round(seconds * 1000)` for legacy listening values.
- Preserve all pre-existing or concurrently appearing user changes. At plan review time these include `src/common/utils/listeningTime.ts`, `build-config/listening-time.test.js`, `build-config/build-pack.js`, and `build-config/packaged-app.test.js`; no storage-plan commit may stage or revert them unless the user explicitly assigns their ownership.
- Use Node.js `node:test`; run SQLite integration tests under the Electron ABI when the normal Node ABI cannot load `better-sqlite3`.
- Every implementation task uses RED-GREEN-REFACTOR, stages only its listed files, and ends with a focused commit.

## Plan Set

| Order | Plan | Release gate | Primary outputs |
| --- | --- | --- | --- |
| 1 | `2026-07-29-storage-foundation.md` | Database failure cannot create an empty replacement | migration runner, online backup, structural checks, atomic JSON writer, startup gate |
| 2 | `2026-07-29-credential-vault.md` | No confirmed secret remains in active plaintext stores | safeStorage vault, account profile repository, QQ/NetEase/WebDAV/sync cutover |
| 3 | `2026-07-29-legacy-data-migration.md` | Non-activity domains use typed storage only | catalog preferences, local state, playlist metadata, search history |
| 4 | `2026-07-29-playback-activity.md` | Playback no longer writes full JSON snapshots | sessions/events, idempotent checkpoints, recent/listening projections, retention |
| 5 | `2026-07-29-cache-separation.md` | Cache can be destroyed without durable-data loss | path roots, cache DB, cache migration, TTL/quota, orchestrated clear |
| 6 | `2026-07-29-backup-legacy-cleanup.md` | One verified typed-only startup has completed | portable logical backup, scoped clear UI, redacted tombstone, legacy removal |

## Shared Migration Numbers

The existing `db_info.version = '2'` is the legacy baseline. Lock the authoritative migration sequence before implementation:

```ts
export const APP_SCHEMA_BASELINE = 2
export const APP_SCHEMA_STORAGE_FOUNDATION = 3
export const APP_SCHEMA_ACCOUNT_PROFILES = 4
export const APP_SCHEMA_NON_ACTIVITY_STATE = 5
export const APP_SCHEMA_PLAYBACK_ACTIVITY = 6
export const APP_SCHEMA_CACHE_CLEANUP = 7
```

`cache.db` has an independent sequence beginning at version `1`; it never writes into authoritative `schema_migrations`.

Migration `7` is a coordinated deferred migration. Database initialization stops at version `6`, the Phase 4 coordinator opens/verifies `cache.db` and completes the raw-lyric/read-write cutover, and only then calls the runner again with target version `7`. This ordering also applies to a fresh install or an upgrade that skipped an intermediate release; merely registering migration `7` must never drop legacy cache rows before its external preconditions exist.

## Shared Marker Names

Marker names are stable API, not free-form log strings:

```ts
export const STORAGE_MARKERS = {
  credentials: 'legacy_data_v1.credentials',
  accountProfiles: 'legacy_data_v1.account_profiles',
  localState: 'legacy_data_v1.local_state',
  playlistMetadata: 'legacy_data_v1.playlist_metadata',
  searchHistory: 'legacy_data_v1.search_history',
  catalogPreferences: 'legacy_data_v1.catalog_preferences',
  phase2Complete: 'legacy_data_v1.phase2_complete',
  playbackActivity: 'legacy_data_v1.playback_activity',
  rawLyrics: 'legacy_cache_v1.raw_lyrics',
  cacheReadWrite: 'legacy_cache_v1.read_write_verified',
  cacheCutover: 'legacy_cache_v1.cutover',
  crossArtifactComplete: 'legacy_data_v1.cross_artifact_complete',
  redacted: 'legacy_data_v1.redacted',
} as const
```

Every marker stores a canonical source SHA-256, completion time, and schema-validated `details_json`. A matching source hash makes a retry reusable; a conflicting hash after cutover is an error requiring diagnosis.

## Shared Service Ownership

```text
main process
  startup/storageCoordinator.ts
    -> atomic JSON files and credential vault
    -> dbService worker initialization and migrations
    -> legacy migration coordinators
    -> module/window registration only after ready

dbService worker
  lx.data.db
    -> durable repositories and playback transaction boundary
  cache.db
    -> reconstructable cache repositories only

renderer
  typed IPC wrappers
    -> never chooses a JSON key, table name, file path, or credential entry
```

The worker owns SQLite connections. The main process owns filesystem roots, Electron sessions, credential encryption, backup containers, and startup sequencing. The renderer owns playback sampling and UI state but never directly persists arbitrary records.

## Cross-Plan Interfaces

Foundation must publish these interfaces before any later plan begins:

```ts
export interface MigrationMarker {
  name: string
  sourceSha256: string
  completedAtMs: number
  detailsJson: string
}

export interface AtomicJsonFile<T> {
  read(): Promise<T | null>
  stage(value: T, label?: 'next'): Promise<AtomicJsonStage>
  commit(stage: AtomicJsonStage): Promise<{ fileSha256: string }>
  replace(value: T): Promise<{ fileSha256: string }>
  flush(): Promise<void>
  cleanupOwnedTemps(): Promise<void>
}

export type DatabaseStartupResult =
  | { status: 'ready'; existed: boolean; schemaVersion: number; migratedVersions: number[]; backupPath: string | null }
  | { status: 'recovery'; reason: string; databasePath: string; backupPath: string | null; diagnostics: string[] }
```

Credentials must publish `CredentialVault` and `AccountRepository`. Legacy migration must publish typed repositories for local state, playlist metadata, and search history. Playback must publish its checkpoint and query services. Cache separation must publish `StoragePaths` and `CacheManager`. Backup/cleanup may consume all of them but must not duplicate their ownership.

## Release Sequence

- [ ] **Step 1: Establish the dirty-worktree guard**

Run:

```powershell
git status --short
git diff -- src/common/utils/listeningTime.ts
```

Expected: record every existing change as user-owned unless provenance proves otherwise. The four files named in Global Constraints are present at plan review time; preserve those and any later additions outside storage commits.

- [ ] **Step 2: Execute the foundation plan**

Release only when an existing invalid database returns `status: 'recovery'`, the database/WAL remain untouched, and a committed-WAL online-backup fixture passes `quick_check`.

- [ ] **Step 3: Execute the credential plan**

Release only when profile fixture scans find no known secret in plaintext JSON and account-status/sync-status IPC responses contain no secret fields.

- [ ] **Step 4: Execute the non-activity migration plan**

Release only when modifying `recentPlayList` or `listeningTimeStats` cannot change Phase 2 source hashes and all migrated callers use typed services.

- [ ] **Step 5: Execute the playback plan**

Release only when duplicate/out-of-order checkpoints are idempotent, a real `playing` transition is required for recent playback, and clearing statistics rotates an active segment.

- [ ] **Step 6: Execute the cache plan**

Release only when deleting the complete cache fixture preserves every durable fixture and no code recursively removes the Electron `sessionData` root.

- [ ] **Step 7: Execute backup and cleanup**

Release legacy removal only after `legacy_data_v1.cross_artifact_complete`, a successful typed-only startup acknowledgement, a verified redacted `data.json`, and a recoverable pre-migration operational snapshot all exist.

- [ ] **Step 8: Run the complete verification matrix**

Run:

```powershell
npm run test:storage
npm run test:storage:electron
node --test build-config/listening-time.test.js
npm run lint
npm run build:main
npm run build:renderer
npm run test:main-bundle
git status --short
```

Expected: all commands pass. `git status --short` contains only the implementation being reviewed plus any explicitly preserved user-owned files.

## Acceptance-Criteria Coverage

The numbered rows below map one-to-one to the approved design's 14 acceptance criteria. A phase cannot claim completion from its local gate alone when the row also names a later final-gate test.

| AC | Owning plan/task | Required executable evidence |
| --- | --- | --- |
| 1 | Backup/cleanup Tasks 7-8 | `legacy-data-redaction.test.js` proves a typed-only startup precedes the tombstone; `legacy-data-cleanup.test.js` scans for active `data.json`, `DATA_KEYS`, `get_data`, and `save_data` paths. |
| 2 | Playback Tasks 5 and 9 | `playback-recorder.test.js` and `playback-cutover.test.js` prove 15-second row checkpoints replace the 2/5-second full-JSON writers. |
| 3 | Playback Task 6 | `playback-storage.test.js` injects failure after each session/daily/track/total/event/resume write and proves one `BEGIN IMMEDIATE` rollback plus duplicate/stale idempotence. |
| 4 | Playback Tasks 5, 6, and 9 | Recorder/storage/cutover tests cover exhausted pre-play failure with no recent/stat contribution and a real short playback followed by an explicit typed skip. |
| 5 | Playback Tasks 5 and 8 | `playback-recorder.test.js` covers pause, buffering, every seek origin, playback rate, background throttling, and baseline resets; `playback-intent-callsite.test.js` proves every caller supplies an origin/reason. |
| 6 | Playback Tasks 7 and 11 | `playback-ipc.test.js` drops acknowledgements and retries the same group/sequence; `playback-renderer-crash.integration.test.js` terminates the recorder child between checkpoints and proves loss is below 15 seconds with no replayed delta. |
| 7 | Credential Task 8 plus Backup Tasks 2-4 | `credential-profile-scan.test.js` recursively scans profile JSON and renderer responses; portable export/import tests scan default containers and reject secret-bearing legacy settings fields. |
| 8 | Credential Tasks 1, 2, and 4 | Cipher/vault/migration tests cover unavailable encryption and Linux `basic_text`, require memory-only operation, redact the legacy plaintext source, and prove no plaintext fallback file exists. |
| 9 | Cache Tasks 3 and 7 | `cache-db.test.js` isolates cache corruption; `cache-clear.test.js` deletes only explicit cache targets and compares every durable fixture before/after. |
| 10 | Playback Task 10 plus Backup Task 6 | `playback-clear.test.js` and `storage-clear.test.js` assert distinct results for recent, statistics, all activity, device reset, and cache. |
| 11 | Playback Tasks 1 and 4 | Legacy conversion/migration tests preserve 520-row order, independently rounded total/day/track millisecond values, nullable timestamps/session IDs, and zero fabricated sessions/events. |
| 12 | Foundation Tasks 3, 4, and 7 | Migration-runner/recovery/failure-matrix tests prove transactional rollback, WAL-aware online backup, read-only recovery, and no automatic empty authoritative DB. |
| 13 | Backup Tasks 2-5 | Contract/export/import/UI tests enumerate every default durable section, optional section, and excluded secret/cache/device/runtime section and verify section hashes before import. |
| 14 | Credential Task 4, Legacy Task 4, Playback Tasks 4/6/11, Cache Tasks 4/8, Backup Task 4 | Each migration test injects failure before/after its commit/replace/marker boundaries and reruns twice; `storage-e2e.test.js` repeats the entire profile upgrade and compares row, projection, credential-entry, and marker counts. |

## Stop Conditions

Stop the rollout and enter the documented recovery path when any of these occurs:

- the authoritative database cannot be opened read/write;
- online backup cannot be created or verified before a pending authoritative migration;
- an applied migration checksum differs from the registered checksum;
- `quick_check`, `foreign_key_check`, or the structural contract fails;
- a vault entry cannot be verified after encryption;
- a target read-back differs from its normalized legacy source;
- a migration would need to infer a timestamp, playback session, or event absent from legacy data;
- a clear operation resolves a target outside its owned root.

Do not recover by creating an empty `lx.data.db`, by writing a plaintext secret, by broadening a deletion path, or by silently dropping an unknown legacy key.
