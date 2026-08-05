# Portable Early Electron Path Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bind Electron to guarded, launcher-local runtime paths before bootstrap first yields, then rebuild and prove the Windows x64 portable artifact through true first and second launches.

**Architecture:** Add a persistent `electronUserDataRoot` beside the existing `sessionDataRoot`, prepare both synchronously under direct-directory guards, and publish them once before any asynchronous migration. Keep authoritative application data under `profileRoot`, leave portable and installed migrations unchanged, and use an isolated real-NSIS smoke plus visible release verification to prove the startup boundary.

**Tech Stack:** Electron 37.6.1, electron-builder 26.15.3 NSIS portable target, TypeScript, Node.js 22 `node:test`, webpack 5.105.2, PowerShell, better-sqlite3 under the Electron ABI, and Computer Use.

## Global Constraints

- `userData` must be `<runtimeRoot>/electron-user-data` and `sessionData` must be `<runtimeRoot>/session-data`; both directories must exist and be guarded before the first bootstrap `await`.
- Electron paths are published exactly once per process and are never rebound to `profileRoot` after an asynchronous boundary.
- Installed persistent runtime state uses LocalAppData on Windows and a dedicated `appData` sibling on macOS/Linux; it must not live under an OS-cleared cache root.
- Authoritative settings, credentials, playlists, playback facts, and databases remain under `profileRoot`; portable migration still copies only `portable/userData/LxDatas` to `portable/profile`.
- Do not customize the NSIS template, append `--user-data-dir`, or add a bootstrap-only environment bypass.
- A valid portable launcher may create only `portable`, `runtime`, `runtime/electron-user-data`, and `runtime/session-data` before migration; it must not consult installed AppData or eagerly create profile, temp, cache, backups, or run-temp.
- Invalid launcher input and linked, reparse, or changed early runtime roots fail closed before Electron path publication or installed migration.
- Missing cache and backup roots remain absent until their existing owners create them; a fresh database creates no backups.
- Preserve the current blocked artifact and any `build/portable` evidence before `npm run build` or another command that executes `build-config/pack.js`.
- Never print or parse installed sentinel contents. Compare only size, UTC modification time, and SHA-256.
- Do not modify, restore, delete, stage, or commit `build-config/storage-electron/database-recovery.test.js`.
- Preserve `stash@{0}`, commit `611e43f8`, branch `codex-pre-merge-user-db-assertion-20260804`, installed-profile backups, and retained `.superpowers` diagnostics.
- Use RED/GREEN TDD, run every stated verification independently, and stage only files listed by the current task.
- Do not claim NTFS/FAT32/exFAT real-media coverage unless explicit roots are configured and actually exercised.

---

### Task 1: Preserve the Blocked Artifact and Add a Real Packaged RED

**Files:**
- Create: `build-config/portable-packaged-bootstrap.test.js`
- Modify: `package.json`

**Interfaces:**
- Consumes: `LX_PORTABLE_ARTIFACT`, `LX_TEST_STORAGE_ROOT`, and a Windows NSIS portable executable.
- Produces: `npm run test:portable-packaged-bootstrap`, which launches a copied artifact with an empty argument list and isolated host-profile traps.

- [ ] **Step 1: Preserve the known blocked artifact before any build cleanup**

Require a zero target-process count and absent `build\portable`. Perform all
of those gates, plus the exact source size and fixed hash checks, before
creating the evidence directory. Verify the source file has size `103490907`
and SHA-256
`6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5`.
Copy it to the initially absent evidence directory, then compare the hashes:

```powershell
$source = (Resolve-Path 'build\starky-lx-music-desktop-v3.0.0-x64-portable.exe').Path
$evidence = Join-Path (Resolve-Path '.superpowers').Path 'evidence\2026-08-05-default-startup-blocked-artifact'
$targetProcesses = @(Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -like '*starky-lx-music-desktop*') -or
  ($_.ExecutablePath -and $_.ExecutablePath.StartsWith(
    (Join-Path (Resolve-Path 'build').Path ''),
    [StringComparison]::OrdinalIgnoreCase))
})
if ($targetProcesses.Count -ne 0) { throw 'Target application processes are still running' }
if (Test-Path -LiteralPath 'build\portable') { throw 'build\portable must be preserved separately before continuing' }
$sourceItem = Get-Item -LiteralPath $source
$sourceHash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
if ($sourceItem.Length -ne 103490907) { throw "Blocked artifact size mismatch: $($sourceItem.Length)" }
if ($sourceHash -ne '6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5') { throw "Blocked artifact hash mismatch: $sourceHash" }
if (Test-Path -LiteralPath $evidence) { throw "Evidence destination already exists: $evidence" }
New-Item -ItemType Directory -Path $evidence | Out-Null
$copy = Join-Path $evidence 'starky-lx-music-desktop-v3.0.0-x64-portable.exe'
Copy-Item -LiteralPath $source -Destination $copy
if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $copy -Algorithm SHA256).Hash) { throw 'Blocked artifact evidence hash mismatch' }
```

Do not move or delete the source in this step. Record the copy path and hash in
this plan's progress ledger.

- [ ] **Step 2: Write the opt-in packaged startup test**

Create `build-config/portable-packaged-bootstrap.test.js` with these observable
contracts:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')
const { createTestStorageRoot } = require('./storage/helpers/test-storage-root.js')

const startupTimeoutMs = 45_000
const cleanupTimeoutMs = 10_000
const pollIntervalMs = 200

const waitForDefaultStartup = async({ launcher, requiredPaths }) => {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    if (launcher.exitCode != null) {
      assert.fail(`portable launcher exited before startup completed: ${launcher.exitCode}`)
    }
    if (requiredPaths.every(targetPath => fs.existsSync(targetPath))) return
    await delay(pollIntervalMs)
  }
  assert.fail(`portable startup did not publish required paths within ${startupTimeoutMs} ms`)
}

test('default NSIS portable launch reaches launcher-local storage without a user-data-dir override', {
  skip: process.platform != 'win32' || process.env.LX_PORTABLE_ARTIFACT == null
    ? 'Windows portable artifact and LX_PORTABLE_ARTIFACT required'
    : false,
  timeout: 90_000,
}, async t => {
  const artifact = process.env.LX_PORTABLE_ARTIFACT
  assert.equal(typeof artifact, 'string', 'LX_PORTABLE_ARTIFACT is required')
  assert.equal(path.isAbsolute(artifact), true)
  assert.equal(fs.lstatSync(artifact).isFile(), true)

  const fixture = createTestStorageRoot('packaged-bootstrap')
  const launcherRoot = path.join(fixture.path, 'launcher')
  const hostRoot = path.join(fixture.path, 'host')
  const roaming = path.join(hostRoot, 'roaming')
  const local = path.join(hostRoot, 'local')
  const userProfile = path.join(hostRoot, 'user')
  const temp = path.join(hostRoot, 'temp')
  for (const directoryPath of [launcherRoot, roaming, local, userProfile, temp]) {
    fs.mkdirSync(directoryPath, { recursive: true })
  }

  const copiedArtifact = path.join(launcherRoot, 'artifact.exe')
  fs.copyFileSync(artifact, copiedArtifact)
  const launcherArguments = []
  assert.deepEqual(launcherArguments, [])

  const childEnv = {
    ...process.env,
    APPDATA: roaming,
    LOCALAPPDATA: local,
    USERPROFILE: userProfile,
    HOME: userProfile,
    HOMEDRIVE: path.parse(userProfile).root.slice(0, 2),
    HOMEPATH: userProfile.slice(path.parse(userProfile).root.length - 1),
    TEMP: temp,
    TMP: temp,
  }
  delete childEnv.PORTABLE_EXECUTABLE_DIR
  delete childEnv.ELECTRON_RUN_AS_NODE

  const launcher = spawn(copiedArtifact, launcherArguments, {
    cwd: launcherRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const portableRoot = path.join(launcherRoot, 'portable')
  await waitForDefaultStartup({
    launcher,
    requiredPaths: [
      path.join(portableRoot, 'profile', 'lx.data.db'),
      path.join(portableRoot, 'runtime', 'electron-user-data'),
      path.join(portableRoot, 'runtime', 'session-data'),
      path.join(portableRoot, 'runtime', 'run-state.v1.json'),
      path.join(portableRoot, 'temp'),
    ],
  })

  assert.equal(fs.existsSync(path.join(roaming, 'starky-lx-music-desktop')), false)
  assert.equal(fs.existsSync(path.join(local, 'starky-lx-music-desktop')), false)
  assert.equal(fs.existsSync(path.join(portableRoot, 'backups')), false)
})
```

Complete the test with these exact process-observation and cleanup rules:

- Keep only the final 32 KiB of launcher stdout and stderr and include them in
  spawn-error, early-exit, and timeout failures. Register the async cleanup
  hook immediately after fixture creation so copy or spawn failures cannot
  bypass owned-fixture cleanup.
- Every required file or directory must be checked with `lstatSync`; reject
  links and require the expected file type.
- Once per second, enumerate processes with the following static PowerShell
  script passed to `execFile('powershell.exe', argv, options, callback)`. Pass
  the fixture only through `LX_PORTABLE_FIXTURE_ROOT`; never interpolate it into
  the script:

```powershell
$root = [IO.Path]::GetFullPath($env:LX_PORTABLE_FIXTURE_ROOT).TrimEnd('\') + '\'
Get-CimInstance Win32_Process |
  Where-Object {
    $_.ExecutablePath -and
    [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith(
      $root, [StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object ProcessId, ParentProcessId, ExecutablePath |
  ConvertTo-Json -Compress
```

- Startup passes only when all required paths are valid, the NSIS launcher is
  still running, and at least one enumerated process has an executable path
  inside the fixture.
- In one async `t.after` hook, enumerate fixture-owned processes again. Never
  use `taskkill /T`: launcher identity alone does not prove every descendant is
  fixture-owned. Build the parent/child graph from the enumerated inventory,
  terminate verified fixture-owned positive integer PIDs deepest-child-first
  with `taskkill.exe /PID <pid> /F`, then re-enumerate to handle races.
- If the launcher is alive, require its enumerated executable path to equal the
  copied `artifact.exe` after case-insensitive full-path normalization before
  terminating that PID. Condition-poll under a cleanup-specific deadline for
  at most `cleanupTimeoutMs` until the fixture-owned list is empty.
- Call `fixture.cleanup()` only after the owned process list is empty. If any
  process remains or launcher identity cannot be proven, retain the fixture and
  fail with its path and PID inventory. Never kill a process whose executable
  path is outside the fixture.

Add this package script without changing another script:

```json
"test:portable-packaged-bootstrap": "node --test build-config/portable-packaged-bootstrap.test.js"
```

- [ ] **Step 3: Run the packaged test against the preserved broken artifact and verify RED**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
$env:LX_PORTABLE_ARTIFACT=(Resolve-Path '.superpowers\evidence\2026-08-05-default-startup-blocked-artifact\starky-lx-music-desktop-v3.0.0-x64-portable.exe').Path
npm run test:portable-packaged-bootstrap
```

Expected: exit 1 after the launcher exits with code 1, before all required
portable paths exist. Confirm the test launched with no `--user-data-dir`.

- [ ] **Step 4: Verify the harness and corrected release ordering**

```powershell
npx eslint --ext .js -f stylish build-config/portable-packaged-bootstrap.test.js
git diff --check
```

Expected: both commands exit 0. Manually confirm the separately committed older
plan correction places evidence preservation before `npm run build`.

- [ ] **Step 5: Commit the RED harness**

```powershell
git add package.json build-config/portable-packaged-bootstrap.test.js
git commit -m "test: reproduce default portable bootstrap failure"
```

### Task 2: Add Canonical Stable Electron Runtime Roots

**Files:**
- Modify: `src/main/utils/storagePaths.ts`
- Test: `build-config/storage/storage-paths.test.js`

**Interfaces:**
- Produces: `StoragePaths.electronUserDataRoot: string`.
- Produces: `prepareElectronBootstrapPaths(input: ElectronBootstrapPathInput): Readonly<ElectronBootstrapPaths>`.
- Produces: a persistent installed runtime-root resolver separate from the cache-root resolver on macOS/Linux.
- Preserves: `initializeStoragePaths(input): Promise<InitializedStoragePaths>` and all existing cache, backup, profile, and run-temp ownership.

- [ ] **Step 1: Write failing path-resolution and early-preparation tests**

Add `electronUserDataRoot` to the literal installed and portable expectations:

```js
electronUserDataRoot: path.join(expectedRuntimeRoot, 'electron-user-data'),
```

Add a focused test using a fresh portable root:

```js
it('prepares only stable Electron runtime roots before asynchronous bootstrap work', () => {
  const root = createFixture('storage-early-electron')
  const portableRoot = path.join(root, 'portable')
  fs.mkdirSync(portableRoot)
  const { prepareElectronBootstrapPaths } = require(storagePathsModule)

  const paths = prepareElectronBootstrapPaths({
    applicationRuntimeRoot: path.join(root, 'ignored-runtime'),
    portableRoot,
  })

  assert.deepEqual(paths, {
    runtimeRoot: path.join(portableRoot, 'runtime'),
    electronUserDataRoot: path.join(portableRoot, 'runtime', 'electron-user-data'),
    sessionDataRoot: path.join(portableRoot, 'runtime', 'session-data'),
  })
  assert.equal(Object.isFrozen(paths), true)
  for (const targetPath of Object.values(paths)) {
    const stat = fs.lstatSync(targetPath)
    assert.equal(stat.isDirectory(), true)
    assert.equal(stat.isSymbolicLink(), false)
  }
  for (const basename of ['profile', 'temp', 'cache', 'backups']) {
    assert.equal(fs.existsSync(path.join(portableRoot, basename)), false)
  }
})
```

Add the installed equivalent with separate roaming, cache, and runtime fixtures.
It must create only `runtime`, `runtime/electron-user-data`, and
`runtime/session-data`; the roaming migration target, profile, temp, cache,
backups, and run-temp roots must remain absent. Add literal platform cases
proving Windows uses the LocalAppData runtime child while macOS/Linux use a
dedicated sibling under `appData`, never `Library/Caches` or `XDG_CACHE_HOME`.

Add a table-driven test that precreates a junction/link at each of `runtime`,
`runtime/electron-user-data`, and `runtime/session-data`, then requires
`prepareElectronBootstrapPaths` to throw `direct_directory_invalid` without
returning paths. Use the existing Windows privilege skip convention. Extend
the existing filesystem swap-hook pattern to replace the held runtime parent or
one stable child before final revalidation; require the helper to throw before
returning any publishable paths.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test --test-name-pattern "builds distinct|builds explicit|resolves persistent installed runtime|prepares only stable|rejects linked early|rejects replaced early" build-config/storage/storage-paths.test.js
```

Expected: exit 1 because `electronUserDataRoot` and
`prepareElectronBootstrapPaths` do not exist.

- [ ] **Step 3: Implement the canonical resolver and synchronous guarded preparation**

In `storagePaths.ts`, add:

```ts
export interface ElectronBootstrapPathInput {
  applicationRuntimeRoot: string
  portableRoot: string | null
}

export type ElectronBootstrapPaths = Readonly<Pick<
  StoragePaths,
  'runtimeRoot' | 'electronUserDataRoot' | 'sessionDataRoot'
>>
```

Add `electronUserDataRoot` to `StoragePaths`. Use one pure resolver for both the
early helper and `resolveStoragePaths`:

```ts
const resolveElectronBootstrapPaths = (input: ElectronBootstrapPathInput): ElectronBootstrapPaths => {
  const runtimeRoot = input.portableRoot == null
    ? path.resolve(input.applicationRuntimeRoot)
    : path.join(path.resolve(input.portableRoot), 'runtime')
  return Object.freeze({
    runtimeRoot,
    electronUserDataRoot: path.join(runtimeRoot, 'electron-user-data'),
    sessionDataRoot: path.join(runtimeRoot, 'session-data'),
  })
}
```

Implement `prepareElectronBootstrapPaths` synchronously. Create or validate
`runtimeRoot` with the existing recursive guarded `ensureDirectDirectory`, then
create/validate the two exact direct children with
`createDirectChildDirectory(runtimeGuard, basename, { mode: 0o700 })`.
Revalidate all three guards, return the frozen pure resolution, and close child
guards before the runtime guard in `finally`.

Add `applicationRuntimeRoot` to installed storage resolution. Add a pure
`resolveApplicationRuntimeRoot` that returns the existing LocalAppData runtime
child on Windows and a dedicated `<appData>/<user-data-dir-name>-runtime`
sibling on macOS/Linux. Make `resolveStoragePaths` spread the same resolved
Electron paths, and include `electronUserDataRoot` in full required-root
validation. Do not create cache or backups.

- [ ] **Step 4: Run focused and adjacent GREEN verification**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test build-config/storage/storage-paths.test.js
npx eslint --ext .ts,.js -f stylish src/main/utils/storagePaths.ts build-config/storage/storage-paths.test.js
npm run build:main
git diff --check
```

Expected: all commands exit 0; storage path tests report no failures.

- [ ] **Step 5: Commit canonical Electron paths**

```powershell
git add src/main/utils/storagePaths.ts build-config/storage/storage-paths.test.js
git commit -m "feat: add stable Electron runtime paths"
```

### Task 3: Publish Electron Paths Before the First Await

**Files:**
- Modify: `src/main/bootstrap.ts`
- Test: `build-config/storage/startup-coordinator.test.js`
- Test: `build-config/storage/storage-paths.test.js`
- Test: `scripts/test-legacy-user-data-migration.js`

**Interfaces:**
- Consumes: `prepareElectronBootstrapPaths` from Task 2.
- Publishes: `app.setPath('userData', electronUserDataRoot)` and `app.setPath('sessionData', sessionDataRoot)` exactly once before retirement or installed migration begins.
- Preserves: portable retirement/preparation, installed legacy migration, full storage initialization, and dynamic application import.

- [ ] **Step 1: Write failing first-await sequencing tests**

Extend `portable bootstrap sequencing` with portable and installed cases. The
first asynchronous dependency must synchronously inspect calls before its first
own `await`:

```js
const expectedElectronPaths = {
  electronUserDataRoot: 'C:\\runtime\\electron-user-data',
  runtimeRoot: 'C:\\runtime',
  sessionDataRoot: 'C:\\runtime\\session-data',
}
const setPathCalls = []
const assertPublished = () => assert.deepEqual(setPathCalls, [
  ['userData', expectedElectronPaths.electronUserDataRoot],
  ['sessionData', expectedElectronPaths.sessionDataRoot],
])
```

For portable mode, call `assertPublished()` as the first line of the
`retireAcknowledgedPortableSource` async stub. For installed mode, return
`null` from `preparePortableUserDataPaths` and call `assertPublished()` as the
first line of the `migrateLegacyUserData` async stub. Both cases inject:

```js
prepareElectronBootstrapPaths: () => expectedElectronPaths,
```

Require successful application loading and assert no later `setPath` calls.
Also keep the existing retirement/preparation failure-order assertions.

Add a mismatch case where full initialization returns a different
`electronUserDataRoot` or `sessionDataRoot`. It must observe exactly the two
early `setPath` calls, then `exit(1)` without application loading and without
another `setPath`. Keep a positive case proving full initialization returns the
same two early paths.

Update the real bootstrap tests so a linked `runtime`, `electron-user-data`, or
`session-data` produces `exit:1` before any `setPath`. A linked `profile` or
`temp` may be discovered after the two valid stable paths are published, but it
must still exit before application loading and must never bind `profile` as
`userData`.

Update the installed migration harness expectation: Electron `userData` is the
local runtime `electron-user-data` directory, while `global.lxDataPath` and the
migrated config remain under the roaming `LxDatas` profile. Simulated Electron
metadata must be written under the runtime root, not under the business
profile.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test --test-name-pattern "publishes stable Electron paths|portable bootstrap sequencing" build-config/storage/startup-coordinator.test.js
node --test --test-name-pattern "early Electron bootstrap" build-config/storage/storage-paths.test.js
node --test --test-name-pattern "startup migrates legacy data" scripts/test-legacy-user-data-migration.js
```

Expected: at least the first-await sequencing test fails because current
bootstrap reaches the async dependency with no published paths.

- [ ] **Step 3: Implement single-publication bootstrap ordering**

Import `prepareElectronBootstrapPaths` and the `ElectronBootstrapPaths` type.
After portable selection and before an async operation, resolve the installed
inputs, prepare the paths, and publish them within one fail-closed block:

```ts
let applicationCacheRoot: string
let applicationRuntimeRoot: string
let installedAppDataRoot: string | null = null
let electronPaths: ElectronBootstrapPaths
try {
  if (portablePaths != null) {
    applicationCacheRoot = portablePaths.appDataPath
    applicationRuntimeRoot = path.join(portablePaths.appDataPath, 'runtime')
  } else {
    installedAppDataRoot = electronApp.getPath('appData')
    applicationCacheRoot = resolveApplicationCacheRoot({
      platform: runtime.platform,
      env: runtime.env,
      homePath: electronApp.getPath('home'),
    })
    applicationRuntimeRoot = resolveApplicationRuntimeRoot({
      platform: runtime.platform,
      env: runtime.env,
      homePath: electronApp.getPath('home'),
      appDataPath: installedAppDataRoot,
    })
  }
  electronPaths = prepareElectronBootstrapPaths({
    applicationRuntimeRoot,
    portableRoot: portablePaths?.appDataPath ?? null,
  })
  electronApp.setPath('userData', electronPaths.electronUserDataRoot)
  electronApp.setPath('sessionData', electronPaths.sessionDataRoot)
} catch (error) {
  console.error('Electron storage root validation failed; startup has been aborted.', error)
  electronApp.exit(1)
  return
}
```

Ensure invalid asserted portable input still returns before reading `home` or
`appData`.

Use cached `installedAppDataRoot` for installed migration, with an explicit
`installedAppDataRoot == null` fail-closed check in the installed branch so
TypeScript does not rely on correlation with `portablePaths`. Pass the same
`applicationRuntimeRoot` into full storage initialization. After
`initializeStoragePaths`, fail closed unless both initialized stable paths
exactly equal the early paths. Remove the late `setPath` calls entirely:

```ts
if (initialized.paths.electronUserDataRoot != electronPaths.electronUserDataRoot ||
  initialized.paths.sessionDataRoot != electronPaths.sessionDataRoot) {
  console.error('Electron storage root changed during startup; startup has been aborted.')
  electronApp.exit(1)
  return
}
```

Do not change the migration result handling, global profile publication,
application import, or shutdown behavior.

- [ ] **Step 4: Run focused and adjacent GREEN verification**

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test scripts/test-legacy-user-data-migration.js
node --test build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js
node --test build-config/storage/session-registry.test.js build-config/storage/playback-cutover.test.js
npx eslint --ext .ts,.js -f stylish src/main/bootstrap.ts src/main/utils/storagePaths.ts build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js scripts/test-legacy-user-data-migration.js
npm run build:main
npm run test:main-bundle
git diff --check
```

Expected: every command exits 0. The first-await assertions prove exact stable
paths are visible before portable and installed asynchronous work.

- [ ] **Step 5: Commit the bootstrap fix**

```powershell
git add src/main/bootstrap.ts build-config/storage/startup-coordinator.test.js build-config/storage/storage-paths.test.js scripts/test-legacy-user-data-migration.js
git commit -m "fix: bind Electron paths before bootstrap awaits"
```

### Task 4: Rebuild and Prove the Real Portable Release

**Files:**
- Create: `docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md`

**Interfaces:**
- Consumes: reviewed Tasks 1-3, `pack:win:portable:x64`, the packaged startup test, and visible Windows application interaction.
- Produces: a new artifact hash, complete source/package/runtime evidence, a preserved clean first-launch tree, and a verified second instance left running.

- [ ] **Step 1: Recheck evidence and run the complete source matrix**

Before any build command, require:

- the blocked artifact evidence copy still matches
  `6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5`;
- no target application process is running;
- any current `build\portable` is moved, after exact direct-child validation,
  to a new initially absent evidence directory rather than deleted;
- the protected user test remains the only unrelated worktree change; the
  corrected older plan, this plan, and the amended design must already be in
  the committed documentation baseline.

Then run each command independently:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test scripts/test-legacy-user-data-migration.js
npm run test:storage
npm run test:storage:portable
npm run test:user-api
node --test build-config/playback-source-fallback.test.js build-config/playback-media-validation.test.js build-config/playback-source-setting.test.js
npm run test:storage:electron
npm run lint
npm run build
npm run test:main-bundle
git diff --check
```

Expected: every command exits 0. Record exact pass, skip, and fail counts; give
lint and build at least 300 seconds.

- [ ] **Step 2: Package, inspect, and run the default-argument smoke GREEN**

```powershell
npm run pack:win:portable:x64
npm run test:packaged-app
$env:LX_PORTABLE_ARTIFACT=(Resolve-Path 'build\starky-lx-music-desktop-v3.0.0-x64-portable.exe').Path
npm run test:portable-packaged-bootstrap
Get-Item -LiteralPath $env:LX_PORTABLE_ARTIFACT
Get-FileHash -LiteralPath $env:LX_PORTABLE_ARTIFACT -Algorithm SHA256
& 'node_modules\7zip-bin\win\x64\7za.exe' t $env:LX_PORTABLE_ARTIFACT
```

Expected: packaging exits 0, packaged-content checks pass, the default NSIS
smoke reports exactly 1 pass, 0 skip, and 0 fail with no `--user-data-dir`,
7-Zip reports `Everything is Ok`, and
the new artifact hash differs from all three blocked hashes:

```text
937C05AF1EAA5F6FED1D6B9C208A031FF4ABDF3CE023404BA56CD7DDAA9FF4E3
11FD8058213BC3558C593CEED9C872D45BC9F16A44B34CAE544ACA9C0BFC0186
6A0BAEB3A88A7830ADD547B1ADCAC1F0FD63D795E7C92CB5C990A0FC4EC305B5
```

- [ ] **Step 3: Freeze installed sentinels without reading contents**

Record size, UTC modification time, and SHA-256 only for:

```text
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\lx.data.db
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\config_v2.json
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\cache\cache.db
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\runtime\run-state.v1.json
```

Do not print, parse, rename, restore, or edit them.

- [ ] **Step 4: Prove true first launch and storage inventory**

Use Computer Use to launch the real artifact with default arguments and inspect
the visible application. Condition-poll for a live main process and:

```text
build\portable\profile\lx.data.db
build\portable\cache\cache.db
build\portable\runtime\electron-user-data\
build\portable\runtime\session-data\
build\portable\runtime\run-state.v1.json
build\portable\temp\
```

Require no recovery/startup error and confirm these remain absent:

```text
build\portable\backups
build\portable\profile\data.json
build\portable\userData
portable migration journal and receipt files
```

Open `lx.data.db` read-only under the Electron ABI and require
`db_info.version == '7'` and schema migration versions exactly `3,4,5,6,7`.
Recompute sentinel metadata and require all four rows unchanged before
continuing.

- [ ] **Step 5: Prove title-bar clean shutdown and preserve the first launch**

Click the real title-bar Close button with the default tray-disabled setting.
Require all target processes to exit, `run-state.v1.json` to record
`clean:true` with a completion timestamp, and the owned `portable/temp/run-*`
count to be zero.

While closed, copy the exact direct `build\portable` tree without deleting it
to the initially absent path:

```text
.superpowers\evidence\2026-08-05-post-early-path-fix-first-launch-portable
```

Record the snapshot path and inventory. Do not create a placeholder if the
source identity is unexpected.

- [ ] **Step 6: Prove second launch reuse and leave it running**

Relaunch the same artifact with default arguments. Require the same schema-7
database, cache, electron-user-data, and session-data paths; require backups,
legacy `data.json`, migration journal, and receipt to remain absent. Inspect the
window for errors, recompute the four installed sentinels, and require them
unchanged. Leave the verified second instance running and record its main PID.

- [ ] **Step 7: Write and commit complete release evidence**

Create `docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md`
with exact commands, exits/counts/skips, artifact size/timestamps/hash, 7-Zip
result, smoke result, storage inventory, schema rows, sentinel comparisons,
visible UI evidence, clean shutdown, preserved snapshot, second-launch reuse,
final PID, the earlier evidence-loss incident, and real-media coverage gaps.

```powershell
git add -f docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md
git commit -m "docs: verify early portable bootstrap"
```
