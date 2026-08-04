# Portable Fail-Closed Final Review Remediation Design

**Date:** 2026-08-03
**Status:** Approved direction; written-spec review pending
**Branch:** `codex/storage-architecture-completion`
**Review base:** `c0957a7120a08baf9d05a58b018572f422eaf6a5`
**Decision:** Preserve NTFS, FAT32, and exFAT support and remove every
production hard-link dependency.

## Context

The final whole-branch review of the Phase 4 storage architecture found one
data-destructive portable-source retirement race and seven Important contract
gaps. One gap exposed a direct conflict between the Task 10 backup decision and
the portable filesystem contract:

- Task 10 selected exclusive hard-link publication and retained the random
  staging hard link to avoid clobbering a raced deterministic backup.
- The portable filesystem contract requires production behavior to work on
  NTFS, FAT32, and exFAT without hard links.

The user selected portable compatibility. This design supersedes the Task 10
hard-link publication decision while preserving its safety goals: no clobber,
no selection among ambiguous artifacts, no automatic deletion of unknown
nodes, and no schema cutover without a verified backup when one is required.

## Scope

This remediation covers only the confirmed final-review blockers:

1. Portable source retirement target-swap deletion.
2. Theme stage publication and cleanup races.
3. Cache, run-temp, and guarded migration stage pathname deletion races.
4. Production hard-link dependencies in migration locks, theme publication,
   and database backup publication.
5. Backup allocation during a fresh database bootstrap.
6. Linked or junctioned storage roots accepted before Electron path setup.
7. Unregistered Electron `defaultSession` consumers.
8. Late scoped URL writes after logout or account replacement.

The existing deferred Minor findings stay non-blocking and are not expanded
into this fix wave. Phase 5 backup/export UI, retained-artifact cleanup UI, and
general legacy cleanup remain out of scope.

The dedicated migration lease coordinates early migration before Electron's
application lock is available; afterward, the application single-instance lock
remains the supported writer-coordination boundary. The design covers
application-owned concurrency and replacements at every validated mutation
boundary. It does not claim to defeat an external process that continuously
mutates an already open file handle; any identity or content change the
application observes still fails closed.

## Global Invariants

- Production code must contain no `fs.link`, `fs.linkSync`, or equivalent
  required hard-link operation.
- Correctness must not depend on hard-link or directory-fsync support.
- A mutable stable pathname is never recursively removed or unlinked merely
  because it passed an earlier identity check.
- A node that cannot be proven to be the operation's owned node is retained and
  the operation fails closed.
- The exact allowlisted empty migration-lock directory is protocol state rather
  than a payload. Only that empty state may be reclaimed by the lease protocol;
  a non-empty, linked, or changed lock path is unknown and retained.
- No operation overwrites, replaces, restores over, or chooses between
  ambiguous files or directories.
- A fresh database creates no backup artifact.
- An existing schema-6 database cannot advance to schema 7 without a verified
  pre-cutover backup.
- Storage roots are direct non-link directories before child creation or
  `app.setPath()` publication.
- Every Electron session that can create cache state participates in the same
  clear barrier.
- A cache write is authorized by both account identity and account generation
  at the authoritative main-process boundary.

## 1. Portable Filesystem Primitives

### 1.1 Exclusive immutable artifacts

Introduce one production primitive with a two-stage ownership API for immutable
attempt artifacts. The reservation stage:

1. Revalidates the owned direct non-link root.
2. Generates an unpredictable same-root filename.
3. Opens it with `O_CREAT | O_EXCL | O_WRONLY` and mode `0600`.
4. Verifies the opened descriptor is a regular file within the expected root.
5. Returns a zero-length reservation guard containing the path, basename, open
   descriptor, and captured identity.

The completion stage accepts that guard plus a bounded byte source and artifact
kind. It:

1. Revalidates the reservation and root.
2. Writes bounded chunks, fsyncs the descriptor, and verifies exact length.
3. Reopens read-only for content or semantic verification while retaining the
   original descriptor and captured identity.
4. Revalidates the pathname against the descriptor before and after semantic
   verification.
5. Returns an immutable ownership guard augmented with SHA-256 and byte length
   only after verification succeeds.

Most callers use a composed reserve-and-complete helper. Database backup uses
the explicit stages so it can durably bind the unique basename before writing
the first byte. Only that exact marker-bound incomplete backup may be reopened
for append, and only after descriptor, identity, expected total length, and
every existing prefix byte are verified. A completed artifact is never reopened
for writing.

There is no staging-to-final rename or link. A failed or partial unique attempt
is retained under its attempt name. It is never mistaken for a successful
artifact because it was not returned or recorded as verified; the prepared
backup protocol defined below is the only path that may resume one.

The caller keeps the guard open through its consuming operation and revalidates
it at the final commit boundary. A successful artifact is immutable by
application protocol: production code never reopens it for writing, gives it a
mutable stable alias, or automatically deletes it.

### 1.2 Exclusive isolation and retention

Introduce one production helper for retiring a mutable stable pathname. It:

1. Validates root containment and the recorded node identity.
2. Atomically reserves an unpredictable direct-child isolation directory with
   non-recursive `mkdir` and mode `0700`. `EEXIST` causes a new-name retry; an
   existing node is never used or replaced.
3. Captures and revalidates that private directory's identity. The directory is
   never published to another application subsystem.
4. Renames the stable direct child to the fixed absent `payload` name inside
   that exclusively owned directory.
5. Validates the moved node against the recorded identity and, when that node
   kind defines one, its ownership marker.
6. Revalidates that the stable pathname is absent. A replacement at the stable
   pathname and the isolated payload are both preserved and reported as a
   conflict.
7. Returns one of `absent`, `isolated`, or `conflict`; a caller may continue its
   destructive operation only after `absent` or `isolated`.

There is no automatic path restoration. Node does not expose a portable atomic
no-replace restore across NTFS, FAT32, and exFAT, so any failure after a move
retains the private directory and fails closed.

After the caller's operation commits successfully, it may reclaim only the
exact verified payload while it still owns the private directory. The helper
revalidates the directory, payload identity, marker, and absence of unexpected
entries immediately before removal. The private name excludes application
concurrency; if verification or removal fails, the remaining directory is
retained. Thus normal cache clears, temp shutdowns, lock releases, and stage
cleanup reclaim their owned bytes, while failed, changed, or ambiguous
artifacts are never automatically deleted.

Retained names are never exposed to renderer callers, scanned for startup
recovery, or accepted as future active inputs. Logs use fixed diagnostics and
paths but never file contents or credentials. A later explicit offline
maintenance workflow may address retained failures, but is outside this wave.

## 2. Hard-Link-Free Consumers

### 2.1 Database backups

The same authoritative SQLite connection continues to serialize the complete
pre-cutover database. The backup writer uses the exclusive immutable artifact
helper directly in `StoragePaths.backupsRoot`.

- The backup filename and basename are unique per attempt rather than
  deterministic.
- The serialized bytes have no duplicate staging copy. A resumed attempt only
  appends bytes after its existing prefix is reverified.
- SQLite semantic verification remains mandatory: quick check, foreign keys,
  schema 6, migration ledger, Phase 3/4 marker state, and expected row hashes.
- Only the verified unique ownership guard is supplied to schema advancement.
- The guard remains open and is revalidated inside the schema-7 transaction,
  after all migration checks and immediately before the transaction callback
  returns to `COMMIT`. A failed final check throws and rolls the database and
  marker back to schema 6. No post-commit check can negate cutover success.
- Database advancement remains single-flight, so concurrent calls cannot
  allocate independent backup attempts.

This supersedes deterministic no-clobber hard-link publication and the
same-inode retained staging rule.

Before writing backup bytes, schema 6 durably records one versioned
`backup-prepared` marker containing the unique basename, source schema, and
read-write marker hash. The marker is committed before the first backup byte,
and no second attempt is allocated while that exact prepared state exists. A
retry resolves only its recorded basename. If the file is partial, its open
descriptor identity and every existing byte must match the corresponding
prefix of a newly serialized bounded snapshot before append resumes at the
current length; the file is never truncated or overwritten. A mismatch or
unverifiable attempt is retained and blocks automatic cutover rather than
selecting or creating another candidate. This makes capacity recovery
retryable after space is freed without accumulating full database copies.

The prepared marker is an allowed schema-6 operational marker and is included
in the backup's semantic contract. Migration 7 removes it and writes cutover
marker details version 2 in the same SQLite transaction. For an existing
schema-6 database, the cutover marker records `backupRequired: true`, the exact
contained backup basename, SHA-256, byte length, source schema, and read-write
marker hash. A schema-6 retry after a rolled-back or interrupted cutover reuses
and re-verifies that one prepared artifact. A schema-7 steady-state open
resolves only the exact basename recorded by its marker and verifies that
artifact. It never scans or chooses among directory candidates.

The authoritative database lifecycle admits no unrelated writes between
committing `backup-prepared` and completing or failing cutover. On a later
process retry, startup verifies the exact prepared state before reserializing;
any intervening authoritative change fails closed instead of appending
different bytes.

If creating the unique file succeeds but committing its prepared marker fails,
the still-open same-process attempt is retained as an unreferenced failed
artifact and no bytes are written to it. Crash-orphaned unreferenced attempts
also remain untouched; they are never candidates. Repeated ordinary write,
verification, or cutover failures use the one marker-bound attempt and do not
grow total backup bytes.

For a fresh database, marker details version 2 records
`backupRequired: false` and no backup basename, hash, or byte length. Existing
schema-7 databases with the current version-1 cutover marker remain readable:
the existing deterministic candidate may be resolved and verified as a legacy
read-only compatibility path, but production never creates, deletes, relinks,
or repairs its hard-link pair. Unknown legacy artifacts remain untouched.

### 2.2 Guarded migration locks

Replace the hard-link file protocol with a direct runtime dependency on
`proper-lockfile` 4.1.2 and its established `mkdir` lease protocol. A stable
empty lock directory is the complete acquired state, so there is no
create-before-owner-record crash window. Use one fixed configuration in every
process: a direct contained lock path, `realpath: false`, conservative fixed
stale and heartbeat intervals, and bounded retry.

The atomic `mkdir` operation is the acquisition point. A live heartbeat blocks
other contenders. After a crash, an unchanged directory becomes stale and may
be removed only with empty-directory `rmdir`; an unexpected entry, linked root,
identity change, heartbeat change, or compromised lease fails closed. The
migration revalidates the lease before every promotion, retirement, or source
mutation, and the compromise callback prevents later mutation.

Normal release removes only the empty directory owned by the active lease.
Release failure is retained and reported. Tests cover a crash immediately
after `mkdir` and before the first heartbeat, a live heartbeat, stale recovery,
compromise during migration, and an unexpected non-empty lock directory. The
lock directory contains no user payload and is not a retained data artifact.

### 2.3 Theme assets

Theme staging remains bounded and main-owned. Publication creates a unique
exclusive target in the durable theme asset root and writes verified bytes to
it. For a file-backed stage, the captured stage identity must match a retained
read descriptor before copying; bytes are read from that descriptor, and the
stage pathname is revalidated against it before and after the copy. Publication
does not reopen the mutable stage pathname as its source and does not link the
stage into the durable root.

After successful publication, any file-backed stage is retired through
exclusive isolation. A raced stage replacement is preserved and causes a fixed
failure.
The durable target is not published to settings until stage retirement
succeeds. Memory-backed stages require no filesystem cleanup. On any
pre-settings failure, published-target rollback isolates the exact owned target
and reclaims it only when the rollback itself completes successfully. A failed
or ambiguous rollback retains the target; it never unlinks a stable path after
a separate validation.

## 3. Destructive Cleanup Conversion

The following operations transfer a stable pathname into exclusive isolation
before byte reclamation:

- portable legacy `LxDatas` source retirement;
- explicit cache reset of `cache.db`, `cache.db-wal`, and `cache.db-shm`;
- per-run temp shutdown cleanup;
- guarded directory migration stage cleanup;
- theme stage cancellation and failed publication rollback.

Each operation moves only its validated direct child into an exclusively
created private directory. Portable retirement extends its journal before the
move with a versioned `retirement-intent` containing the exact private
directory basename and identity, captured source identity, and
source/destination manifest hashes. After the move it durably records
`retirement-isolated`; after verified reclamation it records `retired`.
Existing version-1 acknowledged journals are upgraded only after their source
and destination are reverified.

On restart, portable recovery follows only the exact journal-referenced private
directory; it never scans or chooses a candidate. An exact interrupted payload
is retained and recorded as `retired-retained` rather than automatically
deleted. An exact still-present source and empty journal-bound private directory
resume the isolation attempt. An already removed payload with a durable
`retirement-isolated` record can be finalized as `retired`. A stable-path
replacement, identity mismatch, unexpected private entry, or any other
ambiguity preserves all nodes and stops startup. This keeps an interrupted
retirement usable without deleting a failed artifact.

Cache reset can create a fresh cache only after all active cache pathnames have
been isolated or proved absent in a final revalidation and every isolated
verified cache payload has been removed. This preserves the existing meaning
of a `cleared` component result.

Partial or failed retirement retains every remaining private directory,
preserves every replacement, returns a failure or degraded result, and does not
begin a fresh database open. A cache database isolation, removal, or reopen
failure produces a degraded result and no generation publication. A named
Chromium session-category failure may still produce a degraded result while
publishing the generation of a newly installed usable cache DB, preserving the
existing success-qualified generation contract.

Successful run-temp, guarded-stage, and theme-stage cleanup reclaims the exact
owned payload and its empty private directory. Failed-attempt and conflict
directories remain inert; normal startup never scans or recursively deletes
arbitrary retained prefixes.

## 4. Fresh Database Purity

Database initialization records an immutable `existedBeforeOpen` boolean in
the cached initialization result.

- `false`: Phase 4 may attest and advance the newly created schema-6 connection
  to schema 7 without allocating a backup and writes the no-backup cutover
  evidence defined above.
- `true`: schema-7 advancement requires a verified backup path from the new
  hard-link-free backup protocol and writes its exact backup evidence.

Callers cannot supply or override this fact. Retries reuse the cached value.
An existing, empty-looking database is still treated as existing and requires a
backup.

## 5. Root Integrity Before Electron Publication

Add a shared direct-directory validator used at each storage owner's first
allowed mutation. It can validate an existing direct directory or exclusively
create a missing direct child under a validated parent. In both modes it:

- resolves the lexical expected path;
- inspects an existing node with `lstat` and rejects symbolic links, junctions,
  reparse-point directories, files, and changed identities;
- creates a permitted missing direct child non-recursively beneath a validated
  parent rather than recursively following an unknown node;
- retains the parent identity across creation and revalidates both parent and
  child afterward;
- creates the run-temp child and ownership marker as one lifecycle operation.

Root creation remains phase-specific:

- Bootstrap validates or creates only `profileRoot`, `tempRoot`, `runtimeRoot`,
  `sessionDataRoot`, the required direct parents, and the run-temp lifecycle.
  It calls `app.setPath()` only after these checks complete.
- Bootstrap validates an existing `cacheRoot` or records that it is absent, but
  never creates a missing cache root. The cache lifecycle exclusively creates
  it only after independently re-reading and validating the Phase 3
  prerequisite.
- Bootstrap validates an existing `backupsRoot` or records that it is absent,
  but never creates a missing backup root. Only the existing-database backup
  path may create it. A fresh database does not create or mutate it.
- A source-less portable startup still validates an existing
  `portable/profile` before it can become `userData`.

Every later owner revalidates its root immediately before child creation; a
bootstrap observation alone never authorizes later mutation.

## 6. Complete Electron Session Registration

After `app.whenReady()` and before tray, lyric, main, login, or User API windows
can be created, register `session.defaultSession` with the main-only session
registry. Hold the registration for the process lifetime. Production does not
call its `unregister()` method during shutdown, so a late or concurrent clear
cannot outlive this registration; process teardown releases both together.
Window creation awaits the registration's barrier-admission promise.

Explicit partition registrations remain unchanged. A clear operation includes
the default session and waits for sessions registered while a clear is in
progress.

## 7. Account-Generation URL Authorization

Introduce a main-owned monotonically increasing generation for each persistent
provider account session. User API URLs remain non-persistent.

1. Before starting a network URL request, renderer asks main for an
   authorization containing provider, normalized public profile ID, and
   generation.
2. Cache reads and writes carry that authorization.
3. A main-only per-provider FIFO owns all persistent URL writes and account
   transitions. A write task validates the current active profile and
   generation, then awaits the worker write before releasing the FIFO.
4. Logout, credential clear, and account replacement enqueue one transition
   task that owns the authoritative account-state mutation, advances generation,
   and awaits worker invalidation before releasing the same FIFO.
5. A late result may still resolve its original playback caller, but its
   persistent write is rejected when identity or generation is stale.

The worker cache repository already serializes writes and invalidation on its
own FIFO. Because the main FIFO holds through the awaited worker operation, the
two legal orderings are safe: an older write commits before invalidation, or
invalidation completes before the stale write is rejected. No validation-to-
write gap is released to another account transition. The worker receives only
a main-validated scoped write. Renderer checks remain defense in depth and are
not authoritative.

## 8. Failure Semantics

- Root integrity failure: startup stops before Electron path publication.
- Backup creation or verification failure on an existing DB: schema stays 6;
  the exact prepared attempt remains resumable or blocks on mismatch, and
  unreferenced attempts remain inert.
- Isolation mismatch: preserve the private directory and any stable-path
  replacement, then return the component's fixed failure or degraded result.
  A cache-reset mismatch or removal failure also prevents fresh cache
  generation publication.
- Default-session clear failure: report the named session component failure.
- Stale URL authorization: return a fixed non-secret stale-authorization error;
  playback result handling may continue without persistence.

No failure path falls back to hard links, path-based overwrite, recursive
stable-path deletion, or selecting a candidate artifact.

## 9. Verification Design

Tests are written RED before implementation. Focused automated suites use only
disposable D-local fixtures; the explicit real-volume smoke uses only its
caller-supplied disposable root. Required focused evidence includes:

- replacement injected immediately after portable retirement validation;
- replacement at cache, temp, guarded stage, and theme retirement boundaries;
- successful cache, temp, guarded stage, lock, and theme cleanup reclaims owned
  bytes, while every injected failure or conflict remains preserved;
- no production hard-link symbol across all `src` files;
- filesystem adapter without `link` support for lock, theme, and backup flows;
- migration lock crash before first heartbeat, live-owner blocking, stale
  recovery, compromise, and non-empty lock preservation;
- concurrent advance callers share one single-flight prepared attempt, and an
  unreferenced or mismatched attempt is retained but never selected;
- repeated write, verification, and cutover failures do not allocate another
  full backup; an `ENOSPC` prefix resumes only after exact prefix verification;
- replacement during the final in-transaction backup guard check rolls schema,
  ledger, and cutover marker back to schema 6;
- fresh DB reaches schema 7 with zero backup artifacts;
- existing schema-6 DB still requires one verified backup;
- schema-7 evidence resolves exactly one unique backup without directory
  selection, while version-1 cutover evidence remains readable;
- profile/temp/portable junction roots rejected before `app.setPath()`;
- tray and lyric default-session cache categories included in the clear barrier;
- a clear started during shutdown still includes the lifetime default session;
- logout, same-account relogin, and account replacement reject late URL writes;
- exact FIFO interleavings prove a write committed before transition is then
  removed by invalidation, while transition-before-write rejects persistence;
- valid current-generation URL writes still persist.

A portable-volume smoke script accepts an explicit disposable fixture root and
expected filesystem type. It validates the actual volume type, then runs
synthetic lock, unique backup, theme publication, file isolation, and directory
isolation flows. Release evidence runs it separately on NTFS, FAT32, and exFAT
when those volumes are available. An unavailable volume is reported as an
explicit environmental evidence gap, never as a passing test, and the script
refuses any real profile, cache, portable, or backup root.

The fixed invocation is:

```powershell
node build-config/storage/portable-filesystem-smoke.js --root <disposable-root> --expected-fs <ntfs|fat32|exfat>
```

After focused tests, run the exact full matrix:

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

The final fix wave receives one scoped re-review. Residual load-bearing findings
stop integration; non-blocking observations are recorded with explicit rulings.

## Superseded Decisions

This design supersedes only these earlier decisions:

- deterministic hard-link publication of schema-cutover backups;
- retained same-inode backup staging links;
- any production migration/theme/backup protocol that requires hard links;
- automatic recursive deletion or unlink of a mutable pathname after a prior
  identity check.

All other Phase 4 storage ownership, marker, cutover, backup-root, source
retention, and cache-degradation contracts remain in force.
