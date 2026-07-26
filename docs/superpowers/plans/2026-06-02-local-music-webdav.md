# Local Music WebDAV Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local music library page with folder scanning and WebDAV conversion for list additions.

**Architecture:** Add main-process scan/upload IPC, renderer-side local music state/page, settings for local folders, and a list-add conversion hook that replaces local music with WebDAV music before writing to normal user lists.

**Tech Stack:** Electron main/renderer IPC, Vue 3, TypeScript/JavaScript, WebDAV over `undici`, `music-metadata`.

---

### Task 1: Add Local WebDAV Path Helpers

**Files:**
- Create: `src/common/utils/localMusicWebdav.js`
- Create: `scripts/test-local-music-webdav.js`

- [ ] Write a Node test covering safe filename generation and WebDAV relative path normalization.
- [ ] Run the test and verify it fails before the helper exists.
- [ ] Add the helper implementation.
- [ ] Re-run the test and verify it passes.

### Task 2: Add Main-Process Local Music Scan And Upload IPC

**Files:**
- Create: `src/main/modules/localMusic.ts`
- Modify: `src/main/modules/webdav.ts`
- Modify: `src/main/modules/winMain/rendererEvent/index.ts`
- Create: `src/main/modules/winMain/rendererEvent/localMusic.ts`
- Modify: `src/common/ipcNames.ts`
- Modify: `src/renderer/utils/ipc.ts`
- Modify: `src/common/types/music.d.ts`

- [ ] Add scan IPC returning `LX.Music.MusicInfoLocal[]`.
- [ ] Add upload IPC returning `LX.Music.MusicInfoWebDAV`.
- [ ] Implement WebDAV PUT upload with configured credentials.

### Task 3: Add Settings

**Files:**
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/common/types/app_setting.d.ts`
- Modify: `src/renderer/views/Setting/components/SettingOther.vue`

- [ ] Add `localMusic.dirs` and `localMusic.webdavDir`.
- [ ] Add UI to add/remove local music folders.
- [ ] Add UI to configure WebDAV upload subdirectory.

### Task 4: Add Renderer Store And Local Music Page

**Files:**
- Create: `src/renderer/store/localMusic/state.ts`
- Create: `src/renderer/store/localMusic/action.ts`
- Create: `src/renderer/views/LocalMusic/index.vue`
- Modify: `src/renderer/router.ts`
- Modify: `src/renderer/components/layout/Aside/NavBar.vue`
- Modify: `src/renderer/components/layout/Icons.vue`

- [ ] Add local list state and scan/upload actions.
- [ ] Add page with refresh, empty state, list display, local playback, add-to-list, and upload action.
- [ ] Add sidebar route and icon.

### Task 5: Convert Local Songs On Add-To-List

**Files:**
- Modify: `src/renderer/store/list/action.ts`
- Modify: `src/renderer/components/common/ListAddModal.vue`
- Modify: `src/renderer/components/common/ListAddMultipleModal.vue`

- [ ] Convert local songs to WebDAV songs before writing normal user lists.
- [ ] Show add failures in list-add modals.
- [ ] Keep temp playback and play-later local-only paths unchanged.

### Task 6: Verify

**Commands:**
- `node scripts/test-local-music-webdav.js`
- `npm run build`

- [ ] Confirm helper test passes.
- [ ] Confirm production build succeeds or report exact failures.
