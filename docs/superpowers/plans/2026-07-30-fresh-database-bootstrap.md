# Fresh Database Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Initialize a missing `lx.data.db` at the latest registered schema without creating a migration backup or reporting schema bootstrap as an existing-database migration.

**Architecture:** Add an atomic bootstrap operation beside the existing migration runner. It creates the legacy baseline and applies the canonical migration registry in one transaction, while startup keeps its verified backup path exclusively for existing databases with pending migrations.

**Tech Stack:** TypeScript, Electron, better-sqlite3, Node.js test runner, PowerShell.

## Global Constraints

- Work from the commit containing this plan in an isolated worktree so the staged `account_profiles` work in `.worktrees/storage-full-migration` remains untouched.
- Do not modify portable-path discovery, `run-state.v1.json`, backup retention, or live profile data.
- The ordered migration registry remains the only source for post-v2 schema changes; do not add a separate current-schema SQL snapshot.
- A missing database must return `existed: false`, `migratedVersions: []`, and `backupPath: null`.
- An existing old database must still receive a verified backup before its first migration write.
- Every production change follows a recorded RED/GREEN TDD cycle.

---

### Task 1: Atomic Current-Schema Bootstrap

**Files:**
- Modify: `src/main/worker/dbService/migrate.ts`
- Test: `build-config/storage-electron/migration-runner.test.js`

**Interfaces:**
- Consumes: `tables`, `LEGACY_DB_VERSION`, `SchemaMigration[]`, and the same `{ now?, targetSchemaVersion? }` options accepted by `runMigrations`.
- Produces: `bootstrapDatabaseSchema(db, registry, options?): MigrationRunResult`.
- Preserves: `runMigrations(db, registry, options?): MigrationRunResult` and all existing migration validation behavior.

- [ ] **Step 1: Write failing bootstrap tests**

Import `bootstrapDatabaseSchema` in `migration-runner.test.js` and add tests equivalent to:

```js
it('bootstraps a missing database to the requested registry target atomically', () => {
  const db = new Database(':memory:')
  databases.push(db)
  const registry = [
    migration3,
    createMigration(4, 'bootstrap_four', database => {
      database.exec('CREATE TABLE bootstrap_four (id INTEGER PRIMARY KEY)')
    }),
  ]

  const result = bootstrapDatabaseSchema(db, registry, { now: () => 1234 })

  assert.deepEqual(result, { fromVersion: 2, toVersion: 4, applied: [3, 4] })
  assert.equal(getSchemaVersion(db), 4)
  assert.equal(hasObject(db, 'bootstrap_four'), true)
  assert.deepEqual(readLedger(db).map(row => [row.version, row.name]), [
    [3, 'storage_foundation'],
    [4, 'bootstrap_four'],
  ])
})

it('rolls back the baseline and ledger when fresh bootstrap fails', () => {
  const db = new Database(':memory:')
  databases.push(db)
  const failing = createMigration(4, 'bootstrap_failure', database => {
    database.exec('CREATE TABLE bootstrap_partial (id INTEGER PRIMARY KEY)')
    throw new Error('injected bootstrap failure')
  })

  assert.throws(
    () => bootstrapDatabaseSchema(db, [migration3, failing], { now: () => 1234 }),
    /injected bootstrap failure/,
  )
  assert.equal(hasObject(db, 'db_info'), false)
  assert.equal(hasObject(db, 'schema_migrations'), false)
  assert.equal(hasObject(db, 'migration_markers'), false)
  assert.equal(hasObject(db, 'bootstrap_partial'), false)
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
./node_modules/.bin/cross-env.cmd ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd --test build-config/storage-electron/migration-runner.test.js
```

Expected: FAIL because `bootstrapDatabaseSchema` is not exported or callable. Confirm the failure occurs before any production edit.

- [ ] **Step 3: Implement the minimal atomic bootstrap**

In `migrate.ts`, import `LEGACY_DB_VERSION` and extract the current transaction body into a non-exported operation shared by `runMigrations` and bootstrap:

```ts
type MigrationOptions = { now?: () => number, targetSchemaVersion?: number }

const applyMigrations = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: MigrationOptions,
): MigrationRunResult => {
  validateRegistry(registry)
  const pending = getPendingMigrations(db, registry, options)
  const fromVersion = getSchemaVersion(db)
  let toVersion = fromVersion
  const appliedVersions: number[] = []
  if (pending.length == 0) return { fromVersion, toVersion, applied: appliedVersions }

  const applied = readAppliedMigrations(db)
  if (applied.length == 0) {
    const legacyVersion = readLegacyVersion(db)
    validateLegacySchema(db, legacyVersion)
    if (legacyVersion == 1 && !hasTable(db, 'dislike_list')) db.exec(tables.get('dislike_list')!)
    if (!hasTable(db, 'schema_migrations')) db.exec(createLedgerSql)
  }

  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)',
  )
  const updateMirror = db.prepare('UPDATE db_info SET field_value = ? WHERE field_name = \'version\'')
  for (const migration of pending) {
    migration.up(db)
    const appliedAtMs = (options?.now ?? Date.now)()
    if (!Number.isSafeInteger(appliedAtMs) || appliedAtMs < 0) {
      throw new Error(`Migration ${migration.version} produced an invalid applied timestamp`)
    }
    insert.run(migration.version, migration.name, migration.checksum, appliedAtMs)
    if (updateMirror.run(String(migration.version)).changes != 1) {
      throw new Error(`Migration ${migration.version} could not update the legacy version mirror`)
    }
    appliedVersions.push(migration.version)
    toVersion = migration.version
  }
  return { fromVersion, toVersion, applied: appliedVersions }
}

export const runMigrations = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: MigrationOptions,
): MigrationRunResult => db.transaction(() => applyMigrations(db, registry, options))()

export const bootstrapDatabaseSchema = (
  db: Database.Database,
  registry: readonly SchemaMigration[],
  options?: MigrationOptions,
): MigrationRunResult => db.transaction(() => {
  db.exec(`
    ${Array.from(tables.values()).join('\n')}
    INSERT INTO "main"."db_info" ("field_name", "field_value")
    VALUES ('version', '${LEGACY_DB_VERSION}');
  `)
  return applyMigrations(db, registry, options)
})()
```

Do not catch migration errors in this helper; the outer transaction must receive the exception and roll back every baseline and migration write.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 command again. Expected: all `migration-runner.test.js` tests pass, including both new bootstrap tests.

- [ ] **Step 5: Check the Task 1 diff**

Run:

```powershell
git diff --check
git diff -- src/main/worker/dbService/migrate.ts build-config/storage-electron/migration-runner.test.js
```

Confirm no unrelated files changed and the old `runMigrations` tests retain their prior behavior.

---

### Task 2: Route Missing Databases Around Backup

**Files:**
- Modify: `src/main/worker/dbService/db.ts`
- Modify: `build-config/storage-electron/migration-runner.test.js`
- Modify: `build-config/storage-electron/database-recovery.test.js`

**Interfaces:**
- Consumes: `bootstrapDatabaseSchema` from Task 1 and the existing `prepareDatabaseTarget(...).existed` result.
- Produces: unchanged `DatabaseStartupResult` shape with corrected fresh-start values.
- Preserves: online backup, recovery reasons, packaged native binding, integrity verification, and migration order for existing databases.

- [ ] **Step 1: Replace the fresh-backup expectations with failing fresh-bootstrap expectations**

Update the fresh startup tests to assert:

```js
assert.equal(result.status, 'ready')
assert.equal(result.existed, false)
assert.deepEqual(result.migratedVersions, [])
assert.equal(result.backupPath, null)
assert.equal(fs.existsSync(paths.backupDir), false)
```

Load `db.ts` with an injected backup module whose `createOnlineBackup` increments a counter and throws. Assert the counter stays zero, proving a fresh target never reaches the backup boundary.

Inject `verifyDatabase` around the real verifier and assert fresh startup passes:

```js
{ runQuickCheck: true, runForeignKeyCheck: true }
```

In `migration-runner.test.js`, replace the fixed v3 fresh result with the last registered migration version and assert every registry entry appears in `schema_migrations`. This proves bootstrap follows the registry rather than a hard-coded latest version.

For backup-specific startup tests (`packaged binding`, observable `backup -> migration -> verify` order, backup failure, invalid backup candidate, and backup-name collision), create a valid existing v2 database before `init()`. These tests must continue exercising the existing-database path after fresh startup stops backing up.

- [ ] **Step 2: Run the two focused startup suites and verify RED**

Run:

```powershell
./node_modules/.bin/cross-env.cmd ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron.cmd --test build-config/storage-electron/migration-runner.test.js build-config/storage-electron/database-recovery.test.js
```

Expected: FAIL because current startup still creates an empty v2 database, allocates a backup, reports applied migration versions, and does not force both integrity checks based on `existed == false`.

- [ ] **Step 3: Implement the fresh startup branch**

In `db.ts`:

1. Remove local baseline schema construction and its direct `tables`/`LEGACY_DB_VERSION` imports.
2. After opening the reserved target and applying `foreign_keys = ON` and `journal_mode = WAL`, call `bootstrapDatabaseSchema` only when `existed == false`.
3. Map bootstrap exceptions to the sanitized existing `migration_failed` recovery result with a stable `migration.bootstrap_failed` diagnostic and `backupPath: null`.
4. Plan pending migrations after bootstrap. A successful fresh bootstrap must have no pending migrations.
5. Guard backup creation with `existed && pending.length > 0`.
6. Keep `migratedVersions` populated only by `runMigrations` on the existing-database path.
7. Verify fresh databases fully:

```ts
const needsIntegrityChecks = !existed || migratedVersions.length > 0 || !options.previousShutdownWasClean
verification = verifyDatabase(localWriteDb, {
  runQuickCheck: needsIntegrityChecks,
  runForeignKeyCheck: needsIntegrityChecks,
})
```

Do not create `backupDir` anywhere on the fresh path.

- [ ] **Step 4: Run the focused startup suites and verify GREEN**

Run the Task 2 command again. Expected: both suites pass with no failed tests.

- [ ] **Step 5: Run storage regression suites**

Run:

```powershell
npm run test:storage
npm run test:storage:electron
```

Expected: both commands exit 0. Any test that relied on a fresh database producing a backup must be corrected to seed an existing v2 database rather than weakening the new behavior.

- [ ] **Step 6: Run lint and the main-process build**

Run:

```powershell
./node_modules/.bin/eslint.cmd --ext .ts,.js src/main/worker/dbService/db.ts src/main/worker/dbService/migrate.ts build-config/storage-electron/migration-runner.test.js build-config/storage-electron/database-recovery.test.js
npm run build:main
```

Expected: lint and build both exit 0.

- [ ] **Step 7: Perform final requirement verification**

Run a final focused test command after all edits, then inspect:

```powershell
git diff --check
git status --short
git diff --stat
```

Confirm the final evidence covers: no fresh backup call/artifact, full fresh integrity verification, latest registry schema and ledger, unchanged existing-v2 backup behavior, and unchanged existing-current startup behavior.
