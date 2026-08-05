# Portable First-Launch Bootstrap Release Evidence

- Source verification base: exact HEAD `29044c21cc4cf2cca8b38d698b1720f5d0f2fd21` (`fix: preserve mutable state after legacy migration`)
- Platform and artifact: Windows x64 portable EXE
- Final verdict: `PASS`, subject only to the declared real-removable-media coverage gap
- Controller state: the verified restored-data second launch remains running; this documentation pass did not interact with it.

## Superseded Records And Scope

All `40ab3fd`/`0a0af3a`, `15093773`, and earlier artifact, PID, snapshot, and
first-launch claims in prior release records are historical only. They are not
evidence for final HEAD `29044c21`. The final artifact is
`build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`, not `win-unpacked` or
the installed application.

The only unrelated tracked worktree change is the protected
`build-config/storage-electron/database-recovery.test.js`. It was not opened,
run, modified, restored, staged, or committed in this final pass.
`npm run test:storage:electron` was not run; the Electron ABI command used an
explicit 20-file allowlist excluding that filename. Installed sentinel contents
were not printed or parsed; only length, UTC modification time, and SHA-256
were compared.

## Final Source Verification

Previously established on exact final HEAD: mutable-state replay `1/1`,
`non-activity-retry` `5/5`, legacy migration `31/31`, storage `732 pass / 5
skip / 0 fail` (`737` total), and portable storage `37/37`.

| Command | Final result |
| --- | --- |
| `npm run test:user-api` | exit `0`; `122 pass / 0 skip/fail`; 7.620 s TAP |
| Three playback source tests | exit `0`; `151 pass / 0 skip/fail`; 11.552 s TAP |
| Explicit 20-file Electron ABI allowlist | exit `0`; `369 pass / 0 skip/fail`; 26 suites; 65.761 s TAP |
| `npm run lint` | exit `0`; 205.4 s; existing Browserslist/caniuse-lite age advisory only |
| `npm run build` | exit `0`; 106.9 s; all webpack targets compiled |
| `npm run test:main-bundle` | exit `0`; `1 pass / 0 fail`; live runtime environment preserved |
| Protected-path-excluding `git diff --check` | exit `0` |

## Artifact And Packaging

`npm run pack:win:portable:x64` exited `0` in 221.7 s. `npm run test:packaged-app`
passed `4/4`; the count includes launch-unique extraction configuration tests.
The artifact's empty-argv bootstrap test passed `6/6` in 41.946 s TAP (44.9 s
wall), including real default launch and concurrent-launch extraction coverage.
Post-smoke target process count was zero.

| Property | Final value |
| --- | --- |
| Bytes | `103489728` |
| Creation UTC | `2026-08-05T17:16:01.9577374Z` |
| Modification UTC | `2026-08-05T17:16:02.2963242Z` |
| SHA-256 | `1D736DDB513B1B1C4F526FB6AE83FDFC175C17F6538EE6600BCD7A830E86455E` |

The final hash differs from historical/blocked `937C05...`, `11FD805...`,
`6A0BAE...`, and `98E90B...` artifacts. `D:\software\YesPlayMusic\shims\7z.exe`
successfully tested the artifact with 7-Zip 26.01, `Everything is Ok`, NSIS-3
Unicode, and four files; the former repository-local `7zip-bin` path was
unavailable.

## Backup, Restore, And Database State

The external source backup
`D:\projects\lx-music-desktop-data-backups\2026-08-06-before-final-portable-rebuild-20260806-005046`
is outside `build` and survived the build. Before cleanup, source and old
`build\portable` matched by sorted relative path, directory set, length, and
SHA-256: `124` files, `58` descendant directories, `295853550` bytes, zero
reparse points, and no mismatches. After packaging, robocopy staging and the
published restore had the same zero-mismatch result.

While stopped, the main database opened through Electron 37.6.1 ABI with
`better-sqlite3`, readonly/file-must-exist/query-only boundaries: `quick_check`
was exactly `ok`, foreign-key check had zero rows, and `db_info.version=7`.
`schema_migrations` contains exactly versions 3--7 (`storage_foundation`,
`account_profiles`, `non_activity_state`, `playback_activity`,
`cache_cleanup`) with 64-hex checksums. The cache database likewise had
`quick_check=ok`, zero foreign-key rows, `user_version=1`, and one
`cache_schema_v1` ledger row. The migration journal is version 2/`retired`;
the retired `build\portable\userData\LxDatas` source is absent. The restored
backup intentionally retains `profile\data.json`, the top-level `userData`
shell, and `backups`.

## Installed Isolation And Restored Lifecycle

The four installed sentinels (`lx.data.db`, `config_v2.json`, `cache.db`, and
`run-state.v1.json`) matched their frozen length, UTC mtime, and SHA-256 before
first launch, while it ran, after second launch, and after enabling tray:
`4/4` unchanged each time.

The final EXE's first real restored-data launch reached one normal, error-free
`LX Music` window from `Temp\nsa6113.tmp`; helper targeting timed out, but
window discovery recovered the live main window. Direct non-reparse portable
paths existed for profile database/config, cache, Electron user/session data,
run state, and temp. During the run, `clean=false`, one `temp\run-*` existed,
and sentinels remained unchanged. A real title-bar Close with tray disabled
left all target processes at zero, `clean=true`, completed-after-start timing,
no `run-*`, and an empty portable temp directory.

The same artifact then reused restored data from `Temp\nsm3893.tmp`: one normal
exact-titled main window (with one auxiliary untitled window belonging to its
main process), no startup/recovery error, `clean=false` while active, and one
run-temp reservation. Settings changed tray-minimize from unchecked to checked;
portable config then has `setting.tray.enable=true`, while artifact hash,
journal state, absent legacy source, and installed sentinels stayed unchanged.
This verified second instance remains controller-owned and running.

## Coverage Gap And Release Ruling

No separately configured real NTFS, FAT32, or exFAT removable-media roots were
exercised. Final HEAD `29044c21` nevertheless proves local-volume portable
packaging, isolated default startup, unique concurrent extraction, restored
state integrity, schema/migration health, installed-data isolation, clean
title-bar shutdown, and second-launch reuse. Release bootstrap verification
passes subject to that explicit removable-media coverage gap.
