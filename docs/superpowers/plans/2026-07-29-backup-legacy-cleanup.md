# Backup, Scoped Clearing, and Legacy Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver recoverable operational snapshots, a versioned secret-free portable backup, explicit storage-clear actions, and final removal of all active `data.json` and generic storage IPC plumbing.

**Architecture:** Operational snapshots preserve same-profile recovery state using SQLite online backup plus hashed durable artifacts. Portable exports are main-process-built logical envelopes with per-section integrity and explicit options; import validates every section before a staged, journaled multi-artifact change. Legacy `data.json` becomes a redacted tombstone after one verified typed-only startup, then arbitrary key IPC/constants are deleted.

**Tech Stack:** Electron main/renderer IPC, TypeScript, `better-sqlite3`, Node.js filesystem/crypto/zlib, Vue settings UI, atomic file persistence, and `node:test`.

## Global Constraints

- This plan requires completed schema version `7`, credential isolation, Phase 2/3 markers, playback services, and cache manager.
- Operational snapshots and portable exports are different products; do not present one as the other.
- Operational snapshots are same-profile recovery artifacts. OS-bound vault ciphertext is excluded unless the user explicitly selects it and the UI marks the snapshot sensitive.
- Portable `.slxmc` compression is not encryption; UI text must not imply password or secret protection.
- Portable export always excludes credentials/Cookies, account profiles, resume/local UI state, cache/runtime/temp, raw sessions/events, music URLs, downloads/partials, and sync transport state.
- Default portable sections include secret-free settings, playlists/profiles, dislike rules, edited lyrics, listening aggregates, sound-effect presets, themes, and referenced theme images.
- Search history and recent playback are optional and off by default. User API scripts are a separate explicit option and import disabled.
- Validate container/envelope/version, every section, byte limits, relative paths, and per-section SHA-256 before any live write.
- Existing `allData`, `allData_v2`, `setting`, `setting_v2`, and `playList_v2` imports remain readable but pass through the same secret sanitizer.
- A cross-file import uses a durable journal and per-destination markers; do not claim one SQLite transaction covers settings/assets.
- Clear cache, device state, recent playback, listening statistics, and all playback activity have distinct labels and semantics.
- Renderer clear requests never contain filesystem paths.
- Do not delete legacy IPC/constants until a typed-only startup, redacted tombstone, and operational rollback snapshot have all verified.
- Keep one pre-migration operational snapshot for 30 days; validate a replacement before pruning the previous snapshot.
- Preserve every unrelated user change listed in the roadmap and any later concurrent edit; stage only files named by the current task.

## File Structure

- Create `src/main/storage/backup/operationalSnapshot.ts`: same-profile online DB/artifact snapshot and retention.
- Create `src/common/storage/portableBackup.ts`: portable envelope types, validation, and section hashing.
- Create `src/main/storage/backup/container.ts`: atomic gzip container read/write.
- Create `src/main/storage/backup/logicalExport.ts` and `logicalImport.ts`.
- Create `src/main/worker/dbService/modules/backup/`: consistent logical DB section export/import.
- Create `src/main/modules/winMain/rendererEvent/backup.ts`: main-owned backup IPC.
- Refactor `SettingBackup.vue` into option/inspection-driven export/import.
- Create `src/main/storage/clear/service.ts`, typed IPC, and `SettingStorage.vue` for five clear actions.
- Create `src/main/migration/legacyData/redact.ts`: post-startup redacted tombstone.
- Delete generic data renderer event and constants only at the final gate.
- Add profile/container secret scans and full migration E2E tests.

---

### Task 1: Build Verified Operational Snapshots and Retention

**Files:**
- Create: `src/main/storage/backup/operationalSnapshot.ts`
- Create: `src/common/storage/operationalSnapshot.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Create: `build-config/storage-electron/operational-snapshot.test.js`

**Interfaces:**
- Consumes: foundation online DB backup, settings atomic writer, durable asset roots, optional vault ciphertext.
- Produces: hashed same-profile snapshot directory and fixed pre-migration retention.
- Never includes: cache/runtime/temp/download media.

- [ ] **Step 1: Write WAL, manifest, and retention tests**

```js
it('captures committed WAL data and only durable allowlisted artifacts', async() => {
  const result = await createOperationalSnapshot({ reason: 'pre-migration', includeCredentialCiphertext: false })
  assert.equal(await sqliteQuickCheck(path.join(result.path, 'lx.data.db')), 'ok')
  assert.deepEqual(result.manifest.artifacts.map(item => item.name).sort(), [
    'assets/theme-images', 'config_v2.json', 'lx.data.db', 'sound_effect.json', 'theme.json', 'user_api.json',
  ])
  assert.equal(result.manifest.artifacts.some(item => item.name.includes('cache')), false)
  assert.equal(result.manifest.artifacts.some(item => item.name.includes('credentials')), false)
})

it('keeps one verified pre-migration snapshot for 30 days', async() => {
  await retainPreMigrationSnapshot({ nowMs })
  assert.equal(listSnapshots('pre-migration').length, 1)
  await retainPreMigrationSnapshot({ nowMs: nowMs + 31 * DAY_MS })
  assert.equal(listSnapshots('pre-migration').length, 1)
  assert.ok(listSnapshots('pre-migration')[0].createdAtMs > nowMs)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/operational-snapshot.test.js
```

Expected: FAIL because normal backup still lacks a complete snapshot product.

- [ ] **Step 3: Implement exact snapshot metadata and containment**

```ts
export interface OperationalSnapshotManifestV1 {
  version: 1
  id: string
  reason: 'pre-migration' | 'manual' | 'pre-import'
  createdAtMs: number
  expiresAtMs: number
  schemaVersion: number
  sensitive: boolean
  artifacts: Array<{
    name: string
    relativePath: string
    type: 'file' | 'directory'
    size: number
    sha256: string
  }>
}

export async function createOperationalSnapshot(input: {
  reason: OperationalSnapshotManifestV1['reason']
  includeCredentialCiphertext: boolean
}): Promise<{ path: string; manifest: OperationalSnapshotManifestV1 }>

export async function retainPreMigrationSnapshot(input: {
  nowMs: number
  keep: 1
  expiresAfterMs: 30 * 24 * 60 * 60 * 1000
}): Promise<void>
```

Create under `<backupsRoot>/operational/<id>.staging`, use SQLite `backup()` for DB, atomically copy parsed/validated settings and allowlisted durable JSON/assets, compute a recursive sorted manifest without following symlinks, verify every hash and DB `quick_check`, then rename the staging directory. If ciphertext is selected, copy only `credentials.v1.json`, set `sensitive:true`, and never decrypt it.

Before deleting an older snapshot, verify the newer snapshot again. Deletion resolves a direct child below `operational`; cache DB, WAL/SHM, session data, downloads, and plaintext legacy credential sources are never copied.

- [ ] **Step 4: Verify GREEN**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/operational-snapshot.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/operationalSnapshot.ts src/main/storage/backup/operationalSnapshot.ts src/main/startup/storageCoordinator.ts build-config/storage-electron/operational-snapshot.test.js
git commit -m "feat: add verified operational snapshots"
```

### Task 2: Define and Validate `portable_backup_v3`

**Files:**
- Create: `src/common/storage/portableBackup.ts`
- Create: `src/common/types/portable_backup.d.ts`
- Create: `build-config/storage/portable-backup-contract.test.js`

**Interfaces:**
- Consumes: logical JSON-compatible section DTOs only.
- Produces: exact envelope, section names/options, sanitizer, integrity calculator, and full validator.
- Guarantees: invalid optional or unselected sections cannot reach writers.

- [ ] **Step 1: Write inclusion, exclusion, hash, and path tests**

```js
it('never serializes known credential sentinels', () => {
  const backup = buildPortableBackup(fixture({
    setting: { 'webdav.username': 'USER_SENTINEL', 'webdav.password': 'PASS_SENTINEL' },
    accountCookie: 'COOKIE_SENTINEL',
    syncKey: 'KEY_SENTINEL',
  }))
  assert.doesNotMatch(JSON.stringify(backup), /USER_SENTINEL|PASS_SENTINEL|COOKIE_SENTINEL|KEY_SENTINEL/)
})

it('rejects a bad section hash and unsafe asset path before writes', () => {
  assert.throws(() => validatePortableBackup(corruptSectionHashFixture()), /integrity/)
  assert.throws(() => validatePortableBackup(themeAssetFixture('../outside.png')), /relativePath/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/portable-backup-contract.test.js
```

Expected: FAIL because v3 is undefined.

- [ ] **Step 3: Implement the fixed envelope**

```ts
export type PortableSectionName =
  | 'settings' | 'playlists' | 'dislikeRules' | 'editedLyrics'
  | 'listening' | 'soundEffects' | 'themes'
  | 'searchHistory' | 'recentPlayback' | 'userApis'

export interface PortableExportOptions {
  includeSearchHistory: boolean
  includeRecentPlayback: boolean
  includeUserApis: boolean
}

export interface PortableBackupV3 {
  type: 'portable_backup_v3'
  formatVersion: 3
  createdAtMs: number
  appVersion: string
  sections: PortableSectionsV3
  integrity: {
    algorithm: 'sha256'
    sections: Partial<Record<PortableSectionName, string>>
  }
}
```

Required sections are settings, playlists, dislikeRules, editedLyrics, listening, soundEffects, and themes. Optional sections appear only when selected. `SecretFreeSettings` has a hard denylist for `webdav.username/password` and future credential-classified keys. `ListeningAggregateExport` contains baseline/live played/active milliseconds and no session/event rows. Recent contains sanitized track identity/payload and optional true timestamp only.

Theme assets use normalized POSIX relative paths, SHA-256, MIME, and base64 bytes; cap each at 20 MiB and all assets at 200 MiB. User API files cap at 2 MiB each/50 MiB total and carry `enabled:false` in export/import DTOs. Cap decompressed container JSON at 512 MiB and each JSON section at an explicit validator limit.

Compute each hash from canonical section JSON. Validation first checks exact envelope keys/version, then all section shapes/limits/paths, then every hash. Extra/unknown sections are rejected for v3.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/portable-backup-contract.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/portableBackup.ts src/common/types/portable_backup.d.ts build-config/storage/portable-backup-contract.test.js
git commit -m "feat: define portable backup v3"
```

### Task 3: Export Portable Backups in the Main Process

**Files:**
- Create: `src/main/worker/dbService/modules/backup/export.ts`
- Create: `src/main/worker/dbService/modules/backup/index.ts`
- Modify: `src/main/worker/dbService/modules/index.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Create: `src/main/storage/backup/container.ts`
- Create: `src/main/storage/backup/logicalExport.ts`
- Create: `src/main/modules/winMain/rendererEvent/backup.ts`
- Modify: `src/common/backupFormats.js`
- Modify: `src/common/backupFormats.d.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Create: `build-config/storage-electron/portable-backup-export.test.js`

**Interfaces:**
- Consumes: authoritative repositories, validated settings, durable assets, and export options.
- Produces: atomic gzip-compressed v3 file at a user-selected path.
- Removes: renderer assembly of `{...appSetting, playList}` for all-data export.

- [ ] **Step 1: Write complete-section and no-secret export tests**

```js
it('exports every default durable section and no optional section', async() => {
  const backup = await exportFixture(defaultOptions)
  assert.deepEqual(Object.keys(backup.sections).sort(), [
    'dislikeRules', 'editedLyrics', 'listening', 'playlists', 'settings', 'soundEffects', 'themes',
  ])
})

it('does not include excluded database or profile values', async() => {
  const text = JSON.stringify(await exportFixture(allOptionalOptions))
  assert.doesNotMatch(text, /COOKIE_SENTINEL|URL_SENTINEL|RESUME_SENTINEL|SESSION_SENTINEL|SYNC_SENTINEL/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/portable-backup-export.test.js
```

Expected: FAIL because current `allData_v2` contains only settings/playlists and runs in renderer.

- [ ] **Step 3: Implement consistent logical export and atomic container write**

Worker export opens a read transaction and returns playlists with profiles, dislike rules, edited lyrics, aggregate listening rows, and optional search/recent values. It never queries account profiles, resume, sessions/events, cache tables, downloads, or sync data.

Main export adds validated secret-free settings, sound effects, themes, referenced durable image bytes, and optional disabled User API scripts. Build and validate the complete envelope before compression.

```ts
export async function exportPortableBackup(input: {
  filePath: string
  allowOverwrite: boolean
  options: PortableExportOptions
}): Promise<string>
```

`container.ts` writes gzip bytes to a same-directory exclusive temp, flushes, validates by reading/decompressing the temp, then renames. With `allowOverwrite:false`, fail as `BackupFileExistsError` before replacement. With overwrite true, retain the old target until the staged container validates.

The renderer passes only path/overwrite/options; it never passes settings or database payloads.

- [ ] **Step 4: Verify GREEN**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/portable-backup-export.test.js
npm run build:main
npm run build:renderer
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/backup src/main/worker/dbService/modules/index.ts src/main/worker/dbService/index.ts src/main/storage/backup/container.ts src/main/storage/backup/logicalExport.ts src/main/modules/winMain/rendererEvent/backup.ts src/common/backupFormats.js src/common/backupFormats.d.ts src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/index.ts src/renderer/utils/ipc.ts build-config/storage-electron/portable-backup-export.test.js
git commit -m "feat: export secret-free portable backups"
```

### Task 4: Inspect and Import Portable Backups with a Durable Journal

**Files:**
- Create: `src/main/worker/dbService/modules/backup/import.ts`
- Modify: `src/main/worker/dbService/modules/backup/index.ts`
- Create: `src/main/storage/backup/logicalImport.ts`
- Modify: `src/main/storage/backup/container.ts`
- Modify: `src/main/modules/winMain/rendererEvent/backup.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/common/utils/nodejs.ts`
- Create: `build-config/storage-electron/portable-backup-import.test.js`

**Interfaces:**
- Consumes: v3 and sanitized legacy containers.
- Produces: inspection, section-selective import, durable journal resume, and result report.
- Guarantees: every selected section validates before the first live writer runs.

- [ ] **Step 1: Write prevalidation, retry, and secret-ignore tests**

```js
it('validates all selected sections before invoking any writer', async() => {
  const writes = []
  await assert.rejects(importBackup(corruptHashFixture(), { onWrite: value => writes.push(value) }))
  assert.deepEqual(writes, [])
})

it('resumes after database commit without importing rows twice', async() => {
  await assert.rejects(runImport({ failAt: 'after-db-commit' }), /injected failure/)
  await resumePendingImport()
  assert.equal(countImportedPlaylist('one'), 1)
  assert.equal(readImportJournal().status, 'complete')
})

it('ignores credential fields in legacy setting imports', async() => {
  await importBackup(legacySettingFixture({ 'webdav.password': 'PASS_SENTINEL' }))
  assert.equal(readSettings()['webdav.password'], '')
  assert.doesNotMatch(await readEveryProfileJson(), /PASS_SENTINEL/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/portable-backup-import.test.js
```

Expected: FAIL because current imports mutate from the renderer without complete prevalidation.

- [ ] **Step 3: Implement inspection and journaled import**

```ts
export async function inspectPortableBackup(filePath: string): Promise<PortableBackupInspection>

export async function importPortableBackup(input: {
  filePath: string
  sections: PortableSectionName[]
}): Promise<PortableImportResult>
```

Inspect reads with compressed/decompressed byte caps, normalizes supported legacy types into v3 DTOs, sanitizes settings, validates all selected sections/hashes, and returns counts/warnings without writing.

Before import, create a `pre-import` operational snapshot. Stage external artifacts below `<backupsRoot>/imports/<importId>` and write `journal.v1.json` atomically:

```ts
interface PortableImportJournalV1 {
  version: 1
  importId: string
  sourceSha256: string
  snapshotId: string
  selectedSections: PortableSectionName[]
  status: 'staged' | 'database-committed' | 'external-committed' | 'complete'
  completedDestinations: string[]
  createdAtMs: number
}
```

Worker writes all selected database sections and an import marker in one transaction. Main atomically replaces settings/assets from staged validated files, updates the journal after each destination, then marks complete and removes staging after another read-back. Startup resolves a pending journal before modules/windows: continue from verified staged bytes when safe or offer rollback from the named operational snapshot. Never silently start with a partial import.

Legacy formats supported: `allData`, `allData_v2`, `setting`, `setting_v2`, `playList`, and `playList_v2`. User APIs are always written disabled.

- [ ] **Step 4: Verify GREEN and crash matrix**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/portable-backup-import.test.js
npm run build:main
```

Expected: PASS at failures before staging, after staging, inside DB transaction, after DB commit, after each external replace, and before cleanup.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/modules/backup src/main/storage/backup/logicalImport.ts src/main/storage/backup/container.ts src/main/modules/winMain/rendererEvent/backup.ts src/main/startup/storageCoordinator.ts src/common/utils/nodejs.ts build-config/storage-electron/portable-backup-import.test.js
git commit -m "feat: import portable backups safely"
```

### Task 5: Replace the Backup UI with Explicit Options and Inspection

**Files:**
- Modify: `src/renderer/views/Setting/components/SettingBackup.vue`
- Modify: `src/renderer/utils/backupExport.ts`
- Modify: `src/renderer/utils/compositions/useBackupExport.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`
- Create: `build-config/storage/backup-ui-contract.test.js`

**Interfaces:**
- Consumes: main-process inspect/export/import APIs.
- Produces: explicit optional-section controls and pre-import summary.
- Removes: direct renderer construction/parsing of all-data payloads.

- [ ] **Step 1: Write a source-contract test**

```js
it('does not assemble allData_v2 in the renderer', () => {
  const source = fs.readFileSync('src/renderer/views/Setting/components/SettingBackup.vue', 'utf8')
  assert.doesNotMatch(source, /type:\s*['"]allData_v2['"]/)
  assert.doesNotMatch(source, /setting:\s*\{\s*\.\.\.appSetting/)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/backup-ui-contract.test.js
```

Expected: FAIL on current renderer assembly.

- [ ] **Step 3: Implement explicit UI behavior**

Export shows checkboxes for search history, recent playback, and User API scripts, all initially false. Required sections are listed in a compact summary and cannot be toggled off in this milestone. Display plain text that the file is compressed, not encrypted, and contains no account credentials.

Import first calls inspection, displays type/version/created time/available section counts/warnings, then allows selecting available optional sections. User APIs require a separate explicit checkbox and display that imported scripts start disabled. Existing playlist-only and settings-only actions continue using main-owned sanitized import/export.

- [ ] **Step 4: Verify GREEN, translations, and renderer build**

```powershell
node --test build-config/storage/backup-ui-contract.test.js
npm run build:renderer
npm run lint
```

Expected: PASS with no missing translation keys.

- [ ] **Step 5: Commit**

```powershell
git add src/renderer/views/Setting/components/SettingBackup.vue src/renderer/utils/backupExport.ts src/renderer/utils/compositions/useBackupExport.ts src/renderer/utils/ipc.ts src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json build-config/storage/backup-ui-contract.test.js
git commit -m "refactor: make backup scope explicit"
```

### Task 6: Add Five Scoped Storage-Clear Actions

**Files:**
- Create: `src/common/storage/clear.ts`
- Create: `src/main/storage/clear/service.ts`
- Create: `src/main/modules/winMain/rendererEvent/storageClear.ts`
- Create: `src/renderer/views/Setting/components/SettingStorage.vue`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/views/Setting/index.vue`
- Modify: `src/renderer/views/Setting/components/SettingOther.vue`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`
- Create: `build-config/storage/storage-clear.test.js`

**Interfaces:**
- Consumes: playback clear RPC, cache manager, local-state repository, and current recorder checkpoint.
- Produces: one strict `clearStorage()` command with component results.
- Guarantees: a clear kind cannot broaden into another ownership domain.

- [ ] **Step 1: Write semantic isolation tests for every kind**

```js
it('clearing recent preserves facts and listening totals', async() => {
  await service.clearStorage({ version: 1, kind: 'recent_playback', occurredAtMs: nowMs })
  assert.equal(repo.recentCount(), 0)
  assert.equal(repo.listeningTotalMs(), 120000)
  assert.equal(repo.sessionCount(), 2)
  assert.ok(repo.recentVisibleAfterMs() >= nowMs)
})

it('cache clear receives no durable path', async() => {
  await service.clearStorage({ version: 1, kind: 'cache' })
  assert.equal(deletedPaths.includes(authoritativeDbPath), false)
  assert.equal(deletedPaths.includes(credentialsPath), false)
  assert.equal(deletedPaths.includes(themePath), false)
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/storage-clear.test.js
```

Expected: FAIL because only unrelated individual clear buttons/current Chromium cache clear exist.

- [ ] **Step 3: Implement exact command/result types and orchestration**

```ts
export type StorageClearRequestV1 =
  | { version: 1; kind: 'cache' }
  | { version: 1; kind: 'device_state' }
  | { version: 1; kind: 'recent_playback'; occurredAtMs: number }
  | {
      version: 1
      kind: 'listening_statistics'
      occurredAtMs: number
      activeCheckpoint?: PlaybackCheckpointV1
    }
  | { version: 1; kind: 'all_playback_activity'; occurredAtMs: number }

export interface StorageClearResultV1 {
  version: 1
  kind: StorageClearRequestV1['kind']
  clearedComponents: string[]
  failures: Array<{ component: string; code: string }>
}
```

The renderer recorder flushes and supplies its latest active checkpoint before statistics clear. Device state calls playback/device reset to clear `local_state + playback_resume_state`. Recent, statistics, and all-activity delegate to their tested worker transactions. Cache delegates to `CacheManager`. A failure reports its component/code and does not trigger any broader fallback.

Move storage operations from `SettingOther.vue` into `SettingStorage.vue`. Each action has its own confirmation. Recent copy says aggregate statistics remain; all-activity copy identifies it as the privacy deletion that also removes resume/raw facts. Edited-lyric deletion remains a separate durable-content action and must not be labeled cache.

- [ ] **Step 4: Verify GREEN and UI build**

```powershell
node --test build-config/storage/storage-clear.test.js
npm run build:main
npm run build:renderer
npm run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/clear.ts src/main/storage/clear/service.ts src/main/modules/winMain/rendererEvent/storageClear.ts src/renderer/views/Setting/components/SettingStorage.vue src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/index.ts src/renderer/utils/ipc.ts src/renderer/views/Setting/index.vue src/renderer/views/Setting/components/SettingOther.vue src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json build-config/storage/storage-clear.test.js
git commit -m "feat: add scoped storage clearing actions"
```

### Task 7: Replace `data.json` with a Redacted Tombstone After a Typed-Only Startup

**Files:**
- Create: `src/main/migration/legacyData/redact.ts`
- Modify: `src/main/startup/storageCoordinator.ts`
- Modify: `src/main/modules/winMain/rendererEvent/app.ts`
- Modify: `src/main/modules/winMain/index.ts`
- Create: `build-config/storage/legacy-data-redaction.test.js`

**Interfaces:**
- Consumes: cross-artifact marker, typed startup smoke state, existing `main_window_inited` acknowledgement, vault quarantine, and operational snapshot.
- Produces: redacted tombstone plus `legacy_data_v1.redacted` marker.
- Guarantees: no source values/hashes/secrets remain in the tombstone.

- [ ] **Step 1: Write readiness and crash-resume tests**

```js
it('does nothing before a complete typed-only startup', async() => {
  assert.equal(await archiveLegacyDataAfterSuccessfulStartup(depsWithoutAck), 'not-ready')
  assert.equal(await fs.readFile(dataPath, 'utf8'), originalLegacyText)
})

it('replaces legacy data with a value-free tombstone and resumes a missing marker', async() => {
  await assert.rejects(runRedaction({ failAt: 'after-replace' }), /injected failure/)
  assert.doesNotMatch(await fs.readFile(dataPath, 'utf8'), /COOKIE_SENTINEL|futureKey|recentPlayList/)
  assert.equal(await runRedaction(), 'already-redacted')
  assert.ok(readMarker('legacy_data_v1.redacted'))
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/legacy-data-redaction.test.js
```

Expected: FAIL because legacy data remains active.

- [ ] **Step 3: Implement exact readiness and tombstone**

`main_window_inited` counts only when the same startup used typed readers/writers exclusively, all destination markers match, no legacy IPC request occurred, and the pre-migration operational snapshot verifies. Then atomically replace `data.json` with:

```json
{
  "type": "legacy_data_redacted",
  "schemaVersion": 1,
  "migratedAtMs": 0,
  "completedDomains": [
    "settings",
    "local_state",
    "playlist_metadata",
    "search_history",
    "account_profiles",
    "playback_activity"
  ]
}
```

Use the real completion time in production. Reparse and validate exact keys, scan forbidden names/known sentinels, then write the redacted marker. If the file is already a valid tombstone after a crash, write only the missing marker. Unknown legacy values remain only in the encrypted quarantine created by Phase 3.

- [ ] **Step 4: Verify GREEN**

```powershell
node --test build-config/storage/legacy-data-redaction.test.js
npm run build:main
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/main/migration/legacyData/redact.ts src/main/startup/storageCoordinator.ts src/main/modules/winMain/rendererEvent/app.ts src/main/modules/winMain/index.ts build-config/storage/legacy-data-redaction.test.js
git commit -m "feat: redact completed legacy data store"
```

### Task 8: Remove Generic Data IPC, Constants, and Dead Migration Plumbing

**Files:**
- Delete: `src/main/modules/winMain/rendererEvent/data.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/common/constants.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/main/utils/migrate.ts`
- Modify: `src/main/utils/index.ts`
- Preserve: `src/main/utils/store.ts` for remaining low-frequency stores.
- Create: `build-config/storage/legacy-data-cleanup.test.js`
- Create: `build-config/storage/storage-e2e.test.js`

**Interfaces:**
- Consumes: verified redacted marker and all typed domain services.
- Produces: no active source reference to arbitrary `data.json` operations.
- Preserves: legacy import recognition only inside allowlisted migration/backup compatibility modules.

- [ ] **Step 1: Write whole-source assertions**

```js
it('contains no active generic data IPC or store constants', () => {
  const source = readAllSourceFiles()
  assert.doesNotMatch(source, /WIN_MAIN_RENDERER_EVENT_NAME\.(get_data|save_data)/)
  assert.doesNotMatch(source, /STORE_NAMES\.DATA/)
  assert.doesNotMatch(source, /\bDATA_KEYS\b/)
})

it('allows data.json only in migration tombstone compatibility modules', () => {
  const matches = findSourceMatches(/data\.json/)
  assert.deepEqual(matches.map(item => item.file).sort(), [
    'src/main/migration/legacyData/redact.ts',
    'src/main/migration/legacyData/source.ts',
  ])
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/legacy-data-cleanup.test.js
```

Expected: FAIL on current generic plumbing.

- [ ] **Step 3: Delete only after checking the release gate**

At startup require `crossArtifactComplete`, `redacted`, verified operational snapshot, and prior typed-startup acknowledgement. Then remove renderer event registration/file, event names, `DATA_KEYS`, `STORE_NAMES.DATA`, every wrapper, and the old `migrateDataJson()` creation path. Keep `Store` for hotkeys, themes, sound effects, and User API metadata, now backed by the atomic writer.

Migration source and tombstone compatibility modules may reference the filename but cannot register active readers/writers. Portable legacy import uses container type detection, not `data.json` IPC.

- [ ] **Step 4: Add the complete end-to-end profile test**

Create a fixture with legacy settings/accounts/playback/cache, run Phase 0-5, simulate one successful typed-only startup, redact, export default/optional backup, run all five clear operations on isolated copies, and scan every JSON/container for known secrets.

```js
for (const secret of knownSecrets) {
  assert.equal((await readEveryProfileJson()).includes(secret), false)
  assert.equal((await readPortableContainer(defaultExport)).includes(secret), false)
}
assert.equal(await sqliteQuickCheck(appDbPath), 'ok')
assert.deepEqual(await sqliteForeignKeyCheck(appDbPath), [])
```

- [ ] **Step 5: Run final verification**

```powershell
node --test build-config/storage/*.test.js
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/*.test.js
node --test build-config/listening-time.test.js
npm run lint
npm run build
npm run test:main-bundle
rg -n "WIN_MAIN_RENDERER_EVENT_NAME\.(get_data|save_data)|STORE_NAMES\.DATA|\bDATA_KEYS\b" src
git status --short
```

Expected: all tests/builds pass; the source scan has no output. The final status contains only intentionally uncommitted user-owned changes, if still present.

- [ ] **Step 6: Commit**

```powershell
git add -A src/main/modules/winMain/rendererEvent/data.ts src/main/modules/winMain/rendererEvent/index.ts src/common/ipcNames.ts src/common/constants.ts src/renderer/utils/ipc.ts src/main/utils/migrate.ts src/main/utils/index.ts build-config/storage/legacy-data-cleanup.test.js build-config/storage/storage-e2e.test.js
git commit -m "chore: remove legacy data store plumbing"
```

## Final Acceptance Gate

The storage architecture is complete only when all statements are true:

1. A verified operational snapshot can recover the same profile and is retained under the fixed policy.
2. Default portable export contains every documented durable section and no excluded/secret section.
3. Optional history/recent/User API sections are off by default; imported scripts are disabled.
4. Import prevalidates every section and resumes/rolls back safely after any journaled crash point.
5. The UI states that compression is not encryption.
6. The five clear actions preserve exactly the domains outside their documented ownership.
7. `data.json` is a value-free redacted tombstone after one typed-only startup.
8. Generic `get_data/save_data`, `DATA_KEYS`, and `STORE_NAMES.DATA` no longer exist in active source.
9. Profile and portable-container scans contain no confirmed plaintext secret or music URL.
10. Full lint/build/test/database-health verification passes without staging or reverting unrelated user work.
