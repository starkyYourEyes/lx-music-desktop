# Early Electron Path Binding Design

**Date:** 2026-08-05

**Status:** Approved direction

## Context

The Windows x64 portable artifact now resolves the launcher directory securely,
retains `PORTABLE_EXECUTABLE_DIR` in the production bundle, and creates the
launcher-local `portable` root on a true first launch. Its source matrix passes,
but a default-argument packaged launch still terminates before any window or
storage roots are published.

The failure is reproducible in both the NSIS wrapper and `win-unpacked` child.
The child leaves only `.portable-profile-migration.lock`, and Windows Error
Reporting records Electron exception `0x80000003`. The same child starts and
runs when given an explicit isolated `--user-data-dir`; that early directory
contains only Chromium `Local State`, while application data is correctly
created under `portable/profile` and browser session data under
`portable/runtime/session-data`.

The current bootstrap calls its first asynchronous portable migration before it
publishes Electron `userData` or `sessionData`. During that asynchronous gap,
Electron can initialize browser-process state against its default installed
path. Publishing the paths only before importing application modules is too
late; they must be stable before bootstrap first yields to the event loop.

This design supersedes only the Electron-path publication order in
`2026-08-05-portable-first-launch-bootstrap-design.md` and the corresponding
late-publication sentence in
`2026-08-03-portable-fail-closed-final-review-design.md`. All launcher guards,
portable migration, cache, backup, temporary-file, and shutdown requirements
remain in force.

## Goals

- Publish valid Electron `userData` and `sessionData` paths synchronously before
  the first bootstrap `await` in installed and portable modes.
- Keep Electron-owned state separate from authoritative application profile
  data and from the legacy portable migration source.
- Publish each Electron path once for the process lifetime; do not switch it
  after Electron may have cached or opened it.
- Preserve the guarded direct-directory contract at the publication boundary.
- Preserve portable profile migration atomicity and installed legacy migration
  semantics.
- Keep missing cache and backup roots absent until their existing owners need
  them.
- Prove default-argument packaged startup without using `--user-data-dir` as a
  workaround.

## Non-Goals

- Customizing the electron-builder NSIS template or injecting a launcher
  command-line switch.
- Moving `profile`, `cache`, `session-data`, backups, or run-temp data to new
  ownership classes.
- Migrating Chromium `Local State` or Electron Preferences from an older
  incidental default location.
- Redirecting Electron logs, crash dumps, the operating-system temporary
  directory, `appData`, or `home` as part of this fix.
- Reordering application command-line switches or unrelated `ready` listeners.

## Storage Contract

Add `electronUserDataRoot` to the canonical `StoragePaths` contract. Installed
and portable layouts become:

```text
<installed application cache root>/
  runtime/
    electron-user-data/
    session-data/

portable/
  profile/
  cache/
  runtime/
    electron-user-data/
    session-data/
  temp/
  backups/
```

`electron-user-data` is persistent, device-local runtime state. It may contain
Electron Preferences, Chromium Local State, and fallback framework metadata. It
is not authoritative application data, is excluded from application backup and
portable data export, and is not part of cache clearing. It may be reset only
while the application is closed through an operation that explicitly owns that
directory.

`session-data` retains its existing ownership. Cookies, Local Storage,
IndexedDB, partition state, and named Chromium caches remain there. It is not a
per-run temporary directory and must never be recursively deleted by cache
clear.

Authoritative configuration, credentials, playlists, playback facts, and
databases continue to use `profileRoot`. Production application code continues
to use `global.storagePaths.profileRoot`, `global.lxDataPath`, and typed storage
services rather than `app.getPath('userData')`.

## Bootstrap Design

### Early path preparation

Add a synchronous storage helper that resolves, creates, validates, and returns
the stable Electron paths. It may create only:

- the required application-local parent chain;
- `runtimeRoot`;
- `electronUserDataRoot`;
- `sessionDataRoot`.

It must use the existing `validateDirectDirectory` and
`createDirectChildDirectory` primitives. It must not use an unguarded recursive
`mkdir`, follow links or Windows reparse points, or create `profileRoot`,
`tempRoot`, `cacheRoot`, `backupsRoot`, or a run-temp reservation.

The helper revalidates every held guard immediately before publication and
closes all descriptors on success or failure. Later storage initialization
reopens and revalidates the same lexical roots before publishing the complete
`StoragePaths` object.

### Stable publication order

Bootstrap uses this order:

1. Read `app.getPath('exe')`.
2. Resolve and guard-create the asserted portable root, or select installed
   mode through the existing compatibility detector.
3. Resolve the application-local runtime root without reading or mutating
   legacy user data.
4. Synchronously prepare `runtime`, `electron-user-data`, and `session-data`.
5. Call `app.setPath('userData', electronUserDataRoot)`.
6. Call `app.setPath('sessionData', sessionDataRoot)`.
7. Only then call the first asynchronous retirement or migration operation.
8. Complete portable or installed profile migration.
9. Initialize the remaining required storage roots and run-temp reservation,
   revalidating the early Electron roots.
10. Assert that initialized `electronUserDataRoot` and `sessionDataRoot` equal
    the paths already published; do not call `app.setPath` again.
11. Publish globals and dynamically import the application.

For portable mode, runtime path resolution uses only the guarded launcher-local
portable root. It must not consult installed `appData`, `home`, `APPDATA`, or
`LOCALAPPDATA`.

For installed mode, bootstrap may read `appData` and `home` synchronously to
derive the planned profile and local runtime roots. It binds Electron to the
local runtime paths before starting legacy AppData migration, preventing
Electron from creating the migration destination concurrently. The authoritative
profile path remains the migration result under the roaming application root.

### Why `profile` is not Electron `userData`

Portable `profile` is an atomic migration promotion target. It must remain
absent until a staged tree is promoted, or match a journaled destination. If
Electron uses it during the first asynchronous gap, Chromium can add Local
State or Preferences, turning it into an unjournaled collision. Even an empty
directory can be removed and replaced during promotion while Electron holds a
cached path or handle.

The installed migration has the same class of conflict: creating the final
application directory before migration makes the legacy migrator interpret it
as an existing destination and skip the old profile. A stable runtime-owned
`electron-user-data` directory avoids both conflicts.

### Why paths are not changed later

Electron allows repeated `setPath` calls at the API surface, but consumers can
cache or open `userData` before `ready`, and Electron explicitly requires
`sessionData` to be set before `ready`. Changing either after an asynchronous
gap can split state between two roots. Therefore both paths are immutable for
the process after their early publication.

## Failure Handling

- A present but invalid portable launcher value remains fatal before any
  installed path is read or any Electron path is published.
- Failure to prepare or validate an early Electron root logs a fixed storage
  validation error, calls `app.exit(1)`, and does not start migration or load
  application modules.
- A later migration failure may leave the guarded runtime directories and
  Electron-owned metadata. It must not create an authoritative profile,
  acknowledge portable migration, or create cache/backups as a side effect.
- A later full-storage validation mismatch is fatal. Bootstrap must not repair
  it by rebinding Electron to another path.
- An existing linked or replaced runtime, electron-user-data, or session-data
  root is rejected fail-closed.

## Compatibility

Application business data does not use `app.getPath('userData')`; it uses the
canonical storage globals and typed services. Moving Electron's own user-data
root therefore does not move or reinterpret settings, playlists, databases,
credentials, or playback history.

The stable runtime root also gives each portable directory an independent
Electron single-instance identity. During an upgrade, an already-running older
binary may use the former path until it exits; packaging and verification must
start from a zero-process gate. No cross-version internal-state migration is
performed because observed successful diagnostic startup placed only
reconstructable Chromium Local State in the explicit early root.

## Verification

RED/GREEN automated coverage must prove:

- Portable and installed bootstrap publish the exact stable `userData` and
  `sessionData` paths before the first asynchronous dependency begins.
- Keeping either publication after the first `await`, omitting either path, or
  publishing `profileRoot` makes the sequencing test fail.
- Invalid portable launcher input reaches neither installed path lookup,
  Electron publication, migration, nor application loading.
- Early preparation creates only runtime, electron-user-data, and session-data;
  cache, backups, profile, temp, and run-temp remain absent at that phase.
- Direct links, Windows reparse points, and parent/child identity changes fail
  before path publication.
- Full storage initialization reuses the same early paths and still leaves a
  missing cache or backups directory absent.
- Existing portable-profile and installed legacy migration suites remain
  unchanged in behavior.

Packaged regression coverage must launch the real Windows artifact with no
`--user-data-dir` argument under an isolated launcher directory and redirected
host profile environment. It must observe a live application and the expected
portable profile/runtime roots, then terminate only the fixture-owned process
tree. An explicit `--user-data-dir` comparator may remain diagnostic evidence
but cannot satisfy the default-startup gate.

Release verification must preserve the current blocked artifact and any
existing `build/portable` evidence before a command that runs
`build-config/pack.js`, because that script removes `build/**`. It must then run
the complete source matrix, rebuild the x64 portable artifact, verify its
content and hash, prove a true default first launch with installed sentinels
unchanged, prove schema 7 and migrations `3,4,5,6,7`, close through the real
title-bar control with `clean:true` and reclaimed run-temp, preserve the clean
first-launch tree, relaunch without creating backups, and leave the verified
second instance running.
