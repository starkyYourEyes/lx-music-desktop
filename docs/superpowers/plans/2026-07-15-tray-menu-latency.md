# Tray Menu Latency Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preload the Windows custom tray menu once and update its existing DOM so a right-click can show it without renderer navigation.

**Architecture:** Keep the current frameless `BrowserWindow` and inline HTML in `tray.ts`. Add a shared preload promise and readiness flags around that window, send serializable menu state from the main process over IPC, and let one renderer listener update the existing controls in place.

**Tech Stack:** TypeScript, Electron `BrowserWindow`/IPC, Node.js assertion scripts, ESLint, webpack

---

## File Structure

- Create `scripts/test-tray-menu-latency.js`: source-level regression checks for the click-to-display path, preload lifecycle, and IPC refresh path.
- Modify `src/main/modules/tray.ts`: retain ownership of the Windows tray window, add one-load lifecycle state, construct state snapshots, and update the inline renderer DOM.

### Task 1: Add The Failing Tray Latency Contract

**Files:**
- Create: `scripts/test-tray-menu-latency.js`
- Test: `scripts/test-tray-menu-latency.js`

- [ ] **Step 1: Write the failing regression script**

```js
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const traySource = fs.readFileSync(path.join(root, 'src/main/modules/tray.ts'), 'utf8')

const section = (startMarker, endMarker) => {
  const start = traySource.indexOf(startMarker)
  const end = traySource.indexOf(endMarker, start + startMarker.length)
  assert.notStrictEqual(start, -1, `Expected tray.ts to contain ${startMarker}`)
  assert.notStrictEqual(end, -1, `Expected tray.ts to contain ${endMarker}`)
  return traySource.slice(start, end)
}

const createTray = section('export const createTray =', 'export const destroyTray =')
const refreshTrayMenuWindow = section('const refreshTrayMenuWindow =', 'const getTrayMenuHtml =')
const trayMenuHtml = section('const getTrayMenuHtml =', 'const getTrayMenuBounds =')
const showTrayMenuWindow = section('const showTrayMenuWindow =', 'const createPlayerMenu =')

assert.strictEqual(
  (traySource.match(/\.loadURL\(/g) ?? []).length,
  1,
  'Tray menu HTML should load once through the shared preload path',
)
assert.match(
  createTray,
  /void\s+preloadTrayMenuWindow\(\)/,
  'Creating the Windows tray should preload its hidden menu window',
)
assert.doesNotMatch(
  refreshTrayMenuWindow,
  /\.loadURL\(/,
  'State refreshes should not navigate the tray menu renderer',
)
assert.match(
  refreshTrayMenuWindow,
  /sendTrayMenuState\(\)/,
  'State refreshes should send an IPC snapshot',
)
assert.doesNotMatch(
  showTrayMenuWindow,
  /\.loadURL\(/,
  'A tray right-click should not navigate the tray menu renderer',
)
assert.match(
  showTrayMenuWindow,
  /isTrayMenuShowPending\s*=\s*true/,
  'A right-click during preload should be remembered',
)
assert.match(
  trayMenuHtml,
  /ipcRenderer\.on\('tray-menu-state'/,
  'The loaded menu document should accept incremental state updates',
)

console.log('tray menu latency tests passed')
```

- [ ] **Step 2: Run the script and confirm the RED state**

Run: `node scripts/test-tray-menu-latency.js`

Expected: FAIL on the `loadURL` count because the current refresh and right-click paths both navigate the renderer.

- [ ] **Step 3: Commit the failing contract**

```bash
git add scripts/test-tray-menu-latency.js
git commit -m "test: define tray menu latency contract"
```

### Task 2: Add Incremental Tray Menu State Updates

**Files:**
- Modify: `src/main/modules/tray.ts:16-18`
- Modify: `src/main/modules/tray.ts:138-314`
- Test: `scripts/test-tray-menu-latency.js`

- [ ] **Step 1: Define renderer lifecycle state and the IPC payload**

Add the lifecycle variables beside `trayMenuWindow`:

```ts
let trayMenuWindow: Electron.BrowserWindow | null
let trayMenuWindowLoadPromise: Promise<void> | null = null
let isTrayMenuWindowReady = false
let isTrayMenuShowPending = false
```

Add the payload type after `TrayMenuAction`:

```ts
interface TrayMenuState {
  title: string
  volume: number
  isMute: boolean
  isPlaying: boolean
  isCollected: boolean
  isDesktopLyricEnabled: boolean
}
```

- [ ] **Step 2: Replace reload-based refresh with a state snapshot sender**

Replace `refreshTrayMenuWindow` and move the dynamic value calculation out of `getTrayMenuHtml`:

```ts
const getTrayMenuState = (): TrayMenuState => {
  const sourceVolume = global.lx.player_status.volume || global.lx.appSetting['player.volume']
  const volume = Math.max(0, Math.min(100, normalizeTrayVolume(sourceVolume)))
  return {
    title: getTrayMenuTitle(),
    volume,
    isMute: global.lx.player_status.mute || volume == 0,
    isPlaying: playerState.play,
    isCollected: playerState.collect,
    isDesktopLyricEnabled: global.lx.appSetting['desktopLyric.enable'],
  }
}

const sendTrayMenuState = () => {
  if (!trayMenuWindow || trayMenuWindow.isDestroyed() || !isTrayMenuWindowReady) return
  if (trayMenuWindow.webContents.isDestroyed()) return
  trayMenuWindow.webContents.send('tray-menu-state', getTrayMenuState())
}

const refreshTrayMenuWindow = () => {
  sendTrayMenuState()
}
```

At the start of `getTrayMenuHtml`, derive its initial markup from one snapshot:

```ts
const getTrayMenuHtml = () => {
  const state = getTrayMenuState()
  const title = escapeHtml(state.title)
  const { volume, isMute } = state
  const playIcon = state.isPlaying
    ? '<path d="M9 7h4v18H9zM19 7h4v18h-4z"/>'
    : '<path d="M10 7.5v17l14-8.5z"/>'
  const loveIcon = state.isCollected
    ? '<path d="M16 27s-9-5.6-11.6-11.3C2.5 11.6 4.9 8 9 8c2.5 0 4.2 1.3 5 3 0.8-1.7 2.5-3 5-3 4.1 0 6.5 3.6 4.6 7.7C21 21.4 16 27 16 27z"/>'
    : '<path d="M16 27s-9-5.6-11.6-11.3C2.5 11.6 4.9 8 9 8c2.5 0 4.2 1.3 5 3 0.8-1.7 2.5-3 5-3 4.1 0 6.5 3.6 4.6 7.7C21 21.4 16 27 16 27z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
  const lyricLabel = state.isDesktopLyricEnabled ? '关闭桌面歌词' : '打开桌面歌词'
```

Update the initial play/collect button titles to read `state.isPlaying` and `state.isCollected`.

- [ ] **Step 3: Give the existing markup stable update targets**

Change only the relevant opening tags and spans:

```html
<span data-tray-title>${title}</span>
<button class="ctrl" data-action="collect-toggle" title="${state.isCollected ? '取消收藏' : '收藏'}">
<button class="ctrl" data-action="play-toggle" title="${state.isPlaying ? '暂停' : '播放'}">
<button class="volume-btn" data-action="mute-toggle" title="${isMute ? '取消静音' : '静音'}">
<button class="row" data-action="toggle-desktop-lyric">
```

- [ ] **Step 4: Add the renderer-side state updater before the current click handler**

Insert this code after `const { ipcRenderer } = require('electron')` inside the inline script:

```js
const playIcon = '<path d="M10 7.5v17l14-8.5z"/>'
const pauseIcon = '<path d="M9 7h4v18H9zM19 7h4v18h-4z"/>'
const collectedIcon = '<path d="M16 27s-9-5.6-11.6-11.3C2.5 11.6 4.9 8 9 8c2.5 0 4.2 1.3 5 3 0.8-1.7 2.5-3 5-3 4.1 0 6.5 3.6 4.6 7.7C21 21.4 16 27 16 27z"/>'
const uncollectedIcon = '<path d="M16 27s-9-5.6-11.6-11.3C2.5 11.6 4.9 8 9 8c2.5 0 4.2 1.3 5 3 0.8-1.7 2.5-3 5-3 4.1 0 6.5 3.6 4.6 7.7C21 21.4 16 27 16 27z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'
const volumeIcon = '<path d="M6 13h5l7-6v18l-7-6H6zm16.5-2.4a7.5 7.5 0 0 1 0 10.8l-1.4-1.4a5.5 5.5 0 0 0 0-8.2zm2.9-2.9a11.5 11.5 0 0 1 0 16.6L24 22.9a9.5 9.5 0 0 0 0-13.8z" fill="currentColor"/>'
const mutedIcon = '<path d="M6 13h5l7-6v18l-7-6H6zM23.4 12.2l1.4 1.4-2.4 2.4 2.4 2.4-1.4 1.4-2.4-2.4-2.4 2.4-1.4-1.4 2.4-2.4-2.4-2.4 1.4-1.4 2.4 2.4z" fill="currentColor"/>'
const title = document.querySelector('[data-tray-title]')
const collectButton = document.querySelector('[data-action="collect-toggle"]')
const playButton = document.querySelector('[data-action="play-toggle"]')
const muteButton = document.querySelector('[data-action="mute-toggle"]')
const lyricButton = document.querySelector('[data-action="toggle-desktop-lyric"]')
const volumeSlider = document.querySelector('[data-volume-slider]')
const volumeTip = document.querySelector('[data-volume-tip]')
const setVolume = value => {
  volumeSlider.value = String(value)
  volumeSlider.style.background = 'linear-gradient(to right,#6f7b91 0%,#6f7b91 ' + value + '%,#e5e8ef ' + value + '%,#e5e8ef 100%)'
  volumeTip.textContent = Math.round(value) + '%'
}
ipcRenderer.on('tray-menu-state', (_event, state) => {
  title.textContent = state.title
  collectButton.title = state.isCollected ? '取消收藏' : '收藏'
  collectButton.querySelector('svg').innerHTML = state.isCollected ? collectedIcon : uncollectedIcon
  playButton.title = state.isPlaying ? '暂停' : '播放'
  playButton.querySelector('svg').innerHTML = state.isPlaying ? pauseIcon : playIcon
  muteButton.title = state.isMute ? '取消静音' : '静音'
  muteButton.querySelector('svg').innerHTML = state.isMute ? mutedIcon : volumeIcon
  lyricButton.querySelector('span').textContent = state.isDesktopLyricEnabled ? '关闭桌面歌词' : '打开桌面歌词'
  setVolume(state.volume)
})
```

Remove the later duplicate declarations of `volumeSlider` and `volumeTip`. Keep the existing input listener and call `setVolume(value)` from it before sending `tray-menu-action`.

- [ ] **Step 5: Run the focused script and confirm it still fails for lifecycle work**

Run: `node scripts/test-tray-menu-latency.js`

Expected: FAIL because two `loadURL` calls remain and `createTray` does not preload yet.

### Task 3: Preload Once And Show Without Navigation

**Files:**
- Modify: `src/main/modules/tray.ts:163-205`
- Modify: `src/main/modules/tray.ts:383-426`
- Test: `scripts/test-tray-menu-latency.js`

- [ ] **Step 1: Reset all lifecycle fields when destroying or closing the window**

Update `destroyTrayMenuWindow` and the window's `closed` handler to set:

```ts
trayMenuWindow = null
trayMenuWindowLoadPromise = null
isTrayMenuWindowReady = false
isTrayMenuShowPending = false
```

- [ ] **Step 2: Add the one-load preload function**

Insert after `createTrayMenuWindow`:

```ts
const showLoadedTrayMenuWindow = (win: Electron.BrowserWindow) => {
  if (!tray || trayMenuWindow !== win || win.isDestroyed() || !isTrayMenuWindowReady) return
  sendTrayMenuState()
  win.show()
  win.focus()
}

const preloadTrayMenuWindow = async() => {
  const win = createTrayMenuWindow()
  if (isTrayMenuWindowReady) return
  if (trayMenuWindowLoadPromise) return trayMenuWindowLoadPromise

  trayMenuWindowLoadPromise = win.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(getTrayMenuHtml())}`,
  ).then(() => {
    if (trayMenuWindow !== win || win.isDestroyed()) return
    isTrayMenuWindowReady = true
    sendTrayMenuState()
    if (!isTrayMenuShowPending) return
    isTrayMenuShowPending = false
    showLoadedTrayMenuWindow(win)
  }).catch(() => {
    if (trayMenuWindow === win && !win.isDestroyed()) win.destroy()
  })
  return trayMenuWindowLoadPromise
}
```

- [ ] **Step 3: Preload during Windows tray creation**

After registering the Windows click handlers in `createTray`, add:

```ts
void preloadTrayMenuWindow()
```

- [ ] **Step 4: Replace the right-click navigation with immediate show or one pending request**

Replace `showTrayMenuWindow`:

```ts
const showTrayMenuWindow = () => {
  if (!tray) return
  const win = createTrayMenuWindow()
  win.setBounds(getTrayMenuBounds())
  if (isTrayMenuWindowReady) {
    showLoadedTrayMenuWindow(win)
    return
  }
  isTrayMenuShowPending = true
  void preloadTrayMenuWindow()
}
```

- [ ] **Step 5: Run the regression script and confirm GREEN**

Run: `node scripts/test-tray-menu-latency.js`

Expected: `tray menu latency tests passed`

- [ ] **Step 6: Run focused lint and main-process build**

Run: `npx eslint src/main/modules/tray.ts scripts/test-tray-menu-latency.js`

Expected: exit code 0 with no lint errors.

Run: `npm run build:main`

Expected: webpack exits successfully with no TypeScript errors.

- [ ] **Step 7: Commit the implementation**

```bash
git add src/main/modules/tray.ts scripts/test-tray-menu-latency.js
git commit -m "perf: preload Windows tray menu"
```

### Task 4: Regression And Windows Smoke Verification

**Files:**
- Verify: `src/main/modules/tray.ts`
- Verify: `scripts/test-tray-menu-latency.js`

- [ ] **Step 1: Run the full project checks available in this repository**

Run: `node scripts/test-tray-menu-latency.js`

Expected: `tray menu latency tests passed`

Run: `npm run lint`

Expected: exit code 0. Record unrelated pre-existing failures without changing unrelated files.

Run: `npm run build`

Expected: exit code 0 and all production bundles generated.

- [ ] **Step 2: Start the development app for manual verification**

Run: `npm run dev`

Expected: LX Music starts and creates its tray icon after tray support is enabled.

- [ ] **Step 3: Verify the Windows interaction contract**

Confirm each item in the running app:

1. The first right-click after startup opens the menu without a visible renderer-navigation pause.
2. Repeated close and right-click cycles open at the cursor without recreating content.
3. Play/pause, previous, next, collect, mute, and volume actions still work.
4. Song title, play state, collect state, mute state, volume, and desktop lyric label stay current while the menu is hidden.
5. Disabling tray support destroys the hidden menu window; re-enabling it preloads a new one.

- [ ] **Step 4: Inspect the final diff for scope and whitespace**

Run: `git diff --check HEAD^ -- src/main/modules/tray.ts scripts/test-tray-menu-latency.js`

Expected: no output.

Run: `git status --short`

Expected: only pre-existing user changes remain after the implementation commit.
