# Portable First-Launch Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the electron-builder Windows portable executable create and use launcher-local layered storage on a true first launch, then prove the rebuilt x64 artifact across first and second startup.

**Architecture:** Preserve the existing pure adjacent-directory compatibility detector and add a guarded, side-effecting launcher resolver that consumes `PORTABLE_EXECUTABLE_DIR`. Bootstrap invokes it before any installed-data lookup, then reuses the existing portable profile migration and storage coordinator unchanged.

**Tech Stack:** Electron 37.6.1, electron-builder 26.15.3 NSIS portable target, Node.js 22, TypeScript 5.9, PowerShell, `node:test`, and existing direct-directory guards.

## Global Constraints

- The single-file portable artifact must work when `<launcher>/portable` is absent.
- Only a direct non-link `<launcher>/portable` child may be created; recursive creation and link/reparse traversal are forbidden.
- A present but invalid `PORTABLE_EXECUTABLE_DIR` is fatal and must never fall back to installed AppData.
- Without the launcher variable, preserve the existing adjacent-`portable` compatibility behavior exactly.
- Portable root preparation completes before source retirement, portable profile preparation, storage path publication, database open, sessions, or windows.
- A fresh database reaches schema 7 without creating or mutating `backupsRoot`.
- Do not modify, restore, delete, stage, or commit `build-config/storage-electron/database-recovery.test.js`.
- Do not restore or delete the installed profile changed by the diagnostic launch.
- Use RED/GREEN TDD and stage only files listed by the current task.

---

### Task 1: Add Guarded Portable Launcher Resolution

**Files:**
- Modify: `src/main/migration/legacyUserData.js`
- Modify: `src/main/migration/legacyUserData.d.ts`
- Test: `scripts/test-legacy-user-data-migration.js`

**Interfaces:**
- Preserves: `getPortableUserDataPaths({ platform, executablePath, pathExists? })` as a pure compatibility detector.
- Produces: `preparePortableUserDataPaths({ platform, executablePath, portableExecutableDir?, fsApi? })`.
- Returns: `{ appDataPath: string, userDataPath: string } | null`.
- Throws: invalid launcher assertion or unsafe directory state; it never converts such failures to installed mode.

- [ ] **Step 1: Write failing resolver tests**

Import `preparePortableUserDataPaths` beside the existing exports and add tests with these observable contracts:

```js
test('creates a direct portable root from the wrapper directory on first launch', t => {
  const launcherRoot = makeRoot()
  t.after(() => cleanupRoot(launcherRoot))
  const extractedExecutable = path.join(launcherRoot, 'nsis-temp', 'app.exe')

  const result = preparePortableUserDataPaths({
    platform: 'win32',
    executablePath: extractedExecutable,
    portableExecutableDir: launcherRoot,
  })

  assert.deepEqual(result, {
    appDataPath: path.join(launcherRoot, 'portable'),
    userDataPath: path.join(launcherRoot, 'portable', 'userData'),
  })
  const stat = fs.lstatSync(result.appDataPath)
  assert.equal(stat.isDirectory(), true)
  assert.equal(stat.isSymbolicLink(), false)
})
```

Add a table-driven test for `''`, `'relative'`, and `'C:drive-relative'` that asserts each value throws and creates no `portable` child. Add a directory-link test proving a linked launcher root or linked pre-existing `portable` child is rejected; use the existing `createDirectoryLink` helper and skip only when the host cannot create directory links.

Keep the existing `portable mode resolves package-local paths without invoking migration` test unchanged so removing the compatibility fallback remains observable.

- [ ] **Step 2: Run the resolver tests and verify RED**

Run:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test --test-name-pattern "portable" scripts/test-legacy-user-data-migration.js
```

Expected: FAIL because `preparePortableUserDataPaths` is not exported.

- [ ] **Step 3: Implement the guarded resolver**

In `legacyUserData.js`, import `revalidateDirectDirectory` and implement:

```js
const preparePortableUserDataPaths = ({
  platform,
  executablePath,
  portableExecutableDir,
  fsApi = fs,
}) => {
  if (platform != 'win32') return null
  if (portableExecutableDir == null) {
    const paths = getPortableUserDataPaths({
      platform,
      executablePath,
      pathExists: fsApi.existsSync,
    })
    if (paths == null) return null
    const root = validateDirectDirectory(paths.appDataPath, { fsApi, pathApi: path.win32 })
    try {
      revalidateDirectDirectory(root)
      return paths
    } finally {
      closeDirectDirectory(root)
    }
  }
  if (typeof portableExecutableDir != 'string' || portableExecutableDir.length == 0 ||
    !path.win32.isAbsolute(portableExecutableDir)) {
    throw new Error('portable_executable_directory_invalid')
  }

  const launcherPath = path.win32.resolve(portableExecutableDir)
  const launcher = validateDirectDirectory(launcherPath, { fsApi, pathApi: path.win32 })
  let portable
  try {
    portable = createDirectChildDirectory(launcher, 'portable', { mode: 0o700 })
    revalidateDirectDirectory(launcher)
    revalidateDirectDirectory(portable)
    return Object.freeze({
      appDataPath: portable.path,
      userDataPath: path.win32.join(portable.path, 'userData'),
    })
  } finally {
    try {
      if (portable != null) closeDirectDirectory(portable)
    } finally {
      closeDirectDirectory(launcher)
    }
  }
}
```

Export the function and add the exact option/result declaration to `legacyUserData.d.ts`. Do not create directories through `mkdirSync(..., { recursive: true })`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test --test-name-pattern "portable" scripts/test-legacy-user-data-migration.js
npx eslint --ext .ts,.js -f stylish src/main/migration/legacyUserData.js src/main/migration/legacyUserData.d.ts scripts/test-legacy-user-data-migration.js
```

Expected: all selected tests and lint exit 0.

- [ ] **Step 5: Commit the resolver boundary**

```powershell
git add src/main/migration/legacyUserData.js src/main/migration/legacyUserData.d.ts scripts/test-legacy-user-data-migration.js
git commit -m "fix: resolve portable launcher storage securely"
```

### Task 2: Gate Bootstrap on Portable Root Preparation

**Files:**
- Modify: `src/main/bootstrap.ts`
- Modify: `build-config/storage/storage-paths.test.js`
- Modify: `build-config/storage/startup-coordinator.test.js`

**Interfaces:**
- Consumes: `preparePortableUserDataPaths` from Task 1.
- Preserves: existing portable retirement, portable profile preparation, and storage initialization APIs.
- Guarantees: invalid launcher input exits before installed migration or Electron path publication.

- [ ] **Step 1: Write the failing bootstrap first-launch test**

Add a test under `early Electron bootstrap` in `storage-paths.test.js` that uses different launcher and extracted executable directories, starts with no `portable` child, and supplies `PORTABLE_EXECUTABLE_DIR`:

```js
it('creates launcher-local storage on a true portable first launch without consulting AppData', async() => {
  const root = createFixture('portable-wrapper-first-launch')
  const launcherRoot = path.join(root, 'launcher')
  const extractedRoot = path.join(root, 'nsis-temp')
  fs.mkdirSync(launcherRoot)
  fs.mkdirSync(extractedRoot)
  const calls = []
  const fakeElectron = {
    getPath(name) {
      calls.push(`getPath:${name}`)
      if (name == 'exe') return path.join(extractedRoot, 'app.exe')
      if (name == 'temp') return path.join(root, 'os-temp')
      throw new Error(`installed path consulted: ${name}`)
    },
    setPath(name, value) { calls.push(`setPath:${name}:${value}`) },
    exit(code) { calls.push(`exit:${code}`) },
  }
  const { bootstrap } = require(bootstrapModule)

  await bootstrap(fakeElectron, async() => { calls.push('application') }, {
    platform: 'win32',
    env: { PORTABLE_EXECUTABLE_DIR: launcherRoot },
  })

  const portableRoot = path.join(launcherRoot, 'portable')
  assert.equal(global.storagePaths.portableRoot, portableRoot)
  assert.equal(global.storagePaths.profileRoot, path.join(portableRoot, 'profile'))
  assert.equal(fs.statSync(global.storagePaths.sessionDataRoot).isDirectory(), true)
  assert.equal(fs.existsSync(global.storagePaths.cacheRoot), false)
  assert.equal(fs.existsSync(global.storagePaths.backupsRoot), false)
  assert.equal(calls.some(call => call == 'getPath:appData' || call == 'getPath:home'), false)
  assert.equal(calls.at(-1), 'application')
})
```

Add one test that loops over invalid launcher values and asserts exact ordering: only `getPath:exe`, `exit:1`; no `setPath`, installed path lookup, or application import.

- [ ] **Step 2: Run the bootstrap tests and verify RED**

Run:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test --test-name-pattern "portable|launcher" build-config/storage/storage-paths.test.js
```

Expected: FAIL because bootstrap still ignores `PORTABLE_EXECUTABLE_DIR` and enters the installed branch.

- [ ] **Step 3: Wire the guarded resolver before installed lookup**

Replace the bootstrap import of `getPortableUserDataPaths` with
`preparePortableUserDataPaths`. Resolve inside a fail-closed boundary:

```ts
let portablePaths
try {
  portablePaths = preparePortableUserDataPaths({
    platform: runtime.platform,
    executablePath,
    portableExecutableDir: runtime.env.PORTABLE_EXECUTABLE_DIR,
  })
} catch (error) {
  console.error('Portable root validation failed; startup has been aborted.', error)
  electronApp.exit(1)
  return
}
```

This block must precede portable retirement and every `appData`/`home` lookup. Update bootstrap module stubs to expose `preparePortableUserDataPaths` with the same complete result shape used in production.

- [ ] **Step 4: Run focused tests and builds and verify GREEN**

Run:

```powershell
$env:LX_TEST_STORAGE_ROOT=(Resolve-Path '.superpowers\t').Path
node --test scripts/test-legacy-user-data-migration.js build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js
npx eslint --ext .ts,.js -f stylish src/main/bootstrap.ts build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js
npm run build:main
```

Expected: every command exits 0 and no selected test mutates a real profile.

- [ ] **Step 5: Commit the bootstrap gate**

```powershell
git add src/main/bootstrap.ts build-config/storage/storage-paths.test.js build-config/storage/startup-coordinator.test.js
git commit -m "fix: initialize portable storage on first launch"
```

### Task 3: Full Matrix, Package, and Real First/Second Launch

**Files:**
- Create: `docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md`

**Interfaces:**
- Consumes: completed Tasks 1-2 and `pack:win:portable:x64`.
- Produces: a rebuilt artifact, SHA-256, runtime storage inventory, installed-sentinel comparison, first/second-launch evidence, and a running verified application.

- [ ] **Step 1: Run the complete source verification matrix**

Run from a clean command environment with the disposable storage root:

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

Expected: every command exits 0. Platform-conditional skips are reported as skips, not passes.

- [ ] **Step 2: Build and fingerprint the x64 portable artifact**

```powershell
npm run pack:win:portable:x64
npm run test:packaged-app
Get-Item build\starky-lx-music-desktop-v3.0.0-x64-portable.exe
Get-FileHash build\starky-lx-music-desktop-v3.0.0-x64-portable.exe -Algorithm SHA256
```

Expected: pack exits 0 and the artifact has a new modification time and stable readable SHA-256.

- [ ] **Step 3: Capture pre-launch boundaries**

Assert `build\portable` is absent. Record hashes, sizes, and modification times for installed sentinels without reading their contents into output:

```text
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\lx.data.db
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\config_v2.json
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\cache\cache.db
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\runtime\run-state.v1.json
```

Do not delete or rename any installed file.

- [ ] **Step 4: Launch and verify the real first startup**

Start the built portable executable visibly. Poll on conditions rather than a fixed long sleep until the main process exists and these paths appear:

```text
build\portable\profile\lx.data.db
build\portable\cache\cache.db
build\portable\runtime\run-state.v1.json
build\portable\runtime\session-data\
build\portable\temp\
```

Use the Computer Use skill to inspect the actual main window and confirm no recovery/startup error dialog. Query `lx.data.db` read-only under the Electron ABI and require `db_info.version == '7'` with migration versions `3,4,5,6,7`. Require all of the following:

```text
build\portable\backups                  absent
build\portable\profile\data.json       absent
build\portable\userData                 absent
portable migration journal/receipt       absent
installed sentinel metadata              unchanged
```

- [ ] **Step 5: Prove clean shutdown and second launch**

Quit through the application's real UI/tray exit path so the storage coordinator completes. Require the portable run-state to report a clean shutdown and the run-temp reservation to be reclaimed. Relaunch the same artifact, confirm the same schema-7 database and cache paths reopen, confirm `backups` remains absent, and inspect the window again for startup errors. Leave this second verified instance running.

- [ ] **Step 6: Record and commit verification evidence**

Write the exact commands, exit codes, test counts/skips, artifact path/size/time/hash, storage inventory, schema result, installed-sentinel comparison, clean-shutdown result, second-launch result, process IDs, and any environmental evidence gaps to the review document. Do not claim unavailable NTFS/FAT32/exFAT roots as passes.

```powershell
git add -f docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md
git commit -m "docs: record portable first-launch verification"
```
