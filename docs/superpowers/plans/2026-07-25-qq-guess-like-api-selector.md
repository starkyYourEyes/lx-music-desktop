# QQ Music Guess-Like API Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the signed QQ desktop-client Guess You Like API the default while retaining the legacy API behind a persistent Settings selector.

**Architecture:** Carry a typed API version from renderer settings through the existing IPC request into the main QQ song service. Split the service into new and legacy request paths that share normalization and signed-request helpers, and bind the renderer queue generation to both account and API version so stale or mixed-source results cannot enter playback.

**Tech Stack:** TypeScript, Vue 3/Pug, Electron IPC, Node `fetch`/`crypto`, repository Node assertion scripts.

---

## File Structure

- Create `src/main/modules/qqMusic/request.ts`: shared QQ request signing and deterministic device-ID helpers.
- Modify `src/main/modules/qqMusic/dailyRecommend.ts`: consume shared helpers without changing Daily 30 behavior.
- Modify `src/main/modules/qqMusic/song.ts`: implement strict new and legacy Guess You Like request paths.
- Modify `src/common/types/qq_music.d.ts`: add the API version to the Guess Like IPC request.
- Modify `src/common/types/app_setting.d.ts` and `src/common/defaultSetting.ts`: define and default the persistent setting.
- Modify `src/renderer/utils/ipc.ts`: send continuation and API version together.
- Modify `src/renderer/store/qqGuessLike/action.ts`: route using the current setting and isolate queue generations by API version.
- Modify `src/renderer/views/Setting/components/SettingRecommend.vue`: render the selector.
- Modify `src/lang/{zh-cn,zh-tw,en-us}.json`: localize the setting labels.
- Modify focused scripts under `scripts/`: cover service routing, queue isolation, and settings wiring.

### Task 1: Lock The New And Legacy Main-Process Contracts

**Files:**
- Modify: `scripts/test-qq-music-song.js`

- [ ] **Step 1: Write failing service tests**

Extend the test harness so `getGuessLikeSongs()` expects the new request by default and `getGuessLikeSongs({ apiVersion: 'legacy' })` expects the existing request. Assert the new request has:

```js
assert.strictEqual(url.origin + url.pathname, 'https://u6.y.qq.com/cgi-bin/musics.fcg')
const requestKey = 'music.radioProxy.MbTrackRadioSvr.get_radio_track'
assert.strictEqual(body[requestKey].module, 'music.radioProxy.MbTrackRadioSvr')
assert.strictEqual(body[requestKey].method, 'get_radio_track')
assert.deepStrictEqual(body[requestKey].param, { id: 99, num: 15 })
assert.strictEqual(sign.slice(-32), createHash('md5').update(`CJBPACrRuNy7${options.body}`).digest('hex'))
```

Return tracks from `<request-key>.data.tracks`, then separately assert that the legacy selector retains `songlist`, `firstplay`, and `musicu.fcg`.

- [ ] **Step 2: Run the service test and verify RED**

Run: `node scripts/test-qq-music-song.js`

Expected: FAIL because the current default still calls `musicu.fcg` and ignores `apiVersion`.

- [ ] **Step 3: Add shared signed-request helpers and both service paths**

Create exports in `request.ts`:

```ts
export const createQQMusicRequestSign = (body: string): string => { /* accepted zza + MD5 algorithm */ }
export const createQQMusicFallbackGuid = (uin: string): string => { /* deterministic 32-char hex */ }
export const createQQMusicFallbackUid = (uin: string): string => { /* deterministic 10 digits */ }
```

Move Daily 30 to those helpers. In `song.ts`, route with:

```ts
const apiVersion = options.apiVersion ?? 'new'
return apiVersion == 'legacy'
  ? getLegacyGuessLikeSongs(cookie, options.continuation ?? false)
  : getNewGuessLikeSongs(cookie)
```

The new body uses `music.radioProxy.MbTrackRadioSvr.get_radio_track` as its request key and normalizes that same response node's `data.tracks`. Preserve generic sanitized errors and authentication errors.

- [ ] **Step 4: Run main tests and verify GREEN**

Run:

```powershell
node scripts/test-qq-music-song.js
node scripts/test-qq-music-daily-30.js
```

Expected: both print their pass messages.

### Task 2: Add The Persistent Setting And IPC Value

**Files:**
- Modify: `src/common/types/app_setting.d.ts`
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/common/types/qq_music.d.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/renderer/views/Setting/components/SettingRecommend.vue`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`
- Modify: `scripts/test-provider-recommend-pages.js`
- Modify: `scripts/test-qq-music-ipc.js`

- [ ] **Step 1: Write failing setting and IPC wiring tests**

Assert the default and type are present, the Settings component contains two radio-style controls, all three locales contain the labels, and renderer IPC accepts an `apiVersion` argument in the typed request.

- [ ] **Step 2: Run wiring tests and verify RED**

Run:

```powershell
node scripts/test-provider-recommend-pages.js
node scripts/test-qq-music-ipc.js
```

Expected: FAIL on the missing selector/default/type.

- [ ] **Step 3: Implement the setting and selector**

Add:

```ts
'recommend.qqGuessLikeApiVersion': 'new'
```

with type `LX.QQMusic.GuessLikeApiVersion`. Render two `base-checkbox` controls using the same `name`, `need`, and values `new` and `legacy`, and persist through `updateSetting`.

Update renderer IPC to accept `(continuation, apiVersion)` and send both fields.

- [ ] **Step 4: Run wiring tests and verify GREEN**

Run the same two scripts; expect both pass messages.

### Task 3: Isolate Continuous Queues By API Version

**Files:**
- Modify: `src/renderer/store/qqGuessLike/action.ts`
- Modify: `scripts/test-qq-music-continuous.js`

- [ ] **Step 1: Write failing queue routing tests**

Mock `appSetting['recommend.qqGuessLikeApiVersion']`, record both IPC arguments, and prove initial/continuation requests use the selected value. Start a deferred request under `new`, switch to `legacy`, start another load, then resolve the old request and assert only legacy results remain.

- [ ] **Step 2: Run queue tests and verify RED**

Run: `node scripts/test-qq-music-continuous.js`

Expected: FAIL because requests currently pass only the continuation boolean and queue ownership ignores API version.

- [ ] **Step 3: Implement version snapshots**

Import `appSetting`, store the active queue version in module scope, include it in request snapshots, and reset when either account or version changes. Pass the version to every `getQQMusicGuessLikeSongs` call and keep the existing generation checks for late results.

- [ ] **Step 4: Run queue tests and verify GREEN**

Run: `node scripts/test-qq-music-continuous.js`

Expected: `QQ Music continuous recommendation tests passed`.

### Task 4: Regression And Static Verification

**Files:**
- Verify all modified files.

- [ ] **Step 1: Run focused QQ regression tests**

```powershell
node scripts/test-qq-music-song.js
node scripts/test-qq-music-daily-30.js
node scripts/test-qq-music-account.js
node scripts/test-qq-music-ipc.js
node scripts/test-qq-music-continuous.js
node scripts/test-provider-recommend-pages.js
```

Expected: all pass.

- [ ] **Step 2: Run TypeScript checks**

```powershell
npx tsc -p src/common/tsconfig.json --noEmit
npx tsc -p src/main/tsconfig.json --noEmit
npx tsc -p src/renderer/tsconfig.json --noEmit
```

Expected: exit code 0 for each command.

- [ ] **Step 3: Run focused ESLint**

```powershell
npx eslint src/common/defaultSetting.ts src/common/types/app_setting.d.ts src/common/types/qq_music.d.ts src/main/modules/qqMusic/request.ts src/main/modules/qqMusic/dailyRecommend.ts src/main/modules/qqMusic/song.ts src/renderer/utils/ipc.ts src/renderer/store/qqGuessLike/action.ts src/renderer/views/Setting/components/SettingRecommend.vue
```

Expected: exit code 0.

- [ ] **Step 4: Check patch integrity**

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Review scoped diff**

Inspect only the files listed in this plan. Confirm no cookie, key, token, signature, UIN, GUID, UID, or raw captured payload value is logged or exposed to the renderer.
