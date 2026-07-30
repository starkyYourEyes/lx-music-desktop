# Fresh Database Bootstrap Design

## Scope

This change corrects only authoritative database initialization for a profile
where `lx.data.db` did not exist before startup. Portable-path selection and
run-state semantics remain unchanged.

## Problem

The current startup path creates a legacy version 2 database for a new profile,
detects every registered migration as pending, creates and verifies a
pre-migration backup of that empty database, and then applies the migrations.
This makes first startup depend on the backup subsystem even though there is no
pre-existing database to preserve. It also reports schema applications for a
new database as user-data migrations.

## Required Behavior

Database startup must continue to determine whether `lx.data.db` existed before
opening or initializing it.

For a fresh target (`existed == false`), startup must:

1. Enable authoritative SQLite pragmas before writing schema data.
2. Bootstrap the current schema using the existing baseline tables and the
   canonical ordered migration registry as the only schema source.
3. Run bootstrap schema writes atomically.
4. Never allocate a migration-backup path, create the backup directory, call
   the online-backup service, or create a backup artifact.
5. Verify the final schema, `quick_check`, and foreign-key consistency before
   exposing the connection.
6. Return `existed: false`, `migratedVersions: []`, and `backupPath: null`.

Using the migration registry during bootstrap is an implementation mechanism,
not a migration of a pre-existing user database. The resulting
`schema_migrations` ledger must still contain every registered migration so
that later startups can validate registry names and checksums.

For an existing target (`existed == true`), behavior remains unchanged:

- An older valid schema with pending migrations receives one verified online
  backup before any migration runs.
- A current schema is opened without a backup or migration.
- A malformed or corrupt database enters recovery and is never replaced with
  an empty database.

## Design

Introduce a fresh-bootstrap operation at the schema-migration boundary. It
executes legacy baseline creation and all migrations up to the requested target
inside one outer SQLite transaction. The existing migration registry remains
canonical, avoiding a second hand-maintained current-schema SQL snapshot.

Startup keeps separate internal results for schema versions applied while
bootstrapping and migrations applied to an existing database. Bootstrap
applications populate the ledger and trigger full verification, but only the
latter are returned in `migratedVersions`.

The backup condition becomes the conjunction of an existing target and at
least one pending migration. Fresh startup must not create `backupDir` merely
to discover that no backup is needed.

## Failure Handling

If fresh bootstrap or verification fails, startup follows the existing
sanitized recovery path. The bootstrap transaction prevents a partially
applied schema from being committed. This scoped change does not add automatic
database-file deletion or broaden recovery cleanup.

If backup creation or verification fails for an existing old database,
migration remains blocked and the existing database remains authoritative, as
before.

## Tests

The storage tests must prove all of the following:

- A fresh startup reaches the latest registered schema and has a complete,
  checksum-valid migration ledger.
- Fresh startup reports no migrated versions and no backup path.
- A backup implementation that throws is never called for a fresh target.
- Fresh startup does not create the backup directory or any backup artifact.
- Fresh startup runs schema, quick, and foreign-key verification.
- An existing version 2 database still creates and verifies a pre-migration
  backup before applying registered migrations.
- An existing current database still skips backup and migration.
- Schema additions such as `account_profiles` are present after a fresh
  bootstrap without hard-coding the latest version in bootstrap logic.

## Non-Goals

- Changing portable executable data-root discovery.
- Changing `run-state.v1.json` or introducing a first-run lifecycle enum.
- Changing backup retention policy or operational profile snapshots.
- Migrating or deleting live profile data.
