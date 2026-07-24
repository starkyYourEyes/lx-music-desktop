# QQ Music Personalized Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the QQ Music recommendation page shown in the supplied references using authenticated QQ home-feed data and produce a verified Windows x64 portable executable.

**Architecture:** A new main-process service requests and normalizes `RecommendFeed`, then batch-enriches its grouped song cards through `CgiGetTrackInfo`. A renderer composable owns account-scoped data, and dedicated QQ sections reuse the existing QQ Daily 30, Guess You Like, song-list detail, and temporary-list playback contracts.

**Tech Stack:** Electron 37, Vue 3 Composition API, TypeScript, Less CSS Modules, Node `assert` tests, webpack, electron-builder.

---

## File Map

- Create `src/main/modules/qqMusic/homeRecommend.ts`: authenticated home-feed request, track enrichment, and response normalization.
- Modify `src/main/modules/qqMusic/index.ts`: account-facade ownership and auth-expiry cleanup.
- Modify `src/common/types/qq_music.d.ts`: normalized home recommendation types.
- Modify `src/common/ipcNames.ts`, `src/main/modules/winMain/rendererEvent/qqMusic.ts`, and `src/renderer/utils/ipc.ts`: typed IPC contract.
- Create `src/renderer/views/QQRecommend/useQQHomeRecommendData.ts`: account cache, request revision, loading, refresh, and error state.
- Create `src/renderer/views/QQRecommend/useQQHomeRecommendPlayback.ts`: playlist routing/playback and related-song temporary-list playback.
- Create `src/renderer/views/QQRecommend/components/QQFeaturedSection.vue`: Daily 30 hero plus four functional feature cards.
- Create `src/renderer/views/QQRecommend/components/QQPlaylistSection.vue`: horizontal private/guide playlist section with edge controls.
- Create `src/renderer/views/QQRecommend/components/QQRelatedSongsSection.vue`: three-column song grid with wrapping left/right batch controls.
- Modify `src/renderer/views/QQRecommend/index.vue`: page orchestration, account lifecycle, refresh, and responsive composition.
- Create `scripts/test-qq-music-home-recommend.js`: request and normalization behavior tests.
- Create `scripts/test-qq-music-home-renderer.js`: renderer contract and interaction tests.

### Task 1: Add Failing Main-Process Tests

- [ ] Create fixtures containing hero, private-playlist, grouped-song, exact guide, and AI-guide-fallback shelves.
- [ ] Assert the first request uses `music.recommend.RecommendFeed/get_recommend_feed` and authenticated Android comm fields.
- [ ] Assert the second request uses `music.trackInfo.UniformRuleCtrl/CgiGetTrackInfo` with all song IDs once.
- [ ] Assert normalized playlists, formatted titles, grouped playable songs, malformed-card filtering, auth errors, and timeout cleanup.
- [ ] Run `node scripts/test-qq-music-home-recommend.js`; expected result is a module-not-found failure for `homeRecommend.ts`.

### Task 2: Implement The Service And IPC

- [ ] Add normalized types for playlists and home sections in `qq_music.d.ts`.
- [ ] Implement `createQQMusicHomeRecommendService({ fetchImpl, getCookie })` and export pure normalizers for fixture tests.
- [ ] Inject the service into `createQQMusicAccountService`; on `QQMusicAuthError`, clear the account and rethrow.
- [ ] Add `qq_music_get_home_recommend` to common IPC names, the main handler, and renderer wrapper.
- [ ] Run `node scripts/test-qq-music-home-recommend.js`, `node scripts/test-qq-music-account.js`, and `node scripts/test-qq-music-ipc.js`; expected result is PASS for all three.

### Task 3: Add Failing Renderer Tests

- [ ] Assert the data composable caches by account, force-refreshes, rejects stale account responses, and retains same-account data on refresh failure.
- [ ] Assert the playback composable routes QQ playlists with `source: 'tx'`, installs related-song groups under a dedicated temporary-list ID, and toggles play/pause.
- [ ] Assert the page renders the four requested section labels and the related-song component exposes both arrow controls.
- [ ] Run `node scripts/test-qq-music-home-renderer.js`; expected result is failure because the new composables and components do not exist.

### Task 4: Build The QQ Home Page

- [ ] Implement account-scoped home loading and merge it with the existing Daily 30 and Guess You Like states.
- [ ] Implement the five-item feature strip, keeping Daily 30 as the large first item.
- [ ] Implement private and guide playlist carousels with deterministic card widths and edge scrolling.
- [ ] Implement grouped related songs with a wrapping page index, title from QQ's template/content fields, play-all, song click, current-song state, and left/right arrows.
- [ ] Add stable loading, empty, error, retry, signed-out, and narrow-window states.
- [ ] Run `node scripts/test-qq-music-home-renderer.js`; expected result is PASS.

### Task 5: Regression And Production Verification

- [ ] Run all `scripts/test-qq-music-*.js` and `scripts/test-provider-recommend-pages.js`; expected result is PASS.
- [ ] Run `npx tsc -p src/common --noEmit`, `npx tsc -p src/main --noEmit`, and `npx tsc -p src/renderer --noEmit`; expected result is no diagnostics.
- [ ] Run ESLint on all QQ recommendation files changed by this plan; expected result is no errors.
- [ ] Run `npm run build:main`, `npm run build:renderer`, and `npm run build`; expected result is successful production output.
- [ ] Inspect the final diff and confirm unrelated working-tree edits remain untouched.

### Task 6: Build And Smoke-Test The Portable Artifact

- [ ] Run `npm run pack:win:portable:x64` after the complete production build.
- [ ] Resolve the emitted portable executable path and verify its file size and timestamp.
- [ ] Launch the portable executable with an isolated temporary data directory, wait for stable process startup, and verify no immediate crash or fatal log.
- [ ] Close only the verification process and report the absolute artifact path and SHA-256 hash.

