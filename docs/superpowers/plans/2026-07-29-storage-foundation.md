# Storage Safety Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace destructive database startup behavior with transactional, backed-up, verifiable storage initialization and provide the atomic-file and typed-IPC primitives required by every later migration.

**Architecture:** The database worker bootstraps a canonical integer migration ledger from legacy schema version `2`, creates an online backup before pending migrations, and returns a discriminated startup result instead of a nullable boolean. The main process gates module/window registration on that result, records unclean runs outside the database, and uses one queued atomic JSON writer for settings, vault files, and migration artifacts.

**Tech Stack:** Electron 37.6.1, Node.js 22+, TypeScript 5.9, `better-sqlite3` 12.6, Comlink, Electron main process APIs, and `node:test`.

## Global Constraints

- Continue using `<profileRoot>/lx.data.db`; do not rename it and do not create `activity.db`.
- Set `PRAGMA foreign_keys = ON` on every authoritative connection and preserve the single-writer WAL model.
- Only create a new authoritative database after an explicit filesystem check proves that `lx.data.db` does not exist.
- Before any pending schema migration, create and verify a SQLite online backup; never copy or rename a live DB/WAL pair as a normal backup.
- Applied migrations are immutable: a version/checksum mismatch is a recovery error.
- Validate required tables, columns, indexes, and foreign keys structurally; do not compare normalized `sqlite_master.sql` text.
- Run `quick_check` after migrations or an unclean shutdown and `foreign_key_check` after schema/data migrations.
- On authoritative failure, preserve the database and backup, reopen read-only where possible, and do not register business modules or create the normal window.
- Store timestamps as integer Unix milliseconds.
- Atomic JSON writes use a same-directory temporary file, file flush, atomic replace, read-back validation, retained last-known-valid backup, and serialized/coalesced writes.
- Do not add new callers of `get_data` or `save_data`; their removal occurs after the playback cutover.
- Preserve every unrelated user change, including the listening-time files and the concurrently modified packaging files listed in the roadmap; stage only files named by the current task.

## File Structure

- Create `src/common/storage/canonicalJson.ts`: deterministic JSON serialization and SHA-256 input normalization.
- Create `src/common/storage/validation.ts`: dependency-free bounded scalar/object validators used by later IPC contracts.
- Create `src/main/storage/atomicJsonFile.ts`: queued atomic JSON reader/writer and stale-owned-temp cleanup.
- Modify `src/main/utils/store.ts`: keep current in-memory API while routing persistence through the writer and exposing flush.
- Create `src/main/worker/dbService/migrations/types.ts`: migration and result contracts.
- Create `src/main/worker/dbService/migrations/0003_storage_foundation.ts`: authoritative marker/lifecycle schema.
- Create `src/main/worker/dbService/migrations/index.ts`: immutable ordered registry.
- Rewrite `src/main/worker/dbService/migrate.ts`: bootstrap and transactional runner.
- Create `src/main/worker/dbService/databaseBackup.ts`: SQLite online backup and verification.
- Create `src/main/worker/dbService/schemaContract.ts`: structural schema contract.
- Rewrite `src/main/worker/dbService/verifyDB.ts`: quick/FK/contract validation.
- Modify `src/main/worker/dbService/db.ts`: explicit create/open/recovery state machine.
- Modify `src/main/worker/dbService/index.ts`: expose init, close, health, marker, and app-DB methods.
- Create `src/main/startup/runState.ts`: persistent clean/unclean run marker.
- Create `src/main/startup/storageCoordinator.ts`: startup and bounded shutdown orchestration.
- Create `src/main/startup/recovery.ts`: recovery dialog adapter.
- Modify `src/main/index.ts` and `src/main/app.ts`: gate registration and remove destructive rename/recreate.
- Create `src/common/storage/contracts.ts`: initial capabilities contract.
- Create `src/main/storage/validateStorageRequest.ts`: typed request parser.
- Create `src/main/modules/winMain/rendererEvent/storage.ts`: capabilities-only typed storage endpoint.
- Modify `src/common/ipcNames.ts`, `src/main/modules/winMain/rendererEvent/index.ts`, and `src/renderer/utils/ipc.ts`: wire the endpoint.
- Create tests under `build-config/storage/` and `build-config/storage-electron/`.

---

### Task 1: Add Storage Test Commands and Pure Shared Primitives

**Files:**
- Create: `src/common/storage/canonicalJson.ts`
- Create: `src/common/storage/validation.ts`
- Create: `build-config/storage/canonical-json.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: JSON-compatible values only.
- Produces: `canonicalJson(value: JsonValue): string`, `sha256Canonical(value: JsonValue): string`, `assertRecord`, `assertBoundedString`, `assertFiniteInteger`, and `assertJsonByteSize`.
- Produces: `npm run test:storage` and `npm run test:storage:electron`.

- [ ] **Step 1: Add failing canonicalization and boundary tests**

Create `build-config/storage/canonical-json.test.js`:

```js
const assert = require('node:assert/strict')
const { describe, it } = require('node:test')

describe('storage canonical JSON', async() => {
  const { canonicalJson, sha256Canonical } = await import('../../src/common/storage/canonicalJson.ts')
  const { assertBoundedString, assertFiniteInteger, assertJsonByteSize } = await import('../../src/common/storage/validation.ts')

  it('sorts object keys recursively without reordering arrays', () => {
    const left = { z: [{ b: 2, a: 1 }], a: true }
    const right = { a: true, z: [{ a: 1, b: 2 }] }
    assert.equal(canonicalJson(left), canonicalJson(right))
    assert.equal(sha256Canonical(left), sha256Canonical(right))
  })

  it('rejects invalid scalar and payload limits', () => {
    assert.throws(() => assertBoundedString('', 'term', 1, 200), /term/)
    assert.throws(() => assertFiniteInteger(1.5, 'sequence', 0, 10), /sequence/)
    assert.throws(() => assertJsonByteSize({ value: 'x'.repeat(20) }, 'payload', 8), /payload/)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --test build-config/storage/canonical-json.test.js
```

Expected: FAIL because both modules are missing.

- [ ] **Step 3: Implement deterministic JSON and bounded validators**

Use these public signatures:

```ts
import { createHash } from 'node:crypto'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

const normalize = (value: JsonValue): JsonValue => {
  if (Array.isArray(value)) return value.map(normalize)
  if (value == null || typeof value != 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
}

export const canonicalJson = (value: JsonValue): string => JSON.stringify(normalize(value))
export const sha256Canonical = (value: JsonValue): string =>
  createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
```

`validation.ts` must reject non-plain objects, non-finite numbers, overlong strings, and JSON values over their UTF-8 byte limit. Error messages contain field names but never values.

- [ ] **Step 4: Add test scripts and verify GREEN**

Add:

```json
{
  "test:storage": "node --test build-config/storage/*.test.js",
  "test:storage:electron": "cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/*.test.js"
}
```

Run:

```powershell
npm run test:storage
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add package.json src/common/storage/canonicalJson.ts src/common/storage/validation.ts build-config/storage/canonical-json.test.js
git commit -m "test: add storage contract harness"
```

### Task 2: Add the Atomic JSON File Writer

**Files:**
- Create: `src/main/storage/atomicJsonFile.ts`
- Modify: `src/main/utils/store.ts`
- Create: `build-config/storage/atomic-json-file.test.js`

**Interfaces:**
- Consumes: `canonicalJson` from Task 1 and an injected validator.
- Produces: `createAtomicJsonFile<T>()`, `AtomicJsonFile<T>`, `flushStores()`, and `cleanupStoreTemps()`.
- Preserves: synchronous `Store.get/has/set/override` in-memory behavior for existing callers.

- [ ] **Step 1: Write failure, backup, and coalescing tests**

Create a temporary-directory fixture and these cases:

```js
it('does not replace the destination when temp fsync fails', async() => {
  await fs.writeFile(target, '{"value":1}')
  const file = createAtomicJsonFile({ filePath: target, validate: isValue, fs: failingSyncFs })
  await assert.rejects(file.replace({ value: 2 }), /injected fsync failure/)
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { value: 1 })
})

it('coalesces queued snapshots and resolves every waiter after the newest write', async() => {
  const file = createAtomicJsonFile({ filePath: target, validate: isCounter, fs: delayedFs })
  await Promise.all([file.replace({ n: 1 }), file.replace({ n: 2 }), file.replace({ n: 3 })])
  assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { n: 3 })
  assert.equal(delayedFs.replacements, 2)
})

it('retains the last parsed valid document and removes only owned stale temps', async() => {
  await fs.writeFile(target, '{"n":1}')
  await fs.writeFile(`${target}.unowned`, 'keep')
  await file.replace({ n: 2 })
  assert.deepEqual(JSON.parse(await fs.readFile(`${target}.previous`, 'utf8')), { n: 1 })
  await file.cleanupOwnedTemps()
  assert.equal(await exists(`${target}.unowned`), true)
})
```

- [ ] **Step 2: Run the atomic-file test and verify RED**

Run:

```powershell
node --test build-config/storage/atomic-json-file.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement the exact writer contract**

```ts
export interface AtomicJsonFile<T> {
  read(): Promise<T | null>
  stage(value: T, label?: 'next'): Promise<AtomicJsonStage>
  commit(stage: AtomicJsonStage): Promise<{ fileSha256: string }>
  replace(value: T): Promise<{ fileSha256: string }>
  flush(): Promise<void>
  cleanupOwnedTemps(): Promise<void>
}

export function createAtomicJsonFile<T>(options: {
  filePath: string
  validate: (value: unknown) => value is T
  mode?: number
  fs?: AtomicFileSystem
}): AtomicJsonFile<T>
```

For each persisted generation, serialize exactly once, write `<basename>.owned-tmp-<pid>-<counter>` in the destination directory (or `<basename>.next` for the explicitly requested migration stage), call `FileHandle.sync()`, close it, validate the serialized bytes, and compute its SHA-256. `commit()` verifies the stage still has the recorded identity/hash, preserves a previously parsed/validated destination as `.previous`, renames the stage to the destination, read-backs the destination, and best-effort syncs the parent directory. `replace()` is `stage()` plus `commit()`. The queue keeps one pending newest snapshot; a write arriving during I/O replaces the pending snapshot and shares its completion promise. Cleanup matches only the exact owned prefix in the exact parent directory and never removes a `.next` file referenced by an active migration marker.

Adapt `Store` so `set()` and `override()` update memory immediately, enqueue a complete cloned snapshot, and retain any asynchronous error for `Store.flush()`. Add:

```ts
export const flushStores = async(): Promise<void> => {
  await Promise.all(Object.values(stores).map(async store => store.flush()))
}

export const cleanupStoreTemps = async(): Promise<void> => {
  await Promise.all(Object.values(stores).map(async store => store.cleanupOwnedTemps()))
}
```

Do not rename corrupt JSON automatically in this task. A caller that cannot validate a durable file must surface a recovery error; `clearInvalidConfig=true` remains limited to explicitly resettable files until their later typed migration.

- [ ] **Step 4: Verify GREEN and existing bundle behavior**

Run:

```powershell
node --test build-config/storage/atomic-json-file.test.js
npm run build:main
```

Expected: both pass.

- [ ] **Step 5: Commit**

```powershell
git add src/main/storage/atomicJsonFile.ts src/main/utils/store.ts build-config/storage/atomic-json-file.test.js
git commit -m "feat: add atomic JSON persistence"
```

### Task 3: Replace the Legacy Version Switch with Transactional Migrations

**Files:**
- Create: `src/main/worker/dbService/migrations/types.ts`
- Create: `src/main/worker/dbService/migrations/0003_storage_foundation.ts`
- Create: `src/main/worker/dbService/migrations/index.ts`
- Rewrite: `src/main/worker/dbService/migrate.ts`
- Modify: `src/main/worker/dbService/tables.ts`
- Modify: `src/main/worker/dbService/db.ts`
- Create: `build-config/storage-electron/migration-runner.test.js`

**Interfaces:**
- Consumes: existing `db_info.version = '1' | '2'`, where current databases normalize to baseline `2`.
- Produces: `SchemaMigration`, `getPendingMigrations()`, `runMigrations()`, `getSchemaVersion()`, `getMigrationMarker()`, and `putMigrationMarker()`.
- Produces: authoritative schema version `3`.

- [ ] **Step 1: Write rollback, checksum, and bridge tests**

```js
it('bridges legacy version 2 and applies all pending migrations atomically', () => {
  const db = createLegacyV2Database()
  const result = runMigrations(db, [migration3], { now: () => 1000 })
  assert.deepEqual(result, { fromVersion: 2, toVersion: 3, applied: [3] })
  assert.equal(db.prepare('select name from schema_migrations where version=3').get().name, 'storage_foundation')
})

it('rolls back every pending migration when a later migration fails', () => {
  const db = createLegacyV2Database()
  assert.throws(() => runMigrations(db, [migration3, throwingMigration4]))
  assert.equal(hasTable(db, 'migration_markers'), false)
  assert.equal(hasTable(db, 'schema_migrations'), false)
})

it('rejects a changed checksum for an applied migration', () => {
  const db = createLegacyV2Database()
  runMigrations(db, [migration3])
  assert.throws(() => runMigrations(db, [{ ...migration3, checksum: '0'.repeat(64) }]), /checksum/)
})
```

- [ ] **Step 2: Run under the Electron ABI and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/migration-runner.test.js
```

Expected: FAIL because the migration ledger does not exist.

- [ ] **Step 3: Implement the migration registry and transaction**

Use these contracts:

```ts
export interface SchemaMigration {
  version: number
  name: string
  checksum: string
  up(db: Database.Database): void
}

export interface MigrationRunResult {
  fromVersion: number
  toVersion: number
  applied: number[]
}

export function runMigrations(
  db: Database.Database,
  migrations: readonly SchemaMigration[],
  options?: {
    now?: () => number
    targetSchemaVersion?: number
  },
): MigrationRunResult
```

The runner accepts an optional inclusive `targetSchemaVersion`; this is required later to stop at version `6`, complete the external cache cutover, and then apply version `7`. The bootstrap transaction creates `schema_migrations` only after validating that the legacy table set and `db_info.version` are supported. Migration `3` creates:

```sql
CREATE TABLE migration_markers (
  name TEXT PRIMARY KEY,
  source_sha256 TEXT NOT NULL CHECK(length(source_sha256) = 64),
  completed_at_ms INTEGER NOT NULL CHECK(completed_at_ms >= 0),
  details_json TEXT NOT NULL CHECK(json_valid(details_json))
);
```

The runner rejects duplicate/non-contiguous versions, computes each checksum from a stable migration source string, uses one `db.transaction()` for bootstrap plus the selected pending set, and updates legacy `db_info.version` only as a compatibility mirror after the ledger insert succeeds. A lower target may stop only at a contiguous boundary; a later invocation continues from that exact version.

Add `getAppDB()` now and retain `getDB()` as a compatibility alias. All new modules use `getAppDB()`; cache separation removes the alias after old modules are assigned explicitly.

- [ ] **Step 4: Verify migration tests pass**

```powershell
npm run test:storage:electron -- --test-name-pattern="migration"
```

Expected: PASS for bridge, rollback, idempotence, order, and checksum cases.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/migrations src/main/worker/dbService/migrate.ts src/main/worker/dbService/tables.ts src/main/worker/dbService/db.ts build-config/storage-electron/migration-runner.test.js
git commit -m "feat: add transactional database migrations"
```

### Task 4: Add Online Backup, Structural Verification, and Read-Only Recovery

**Files:**
- Create: `src/main/worker/dbService/databaseBackup.ts`
- Create: `src/main/worker/dbService/schemaContract.ts`
- Rewrite: `src/main/worker/dbService/verifyDB.ts`
- Rewrite: `src/main/worker/dbService/db.ts`
- Modify: `src/main/worker/dbService/index.ts`
- Create: `build-config/storage-electron/database-recovery.test.js`

**Interfaces:**
- Consumes: migration registry from Task 3.
- Produces: `DatabaseStartupResult`, `createOnlineBackup()`, `verifyDatabase()`, `close()`, and `getDatabaseHealth()`.
- Guarantees: an existing invalid file is never replaced with an empty database.

- [ ] **Step 1: Write WAL-backup and non-destructive recovery tests**

```js
it('backs up committed rows still present in WAL', async() => {
  const db = new Database(source)
  db.pragma('journal_mode = WAL')
  db.exec('create table items(id integer primary key); insert into items values (1)')
  await createOnlineBackup(db, destination)
  const restored = new Database(destination, { readonly: true })
  assert.equal(restored.prepare('select count(*) count from items').get().count, 1)
  assert.equal(restored.pragma('quick_check', { simple: true }), 'ok')
})

it('returns recovery for an existing invalid database without changing its bytes', async() => {
  await fs.writeFile(databasePath, 'not sqlite')
  const before = await fs.readFile(databasePath)
  const result = await init({ dataPath, backupDir, previousShutdownWasClean: true })
  assert.equal(result.status, 'recovery')
  assert.deepEqual(await fs.readFile(databasePath), before)
  assert.equal(await exists(`${databasePath}.recreated`), false)
})
```

- [ ] **Step 2: Run the recovery test and verify RED**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/database-recovery.test.js
```

Expected: FAIL because current `init()` treats every open error as a missing file.

- [ ] **Step 3: Implement explicit startup states**

```ts
export type DatabaseRecoveryReason =
  | 'open_failed'
  | 'backup_failed'
  | 'migration_failed'
  | 'schema_invalid'
  | 'quick_check_failed'
  | 'foreign_key_check_failed'

export type DatabaseStartupResult =
  | {
      status: 'ready'
      existed: boolean
      schemaVersion: number
      migratedVersions: number[]
      backupPath: string | null
    }
  | {
      status: 'recovery'
      reason: DatabaseRecoveryReason
      databasePath: string
      backupPath: string | null
      diagnostics: string[]
    }

export async function init(options: {
  dataPath: string
  backupDir: string
  previousShutdownWasClean: boolean
  targetSchemaVersion?: number
}): Promise<DatabaseStartupResult>
```

Initialization order is exact: resolve and contain paths; test existence; open or create; set WAL and foreign keys; inspect pending migrations; online-backup when pending; run migrations; validate structural contract; run checks required by migration/unclean state; return ready. Any failure closes the write connection, attempts `readonly: true, fileMustExist: true`, stores only sanitized issue codes, and returns recovery.

`schemaContract.ts` describes required table columns, unique/index properties, and foreign keys as data. `verifyDatabase()` queries `table_info`, `index_list`, `index_info`, and `foreign_key_list`. It accepts compatible DDL formatting and rejects missing/weak constraints.

- [ ] **Step 4: Verify GREEN and the worker bundle**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/database-recovery.test.js
npm run build:main
npm run test:main-bundle
```

Expected: PASS; the production build still emits `dbService.worker.js`.

- [ ] **Step 5: Commit**

```powershell
git add src/main/worker/dbService/databaseBackup.ts src/main/worker/dbService/schemaContract.ts src/main/worker/dbService/verifyDB.ts src/main/worker/dbService/db.ts src/main/worker/dbService/index.ts build-config/storage-electron/database-recovery.test.js
git commit -m "feat: add database backup and recovery validation"
```

### Task 5: Gate Startup and Record Clean Shutdown

**Files:**
- Create: `src/main/startup/runState.ts`
- Create: `src/main/startup/storageCoordinator.ts`
- Create: `src/main/startup/recovery.ts`
- Modify: `src/main/index.ts`
- Modify: `src/main/app.ts`
- Modify: `src/main/types/app.d.ts`
- Create: `build-config/storage/startup-coordinator.test.js`

**Interfaces:**
- Consumes: `DatabaseStartupResult`, `flushStores()`, and existing single-instance lock.
- Produces: `StorageCoordinator.start()`, `StorageCoordinator.shutdown()`, and `StorageStartupOutcome`.
- Guarantees: business services and windows cannot observe a partially migrated profile.

- [ ] **Step 1: Write startup-order and recovery-isolation tests**

```js
it('starts business modules only after storage is ready', async() => {
  const coordinator = createStorageCoordinator(fakeDeps({ dbStatus: 'ready' }))
  assert.deepEqual(await coordinator.start(), { status: 'ready', schemaVersion: 3 })
  assert.deepEqual(calls, [
    'run-state:unclean', 'db:init', 'migration-hooks', 'settings:init', 'modules:register', 'app:inited',
  ])
})

it('does not register modules or create a window in recovery mode', async() => {
  const result = await createStorageCoordinator(fakeDeps({ dbStatus: 'recovery' })).start()
  assert.equal(result.status, 'recovery')
  assert.equal(result.target.kind, 'database')
  assert.deepEqual(calls, ['run-state:unclean', 'db:init', 'recovery:show'])
})

it('marks clean only after flushers and database close complete', async() => {
  await coordinator.shutdown()
  assert.deepEqual(calls, ['activity:flush', 'stores:flush', 'db:close', 'run-state:clean'])
})
```

- [ ] **Step 2: Run the coordinator test and verify RED**

```powershell
node --test build-config/storage/startup-coordinator.test.js
```

Expected: FAIL because startup currently retries by renaming the database.

- [ ] **Step 3: Implement the coordinator and remove destructive recovery**

```ts
export type StorageRecoveryTarget =
  | {
      kind: 'database'
      databasePath: string
      backupPath: string | null
      diagnostics: string[]
    }
  | {
      kind: 'legacy-json'
      sourcePath: string
      candidatePreviousPath: string | null
    }
  | {
      kind: 'external-migration'
      component: 'credentials' | 'cache'
      affectedPath: string | null
      diagnostics: string[]
    }

export type StorageStartupOutcome =
  | { status: 'ready'; schemaVersion: number }
  | { status: 'recovery'; reason: string; target: StorageRecoveryTarget }
  | { status: 'fatal'; reason: string }

export interface StorageCoordinator {
  start(): Promise<StorageStartupOutcome>
  registerShutdownFlusher(name: string, flush: () => Promise<void>): () => void
  shutdown(): Promise<void>
}
```

Map `DatabaseStartupResult.status='recovery'` to `target.kind='database'`. Later migration hooks use `legacy-json` for a preserved invalid legacy source and `external-migration` for a verified destination/cutover failure. `recovery.ts` switches on `target.kind`; it displays only sanitized paths/diagnostic codes and never reads or logs the affected file contents.

`runState.ts` stores `{ version: 1, clean: boolean, startedAtMs, completedAtMs }` under `<runtimeRoot>/run-state.v1.json` using Task 2. `start()` reads the prior value before atomically writing `clean:false`. `shutdown()` runs registered flushers with a 3,000 ms overall bound, flushes remaining stores, closes the DB worker, then writes `clean:true`. Timeout details contain flusher names but no payloads.

Delete `backupDB()` and the `dbFileExists === null` branch from `src/main/app.ts`. Change the top-level flow so `registerModules()` and `global.lx.event_app.app_inited()` execute only after `{status:'ready'}`. Recovery presents `Open data folder` and `Quit`; it never calls `init()` a second time.

- [ ] **Step 4: Verify startup tests and main build**

```powershell
node --test build-config/storage/startup-coordinator.test.js
npm run build:main
```

Expected: PASS and no `renameSync` recovery path remains in `src/main/app.ts`.

- [ ] **Step 5: Commit**

```powershell
git add src/main/startup src/main/index.ts src/main/app.ts src/main/types/app.d.ts build-config/storage/startup-coordinator.test.js
git commit -m "feat: gate startup on storage readiness"
```

### Task 6: Add the First Typed Storage IPC Contract

**Files:**
- Create: `src/common/storage/contracts.ts`
- Create: `src/main/storage/validateStorageRequest.ts`
- Create: `src/main/modules/winMain/rendererEvent/storage.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Create: `build-config/storage/storage-contracts.test.js`

**Interfaces:**
- Consumes: database schema version and a secure-persistence capability supplied by the main process.
- Produces: `storage_capabilities_get` only; later plans add domain-specific endpoints.
- Does not replace: legacy `get_data/save_data` yet.

- [ ] **Step 1: Write strict parsing tests**

```js
it('accepts only the versioned capabilities request', () => {
  assert.deepEqual(parseStorageRequest({ version: 1, type: 'capabilities.get' }), {
    version: 1,
    type: 'capabilities.get',
  })
  assert.throws(() => parseStorageRequest({ version: 1, type: 'file.read', path: 'data.json' }))
  assert.throws(() => parseStorageRequest({ version: 2, type: 'capabilities.get' }))
})
```

- [ ] **Step 2: Run and verify RED**

```powershell
node --test build-config/storage/storage-contracts.test.js
```

Expected: FAIL because the parser is absent.

- [ ] **Step 3: Implement exact request and response types**

```ts
export type StorageRequestV1 = { version: 1; type: 'capabilities.get' }

export interface StorageCapabilitiesV1 {
  version: 1
  schemaVersion: number
  securePersistence: 'available' | 'memory-only'
  recoveryMode: boolean
}

export const getStorageCapabilities = (): Promise<StorageCapabilitiesV1> =>
  rendererInvoke(WIN_MAIN_RENDERER_EVENT_NAME.storage_capabilities_get)
```

The main handler ignores no extra fields: parse a plain object, assert exactly `version` and `type`, and reject unknown keys. The renderer cannot supply a key, path, table, SQL fragment, or unrestricted JSON value.

- [ ] **Step 4: Verify GREEN and scan for new generic callers**

```powershell
node --test build-config/storage/storage-contracts.test.js
rg -n "WIN_MAIN_RENDERER_EVENT_NAME\.(get_data|save_data)" src
npm run build:main
npm run build:renderer
```

Expected: the test/builds pass; the `rg` output is only the pre-existing legacy call sites documented by the design.

- [ ] **Step 5: Commit**

```powershell
git add src/common/storage/contracts.ts src/main/storage/validateStorageRequest.ts src/main/modules/winMain/rendererEvent/storage.ts src/common/ipcNames.ts src/main/modules/winMain/rendererEvent/index.ts src/renderer/utils/ipc.ts build-config/storage/storage-contracts.test.js
git commit -m "feat: add validated storage IPC foundation"
```

### Task 7: Run the Foundation Failure Matrix

**Files:**
- Create: `build-config/storage-electron/storage-foundation.integration.test.js`
- Modify: `docs/superpowers/specs/2026-07-29-storage-architecture-design.md` only if observed implementation constraints require an approved correction.

**Interfaces:**
- Consumes: all Task 1-6 outputs.
- Produces: a release gate for the credential plan.

- [ ] **Step 1: Add crash-point integration cases**

Cover these exact cases in one table-driven test: before backup, after backup, inside migration 3, after migration commit, before structural validation, corrupt existing DB, unclean run with valid DB, quick-check failure, foreign-key failure, and atomic JSON failure before/after rename. For every pre-commit failure, compare SHA-256 of the original DB and verify the backup path remains readable.

```js
for (const failAt of failurePoints) {
  await t.test(failAt, async() => {
    const result = await runFixture({ failAt })
    assert.equal(result.status, 'recovery')
    assert.equal(await sha256(databasePath), originalSha256)
    assert.equal(await sqliteQuickCheck(result.backupPath), 'ok')
  })
}
```

- [ ] **Step 2: Run the focused matrix**

```powershell
cross-env ELECTRON_RUN_AS_NODE=1 electron --test build-config/storage-electron/storage-foundation.integration.test.js
```

Expected: PASS.

- [ ] **Step 3: Run the complete foundation verification**

```powershell
npm run test:storage
npm run test:storage:electron
npm run lint
npm run build:main
npm run build:renderer
npm run test:main-bundle
git status --short
```

Expected: all commands pass. The final status still shows the two pre-existing listening-time files separately unless the user has handled them.

- [ ] **Step 4: Commit the integration gate**

```powershell
git add build-config/storage-electron/storage-foundation.integration.test.js
git commit -m "test: verify storage foundation recovery"
```

## Foundation Acceptance Gate

Do not start credential migration until all statements are true:

1. An existing unreadable or structurally invalid `lx.data.db` cannot trigger empty database creation.
2. Every pending authoritative migration has a verified online backup.
3. Migration order and checksum drift are rejected transactionally.
4. `quick_check`, `foreign_key_check`, and structural verification have explicit results.
5. Recovery mode does not register business modules or create the normal window.
6. Atomic JSON writes survive injected failures without losing the last valid document.
7. Shutdown marks clean only after registered activity/store flushers and DB close complete.
