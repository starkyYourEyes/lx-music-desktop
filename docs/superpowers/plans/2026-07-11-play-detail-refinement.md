# Play Detail Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the tonearm onto the record during playback, center only the track information, and reduce the play detail footer to 72px without removing controls.

**Architecture:** Keep playback state in the existing player store and expose it to CSS through one conditional module class on the decorative tonearm. Make the alignment and footer changes entirely in the existing CSS modules so lyric settings and player behavior remain untouched. Use a focused Node structural test for the three visual contracts, followed by lint, renderer build, desktop visual inspection, and portable packaging.

**Tech Stack:** Vue 3, Pug templates, Less CSS modules, Node.js assertions, ESLint, Webpack, Electron Builder.

---

### Task 1: Add the play detail refinement contract

**Files:**
- Create: `scripts/test-play-detail-refinement.js`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Write the failing structural test**

```js
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

const turntable = read('src/renderer/components/layout/PlayDetail/Turntable.vue')
const playDetail = read('src/renderer/components/layout/PlayDetail/index.vue')
const playBar = read('src/renderer/components/layout/PlayDetail/PlayBar.vue')

assert(
  /\$style\.tonearmPlaying\]:\s*isPlay/.test(turntable),
  'Tonearm should receive a playing class from isPlay',
)
assert(
  /\.tonearmPlaying\s*\{[^}]*transform:\s*rotate\(18deg\)/s.test(turntable),
  'Playing tonearm should rotate onto the outer groove',
)
assert(
  /\.trackHeader\s*\{[^}]*align-items:\s*center;[^}]*text-align:\s*center;/s.test(playDetail),
  'Track title and metadata container should be centered',
)
assert(
  /\.trackMeta\s*\{[^}]*width:\s*100%;[^}]*justify-content:\s*center;/s.test(playDetail),
  'Singer and album row should be centered',
)
assert(
  /\.footer\s*\{[^}]*flex:\s*0\s+0\s+72px;/s.test(playBar),
  'Play detail footer should be 72px high',
)
assert(
  /\.playBtnPrimary\s*\{[^}]*width:\s*42px;[^}]*height:\s*42px;/s.test(playBar),
  'Primary play button should be 42px square',
)

console.log('play detail refinement tests passed')
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node scripts/test-play-detail-refinement.js`

Expected: FAIL with `Tonearm should receive a playing class from isPlay`.

- [ ] **Step 3: Commit the failing contract**

```powershell
git add -- scripts/test-play-detail-refinement.js
git commit -m "test: define play detail refinement contract"
```

### Task 2: Move the tonearm with playback state

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/Turntable.vue`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Bind the playing class to the existing state**

Replace the tonearm template line with:

```pug
div(:class="[$style.tonearm, { [$style.tonearmPlaying]: isPlay }]" aria-hidden="true")
```

- [ ] **Step 2: Add pivoted motion and reduced-motion handling**

Add the transition to `.tonearm` and the playing selector after it:

```less
.tonearm {
  transition: transform 360ms cubic-bezier(.2, .75, .25, 1);
}

.tonearmPlaying {
  transform: rotate(18deg);
}
```

Extend the existing reduced-motion query:

```less
@media (prefers-reduced-motion: reduce) {
  .record {
    animation: none;
  }

  .tonearm {
    transition: none;
  }
}
```

- [ ] **Step 3: Run the test and observe the next expected failure**

Run: `node scripts/test-play-detail-refinement.js`

Expected: FAIL with `Track title and metadata container should be centered`; the two tonearm assertions pass.

- [ ] **Step 4: Commit the tonearm change**

```powershell
git add -- src/renderer/components/layout/PlayDetail/Turntable.vue
git commit -m "fix: lower tonearm during playback"
```

### Task 3: Center the track information only

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/index.vue`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Center the header without touching the lyric component**

Add these declarations to `.trackHeader` after `flex-direction`:

```less
  align-items: center;
  text-align: center;
```

Add these declarations to `.trackMeta` after `min-width`:

```less
  width: 100%;
  justify-content: center;
```

Do not modify `LyricPlayer.vue` or `appSetting['playDetail.style.align']`.

- [ ] **Step 2: Run the test and observe the footer failure**

Run: `node scripts/test-play-detail-refinement.js`

Expected: FAIL with `Play detail footer should be 72px high`; tonearm and track information assertions pass.

- [ ] **Step 3: Commit the alignment change**

```powershell
git add -- src/renderer/components/layout/PlayDetail/index.vue
git commit -m "fix: center play detail track information"
```

### Task 4: Compact the bottom play bar

**Files:**
- Modify: `src/renderer/components/layout/PlayDetail/PlayBar.vue`
- Test: `scripts/test-play-detail-refinement.js`

- [ ] **Step 1: Reduce the footer and controls**

Apply the following exact values:

```less
.footer {
  flex: 0 0 72px;
  padding: 10px 28px 4px;
}

.progressTrack {
  height: 10px;
  padding-top: 4px;
}

.partyBtn {
  min-height: 30px;
  padding: 6px 10px;
}

.playBtn {
  width: 32px;
  height: 32px;
  padding: 6px;
}

.playBtnPrimary {
  width: 42px;
  height: 42px;
  padding: 11px;
}
```

In the `max-width: 900px` query, use `30px` for `.playBtn` and `38px` for `.playBtnPrimary` width and height.

- [ ] **Step 2: Run the focused test and verify GREEN**

Run: `node scripts/test-play-detail-refinement.js`

Expected: PASS with `play detail refinement tests passed`.

- [ ] **Step 3: Run focused lint**

Run:

```powershell
npx eslint "src/renderer/components/layout/PlayDetail/Turntable.vue" "src/renderer/components/layout/PlayDetail/index.vue" "src/renderer/components/layout/PlayDetail/PlayBar.vue"
```

Expected: exit code 0 with no lint errors.

- [ ] **Step 4: Commit the compact footer**

```powershell
git add -- src/renderer/components/layout/PlayDetail/PlayBar.vue
git commit -m "fix: compact play detail controls"
```

### Task 5: Build and inspect the desktop result

**Files:**
- Verify: `src/renderer/components/layout/PlayDetail/Turntable.vue`
- Verify: `src/renderer/components/layout/PlayDetail/index.vue`
- Verify: `src/renderer/components/layout/PlayDetail/PlayBar.vue`

- [ ] **Step 1: Run the renderer production build**

Run: `npm run build:renderer`

Expected: exit code 0 and `webpack ... compiled successfully`.

- [ ] **Step 2: Launch the existing Electron development workflow**

Run: `npm run dev`

Expected: the LX Music desktop window opens without renderer errors.

- [ ] **Step 3: Inspect the paused and playing states**

Verify in the desktop window:

- Paused: tonearm rests above the record.
- Playing: tonearm cartridge overlaps the outer groove without covering the center label.
- Song title, singer, and album are centered over the lyric panel.
- Lyrics retain the selected left, center, or right alignment.
- Footer is visibly shorter, all controls fit, and no labels overlap at normal desktop width.

- [ ] **Step 4: Adjust only the playing angle if visual inspection requires it**

If the cartridge misses the outer groove, change only the `18deg` value in `.tonearmPlaying` and the matching test expectation, then rerun the structural test, focused lint, and renderer build.

### Task 6: Rebuild and verify the portable executable

**Files:**
- Generate: `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`

- [ ] **Step 1: Build all renderer and main targets**

Run: `npm run build`

Expected: exit code 0 with all four targets reporting build success.

- [ ] **Step 2: Package Windows x64 portable**

Run:

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
npm run pack:win:portable:x64
```

Expected: exit code 0 and a new `build/starky-lx-music-desktop-v3.0.0-x64-portable.exe`.

- [ ] **Step 3: Verify archive integrity and smoke launch**

Run the project-provided 7-Zip binary against the EXE and expect `Everything is Ok`. Launch the portable EXE, confirm the extracted `starky-lx-music-desktop` processes remain responsive for at least 10 seconds, then stop only those newly launched processes.

- [ ] **Step 4: Record artifact details**

Report the absolute file path, byte size, modification time, SHA-256 hash, build result, archive result, and smoke-launch result.
