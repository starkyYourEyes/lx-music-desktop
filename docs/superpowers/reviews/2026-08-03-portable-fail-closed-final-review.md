# Portable Fail-Closed Final Review Evidence

- Review base: `c739fdc6`
- Review head: `d59aad9c`
- Full matrix: `passed`
- NTFS smoke: `environmental evidence gap`
- FAT32 smoke: `environmental evidence gap`
- exFAT smoke: `environmental evidence gap`
- Load-bearing review findings: `none`
- Non-blocking observations: `2 Minor` (recorded below with the final review ruling)

## Verification Environment

The final matrix ran from the isolated worktree on branch
`codex/storage-architecture-completion` at exact HEAD `d59aad9c`. Every test
command used the ignored disposable storage root:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:TEMP=$env:LX_TEST_STORAGE_ROOT
$env:TMP=$env:LX_TEST_STORAGE_ROOT
```

No real profile, portable, cache, backup, or user configuration directory was
used by the matrix.

## Full Matrix Evidence

| Command | Exit | Observed evidence |
| --- | ---: | --- |
| `git status --short` | 0 | No output; tracked worktree clean |
| `git diff --check` | 0 | No output |
| `npm run test:storage:portable` | 0 | 37 tests, 37 passed, 0 failed |
| `npm run test:storage` | 0 | 710 tests, 705 passed, 5 skipped, 0 failed |
| `npm run test:user-api` | 0 | 83 tests, 83 passed, 0 failed |
| `npx cross-env ELECTRON_RUN_AS_NODE=1 electron --test --test-concurrency=1 build-config/storage-electron/*.test.js` | 0 | 430 tests, 430 passed, literal `# fail 0` |
| `npm run lint` | 0 | No lint findings |
| `npm run build:main` | 0 | webpack compiled successfully |
| `npm run build:renderer` | 0 | webpack compiled successfully |
| `npm run test:main-bundle` | 0 | 1 test, 1 passed, 0 failed |
| final `git diff --check` | 0 | No output |

The five storage skips remain skips and are not represented as passes.

## Real-Volume Evidence

The Task 15 evidence loop produced exactly:

```text
EVIDENCE_GAP:ntfs:disposable root unavailable
EVIDENCE_GAP:fat32:disposable root unavailable
EVIDENCE_GAP:exfat:disposable root unavailable
```

- Real-volume passes: `0`
- Real-volume smoke failures: `0`
- Environmental evidence gaps: `3`

These are environmental evidence gaps, not successful tests. The portable
static/unit gate and Electron ABI portable integration passed, but behavior on
actual disposable NTFS, FAT32, and exFAT volumes was not observed in this
environment.

## Final Review Evidence

One read-only whole-branch review inspected `c739fdc6..d59aad9c`, covering 35
commits and the complete remediation plan. The reviewer returned:

- Status: `PASS_WITH_MINOR_FINDINGS`
- Critical findings: `0`
- Important findings: `0`
- Minor findings: `2`
- Load-bearing findings: `none`
- Merge verdict: `Ready to merge`

The seven required review criteria all received `PASS` verdicts:

1. No production hard-link dependency or stable-path destructive race remains.
2. Fresh DB and existing schema-6 backup/cutover branches obey their exact evidence contracts.
3. Prepared backup retries allocate no second candidate and final guard validation is in-transaction.
4. Root publication, cache creation, backup creation, and run-temp reservation occur in their allowed phases.
5. Portable retirement follows only journal-bound isolation state.
6. Default session and per-provider URL FIFO close their reviewed races.
7. Tests prove success reclamation and failure retention on every converted cleanup boundary.

## Non-Blocking Observations

### Minor 1: Authorization generation can leave its wire domain

`src/main/services/musicUrlAuthorization.ts:149` increments a provider's
generation without guarding `Number.MAX_SAFE_INTEGER`. The authorization
parser accepts only positive safe integers at
`src/common/storage/cacheValidation.ts:47`. After an impractically large
number of changed account transitions in one process, the service could issue
an authorization that its own IPC parser rejects.

Ruling: Minor and non-load-bearing. Reaching the boundary requires more than
nine quadrillion successful account transitions without restarting, so this
does not create a credible merge-time storage or credential race. A future
change should fail closed or rotate service state before incrementing beyond
the safe-integer domain.

### Minor 2: Three URL FIFO edge cases lack direct regression tests

The implementation is structurally correct, and the existing tests cover
stale queued writes, independent provider queues, pending invalidation retry,
flush waiting, direct and fallback request ordering, captured scope, canonical
response quality, and User API bypass. Direct regressions are still absent for:

1. a provider FIFO accepting later work after an earlier queued operation rejects;
2. two or more simultaneously pending invalidation scopes for one provider;
3. renderer mapping of a stale authorized read to a miss and a stale authorized write to an ignored best-effort result.

The recovery behavior is visible in
`src/main/services/musicUrlAuthorization.ts:69`-`72`, multi-scope retention in
the `Set` at lines 64-67 and 87-98, and renderer stale mapping in
`src/renderer/utils/ipc.ts:648`-`677`.

Ruling: one aggregated Minor, non-load-bearing test-gap finding. No behavior
defect was found in these paths.

## Final Ruling

No Critical or Important defect was found in the approved remediation range.
Neither Minor observation is load-bearing. The full matrix is green, all seven
required review criteria pass, and unavailable real-volume filesystems remain
explicitly labeled as environmental evidence gaps.

**Ready to merge.**
