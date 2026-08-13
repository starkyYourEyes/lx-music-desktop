# Adjustable Play Bar Height Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted `56-74px` play-bar height setting whose artwork scales from `42px` to `54px` across every progress-bar style.

**Architecture:** Put all bounds, normalization, and artwork-size calculations in one renderer-independent TypeScript utility. Basic Settings uses that utility before persisting input, while the shared `ModernBar` converts the normalized setting into CSS custom properties for height, artwork size, and vertical padding.

**Tech Stack:** Vue 3 Options API, Pug templates, Less CSS Modules, TypeScript settings contracts, JSON locale files, Node.js built-in test runner.

## Global Constraints

- Height range is inclusive `56-74px`, with integer `1px` steps.
- Default height remains `74px` for backward-compatible appearance.
- Artwork scales linearly from `42px` at minimum height to `54px` at maximum height.
- Existing playback and utility button sizes do not change.
- Mini, middle, and full-width progress styles continue to use the shared `ModernBar` implementation.
- The desktop lyric renderer's separate `@height-player` remains unchanged.
- No new dependencies are added.

## File Map

- Create `src/common/utils/playBarLayout.ts`: single source of truth for play-bar limits, input normalization, and computed layout metrics.
- Create `build-config/play-bar-height.test.js`: focused unit and source-contract coverage for settings defaults and shared play-bar layout.
- Modify `src/common/defaultSetting.ts`: add the persisted default.
- Modify `src/common/types/app_setting.d.ts`: declare the numeric setting key.
- Modify `src/renderer/views/Setting/components/SettingBasic.vue`: render and handle the slider/number control.
- Modify `src/lang/zh-cn.json`, `src/lang/zh-tw.json`, and `src/lang/en-us.json`: add the control label.
- Modify `build-config/settings-page-layout.test.js`: cover control placement, bounds, normalization, persistence, and locale availability.
- Modify `src/renderer/components/layout/PlayBar/ModernBar.vue`: bind normalized layout metrics to CSS custom properties.

---

### Task 1: Shared Layout Rules And Settings Contract

**Files:**
- Create: `src/common/utils/playBarLayout.ts`
- Create: `build-config/play-bar-height.test.js`
- Modify: `src/common/defaultSetting.ts:5-27`
- Modify: `src/common/types/app_setting.d.ts:69-80`

**Interfaces:**
- Produces: `PLAY_BAR_HEIGHT_MIN`, `PLAY_BAR_HEIGHT_MAX`, `PLAY_BAR_HEIGHT_DEFAULT`, `normalizePlayBarHeight(value: unknown): number`, and `getPlayBarLayout(value: unknown): { height: number, artworkSize: number, paddingY: number }`.
- Produces: `LX.AppSetting['common.playBarHeight']: number` with a default value of `74`.
- Consumes: no feature-specific interface.

- [ ] **Step 1: Write failing unit and contract tests**

Create `build-config/play-bar-height.test.js` with the following focused coverage:

```js
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const root = path.resolve(__dirname, '..')
const loadLayout = () => loadTsModule(path.join(root, 'src/common/utils/playBarLayout.ts'))

test('play bar height normalization clamps and rounds persisted values', () => {
  const { normalizePlayBarHeight } = loadLayout()
  assert.equal(normalizePlayBarHeight(undefined), 74)
  assert.equal(normalizePlayBarHeight('bad'), 74)
  assert.equal(normalizePlayBarHeight(55), 56)
  assert.equal(normalizePlayBarHeight(65.6), 66)
  assert.equal(normalizePlayBarHeight(75), 74)
})

test('play bar artwork scales linearly across both supported endpoints', () => {
  const { getPlayBarLayout } = loadLayout()
  assert.deepEqual(getPlayBarLayout(56), { height: 56, artworkSize: 42, paddingY: 7 })
  assert.deepEqual(getPlayBarLayout(74), { height: 74, artworkSize: 54, paddingY: 10 })
  assert.deepEqual(getPlayBarLayout(65), { height: 65, artworkSize: 48, paddingY: 8.5 })
})

test('application settings declare and default the play bar height', () => {
  const defaults = loadTsModule(path.join(root, 'src/common/defaultSetting.ts'), {
    './constants': { RECOMMEND_HOME_SECTION_IDS: [] },
    './projectIdentity': { PROJECT_IDENTITY: { defaultWebdavUrl: '' } },
  }).default
  const types = fs.readFileSync(path.join(root, 'src/common/types/app_setting.d.ts'), 'utf8')

  assert.equal(defaults['common.playBarHeight'], 74)
  assert.match(types, /'common\.playBarHeight': number/)
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test build-config/play-bar-height.test.js`

Expected: FAIL because `src/common/utils/playBarLayout.ts` and `common.playBarHeight` do not exist.

- [ ] **Step 3: Implement the shared layout utility**

Create `src/common/utils/playBarLayout.ts`:

```ts
export const PLAY_BAR_HEIGHT_MIN = 56
export const PLAY_BAR_HEIGHT_MAX = 74
export const PLAY_BAR_HEIGHT_DEFAULT = 74

const PLAY_BAR_ARTWORK_MIN = 42
const PLAY_BAR_ARTWORK_MAX = 54

export const normalizePlayBarHeight = (value: unknown): number => {
  const height = Math.round(Number(value))
  if (!Number.isFinite(height)) return PLAY_BAR_HEIGHT_DEFAULT
  return Math.min(PLAY_BAR_HEIGHT_MAX, Math.max(PLAY_BAR_HEIGHT_MIN, height))
}

export const getPlayBarLayout = (value: unknown) => {
  const height = normalizePlayBarHeight(value)
  const ratio = (height - PLAY_BAR_HEIGHT_MIN) / (PLAY_BAR_HEIGHT_MAX - PLAY_BAR_HEIGHT_MIN)
  const artworkSize = PLAY_BAR_ARTWORK_MIN + ratio * (PLAY_BAR_ARTWORK_MAX - PLAY_BAR_ARTWORK_MIN)
  return { height, artworkSize, paddingY: (height - artworkSize) / 2 }
}
```

- [ ] **Step 4: Add the default and type contract**

Import `PLAY_BAR_HEIGHT_DEFAULT` into `src/common/defaultSetting.ts` and add:

```ts
'common.playBarHeight': PLAY_BAR_HEIGHT_DEFAULT,
```

Place it next to `common.playBarProgressStyle`. In `src/common/types/app_setting.d.ts`, add the numeric property next to the progress-style property:

```ts
/**
 * Main window play bar height in pixels.
 */
'common.playBarHeight': number
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run: `node --test build-config/play-bar-height.test.js`

Expected: 3 tests PASS.

- [ ] **Step 6: Commit the shared contract**

```powershell
git add -- src/common/utils/playBarLayout.ts src/common/defaultSetting.ts src/common/types/app_setting.d.ts build-config/play-bar-height.test.js
git commit -m "feat: define adjustable play bar dimensions"
```

---

### Task 2: Basic Settings Control And Localized Copy

**Files:**
- Modify: `src/renderer/views/Setting/components/SettingBasic.vue:112-125,133-150`
- Modify: `src/lang/zh-cn.json:380-384`
- Modify: `src/lang/zh-tw.json:380-384`
- Modify: `src/lang/en-us.json:380-384`
- Modify: `build-config/settings-page-layout.test.js`

**Interfaces:**
- Consumes: `PLAY_BAR_HEIGHT_MIN`, `PLAY_BAR_HEIGHT_MAX`, and `normalizePlayBarHeight(value: unknown): number` from Task 1.
- Consumes: `updateSetting({ 'common.playBarHeight': number })` from the existing renderer setting store.
- Produces: `handlePlayBarHeightChange(valueOrEvent)` for slider and numeric-input events.

- [ ] **Step 1: Add failing settings UI tests**

Import `loadTsModule` at the top, then replace `loadSettingBasic()` with an override-aware loader:

```js
const loadTsModule = require('../scripts/test-utils/load-ts-module')

const loadSettingBasic = (settingStore = {}) => loadVueComponent(
  'src/renderer/views/Setting/components/SettingBasic.vue',
  {
    '@common/utils/vueTools': {},
    '@common/utils/playBarLayout': loadTsModule(
      path.join(root, 'src/common/utils/playBarLayout.ts'),
    ),
    '@renderer/store': {},
    '@root/lang': {},
    '@renderer/utils/ipc': {},
    '@renderer/utils/musicSdk/api-source-info': { __esModule: true, default: [] },
    '@renderer/core/player/timeoutStop': {},
    '@renderer/plugins/Dialog': {},
    '@renderer/store/setting': settingStore,
    '@renderer/store/utils': {},
  },
)
```

Add a test that renders the Pug template, invokes the setup handler with a controlled store mock, and reads all three locale files:

```js
test('Basic settings exposes a bounded localized play bar height control', () => {
  const html = renderPugTemplate('src/renderer/views/Setting/components/SettingBasic.vue')
  assert.match(html, /id="basic_playbar_height"/)
  assert.match(html, /type="range" :min="PLAY_BAR_HEIGHT_MIN" :max="PLAY_BAR_HEIGHT_MAX" step="1"/)
  assert.match(html, /common\.playBarHeight/)
  assert.match(html, />px</)

  const updates = []
  const component = loadSettingBasic({
    appSetting: { 'common.playBarHeight': 74 },
    updateSetting: setting => updates.push(setting),
  })
  const { handlePlayBarHeightChange } = component.setup()
  handlePlayBarHeightChange({ target: { value: '55' } })
  handlePlayBarHeightChange('65.6')
  handlePlayBarHeightChange('invalid')
  assert.deepEqual(updates, [
    { 'common.playBarHeight': 56 },
    { 'common.playBarHeight': 66 },
    { 'common.playBarHeight': 74 },
  ])

  for (const file of ['zh-cn.json', 'zh-tw.json', 'en-us.json']) {
    const messages = JSON.parse(fs.readFileSync(path.join(root, 'src/lang', file), 'utf8'))
    assert.equal(typeof messages.setting__basic_playbar_height, 'string')
    assert.notEqual(messages.setting__basic_playbar_height.trim(), '')
  }
})
```

- [ ] **Step 2: Run the settings test and verify it fails**

Run: `node --test build-config/settings-page-layout.test.js`

Expected: FAIL because the height control, handler, and locale key do not exist.

- [ ] **Step 3: Add the Basic Settings control**

Immediately before the existing progress-style card in `SettingBasic.vue`, add:

```pug
dd
  h3#basic_playbar_height {{ $t('setting__basic_playbar_height') }}
  div
    .p(:class="$style.playBarHeightControl")
      input(
        :class="$style.playBarHeightRange" type="range" :min="PLAY_BAR_HEIGHT_MIN" :max="PLAY_BAR_HEIGHT_MAX" step="1"
        :value="appSetting['common.playBarHeight']"
        @input="handlePlayBarHeightChange")
      base-input.gap-left(
        :class="$style.playBarHeightInput" type="number"
        :model-value="appSetting['common.playBarHeight']"
        @change="handlePlayBarHeightChange")
      span(:class="$style.playBarHeightUnit") px
```

Import the helper values and define the handler in `setup()`:

```js
import {
  PLAY_BAR_HEIGHT_MAX,
  PLAY_BAR_HEIGHT_MIN,
  normalizePlayBarHeight,
} from '@common/utils/playBarLayout'

const handlePlayBarHeightChange = value => {
  const nextValue = value?.target ? value.target.value : value
  updateSetting({ 'common.playBarHeight': normalizePlayBarHeight(nextValue) })
}
```

Return the constants and handler from `setup()`. Add CSS module rules matching the existing numeric setting controls:

```less
.playBarHeightControl {
  display: flex;
  align-items: center;
  gap: 8px;
}
.playBarHeightRange {
  width: 180px;
  max-width: 36vw;
  accent-color: var(--color-primary);
  cursor: pointer;
}
.playBarHeightInput {
  width: 62px;
  text-align: center;
}
.playBarHeightUnit {
  color: var(--color-label);
}
```

- [ ] **Step 4: Add locale labels**

Add the same key near the progress-style messages:

```json
// zh-cn.json
"setting__basic_playbar_height": "播放栏高度",

// zh-tw.json
"setting__basic_playbar_height": "播放欄高度",

// en-us.json
"setting__basic_playbar_height": "Playbar Height",
```

The comments above only identify files; do not insert JSON comments.

- [ ] **Step 5: Run the settings tests and lint the component**

Run:

```powershell
node --test build-config/settings-page-layout.test.js
npx eslint src/renderer/views/Setting/components/SettingBasic.vue
```

Expected: all settings-page layout tests PASS and ESLint exits 0.

- [ ] **Step 6: Commit the settings UI**

```powershell
git add -- src/renderer/views/Setting/components/SettingBasic.vue src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json build-config/settings-page-layout.test.js
git commit -m "feat: add play bar height setting"
```

---

### Task 3: Apply The Height And Artwork Metrics To ModernBar

**Files:**
- Modify: `src/renderer/components/layout/PlayBar/ModernBar.vue:1-2,91-109,123-134,193-214,219-229,286-290`
- Modify: `build-config/play-bar-height.test.js`

**Interfaces:**
- Consumes: `getPlayBarLayout(value: unknown)` from Task 1.
- Consumes: reactive `appSetting['common.playBarHeight']` from the renderer setting store.
- Produces: `playBarStyle`, a computed inline-style object with `--play-bar-height`, `--play-bar-artwork-size`, and `--play-bar-padding-y` pixel values.

- [ ] **Step 1: Add failing shared-play-bar source-contract tests**

Append to `build-config/play-bar-height.test.js`:

```js
test('ModernBar binds shared responsive height, artwork, and padding variables', () => {
  const source = fs.readFileSync(
    path.join(root, 'src/renderer/components/layout/PlayBar/ModernBar.vue'),
    'utf8',
  )
  assert.match(source, /:style="playBarStyle"/)
  assert.match(source, /getPlayBarLayout\(appSetting\['common\.playBarHeight'\]\)/)
  assert.match(source, /--play-bar-height/)
  assert.match(source, /--play-bar-artwork-size/)
  assert.match(source, /--play-bar-padding-y/)
  assert.match(source, /height:\s*var\(--play-bar-height\)/)
  assert.match(source, /width:\s*var\(--play-bar-artwork-size\)/)
})

test('all progress variants continue to delegate to ModernBar', () => {
  for (const [file, style] of [
    ['MiniWidthProgress.vue', 'mini'],
    ['MiddleWidthProgress.vue', 'middle'],
    ['FullWidthProgress.vue', 'full'],
  ]) {
    const source = fs.readFileSync(
      path.join(root, 'src/renderer/components/layout/PlayBar', file),
      'utf8',
    )
    assert.match(source, new RegExp(`<modern-bar progress-style="${style}"`))
  }
})
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `node --test build-config/play-bar-height.test.js`

Expected: the new `ModernBar` binding test FAILS while the existing utility tests and variant-delegation test pass.

- [ ] **Step 3: Bind normalized metrics in ModernBar**

Change the root template element to:

```vue
<div :class="$style.player" :style="playBarStyle">
```

Import `computed`, `appSetting`, and `getPlayBarLayout`, then define the computed style in `setup()`:

```js
const playBarStyle = computed(() => {
  const { height, artworkSize, paddingY } = getPlayBarLayout(appSetting['common.playBarHeight'])
  return {
    '--play-bar-height': `${height}px`,
    '--play-bar-artwork-size': `${artworkSize}px`,
    '--play-bar-padding-y': `${paddingY}px`,
  }
})
```

Return `playBarStyle` from `setup()`.

- [ ] **Step 4: Switch fixed dimensions to CSS variables**

Update the CSS module rules:

```less
.player {
  height: var(--play-bar-height);
  padding: var(--play-bar-padding-y) 24px;
}

.picContent {
  width: var(--play-bar-artwork-size);
  height: var(--play-bar-artwork-size);
}
```

Keep the existing horizontal padding overrides in both responsive breakpoints. Do not modify button dimensions or `src/renderer-lyric/assets/styles/variables.less`.

- [ ] **Step 5: Run focused tests and lint**

Run:

```powershell
node --test build-config/play-bar-height.test.js build-config/settings-page-layout.test.js
npx eslint src/common/utils/playBarLayout.ts src/common/defaultSetting.ts src/renderer/components/layout/PlayBar/ModernBar.vue src/renderer/views/Setting/components/SettingBasic.vue
```

Expected: all focused tests PASS and ESLint exits 0.

- [ ] **Step 6: Run the renderer production build**

Run: `npm run build:renderer`

Expected: webpack exits 0 and produces the renderer bundle without TypeScript, Vue template, Less, or locale errors.

- [ ] **Step 7: Review the final diff for scope and workspace isolation**

Run:

```powershell
git diff --check
git status --short
git diff -- src/common/utils/playBarLayout.ts src/common/defaultSetting.ts src/common/types/app_setting.d.ts src/renderer/views/Setting/components/SettingBasic.vue src/renderer/components/layout/PlayBar/ModernBar.vue src/lang/zh-cn.json src/lang/zh-tw.json src/lang/en-us.json build-config/play-bar-height.test.js build-config/settings-page-layout.test.js
```

Expected: no whitespace errors; feature changes are limited to the listed files; pre-existing unrelated modified and untracked files remain untouched.

- [ ] **Step 8: Commit the runtime integration**

```powershell
git add -- src/renderer/components/layout/PlayBar/ModernBar.vue build-config/play-bar-height.test.js
git commit -m "feat: resize play bar artwork with height"
```

---

## Final Verification

- [ ] Run `node --test build-config/play-bar-height.test.js build-config/settings-page-layout.test.js` and confirm all tests pass.
- [ ] Run the targeted ESLint command from Task 3 and confirm exit code 0.
- [ ] Run `npm run build:renderer` and confirm webpack exits 0.
- [ ] Confirm `git status --short` still shows every pre-existing unrelated user change and no unexpected generated files are staged.
- [ ] In the running app, open Basic Settings and verify `74px`, `65px`, and `56px` update the play bar immediately for mini, middle, and full-width progress modes without text, artwork, progress, or button overlap.
