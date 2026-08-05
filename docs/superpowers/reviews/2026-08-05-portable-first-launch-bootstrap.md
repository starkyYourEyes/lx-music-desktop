# Portable First-Launch Bootstrap Release Evidence

- Verification base: `40ab3fd84bc3704183ef7ba094bff856fb3e0771`
- Platform: Windows x64
- Artifact verdict: `PASS`
- Default packaged smoke: `3 pass / 0 skip / 0 fail`
- First-launch storage/schema/UI verdict: `PASS`
- Clean title-bar shutdown and snapshot verdict: `PASS`
- Historical second-launch reuse verdict: `PASS`; that implementer instance later exited cleanly
- Controller finalization verdict: `PASS`, current instance running
- Current launcher/main PIDs: `37536` / `32560`
- Controller audit UTC: `2026-08-05T04:49:37.1003241Z`
- Residual coverage: real provider media and real-volume filesystem loops not exercised

## Preflight And Protection

The release run started on branch `master` at exact HEAD `40ab3fd8`. The
blocked artifact evidence copy was still `103490907` bytes with SHA-256
`6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5`.
No target application process was running, `build\portable` and the final
snapshot destination were absent, and the committed documentation baseline
contained both portable plans and both amended designs.

The only unrelated worktree change was
`build-config/storage-electron/database-recovery.test.js`. It was checked only
with status and `git hash-object`; its start and end blob was
`959df4d23cd581ce43493e1c83c95881e64a710f`. It was not manually inspected or
printed, and it was not modified, restored, staged, or committed. However,
`npm run test:storage:electron` expanded
`build-config/storage-electron/*.test.js`, so the protected worktree file was
loaded and executed by that suite. The protected `stash@{0}`, commit
`611e43f8`, and branch `codex-pre-merge-user-db-assertion-20260804` were not
changed.

## Source Matrix

Each command ran independently with ordinary system Node and:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
```

| Command | Exit | Pass | Skip | Fail |
| --- | ---: | ---: | ---: | ---: |
| `node --test scripts/test-legacy-user-data-migration.js` | 0 | 31 | 0 | 0 |
| `npm run test:storage` | 0 | 725 | 5 | 0 |
| `npm run test:storage:portable` | 0 | 37 | 0 | 0 |
| `npm run test:user-api` | 0 | 122 | 0 | 0 |
| `node --test build-config/playback-source-fallback.test.js build-config/playback-media-validation.test.js build-config/playback-source-setting.test.js` | 0 | 151 | 0 | 0 |
| `npm run test:storage:electron` | 0 | 431 | 0 | 0 |
| `npm run lint` | 0 | n/a | n/a | 0 findings |
| `npm run build` | 0 | n/a | n/a | 0 build errors |
| `npm run test:main-bundle` | 0 | 1 | 0 | 0 |

Source-test aggregate: `1498 pass / 5 skip / 0 fail`. Lint completed in 169.7
seconds. Build completed in 94.6 seconds and all webpack targets compiled
successfully.

The 431 Electron-storage passes are working-tree evidence for the committed
base plus the protected blob, not exact-commit evidence for the verification
base alone. Exact-commit Electron-storage coverage is **PENDING CONTROLLER
VERIFICATION** from a retained `git archive` source tree that does not use the
protected worktree file. That run must target the new source-fix commit.

The final whitespace check was deliberately scoped around the protected user
file:

```powershell
git status --short
git diff --check -- . ':(exclude)build-config/storage-electron/database-recovery.test.js'
```

It exited `0`, and status still showed only the protected file. An unrestricted
`git diff --check` would have parsed that file, contrary to the controller's
explicit protection rule.

## Package And Default Smoke

| Command | Exit | Result |
| --- | ---: | --- |
| `npm run pack:win:portable:x64` | 0 | Windows x64 NSIS portable produced |
| `npm run test:packaged-app` | 0 | 2 pass, 0 skip, 0 fail |

An initial invalid smoke invocation set only `LX_PORTABLE_ARTIFACT`; its
independent shell lacked `LX_TEST_STORAGE_ROOT`. It exited `1` before artifact
launch with `1 pass / 1 skip / 1 fail` and
`LX_TEST_STORAGE_ROOT is required`. The valid invocation restarted the full
test file with both variables:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:LX_PORTABLE_ARTIFACT=(Resolve-Path 'build\starky-lx-music-desktop-v3.0.0-x64-portable.exe').Path
npm run test:portable-packaged-bootstrap
```

The valid invocation exited `0` with `3 pass / 0 skip / 0 fail`: two helper
tests and one real default-NSIS launch contract. The real launch used an empty
argument array and no `--user-data-dir`.

## Artifact And 7-Zip

- Path: `D:\projects\lx-music-desktop\build\starky-lx-music-desktop-v3.0.0-x64-portable.exe`
- Length: `103490485` bytes
- Creation UTC: `2026-08-05T04:06:19.3179656Z`
- Last-write UTC: `2026-08-05T04:06:19.6547389Z`
- SHA-256: `89829C7538240AB4FB0E5FAF85F5EFB8A804AFF58C13E95104216CE23C215E41`

The hash differs from all blocked hashes:

```text
937C05AF1EAA5F6FED1D6B9C208A031FF4ABDF3CE023404BA56CD7DDAA9FF4E3
11FD8058213BC3558C593CEED9C872D45BC9F16A44B34CAE544ACA9C0BFC0186
6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5
```

The planned binary path
`D:\projects\lx-music-desktop\node_modules\7zip-bin\win\x64\7za.exe` did not
exist. Attempts through that path did not execute 7-Zip. The actual independent
test used electron-builder's installed cache binary:

```powershell
& 'C:\Users\hao238\AppData\Local\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-1nrf7\bin\7za.exe' t $env:LX_PORTABLE_ARTIFACT
```

The fallback binary was `849920` bytes with SHA-256
`223B873C50380FE9A39F1A22B6ABF8D46DB506E1C08D08312902F6F3CD1F7AC3` before
the archive check. It was 7-Zip `24.09 (x86)` and exited `0` with `Everything
is Ok`, testing 3 folders and 79 files. It reported one expected NSIS warning,
`There are data after the end of archive`.

## Installed Sentinel Isolation

Only length, UTC mtime, and SHA-256 were read. Contents were never printed or
parsed.

| Sentinel | Length | LastWriteTimeUtc | SHA-256 |
| --- | ---: | --- | --- |
| installed `LxDatas\lx.data.db` | 49512448 | `2026-08-04T22:04:38.4306334Z` | `CD318C24446E97ADA1B354E88650A1DF5A8FB8DE618EFFFF522A25E823C7724B` |
| installed `LxDatas\config_v2.json` | 5493 | `2026-08-04T22:04:37.9573321Z` | `F7F73169F99D3B30B25C904921EDF37E540ECC4105FE2A28C41BFDB2B166F6A7` |
| installed `cache\cache.db` | 86016 | `2026-08-04T22:04:38.4386651Z` | `2FE3EC5A833BF2AC3BFAA62106F0A963E1CA4EA6BBD5D8F57821BA6AD3CF0AB0` |
| installed `runtime\run-state.v1.json` | 73 | `2026-08-04T22:59:26.6913437Z` | `45503D71B01251A11D37346B8C6C0AA84F36E564F6B95EB443B7C38B087432A4` |

All four rows were unchanged after first launch, after clean close, and after
second launch.

## First Default Launch

Before UI actions, the Computer Use wrapper was initialized and its required
`guidance` and `confirmations` documents were read. `sky.launch_app` received
the real artifact path and no arguments. Its initial internal wait expired,
then fresh `list_apps` and `list_windows` each returned exactly one running
candidate with title `LX Music`. That returned window object was selected and
captured.

The normal license screen was visible. After accepting it, the main music UI
appeared. A normal free/open-source information notice also appeared. Neither
screen contained a recovery, startup, migration, or database error.

- First main PID: `7880`
- Launcher parent PID: `47708`
- Main argv: executable only; no application argument and no
  `--user-data-dir`
- Electron process count: `6`

The portable root was a direct, non-reparse directory under `build`. Its exact
direct children were `cache`, `profile`, `runtime`, and `temp`. All required
paths existed:

```text
build\portable\profile\lx.data.db
build\portable\cache\cache.db
build\portable\runtime\electron-user-data\
build\portable\runtime\session-data\
build\portable\runtime\run-state.v1.json
build\portable\temp\
```

These remained absent:

```text
build\portable\backups
build\portable\profile\data.json
build\portable\userData
build\portable\.portable-profile-migration.json
build\portable\.portable-profile-migration.pending.json
```

Chromium's own `*-journal` files under `runtime\session-data` do not match the
two exact portable migration filenames and are not migration evidence.

## Read-Only Schema Evidence

The installed Electron ABI opened the portable application database with
`readonly:true`, `fileMustExist:true`, and SQLite `query_only=1`. The first
launch returned `db_info.version == '7'` and these exact ledger rows:

| Version | Name | Checksum | applied_at_ms |
| ---: | --- | --- | ---: |
| 3 | `storage_foundation` | `9243aa510e8355d2c3d0f687c6736654adf584ec6007b1bcf46f374a9d694e41` | 1785903027018 |
| 4 | `account_profiles` | `885ff60acc5b2eece73a566fb59f73a7d3d3496d846c98a38d2f6be359638451` | 1785903027018 |
| 5 | `non_activity_state` | `a4dda51309eb5e7e98d61125bc50bf7342b6aba5e367d5824a9b357774bc8c65` | 1785903027018 |
| 6 | `playback_activity` | `41fd08b6838c90dcd78435d38eb0ec112be9a0ee9c442fdf0efec669da60904b` | 1785903027018 |
| 7 | `cache_cleanup` | `493156099746b38631fc96a4ec2c03a3607e5e848f6f05bafa5f510bf1fa61b2` | 1785903027211 |

## Title-Bar Shutdown And Preserved Snapshot

The first title-bar Close click occurred while the information modal was still
present, so the window remained and no close claim was made. Computer Use
dismissed the notice through a fresh `OK` element, refreshed the accessibility
tree, and clicked the fresh real title-bar `Close` element. The target window
then disappeared and all target processes exited naturally.

- Run-state version: `1`
- Clean: `true`
- Started: `1785903026808` (`2026-08-05T04:10:26.8080000Z`)
- Completed: `1785903411152` (`2026-08-05T04:16:51.1520000Z`)
- `portable\temp\run-*` direct-child count: `0`

With the application closed, source identity was rechecked and the exact tree
was copied without deleting the source to the initially absent path:

```text
D:\projects\lx-music-desktop\.superpowers\evidence\2026-08-05-post-early-path-fix-first-launch-portable
```

The source and snapshot each contain 82 files, 45 directories, and 11152826
bytes. Relative paths, types, lengths, and per-file SHA-256 values matched;
manifest delta count was `0`.

## Historical Implementer Second Launch Reuse

Computer Use launched the same artifact again with no arguments. Fresh app and
window lists again returned one `LX Music` candidate. The normal UI appeared
directly, with no license, startup, recovery, migration, or database error.

The same profile database, cache database, electron-user-data, session-data,
run-state, and temp paths existed. Backups, legacy `data.json`, `userData`, and
both portable migration files remained absent. A second Electron ABI read-only
query returned `query_only=1`, version `7`, and ledger versions
`[3,4,5,6,7]`. Installed sentinels remained `4/4` unchanged.

- Historical main PID: `37544`
- Historical launcher parent PID: `31912`
- Main argv: executable only, no `--user-data-dir`
- Electron process count: `6`
- State at implementer finalization: verified second instance intentionally left running

That historical instance subsequently exited cleanly and is not the current
final process. Its post-exit portable run-state was `version:1`, `clean:true`,
`startedAtMs:1785903602398`, and `completedAtMs:1785904434329`.

## Controller Finalization

The controller relaunched the same
`build\starky-lx-music-desktop-v3.0.0-x64-portable.exe` through Computer Use
with an empty argument list. The launcher started at
`2026-08-05T04:38:17.3573580Z` as PID `37536`; the extracted main process
started at `2026-08-05T04:38:27.7952289Z` as PID `32560`, with parent PID
`37536`.

At the controller audit time `2026-08-05T04:49:37.1003241Z`:

- Fresh `list_windows` returned exactly one `LX Music` window.
- A fresh accessibility tree showed the normal recommendation UI with no
  startup, recovery, migration, or database error.
- The launcher command line contained only the quoted artifact executable;
  the main command line contained only the extracted executable.
- All six current Electron child processes had parent PID `32560` and used
  `D:\projects\lx-music-desktop\build\portable\runtime\electron-user-data`.
- The artifact remained `103490485` bytes with SHA-256
  `89829C7538240AB4FB0E5FAF85F5EFB8A804AFF58C13E95104216CE23C215E41`.
- All six required portable paths were direct/non-reparse, and backups,
  legacy `data.json`, `userData`, and both portable migration files remained
  absent.
- The Electron ABI query remained read-only with `query_only=1`,
  `db_info.field_value == '7'`, and migrations `[3,4,5,6,7]`.
- Installed sentinels remained `4/4` unchanged.
- The preserved snapshot remained 82 files, 45 child directories, and
  11152826 bytes.
- The fallback 7-Zip binary and hash were unchanged; its fresh archive test
  exited `0` with `Everything is Ok`, 3 folders, 79 files, and the one expected
  NSIS tail warning.

A separate read-only process liveness check at
`2026-08-05T04:52:03.2647821Z` found launcher PID `37536` and main PID `32560`
still running with the exact start times above; historical PIDs `31912` and
`37544` were absent. No process was closed, restarted, or otherwise touched by
this review fix.

## Evidence-Loss History And Gaps

The amended design records that `build-config/pack.js` removes `build/**`. An
earlier release-evidence ordering allowed an unpreserved `build\portable` tree
to be lost. This run does not reconstruct or claim that missing tree. It began
with `build\portable` absent, preserved and rechecked the blocked artifact
before build, and copied the new clean first-launch tree before relaunch.

No real provider track was requested or played. This evidence covers build,
package structure, default artifact launch, visible UI, portable storage
isolation, schema creation/reuse, clean shutdown, snapshot preservation, and
second launch. It does not cover provider network resolution, real audio
decode/output, or account-scoped playback URL persistence. No configured real
NTFS/FAT32/exFAT disposable-volume loop was available, so those real-media
filesystem checks remain evidence gaps, not passes.

## Release Ruling

The Windows x64 portable artifact now reaches launcher-local storage with
default arguments, publishes stable Electron roots, leaves the installed
profile untouched, creates and reuses schema 7, closes cleanly through the
title bar, and relaunches from the preserved first-launch state. The historical
implementer instance at main PID `37544` later exited cleanly. The current
controller-relaunched instance remained running at audit and fix-round
liveness check with launcher PID `37536` and main PID `32560`.

**Release bootstrap verification passed with the explicitly recorded
real-media coverage gaps.**
