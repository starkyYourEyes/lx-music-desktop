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
