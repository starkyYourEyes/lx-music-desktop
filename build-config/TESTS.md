# Test inventory and commands

Task E inventory: 2026-10-05, Windows, Node 22.19.0, Electron 37.6.1.

## Default commands

- `npm run typecheck`: four TypeScript projects, no emit or incremental cache.
- `npm run test:unit`: discovers all nested build-config Node tests and invokes `node --test --test-concurrency=1`. Explicit build/Electron exclusions live in `scripts/run-unit-tests.js`; failures are never exclusions.
- `npm run test:scripts`: runs **all** 53 `scripts/test-*.js` in sorted order, each in its own Node process. Continues after failures, prints filenames and returns nonzero if any child fails or cannot start.
- `npm test`: typecheck, unit tests, then scripts. A failed stage stops subsequent stages; run test:scripts separately to inspect its failures.

The runners allocate an isolated LX_TEST_STORAGE_ROOT. Successful runs remove their owned base; failed runs retain it and print its path. Test processes must not use real account/profile data.

**Repair authorization (2026-10-05):** The user explicitly approved repairing the default-suite failures and five source lint errors. Historical inventory results below describe the pre-repair baseline; they are retained as evidence. Final repair validation is recorded below.

## Inventory method and prerequisites

All 209 pre-existing files were attempted individually: 156 build-config tests and 53 scripts. Of these, 121 build-config tests and all 53 scripts run under Node; 29 require Electron; 6 invoke a build or need packaged artifacts. Two new runner/discovery tests bring the total to 211 and default unit files to 123. All 53 scripts remain selected, including 10 using node:test and 43 direct-assertion scripts.

Before execution, child launches, imported test loaders, file writes/removals, and profile selection were inspected. Account/API tests use mocked services and synthetic credentials; project-identity binds loopback only. Storage tests receive fresh direct fixture bases. Electron render helpers set temporary userData paths; safeStorage receives a temporary profile and isolated child APPDATA/LOCALAPPDATA. Child-only HOME/USERPROFILE/TEMP/TMP isolation was used during the inventory; the parent environment and real app were not changed.

Build tests ran from a HEAD archive under .tmp/task-e/work with shared dependencies, protecting the live dist/build. Packaged tests were first attempted without app.asar (prerequisite failure/skips), then rerun using the exact Task D pack:dir app.asar. No installed application or real account was launched. The two portable launcher scenarios were safely left skipped because LX_PORTABLE_ARTIFACT was not supplied. They require a deliberately selected standalone portable artifact and Windows. Existing integration commands are preserved: test:storage:electron, test:packaged-app, test:portable-packaged-bootstrap, test:main-bundle, test:preload, test:audio-quality and test:storage. The test:preload and test:audio-quality commands now allocate their own disposable fixture environment. Direct Node invocations and the other mixed suites need an explicit LX_TEST_STORAGE_ROOT directory; Electron storage also needs Electron-built native dependencies.

For build/Electron tests without a named script, invoke node scripts/run-test-environment.js --test with the file listed below (storage-electron uses ELECTRON_RUN_AS_NODE=1 with the Electron executable). Electron GUI tests require a desktop/display. Kugou main-bundle compiles into dist: run it in an isolated checkout. Never run pack.js against a live output directory; it deletes dist/build.

Inventory logs and machine-readable results are retained locally in .tmp/task-e/. No inventory process hit its 180-second cap. Passing file status does not imply every subtest ran; skips are explicit below. The archive package absence is a prerequisite issue, not a product regression. The safeStorage child failure is recorded without claiming a diagnosed cause.

## Per-file results at original inventory (before authorized repairs)

Node = selected by the default commands; Electron and Build/package remain separate. Result reflects final targeted reruns where noted.

| File | Runtime | Result / notes |
| --- | --- | --- |
| build-config/background-transparency.test.js | Node | FAIL: Missing ./performance/featurePolicy fixture resolution |
| build-config/import-source-list.test.js | Node | PASS |
| build-config/kugou-account-service.test.js | Node | PASS |
| build-config/kugou-account-store.test.js | Node | PASS |
| build-config/kugou-api-adapter.test.js | Node | PASS |
| build-config/kugou-ipc-contract.test.js | Node | PASS |
| build-config/kugou-main-bundle.test.js | Build/package | PASS |
| build-config/kugou-package-files.test.js | Node | PASS |
| build-config/kugou-packaged-app.test.js | Build/package | FAIL: Missing importSourceList mock; Windows ASAR path separator; extracted-package containment (rerun with Task D app.asar); initial run skipped 2 package cases; rerun exercised both |
| build-config/kugou-recommend-view.test.js | Node | FAIL: Stale router/sidebar separator assertion |
| build-config/kugou-user-playlists.test.js | Node | PASS |
| build-config/listening-time.test.js | Node | PASS |
| build-config/main/webpack-worker-output.test.js | Build/package | PASS |
| build-config/my-list-group-flows.test.js | Node | PASS after adapting new Task A helper injection; both files 38/38 (pre-A snapshot also 38/38) |
| build-config/my-list-groups.test.js | Node | PASS |
| build-config/my-list-sidebar-groups.test.js | Node | PASS after adapting new Task A helper injection; both files 38/38 (pre-A snapshot also 38/38) |
| build-config/netease-playlist-detail-errors.test.js | Node | PASS |
| build-config/netease-user-playlists.test.js | Node | PASS |
| build-config/packaged-app.test.js | Build/package | PASS after supplying Task D app.asar (2/2) |
| build-config/performance/audio-lifecycle.test.js | Node | PASS |
| build-config/performance/bounded-cache.test.js | Node | PASS |
| build-config/performance/cache-integrations.test.js | Node | PASS |
| build-config/performance/convolution-buffer-cache.test.js | Node | PASS |
| build-config/performance/desktop-lyric-lifecycle.test.js | Node | PASS |
| build-config/performance/download-actions.test.js | Node | PASS |
| build-config/performance/download-runtime.test.js | Node | PASS |
| build-config/performance/download-worker.test.js | Node | PASS |
| build-config/performance/download-writes.test.js | Node | PASS |
| build-config/performance/draft.test.js | Node | PASS |
| build-config/performance/feature-policy.test.js | Node | PASS |
| build-config/performance/lyric-analyser.test.js | Node | PASS |
| build-config/performance/main-optional-resources.test.js | Node | PASS |
| build-config/performance/netease-lazy-api.test.js | Node | PASS |
| build-config/performance/performance-ipc.test.js | Node | PASS |
| build-config/performance/recommendation-access.test.js | Node | PASS |
| build-config/performance/recommendation-route.test.js | Node | PASS |
| build-config/performance/restart.test.js | Node | PASS |
| build-config/performance/settings-application.test.js | Node | PASS |
| build-config/performance/settings-event.test.js | Node | PASS |
| build-config/performance/visualizer-lifecycle.test.js | Node | PASS |
| build-config/performance/webpack-chunk-isolation.test.js | Build/package | PASS |
| build-config/platform-user-playlist-auto-update.test.js | Node | PASS |
| build-config/platform-user-playlist-read-only.test.js | Node | PASS |
| build-config/platform-user-playlist-reconcile.test.js | Node | PASS |
| build-config/platform-user-playlist-refresh.test.js | Node | PASS |
| build-config/platform-user-playlist-settings-page.test.js | Node | PASS |
| build-config/platform-user-playlist-settings.test.js | Node | PASS |
| build-config/platform-user-playlist-sidebar.test.js | Node | PASS |
| build-config/play-bar-height.test.js | Node | FAIL: Missing ./performance/featurePolicy fixture resolution |
| build-config/play-bar-quality-label.test.js | Node | PASS |
| build-config/playback-media-validation.test.js | Node | PASS |
| build-config/playback-source-fallback.test.js | Node | PASS |
| build-config/playback-source-setting.test.js | Node | FAIL: Missing ./performance/featurePolicy fixture resolution |
| build-config/player-audio-quality.test.js | Electron | PASS |
| build-config/player-preload-electron.test.js | Electron | PASS |
| build-config/player-preload.test.js | Node | PASS |
| build-config/player-sound-effect-settings.test.js | Node | PASS |
| build-config/playlist-detail-unified-scroll.test.js | Node | PASS |
| build-config/portable-packaged-bootstrap.test.js | Build/package | PASS; 2 skipped subtest(s) |
| build-config/portable-packaging-config.test.js | Node | PASS |
| build-config/qq-user-playlists.test.js | Node | PASS |
| build-config/settings-page-layout.test.js | Node | FAIL: Missing performance fixture dependencies |
| build-config/sidebar-context-menu.test.js | Node | PASS |
| build-config/sidebar-font-size.test.js | Node | FAIL: Missing performance fixture dependencies |
| build-config/sidebar-group-compositing.test.js | Electron | PASS |
| build-config/sidebar-navigation.test.js | Node | FAIL: Missing performance fixture dependencies |
| build-config/song-row-artwork.test.js | Node | PASS |
| build-config/song-row-components.test.js | Node | FAIL: Five existing My Lists cases: window is not defined |
| build-config/sound-effect-mode.test.js | Node | PASS |
| build-config/storage-electron/account-profile.test.js | Electron | PASS |
| build-config/storage-electron/cache-cutover.test.js | Electron | PASS |
| build-config/storage-electron/cache-db.test.js | Electron | PASS |
| build-config/storage-electron/cache-lifecycle.test.js | Electron | PASS |
| build-config/storage-electron/cache-phase4.integration.test.js | Electron | PASS |
| build-config/storage-electron/cache-policy.test.js | Electron | PASS |
| build-config/storage-electron/database-recovery.test.js | Electron | PASS |
| build-config/storage-electron/kugou-account-profile.test.js | Electron | PASS |
| build-config/storage-electron/listening-play-count-migration.test.js | Electron | PASS |
| build-config/storage-electron/migration-runner.test.js | Electron | PASS |
| build-config/storage-electron/non-activity-repository.test.js | Electron | PASS |
| build-config/storage-electron/non-activity-retry.test.js | Electron | PASS |
| build-config/storage-electron/playback-clear.test.js | Electron | PASS |
| build-config/storage-electron/playback-migration.test.js | Electron | PASS |
| build-config/storage-electron/playback-phase3.integration.test.js | Electron | PASS |
| build-config/storage-electron/playback-renderer-crash.integration.test.js | Electron | PASS |
| build-config/storage-electron/playback-retention.test.js | Electron | PASS |
| build-config/storage-electron/playback-schema.test.js | Electron | PASS |
| build-config/storage-electron/playback-storage.test.js | Electron | PASS |
| build-config/storage-electron/raw-lyric-migration.test.js | Electron | PASS |
| build-config/storage-electron/safe-storage-vault.test.js | Electron | FAIL: Electron GUI child exits 2147483651 without diagnostic; environment/runtime failure, cause unverified |
| build-config/storage-electron/scoped-cache-repository.test.js | Electron | PASS |
| build-config/storage-electron/storage-foundation.integration.test.js | Electron | PASS |
| build-config/storage-platform-playlist.test.js | Node | FAIL: Missing expected invalid-metadata exception |
| build-config/storage/account-credential-cutover.test.js | Node | PASS |
| build-config/storage/account-repository.test.js | Node | PASS |
| build-config/storage/atomic-json-file.test.js | Node | PASS |
| build-config/storage/cache-callsite.test.js | Node | PASS |
| build-config/storage/cache-manager.test.js | Node | PASS |
| build-config/storage/cache-ownership.test.js | Node | FAIL: Five existing temporary-root ownership violations (four build/Electron fixtures plus netease/api.ts) |
| build-config/storage/cache-phase-prerequisite.test.js | Electron | PASS |
| build-config/storage/canonical-json.test.js | Node | PASS |
| build-config/storage/credential-cipher.test.js | Node | PASS |
| build-config/storage/credential-migration.test.js | Node | PASS |
| build-config/storage/credential-profile-scan.test.js | Node | PASS |
| build-config/storage/credential-vault.test.js | Node | PASS |
| build-config/storage/exclusive-artifact.test.js | Node | PASS |
| build-config/storage/exclusive-isolation.test.js | Node | PASS |
| build-config/storage/guarded-directory-migration.test.js | Node | PASS |
| build-config/storage/kugou-account-repository.test.js | Node | PASS |
| build-config/storage/legacy-listening-conversion.test.js | Node | PASS |
| build-config/storage/local-artwork-worker.test.js | Node | PASS; 3 skipped subtest(s) |
| build-config/storage/migration-lease.test.js | Node | PASS |
| build-config/storage/music-url-authorization.test.js | Node | PASS |
| build-config/storage/non-activity-callsite.test.js | Node | PASS |
| build-config/storage/non-activity-contracts.test.js | Node | PASS |
| build-config/storage/non-activity-ipc.test.js | Node | PASS |
| build-config/storage/non-activity-source.test.js | Node | PASS |
| build-config/storage/non-activity-startup.test.js | Node | FAIL: Missing @main/modules/sync/listProfileEvent fixture dependency |
| build-config/storage/playback-comparison.test.js | Node | PASS |
| build-config/storage/playback-contracts.test.js | Node | PASS |
| build-config/storage/playback-cutover.test.js | Node | PASS |
| build-config/storage/playback-intent-callsite.test.js | Node | PASS |
| build-config/storage/playback-ipc.test.js | Node | PASS |
| build-config/storage/playback-recorder.test.js | Node | PASS |
| build-config/storage/portable-cutover-auto-update.test.js | Node | PASS |
| build-config/storage/portable-filesystem.test.js | Electron | PASS |
| build-config/storage/portable-profile-migration.test.js | Node | PASS |
| build-config/storage/portable-sync-filesystem.test.js | Node | PASS |
| build-config/storage/session-registry.test.js | Node | PASS |
| build-config/storage/settings-document.test.js | Node | PASS |
| build-config/storage/single-instance-startup.test.js | Node | PASS |
| build-config/storage/startup-coordinator.test.js | Electron | PASS; 1 skipped subtest(s) |
| build-config/storage/storage-contracts.test.js | Node | PASS |
| build-config/storage/storage-paths.test.js | Node | PASS |
| build-config/storage/sync-credential-cutover.test.js | Node | PASS |
| build-config/storage/temp-lifecycle.test.js | Node | PASS |
| build-config/storage/theme-asset-manager.test.js | Node | PASS; 2 skipped subtest(s) |
| build-config/storage/theme-modal-transaction.test.js | Node | PASS |
| build-config/storage/theme-store-transaction.test.js | Node | PASS |
| build-config/storage/webdav-credential-cutover.test.js | Node | PASS |
| build-config/sync-client-credential-recovery.test.js | Node | PASS |
| build-config/user-api/github-import-isolation.test.js | Node | PASS |
| build-config/user-api/ipc-envelope.test.js | Node | PASS |
| build-config/user-api/ipc-routing.test.js | Node | PASS |
| build-config/user-api/modal-reconciliation.test.js | Node | PASS |
| build-config/user-api/primary-source-initialization.test.js | Node | PASS |
| build-config/user-api/renderer-ipc-compat.test.js | Node | PASS |
| build-config/user-api/renderer-routing.test.js | Node | PASS |
| build-config/user-api/renderer-source-capture.test.js | Node | PASS |
| build-config/user-api/runtime-compatibility.test.js | Node | PASS |
| build-config/user-api/runtime-error.test.js | Node | PASS |
| build-config/user-api/runtime-pool.test.js | Node | PASS |
| build-config/user-api/runtime-registry.test.js | Node | PASS |
| build-config/user-api/state-reconciliation.test.js | Node | PASS |
| build-config/user-api/state-serialization.test.js | Node | PASS |
| build-config/virtualized-list-scroll-header.test.js | Node | PASS |
| scripts/test-backup-formats.js | Node | PASS |
| scripts/test-desktop-lyric-bottom-anchor.js | Node | PASS |
| scripts/test-electron-security-boundaries.js | Node | FAIL: Missing ./runtimeWindow fixture dependency |
| scripts/test-github-user-api.js | Node | PASS |
| scripts/test-legacy-user-data-migration.js | Node | PASS |
| scripts/test-list-profile-client.js | Node | PASS |
| scripts/test-list-profile-sync.js | Node | PASS |
| scripts/test-local-music-settings-wiring.js | Node | FAIL: Stale SettingLocalMusic import assertion |
| scripts/test-local-music-settings.js | Node | PASS |
| scripts/test-local-music-webdav.js | Node | PASS |
| scripts/test-lyric-raw-preservation.js | Node | FAIL: Missing @renderer/store/netease fixture dependency |
| scripts/test-music-url-result.js | Node | FAIL: getMusicUrlCacheKey mock missing |
| scripts/test-play-detail-refinement.js | Node | PASS |
| scripts/test-project-identity.js | Node | FAIL: Runtime identity source assertions and parseEnvParams fixture failure |
| scripts/test-provider-recommend-pages.js | Node | FAIL: Stale QQ route source assertion |
| scripts/test-qq-music-account-refresh.js | Node | FAIL: Missing ./userPlaylists fixture dependency |
| scripts/test-qq-music-account.js | Node | FAIL: Missing ./userPlaylists fixture dependency |
| scripts/test-qq-music-auth.js | Node | PASS |
| scripts/test-qq-music-browser-auth-lifecycle.js | Node | FAIL: sessionRegistry missing from fixture |
| scripts/test-qq-music-browser-auth.js | Node | PASS |
| scripts/test-qq-music-browser-login.js | Node | PASS |
| scripts/test-qq-music-brush-mode.js | Node | PASS |
| scripts/test-qq-music-continuous.js | Node | PASS |
| scripts/test-qq-music-credential.js | Node | PASS |
| scripts/test-qq-music-daily-30-renderer.js | Node | PASS |
| scripts/test-qq-music-daily-30.js | Node | PASS |
| scripts/test-qq-music-feedback.js | Node | PASS |
| scripts/test-qq-music-home-recommend.js | Node | PASS |
| scripts/test-qq-music-home-renderer.js | Node | PASS |
| scripts/test-qq-music-ipc.js | Node | PASS |
| scripts/test-qq-music-login.js | Node | PASS |
| scripts/test-qq-music-love-sync.js | Node | FAIL: Missing @common/utils fixture dependency |
| scripts/test-qq-music-playlist-detail.js | Node | PASS |
| scripts/test-qq-music-renderer-account.js | Node | PASS |
| scripts/test-qq-music-song.js | Node | PASS |
| scripts/test-qq-music-ui-wiring.js | Node | FAIL: Missing recommendationAccess fixture dependency |
| scripts/test-recommend-quality-races.js | Node | PASS |
| scripts/test-safe-array-removal.js | Node | PASS |
| scripts/test-session-proxy.js | Node | PASS |
| scripts/test-store-validation.js | Node | FAIL: Missing ../storage/atomicJsonFile fixture dependency |
| scripts/test-sync-client-compatibility.js | Node | PASS |
| scripts/test-sync-rpc-wire-compatibility.js | Node | PASS |
| scripts/test-sync-rpc.js | Node | PASS |
| scripts/test-tray-menu-latency.js | Node | PASS |
| scripts/test-updater-removal.js | Node | PASS |
| scripts/test-upstream-detachment.js | Node | FAIL: Existing blog attribution plus .gitignore/My Lists legacy-extension scan findings |
| scripts/test-user-api-github-replace.js | Node | FAIL: Undefined value read with .map in fixture |
| scripts/test-user-api-github-wiring.js | Node | FAIL: Stale GitHub replacement implementation source assertion |
| scripts/test-user-api-runtime-close.js | Node | FAIL: sessionRegistry missing from fixture |
| scripts/test-user-api-sync-v2-wiring.js | Node | PASS |
| scripts/test-user-api-sync.js | Node | PASS |
| scripts/test-web-contents-navigation-guard.js | Node | PASS |
| scripts/test-webdav-proxy-startup.js | Node | FAIL: Missing @main/storage/credentials/types fixture dependency |
| build-config/test-script-runner.test.js | Node | PASS; new behavioral tests, red then green |
| build-config/unit-test-discovery.test.js | Node | PASS; new behavioral tests, red then green |

## Original lint baseline and continuing validation limits

The original full npm run lint reported 5 pre-existing errors: rendererShutdown.ts lines 56, 57, 59 and appRestart.ts line 9 (promise-function-async); main/utils/index.ts line 244 (consistent-type-assertions). These files' behavior predates this review plan; Task B preserved the existing work. They were initially left unchanged; the later authorized repair resolves them as documented below. Browserslist reports aged data; some existing renderer tests emit Vue lifecycle warnings. No dependency updates were made.

The PR workflow targets master and runs npm ci, lint, npm test and build, plus tracked-ignored-file and renderer HTML guards. YAML parsing and required step semantics were checked locally. A remote clean npm ci / Linux GitHub run has not been performed; PR status needs a user push. beta-pack.yml remains unchanged and triggers only on beta (not present among the current branches).

Original aggregate: npm test exited 1 after successful four-project typecheck; unit test totals 1,394 / pass 1,367 / fail 22 / skipped 5 (11 failing files). Separate test:scripts exited 1 with 36/53 passing (17 failing files). Isolated npm run build passed in 3m42s. Both CI guards passed positive/negative fixture checks using their actual Bash bodies.

## Authorized default-suite repairs

The default selection remains 123 build-config files and all 53 scripts. No failure was excluded and no skip was added. Real feature policy, lazy setting registration, recommendation routing/guards, repository-based account fixtures, durable Store writes, IPC envelopes, runtime cleanup and retained-retirement retry contracts replace outdated harness assumptions. GitHub replacement tests preserve rollback/error assertions and now explicitly verify fail-closed ensure before successful disposal retry. Attribution and legacy import coverage remain, with narrow audit allowances and negative probes.

Production fixes: QQ singleton callbacks now use the existing account/profile validator before returning a cookie, preserving malformed and mismatched-account rejection. NetEase's pinned request module receives its anonymous bootstrap token in memory through a module-local require adapter (no shared OS token file or global patch); Store clearInvalidConfig preserves invalid originals in unique adjacent directories and permits a durable replacement while strict mode/read/recovery failures remain errors. Five source lint errors are resolved while preserving the restart factory's exact shared Promise identity.

**Current result: npm test and npm run lint both exit 0.** Default unit result: 1,398 tests, 1,393 pass, 0 fail, 5 unchanged skips; all 53 scripts pass. The four exact final-source noEmit/incremental-false TypeScript checks and targeted final-source lint also pass. Final isolated production build passes in 1m14s. The four affected Electron/build fixture suites pass 30/30 with no skips. See local task-E-repair-report.md for the full attempt ledger, including the first repair aggregate failures and subsequent correction. Historical Electron safeStorage and Kugou packaged-artifact failures remain outside the default-suite repair scope, and PR CI is unverified until pushed. beta-pack.yml remains unchanged with its existing beta-only trigger.
