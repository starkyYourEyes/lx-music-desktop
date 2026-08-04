# Portable Production Runtime Environment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve electron-builder's portable launcher environment in the production main-process bundle, then rebuild and prove the x64 portable artifact across true first and second launches.

**Architecture:** Keep the existing guarded portable resolver and bootstrap ordering unchanged. Correct the production main webpack boundary so only `process.env.NODE_ENV` is compiled to a literal while Node's live `process.env` reaches bootstrap, and add a compiled-bundle regression assertion before repeating release verification.

**Tech Stack:** Electron 37.6.1, electron-builder 26.15.3 NSIS portable target, webpack 5.105.2, Node.js 22, `node:test`, PowerShell, and Computer Use.

## Global Constraints

- The production main bundle must retain Node's live `process.env` object for bootstrap while compiling `process.env.NODE_ENV` as `production`.
- Do not add a bootstrap-only environment bypass, change the NSIS template, or modify renderer/lyric-renderer webpack environment substitution.
- The single-file portable artifact must create and use `<launcher>/portable` when that child is initially absent.
- A rebuilt artifact must not read, migrate, or mutate installed AppData, cache, runtime, or configuration sentinels.
- Treat the currently changed installed `run-state.v1.json` as the new read-only baseline; do not restore, delete, rename, or edit it or the installed temp evidence.
- Do not modify, restore, delete, stage, or commit `build-config/storage-electron/database-recovery.test.js`.
- Use RED/GREEN TDD and stage only files listed by the current task.
- Do not claim NTFS/FAT32/exFAT real-media coverage unless those roots are actually configured and exercised.

---

### Task 1: Preserve Runtime Environment in the Production Main Bundle

**Files:**
- Modify: `build-config/main/webpack-worker-output.test.js`
- Modify: `build-config/main/webpack.config.prod.js`

**Interfaces:**
- Preserves: bootstrap's default `runtime = { platform: process.platform, env: process.env }`.
- Produces: a production bundle that retains the live runtime environment and still folds `process.env.NODE_ENV` to `production`.

- [ ] **Step 1: Write the failing compiled-bundle assertion**

Rename the existing bundle test to describe both production contracts and add these assertions after `applicationBundle` is assembled:

```js
assert.match(
  applicationBundle,
  /runtime = \{ platform: process\.platform, env: process\.env \}/,
)
assert.doesNotMatch(
  applicationBundle,
  /env: \(\{\"NODE_ENV\":\"production\"\}\)/,
)
```

The assertions inspect the real webpack output, not the source configuration object.

- [ ] **Step 2: Run the bundle test and verify RED**

Run:

```powershell
npm run test:main-bundle
```

Expected: exit 1 because the current compiled bootstrap contains
`env: ({"NODE_ENV":"production"})` instead of the live `process.env` object.

- [ ] **Step 3: Narrow the production DefinePlugin key**

In `build-config/main/webpack.config.prod.js`, replace the complete-object definition:

```js
new webpack.DefinePlugin({
  'process.env': {
    NODE_ENV: '"production"',
  },
})
```

with the exact property definition:

```js
new webpack.DefinePlugin({
  'process.env.NODE_ENV': JSON.stringify('production'),
})
```

Do not change bootstrap or another webpack target.

- [ ] **Step 4: Run focused GREEN verification**

Run:

```powershell
npm run test:main-bundle
npx eslint --ext .js -f stylish build-config/main/webpack.config.prod.js build-config/main/webpack-worker-output.test.js
npm run build:main
rg -n "runtime = \{ platform: process\.platform, env: process\.env \}" dist/main.js
git diff --check
```

Expected: the bundle test passes 1/1, ESLint/build/diff checks exit 0, and `rg` finds the live runtime environment in `dist/main.js`.

- [ ] **Step 5: Commit the bundle boundary fix**

```powershell
git add build-config/main/webpack.config.prod.js build-config/main/webpack-worker-output.test.js
git commit -m "fix: preserve portable environment in main bundle"
```

### Task 2: Rebuild and Prove Real Portable First and Second Launches

**Files:**
- Create: `docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md`

**Interfaces:**
- Consumes: the reviewed Task 1 production bundle and `pack:win:portable:x64`.
- Produces: a new artifact SHA-256, complete source/package evidence, first/second-launch evidence, and a running verified portable application.

- [ ] **Step 1: Run the complete source matrix from the fixed commit**

Use the disposable storage root and run every command independently:

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

Expected: every command exits 0. Record platform-conditional skips as skips. Give full lint and build commands at least 300 seconds before treating them as timed out.

- [ ] **Step 2: Build, inspect, and fingerprint a new x64 portable artifact**

Require `build\portable` and target-app processes to be absent, then run:

```powershell
npm run pack:win:portable:x64
npm run test:packaged-app
Get-Item build\starky-lx-music-desktop-v3.0.0-x64-portable.exe
Get-FileHash build\starky-lx-music-desktop-v3.0.0-x64-portable.exe -Algorithm SHA256
```

Expected: packaging exits 0, packaged checks pass 2/2, and the artifact has a new modification time and SHA-256 distinct from the blocked artifact
`937C05AF1EAA5F6FED1D6B9C208A031FF4ABDF3CE023404BA56CD7DDAA9FF4E3`.

- [ ] **Step 3: Freeze the new installed-data baseline**

Record only size, UTC modification time, and SHA-256 for these sentinels:

```text
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\lx.data.db
C:\Users\hao238\AppData\Roaming\starky-lx-music-desktop\LxDatas\config_v2.json
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\cache\cache.db
C:\Users\hao238\AppData\Local\starky-lx-music-desktop\runtime\run-state.v1.json
```

Do not print, parse, move, delete, or restore sentinel contents. The current run-state hash after the blocked launch is the baseline to preserve.

- [ ] **Step 4: Launch and verify the true first startup**

Use Computer Use for visible application interaction. Launch the new artifact and condition-poll until the main process and these paths exist:

```text
build\portable\profile\lx.data.db
build\portable\cache\cache.db
build\portable\runtime\run-state.v1.json
build\portable\runtime\session-data\
build\portable\temp\
```

Inspect the actual main window and require no recovery/startup error. Query the portable database read-only under the Electron ABI and require `db_info.version == '7'` with migration versions `3,4,5,6,7`. Require:

```text
build\portable\backups                    absent
build\portable\profile\data.json          absent
build\portable\userData                   absent
portable migration journal/receipt        absent
all four installed sentinel metadata rows unchanged
```

If any installed sentinel changes, stop without attempting a second launch.

- [ ] **Step 5: Prove clean shutdown and second startup**

Quit through the real application UI or tray exit path. Require portable run-state to record a clean shutdown and the owned run-temp reservation to be reclaimed. Relaunch the same artifact, require the same schema-7 database and cache paths, confirm `backups` remains absent, and inspect the window again for startup errors. Leave this verified second instance running and record its main PID.

- [ ] **Step 6: Write and commit complete verification evidence**

Create `docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md` with exact commands, exits/counts/skips, artifact metadata/hash, bundle assertion, storage inventory, schema/migration rows, installed-sentinel comparison, UI evidence, clean shutdown, second launch, final PID, and environmental gaps. Do not reuse the blocked artifact as passing evidence.

```powershell
git add -f docs/superpowers/reviews/2026-08-05-portable-first-launch-bootstrap.md
git commit -m "docs: verify portable production bootstrap"
```
