# Play Detail Vinyl And Progress Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enlarge the play-detail vinyl label, replace the footer's status/time block with song and singer plus the homepage favorite control, and add a live progress marker with a current-time tooltip.

**Architecture:** Keep player state, time updates, seeking, and favorite mutations in their existing stores and components. Make the vinyl change in `Turntable.vue`, compose the existing homepage favorite control into the detail footer, and add detail-only marker and tooltip presentation around the unchanged shared progress bar. Extend the existing structural regression test before implementation, then verify the renderer and the Windows x64 portable package.

**Tech Stack:** Vue 3 Composition API, Less CSS modules, existing LX player stores and controls, Node.js assertions, ESLint, Webpack, Electron Builder.

---

## File Structure

- Modify `scripts/test-play-detail-refinement.js`: extend the existing structural contract for the new label proportion, footer metadata/favorite composition, and progress marker/tooltip behavior.
- Modify `src/renderer/components/layout/PlayDetail/Turntable.vue`: change only the center-label inset from 27 percent to 19 percent.
- Modify `src/renderer/components/layout/PlayDetail/PlayBar.vue`: render track metadata and the reused homepage favorite control, expose a clamped reactive progress position, and style the detail-only marker and tooltip.
- Generate `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`: final Windows x64 portable artifact.

### Task 1: Extend the play-detail regression contract

**Files:**
- Modify: `scripts/test-play-detail-refinement.js:153-259`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Add the vinyl label contract**

Immediately after the existing `turntableStyle`, `playDetailStyle`, and `playBarStyle` declarations, add:

```js
const recordLabel = getDirectDeclarations(getRule(turntableStyle, '.label'))
expectDeclaration(
  recordLabel,
  'inset',
  '19%',
  'Record center label should use the approved 62 percent diameter',
)
```

- [ ] **Step 2: Add the footer metadata and favorite contracts**

After the existing `.progressTrack` size assertions, add:

```js
assert.match(
  playBar,
  /import PlayerControlBtns from '\.\.\/PlayBar\/ControlBtns\.vue'/,
  'Play detail should reuse the homepage player controls for favorite state',
)
assert.match(
  playBar,
  /\{\{ musicInfo\.name \|\| 'LX Music' \}\}/,
  'Footer should show the current song name',
)
assert.match(
  playBar,
  /\{\{ musicInfo\.singer \|\| statusText \}\}/,
  'Footer should show the current singer',
)
assert.match(
  playBar,
  /<player-control-btns show-favorite :show-add-to="false" :show-lyric="false" :show-volume="false" :show-play-mode="false" compact\s*\/>/,
  'Favorite control should sit beside the footer track information',
)
assert.doesNotMatch(
  playBar,
  /:class="\$style\.(?:status|time)"/,
  'Footer should no longer render playback status or time in the left column',
)

const footerLeft = getDirectDeclarations(getRule(playBarStyle, '.footerLeft'))
expectDeclaration(footerLeft, 'flex-direction', 'row', 'Footer track and favorite control should share one row')
expectDeclaration(footerLeft, 'align-items', 'center', 'Footer track and favorite control should align vertically')

const trackInfo = getDirectDeclarations(getRule(playBarStyle, '.trackInfo'))
expectDeclaration(trackInfo, 'min-width', '0', 'Footer track information should be allowed to shrink')
expectDeclaration(trackInfo, 'overflow', 'hidden', 'Footer track information should not overlap controls')
```

- [ ] **Step 3: Add the progress marker and tooltip contracts**

Immediately after the footer metadata assertions, add:

```js
assert.match(
  playBar,
  /const progressPosition = computed\(\(\) => `\$\{Math\.min\(Math\.max\(progress\.value \|\| 0, 0\), 1\) \* 100\}%`\)/,
  'Progress marker position should react to the existing player progress ref',
)
assert.match(
  playBar,
  /:style="\{ '--progress-position': progressPosition \}"/,
  'Progress track should expose the reactive marker position to CSS',
)
assert.match(
  playBar,
  /\{\{ nowPlayTimeStr \}\} \/ \{\{ maxPlayTimeStr \}\}/,
  'Progress tooltip should show current time and total duration',
)

const progressMarker = getDirectDeclarations(getRule(playBarStyle, '.progressMarker'))
expectDeclaration(progressMarker, 'left', 'var(--progress-position)', 'Marker should follow current playback progress')
expectDeclaration(progressMarker, 'pointer-events', 'none', 'Marker should not block seeking')

const progressTooltip = getDirectDeclarations(getRule(playBarStyle, '.progressTooltip'))
expectDeclaration(
  progressTooltip,
  'left',
  'clamp(50px, var(--progress-position), calc(100% - 50px))',
  'Tooltip should stay within the footer edges',
)
expectDeclaration(progressTooltip, 'opacity', '0', 'Tooltip should be hidden until hover')
expectDeclaration(progressTooltip, 'pointer-events', 'none', 'Tooltip should not block seeking')

const hoverTooltip = getDirectDeclarations(getRule(playBarStyle, '.progressTrack:hover .progressTooltip'))
expectDeclaration(hoverTooltip, 'visibility', 'visible', 'Hovering the progress track should reveal the tooltip')
expectDeclaration(hoverTooltip, 'opacity', '1', 'Hovering the progress track should fade in the tooltip')
```

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
node scripts/test-play-detail-refinement.js
```

Expected: exit code 1 with `Record center label should use the approved 62 percent diameter`; the existing refinement assertions still pass up to that point.

- [ ] **Step 5: Commit the failing contract**

```powershell
git add -- scripts/test-play-detail-refinement.js
git commit -m "test: define play detail progress refinement"
```

### Task 2: Enlarge the vinyl center label

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/Turntable.vue:86-94`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Apply the approved option A proportion**

Change only the `.label` inset:

```less
.label {
  position: absolute;
  inset: 19%;
  overflow: hidden;
  border-radius: 50%;
  background: var(--color-primary-light-900-alpha-700);
  box-shadow:
    0 0 0 5px rgba(0, 0, 0, .3),
    inset 0 0 18px rgba(0, 0, 0, .16);
}
```

- [ ] **Step 2: Run the test and verify the next failure**

Run:

```powershell
node scripts/test-play-detail-refinement.js
```

Expected: the label assertion passes, then the test fails with `Play detail should reuse the homepage player controls for favorite state`.

- [ ] **Step 3: Commit the vinyl change**

```powershell
git add -- src/renderer/components/layout/PlayDetail/Turntable.vue
git commit -m "fix: enlarge play detail record label"
```

### Task 3: Replace the footer status block with track information and favorite

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue:1-68`
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue:109-132`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Replace the footer-left template**

Replace the existing `footerLeft` contents with:

```vue
<div :class="$style.footerLeft">
  <div :class="$style.trackInfo">
    <span :class="$style.trackTitle">{{ musicInfo.name || 'LX Music' }}</span>
    <span :class="$style.trackSinger">{{ musicInfo.singer || statusText }}</span>
  </div>
  <player-control-btns show-favorite :show-add-to="false" :show-lyric="false" :show-volume="false" :show-play-mode="false" compact />
</div>
```

Do not add a cover-art element. Keep `<control-btns />` in `footerRight` so all detail-specific tools remain available.

- [ ] **Step 2: Reuse the homepage favorite component and metadata state**

Update the imports to:

```js
import { ref } from '@common/utils/vueTools'
import { playNext, playPrev, togglePlay } from '@renderer/core/player'
import { party } from '@renderer/store/party'
import { isPlay, musicInfo, statusText } from '@renderer/store/player/state'
import usePlayProgress from '@renderer/utils/compositions/usePlayProgress'

import ControlBtns from './components/ControlBtns.vue'
import PlayerControlBtns from '../PlayBar/ControlBtns.vue'
import PlayQueue from '../PlayQueue.vue'
```

This removes the unused `status` import and leaves all favorite mutation and rollback behavior inside `PlayerControlBtns`.

- [ ] **Step 3: Replace the left-column styles**

Replace `.footerLeft`, `.status`, and `.time` with:

```less
.footerLeft {
  min-width: 0;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  overflow: hidden;
}

.trackInfo {
  flex: 0 1 260px;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow: hidden;
}

.trackTitle,
.trackSinger {
  overflow: hidden;
  line-height: 1.35;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trackTitle {
  color: var(--color-font);
  font-size: 13px;
}

.trackSinger {
  color: var(--color-font-label);
  font-size: 12px;
}
```

- [ ] **Step 4: Run the test and verify the progress failure**

Run:

```powershell
node scripts/test-play-detail-refinement.js
```

Expected: label and footer/favorite assertions pass, then the test fails with `Progress marker position should react to the existing player progress ref`.

- [ ] **Step 5: Run focused lint**

Run:

```powershell
npx eslint "src/renderer/components/layout/PlayDetail/PlayBar.vue"
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 6: Commit the footer information change**

```powershell
git add -- src/renderer/components/layout/PlayDetail/PlayBar.vue
git commit -m "feat: show track favorite in detail footer"
```

### Task 4: Add the live marker and current-time hover tooltip

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue:1-68`
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue:96-108`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Render the marker and tooltip without changing the shared progress bar**

Replace the opening progress-track block with:

```vue
<div :class="$style.progressTrack" :style="{ '--progress-position': progressPosition }">
  <common-progress-bar
    :class-name="$style.progress"
    :progress="progress"
    :handle-transition-end="handleTransitionEnd"
    :is-active-transition="isActiveTransition"
  />
  <span :class="$style.progressMarker" aria-hidden="true" />
  <span :class="$style.progressTooltip" aria-hidden="true">{{ nowPlayTimeStr }} / {{ maxPlayTimeStr }}</span>
</div>
```

- [ ] **Step 2: Derive a safe CSS percentage from the existing progress ref**

Change the Vue tools import and add the computed value after `usePlayProgress()`:

```js
import { computed, ref } from '@common/utils/vueTools'
```

```js
const progressPosition = computed(() => `${Math.min(Math.max(progress.value || 0, 0), 1) * 100}%`)
```

Return exposure is automatic in `<script setup>`. Do not add an interval; `progress` already updates through the player `timeupdate` event.

- [ ] **Step 3: Add detail-only marker and tooltip styling**

Keep the existing `.progressTrack` dimensions and add the custom property:

```less
.progressTrack {
  --progress-position: 0%;
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 10px;
  padding-top: 4px;
}
```

After `.progress`, add:

```less
.progressMarker {
  position: absolute;
  z-index: 2;
  left: var(--progress-position);
  top: 5.5px;
  width: 8px;
  height: 8px;
  box-sizing: border-box;
  border: 2px solid var(--color-primary);
  border-radius: 50%;
  background: var(--color-content-background);
  box-shadow: 0 1px 4px rgba(0, 0, 0, .28);
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: left .2s ease-out;
}

.progressTooltip {
  position: absolute;
  z-index: 3;
  left: clamp(50px, var(--progress-position), calc(100% - 50px));
  bottom: 12px;
  padding: 4px 7px;
  border: 1px solid rgba(128, 128, 128, .18);
  border-radius: 4px;
  color: var(--color-font);
  background: var(--color-content-background);
  box-shadow: 0 4px 12px rgba(0, 0, 0, .16);
  opacity: 0;
  visibility: hidden;
  font-size: 11px;
  line-height: 1.2;
  white-space: nowrap;
  transform: translate(-50%, 2px);
  pointer-events: none;
  transition: left .2s ease-out, opacity .15s ease, transform .15s ease;
}

.progressTrack:hover .progressTooltip {
  visibility: visible;
  opacity: 1;
  transform: translate(-50%, 0);
}
```

- [ ] **Step 4: Run the focused regression and verify GREEN**

Run:

```powershell
node scripts/test-play-detail-refinement.js
```

Expected: exit code 0 and `play detail refinement tests passed`.

- [ ] **Step 5: Run focused lint**

Run:

```powershell
npx eslint "src/renderer/components/layout/PlayDetail/Turntable.vue" "src/renderer/components/layout/PlayDetail/PlayBar.vue"
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 6: Commit the progress interaction**

```powershell
git add -- src/renderer/components/layout/PlayDetail/PlayBar.vue
git commit -m "feat: add detail progress marker tooltip"
```

### Task 5: Build and inspect the playback detail page

**Files:**
- Verify: `src/renderer/components/layout/PlayDetail/Turntable.vue`
- Verify: `src/renderer/components/layout/PlayDetail/PlayBar.vue`
- Verify: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Run the focused regression and renderer build**

Run:

```powershell
node scripts/test-play-detail-refinement.js
npm run build:renderer
```

Expected: the focused test prints `play detail refinement tests passed`, and webpack completes the renderer bundle with no errors.

- [ ] **Step 2: Inspect normal desktop width**

Open the running application at approximately 1440 by 900 and verify:

- The center artwork diameter is approximately 62 percent of the record.
- The tonearm and record rotation still follow playback state.
- Footer left shows song name over singer, with the favorite button immediately to their right and no footer artwork.
- Center transport controls and right-side detail tools keep their existing positions.
- The marker moves with playback and remains at the paused position.
- Hovering anywhere over the 10px progress interaction track shows current time and total duration above the current marker.
- Clicking and dragging the progress bar still seek normally because the marker and tooltip do not receive pointer events.

- [ ] **Step 3: Inspect edge and responsive states**

Verify at approximately 900 by 700 and with long song/singer names:

- Track text truncates without pushing the favorite button into the transport controls.
- The tooltip remains fully visible at zero progress and near completion.
- No footer element overlaps, resizes the transport controls, or changes the 72px footer height.
- The no-track state disables favorite through the reused control and shows the homepage metadata fallbacks.

- [ ] **Step 4: Check the final diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors; only the planned files and the pre-existing unrelated untracked plan are present.

### Task 6: Build and verify the Windows x64 portable executable

**Files:**
- Generate: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`

- [ ] **Step 1: Build all production targets**

Run:

```powershell
npm run build
```

Expected: exit code 0 with main, renderer, renderer-lyric, and renderer-scripts reporting build success.

- [ ] **Step 2: Package Windows x64 portable**

Run:

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run pack:win:portable:x64
```

Expected: exit code 0 and a newly generated `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`.

- [ ] **Step 3: Verify the portable archive and artifact metadata**

Run:

```powershell
$artifact = Resolve-Path 'build/starky-lx-music-desktop-v3.0.0-x64-portable.exe'
7z t $artifact
Get-Item $artifact | Select-Object FullName, Length, LastWriteTime
Get-FileHash $artifact -Algorithm SHA256
```

Expected: 7-Zip reports `Everything is Ok`; the artifact exists with a non-zero size, current modification time, and SHA-256 hash.

- [ ] **Step 4: Smoke-launch without disturbing existing app processes**

Run this from PowerShell, recording the baseline process IDs first and stopping only new processes created by the portable executable:

```powershell
$artifact = (Resolve-Path 'build/starky-lx-music-desktop-v3.0.0-x64-portable.exe').Path
$before = @(Get-Process 'starky-lx-music-desktop' -ErrorAction SilentlyContinue | ForEach-Object Id)
$smokeData = Join-Path $env:TEMP ('lx-music-portable-smoke-' + [guid]::NewGuid().ToString('N'))
$launcher = Start-Process -FilePath $artifact -ArgumentList "--user-data-dir=$smokeData" -PassThru
Start-Sleep -Seconds 15
$newProcesses = @(Get-Process 'starky-lx-music-desktop' -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $before })
if (-not $newProcesses) { throw 'Portable executable did not start starky-lx-music-desktop processes' }
if ($newProcesses | Where-Object { -not $_.Responding }) { throw 'Portable executable started an unresponsive process' }
$newProcesses | Stop-Process
```

Expected: at least one new responsive `starky-lx-music-desktop` process remains alive after 15 seconds, and only those new process IDs are stopped.

- [ ] **Step 5: Report the deliverable**

Report the absolute artifact path, byte size, modification time, SHA-256 hash, focused test result, lint result, production build result, archive-integrity result, smoke-launch result, and any visual-verification limitation.
