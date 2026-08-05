# Portable First-Launch Bootstrap Release Evidence

- Source verification base: exact HEAD `15093773cad3e64946aebee3886d0754dc126fab`
- Platform: Windows x64
- Artifact and bootstrap verdict: `PASS`
- Default portable smoke: `4 pass / 0 skip / 0 fail`
- First launch, schema, close, snapshot, and second launch: `PASS`
- Current controller state: the verified second launch remains running.
- Residual coverage: real provider media and real NTFS/FAT32/exFAT removable-root loops were not exercised.

## Scope And Historical Evidence

This is the final reconstructed release evidence for exact HEAD
`15093773cad3e64946aebee3886d0754dc126fab`. The previous `40ab3fd` /
`0a0af3` records are historical and are not current evidence. In particular,
the old `89829...` artifact and all old PIDs are historical only.

The protected test was not manually opened, inspected, printed, modified,
restored, staged, or committed. The worktree Electron glob did load and execute
it; pure exact-commit Electron evidence instead comes from the archive suite.
Its required blob remains
`959df4d23cd581ce43493e1c83c95881e64a710f`. Protected Git references remain:
`stash@{0}`, commit `611e43f8f80ae348a062c66edef2be1db6986060`, and branch
`codex-pre-merge-user-db-assertion-20260804`.

## Preflight And Exact-Source Evidence

At the start, the only worktree change was the protected test. The blocked
artifact evidence remained `103490907` bytes with SHA-256
`6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5`.
Before build, `build/portable` was absent and target process count was zero.

The old portable tree was retained without deletion at
`.superpowers/evidence/2026-08-05-pre-final-review-fix-portable`:
`225` files, `49` child directories, `71203481` bytes.

| Exact-source item | Result |
| --- | --- |
| Archive | `.superpowers/evidence/2026-08-05-exact-head-storage-electron.zip` |
| Archive length / SHA-256 | `14671534` bytes / `FA67B361AF1EE4E5A3FA7B4DE6A75476DADE080CD10D51796A7B4EA3E679002E` |
| Extracted source | `1274` files |
| Isolated Electron suite | `431` tests, `30` suites, `431 pass / 0 fail / 0 skip` |
| Isolated duration / exit | `19779.1949 ms` / `0` |

The isolated suite ran from the archive extraction, rather than the worktree,
and is the pure exact-commit Electron-storage evidence. Its working directory
and exact archive-isolation command were:

```powershell
$env:LX_TEST_STORAGE_ROOT='D:\projects\lx-music-desktop\.superpowers\t'
$env:ELECTRON_RUN_AS_NODE='1'
$env:NODE_PATH='D:\projects\lx-music-desktop\node_modules'
Set-Location 'D:\projects\lx-music-desktop\.superpowers\evidence\2026-08-05-exact-head-storage-electron'
& 'D:\projects\lx-music-desktop\node_modules\electron\dist\electron.exe' --test 'build-config/storage-electron/*.test.js'
```

## Source Matrix

All effective commands ran independently in an environment that permits child
processes. The common setup was:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
```

A restricted sandbox's spawn `EPERM` is an environment diagnostic, not a code
failure; it is not counted as valid matrix evidence.

| Command | Exit | Result | Duration |
| --- | ---: | --- | ---: |
| `node --test scripts/test-legacy-user-data-migration.js` | 0 | `31 pass / 0 skip / 0 fail` | `15454.6831 ms` |
| `npm run test:storage` | 0 | `731` tests, `56` suites, `726 pass / 5 skip / 0 fail` | `37672.0752 ms` |
| `npm run test:storage:portable` | 0 | `37` tests, `2` suites, `37 pass / 0 fail` | `7259.1302 ms` |
| `npm run test:user-api` | 0 | `122 pass / 0 fail` | `6142.8349 ms` |
| `node --test build-config/playback-source-fallback.test.js build-config/playback-media-validation.test.js build-config/playback-source-setting.test.js` | 0 | `151 pass / 0 fail` | `8312.2246 ms` |
| `npm run test:storage:electron` | 0 | `431` tests, `30` suites, `431 pass / 0 skip / 0 fail` | `18622.3496 ms` |
| `npm run lint` | 0 | `caniuse-lite` notice only | n/a |
| `npm run build` | 0 | successful build | `85 s` wall; pack `1:22.103` |
| `npm run test:main-bundle` | 0 | `1 pass / 0 fail` | `15661.6318 ms` |
| `git diff --check -- . ':(exclude)build-config/storage-electron/database-recovery.test.js'` | 0 | scoped whitespace check | n/a |

The worktree Electron glob executes the protected worktree test, so its 431
passes are not pure exact-commit evidence. The archive suite above is the pure
exact-commit result.

## Package, 7-Zip, And Default Smoke

`npm run pack:win:portable:x64` exited `0` in `153.7 s`.
`npm run test:packaged-app` passed `2/2` in `165.4846 ms`.

```powershell
npm run pack:win:portable:x64
npm run test:packaged-app
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:LX_PORTABLE_ARTIFACT=(Resolve-Path 'build\starky-lx-music-desktop-v3.0.0-x64-portable.exe').Path
npm run test:portable-packaged-bootstrap
```

| Artifact property | Value |
| --- | --- |
| Path | `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` |
| Length | `103493632` bytes |
| Creation UTC | `2026-08-05T06:53:53.0161920Z` |
| Last-write UTC | `2026-08-05T06:53:53.3166291Z` |
| SHA-256 | `E2EE87DEA443E7115B2F2B7ADCB53610017970474659B2555C9D39C3B0E7FBAC` |

The current artifact differs from the three blocked hashes
`937C05AF1EAA5F6FED1D6B9C208A031FF4ABDF3CE023404BA56CD7DDAA9FF4E3`,
`11FD8058213BC3558C593CEED9C872D45BC9F16A44B34CAE544ACA9C0BFC0186`, and
`6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5`.
It also differs from the historical previously passing artifact
`89829C7538240AB4FB0E5FAF85F5EFB8A804AFF58C13E95104216CE23C215E41`.
The default portable smoke was three helper tests plus one real
default-empty-argv packaged launch, for `4` total: `4 pass / 0 skip / 0 fail`,
`13879.3275 ms`, exit `0`. It used empty argv and no `--user-data-dir`
override. After smoke, target process count, fixture process count, and
`build/portable` were all zero/absent.

The local planned 7-Zip path was unavailable. The fallback was:

    C:\Users\hao238\AppData\Local\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-1nrf7\bin\7za.exe

It was `849920` bytes, SHA-256
`223B873C50380FE9A39F1A22B6ABF8D46DB506E1C08D08312902F6F3CD1F7AC3`.
7-Zip `24.09 x86` exited `0` with `Everything is Ok`, covering `79`
files and `3` folders. The expected NSIS tail-signature warning was reported
but did not affect the successful exit.

```powershell
& 'C:\Users\hao238\AppData\Local\electron-builder\Cache\7zip@1.0.0\7zip-win-x64-1nrf7\bin\7za.exe' t $env:LX_PORTABLE_ARTIFACT
```

## Installed Sentinel Isolation

Only metadata and hashes were read. No sentinel contents were printed or parsed.
The frozen absolute paths were:

```text
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\lx.data.db
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\config_v2.json
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\cache\cache.db
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\runtime\run-state.v1.json
```

| Sentinel | Length | UTC mtime | SHA-256 |
| --- | ---: | --- | --- |
| `LxDatas/lx.data.db` | 49512448 | `2026-08-04T22:04:38.4306334Z` | `CD318C24446E97ADA1B354E88650A1DF5A8FB8DE618EFFFF522A25E823C7724B` |
| `LxDatas/config_v2.json` | 5493 | `2026-08-04T22:04:37.9573321Z` | `F7F73169F99D3B30B25C904921EDF37E540ECC4105FE2A28C41BFDB2B166F6A7` |
| `cache/cache.db` | 86016 | `2026-08-04T22:04:38.4386651Z` | `2FE3EC5A833BF2AC3BFAA62106F0A963E1CA4EA6BBD5D8F57821BA6AD3CF0AB0` |
| `runtime/run-state.v1.json` | 73 | `2026-08-04T22:59:26.6913437Z` | `45503D71B01251A11D37346B8C6C0AA84F36E564F6B95EB443B7C38B087432A4` |

All four were unchanged on the first and second launch (`4/4` each).

## True First Launch And Schema

Computer Use launched the real current artifact with default empty arguments.
`sky.launch_app` reported that it did not expose a targetable window; a fresh
list then found exactly one `LX Music` instance. Launcher PID was `18996`; main
PID was `3500`.

The new-profile license-agreement countdown was visible and accepted as an
allowed ToS action. The normal free-software notice appeared, followed by the
main UI. No recovery, startup, migration, or database error was visible.

Required direct, non-reparse paths:

    portable/profile/lx.data.db
    portable/cache/cache.db
    portable/runtime/electron-user-data
    portable/runtime/session-data
    portable/runtime/run-state.v1.json
    portable/temp

Absent paths:

    portable/backups
    portable/profile/data.json
    portable/userData
    portable/.portable-profile-migration.json
    portable/.portable-profile-migration.pending.json

The query used the Electron ABI with `better-sqlite3`, `readonly:true`,
`fileMustExist:true`, and SQLite `query_only=1`; it returned version `7`.

| Version | Name | Checksum suffix | applied_at_ms |
| ---: | --- | --- | ---: |
| 3 | `storage_foundation` | `9243...e41` | 1785913032398 |
| 4 | `account_profiles` | `885ff...451` | 1785913032398 |
| 5 | `non_activity_state` | `a4dda...c65` | 1785913032398 |
| 6 | `playback_activity` | `41fd...04b` | 1785913032398 |
| 7 | `cache_cleanup` | `493156...1b2` | 1785913032559 |

Full migration checksums were verified as:
`9243aa510e8355d2c3d0f687c6736654adf584ec6007b1bcf46f374a9d694e41`,
`885ff60acc5b2eece73a566fb59f73a7d3d3496d846c98a38d2f6be359638451`,
`a4dda51309eb5e7e98d61125bc50bf7342b6aba5e367d5824a9b357774bc8c65`,
`41fd08b6838c90dcd78435d38eb0ec112be9a0ee9c442fdf0efec669da60904b`,
and `493156099746b38631fc96a4ec2c03a3607e5e848f6f05bafa5f510bf1fa61b2`.

## Title-Bar Close And Snapshot

The real title-bar Close was sent. Escape interrupted the tool return, not the
action. An independent subsequent state check found zero windows and zero target
processes, confirming a natural close; the result is not unknown.

Run-state recorded `version:1`, `clean:true`,
`startedAtMs:1785913032222` (`2026-08-05T06:57:12.222Z`), and
`completedAtMs:1785913443668` (`2026-08-05T07:04:03.668Z`).
`portable/temp/run-*` direct-child count was `0`.

The source was retained and copied to initially absent
`.superpowers/evidence/2026-08-05-post-final-review-fix-first-launch-portable`.
Before copy it was absent; source and full tree had zero reparse entries.
Item type, length, and SHA-256 were verified. The snapshot is `130` files,
`45` child directories, and `38730899` bytes.

The first evidence script failed because PowerShell 5.1 lacks
`GetRelativePath`, after copying had completed. Without deleting or recopying,
it was corrected to use validated prefix-relative paths; full verification of
the existing copy then passed. This records an evidence-script correction only.

## Second Launch Reuse

The same artifact launched again with empty arguments. Its helper timed out, but
fresh inspection found exactly one `LX Music` instance. The settings page was
reused, the license did not reappear, no error was visible, and tray-minimize
was unchecked.

- Launcher PID `50420`, started `2026-08-05T07:13:51.0285320Z`
- Main PID `7700`, started `2026-08-05T07:13:59.1671560Z`
- Main child count `5`
- Liveness audit `2026-08-05T07:18:10.7875463Z`
- Run-state: `clean:false`, `startedAtMs:1785914040347`
  (`2026-08-05T07:14:00.347Z`)

At that audit all six required paths remained direct/non-reparse; all five
forbidden paths remained absent. The second query was again `query_only=1`,
version `7`, with the same migration rows. Sentinel metadata was unchanged
`4/4`, snapshot counts were unchanged, and artifact hash remained
`E2EE87DEA443E7115B2F2B7ADCB53610017970474659B2555C9D39C3B0E7FBAC`.

The parent controller intentionally holds this verified second instance. This
documentation refresh did not start, close, click, or otherwise alter it.

## Evidence-Loss History And Coverage Gaps

An earlier release-evidence ordering allowed an unpreserved `build/portable`
tree to be lost because `build-config/pack.js` removes `build/**`. This run
does not reconstruct that tree: it began with `build/portable` absent,
preserved older evidence before building, and copied the current first-launch
tree before the second launch.

No real provider track was configured or played. No real NTFS, FAT32, or exFAT
removable roots were configured and exercised. Provider/network/decode/output
and real-media filesystem coverage remain declared gaps, not passes.

## Release Ruling

Exact HEAD `15093773cad3e64946aebee3886d0754dc126fab` produced the current,
distinct Windows x64 portable artifact. Default-argument launch created and
reused launcher-local schema-7 storage, left installed sentinels unchanged,
closed cleanly, preserved a verified first-launch tree, and reached the normal
UI on its controller-held second launch.

**Release bootstrap verification passes with the explicit real-media and
real-volume coverage gaps above.**
