# QQ Music Personalized Home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the QQ Music recommendation page shown in the supplied references using authenticated QQ home-feed data and produce a verified Windows x64 portable executable.

**Architecture:** A new main-process service requests and merges the two captured `RecommendFeed` pages, then batch-enriches its grouped song cards through `CgiGetTrackInfo`. A renderer composable owns account-scoped data, and dedicated QQ sections reuse the existing QQ Daily 30, Guess You Like, song-list detail, and temporary-list playback contracts.

**Tech Stack:** Electron 37, Vue 3 Composition API, TypeScript, Less CSS Modules, Node `assert` tests, webpack, electron-builder.

---

## File Map

- Create `src/main/modules/qqMusic/homeRecommend.ts`: authenticated home-feed request, track enrichment, and response normalization.
- Modify `src/main/modules/qqMusic/index.ts`: account-facade ownership and auth-expiry cleanup.
- Modify `src/common/types/qq_music.d.ts`: normalized home recommendation types.
- Modify `src/common/ipcNames.ts`, `src/main/modules/winMain/rendererEvent/qqMusic.ts`, and `src/renderer/utils/ipc.ts`: typed IPC contract.
- Create `src/renderer/views/QQRecommend/useQQHomeRecommendData.ts`: account cache, request revision, loading, refresh, and error state.
- Create `src/renderer/views/QQRecommend/useQQHomeRecommendPlayback.ts`: playlist routing/playback and related-song temporary-list playback.
- Create `src/renderer/views/QQRecommend/components/QQFeaturedSection.vue`: Guess You Like lead card, Daily 30, and supported feed cards.
- Create `src/renderer/views/QQRecommend/components/QQPlaylistSection.vue`: horizontal private/guide playlist section with edge controls.
- Create `src/renderer/views/QQRecommend/components/QQRelatedSongsSection.vue`: three-column song grid with wrapping left/right batch controls.
- Modify `src/renderer/views/QQRecommend/index.vue`: page orchestration, account lifecycle, refresh, and responsive composition.
- Create `scripts/test-qq-music-home-recommend.js`: request and normalization behavior tests.
- Create `scripts/test-qq-music-home-renderer.js`: renderer contract and interaction tests.

### Task 1: Add Failing Main-Process Tests

- [x] Create fixtures containing hero, private-playlist, grouped-song, exact guide, and AI-guide-fallback shelves.
- [x] Assert the first two requests use `music.recommend.RecommendFeed/get_recommend_feed` with the captured desktop comm fields and page parameters.
- [x] Assert the third request uses `music.trackInfo.UniformRuleCtrl/CgiGetTrackInfo` with all song IDs once and `source=AiNoFree`.
- [x] Assert normalized playlists, formatted titles, grouped playable songs, malformed-card filtering, auth errors, and timeout cleanup.
- [x] Run `node scripts/test-qq-music-home-recommend.js`; expected result is a module-not-found failure for `homeRecommend.ts`.

### Task 2: Implement The Service And IPC

- [x] Add normalized types for playlists and home sections in `qq_music.d.ts`.
- [x] Implement `createQQMusicHomeRecommendService({ fetchImpl, getCookie })` and export pure normalizers for fixture tests.
- [x] Inject the service into `createQQMusicAccountService`; on `QQMusicAuthError`, clear the account and rethrow.
- [x] Add `qq_music_get_home_recommend` to common IPC names, the main handler, and renderer wrapper.
- [x] Run `node scripts/test-qq-music-home-recommend.js`, `node scripts/test-qq-music-account.js`, and `node scripts/test-qq-music-ipc.js`; expected result is PASS for all three.

### Task 3: Add Failing Renderer Tests

- [x] Assert the data composable caches by account, force-refreshes, rejects stale account responses, and retains same-account data on refresh failure.
- [x] Assert the playback composable routes QQ playlists with `source: 'tx'`, installs related-song groups under a dedicated temporary-list ID, and toggles play/pause.
- [x] Assert the page renders the four requested section labels and the related-song component exposes both arrow controls.
- [x] Run `node scripts/test-qq-music-home-renderer.js`; expected result is failure because the new composables and components do not exist.

### Task 4: Build The QQ Home Page

- [x] Implement account-scoped home loading and merge it with the existing Daily 30 and Guess You Like states.
- [x] Implement the feature strip with Guess You Like first, Daily 30 second, and supported feed cards after them.
- [x] Implement private and guide playlist carousels with deterministic card widths and edge scrolling.
- [x] Implement grouped related songs with a wrapping page index, title from QQ's template/content fields, play-all, song click, current-song state, and left/right arrows.
- [x] Add stable loading, empty, error, retry, signed-out, and narrow-window states.
- [x] Run `node scripts/test-qq-music-home-renderer.js`; expected result is PASS.

### Task 5: Regression And Production Verification

- [x] Run all `scripts/test-qq-music-*.js` and `scripts/test-provider-recommend-pages.js`; expected result is PASS.
- [x] Run `npx tsc -p src/common --noEmit`, `npx tsc -p src/main --noEmit`, and `npx tsc -p src/renderer --noEmit`; expected result is no diagnostics.
- [x] Run ESLint on all QQ recommendation files changed by this plan; expected result is no errors.
- [x] Run `npm run build:main`, `npm run build:renderer`, and `npm run build`; expected result is successful production output.
- [x] Inspect the final diff and confirm unrelated working-tree edits remain untouched.

### Task 6: Build And Smoke-Test The Portable Artifact

- [x] Run `npm run pack:win:portable:x64` after the complete production build.
- [x] Resolve the emitted portable executable path and verify its file size and timestamp.
- [x] Launch the portable executable with an isolated temporary data directory, wait for stable process startup, and verify no immediate crash or fatal log.
- [x] Close only the verification process and report the absolute artifact path and SHA-256 hash.

### Task 7: Fix Live Feed Authentication And Shelf Experiments

**Files:**
- Modify: `src/main/modules/qqMusic/homeRecommend.ts`
- Modify: `scripts/test-qq-music-home-recommend.js`
- Modify: `docs/superpowers/specs/2026-07-25-qq-personalized-home-design.md`

- [x] **Step 1: Reproduce the signed-request failure against the live account**

  Send the exact serialized `RecommendFeed` body once without `sign` and once with `createQQMusicRequestSign(body)`. Confirm the unsigned request returns QQ code `2000` and the signed request returns QQ code `0` with shelf IDs `301`, `271`, `272`, and `207`.

- [x] **Step 2: Add and verify request-signing coverage**

  Make the request test assert that every `musics.fcg` URL contains a non-empty `sign` and that the string passed to the signer is byte-for-byte identical to the transmitted body. Run `node scripts/test-qq-music-home-recommend.js`; before the implementation the assertion must fail because `sign` is absent.

- [x] **Step 3: Sign the exact transmitted body**

  Serialize the body once, call `createQQMusicRequestSign(requestBody)`, append the result as the `sign` query parameter, and transmit the same `requestBody` string.

- [x] **Step 4: Add and verify a live-title shelf-selection regression test**

  Add a fixture whose `id=271` shelf title is `你的歌单补给站`, normalize it, and assert that all valid playlist cards appear in `privatePlaylists`. Run `node scripts/test-qq-music-home-recommend.js`; it must fail with an empty `privatePlaylists` array before the fix.

- [x] **Step 5: Select the private shelf by stable ID fallback**

  Keep the semantic title match and add `shelves.find(shelf => shelf.id == 271)` as the fallback. Do not expose opaque identifiers that the existing QQ playlist-detail endpoint cannot resolve.

- [x] **Step 6: Verify the live normalized result and rebuild**

  Run the service with the stored QQ account while logging counts only. Require non-zero featured playlists, private playlists, related songs, and guide playlists; then run the QQ regression suite, TypeScript checks, ESLint, `npm run build`, and `npm run pack:win:portable:x64` before smoke-testing the portable executable.

- [x] **Step 7: Apply completion-review compatibility fixes**

  Add deterministic UID/GUID fallbacks for browser-login cookies, select the renamed guide shelf by stable `id=205`, and guard card-level Enter/Space handlers with `.self` so nested play buttons do not also open the playlist. Cover all three behaviors in the home service and renderer regression scripts.

- [x] **Step 8: Rebuild and repeat artifact verification**

  Re-run the QQ/provider tests, three TypeScript projects, changed-file ESLint, production build, Windows x64 portable packaging, live-account count check, and packaged-app UI/smoke verification after the review fixes.

### Task 8: Add QQ Immersive Brush Mode And Remove Duplicate Daily 30

**Files:**
- Modify: `src/main/modules/qqMusic/homeRecommend.ts`
- Modify: `src/main/modules/qqMusic/song.ts`
- Modify: `src/common/types/qq_music.d.ts`
- Create: `src/renderer/store/qqBrushMode/state.ts`
- Create: `src/renderer/store/qqBrushMode/action.ts`
- Create: `src/renderer/views/QQRecommend/useQQBrushModeData.ts`
- Create: `src/renderer/views/QQRecommend/useQQBrushModeCard.ts`
- Create: `src/renderer/views/QQRecommend/useQQBrushModePlayback.ts`
- Modify: `src/renderer/views/QQRecommend/index.vue`
- Modify: `src/renderer/core/useApp/usePlayer/usePlayer.ts`
- Modify: `src/renderer/store/qqMusic.ts`
- Modify: `src/renderer/views/Recommend/constants.ts`
- Modify: `src/renderer/views/Recommend/types.ts`
- Modify: `scripts/test-qq-music-home-recommend.js`
- Create: `scripts/test-qq-music-brush-mode.js`

- [x] **Step 1: Add failing Feed normalization assertions**

  Assert `type=700, id=99` becomes the Brush Mode descriptor and `type=500, id=0` never appears in `featuredPlaylists`.

- [x] **Step 2: Add failing independent-queue tests**

  Assert Brush Mode uses its own card/list IDs, lazily requests five radio tracks, starts its own temporary list, appends a deduplicated continuation batch near the queue tail, and does not import or mutate the Guess You Like store.

- [x] **Step 3: Implement the captured radio request and renderer session**

  Send the QQ desktop `id=99, num=5` request for Brush Mode, create account-scoped queue state with stale-response rejection and single-flight continuation, and wire the global player guard.

- [x] **Step 4: Put Brush Mode in the first row**

  Render cards in the stable order Guess You Like, Daily 30, Brush Mode, then at most two ordinary Feed playlists. Reuse the feature-card layout, controls, and active state.

### Task 9: Rebuild And Verify The Final Portable Artifact

- [x] Re-run all QQ/provider tests, three TypeScript projects, and changed-file ESLint.
- [x] Run the production build and Windows x64 portable packaging from the final sources.
- [x] Verify live Home Feed counts, one Daily 30 card, Brush Mode start/continuation, carousel navigation, and no recommendation error banner.
- [x] Launch the packaged executable with isolated portable data, confirm stable startup, close only the verification process, and report its size, timestamp, and SHA-256.

### Final Verification Record

- `16/16` QQ Music and provider recommendation regression scripts passed.
- `src/common`, `src/main`, and `src/renderer` TypeScript projects passed with no diagnostics.
- ESLint passed for all 25 changed TypeScript and Vue source files.
- Live QQ data returned 2 featured playlists, 12 private playlists, 12 related-song groups / 36 songs, 12 guide playlists, and 5 Brush Mode songs; duplicate Daily 30 Feed cards: 0.
- `npm run build` and `npm run pack:win:portable:x64` completed successfully.
- The final NSIS archive passed `7z t`; isolated startup remained stable for 20 seconds with no fatal/error log match.
- Artifact: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` (`101607399` bytes, SHA-256 `5E467E0E9A859024DFF6B5158C715D9BFA2F62FB80B30F0ADF050F1EC074BC9A`).

### Task 10: Make Radio Cards Follow Their Current Song

**Files:**
- Modify: `scripts/test-qq-music-home-renderer.js`
- Modify: `src/renderer/views/QQRecommend/useQQGuessLikeCard.ts`
- Modify: `src/renderer/views/QQRecommend/useQQBrushModeCard.ts`
- Modify: `src/renderer/views/QQRecommend/index.vue`

- [x] **Step 1: Add failing card-state tests**

  Load both card composables with Vue refs. Assert that `currentSong` overrides the queue preview for `img`, `author`, `desc`, and `total`, then set `currentSong.value = null` and assert the card falls back to the first queued song. Assert the QQ page includes `loadQQBrushModeSongs` in `loadAll`.

- [x] **Step 2: Run the renderer test and verify RED**

  Run `node scripts/test-qq-music-home-renderer.js`. Expected: FAIL because neither card composable accepts `currentSong`, and Brush Mode is not loaded by `loadAll`.

- [x] **Step 3: Bind each card to its owned active list**

  Add a `currentSong` ref parameter to both card composables and select `currentSong.value ?? songs.value[0]`. In `index.vue`, compute the current Guess You Like and Brush Mode song only when the matching `isQQ*ListActive(accountKey.value)` guard is true, pass those refs into the card composables, and add `loadQQBrushModeSongs(force)` to `loadAll`.

- [x] **Step 4: Run focused and full verification**

  Run `node scripts/test-qq-music-home-renderer.js`, all `scripts/test-qq-music-*.js`, `scripts/test-provider-recommend-pages.js`, the three TypeScript projects, changed-file ESLint, `npm run build`, and `npm run pack:win:portable:x64`.

- [x] **Step 5: Verify the packaged UI**

  Start the final build with the existing QQ account, confirm both radio cards initially show fetched song metadata, switch songs in Guess You Like and Brush Mode, and verify each matching card updates its cover and `歌曲名 · 歌手` without changing the other card.

### Task 10 Verification Record

- Guess You Like changed from `Promise · 山冈晃` to `you are my curse · nyamura`; both the card cover and supporting line changed with the player.
- Brush Mode changed from `多想留在你身边 · 刘增瞳` to `恋の宅配便(feat. AZKi) · 瀬名航、AZKi`; both the card cover and supporting line changed with the player.
- The QQ page preloaded a five-song Brush Mode preview, so the card showed real song metadata before activation.
- `16/16` QQ Music and provider recommendation tests, all three TypeScript projects, and ESLint for 26 changed TypeScript/Vue files passed.
- `npm run build` and `npm run pack:win:portable:x64` completed successfully; `7z t` reported `Everything is Ok`.
- The final portable build remained stable for 15 seconds with seven related processes and no fatal/error log match; all seven verification processes were then closed.
- Artifact: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` (`101606252` bytes, SHA-256 `13889321D98A23FD7CDA3BC2A9892D00D325CBEF8498AF0C34431F16A6C27B03`).

### Task 11: Keep Each Radio Card On Its Last Played Song

**Files:**
- Modify: `scripts/test-qq-music-home-renderer.js`
- Create: `src/renderer/views/QQRecommend/useQQRadioCardSong.ts`
- Modify: `src/renderer/views/QQRecommend/index.vue`

- [x] **Step 1: Reproduce the reset with a failing regression test**

  Advance each mode to a later song, make the active-song ref empty as happens when another playlist starts, and assert the displayed song remains the last one reached. Also assert the two mode histories are isolated and explicit account cleanup removes the saved song.

- [x] **Step 2: Add isolated, route-persistent last-song state**

  Watch only the active song owned by each radio list, save non-null updates synchronously in module-level refs, and expose the active-or-last song to the existing card composables. Key the refs separately for Guess You Like and Brush Mode so they survive destruction and recreation of the QQ recommendation route without sharing songs.

- [x] **Step 3: Integrate account cleanup**

  Clear both saved songs from the existing `clearAll()` path so logout and account changes cannot retain another account's metadata.

- [x] **Step 4: Rebuild and verify the portable artifact**

  Run the focused regression, all QQ/provider scripts, the three TypeScript projects, changed-file ESLint, production build, Windows x64 portable packaging, archive validation, and isolated startup smoke test.

### Task 11 Verification Record

- The focused renderer regression reproduced the missing helper before implementation and passed after the fix. Guess You Like retained `guess-third` after its active-song ref became empty and after a simulated route remount, Brush Mode independently retained `brush-third`, account changes cleared both histories, and explicit cleanup remained mode-specific.
- `16/16` QQ Music and provider recommendation scripts passed; `src/common`, `src/main`, and `src/renderer` TypeScript projects completed with no diagnostics.
- Full `npm run lint` and `git diff --check` passed.
- `npm run build` and `npm run pack:win:portable:x64` completed successfully; `7z t` reported `Everything is Ok`.
- The final portable build remained stable for 15 seconds with seven related processes, one main process, 46 isolated user-data files, and no fatal/uncaught/unhandled log match. The verification process tree closed and the temporary extraction directory was removed.
- Artifact: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` (`101607846` bytes, SHA-256 `D2D68F7965A3E4D63BBF70669726589D1DB79570CB9542D7272C3F1FC18DDA9E`).

### Task 12: Stop Refreshing Recommendations On Page Re-entry

**Files:**
- Modify: `scripts/test-qq-music-home-renderer.js`
- Modify: `src/renderer/views/QQRecommend/useQQHomeRecommendData.ts`

- [x] **Step 1: Reproduce the route-lifetime cache loss**

  Create a second `useQQHomeRecommendData` instance for the same account after a successful forced refresh, call its non-forced `load()`, and assert it restores the refreshed data without increasing the IPC request count.

- [x] **Step 2: Preserve the account cache across route instances**

  Move the existing `Map<string, LX.QQMusic.HomeRecommendation>` to module scope. Keep loading, errors, request revisions, and visible data local to each route instance; keep `load(true)` as the only same-account cache replacement path.

- [x] **Step 3: Preserve account and refresh behavior**

  Continue loading automatically when no same-account cache exists or the QQ account changes. Keep the page refresh and retry buttons on `loadAll(true)` so users explicitly control recommendation replacement.

- [x] **Step 4: Verify and rebuild the portable artifact**

  Run the focused renderer regression, all QQ/provider scripts, three TypeScript projects, relevant ESLint, production build, Windows x64 portable packaging, archive validation, and isolated startup smoke test.

### Task 12 Verification Record

- The route-remount regression failed before implementation because the second composable increased the same-account IPC request count from 2 to 3, then passed with the request count remaining at 2 after the module-level cache change.
- `16/16` QQ Music and provider recommendation scripts passed; `src/common`, `src/main`, and `src/renderer` TypeScript projects completed with no diagnostics.
- ESLint passed for `useQQHomeRecommendData.ts`, and `git diff --check` reported no whitespace errors.
- `npm run build` and `npm run pack:win:portable:x64` completed successfully; `7z t` reported `Everything is Ok`.
- The final portable build remained stable for 15 seconds with seven related processes, one main process, 46 isolated user-data files, and no fatal/uncaught/unhandled log match. The verification process tree closed successfully.
- Artifact: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe` (`101607813` bytes, SHA-256 `0B952BFC7E050967D740DE8F5A140A5424E22E28F5F72555D034285D7D8B9520`).
