const assert = require('node:assert/strict')
const test = require('node:test')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const babel = require('@babel/core')
const load = (file, mocks) => {
  const { code } = babel.transformSync(fs.readFileSync(file, 'utf8'), {
    babelrc: false,
    configFile: false,
    filename: file,
    presets: [[require.resolve('@babel/preset-typescript'), { allowDeclareFields: true }]],
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  })
  const exports = {}
  // Expose only the private dictionary in this isolated test VM, without a production test API.
  vm.runInNewContext(code + '\nexports.testMessages = messages', { exports, require: key => mocks[key] ?? require(key), global, setTimeout, clearTimeout })
  return exports
}

const expected = {
  'en-us': ['Love', 'Unlove', 'Play', 'Pause', 'Prev Song', 'Next Song', 'Mute', 'Unmute', 'Show Lyric Window', 'Hide Lyric Window', 'Settings', 'Exit'],
  'zh-cn': ['收藏', '取消收藏', '播放', '暂停', '上一曲', '下一曲', '静音', '取消静音', '开启桌面歌词', '关闭桌面歌词', '设置', '退出'],
  'zh-tw': ['收藏', '取消收藏', '播放', '暫停', '上一曲', '下一曲', '靜音', '取消靜音', '開啟歌詞視窗', '關閉歌詞視窗', '設定', '退出'],
}
const harness = async(lang, replacement) => {
  const previous = { lx: global.lx, staticPath: global.staticPath }
  const windows = []
  const nodes = {}
  const node = () => ({ title: '', textContent: '', style: {}, value: '', addEventListener() {}, querySelector(selector) { return this[selector] ??= node() } })
  const document = { querySelector: selector => nodes[selector] ??= node(), addEventListener() {} }
  const renderer = new EventEmitter()
  renderer.send = () => {}
  class Window extends EventEmitter {
    constructor() { super(); windows.push(this); this.loads = 0; this.webContents = new EventEmitter(); this.webContents.isDestroyed = () => false; this.webContents.send = (channel, state) => { this.state = state; renderer.emit(channel, {}, state) } }
    isDestroyed() { return false }
    isVisible() { return false }
    setMenu() {}
    loadURL(url) { this.loads++; this.html = decodeURIComponent(url.split(',').slice(1).join(',')); vm.runInNewContext(this.html.match(/<script>([\s\S]*?)<\/script>/)[1], { require: () => ({ ipcRenderer: renderer }), document }); return Promise.resolve() }
  }
  class Tray extends EventEmitter { setIgnoreDoubleClickEvents() {} isDestroyed() { return false } setImage() {} setTitle() {} setToolTip() {} setContextMenu() {} }
  global.staticPath = '.'
  global.lx = { appSetting: { 'tray.enable': true, 'tray.themeId': 0, 'common.langId': lang, 'player.volume': 0.5, 'desktopLyric.enable': false }, theme: {}, player_status: { name: '<&"\'>' }, event_app: new EventEmitter() }
  const api = load('src/main/modules/tray.ts', {
    electron: { BrowserWindow: Window, Tray, nativeImage: { createFromPath() {} }, Menu: {} },
    '@common/utils': { isWin: true, isMac: false },
    './winMain': {},
    '@main/app': {},
    '@common/constants': { TRAY_AUTO_ID: -1 },
    '@common/ipcNames': {},
    '@common/performance/featurePolicy': { getFeatureMode: () => 'resident', isFeatureEnabled: () => true },
    '@main/services/optionalResources': { registerOptionalResourcePreparation() {}, reportOptionalResourceState() {} },
  })
  if (replacement) for (const key of Object.keys(api.testMessages[lang])) api.testMessages[lang][key] = replacement
  api.default()
  global.lx.event_app.emit('app_inited')
  await Promise.resolve()
  return { win: windows[0], nodes, change(lang) { global.lx.appSetting['common.langId'] = lang; global.lx.event_app.emit('updated_config', ['common.langId'], global.lx.appSetting) }, toggle() { global.lx.player_status.mute = true; global.lx.appSetting['desktopLyric.enable'] = true; global.lx.event_app.emit('player_status', { status: 'playing', collect: true }) }, dispose() { global.lx = previous.lx; global.staticPath = previous.staticPath } }
}
const verifyLive = (h, labels, on = false) => {
  for (const [action, index] of [['collect-toggle', on ? 1 : 0], ['play-toggle', on ? 3 : 2], ['prev', 4], ['next', 5], ['mute-toggle', on ? 7 : 6]]) assert.equal(h.nodes[`[data-action="${action}"]`].title, labels[index], action)
  for (const [action, index] of [['toggle-desktop-lyric', on ? 9 : 8], ['settings', 10], ['quit', 11]]) assert.equal(h.nodes[`[data-action="${action}"]`].querySelector('span').textContent, labels[index], action)
}
test('generated HTML and executed IPC script translate initial and toggled labels in all locales', async() => {
  for (const [lang, labels] of Object.entries(expected)) {
    const h = await harness(lang)
    try {
      for (const index of [0, 2, 4, 5, 6, 8, 10, 11]) assert.ok(h.win.html.includes(labels[index]), `${lang}: initial ${labels[index]}`)
      assert.ok(h.win.html.includes('&lt;&amp;&quot;&#39;&gt;'))
      assert.doesNotMatch(h.win.html.match(/<script>([\s\S]*?)<\/script>/)[1], /[\u3400-\u9fff]/)
      verifyLive(h, labels)
      h.toggle()
      verifyLive(h, labels, true)
    } finally { h.dispose() }
  }
})
test('actual updated_config listener refreshes all labels without another navigation', async() => {
  const h = await harness('zh-cn')
  try {
    h.change('en-us'); verifyLive(h, expected['en-us'])
    h.toggle(); h.change('zh-tw'); verifyLive(h, expected['zh-tw'], true)
    assert.equal(h.win.loads, 1)
    const unsafe = '<img src=x onerror="alert(1)">&\''
    for (const key of Object.keys(h.win.state.labels)) h.win.state.labels[key] = unsafe
    // Re-deliver the actual snapshot through the already executed embedded handler.
    const script = h.win.html.match(/<script>([\s\S]*?)<\/script>/)[1]
    const renderer = new EventEmitter()
    vm.runInNewContext(script, { require: () => ({ ipcRenderer: renderer }), document: { querySelector: selector => h.nodes[selector], addEventListener() {} } })
    renderer.emit('tray-menu-state', {}, h.win.state)
    assert.equal(h.nodes['[data-action="settings"]'].querySelector('span').textContent, unsafe)
    assert.equal(h.nodes['[data-action="prev"]'].title, unsafe)
  } finally { h.dispose() }
})

test('initial translations escape attribute and text delimiters and live updates keep them as text', async() => {
  const unsafe = '<img src=x onerror="alert(1)">&\''
  const h = await harness('en-us', unsafe)
  try {
    const escaped = '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;&#39;'
    for (const action of ['collect-toggle', 'play-toggle', 'prev', 'next', 'mute-toggle']) {
      assert.ok(h.win.html.includes('data-action="' + action + '" title="' + escaped + '"'))
      assert.equal(h.nodes['[data-action="' + action + '"]'].title, unsafe)
    }
    assert.equal(h.win.html.split('<span>' + escaped + '</span>').length - 1, 3)
    assert.ok(!h.win.html.includes(unsafe))
    for (const action of ['toggle-desktop-lyric', 'settings', 'quit']) {
      const span = h.nodes['[data-action="' + action + '"]'].querySelector('span')
      assert.equal(span.textContent, unsafe)
      assert.equal(span.innerHTML, undefined)
    }
  } finally { h.dispose() }
})
