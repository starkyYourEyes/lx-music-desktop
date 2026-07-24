# QQ Music Recommend Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated QQ Music recommendation destination and move Guess You Like out of the NetEase recommendation page.

**Architecture:** Keep the existing NetEase page and reusable recommendation primitives, then add a focused QQ page that owns QQ login, loading, and playback lifecycle. Use local provider logo assets in the sidebar and a source-wiring regression test to protect route/page ownership across the Vue SFC boundary.

**Tech Stack:** Vue 3 SFC, TypeScript, Vue Router, Less CSS Modules, Node assert tests, SVG assets.

---

### Task 1: Add The Failing Navigation And Ownership Test

**Files:**
- Create: `scripts/test-provider-recommend-pages.js`

- [ ] **Step 1: Write assertions for `/qq-recommend`, route ownership, provider ordering, local logo assets, QQ account routing, QQ auto-load, card metadata, and obsolete-setting removal.**
- [ ] **Step 2: Run `node scripts/test-provider-recommend-pages.js` and verify it fails because the QQ route/page and logo assets do not exist.**

### Task 2: Add Provider Navigation

**Files:**
- Create: `src/renderer/assets/images/providers/netease-music.svg`
- Create: `src/renderer/assets/images/providers/qq-music.svg`
- Modify: `src/renderer/components/layout/Aside/NavBar.vue`
- Modify: `src/renderer/components/layout/Aside/index.vue`
- Modify: `src/renderer/router.ts`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`

- [ ] **Step 1: Add the two bundled colored logo files.**
- [ ] **Step 2: Render image-backed provider nav items before the separator and retain sprite icons for other destinations.**
- [ ] **Step 3: Add the QQ route and redirect QQ account-popover login requests to it.**
- [ ] **Step 4: Add localized provider navigation labels.**

### Task 3: Split The QQ Page From NetEase

**Files:**
- Create: `src/renderer/views/QQRecommend/index.vue`
- Create: `src/renderer/views/QQRecommend/useQQGuessLikeCard.ts`
- Modify: `src/renderer/views/Recommend/index.vue`
- Modify: `src/renderer/views/Recommend/useRecommendCards.ts`
- Modify: `src/renderer/views/Recommend/useRecommendPlayback.ts`

- [ ] **Step 1: Add a QQ card builder that maps the first song to cover and `name · singer` metadata and exposes loading/error/empty text.**
- [ ] **Step 2: Build the QQ page with signed-out login entry, QR panel, account initialization, automatic cached loading, account-change cleanup, and existing playlist playback.**
- [ ] **Step 3: Remove QQ data, login, card, account watchers, and event listeners from the NetEase page.**
- [ ] **Step 4: Keep shared playback support for the QQ card while removing the unused QQ argument declaration.**

### Task 4: Clean Up Settings

**Files:**
- Modify: `src/common/defaultSetting.ts`
- Modify: `src/common/types/app_setting.d.ts`
- Modify: `src/renderer/views/Setting/components/SettingRecommend.vue`
- Modify: `src/lang/zh-cn.json`
- Modify: `src/lang/zh-tw.json`
- Modify: `src/lang/en-us.json`

- [ ] **Step 1: Remove the logged-out visibility setting from defaults, types, and UI.**
- [ ] **Step 2: Rename the remaining setting section to NetEase Music recommendations in all three languages.**

### Task 5: Verify The Feature

- [ ] **Step 1: Run `node scripts/test-provider-recommend-pages.js` and verify all assertions pass.**
- [ ] **Step 2: Run renderer and common TypeScript checks and resolve errors introduced by this change.**
- [ ] **Step 3: Run ESLint on all changed source files and resolve new violations.**
- [ ] **Step 4: Run `npm run build:renderer` and verify the production bundle succeeds.**
- [ ] **Step 5: Inspect the final diff to confirm unrelated working-tree changes were preserved.**
