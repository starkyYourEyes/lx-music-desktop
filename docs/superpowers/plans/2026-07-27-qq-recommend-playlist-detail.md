# QQ Recommend Playlist Detail Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make QQ Music recommendation playlist cards, including dynamic directories `211111` and `211207`, load and play through QQ's current authenticated API.

**Architecture:** Add a focused main-process playlist-detail service beside the existing QQ Daily 30 service. Expose its normalized result over typed IPC, then let the shared song-list store prefer it for QQ lists while retaining the legacy SDK as a compatibility fallback.

**Tech Stack:** TypeScript, Electron IPC, Vue renderer stores, Node assertion tests

---

### Task 1: Authenticated QQ Playlist Detail Service

**Files:**
- Create: `src/main/modules/qqMusic/playlistDetail.ts`
- Modify: `src/common/types/qq_music.d.ts`
- Test: `scripts/test-qq-music-playlist-detail.js`

- [ ] **Step 1: Write the failing service test**

Create a test fixture for `uniform_get_Dissinfo` with `dirinfo` and `songlist`. Assert that ID `211111` is sent as `disstid`, the serialized body is signed unchanged, the Cookie stays in the main-process request, and the response becomes an `LX.QQMusic.PlaylistDetailInfo` with normalized tracks and metadata.

- [ ] **Step 2: Run the test to verify RED**

Run: `node scripts/test-qq-music-playlist-detail.js`

Expected: FAIL because `src/main/modules/qqMusic/playlistDetail.ts` does not exist.

- [ ] **Step 3: Implement the minimal service**

Use the same `comm` identity and signer contract as `dailyRecommend.ts`, call:

```ts
req_1: {
  module: 'music.srfDissInfo.aiDissInfo',
  method: 'uniform_get_Dissinfo',
  param: { disstid: Number(id), userinfo: 1, tag: 1, is_pc: 1, guid, enc_host_uin: uin, dirid: 0 },
}
```

Reject non-decimal/zero IDs before the request. Treat top-level, module, and inner data codes as failures; preserve `QQMusicAuthError`; normalize `songlist` with `normalizeQQMusicTracks`; map `dirinfo.title`, `picurl2 || picurl`, `desc`, `host_nick`, and `listennum` into detail metadata.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node scripts/test-qq-music-playlist-detail.js`

Expected: `QQ Music playlist detail tests passed`.

### Task 2: Account and IPC Contract

**Files:**
- Modify: `src/main/modules/qqMusic/index.ts`
- Modify: `src/main/modules/winMain/rendererEvent/qqMusic.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Test: `scripts/test-qq-music-account.js`
- Test: `scripts/test-qq-music-ipc.js`

- [ ] **Step 1: Add failing contract assertions**

Assert that the account service wraps playlist detail in `runAuthenticatedRequest`, the renderer event accepts `{ id, page }`, and renderer IPC invokes the new event with that cloneable payload.

- [ ] **Step 2: Run the tests to verify RED**

Run: `node scripts/test-qq-music-account.js; node scripts/test-qq-music-ipc.js`

Expected: FAIL because the new service method and event name are absent.

- [ ] **Step 3: Wire the service through account and IPC layers**

Instantiate `createQQMusicPlaylistDetailService({ getCookie })`, expose `getPlaylistDetail(id, page)`, register `qq_music_get_playlist_detail`, and export renderer helper `getQQMusicPlaylistDetail(id, page)`.

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `node scripts/test-qq-music-account.js; node scripts/test-qq-music-ipc.js`

Expected: both scripts pass.

### Task 3: Renderer Song-List Integration

**Files:**
- Modify: `src/renderer/store/songList/action.ts`
- Test: `scripts/test-qq-music-playlist-detail.js`

- [ ] **Step 1: Add a failing renderer loader test**

Load `songList/action.ts` with mocked IPC and SDK. Assert that a `tx` detail request uses `getQQMusicPlaylistDetail`, normalizes and caches its songs, and falls back to `musicSdk.tx.songList.getListDetail` when authenticated detail fails.

- [ ] **Step 2: Run the test to verify RED**

Run: `node scripts/test-qq-music-playlist-detail.js`

Expected: FAIL because QQ lists still call the legacy SDK directly.

- [ ] **Step 3: Prefer the authenticated QQ loader**

Add a QQ branch parallel to the existing NetEase branch. Keep Daily 30's dedicated in-memory behavior first, then use main-process QQ detail for other `tx` IDs with a legacy SDK fallback.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `node scripts/test-qq-music-playlist-detail.js`

Expected: the service and renderer integration tests pass.

### Task 4: Verification

**Files:**
- Verify all modified files

- [ ] **Step 1: Run focused regressions**

Run: `node scripts/test-qq-music-playlist-detail.js; node scripts/test-qq-music-home-recommend.js; node scripts/test-qq-music-home-renderer.js; node scripts/test-qq-music-daily-30-renderer.js; node scripts/test-qq-music-account.js; node scripts/test-qq-music-ipc.js`

Expected: every script exits `0`.

- [ ] **Step 2: Run static verification**

Run: `npx tsc --noEmit; npx eslint src/main/modules/qqMusic/playlistDetail.ts src/main/modules/qqMusic/index.ts src/main/modules/winMain/rendererEvent/qqMusic.ts src/common/ipcNames.ts src/renderer/utils/ipc.ts src/renderer/store/songList/action.ts`

Expected: both commands exit `0`.

- [ ] **Step 3: Run an authenticated live smoke test**

Call the service with the locally stored QQ account and request `211111` and `211207`, printing only ID, title, and song count.

Expected: both return non-empty lists without exposing credentials.
