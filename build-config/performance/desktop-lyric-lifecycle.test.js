const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const load = require('../../scripts/test-utils/load-ts-module')

const harness = (mode, visible = true) => {
  const windows = []
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this) }
    async loadURL() {}
    show() { this.visible = true }
    hide() { this.visible = false }
    isVisible() { return !!this.visible }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true; this.emit('closed') }
    close() { this.destroy() }
    blur() {}
  }
  global.envParams = { workAreaSize: { width: 1000, height: 1000 } }
  global.lx = { appSetting: { 'performance.features.desktopLyric': mode, 'desktopLyric.enable': visible, 'desktopLyric.width': 600, 'desktopLyric.height': 100 }, theme: {}, event_app: { update_config() {}, desktop_lyric_window_created() {} } }
  const main = load('src/main/modules/winLyric/main.ts', {
    electron: { BrowserWindow: Window },
    '@common/utils': { debounce: fn => fn, getPlatform: () => 'win32' },
    './utils': { initWindowSize: () => ({ x: 0, y: 0, width: 600, height: 100 }) },
    '@common/mainIpc': {},
    '@common/utils/electron': {},
    '@common/performance/featurePolicy': { getFeatureMode: (settings, id) => settings[`performance.features.${id}`] },
    '@main/services/optionalResources': { reportOptionalResourceState() {}, registerOptionalResourcePreparation() {} },
  })
  return { main, windows, update(mode, visible) { global.lx.appSetting['performance.features.desktopLyric'] = mode; global.lx.appSetting['desktopLyric.enable'] = visible; main.applyDesktopLyricPolicy() } }
}

test('off lyric policy blocks direct creation while preserving display preference', () => {
  const h = harness('off')
  h.main.createWindow()
  assert.equal(h.windows.length, 0)
  assert.equal(global.lx.appSetting['desktopLyric.enable'], true)
})

test('resident lyrics prewarm hidden, reuse on show, and off destroys without changing preference', () => {
  const h = harness('resident', false)
  h.main.applyDesktopLyricPolicy()
  assert.equal(h.windows.length, 1)
  h.windows[0].emit('ready-to-show')
  assert.equal(h.windows[0].isVisible(), false)
  h.update('resident', true)
  assert.equal(h.windows[0].isVisible(), true)
  assert.equal(h.windows.length, 1)
  h.update('off', true)
  assert.equal(h.windows[0].isDestroyed(), true)
  assert.equal(global.lx.appSetting['desktopLyric.enable'], true)
})

test('on-demand hidden lyrics release; late ready event after off cannot reopen them', () => {
  const h = harness('onDemand')
  h.main.applyDesktopLyricPolicy()
  h.update('off', true)
  h.windows[0].emit('ready-to-show')
  assert.equal(h.main.isExistWindow(), false)
  h.update('onDemand', true)
  h.windows[1].emit('ready-to-show')
  h.update('onDemand', false)
  assert.equal(h.windows[1].isDestroyed(), true)
})
