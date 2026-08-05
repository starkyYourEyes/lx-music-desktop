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

## Earlier Evidence-Loss Incident

An earlier Task 4 ordering allowed `npm run build` to clean blocked
`build\portable` before it was moved. No recoverable tree copy was found, and
no placeholder was claimed. That historical loss is distinct from the final
HEAD backup-and-restore evidence below.

## Final Source Verification

Previously established on exact final HEAD: mutable-state replay `1/1`,
`non-activity-retry` `5/5`, legacy migration `31/31`, storage `732 pass / 5
skip / 0 fail` (`737` total), and portable storage `37/37`.

The final-pass commands were run independently with this storage-root setup:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
npm run test:user-api
node --test build-config/playback-source-fallback.test.js build-config/playback-media-validation.test.js build-config/playback-source-setting.test.js
electron.exe --test --test-concurrency=1 `
  build-config/storage-electron/account-profile.test.js `
  build-config/storage-electron/cache-cutover.test.js `
  build-config/storage-electron/cache-db.test.js `
  build-config/storage-electron/cache-lifecycle.test.js `
  build-config/storage-electron/cache-phase4.integration.test.js `
  build-config/storage-electron/cache-policy.test.js `
  build-config/storage-electron/migration-runner.test.js `
  build-config/storage-electron/non-activity-repository.test.js `
  build-config/storage-electron/non-activity-retry.test.js `
  build-config/storage-electron/playback-clear.test.js `
  build-config/storage-electron/playback-migration.test.js `
  build-config/storage-electron/playback-phase3.integration.test.js `
  build-config/storage-electron/playback-renderer-crash.integration.test.js `
  build-config/storage-electron/playback-retention.test.js `
  build-config/storage-electron/playback-schema.test.js `
  build-config/storage-electron/playback-storage.test.js `
  build-config/storage-electron/raw-lyric-migration.test.js `
  build-config/storage-electron/safe-storage-vault.test.js `
  build-config/storage-electron/scoped-cache-repository.test.js `
  build-config/storage-electron/storage-foundation.integration.test.js
npm run lint
npm run build
npm run test:main-bundle
git diff --check -- . ':(exclude)build-config/storage-electron/database-recovery.test.js'
```

The explicit Electron command is the final-pass substitute for the plan's
protected-file-inclusive glob; it names all 20 allowed suites and excludes the
protected test without opening or executing it.

| Command | Final result |
| --- | --- |
| `npm run test:user-api` | exit `0`; `122 pass / 0 skip/fail`; 7.620 s TAP |
| `node --test build-config/playback-source-fallback.test.js build-config/playback-media-validation.test.js build-config/playback-source-setting.test.js` | exit `0`; `151 pass / 0 skip/fail`; 11.552 s TAP |
| Explicit `electron.exe --test --test-concurrency=1` 20-file command above | exit `0`; `369 pass / 0 skip/fail`; 26 suites; 65.761 s TAP |
| `npm run lint` | exit `0`; 205.4 s; existing Browserslist/caniuse-lite age advisory only |
| `npm run build` | exit `0`; 106.9 s; all webpack targets compiled |
| `npm run test:main-bundle` | exit `0`; `1 pass / 0 fail`; live runtime environment preserved |
| `git diff --check -- . ':(exclude)build-config/storage-electron/database-recovery.test.js'` | exit `0` |

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

### Snapshot Deviation

This final restored-data pass did not create the plan's separate
post-first-launch snapshot before the second launch. The verified external
backup is a recovery source, not a replacement snapshot claim. The in-place
clean-close evidence below remains verified; no post-first-launch inventory or
snapshot path is invented for this final pass.

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

All four installed sentinel rows matched before launch, during first launch,
after second launch, and after the tray-setting change (`4/4` unchanged at each
comparison). Contents were not read or parsed.

| Sentinel | Bytes | UTC mtime | SHA-256 |
| --- | ---: | --- | --- |
| `C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\lx.data.db` | 49,512,448 | `2026-08-04T22:04:38.4306334Z` | `CD318C24446E97ADA1B354E88650A1DF5A8FB8DE618EFFFF522A25E823C7724B` |
| `C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\config_v2.json` | 5,493 | `2026-08-04T22:04:37.9573321Z` | `F7F73169F99D3B30B25C904921EDF37E540ECC4105FE2A28C41BFDB2B166F6A7` |
| `C:\Users\hao238\AppData\Local\starky-lx-music-desktop\cache\cache.db` | 86,016 | `2026-08-04T22:04:38.4386651Z` | `2FE3EC5A833BF2AC3BFAA62106F0A963E1CA4EA6BBD5D8F57821BA6AD3CF0AB0` |
| `C:\Users\hao238\AppData\Local\starky-lx-music-desktop\runtime\run-state.v1.json` | 73 | `2026-08-04T22:59:26.6913437Z` | `45503D71B01251A11D37346B8C6C0AA84F36E564F6B95EB443B7C38B087432A4` |

The final EXE's first real restored-data launch reached one normal, error-free
`LX Music` window from `Temp\nsa6113.tmp`; helper targeting timed out, but
window discovery recovered the live main window. Direct non-reparse portable
paths existed for profile database/config, cache, Electron user/session data,
run state, and temp. During the run, `clean=false`, one `temp\run-*` existed,
and sentinels remained unchanged. A real title-bar Close with tray disabled
left all target processes at zero, `clean=true`,
`startedAtMs=1785950689101` (`2026-08-05T17:24:49.101Z`), and
`completedAtMs=1785950762267` (`2026-08-05T17:26:02.267Z`), with completion
after start, no `run-*`, and an empty portable temp directory.

The same artifact then reused restored data from `Temp\nsm3893.tmp`: one normal
exact-titled main window (with one auxiliary untitled window belonging to its
main process), no startup/recovery error, `clean=false` while active, and one
run-temp reservation. Its launcher PID was `39172`, main PID was `47868`, and
`run-state.startedAtMs=1785950809733` (`2026-08-05T17:26:49.733Z`). Settings
changed tray-minimize from unchecked to checked;
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
