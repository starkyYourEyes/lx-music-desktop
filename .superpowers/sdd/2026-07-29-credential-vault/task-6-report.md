# Task 6 Report: Separate WebDAV Credentials from Settings

## Implementation

- Added the pure `sanitizeSettingUpdate()` boundary. Runtime settings updates reject non-empty `webdav.username` or `webdav.password`, omit both input keys, and force any compatibility values in the persisted settings snapshot back to empty strings.
- Added a WebDAV credential service backed only by `global.lx.credentialVault` using `{ kind: 'webdav-basic' }`. Status returns only `configured`, a masked username hint, and persistence mode. Set awaits vault write and verification; remove awaits deletion and verifies a missing readback.
- Exported `getConfiguredWebDAV()`. Normal list, play, picture, lyric, and upload paths now combine the ordinary URL with vault credentials, with no plaintext settings fallback. Runtime list parameters can no longer override credentials.
- Added exact plain-object and byte-bound validation for the transient Test payload. The Test path performs no vault mutation and does not log credentials.
- Added narrow status/set/remove IPC names, main handlers, renderer wrappers, and shared types.
- Updated `SettingOther.vue` so username/password are local refs. Test uses only transient local values, Save is the only credential write, Clear awaits vault removal, and the loaded status contains only a masked hint.
- Kept `src/common/defaultSetting.ts` and `app_setting.d.ts` compatibility keys unchanged and empty, as required. No file-list expansion was necessary beyond the required report.

## TDD Evidence

- Initial RED command: `node --test build-config/storage/webdav-credential-cutover.test.js` exited 1; one expected missing API and six test-harness lyric-import errors. The harness was corrected without production changes.
- Valid RED command: `node --test build-config/storage/webdav-credential-cutover.test.js` exited 1 with 0 passed / 7 failed. Failures were missing `sanitizeSettingUpdate`, missing credential/status APIs, permissive transient extras, and list credential override.
- First focused GREEN after main-process implementation: exit 0, 7 passed / 0 failed.
- Final focused GREEN: exit 0, 7 passed / 0 failed, 0 skipped, 0 todo.

## Verification

- Baseline `npm run test:storage`: exit 0, 102 passed / 0 failed.
- Final `npm run test:storage`: exit 0, 109 passed / 0 failed across 16 suites.
- Changed-file ESLint, including Vue and the new test: exit 0, no findings.
- `npm run build:main`: exit 0, webpack compiled successfully in 18.5 s.
- `npm run build:renderer`: exit 0, webpack compiled successfully in 228.9 s.
- `git diff --check`: exit 0 (only repository line-ending conversion notices).
- No real user settings/data were read and no live WebDAV server was contacted. Tests replace the network boundary with a controlled response.

## Credential Scan Classification

Command: `rg -n "webdav\.(username|password)" src/main src/renderer src/common`

- `src/common/defaultSetting.ts`: empty compatibility defaults only.
- `src/common/types/app_setting.d.ts`: compatibility type declarations only.
- `src/main/migration/credentials/legacySources.ts`: required legacy inventory and redaction only.
- `src/main/utils/index.ts`: settings denylist and forced empty compatibility values only.
- No renderer match and no ordinary main-process settings read of either credential key.

The broader username/password scan additionally found only local unsaved Vue refs, vault/transient validators, and WebDAV request configuration assembled in memory. No credential appears in status output or logging.

## Files Changed

- `build-config/storage/webdav-credential-cutover.test.js`
- `src/common/ipcNames.ts`
- `src/common/types/music.d.ts`
- `src/main/modules/webdav.ts`
- `src/main/modules/winMain/rendererEvent/webdav.ts`
- `src/main/utils/index.ts`
- `src/renderer/utils/ipc.ts`
- `src/renderer/views/Setting/components/SettingOther.vue`
- `.superpowers/sdd/2026-07-29-credential-vault/task-6-report.md`

## Self-review

- Confirmed every vault write/remove is awaited and set/remove effects are verified before IPC resolution.
- Confirmed missing or undecryptable credentials produce the same secret-free missing status and normal access fails through the existing incomplete-config guard.
- Confirmed malicious runtime list objects cannot replace vault username/password even when JavaScript bypasses TypeScript.
- Confirmed the UI never reads compatibility username/password settings and clears locally held values after Save or Clear.
- The UI reuses the existing `.p` row and adjacent compact button conventions; no custom sizing or layout behavior was introduced.

## Concerns

None. Interactive testing against a live WebDAV server was intentionally not performed.
