const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const load = require('../../scripts/test-utils/load-ts-module')
const { createFakeClock, createPoolHarness } = require('../test-utils/playback-fallback-harness')

test('configured backup expires after idle timeout while primary remains and credentials survive', async() => {
  const clock = createFakeClock()
  const h = createPoolHarness({ clock, autoInit: true })
  await h.pool.configureIdlePolicy({ primaryApiId: 'a', idleMinutes: 1 })
  await Promise.all([h.pool.ensure('a'), h.pool.ensure('b')])
  clock.advance(59_999)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, true)
  clock.advance(1)
  await clock.flush()
  assert.equal(h.pool.getStatus('a').status, true)
  assert.equal(h.pool.getStatus('b').status, false)
  assert.deepEqual(h.clearedSessionIds, [])
  await h.pool.ensure('b')
  assert.equal(h.pool.getStatus('b').status, true)
  assert.deepEqual(h.createdGenerations('b'), [1, 2])
  await h.pool.disposeAll()
})

test('backup lease cancels timeout; release starts a full new idle interval; never disables timeout', async() => {
  const clock = createFakeClock()
  const h = createPoolHarness({ clock, autoInit: true })
  await h.pool.configureIdlePolicy({ primaryApiId: 'a', idleMinutes: 1 })
  await h.pool.ensure('b')
  clock.advance(59_000)
  h.pool.acquireLease({ apiIds: ['b'], leaseId: 'preload' }, 9)
  clock.advance(120_000)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, true)
  await h.pool.releaseLease({ apiIds: ['b'], leaseId: 'preload' }, 9)
  clock.advance(59_999)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, true)
  await h.pool.configureIdlePolicy({ primaryApiId: 'a', idleMinutes: 0 })
  clock.advance(1_000_000)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, true)
  await h.pool.disposeAll()
})

test('pending request resets backup idle interval and eviction publishes unavailable status', async() => {
  const clock = createFakeClock()
  const h = createPoolHarness({ clock, autoInit: true })
  await h.pool.configureIdlePolicy({ primaryApiId: 'a', idleMinutes: 1 })
  await h.pool.ensure('b')
  clock.advance(59_000)
  const pending = h.pool.request({ apiId: 'b', requestId: 'request', action: 'musicUrl', data: {} }, 9)
  await h.waitForPending('b', 'request')
  clock.advance(2_000)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, true)
  h.respond('b', 'request', 'https://example.invalid/song')
  assert.equal((await pending).ok, true)
  clock.advance(59_999)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, true)
  clock.advance(1)
  await clock.flush()
  assert.equal(h.pool.getStatus('b').status, false)
  assert.equal(h.statusEvents.at(-1).status, false)
  await h.pool.disposeAll()
})

test('initialization has no idle timer until acknowledgement; 5 and 15 minute choices are honored', async() => {
  for (const minutes of [5, 15]) {
    const clock = createFakeClock()
    const h = createPoolHarness({ clock, autoInit: false })
    await h.pool.configureIdlePolicy({ primaryApiId: 'a', idleMinutes: minutes })
    const pending = h.pool.ensure('b')
    await h.waitForInitializeCall('b', 1)
    assert.equal(clock.pendingTimerCount, 1)
    clock.advance(9_000)
    await h.init('b', { sources: {} })
    await pending
    clock.advance(minutes * 60_000 - 1)
    await clock.flush()
    assert.equal(h.pool.getStatus('b').status, true)
    clock.advance(1)
    await clock.flush()
    assert.equal(h.pool.getStatus('b').status, false)
    await h.pool.disposeAll()
  }
})

const trayHarness = (mode = 'onDemand', enabled = true) => {
  const clock = createFakeClock()
  const windows = []
  const trays = []
  class Window extends EventEmitter {
    constructor() { super(); this.webContents = new EventEmitter(); this.webContents.send = () => {}; this.webContents.isDestroyed = () => false; windows.push(this) }
    setMenu() {}
    setBounds() {}
    isDestroyed() { return !!this.destroyed }
    isVisible() { return !!this.visible }
    async loadURL() {}
    show() { this.visible = true }
    hide() { this.visible = false; this.emit('hide') }
    focus() {}
    destroy() { this.destroyed = true; this.emit('closed') }
  }
  class Tray extends EventEmitter {
    constructor() { super(); trays.push(this) }
    isDestroyed() { return !!this.destroyed }
    destroy() { this.destroyed = true }
    setIgnoreDoubleClickEvents() {}
    setContextMenu(menu) { this.menu = menu }
    setImage() {}
    setTitle() {}
    setToolTip() {}
  }
  global.staticPath = '/static'
  global.lx = {
    appSetting: { 'tray.enable': enabled, 'tray.themeId': 0, 'performance.features.customTrayMenu': mode, 'performance.features.desktopLyric': 'off', 'player.volume': 1 },
    theme: {},
    player_status: {},
    event_app: new EventEmitter(),
  }
  const policy = { getFeatureMode: (settings, id) => settings[`performance.features.${id}`] ?? 'onDemand', isFeatureEnabled: (settings, id) => settings[`performance.features.${id}`] != 'off' }
  const originalSetTimeout = global.setTimeout
  const originalClearTimeout = global.clearTimeout
  global.setTimeout = clock.setTimeout
  global.clearTimeout = clock.clearTimeout
  const module = load('src/main/modules/tray.ts', {
    electron: { BrowserWindow: Window, Tray, Menu: { buildFromTemplate: items => items }, nativeImage: { createFromPath() {} }, screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1000, height: 1000 } }) } },
    '@common/utils': { isWin: true },
    '@common/constants': {},
    '@common/ipcNames': { WIN_MAIN_RENDERER_EVENT_NAME: {} },
    '@common/performance/featurePolicy': policy,
    '@main/app': {},
    './winMain': { isExistWindow: () => false },
    '@main/services/optionalResources': { reportOptionalResourceState() {}, registerOptionalResourcePreparation() {} },
  })
  module.default()
  global.lx.event_app.emit('app_inited')
  return { clock, windows, trays, module, update(mode) { global.lx.appSetting['performance.features.customTrayMenu'] = mode; global.lx.event_app.emit('updated_config', ['performance.features.customTrayMenu'], global.lx.appSetting) }, cleanup() { module.destroyTray(); global.setTimeout = originalSetTimeout; global.clearTimeout = originalClearTimeout } }
}

test('tray on-demand creates once at first open and destroys after 60 hidden seconds', async() => {
  const h = trayHarness()
  try {
    assert.equal(h.windows.length, 0)
    h.trays[0].emit('right-click')
    h.trays[0].emit('right-click')
    await h.clock.flush()
    assert.equal(h.windows.length, 1)
    assert.equal(h.windows[0].isVisible(), true)
    h.windows[0].emit('blur')
    h.clock.advance(59_999)
    assert.equal(h.windows[0].isDestroyed(), false)
    h.clock.advance(1)
    assert.equal(h.windows[0].isDestroyed(), true)
  } finally { h.cleanup() }
})

test('tray resident prewarms, off uses native controls, and tray master switch prevents prewarm', async() => {
  const h = trayHarness('resident')
  try {
    await h.clock.flush()
    assert.equal(h.windows.length, 1)
    assert.equal(h.windows[0].isVisible(), false)
    h.clock.advance(120_000)
    assert.equal(h.windows[0].isDestroyed(), false)
    h.update('off')
    assert.equal(h.windows[0].isDestroyed(), true)
    assert.ok(h.trays[0].menu.some(item => item.label == 'Play'))
    h.trays[0].emit('right-click')
    assert.equal(h.windows.length, 1)
  } finally { h.cleanup() }
  const disabled = trayHarness('resident', false)
  try { assert.equal(disabled.windows.length, 0); assert.equal(disabled.trays.length, 0) } finally { disabled.cleanup() }
})

test('main optional retry checks saved policy and clears an old error after successful preparation', async() => {
  global.lx = { appSetting: { 'performance.features.customTrayMenu': 'off' } }
  const api = load('src/main/services/optionalResources.ts', {
    '@common/performance/featurePolicy': { getFeatureMode: (settings, feature) => settings[`performance.features.${feature}`] },
  })
  let calls = 0
  api.registerOptionalResourcePreparation('customTrayMenu', async() => { calls++ })
  api.reportOptionalResourceState('customTrayMenu', { error: 'previous failure' })
  await api.prepareOptionalResource('customTrayMenu')
  assert.equal(calls, 0)
  global.lx.appSetting['performance.features.customTrayMenu'] = 'onDemand'
  await api.prepareOptionalResource('customTrayMenu')
  assert.equal(calls, 1)
  assert.equal(api.getOptionalResourceStatus().customTrayMenu.error, undefined)
})
