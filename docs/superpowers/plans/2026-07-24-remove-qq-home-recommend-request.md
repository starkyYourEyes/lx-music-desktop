# Remove QQ Home Recommendation Request Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every runtime path that can issue the QQ Music home recommendation request while preserving QQ login, the QQ recommendation page, and Guess You Like.

**Architecture:** Turn the existing source-wiring checks into regression guards that reject the removed request, then remove the renderer diagnostic, IPC contract, main-process request service, and request-only types. Keep the captured response JSON and historical documents untouched.

**Tech Stack:** Electron, Vue 3, TypeScript, Node.js assertion scripts, webpack

---

## File Map

- Modify `scripts/test-provider-recommend-pages.js`: assert the QQ page has no home recommendation diagnostic while retaining Guess You Like wiring.
- Modify `scripts/test-qq-music-ipc.js`: assert the IPC contract exposes no home recommendation request.
- Modify `scripts/test-qq-music-account.js`: remove the obsolete recommendation-service fixture and account-facade assertions.
- Delete `scripts/test-qq-music-home-recommend.js`: remove tests dedicated to the deleted service.
- Modify `src/renderer/views/QQRecommend/index.vue`: remove diagnostic setup and trigger calls only.
- Delete `src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts`: remove Console diagnostic behavior.
- Modify `src/renderer/utils/ipc.ts`: remove the renderer IPC wrapper.
- Modify `src/common/ipcNames.ts`: remove the IPC event name.
- Modify `src/common/types/qq_music.d.ts`: remove the request-only response type.
- Modify `src/main/modules/winMain/rendererEvent/qqMusic.ts`: remove the main IPC handler.
- Modify `src/main/modules/qqMusic/index.ts`: remove recommendation-service construction and account-facade exposure.
- Delete `src/main/modules/qqMusic/recommend.ts`: remove the upstream QQ request implementation.

### Task 1: Add Regression Guards for Request Removal

**Files:**
- Modify: `scripts/test-provider-recommend-pages.js:44-66`
- Modify: `scripts/test-qq-music-ipc.js:16-45`

- [ ] **Step 1: Replace positive page diagnostic assertions with absence assertions**

Use these assertions while retaining the existing QQ page, login, artwork, subtitle, and Guess You Like assertions:

```js
assert(!exists('src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts'),
  'QQ home recommendation diagnostic should be removed')

const qqPage = read('src/renderer/views/QQRecommend/index.vue')
const qqCard = read('src/renderer/views/QQRecommend/useQQGuessLikeCard.ts')
assert.doesNotMatch(qqPage, /useQQHomeRecommendDiagnostic|inspectHomeRecommend|resetHomeRecommendDiagnostic/,
  'QQ page should not request or log QQ home recommendations')
assert.match(qqPage, /useQQGuessLikeData/,
  'QQ page should own Guess You Like data')
assert.match(qqPage, /useQQMusicLoginQr/,
  'QQ page should own QQ QR login')
assert.match(qqPage, /await loadQQGuessLikeSongs\(\)/,
  'QQ page should automatically load recommendations for a signed-in account')
```

- [ ] **Step 2: Replace positive home recommendation IPC assertions with absence assertions**

Keep the account, login, logout, and Guess You Like event names in the positive loop, but remove `qq_music_get_home_recommend`. Replace the home recommendation assertions with:

```js
assert.doesNotMatch(names, /qq_music_get_home_recommend/)
assert.doesNotMatch(handlers, /getHomeRecommend|qq_music_get_home_recommend/)
assert.doesNotMatch(rendererIpc, /getQQMusicHomeRecommend|qq_music_get_home_recommend/)
assert.doesNotMatch(types, /HomeRecommendResponse/)
```

- [ ] **Step 3: Run the guards and verify RED**

Run:

```bash
node scripts/test-provider-recommend-pages.js
node scripts/test-qq-music-ipc.js
```

Expected: both commands fail because the diagnostic file, page calls, IPC name, handler, renderer wrapper, and type still exist.

### Task 2: Remove the Renderer Request Trigger

**Files:**
- Modify: `src/renderer/views/QQRecommend/index.vue:37-45,87-116,127-135`
- Delete: `src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts`
- Modify: `src/renderer/utils/ipc.ts:759-764`

- [ ] **Step 1: Remove diagnostic construction from the QQ page**

Delete the diagnostic import and construction:

```ts
import { useQQHomeRecommendDiagnostic } from './useQQHomeRecommendDiagnostic'

const {
  inspect: inspectHomeRecommend,
  reset: resetHomeRecommendDiagnostic,
} = useQQHomeRecommendDiagnostic()
```

- [ ] **Step 2: Leave account initialization responsible only for Guess You Like**

The final branch in `initializeAccount` must be:

```ts
if (accountKey.value) {
  await loadQQGuessLikeSongs()
} else {
  clearQQGuessLikeSongs()
}
```

The final account watcher must be:

```ts
watch(accountKey, (value, oldValue) => {
  if (value == oldValue) return
  clearQQGuessLikeSongs()
  if (!value) return
  handleCloseLogin()
  if (isInitializingAccount) return
  void loadQQGuessLikeSongs()
})
```

The final unmount hook must only remove the login event listener:

```ts
onBeforeUnmount(() => {
  window.removeEventListener('show-qq-music-login', handleLoginRequest)
})
```

- [ ] **Step 3: Delete the diagnostic composable and renderer IPC wrapper**

Delete `src/renderer/views/QQRecommend/useQQHomeRecommendDiagnostic.ts` and remove this complete export from `src/renderer/utils/ipc.ts`:

```ts
export const getQQMusicHomeRecommend = async() => {
  return rendererInvoke<LX.QQMusic.HomeRecommendResponse>(
    WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_home_recommend,
  )
}
```

- [ ] **Step 4: Run the page guard**

Run:

```bash
node scripts/test-provider-recommend-pages.js
```

Expected: PASS with `provider recommendation page wiring tests passed`.

### Task 3: Remove the Main-Process Request Contract

**Files:**
- Modify: `src/common/ipcNames.ts:187`
- Modify: `src/common/types/qq_music.d.ts:29-32`
- Modify: `src/main/modules/winMain/rendererEvent/qqMusic.ts:3-9,33-38`
- Modify: `src/main/modules/qqMusic/index.ts:10,43-46,64-73,163-166,173-175,184-188,198`
- Delete: `src/main/modules/qqMusic/recommend.ts`

- [ ] **Step 1: Remove the public IPC event and response type**

Delete the `qq_music_get_home_recommend` property from `WIN_MAIN_RENDERER_EVENT_NAME` and delete:

```ts
interface HomeRecommendResponse {
  code: number
  [key: string]: unknown
}
```

- [ ] **Step 2: Remove the main-process handler**

Remove `getHomeRecommend` from the `@main/modules/qqMusic` import and delete:

```ts
mainHandle<LX.QQMusic.HomeRecommendResponse>(
  WIN_MAIN_RENDERER_EVENT_NAME.qq_music_get_home_recommend,
  async() => getHomeRecommend(),
)
```

- [ ] **Step 3: Remove recommendation service injection and facade methods**

Delete the `createQQMusicRecommendService` import and `RecommendService` interface. The final account-service parameters and type must be:

```ts
export const createQQMusicAccountService = ({
  store,
  loginService,
  songService,
  now = Date.now,
}: {
  store: AccountStore
  loginService: LoginService
  songService: SongService
  now?: () => number
}) => {
```

Remove the local `getHomeRecommend` wrapper, its returned property, and the exported singleton function. The final singleton construction must be:

```ts
const songService = createQQMusicSongService({ getCookie })
accountService = createQQMusicAccountService({ store, loginService, songService })
```

- [ ] **Step 4: Delete the upstream request service**

Delete `src/main/modules/qqMusic/recommend.ts`. Do not modify `src/main/modules/qqMusic/song.ts`; it owns Guess You Like and remains in use.

- [ ] **Step 5: Run the IPC guard**

Run:

```bash
node scripts/test-qq-music-ipc.js
```

Expected: PASS with `QQ Music IPC security tests passed`.

### Task 4: Remove Obsolete Service Tests and Verify Preserved Behavior

**Files:**
- Modify: `scripts/test-qq-music-account.js:37-44,72-77,82-88,126-131,284-287`
- Delete: `scripts/test-qq-music-home-recommend.js`

- [ ] **Step 1: Remove the obsolete account-test fixture**

Delete `singletonGetRecommendCookie`, `recommendError`, `rawRecommend`, and `recommendService`. Remove the `./recommend` loader mock and both `singletonGetRecommendCookie()` assertions. The final facade factory must be:

```js
const createFacade = () => createQQMusicAccountService({
  store,
  loginService,
  songService,
  now: () => 123456,
})
```

Delete the assertions that call `restarted.getHomeRecommend()` and `raceFacade.getHomeRecommend()`.

- [ ] **Step 2: Delete the dedicated home recommendation test**

Delete `scripts/test-qq-music-home-recommend.js`. It tests only the request service and diagnostic that no longer exist.

- [ ] **Step 3: Run focused regression tests**

Run each command:

```bash
node scripts/test-provider-recommend-pages.js
node scripts/test-qq-music-ipc.js
node scripts/test-qq-music-account.js
node scripts/test-qq-music-login.js
node scripts/test-qq-music-song.js
node scripts/test-qq-music-renderer-account.js
node scripts/test-qq-music-ui-wiring.js
node scripts/test-qq-music-continuous.js
```

Expected: every command exits with code 0 and prints its success message.

- [ ] **Step 4: Verify removed and preserved artifacts**

Run:

```powershell
rg -n --glob '!docs/**' --glob '!qq-getRecommend-response.json' "HomeRecommendResponse|getHomeRecommend|qq_music_get_home_recommend|useQQHomeRecommendDiagnostic|QQ Music getRecommend" src scripts
Test-Path 'qq-getRecommend-response.json'
Test-Path 'src/renderer/views/QQRecommend/index.vue'
```

Expected: `rg` exits with no matches; both `Test-Path` commands print `True`.

- [ ] **Step 5: Build both affected bundles**

Run:

```bash
npm run build:main
npm run build:renderer
```

Expected: both webpack builds exit with code 0 and no TypeScript or module-resolution errors.

- [ ] **Step 6: Commit the implementation**

Stage only the files listed in this plan, then commit:

```bash
git commit -m "refactor: remove QQ home recommendation request"
```
