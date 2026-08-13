# Invalid Remote User API Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import every valid script from a GitHub source batch, skip downloaded scripts whose LX metadata cannot be parsed, and report the skipped paths in one dialog without replacing local sources when the whole batch is invalid.

**Architecture:** The main-process preparation function parses each downloaded script and returns a candidate state plus rejected remote paths. The transactional replacement function commits only a nonempty candidate and carries the skipped paths through the typed IPC success result. The settings modal reconciles the committed list, keeps its existing success status, and opens one bounded localized summary dialog.

**Tech Stack:** TypeScript, JavaScript, Electron IPC, Vue 3 Options API, Node.js `node:test`, Babel test loader, JSON locale files.

## Global Constraints

- Skip only scripts that downloaded successfully but fail `parseScriptInfo`.
- Network, HTTP, GitHub snapshot, metadata, download-response, and batch-limit errors still abort the whole import.
- A mixed batch replaces custom sources atomically with its valid scripts.
- An all-invalid batch performs no commit and preserves local source, fallback, selection, and runtime state.
- Show one summary dialog for all skipped paths; do not expose script contents or stack traces.
- Do not change local-file import, online-URL import, or user API synchronization.
- Preserve unrelated working-tree changes in `build-config/playback-media-validation.test.js`, `build-config/playback-source-fallback.test.js`, `build-config/song-row-components.test.js`, `build-config/storage-electron/database-recovery.test.js`, `build-config/test-utils/playback-fallback-harness.js`, `src/renderer/core/music/playback/sourceAdapter.ts`, `src/renderer/core/useApp/usePlayer/usePlayerEvent.ts`, and `src/renderer/views/List/MusicList/index.vue`.

---

## File Structure

- Create `build-config/user-api/github-import-isolation.test.js`: focused core tests that load `src/main/modules/userApi/utils.ts` and `src/main/modules/userApi/index.ts` with deterministic stores, compression, and runtime mocks.
- Modify `build-config/user-api/state-reconciliation.test.js` and `build-config/user-api/state-serialization.test.js`: update preparation mocks to the new `{ state, skipped }` contract.
- Modify `src/main/modules/userApi/utils.ts`: define the prepared GitHub batch shape, skip parse failures, and reject an all-invalid batch before state construction completes.
- Modify `src/main/modules/userApi/index.ts`: commit the prepared state and return `{ apiList, skipped }` while preserving rollback and runtime cleanup behavior.
- Modify `src/common/types/user_api.d.ts`: declare shared prepared/replacement result types and add `skipped` to the IPC success variant.
- Modify `build-config/user-api/ipc-routing.test.js`: prove the main IPC handler serializes the successful replacement object.
- Modify `build-config/user-api/ipc-envelope.test.js`: prove the renderer IPC helper returns the complete success object and retains existing error behavior.
- Modify `src/main/modules/winMain/rendererEvent/userApi.ts`: pass the main-process replacement result through the IPC success envelope.
- Modify `src/renderer/utils/ipc.ts`: return `{ apiList, skipped }` from the renderer helper.
- Modify `build-config/user-api/modal-reconciliation.test.js`: prove mixed batches reconcile once and display one bounded summary, while all-invalid failures keep the current list.
- Modify `src/renderer/views/Setting/components/UserApiModal.vue`: format bounded paths and display the localized summary after a successful mixed import.
- Modify `src/lang/zh-cn.json`, `src/lang/zh-tw.json`, and `src/lang/en-us.json`: add the skipped-source summary message.

### Task 1: Isolate Invalid Scripts In Main-Process Preparation

**Files:**
- Create: `build-config/user-api/github-import-isolation.test.js`
- Modify: `build-config/user-api/state-reconciliation.test.js`
- Modify: `build-config/user-api/state-serialization.test.js`
- Modify: `src/main/modules/userApi/utils.ts:167-311`
- Modify: `src/main/modules/userApi/index.ts:154-193`

**Interfaces:**
- Consumes: `LX.UserApi.GitHubImportItem[]`, `parseScriptInfo(script)`, `createGitHubUserApiError(code, detail)`, and the existing `UserApiState` transaction.
- Produces: `prepareApisFromGitHub(items): Promise<{ state: UserApiState, skipped: string[] }>` and `replaceApisFromGitHub(items): Promise<{ apiList: LX.UserApi.UserApiInfo[], skipped: string[] }>`.
- Error contract: if no script parses, throw `createGitHubUserApiError('GITHUB_INVALID_SCRIPT', skipped.join(', '))` before `commitUserApiState` runs.

- [ ] **Step 1: Write focused failing preparation and transaction tests**

Create `build-config/user-api/github-import-isolation.test.js` with a `loadTsModule` harness. Use valid scripts with a leading metadata block and invalid scripts such as `'console.log("missing metadata")'`. Assert the exact behavior:

```js
test('mixed GitHub batch keeps valid scripts in order and reports every invalid path', async() => {
  const { utils } = createUtilsHarness()
  const result = await utils.prepareApisFromGitHub([
    githubItem('valid-a.js', validScript('A')),
    githubItem('invalid-b.js', 'console.log("missing metadata")'),
    githubItem('valid-c.js', validScript('C')),
    githubItem('invalid-d.js', ''),
  ])

  assert.deepEqual(result.state.apiList.map(api => api.name), ['A', 'C'])
  assert.deepEqual(result.skipped, [
    `${VERSION}/group/invalid-b.js`,
    `${VERSION}/group/invalid-d.js`,
  ])
  assert.equal(result.state.scripts.size, 2)
})

test('all-invalid GitHub batch rejects before replacement commits', async() => {
  const harness = createReplacementHarness([
    githubItem('invalid-a.js', ''),
    githubItem('invalid-b.js', 'const value = 1'),
  ])

  await assert.rejects(
    () => harness.module.replaceApisFromGitHub(harness.items),
    error => error.code == 'GITHUB_INVALID_SCRIPT' &&
      error.detail.includes('invalid-a.js') &&
      error.detail.includes('invalid-b.js'),
  )
  assert.equal(harness.commitCount, 0)
  assert.deepEqual(harness.currentState, harness.previousState)
  assert.deepEqual(harness.runtimeActions, [])
})

test('compression failure still aborts the whole batch', async() => {
  const compressionError = new Error('compression failed')
  const { utils } = createUtilsHarness({ compressionError })
  await assert.rejects(
    () => utils.prepareApisFromGitHub([githubItem('valid.js', validScript('A'))]),
    error => error === compressionError,
  )
})
```

The harness must use valid GitHub metadata, unique paths and blob SHAs, an in-memory store, and a `node:zlib` mock. It must preserve the real `createGitHubUserApiError` implementation from `src/common/utils/githubUserApi.js`.

- [ ] **Step 2: Run the focused test and verify the RED state**

Run:

```powershell
node --test build-config/user-api/github-import-isolation.test.js
```

Expected: FAIL because `prepareApisFromGitHub` throws on the first invalid script and returns `UserApiState` rather than `{ state, skipped }`.

- [ ] **Step 3: Implement per-script parse isolation**

In `src/main/modules/userApi/utils.ts`, introduce a local or exported result type and catch only `parseScriptInfo` failures:

```ts
export interface PreparedGitHubUserApis {
  state: UserApiState
  skipped: string[]
}

export const prepareApisFromGitHub = async(
  items: LX.UserApi.GitHubImportItem[],
): Promise<PreparedGitHubUserApis> => {
  const snapshots = validateGitHubImportItems(items)
  const nextUserApis: LX.UserApi.UserApiInfo[] = []
  const nextScripts = new Map<string, string>()
  const skipped: string[] = []

  for (const { id, script, remote } of snapshots) {
    let scriptInfo: ReturnType<typeof parseScriptInfo>
    try {
      scriptInfo = parseScriptInfo(script)
    } catch {
      skipped.push(remote.path)
      continue
    }
    nextUserApis.push({ id, ...scriptInfo, allowShowUpdateAlert: true, remote })
    nextScripts.set(id, await deflateScript(script))
  }

  if (!nextUserApis.length) {
    throw createGitHubUserApiError('GITHUB_INVALID_SCRIPT', skipped.join(', '))
  }
  return { state: { apiList: nextUserApis, scripts: nextScripts }, skipped }
}
```

Do not wrap `deflateScript`. Compression and allocation failures must propagate and abort preparation.

- [ ] **Step 4: Carry the preparation result through the transaction**

In `src/main/modules/userApi/index.ts`, destructure the prepared result before commit and return both fields after the current lifecycle work finishes:

```ts
export interface GitHubUserApiReplacement {
  apiList: LX.UserApi.UserApiInfo[]
  skipped: string[]
}

const { state: nextState, skipped } = await prepareApisFromGitHub(items)
const apiList = commitUserApiState(nextState)
return { apiList, skipped }
```

Place the new `return` after the existing `completeCommittedUserApiState(...)` call. Leave the intervening `applyRuntimeChanges`, rollback, fallback cleanup, and notification statements unchanged.

Update existing user-API test mocks whose `prepareApisFromGitHub` functions return a bare state. Each mock must return `{ state: cloneState(nextState), skipped: [] }`; the serialization harness uses `{ state: nextState, skipped: [] }`. Update assertions that consume `replaceApisFromGitHub` to read `.apiList` only when they inspect its result.

- [ ] **Step 5: Run core tests and verify the GREEN state**

Run:

```powershell
node --test build-config/user-api/github-import-isolation.test.js build-config/user-api/state-reconciliation.test.js build-config/user-api/state-serialization.test.js
```

Expected: all tests PASS. The mixed test reports both rejected paths, the all-invalid test records zero commits, and the compression error remains fatal.

- [ ] **Step 6: Commit the core behavior**

```powershell
git add -- build-config/user-api/github-import-isolation.test.js build-config/user-api/state-reconciliation.test.js build-config/user-api/state-serialization.test.js src/main/modules/userApi/utils.ts src/main/modules/userApi/index.ts
git commit -m "fix: isolate invalid remote source scripts"
```

### Task 2: Carry Skipped Paths Through Typed IPC

**Files:**
- Modify: `src/common/types/user_api.d.ts:16-34`
- Modify: `src/main/modules/winMain/rendererEvent/userApi.ts:110-124`
- Modify: `src/renderer/utils/ipc.ts:125-140`
- Modify: `build-config/user-api/ipc-routing.test.js`
- Modify: `build-config/user-api/ipc-envelope.test.js`

**Interfaces:**
- Consumes: Task 1 `replaceApisFromGitHub(items): Promise<{ apiList, skipped }>`.
- Produces: `LX.UserApi.GitHubReplaceSuccess` and a renderer helper that resolves to `{ apiList, skipped }`.
- Keeps: failure envelopes with optional retained `apiList`, bounded `message`, `code`, and `detail`.

- [ ] **Step 1: Write failing IPC success-contract tests**

Extend the existing main and renderer IPC tests with a success object:

```js
const success = {
  apiList: [{ id: 'github-source' }],
  skipped: ['v260724/group/invalid.js'],
}

replaceImplementation = async() => success
assert.deepEqual(await invokeMainReplacement(), {
  success: true,
  ...success,
})

rendererResult = { success: true, ...success }
assert.deepEqual(
  await rendererRuntime.replaceUserApisFromGitHub([]),
  success,
)
```

Retain the existing assertions for invalid-script errors, post-commit failures with `apiList`, and length-bounded serialized errors.

- [ ] **Step 2: Run IPC tests and verify the RED state**

Run:

```powershell
node --test build-config/user-api/ipc-routing.test.js build-config/user-api/ipc-envelope.test.js
```

Expected: FAIL because the main handler nests Task 1's object under `apiList`, and the renderer helper drops `skipped`.

- [ ] **Step 3: Define and implement the success envelope**

In `src/common/types/user_api.d.ts`, define the shared success shape and use it in the discriminated union:

```ts
interface GitHubReplaceSuccess {
  apiList: UserApiInfo[]
  skipped: string[]
}

type GitHubReplaceResult = ({ success: true } & GitHubReplaceSuccess) | {
  success: false
  apiList?: UserApiInfo[]
  error: GitHubReplaceError
}
```

In the main handler, spread the result:

```ts
return { success: true, ...await replaceApisFromGitHub(items) }
```

In the renderer helper, return both fields:

```ts
if (result.success) {
  return { apiList: result.apiList, skipped: result.skipped }
}
```

Do not add `skipped` to failure envelopes. An all-invalid batch uses the existing `GITHUB_INVALID_SCRIPT` error path.

- [ ] **Step 4: Run IPC tests and verify the GREEN state**

Run:

```powershell
node --test build-config/user-api/ipc-routing.test.js build-config/user-api/ipc-envelope.test.js
```

Expected: all tests PASS with the exact success object and unchanged failure semantics.

- [ ] **Step 5: Commit the IPC contract**

```powershell
git add -- src/common/types/user_api.d.ts src/main/modules/winMain/rendererEvent/userApi.ts src/renderer/utils/ipc.ts build-config/user-api/ipc-routing.test.js build-config/user-api/ipc-envelope.test.js
git commit -m "feat: report skipped remote source scripts"
```

### Task 3: Display One Bounded Summary Dialog

**Files:**
- Modify: `build-config/user-api/modal-reconciliation.test.js`
- Modify: `src/renderer/views/Setting/components/UserApiModal.vue:122-218`
- Modify: `src/lang/zh-cn.json:804-819`
- Modify: `src/lang/zh-tw.json:804-819`
- Modify: `src/lang/en-us.json:804-819`

**Interfaces:**
- Consumes: Task 2 renderer result `{ apiList, skipped }`.
- Produces: `formatSkippedGitHubScripts(paths): string` and one call to the existing `dialog(message)` plugin after a mixed import succeeds.
- Bounds: normalize each path to its first line and at most 96 characters; include at most 20 paths; cap the final joined path text at 2,000 characters.

- [ ] **Step 1: Extend the modal harness and add failing UI tests**

Allow `createHarness` to inject `replaceUserApisFromGitHub`. Make `$t` interpolate enough data for assertions or record `{ key, params }`. Add these tests:

```js
test('mixed GitHub import reconciles valid sources and shows one skipped summary', async() => {
  const validList = [{ id: 'valid', name: 'Valid source' }]
  const harness = createHarness({
    replaceResult: {
      apiList: validList,
      skipped: ['v260724/group/bad-a.js', 'v260724/group/bad-b.js'],
    },
  })

  await harness.component.methods.handleGitHubImport.call(harness.vm)

  assert.equal(harness.userApi.list, validList)
  assert.equal(harness.vm.githubStatusKey, 'user_api__github_import_success')
  assert.deepEqual(harness.dialogs, [{
    key: 'user_api__github_skipped_invalid_scripts',
    params: {
      count: 2,
      paths: 'v260724/group/bad-a.js\nv260724/group/bad-b.js',
    },
  }])
})

test('skipped summary bounds untrusted remote paths', () => {
  const harness = createHarness()
  const paths = Array.from({ length: 25 }, (_, index) =>
    `v260724/group/${index}-${'x'.repeat(200)}\nsecret`,
  )
  const formatted = harness.component.methods.formatSkippedGitHubScripts.call(harness.vm, paths)
  assert.equal(formatted.split('\n').length, 20)
  assert.ok(formatted.length <= 2_000)
  assert.doesNotMatch(formatted, /secret/)
})

test('all-invalid GitHub failure keeps the current list and shows only the error dialog', async() => {
  const error = Object.assign(new Error('invalid scripts'), {
    code: 'GITHUB_INVALID_SCRIPT',
    detail: 'v260724/group/bad.js',
  })
  const harness = createHarness({ replaceError: error })
  const previous = harness.userApi.list

  await harness.component.methods.handleGitHubImport.call(harness.vm)

  assert.equal(harness.userApi.list, previous)
  assert.deepEqual(harness.dialogs, [{
    key: 'user_api__github_error_invalid_script',
    params: { message: 'v260724/group/bad.js' },
  }])
})
```

Keep the existing retained post-commit failure test. Its mocked error still carries `apiList` and must reconcile before the error dialog.

- [ ] **Step 2: Run the modal test and verify the RED state**

Run:

```powershell
node --test build-config/user-api/modal-reconciliation.test.js
```

Expected: FAIL because the modal expects a bare API list, has no bounded path formatter, and has no skipped-summary translation key.

- [ ] **Step 3: Add translations**

Add `user_api__github_skipped_invalid_scripts` next to the GitHub import success string:

```json
// zh-cn.json
"user_api__github_skipped_invalid_scripts": "已跳过 {count} 个无效远程音源脚本：\n{paths}",

// zh-tw.json
"user_api__github_skipped_invalid_scripts": "已略過 {count} 個無效遠端音源腳本：\n{paths}",

// en-us.json
"user_api__github_skipped_invalid_scripts": "Skipped {count} invalid remote source scripts:\n{paths}",
```

Use JSON string escapes for the newline. Keep each locale file valid JSON.

- [ ] **Step 4: Implement bounded formatting and one dialog**

Add constants near the imports or component definition and a method:

```js
const skippedPathLimits = Object.freeze({ count: 20, path: 96, total: 2_000 })

formatSkippedGitHubScripts(paths) {
  return paths.slice(0, skippedPathLimits.count)
    .map(path => String(path).split(/\r?\n/, 1)[0].substring(0, skippedPathLimits.path))
    .join('\n')
    .substring(0, skippedPathLimits.total)
}
```

Update the success path in `handleGitHubImport`:

```js
const { apiList, skipped } = await replaceUserApisFromGitHub(items)
this.reconcileApiList(apiList, oldCustomIds)
if (!this.isGitHubViewCurrent(viewGeneration)) return
this.githubStatus = this.$t('user_api__github_import_success', {
  version: snapshot.version,
  count: apiList.length,
})
if (skipped.length) {
  void dialog(this.$t('user_api__github_skipped_invalid_scripts', {
    count: skipped.length,
    paths: this.formatSkippedGitHubScripts(skipped),
  }))
}
```

Do not show the summary before `reconcileApiList` or for an empty `skipped` array. Keep the view-generation guard so closing the modal suppresses stale UI changes.

- [ ] **Step 5: Run modal and locale tests and verify the GREEN state**

Run:

```powershell
node --test build-config/user-api/modal-reconciliation.test.js
node -e "for (const file of ['src/lang/zh-cn.json','src/lang/zh-tw.json','src/lang/en-us.json']) JSON.parse(require('node:fs').readFileSync(file, 'utf8')); console.log('locale JSON valid')"
```

Expected: all modal tests PASS and the JSON command prints `locale JSON valid`.

- [ ] **Step 6: Commit the renderer behavior**

```powershell
git add -- build-config/user-api/modal-reconciliation.test.js src/renderer/views/Setting/components/UserApiModal.vue src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json
git commit -m "feat: summarize skipped remote source scripts"
```

### Task 4: Full Verification

**Files:**
- Verify only; fix failures in the files owned by Tasks 1-3.

**Interfaces:**
- Consumes: all Task 1-3 behavior.
- Produces: fresh test, lint, type/bundle, and diff evidence suitable for completion.

- [ ] **Step 1: Run the complete user-API test suite**

```powershell
npm run test:user-api
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 2: Re-run the GitHub downloader tests**

```powershell
node scripts/test-github-user-api.js
```

Expected: exit code 0. Downloader network and HTTP failures retain fail-fast semantics.

Do not use `scripts/test-user-api-github-replace.js` or `scripts/test-user-api-github-wiring.js` as completion gates. Both scripts fail on the unmodified baseline because they contain stale modal ordering assertions and an incomplete `ipcValidation` module mock; `npm run test:user-api` is the maintained user-API suite.

- [ ] **Step 3: Lint every touched source file**

```powershell
npx eslint -f node_modules/eslint-formatter-friendly src/main/modules/userApi/utils.ts src/main/modules/userApi/index.ts src/common/types/user_api.d.ts src/main/modules/winMain/rendererEvent/userApi.ts src/renderer/utils/ipc.ts src/renderer/views/Setting/components/UserApiModal.vue
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 4: Build both affected bundles**

```powershell
npm run build:main
npm run build:renderer
```

Expected: both commands exit 0.

- [ ] **Step 5: Audit the final diff and working tree**

```powershell
git diff --check
git status --short
git diff --stat HEAD~3..HEAD
```

Expected: `git diff --check` produces no output. The three implementation commits contain only the planned source and test files; the pre-existing unrelated working-tree changes remain untouched.
