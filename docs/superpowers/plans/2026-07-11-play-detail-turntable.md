# Play Detail Turntable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the playback detail view around a rotating CSS turntable, a dedicated lyric column, and a stable full-width bottom control deck without changing player behavior or store contracts.

**Architecture:** Add a store-connected `Turntable.vue` leaf component for the record visual and playback animation. Keep layout state in `index.vue`, keep lyric behavior inside the existing `LyricPlayer.vue`, and reorganize existing controls in `PlayBar.vue` without adding new actions or state.

**Tech Stack:** Vue 3, Pug templates, CSS Modules, Less, existing LX Music renderer stores and SVG icon sprite.

---

### Task 1: Add The Turntable Component

**Files:**
- Create: `src/renderer/components/layout/PlayDetail/Turntable.vue`

- [ ] **Step 1: Verify the component does not exist yet**

Run:

```powershell
if (Test-Path 'src/renderer/components/layout/PlayDetail/Turntable.vue') { throw 'Turntable.vue already exists' } else { 'PASS: component is absent' }
```

Expected: `PASS: component is absent`.

- [ ] **Step 2: Create the store-connected turntable component**

Create a component with this structure:

```vue
<template lang="pug">
div(:class="$style.stage")
  div(:class="$style.tonearm" aria-hidden="true")
    span(:class="$style.pivot")
    span(:class="$style.arm")
    span(:class="$style.head")
  div(:class="$style.deck" aria-hidden="true")
    div(:class="[$style.record, { [$style.playing]: isPlay }]")
      div(:class="$style.label")
        img(v-if="musicInfo.pic" :src="musicInfo.pic" decoding="async" @error="handleImageError")
        div(v-else :class="$style.emptyPic") L<span>X</span>
        span(:class="$style.spindle")
</template>

<script setup>
import { isPlay, musicInfo } from '@renderer/store/player/state'
import { setMusicInfo } from '@renderer/store/player/action'

const handleImageError = () => {
  setMusicInfo({ pic: null })
}
</script>
```

Add CSS Module styles that:

```less
.stage { position: relative; display: flex; align-items: center; justify-content: center; min-width: 0; min-height: 0; }
.deck { width: min(78%, 430px); aspect-ratio: 1; display: grid; place-items: center; border-radius: 50%; }
.record { width: 94%; aspect-ratio: 1; border-radius: 50%; animation: recordSpin 18s linear infinite; animation-play-state: paused; }
.playing { animation-play-state: running; }
.label { position: absolute; inset: 27%; overflow: hidden; border-radius: 50%; }
@keyframes recordSpin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .record { animation: none; } }
```

Use theme variables plus neutral black groove rings. The tonearm is decorative CSS and must use `pointer-events: none`.

- [ ] **Step 3: Lint the new component**

Run:

```powershell
npx eslint src/renderer/components/layout/PlayDetail/Turntable.vue
```

Expected: exit code `0` with no errors.

- [ ] **Step 4: Commit the turntable component**

```powershell
git add src/renderer/components/layout/PlayDetail/Turntable.vue
git commit -m "feat: add rotating play detail turntable"
```

### Task 2: Recompose The Main Detail Stage

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/index.vue:3-26`
- Modify: `src/renderer/components/layout/PlayDetail/index.vue:30-63`
- Modify: `src/renderer/components/layout/PlayDetail/index.vue:142-282`
- Modify: `src/renderer/components/layout/PlayDetail/LyricPlayer.vue:199-359`

- [ ] **Step 1: Capture the current renderer build baseline**

Run:

```powershell
npm run build:renderer
```

Expected: the renderer bundle completes successfully before layout edits.

- [ ] **Step 2: Replace the flat left column with the turntable and track header**

Import and register `Turntable`, then make the main template follow this structure:

```pug
div(:class="[$style.main, {[$style.showComment]: isShowPlayComment}]")
  Turntable.turntable(:class="$style.turntable")
  section(:class="$style.lyricPanel")
    header(:class="$style.trackHeader")
      h1(:title="musicInfo.name") {{ musicInfo.name || 'LX Music' }}
      div(:class="$style.trackMeta")
        span(v-if="musicInfo.singer" :title="musicInfo.singer") {{ musicInfo.singer }}
        span(v-if="musicInfo.album" :title="musicInfo.album") {{ musicInfo.album }}
    transition(enter-active-class="animated fadeIn" leave-active-class="animated fadeOut")
      LyricPlayer(v-if="visibled")
  music-comment(v-if="visibled" :class="$style.comment" :show="isShowPlayComment" :music-info="playMusicInfo.musicInfo" @close="hideComment")
```

Use `flex: 0 0 40%` for the turntable and `flex: 1 1 60%` for the lyric panel. The lyric panel must use `min-width: 0`, `min-height: 0`, and a column layout so long metadata cannot change the page width.

- [ ] **Step 3: Implement comment, fullscreen, and narrow-window layout states**

Use explicit sizing rules:

```less
.main { display: flex; gap: clamp(18px, 3vw, 52px); margin: 0 clamp(20px, 4vw, 68px); }
.turntable { flex: 0 0 40%; transition: flex-basis @transition-normal; }
.lyricPanel { flex: 1 1 60%; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.showComment .turntable { flex-basis: 18%; }
.showComment .lyricPanel { flex: 0 0 30%; }
.comment { position: absolute; right: 0; width: calc(50% - 12px); }
@media (max-width: 900px) { .main { gap: 16px; margin-inline: 18px; } .trackMeta { gap: 8px; } }
@media (max-height: 650px) { .trackHeader { padding-bottom: 8px; } }
```

Keep the current comment transform transition and existing fullscreen class behavior.

- [ ] **Step 4: Polish lyric spacing without changing lyric logic**

Change only styles in `LyricPlayer.vue`:

```less
.right { flex: auto; min-height: 0; position: relative; }
.lyric { -webkit-mask-image: linear-gradient(transparent 0%, #fff 16%, #fff 84%, transparent 100%); }
.lyric :global(.line-content) { padding: calc(var(--playDetail-lrc-font-size, 16px) * .62) 1px; }
.lyricSpace { height: 62%; }
```

Do not change `useLyric`, event handlers, selection mode, offset behavior, or lyric store usage.

- [ ] **Step 5: Build and lint the stage changes**

Run:

```powershell
npx eslint src/renderer/components/layout/PlayDetail/index.vue src/renderer/components/layout/PlayDetail/LyricPlayer.vue src/renderer/components/layout/PlayDetail/Turntable.vue
npm run build:renderer
```

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the main stage**

```powershell
git add src/renderer/components/layout/PlayDetail/index.vue src/renderer/components/layout/PlayDetail/LyricPlayer.vue
git commit -m "feat: recompose play detail stage"
```

### Task 3: Rebuild The Bottom Control Deck

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue:1-47`
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue:74-200`
- Modify: `src/renderer/components/layout/PlayDetail/components/ControlBtns.vue:108-149`

- [ ] **Step 1: Establish the desired three-zone DOM contract**

Before editing, run:

```powershell
$source = Get-Content -Raw 'src/renderer/components/layout/PlayDetail/PlayBar.vue'
if ($source -match 'footerCenter' -or $source -match 'footerRight') { throw 'New control deck already present' } else { 'PASS: old control deck confirmed' }
```

Expected: `PASS: old control deck confirmed`.

- [ ] **Step 2: Move progress to the deck edge and center transport controls**

Use this hierarchy:

```vue
<div :class="$style.footer">
  <div :class="$style.progressTrack">
    <common-progress-bar
      :class-name="$style.progress"
      :progress="progress"
      :handle-transition-end="handleTransitionEnd"
      :is-active-transition="isActiveTransition"
    />
  </div>
  <div :class="$style.footerLeft">
    <span :class="$style.status">{{ status }}</span>
    <span :class="$style.time">{{ nowPlayTimeStr }} / {{ maxPlayTimeStr }}</span>
  </div>
  <div :class="$style.footerCenter">
    <button type="button" :class="[$style.playBtn, { [$style.playBtnActive]: isShowPlayQueue }]" :aria-label="$t('player__play_queue')" @click="isShowPlayQueue = !isShowPlayQueue">
      <svg viewBox="0 0 24 24"><use xlink:href="#icon-play-queue" /></svg>
    </button>
    <button type="button" :class="$style.playBtn" :aria-label="$t('player__prev')" @click="playPrev()">
      <svg viewBox="0 0 1024 1024"><use xlink:href="#icon-prevMusic" /></svg>
    </button>
    <button type="button" :class="[$style.playBtn, $style.playBtnPrimary]" :aria-label="isPlay ? $t('player__pause') : $t('player__play')" @click="togglePlay">
      <svg v-if="isPlay" viewBox="0 0 1024 1024"><use xlink:href="#icon-pause" /></svg>
      <svg v-else viewBox="0 0 1024 1024"><use xlink:href="#icon-play" /></svg>
    </button>
    <button type="button" :class="$style.playBtn" :aria-label="$t('player__next')" @click="playNext()">
      <svg viewBox="0 0 1024 1024"><use xlink:href="#icon-nextMusic" /></svg>
    </button>
  </div>
  <div :class="$style.footerRight">
    <control-btns />
    <button type="button" :class="[$style.partyBtn, {[$style.partyBtnActive]: !!party.room}]" @click="party.isShowModal = true">
      <span :class="$style.partyDot" />
      <span>{{ party.room ? `Room ${party.room.roomCode}` : 'Party' }}</span>
    </button>
  </div>
  <play-queue v-model:show="isShowPlayQueue" />
</div>
```

Preserve every existing action and `aria-label`. Replace clickable transport `div` elements with semantic `button` elements.

- [ ] **Step 3: Add a stable grid layout and compact fallbacks**

```less
.footer { position: relative; flex: 0 0 92px; display: grid; grid-template-columns: minmax(180px, 1fr) auto minmax(180px, 1fr); align-items: center; gap: 20px; padding: 12px 28px 8px; }
.progressTrack { position: absolute; inset: 0 0 auto; height: 12px; padding-top: 5px; }
.footerCenter { display: flex; align-items: center; justify-content: center; gap: 12px; }
.footerRight { display: flex; align-items: center; justify-content: flex-end; gap: 14px; min-width: 0; }
.playBtn { width: 34px; height: 34px; border: 0; background: transparent; color: var(--color-button-font); }
.playBtnPrimary { width: 46px; height: 46px; border-radius: 50%; background: var(--color-primary-alpha-200); }
@media (max-width: 900px) { .footer { grid-template-columns: minmax(120px, 1fr) auto minmax(120px, 1fr); padding-inline: 18px; } .partyBtn span:last-child { display: none; } }
```

Use `var(--color-surface-background)` when available through the current theme and keep a readable non-blur fallback.

- [ ] **Step 4: Normalize secondary action hit areas**

Update `ControlBtns.vue` styles so each action remains a 28 by 28 pixel stable target, uses current-color icons, and has visible hover and focus-visible feedback. Do not change control order or behavior.

- [ ] **Step 5: Lint and build the control deck**

Run:

```powershell
npx eslint src/renderer/components/layout/PlayDetail/PlayBar.vue src/renderer/components/layout/PlayDetail/components/ControlBtns.vue
npm run build:renderer
```

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the control deck**

```powershell
git add src/renderer/components/layout/PlayDetail/PlayBar.vue src/renderer/components/layout/PlayDetail/components/ControlBtns.vue
git commit -m "feat: rebuild play detail controls"
```

### Task 4: Visual And Behavioral Verification

**Files:**
- Verify: `src/renderer/components/layout/PlayDetail/Turntable.vue`
- Verify: `src/renderer/components/layout/PlayDetail/index.vue`
- Verify: `src/renderer/components/layout/PlayDetail/LyricPlayer.vue`
- Verify: `src/renderer/components/layout/PlayDetail/PlayBar.vue`
- Verify: `src/renderer/components/layout/PlayDetail/components/ControlBtns.vue`

- [ ] **Step 1: Run focused static checks**

```powershell
npx eslint src/renderer/components/layout/PlayDetail/Turntable.vue src/renderer/components/layout/PlayDetail/index.vue src/renderer/components/layout/PlayDetail/LyricPlayer.vue src/renderer/components/layout/PlayDetail/PlayBar.vue src/renderer/components/layout/PlayDetail/components/ControlBtns.vue
git diff --check
```

Expected: exit code `0` for both commands.

- [ ] **Step 2: Run the production renderer build**

```powershell
npm run build:renderer
```

Expected: webpack completes the renderer bundle with no errors.

- [ ] **Step 3: Start the development app**

```powershell
npm run dev
```

Expected: the Electron app opens with the renderer connected.

- [ ] **Step 4: Verify playback states visually**

Check these states in the running app:

```text
playing: record rotates continuously
paused: record stops at its current angle
resumed: record continues from the paused angle
missing cover: LX fallback remains centered inside the record
reduced motion: record does not rotate
```

- [ ] **Step 5: Verify layout and interactions visually**

Check normal, comments-open, fullscreen, 900px-wide, and minimum-height states in both light and dark themes. Exercise lyric scrolling, selection, context menu, progress seek, previous, play/pause, next, queue, party modal, desktop lyric, visualization, sound effect, playback rate, volume, play mode, and add-to-list.

- [ ] **Step 6: Commit verification fixes**

If verification requires corrections, stage only the five playback detail files and commit:

```powershell
git add src/renderer/components/layout/PlayDetail/Turntable.vue src/renderer/components/layout/PlayDetail/index.vue src/renderer/components/layout/PlayDetail/LyricPlayer.vue src/renderer/components/layout/PlayDetail/PlayBar.vue src/renderer/components/layout/PlayDetail/components/ControlBtns.vue
git commit -m "fix: polish play detail layout"
```
